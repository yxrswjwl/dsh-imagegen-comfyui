/**
 * ComfyUI workflow discovery and connectivity probe.
 *
 * Background
 * ----------
 * ComfyUI mainline (comfyanonymous/ComfyUI master) exposes workflow
 * information across two endpoints:
 *
 *   GET /userdata?dir=workflows&recurse=true&full_info=true
 *     → Returns the *user-saved* workflows living under
 *       `ComfyUI/user/default/workflows/` (and any custom_node
 *       `example_workflows/` folders). This is what the user actually
 *       runs day-to-day, and it is the listing the plugin needs.
 *
 *   GET /api/workflow_templates
 *     → Returns the *example* workflows shipped with installed
 *       custom_nodes (organised by module name). Useful as a fallback
 *       when the user has no saved workflows of their own, or as a
 *       reference library for first-time exploration.
 *
 * Surface
 * -------
 * This module exposes two independent functions:
 *
 *   - listComfyUiWorkflows()   fetches `/userdata` (preferred) or
 *                               `/api/workflow_templates` (fallback),
 *                               and groups the response by folder.
 *   - probeComfyUiService()    calls POST `/prompt` (empty body) to
 *                               confirm the service is reachable; used
 *                               by the "add ComfyUI service" picker.
 *
 * Framework-free: takes a plain UpstreamConfig (apiUrl + optional
 * apiKey) so the route handler can drive both without coupling to
 * plugin internals.
 */

import type { UpstreamConfig } from './engine.ts'

/** One workflow entry as the panel consumes it (already grouped by folder). */
export interface ComfyUiWorkflowEntry {
  /** Stable id, also the ComfyUI workflow `path` (relative to the workflows root). */
  id: string
  /** Workflow file name. */
  name: string
  /** The folder name this workflow belongs to (`''` for top-level / no folder). */
  folder: string
  /** Full path as reported by ComfyUI, e.g. `seedvr2_videoupscaler/SeedVR2_HD_video_upscale`. */
  path: string
}

/** One folder grouping in the workflow list. */
export interface ComfyUiWorkflowFolder {
  /** Folder name as displayed; `''` for the un-grouped top-level bucket. */
  name: string
  /** Display order (matches the folder's alphabetic order in the listing). */
  workflows: ComfyUiWorkflowEntry[]
}

/** Aggregated workflow listing ready for the UI. */
export interface ComfyUiWorkflowList {
  folders: ComfyUiWorkflowFolder[]
  /** Total workflow count (sum of every folder). */
  total: number
}

/** One connectivity-probe result, used by the picker / editor. */
export interface ComfyUiProbeResult {
  reachable: boolean
  /** Stable code for the failure case (drives UI copy). */
  code?: 'unreachable' | 'http-error' | 'invalid-response' | 'config-missing' | 'not-comfyui'
  message: string
  /** The HTTP status code, when the probe reached the server. */
  httpStatus?: number
}

/** Cap on the listing fetch (enumeration is cheap; long timeouts usually
 *  mean the host is wrong or the service is overloaded). */
const WORKFLOW_FETCH_TIMEOUT_MS = 15_000
/** Cap on the connectivity probe. ComfyUI's local server should respond
 *  in milliseconds; long timeouts usually mean the host is wrong. */
const PROBE_TIMEOUT_MS = 10_000

/** Whether this ComfyUI preset accepts an empty API key. */
export function isComfyUiPreset(preset: string): boolean {
  return /^comfyui-/i.test(preset.trim())
}

/** Send Bearer only when the caller actually configured one, so a local
 *  service that rejects unknown `Authorization` headers still works. */
function buildHeaders(apiKey: string, accept: 'json' | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (accept === 'json') headers.accept = 'application/json'
  if (apiKey.trim() !== '') headers.authorization = `Bearer ${apiKey.trim()}`
  return headers
}

/** Turn a folder→names accumulator into the wire ComfyUiWorkflowList shape,
 *  sorting root folders first and the rest alphabetically. */
function buildList(records: Map<string, string[]>): ComfyUiWorkflowList {
  const folders: ComfyUiWorkflowFolder[] = []
  let total = 0
  for (const [folder, names] of records.entries()) {
    const workflows: ComfyUiWorkflowEntry[] = names.map(name => ({
      id: folder === '' ? name : `${folder}/${name}`,
      name,
      folder,
      path: folder === '' ? name : `${folder}/${name}`,
    }))
    folders.push({ name: folder, workflows })
    total += workflows.length
  }
  // Root folder ('') first, then alphabetic; lets the UI show "Root" at the
  // top instead of sorting it after the longest module name.
  folders.sort((a, b) => {
    if (a.name === '' && b.name !== '') return -1
    if (a.name !== '' && b.name === '') return 1
    return a.name.localeCompare(b.name)
  })
  return { folders, total }
}

/** Parse the `/userdata?dir=workflows&recurse=true` response (and tolerate the
 *  `/api/workflow_templates` shape too) into a folder-grouped listing.
 *
 *  ComfyUI mainline splits workflow storage across two endpoints:
 *   - `/api/workflow_templates` returns *example* workflows shipped with
 *     custom_nodes (organised by module name).
 *   - `/userdata?dir=workflows&recurse=true` returns the *user-saved*
 *     workflows living under `ComfyUI/user/default/workflows/` — these
 *     are the ones the user actually wants to run from the plugin.
 *
 *  This parser accepts either shape so a misconfigured upstream (or a
 *  future API change) keeps working. */
function groupByFolder(raw: unknown): ComfyUiWorkflowList {
  // Local accumulator; shaped into a ComfyUiWorkflowList at the end.
  // Case A — `/api/workflow_templates` style:
  //   `{ "<folder>": ["wf1", "wf2", ...], ... }`
  // Case B — `/userdata?...` style with `full_info=true`:
  //   `[{ "name": "...", "path": "subdir/file.json", "type": "file", ... }, ...]`
  // Case C — `/userdata?...` style without `full_info`:
  //   `["subdir/file.json", ...]`
  const records = new Map<string, string[]>()

  if (raw === null || typeof raw !== 'object') return buildList(records)

  // Case A
  if (!Array.isArray(raw)) {
    for (const [folder, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const names = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      if (names.length === 0) continue
      records.set(folder, names)
    }
  } else {
    // Case B / C — array response.
    for (const entry of raw) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim()
        if (trimmed === '' || !trimmed.toLowerCase().endsWith('.json')) continue
        const slash = trimmed.indexOf('/')
        const folder = slash >= 0 ? trimmed.slice(0, slash) : ''
        const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
        const list = records.get(folder) ?? []
        list.push(name)
        records.set(folder, list)
      } else if (entry !== null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        const type = record.type
        if (type !== undefined && type !== 'file') continue
        const path = typeof record.path === 'string' ? record.path : typeof record.name === 'string' ? record.name : ''
        if (!path || !path.toLowerCase().endsWith('.json')) continue
        const slash = path.indexOf('/')
        const folder = slash >= 0 ? path.slice(0, slash) : ''
        const name = slash >= 0 ? path.slice(slash + 1) : path
        const list = records.get(folder) ?? []
        list.push(name)
        records.set(folder, list)
      }
    }
  }

  return buildList(records)
}

/** Network-shaped error so the route handler can surface a useful message. */
class ComfyUiError extends Error {
  readonly code: string
  constructor(message: string, code = 'comfyui-failed') {
    super(message)
    this.name = 'ComfyUiError'
    this.code = code
  }
}

/**
 * Fetch the workflow listing from a ComfyUI HTTP service.
 *
 * Tries the user-saved `/userdata` endpoint first; falls back to the
 * bundled `/api/workflow_templates` endpoint if `/userdata` returns a
 * non-OK status (older builds, missing permission, etc).
 *
 * @param upstream  apiUrl (e.g. `http://127.0.0.1:8188`) + optional apiKey.
 * @param options.preset  Channel preset id; only `comfyui-*` presets reach
 *                        this call (the route layer filters upstream).
 */
export async function listComfyUiWorkflows(
  upstream: UpstreamConfig,
  options: { preset: string; signal?: AbortSignal },
): Promise<ComfyUiWorkflowList> {
  if (!isComfyUiPreset(options.preset)) {
    throw new ComfyUiError(`not a ComfyUI preset: ${options.preset}`, 'preset-mismatch')
  }
  const baseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  if (baseUrl === '') {
    throw new ComfyUiError('ComfyUI 地址未填写：请先在「API 地址」字段填入形如 http://127.0.0.1:8188 的服务地址', 'config-missing')
  }

  const controller = new AbortController()
  const onAbort = () => { controller.abort(options.signal?.reason) }
  if (options.signal?.aborted === true) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, WORKFLOW_FETCH_TIMEOUT_MS)
  timer.unref()
  try {
    const userDataPayload = await fetchUserWorkflows(baseUrl, upstream.apiKey, controller.signal)
    if (userDataPayload !== undefined) {
      const parsed = groupByFolder(userDataPayload)
      if (parsed.total > 0) return parsed
    }
    // Fall back to the templates endpoint (or use it when the user has
    // no saved workflows of their own).
    let response: Response
    try {
      response = await fetch(`${baseUrl}/api/workflow_templates`, {
        method: 'GET',
        headers: buildHeaders(upstream.apiKey, 'json'),
        signal: controller.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new ComfyUiError('请求已取消', 'cancelled')
      const message = error instanceof Error ? error.message : String(error)
      throw new ComfyUiError(`无法连接 ComfyUI 服务：${message}`, 'unreachable')
    }
    if (!response.ok) {
      throw new ComfyUiError(`ComfyUI 工作流列表请求失败：HTTP ${response.status}`, 'http-error')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ComfyUiError(`ComfyUI 工作流列表返回了非 JSON 响应：${error instanceof Error ? error.message : String(error)}`, 'invalid-response')
    }
    return groupByFolder(payload)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Fetch the user's saved workflows from
 * `GET /userdata?dir=workflows&recurse=true&full_info=true`.
 *
 * Returns the raw JSON payload when the endpoint is reachable (200) and
 * the response parses as JSON. Returns `undefined` when the endpoint is
 * not available (403 / 404 / network failure) so the caller can fall
 * back to the templates endpoint. An empty `[]` is treated as the user
 * having no saved workflows of their own — still a successful fetch.
 */
async function fetchUserWorkflows(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const response = await fetch(
      `${baseUrl}/userdata?dir=workflows&recurse=true&full_info=true`,
      {
        method: 'GET',
        headers: buildHeaders(apiKey, 'json'),
        signal,
      },
    )
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Probe a ComfyUI HTTP service for reachability.
 *
 * Used by the "add ComfyUI service" picker so the user can validate the
 * URL BEFORE committing to a preset. Strategy: POST `/prompt` with an
 * empty JSON body — a healthy ComfyUI answers with 400 + a structured
 * `{"error":{"type":"no_prompt"}}` payload; any non-404 response proves
 * the service is up. As a fallback, GET `/` and confirm the page title
 * contains "ComfyUI".
 */
export async function probeComfyUiService(
  upstream: UpstreamConfig,
  options: { preset: string; signal?: AbortSignal },
): Promise<ComfyUiProbeResult> {
  if (!isComfyUiPreset(options.preset)) {
    return { reachable: false, code: 'config-missing', message: `not a ComfyUI preset: ${options.preset}` }
  }
  const baseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  if (baseUrl === '') {
    return { reachable: false, code: 'config-missing', message: 'ComfyUI 地址未填写：请先在「API 地址」字段填入形如 http://127.0.0.1:8188 的服务地址' }
  }
  const promptResult = await probePrompt(baseUrl, upstream.apiKey, options.signal)
  if (promptResult.reachable) return promptResult
  if (promptResult.code === 'http-error' && (promptResult.httpStatus === 404 || promptResult.httpStatus === 405)) {
    const rootResult = await probeRoot(baseUrl, upstream.apiKey, options.signal)
    if (rootResult.reachable) return rootResult
  }
  return promptResult
}

/** Probe `/prompt` — any non-404 response is reachable. */
async function probePrompt(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<ComfyUiProbeResult> {
  const controller = new AbortController()
  const onAbort = () => { controller.abort(signal?.reason) }
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, PROBE_TIMEOUT_MS)
  timer.unref()
  try {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { ...buildHeaders(apiKey, 'json'), 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted === true) return { reachable: false, code: 'unreachable', message: '请求已取消' }
      return {
        reachable: false,
        code: 'unreachable',
        message: `无法连接 ComfyUI 服务：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const status = response.status
    if (status === 200 || status === 400) {
      // 200 is unusual but harmless; 400 is the canonical "no_prompt" path.
      return { reachable: true, message: `已连通 · POST /prompt 返 HTTP ${status}`, httpStatus: status }
    }
    if (status === 404 || status === 405) {
      return {
        reachable: false,
        code: 'not-comfyui',
        message: `地址返回了 ${status}，看起来不是 ComfyUI 服务（或 ComfyUI 版本过旧）`,
        httpStatus: status,
      }
    }
    return { reachable: false, code: 'http-error', message: `POST /prompt 返 HTTP ${status}`, httpStatus: status }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Probe `/` and check the page title for "ComfyUI". */
async function probeRoot(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<ComfyUiProbeResult> {
  const controller = new AbortController()
  const onAbort = () => { controller.abort(signal?.reason) }
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, PROBE_TIMEOUT_MS)
  timer.unref()
  try {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/`, {
        method: 'GET',
        headers: buildHeaders(apiKey, null),
        signal: controller.signal,
      })
    } catch (error) {
      return {
        reachable: false,
        code: 'unreachable',
        message: `无法连接 ComfyUI 服务：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!response.ok) {
      return { reachable: false, code: 'http-error', message: `GET / 返 HTTP ${response.status}`, httpStatus: response.status }
    }
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      return {
        reachable: false,
        code: 'invalid-response',
        message: `ComfyUI 服务返回了非文本响应：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (/<title>[^<]*ComfyUI/i.test(body)) {
      return { reachable: true, message: '已连通 · 根页面包含 ComfyUI 标题', httpStatus: response.status }
    }
    return {
      reachable: false,
      code: 'not-comfyui',
      message: '地址可达但首页不是 ComfyUI',
      httpStatus: response.status,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}