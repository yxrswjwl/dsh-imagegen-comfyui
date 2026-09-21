/**
 * ComfyUI workflow loader: download one user-saved workflow JSON from a
 * ComfyUI HTTP service and inject the panel's request parameters (positive /
 * negative prompt, random seed) into the right nodes so the workflow runs as
 * the user intends.
 *
 * Background
 * ----------
 * ComfyUI's on-the-wire workflow format is a flat node map:
 *   `{ "<node_id>": { "inputs": {...}, "class_type": "...", "_meta": {...} }, ... }`
 * A few node classes are relevant to the panel:
 *   - `CLIPTextEncode` / `CLIPTextEncodeSDXL` (+ the SDXL refiner / pixart
 *     variants) carry the prompt text in `inputs.text`. The convention used
 *     here is: the first one found is the *positive* prompt, the second is
 *     the *negative* prompt — which matches how ComfyUI ships its default
 *     txt2img / SDXL workflows.
 *   - `KSampler` / `KSamplerAdvanced` / `KSampler (Efficient)` /
 *     `KSamplerAdvanced (Efficient)` / `KSampler 2` / `SamplerCustom` etc.
 *     expose a `seed` integer input, often alongside `noise_seed` (for the
 *     newer variants). We randomise both and set `control_after_generate`
 *     to `'randomize'` so a re-run uses a different seed without the user
 *     having to re-trigger.
 *
 * Why not load the file from disk?
 *   The ComfyUI service may run on a different host (a remote ComfyUI). The
 *   `/userdata/workflows/<path>` endpoint exists in mainline and is the only
 *   path that works for both local and remote services. The endpoint sets
 *   `Content-Disposition: attachment`, which is harmless — `response.json()`
 *   still parses the body as long as the MIME stays JSON or octet-stream.
 */

import { randomInt } from 'node:crypto'
import type { UpstreamConfig } from './engine.ts'

/** A workflow node as ComfyUI emits it on the wire. */
interface WorkflowNode {
  inputs?: Record<string, unknown>
  class_type?: string
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

/** A workflow JSON as ComfyUI emits it: `{ "<node_id>": node, ... }`. */
export type ApiWorkflow = Record<string, WorkflowNode>

/** A picker prompt request the user picked from the panel. */
export interface ComfyUiPromptInjection {
  /** Positive prompt written into the first `CLIPTextEncode*` node. */
  positive: string
  /** Negative prompt written into the second `CLIPTextEncode*` node (when
   *  the workflow has one). Empty string clears the negative prompt. */
  negative?: string
  /** Random seed; when omitted a fresh random integer is generated. */
  seed?: number
  /** Random noise seed; defaults to `seed`. Some sparse samplers apply
   *  `noise_seed` instead of (or in addition to) `seed`. */
  noiseSeed?: number
}

/** Diagnostic summary of the injected fields, so the engine can tell the
 *  user which node ids were used (the ComfyUI frontend shows these in its
 *  loaded-workflow view; surfacing them keeps the round-trip honest). */
export interface InjectionSummary {
  positiveNodeId: string | null
  negativeNodeId: string | null
  samplerNodeId: string | null
  /** All sampler nodes touched (may be several for multi-stage samplers). */
  samplerNodeIds: string[]
  seed: number
  noiseSeed: number
}

/** Class names we route to as prompt text carriers. */
export const PROMPT_NODE_CLASSES = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeSDXL',
  'CLIPTextEncodeSDXLRefiner',
  'CLIPTextEncodePixArtAlpha',
  'BNK_CLIPTextEncodeAdvanced',
  'smZ CLIPTextEncode',
  'TextEncodeHunyuanDiT',
  'TextEncodeQwenImageEdit',
])

/** Class names we route to as samplers (each accepts a seed input). */
export const SAMPLER_NODE_CLASSES = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'KSampler (Efficient)',
  'KSamplerAdvanced (Efficient)',
  'KSampler 2',
  'KSamplerAdvanced (2-pass)',
  'KSampler SD3',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'SamplerCustomEfficient',
])

/** Read a single user-saved workflow JSON from the configured ComfyUI service.
 *
 *  Strategy:
 *   1. Try `GET /userdata/workflows/<path>` over HTTP (the documented mainline
 *      path; works for remote ComfyUI services and most local installs).
 *   2. If HTTP fails (404 because a custom_node intercepted the route, or
 *      because the user runs an older ComfyUI build), fall back to reading
 *      `<installDir>/user/default/workflows/<path>` from disk when an
 *      `installDir` is supplied.
 *
 *  The two strategies share the same return shape so the caller does not
 *  have to care which one won. */
export async function fetchComfyUiWorkflow(
  upstream: UpstreamConfig,
  workflowPath: string,
  options: { signal?: AbortSignal; installDir?: string } = {},
): Promise<ApiWorkflow> {
  const trimmed = workflowPath.trim().replace(/^\/+/, '')
  if (trimmed === '') throw new Error('工作流路径为空')
  // Absolute paths bypass HTTP/local fallback entirely. The canvas round-3
  // importer writes a temporary JSON here when the user picks an
  // "import JSON" workflow that lives outside ComfyUI's workflow root.
  if (looksLikeAbsolute(workflowPath)) {
    const absolute = await tryReadWorkflowFile(workflowPath)
    if (absolute !== undefined) return absolute
  }
  try {
    return await readWorkflowHttp(upstream, trimmed, options.signal)
  } catch (httpError) {
    if (options.installDir === undefined || options.installDir.trim() === '') throw httpError
    // UI-format errors are user-actionable; surface them verbatim instead of
    // masking them with the HTTP 404 from the failed /userdata call.
    if (httpError instanceof UiFormatWorkflowError) throw httpError
    try {
      const local = await tryFetchWorkflowLocal(options.installDir, trimmed)
      if (local !== undefined) return local
    } catch (localError) {
      if (localError instanceof UiFormatWorkflowError) throw localError
    }
    throw httpError
  }
}

function looksLikeAbsolute(candidate: string): boolean {
  if (candidate.length === 0) return false
  // POSIX: /foo/bar.json — Windows: C:\foo or C:/foo. Reject UNC / scheme.
  if (candidate[0] === '/') return true
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true
  return false
}

async function tryReadWorkflowFile(absolutePath: string): Promise<ApiWorkflow | undefined> {
  try {
    const fs = await import('node:fs/promises')
    const text = await fs.readFile(absolutePath, 'utf8')
    const payload = JSON.parse(text) as unknown
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('工作流 JSON 顶层不是节点映射')
    }
    if (isUiFormatWorkflow(payload)) throw new UiFormatWorkflowError(absolutePath)
    return payload as ApiWorkflow
  } catch (error) {
    if (error instanceof UiFormatWorkflowError) throw error
    return undefined
  }
}

async function readWorkflowHttp(
  upstream: UpstreamConfig,
  trimmedPath: string,
  signal?: AbortSignal,
): Promise<ApiWorkflow> {
  const baseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  if (baseUrl === '') throw new Error('ComfyUI 地址未填写')
  // The picker stores relative paths like `SD3/z_image_turbo.json` (folder +
  // filename). ComfyUI's `/userdata/{file}` handler appends the supplied
  // path to the user's `workflows/` root, so we have to prepend the
  // `workflows/` segment here.
  const relativeToRoot = trimmedPath.startsWith('workflows/') ? trimmedPath : `workflows/${trimmedPath}`
  // ComfyUI decodes `%xx` segments before joining the user root, so spaces
  // and Chinese directory names round-trip cleanly.
  const encoded = relativeToRoot.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const url = `${baseUrl}/userdata/${encoded}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: upstream.apiKey.trim() !== ''
        ? { authorization: `Bearer ${upstream.apiKey.trim()}` }
        : {},
      signal,
    })
  } catch (error) {
    throw new Error(`无法读取 ComfyUI 工作流：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`ComfyUI 工作流读取失败（HTTP ${response.status}）：${trimmedPath}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`ComfyUI 工作流不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ComfyUI 工作流 JSON 顶层不是节点映射')
  }
  if (isUiFormatWorkflow(payload)) {
    throw new UiFormatWorkflowError(trimmedPath)
  }
  return payload as ApiWorkflow
}

/** Local-disk fallback for environments whose ComfyUI build does not expose
 *  `GET /userdata/{file}` (e.g. older builds, custom_node conflicts). */
async function tryFetchWorkflowLocal(installDir: string, trimmedPath: string): Promise<ApiWorkflow | undefined> {
  try {
    const fs = await import('node:fs/promises')
    const nodePath = await import('node:path')
    const root = nodePath.resolve(installDir.trim())
    // The ComfyUI user-data tree lives under `<installDir>/user/default/`.
    // Custom node example workflows sit under `<installDir>/custom_nodes/...`
    // but we never auto-discover those; the picker only feeds user-saved
    // workflows, which are under `user/default/workflows/`. The picker
    // already strips the `workflows/` prefix (so `trimmedPath` looks like
    // `image_qwen_Image_2512_生图效果最好.json`), but the on-disk path needs
    // it back — we re-add it before the resolve so the disk read matches the
    // HTTP read at `<base>/userdata/workflows/<path>`.
    const withPrefix = trimmedPath.startsWith('workflows/')
      ? trimmedPath
      : `workflows/${trimmedPath}`
    const candidate = nodePath.resolve(root, 'user', 'default', withPrefix)
    // Path-containment check: refuse anything that escapes the user root.
    const userRoot = nodePath.resolve(root, 'user', 'default')
    if (!candidate.startsWith(userRoot + nodePath.sep) && candidate !== userRoot) {
      throw new Error(`工作流路径越界：${trimmedPath}`)
    }
    const text = await fs.readFile(candidate, 'utf8')
    const payload = JSON.parse(text) as unknown
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('本地工作流 JSON 顶层不是节点映射')
    }
    if (isUiFormatWorkflow(payload)) {
      // Surface the UI-format error to the caller; tryFetchWorkflowLocal's
      // outer try/catch will swallow it (returning undefined) so the HTTP
      // attempt's error wins. Re-throw here is therefore pointless.
      throw new UiFormatWorkflowError(trimmedPath)
    }
    return payload as ApiWorkflow
  } catch (error) {
    if (error instanceof UiFormatWorkflowError) {
      // Re-raise UI-format errors so fetchComfyUiWorkflow can produce the
      // friendly "save as API format" message instead of "HTTP 404".
      throw error
    }
    return undefined
  }
}

/** Whether a workflow JSON is the ComfyUI frontend *UI export* format
 *  (`{ nodes: [...], links: [...] }`) rather than the API submission
 *  format (`{ "<id>": { class_type, inputs, widgets_values } }`).
 *
 *  Heuristic: UI export always carries a `nodes` array whose entries are
 *  objects with a `type` string. The API format carries only numeric /
 *  string keys whose values have a `class_type` string.
 *
 *  This is best-effort — a workflow saved by the frontend via "Save (API
 *  Format)" never trips it. */
function isUiFormatWorkflow(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  const nodes = record['nodes']
  if (!Array.isArray(nodes)) return false
  if (nodes.length === 0) return false
  // A single entry with both `type` and no `class_type` is a strong signal:
  // API format uses `class_type`, UI format uses `type`.
  const first = nodes[0]
  return typeof first === 'object' && first !== null
    && typeof (first as Record<string, unknown>)['type'] === 'string'
    && (first as Record<string, unknown>)['class_type'] === undefined
}

/** Error thrown when the loaded workflow is in ComfyUI's UI export format
 *  rather than the API submission format. The user has to re-save the
 *  workflow from the ComfyUI frontend via "Save (API Format)". */
export class UiFormatWorkflowError extends Error {
  readonly code = 'comfyui-ui-format'
  readonly workflowPath: string
  constructor(workflowPath: string) {
    super(
      `工作流「${workflowPath}」是 ComfyUI 浏览器的「UI 导出格式」，插件无法直接提交。\n`
      + `请在 ComfyUI 浏览器里打开该工作流，使用右上角菜单的「Save (API Format)」另存一份，`
      + `再把那份文件路径（或同名）作为插件渠道里的模型别名。\n`
      + `（细节：UI 格式顶层是 { nodes: [], links: [] }；API 格式顶层是 { "<id>": { class_type, ... } }。）`,
    )
    this.name = 'UiFormatWorkflowError'
    this.workflowPath = workflowPath
  }
}

/** Pick the first node id whose `class_type` is in the given class set, in
 *  numeric order (ComfyUI assigns small integers as node ids; sorting keeps
 *  "the first prompt" deterministic even when the workflow is a refactor). */
function firstNodeOfClass(workflow: ApiWorkflow, classes: ReadonlySet<string>): string | null {
  const ids = Object.keys(workflow)
    .filter(id => {
      const node = workflow[id]
      return node !== undefined && node !== null && typeof node === 'object' && typeof node.class_type === 'string' && classes.has(node.class_type)
    })
    // Numeric sort with stable fallback: "6" < "7" < "10"; non-numeric ids
    // ("a", "b") are kept at the end so the user's named anchors win.
    .sort((a, b) => {
      const na = Number(a); const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      if (Number.isFinite(na)) return -1
      if (Number.isFinite(nb)) return 1
      return a.localeCompare(b)
    })
  return ids[0] ?? null
}

/** Pick every node id whose `class_type` is in the given class set, in
 *  numeric order. Multi-stage workflows (refiner, hires-fix) chain several
 *  samplers; touching every one prevents a stale seed from leaking into a
 *  downstream stage. */
function everyNodeOfClass(workflow: ApiWorkflow, classes: ReadonlySet<string>): string[] {
  return Object.keys(workflow)
    .filter(id => {
      const node = workflow[id]
      return node !== undefined && node !== null && typeof node === 'object' && typeof node.class_type === 'string' && classes.has(node.class_type)
    })
    .sort((a, b) => {
      const na = Number(a); const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      if (Number.isFinite(na)) return -1
      if (Number.isFinite(nb)) return 1
      return a.localeCompare(b)
    })
}

/** Patch a node's `inputs.text` value (positive/negative prompt carriers). */
function patchTextInputs(node: WorkflowNode, text: string): void {
  if (node.inputs === undefined) node.inputs = {}
  node.inputs.text = text
}

/** Patch a sampler node's seeds + control flag. Tries the modern
 *  `noise_seed` first, then falls back to the classic `seed`, and leaves any
 *  other inputs alone so `steps` / `cfg` / `sampler_name` / `scheduler`
 *  settings the workflow author chose survive. */
function patchSamplerInputs(node: WorkflowNode, seed: number, noiseSeed: number): void {
  if (node.inputs === undefined) node.inputs = {}
  // The modern ComfyUI sampler accepts both `seed` and `noise_seed`; setting
  // both is the safest call when the version is unknown.
  node.inputs.seed = seed
  node.inputs.noise_seed = noiseSeed
  // `control_after_generate` of `randomize` means "on every new prompt, use
  // a fresh seed". Without it, the workflow re-runs with the same seed
  // every time the panel calls it — and that is almost never what the user
  // wants from a generation panel.
  node.inputs.control_after_generate = 'randomize'
}

/**
 * Apply one picker prompt to a ComfyUI workflow JSON in place. Returns a
 * summary of which nodes were patched so the engine can log them. The
 * mutation is intentional: ComfyUI's prompt format is already a plain JSON
 * object, the engine hands it straight to `POST /prompt`, and cloning the
 * whole graph just to patch it is silly.
 */
export function injectPromptIntoWorkflow(
  workflow: ApiWorkflow,
  injection: ComfyUiPromptInjection,
): InjectionSummary {
  const promptIds = everyNodeOfClass(workflow, PROMPT_NODE_CLASSES)
  const samplerIds = everyNodeOfClass(workflow, SAMPLER_NODE_CLASSES)
  const positiveNodeId = promptIds[0] ?? null
  // Convention: first CLIPTextEncode = positive, second = negative. Empty
  // negative leaves the second node untouched (its absence means the
  // workflow was single-prompt and a missing node here is fine).
  const negativeNodeId = promptIds[1] ?? null
  const samplerNodeId = samplerIds[0] ?? null
  const seed = injection.seed ?? randomInt(0, 2 ** 31)
  const noiseSeed = injection.noiseSeed ?? seed

  if (positiveNodeId !== null) {
    const node = workflow[positiveNodeId]
    if (node !== undefined) patchTextInputs(node, injection.positive)
  }
  if (negativeNodeId !== null && injection.negative !== undefined) {
    const node = workflow[negativeNodeId]
    if (node !== undefined) patchTextInputs(node, injection.negative)
  }
  for (const id of samplerIds) {
    const node = workflow[id]
    if (node !== undefined) patchSamplerInputs(node, seed, noiseSeed)
  }

  return {
    positiveNodeId,
    negativeNodeId,
    samplerNodeId,
    samplerNodeIds: samplerIds,
    seed,
    noiseSeed,
  }
}

/** One override the canvas asked for, resolved against the workflow. */
export interface AppliedWorkflowOverride {
  nodeId: string
  inputName: string
  /** Value actually written (after type coercion). */
  value: unknown
  /** The value that was there before (undefined when the input is new). */
  previous: unknown
}

/** Outcome of applying the canvas's advanced-override map. */
export interface WorkflowOverrideResult {
  applied: AppliedWorkflowOverride[]
  /** Keys we could not apply, with the reason — surfaced to the user so a
   *  typo'd node id doesn't silently do nothing. */
  skipped: Array<{ key: string; reason: 'malformed-key' | 'node-not-found' | 'invalid-value' }>
}

/**
 * Round 4.3: write the canvas's per-widget overrides back into a ComfyUI
 * workflow JSON in place.
 *
 * Keys are `${nodeId}:${inputName}` — a flat map so the client never has
 * to carry node topology. Values arrive from `<input>` elements as
 * strings (or as numbers when the client manages the state itself), so
 * each value is coerced against the type of the value already sitting on
 * the node:
 *
 *   - existing number → Number(override), rejected when NaN
 *   - existing boolean → 'true'/'false'/'1'/'0' → boolean
 *   - existing string  → String(override)
 *   - input absent     → written as-is (the workflow author added it)
 *
 * Call this AFTER `injectPromptIntoWorkflow`: the injector rewrites every
 * sampler's seed to a fresh random value, so a user-pinned seed has to be
 * applied last to win. This ordering also lets a user override `text` on
 * a prompt node, which is why we don't filter by class here.
 */
export function applyWorkflowOverrides(
  workflow: ApiWorkflow,
  overrides: Record<string, unknown> | undefined,
): WorkflowOverrideResult {
  const result: WorkflowOverrideResult = { applied: [], skipped: [] }
  if (overrides === undefined) return result
  for (const [key, raw] of Object.entries(overrides)) {
    // Split on the FIRST colon only: ComfyUI node ids are opaque strings
    // that can themselves contain colons (custom nodes use things like
    // `3:1` for subgraphs), while input names never do.
    const separator = key.indexOf(':')
    if (separator <= 0 || separator === key.length - 1) {
      result.skipped.push({ key, reason: 'malformed-key' })
      continue
    }
    const nodeId = key.slice(0, separator)
    const inputName = key.slice(separator + 1)
    const node = workflow[nodeId]
    if (node === undefined || node === null || typeof node !== 'object') {
      result.skipped.push({ key, reason: 'node-not-found' })
      continue
    }
    if (node.inputs === undefined) node.inputs = {}
    const previous = node.inputs[inputName]
    const coerced = coerceOverride(raw, previous)
    if (coerced === INVALID_OVERRIDE) {
      result.skipped.push({ key, reason: 'invalid-value' })
      continue
    }
    node.inputs[inputName] = coerced
    result.applied.push({ nodeId, inputName, value: coerced, previous })
    // A pinned `seed` also has to land on `noise_seed` when the node has
    // one: the injector wrote a random value there, and samplers that read
    // `noise_seed` (SamplerCustomAdvanced / RandomNoise / a refiner stage)
    // would otherwise ignore the user's pin.
    if (inputName === 'seed' && node.inputs['noise_seed'] !== undefined && typeof coerced === 'number') {
      node.inputs['noise_seed'] = coerced
    }
  }
  return result
}

/** Sentinel for "the override could not be coerced to the target type".
 *  A unique symbol so a legitimate `undefined` can never collide. */
const INVALID_OVERRIDE = Symbol('invalid-override')

/** Coerce a canvas-supplied override to match the type already on the node.
 *  When there is no previous value we trust the caller (round 4.3 only
 *  renders fields the inspector already found, so this is the rare path). */
function coerceOverride(raw: unknown, previous: unknown): unknown {
  if (raw === null || raw === undefined) return INVALID_OVERRIDE
  if (typeof previous === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
    return Number.isFinite(n) ? n : INVALID_OVERRIDE
  }
  if (typeof previous === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const text = String(raw).trim().toLowerCase()
    if (text === 'true' || text === '1') return true
    if (text === 'false' || text === '0') return false
    return INVALID_OVERRIDE
  }
  if (typeof previous === 'string') return String(raw)
  // No previous value to learn the type from: pass it through, but reject
  // objects/arrays so a malformed client can't inject a graph fragment.
  if (typeof raw === 'object') return INVALID_OVERRIDE
  return raw
}