/**
 * ComfyUI result poll: after `POST /prompt` returns a `prompt_id`, the
 * ComfyUI service runs the workflow asynchronously. We poll
 * `GET /history/{prompt_id}` until the entry exists and the per-output
 * images are populated, then read each output via `GET /view` and hand the
 * bytes back as `GeneratedImage`.
 *
 * The `status` field in the history entry is documented in
 * `comfy_execution/jobs.py` and tells us whether the run succeeded,
 * failed, or was cancelled; we surface the `messages[].text` strings as a
 * human-readable error so the panel shows the upstream's own complaint.
 */

import { ImageGenError } from './engine.ts'
import { detectImageMime } from './image-format.ts'
import type { GeneratedImage } from './protocol.ts'

/** ComfyUI `outputs.<node>.images[i]` shape. */
interface ComfyUiImageOutput {
  filename: string
  subfolder?: string
  type?: 'output' | 'input' | 'temp'
}

/** A single history entry as `GET /history/{prompt_id}` returns it. */
interface ComfyUiHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: Array<[string, Array<unknown>]> }
  outputs?: Record<string, { images?: ComfyUiImageOutput[] }>
}

/** Total budget for one ComfyUI run (image workflows can run for minutes). */
const COMFY_POLL_DEADLINE_MS = 600_000
/** Time between polls; ComfyUI usually takes seconds to start. */
const COMFY_POLL_INITIAL_MS = 800
/** Per-poll HTTP timeout (the server's WS status doesn't always reflect /history). */
const COMFY_POLL_HTTP_TIMEOUT_MS = 15_000

/** One workflow run submission. */
export interface ComfyUiPromptSubmission {
  promptId: string
}

/** Read `GET /view` for one output entry and decode the bytes. */
async function fetchViewImage(
  baseUrl: string,
  apiKey: string,
  output: ComfyUiImageOutput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const params = new URLSearchParams()
  params.set('filename', output.filename)
  if (output.subfolder !== undefined && output.subfolder !== '') params.set('subfolder', output.subfolder)
  const type = output.type ?? 'output'
  params.set('type', type)
  const url = `${baseUrl}/view?${params.toString()}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: apiKey.trim() !== '' ? { authorization: `Bearer ${apiKey.trim()}` } : {},
      signal,
    })
  } catch (error) {
    throw new ImageGenError(`fetch view 失败：${error instanceof Error ? error.message : String(error)}`, 'comfyui-unreachable')
  }
  if (!response.ok) throw new ImageGenError(`fetch view 失败（HTTP ${response.status}）：${output.filename}`, 'comfyui-http')
  const buffer = Buffer.from(await response.arrayBuffer())
  const mime = detectImageMime(buffer) ?? 'image/png'
  return { b64: buffer.toString('base64'), mime }
}

/** Flatten every `outputs.<node>.images[]` from one history entry into a
 *  single ordered image list. ComfyUI workflows may have multiple output
 *  nodes (e.g. preview + final); the upstream convention is to keep them in
 *  node-id order so the user gets the *final* image last. */
function collectOutputs(entry: ComfyUiHistoryEntry): ComfyUiImageOutput[] {
  const outputs = entry.outputs
  if (outputs === undefined) return []
  const ids = Object.keys(outputs).sort((a, b) => {
    const na = Number(a); const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    if (Number.isFinite(na)) return -1
    if (Number.isFinite(nb)) return 1
    return a.localeCompare(b)
  })
  const out: ComfyUiImageOutput[] = []
  for (const id of ids) {
    const images = outputs[id]?.images
    if (images === undefined) continue
    for (const image of images) {
      // Skip non-output entries: temp/preview images are noise for the panel.
      const type = image.type ?? 'output'
      if (type !== 'output') continue
      out.push(image)
    }
  }
  return out
}

/** Render ComfyUI's structured messages into one readable error string. The
 *  `messages` array is `Array<[kind, Array<any>]>`; ComfyUI logs errors with
 *  kind strings like `execution_error`, `execution_cached`, etc. We pluck
 *  anything that looks like text and join them, so a workflow that fails
 *  with `ValueError: missing model` actually surfaces that to the user. */
function renderMessages(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const parts: string[] = []
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const rest = entry.slice(1).filter((item): item is string => typeof item === 'string' && item !== '')
    if (rest.length > 0) parts.push(rest.join(' '))
  }
  return parts.join(' / ')
}

/**
 * Wait for one ComfyUI run to finish, then read its output images and
 * return them as base64 `GeneratedImage[]`.
 *
 * @param baseUrl  ComfyUI service base URL (no trailing slash).
 * @param apiKey   Optional Bearer key (empty for unauthenticated local services).
 * @param promptId The id returned by `POST /prompt`.
 * @param signal   Cancellation handle propagated from the engine's request.
 */
export async function waitForComfyUiOutputs(
  baseUrl: string,
  apiKey: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const deadline = Date.now() + COMFY_POLL_DEADLINE_MS
  let delay = COMFY_POLL_INITIAL_MS
  let lastEntry: ComfyUiHistoryEntry | undefined
  while (Date.now() < deadline) {
    if (signal !== undefined && signal.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
    const remaining = deadline - Date.now()
    const controller = new AbortController()
    const onAbort = () => { controller.abort(signal?.reason) }
    if (signal !== undefined && signal.aborted === true) onAbort()
    else if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { controller.abort(new DOMException('Timed out', 'TimeoutError')) }, Math.min(COMFY_POLL_HTTP_TIMEOUT_MS, remaining))
    timer.unref()
    let response: Response
    try {
      response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
        method: 'GET',
        headers: apiKey.trim() !== '' ? { authorization: `Bearer ${apiKey.trim()}` } : {},
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
      // A transient network blip should not abort the run; back off and retry.
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
      continue
    }
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (response.status === 404) {
      // ComfyUI only writes the history entry once the workflow is queued;
      // 404 means "not yet started", keep polling.
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
      continue
    }
    if (!response.ok) throw new ImageGenError(`history 拉取失败（HTTP ${response.status}）`, 'comfyui-http')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
      continue
    }
    // `/history/{id}` returns `{ "<prompt_id>": entry }` per the docs. A bare
    // empty object means the entry still hasn't been written.
    const entry = readEntry(payload, promptId) ?? readEntryAsObject(payload)
    if (entry === undefined) {
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
      continue
    }
    lastEntry = entry
    const status = entry.status
    const completed = status !== undefined && status.completed === true
    const statusValue = (status?.status_str ?? '').toLowerCase()
    if (!completed) {
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
      continue
    }
    if (statusValue === 'error' || statusValue === 'failed' || statusValue === 'canceled' || statusValue === 'cancelled') {
      throw new ImageGenError(`ComfyUI 运行失败：${renderMessages(status?.messages) || statusValue}`, 'comfyui-failed')
    }
    const outputs = collectOutputs(entry)
    if (outputs.length === 0) {
      throw new ImageGenError('ComfyUI 运行完成但没有 output 图片', 'comfyui-empty')
    }
    // Download each output in parallel; the host's `data:` payload rides to
    // the browser through the same path OpenAI-style providers use.
    const images = await Promise.all(outputs.map(item => fetchViewImage(baseUrl, apiKey, item, signal ?? new AbortController().signal)))
    return images
  }
  // Reaching here means we ran out of time without ever seeing a completed
  // entry. The upstream may still be running; surface the last messages we
  // saw (if any) so the user has something actionable to read.
  const tail = lastEntry === undefined ? '' : renderMessages(lastEntry.status?.messages)
  throw new ImageGenError(`ComfyUI 运行超时（${COMFY_POLL_DEADLINE_MS / 1000} 秒）${tail !== '' ? `：${tail}` : ''}`, 'comfyui-timeout')
}

/** Extract the history entry for one prompt id from the
 *  `{ "<prompt_id>": entry }` shape; fall back to the bare object form so a
 *  different ComfyUI build (or a future /history shape) keeps working. */
function readEntry(payload: unknown, promptId: string): ComfyUiHistoryEntry | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const candidate = record[promptId]
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  return candidate as ComfyUiHistoryEntry
}

/** Bare-object fallback: a future ComfyUI shape that returns the record
 *  un-indexed by prompt id (e.g. wrapped in `{ "history": {...} }`). */
function readEntryAsObject(payload: unknown): ComfyUiHistoryEntry | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const candidate = record['history']
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const inner = candidate as Record<string, unknown>
  const first = Object.values(inner)[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return undefined
  return first as ComfyUiHistoryEntry
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted === true) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const done = () => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref()
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
}