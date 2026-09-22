/**
 * ComfyUI live progress tracker (round 4.6).
 *
 * ComfyUI broadcasts step-level progress over its WebSocket: after the
 * client sends a JSON `client_id` frame the server switches to text
 * frames and emits `progress` messages like
 * `{ type: 'progress', data: { value, max, prompt_id, node } }` — the
 * sampler's current step over its total. The canvas node polls the host
 * while a run is in flight, so instead of an indefinite spinner it can
 * show "生成中… 45%".
 *
 * One WS connection per ComfyUI base URL, lazily opened on first use.
 * The tracker is deliberately best-effort: if the socket cannot connect
 * (older ComfyUI, network fence, …) it degrades to "no progress" and the
 * canvas keeps the plain spinner.
 */

/** One progress sample. */
export interface ComfyUiProgressSample {
  value: number
  max: number
  node: string | null
  at: number
}

/** How long a sample is considered live before the node shows no progress. */
const SAMPLE_TTL_MS = 60_000
/** Back off for a failed connection before retrying. */
const RETRY_BACKOFF_MS = 5 * 60_000
/** Client id shared with `submitComfyUiPrompt` (engine.ts). ComfyUI only
 *  forwards execution/progress messages to the WebSocket whose client id
 *  matches the one the prompt was submitted under, so the tracker socket
 *  MUST use the exact same id or it would never see any progress. */
const COMFY_CLIENT_ID = 'dsh-imagegen'

export class ComfyUiProgressTracker {
  private ws: WebSocket | null = null
  private connecting = false
  private degradedUntil = 0
  /** promptId -> { value, max, node, at } (last observed sample). */
  private readonly samples = new Map<string, ComfyUiProgressSample>()
  /** promptId -> workflowNodeId that triggered it (for correlation). */
  private readonly owners = new Map<string, string>()
  private readonly wsUrl: string

  constructor(wsUrl: string) {
    // Plain assignment: parameter properties are not supported by Node's
    // type-stripping loader, which the verification scripts rely on.
    this.wsUrl = wsUrl
  }

  /** Associate a freshly-submitted ComfyUI run with the canvas workflow
   *  node that triggered it, and make sure the socket is up. */
  register(workflowNodeId: string, promptId: string): void {
    this.owners.set(promptId, workflowNodeId)
    this.ensureSocket()
  }

  /** Ensure the socket is up (or at least connecting), resolving once the
   *  connection is ready or the timeout elapses. Call BEFORE submitting a
   *  prompt: ComfyUI only broadcasts execution/progress messages to the
   *  client id the prompt was submitted under, so if this socket isn't
   *  connected when the run starts, the early (and for fast workflows,
   *  all) progress frames are lost. */
  async ensureConnected(timeoutMs = 3000): Promise<void> {
    if (this.ws !== null && !this.connecting) return
    this.ensureSocket()
    if (this.ws === null) return
    const deadline = Date.now() + timeoutMs
    while (this.connecting && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** Latest live sample owned by this workflow node, or null. */
  progressOf(workflowNodeId: string): { value: number; max: number; node: string | null } | null {
    let latest: ComfyUiProgressSample | null = null
    for (const [promptId, owner] of this.owners) {
      if (owner !== workflowNodeId) continue
      const sample = this.samples.get(promptId)
      if (sample === undefined) continue
      if (latest === null || sample.at > latest.at) latest = sample
    }
    if (latest === null) return null
    if (Date.now() - latest.at > SAMPLE_TTL_MS) return null
    return { value: latest.value, max: latest.max, node: latest.node }
  }

  /** Forget a finished/cancelled run so stale samples don't linger. */
  release(promptId: string): void {
    this.samples.delete(promptId)
    this.owners.delete(promptId)
  }

  /** Diagnostic state (used by the verification scripts). */
  debugState(): { wsUp: boolean; connecting: boolean; degraded: boolean; samples: number; owners: number } {
    return {
      wsUp: this.ws !== null,
      connecting: this.connecting,
      degraded: Date.now() < this.degradedUntil,
      samples: this.samples.size,
      owners: this.owners.size,
    }
  }

  private ensureSocket(): void {
    if (this.ws !== null || this.connecting) return
    if (Date.now() < this.degradedUntil) return
    this.connecting = true
    try {
      const ws = new WebSocket(this.wsUrl)
      ws.onopen = () => {
        // The socket is up; the open flag must clear or later registers
        // would never be able to (re)connect.
        this.connecting = false
        // Switching to the JSON text protocol is what makes ComfyUI emit
        // parseable `progress` frames instead of the binary protocol.
        try { ws.send(JSON.stringify({ type: 'client_id', clientId: COMFY_CLIENT_ID })) } catch { /* ignore */ }
      }
      ws.onmessage = event => { void this.handleMessage(event) }
      ws.onclose = () => {
        this.ws = null
        this.connecting = false
        this.degradedUntil = Date.now() + RETRY_BACKOFF_MS
      }
      ws.onerror = () => { try { ws.close() } catch { /* ignore */ } }
      this.ws = ws
    } catch {
      this.connecting = false
      this.degradedUntil = Date.now() + RETRY_BACKOFF_MS
    }
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    let text: string
    if (typeof event.data === 'string') text = event.data
    else if (event.data instanceof Blob) text = await event.data.text()
    else return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const msg = parsed as Record<string, unknown>
    const data = (msg['data'] ?? {}) as Record<string, unknown>
    const promptId = data['prompt_id']
    if (typeof promptId !== 'string') return
    if (msg['type'] === 'progress') {
      const value = Number(data['value'])
      const max = Number(data['max'])
      if (Number.isFinite(value) && Number.isFinite(max)) {
        this.samples.set(promptId, {
          value,
          max,
          node: typeof data['node'] === 'string' ? data['node'] : null,
          at: Date.now(),
        })
      }
    } else if (msg['type'] === 'executing') {
      // `node` is null when the whole prompt finished; record the switch
      // otherwise so the canvas can label which node is running.
      const previous = this.samples.get(promptId)
      if (typeof data['node'] === 'string') {
        this.samples.set(promptId, { value: previous?.value ?? 0, max: previous?.max ?? 1, node: data['node'], at: Date.now() })
      }
    } else if (msg['type'] === 'execution_success' || msg['type'] === 'execution_interrupted') {
      // Keep the last sample around for a while (the client shows the
      // final state) — the TTL handles expiry.
      const previous = this.samples.get(promptId)
      if (previous !== undefined) {
        this.samples.set(promptId, { ...previous, value: previous.max, at: Date.now() })
      }
    }
  }
}

/** Module-level trackers, keyed by ComfyUI base URL (one socket per service). */
const trackers = new Map<string, ComfyUiProgressTracker>()

/** Get (creating on first use) the progress tracker for a ComfyUI base URL. */
export function progressTrackerFor(baseUrl: string): ComfyUiProgressTracker {
  const key = baseUrl.replace(/\/+$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  let tracker = trackers.get(key)
  if (tracker === undefined) {
    tracker = new ComfyUiProgressTracker(`${key}/ws?clientId=${COMFY_CLIENT_ID}`)
    trackers.set(key, tracker)
  }
  return tracker
}

/** Latest live progress sample for a canvas workflow node, across every
 *  known ComfyUI service. Returns null when nothing is running for it. */
export function progressForWorkflowNode(workflowNodeId: string): { value: number; max: number; node: string | null } | null {
  for (const tracker of trackers.values()) {
    const sample = tracker.progressOf(workflowNodeId)
    if (sample !== null) return sample
  }
  return null
}
