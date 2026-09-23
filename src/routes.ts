/**
 * The /api/dsh-imagegen route family: a loopback-only settings bridge for the
 * plugin's own namespace (describe/mutate, mirroring the dsh-web-ui family
 * bridge wire), the image-model discovery route the canvas workflow picker
 * uses to list ComfyUI workflows on a channel, and the canvas surface itself
 * (project list / read / save / asset storage / skill catalog / workflow
 * inspection + run).
 *
 * Round 5: the panel/ecommerce/generation-studio routes (generate proxy,
 * history, gallery, template library, update check, object-storage probe,
 * data-folder reveal) were removed alongside the surfaces that owned them.
 * Canvas persistence and skills are the only routes left.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type { UpstreamConfig } from './engine.ts'
import { fetchComfyUiWorkflow, UiFormatWorkflowError, type ApiWorkflow } from './comfyui-workflow-loader.ts'
import { inspectWorkflow } from './comfyui-workflow-inspect.ts'
import { listImageModels } from './prompt-enhancer.ts'
import { analyzeLayers, MAX_LAYER_IMAGE_BYTES } from './layer-analyzer.ts'
import { normalizeImageModels } from './image-models.ts'
import { ImageGenerationRuntime, type ChannelsView } from './generation-runtime.ts'
import { progressForWorkflowNode, progressTrackerFor } from './comfyui-progress.ts'
import { baseMime, canvasStore, CanvasConflictError, MAX_CANVAS_FILE_BYTES, mimeFromFileName, safeFileName, type CanvasFileInput, type CanvasImageInput, type CanvasStore } from './canvas-store.ts'
import { buildFilePreview } from './file-preview.ts'
import { isComfyUiPreset, listComfyUiWorkflows, probeComfyUiService } from './comfyui-workflows.ts'
import { IMAGE_PRESETS } from './presets.ts'
import { CANVAS_API, CANVAS_SKILL_API, IMAGEGEN_SETTINGS_NAMESPACE, IMAGE_MODEL_API, PRESETS_API, SETTINGS_API, type CanvasDocument, type CanvasSkillCatalog, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type CanvasSkillRunRequest, type CanvasSkillTask, type CanvasGenerateRequest, type ImportedWorkflowLibraryDeleteRequest, type ImportedWorkflowLibraryImportRequest, type ImportedWorkflowLibraryListResult, type ImportedWorkflowLibraryRenameRequest, type ModelMapping, type PresetProviderView } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'
import { deleteImportedWorkflow, importWorkflowToLibrary, listImportedWorkflows, pathOfImportedWorkflow, renameImportedWorkflow } from './workflow-library.ts'

/** Cap on JSON request bodies (settings ops and canvas payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024

/** Cap on canvas asset upload bodies (base64 PNG/JPEG can be much larger). */
const MAX_ASSET_BODY_BYTES = 64 * 1024 * 1024

/** Image types the asset route always serves inline (they cannot execute). */
const CANVAS_INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/

/**
 * The only non-image types `?inline=1` will serve with their real content type:
 * the browser's own renderers for documents and media. Anything not listed here
 * (HTML, SVG, XML, unknown binaries) keeps coming back as an attachment.
 */
const CANVAS_INLINE_MIME = /^(application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/

/** Parse one `bytes=a-b` range header; undefined when absent or unsatisfiable. */
function parseByteRange(header: string | string[] | undefined, size: number): { start: number; end: number } | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || size <= 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return undefined
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return undefined
  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return undefined
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined
    if (start >= size) return undefined
    end = Math.min(end, size - 1)
  }
  if (end < start) return undefined
  return { start, end }
}

/** Settings seam face the bridge needs (the host settings provider). */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: unknown, ops: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
}

/** Route dependencies. */
export interface ImageGenRoutesDeps {
  /** The settings seam (namespace storage). */
  settings: SettingsSeam
  /** Resolve the current upstream config (legacy single-endpoint path). */
  resolve: () => UpstreamConfig
  /** Resolve the current channel view (the channel-aware path). */
  resolveChannels?: () => ChannelsView
  /** Resolve the optional chat-model configuration for layer decomposition. */
  resolvePrompt?: () => { apiUrl: string; apiKey: string; model: string }
  /** Models explicitly selected for this image API endpoint (legacy path). */
  resolveImageModels?: () => string[]
  /** Overrideable canvas backend, primarily for host integration tests. */
  canvas?: CanvasBackend
  /** Shared host runtime, used by the canvas workflow run route. */
  runtime?: ImageGenerationRuntime
  /**
   * Canvas skill runner. Absent when the host skill registry or agent runtime
   * never mounted (deployments without them): the canvas then offers its
   * built-in text actions only and says why.
   */
  skills?: {
    list: (language?: string) => Promise<CanvasSkillCatalog>
    run: (request: CanvasSkillRunRequest) => Promise<CanvasSkillTask>
    task: (id: string) => CanvasSkillTask | undefined
    tasksOfCanvas: (canvasId: string) => CanvasSkillTask[]
    cancel: (id: string) => Promise<boolean>
  }
  /**
   * Local skill library (`~/.dsh/skills`). Absent on hosts that cannot write to
   * the user's skill root: the browser then hides the install affordances.
   */
  skillLibrary?: {
    list: (options?: { language?: string }) => Promise<CanvasSkillLibrary>
    install: (request: CanvasSkillInstallRequest) => Promise<CanvasSkillInstallResult>
    remove: (name: string, options?: { language?: string }) => Promise<CanvasSkillRemoveResult>
    /** Save the values a skill's own declaration asked for. */
    configSave?: (request: CanvasSkillConfigSaveRequest) => Promise<CanvasSkillConfigSaveResult>
    /** Run the declaration's `apply` steps (commands / files). */
    configApply?: (request: CanvasSkillConfigApplyRequest) => Promise<CanvasSkillConfigApplyResult>
  }
}

/** Minimal canvas store contract so hosts can inject an isolated test backend. */
export interface CanvasBackend {
  list: () => Promise<Awaited<ReturnType<CanvasStore['list']>>>
  create: (title?: string) => Promise<Awaited<ReturnType<CanvasStore['create']>>>
  read: (id: string) => Promise<Awaited<ReturnType<CanvasStore['read']>>>
  save: (document: CanvasDocument, expectedRevision?: number) => Promise<Awaited<ReturnType<CanvasStore['save']>>>
  remove: (id: string) => Promise<Awaited<ReturnType<CanvasStore['remove']>>>
  putImage: (input: CanvasImageInput) => Promise<Awaited<ReturnType<CanvasStore['putImage']>>>
  readAsset: (file: string) => Promise<Awaited<ReturnType<CanvasStore['readAsset']>>>
  /** File assets (the canvas file node). Optional so older test backends work. */
  putFile?: (input: CanvasFileInput) => Promise<Awaited<ReturnType<CanvasStore['putFile']>>>
  /** Batch asset read, used by skill runs. Optional for the same reason. */
  readAssets?: (refs: readonly import('./protocol.ts').CanvasAssetRef[]) => Promise<Map<string, { data: Buffer; mime: string }>>
  /** Copy one asset to a real path for a heavy skill run. */
  materialize?: (ref: import('./protocol.ts').CanvasAssetRef, targetPath: string) => Promise<void>
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read a raw request body (the canvas file upload path; no base64 inflation). */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate the body of a canvas skill run (projected from the browser). */
function parseSkillRunRequest(body: Record<string, unknown> | undefined): CanvasSkillRunRequest | undefined {
  const canvasId = typeof body?.canvasId === 'string' ? body.canvasId.trim() : ''
  const skillId = typeof body?.skillId === 'string' ? body.skillId.trim() : ''
  if (canvasId === '' || skillId === '') return undefined
  const nodeIds = Array.isArray(body?.nodeIds)
    ? [...new Set(body.nodeIds.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== ''))]
    : []
  const instruction = typeof body?.instruction === 'string' ? body.instruction : undefined
  const params: Record<string, string> = {}
  if (body?.params !== null && typeof body?.params === 'object' && !Array.isArray(body.params)) {
    for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value
    }
  }
  return {
    canvasId,
    skillId,
    nodeIds,
    ...instruction === undefined ? {} : { instruction },
    ...Object.keys(params).length === 0 ? {} : { params },
    placement: body?.placement === 'below' ? 'below' : 'right',
    ...parseSkillLanguage(body),
  }
}

/** The UI language hint every skill route accepts (copy stays translated). */
function parseSkillLanguage(body: Record<string, unknown> | undefined): { language?: string } {
  const raw = typeof body?.language === 'string' ? body.language.trim().toLowerCase() : ''
  // Only the shipped dictionaries are accepted: the value reaches a lookup.
  return raw === 'zh' || raw === 'en' || raw === 'ru' ? { language: raw } : {}
}

/**
 * Normalize one skill-library install request: sources are trimmed, de-duped
 * URLs, and the uploaded archive is taken from an asset reference the canvas
 * upload route already stored (the host never sees raw browser bytes twice).
 */
function parseSkillInstallRequest(body: Record<string, unknown> | undefined): CanvasSkillInstallRequest | undefined {
  const raw = Array.isArray(body?.sources) ? body.sources : []
  const sources = [...new Set(raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item !== ''))].slice(0, 10)
  const asset = body?.asset !== null && typeof body?.asset === 'object' && !Array.isArray(body.asset)
    ? body.asset as import('./protocol.ts').CanvasAssetRef
    : undefined
  if (sources.length === 0 && asset === undefined) return undefined
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  return {
    ...sources.length === 0 ? {} : { sources },
    ...asset === undefined ? {} : { asset },
    ...name === '' ? {} : { name },
    force: body?.force === true,
    ...parseSkillLanguage(body),
  }
}

function parseGenerateRequest(body: Record<string, unknown>): CanvasGenerateRequest | undefined {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return undefined
  return {
    mode: 'text',
    model: typeof body.model === 'string' ? body.model : '',
    prompt,
    size: typeof body.size === 'string' ? body.size : 'auto',
    quality: typeof body.quality === 'string' ? body.quality : 'auto',
    n: typeof body.n === 'number' ? body.n : 1,
    detail: typeof body.detail === 'string' ? body.detail : '',
    ...Array.isArray(body.images)
      ? { images: body.images.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 4) }
      : {},
    ...typeof body.channelId === 'string' && body.channelId !== '' ? { channelId: body.channelId } : {},
    ...typeof body.canvasId === 'string' && body.canvasId !== '' ? { canvasId: body.canvasId } : {},
    ...typeof body.sourceNodeId === 'string' && body.sourceNodeId !== '' ? { sourceNodeId: body.sourceNodeId } : {},
  }
}

function imageDataUrl(value: string): { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: Uint8Array } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const data = Buffer.from(match[2], 'base64')
  return data.byteLength === 0 ? undefined : { mediaType: match[1] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data }
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor: SettingsDescriptor): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    ...descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })),
    },
    revision: descriptor.revision,
  }
}

/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'settings-rejected', message }
}

/**
 * Build every /api/dsh-imagegen route.
 * @param deps - settings seam + config resolver.
 * @returns the route registrations.
 */
export function makeRoutes(deps: ImageGenRoutesDeps): WebRoute[] {
  const canvas = deps.canvas ?? canvasStore
  const resolvePrompt = deps.resolvePrompt ?? (() => ({ apiUrl: '', apiKey: '', model: '' }))
  const resolveImageModels = deps.resolveImageModels ?? (() => normalizeImageModels(undefined))

  /** The current channel view: the channel-aware resolver, or a synthesized
   *  single default channel from the legacy flat upstream config (tests and
   *  older hosts). */
  const channelViewOf = (): ChannelsView => {
    if (deps.resolveChannels !== undefined) return deps.resolveChannels()
    const upstream = deps.resolve()
    const models: ModelMapping[] = normalizeImageModels(resolveImageModels()).map(id => ({ alias: id, id }))
    if (upstream.apiUrl.trim() === '' && models.length === 0) return { channels: [], defaultChannelId: '' }
    return {
      channels: [{ id: 'default', preset: '', name: '默认渠道', apiUrl: upstream.apiUrl, apiKey: upstream.apiKey, models }],
      defaultChannelId: 'default',
    }
  }
  const runtime = deps.runtime ?? new ImageGenerationRuntime(channelViewOf)

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  return [
    // -------------------------------------------- image model discovery
    // Accepts optional temporary per-channel credentials so the settings card
    // can probe the endpoint the user is *typing* without saving first:
    //   { channelId?, apiUrl?, apiKey?, forceKind? } — the channel's stored
    //   values are the fallback, and the body's apiUrl/apiKey override them
    //   for this call. `forceKind: 'comfyui' | 'openai'` lets pre-channel
    //   probes (the "add ComfyUI service" picker) tell the route to dispatch
    //   as ComfyUI even when the user has no channel saved yet.
    //
    // For ComfyUI channels the response is `{ kind: 'comfyui', probe }` —
    // ComfyUI mainline does NOT expose a workflow-listing HTTP route, so the
    // endpoint only confirms reachability via POST /prompt; the user types
    // workflow names by hand. Other channels fall back to the OpenAI-style
    // `/v1/models` enumeration.
    {
      kind: 'exact',
      path: IMAGE_MODEL_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const view = channelViewOf()
        const stored = view.channels.find(candidate => candidate.id === (typeof body?.channelId === 'string' ? body.channelId : undefined))
          ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
          ?? view.channels[0]
        const upstream: UpstreamConfig = {
          apiUrl: typeof body?.apiUrl === 'string' && body.apiUrl.trim() !== '' ? body.apiUrl.trim() : (stored?.apiUrl ?? ''),
          apiKey: typeof body?.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : (stored?.apiKey ?? ''),
        }
        const storedPreset = stored?.preset ?? ''
        const forceKind = typeof body?.forceKind === 'string' && (body.forceKind === 'comfyui' || body.forceKind === 'openai')
          ? body.forceKind
          : null
        // The picker is the only caller that wants a `probe` (a connectivity
        // check before the user has committed to a preset). It signals this
        // intent explicitly via `probeOnly: true`. Every other ComfyUI
        // dispatch — the channel editor — wants the full workflow listing.
        const probeOnly = body?.probeOnly === true
        // Heuristic fallback: a channel created before the ComfyUI preset
        // field landed has `preset === ''` even though the user clearly
        // wants ComfyUI dispatch. When the URL looks like a ComfyUI
        // service (typical local port, no `/v1`/`/api/v1` OpenAI-shaped
        // suffix), treat it as ComfyUI so old settings keep dispatching
        // correctly. The picker sets `forceKind: 'comfyui'` explicitly so
        // the heuristic never overrides an explicit user choice.
        const url = upstream.apiUrl.trim()
        const looksLikeComfyUiUrl = url !== ''
          && !/\/v\d(?:\/|$)/.test(url)
          && /^https?:\/\//.test(url)
        const treatAsComfyUi = isComfyUiPreset(storedPreset)
          || forceKind === 'comfyui'
          || (storedPreset === '' && forceKind !== 'openai' && looksLikeComfyUiUrl)
        try {
          if (treatAsComfyUi) {
            const comfyPreset = storedPreset === '' ? 'comfyui-local' : storedPreset
            // `probeOnly: true` (set by the picker) → return a connectivity
            // probe. Otherwise return the folder-grouped workflow listing.
            if (probeOnly) {
              const probe = await probeComfyUiService(upstream, { preset: comfyPreset })
              writeJson(res, 200, { ok: true, kind: 'comfyui', probe })
              return
            }
            const workflows = await listComfyUiWorkflows(upstream, { preset: comfyPreset })
            writeJson(res, 200, { ok: true, kind: 'comfyui', workflows })
            return
          }
          const models = await listImageModels(upstream)
          writeJson(res, 200, { ok: true, kind: 'openai', models })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'image-models-failed'
          writeJson(res, 200, { ok: false, code, message })
        }
      },
    },
    // ---------------------------------------------------------- presets
    {
      kind: 'exact',
      path: PRESETS_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const presets: PresetProviderView[] = IMAGE_PRESETS.map(preset => ({
          id: preset.id,
          name: preset.name,
          apiUrl: preset.apiUrl,
          hint: preset.hint,
          models: preset.models,
        }))
        writeJson(res, 200, { ok: true, presets })
      },
    },
    // -------------------------------------------------- settings describe
    {
      kind: 'exact',
      path: SETTINGS_API.describe,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === IMAGEGEN_SETTINGS_NAMESPACE)
        writeJson(res, 200, {
          ok: true,
          value: {
            namespaces: descriptor === undefined ? [] : [toView(descriptor)],
            writable: deps.settings.writable !== false,
          },
        })
      },
    },
    // ----------------------------------------------------- settings mutate
    {
      kind: 'exact',
      path: SETTINGS_API.mutate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const ns = typeof body.ns === 'string' ? body.ns : ''
        if (ns !== IMAGEGEN_SETTINGS_NAMESPACE || !Array.isArray(body.ops)) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
          return
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
        try {
          // The alpha.2 settings package no longer exports settingsNamespace;
          // the bridge already checked this value against our fixed namespace.
          await deps.settings.mutate(ns, body.ops, expectedRevision)
        } catch (error) {
          writeJson(res, 200, failureOf(error))
          return
        }
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === ns)
        if (descriptor === undefined) {
          writeJson(res, 200, { ok: false, code: 'internal', message: `settings namespace "${ns}" was disposed after the mutate` })
          return
        }
        writeJson(res, 200, { ok: true, value: toView(descriptor) })
      },
    },
    // ------------------------------------------------------ canvas list
    {
      kind: 'exact',
      path: CANVAS_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try { writeJson(res, 200, { ok: true, projects: await canvas.list() }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- canvas create
    {
      kind: 'exact',
      path: CANVAS_API.create,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const title = typeof body?.title === 'string' ? body.title : '未命名画布'
        try { writeJson(res, 200, { ok: true, document: await canvas.create(title) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------------ canvas read
    {
      kind: 'exact',
      path: CANVAS_API.read,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const document = id === '' ? undefined : await canvas.read(id)
        if (document === undefined) writeJson(res, 200, { ok: false, code: 'not-found', message: '画布不存在' })
        else writeJson(res, 200, { ok: true, document })
      },
    },
    // ------------------------------------------------------ canvas save
    {
      kind: 'exact',
      path: CANVAS_API.save,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const document = body?.document as CanvasDocument | undefined
        const expectedRevision = typeof body?.expectedRevision === 'number' ? body.expectedRevision : undefined
        if (document === undefined || typeof document !== 'object') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvas document is required' })
          return
        }
        try { writeJson(res, 200, { ok: true, document: await canvas.save(document, expectedRevision) }) }
        catch (error) {
          const code = error instanceof CanvasConflictError ? error.code : 'canvas-failed'
          writeJson(res, 200, { ok: false, code, message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------- canvas remove
    {
      kind: 'exact',
      path: CANVAS_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvas id is required' }); return }
        try { writeJson(res, 200, { ok: true, projects: await canvas.remove(id) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------ canvas asset upload
    {
      kind: 'exact',
      path: CANVAS_API.assetUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_ASSET_BODY_BYTES)
        const parsed = typeof body?.dataUrl === 'string' ? imageDataUrl(body.dataUrl) : undefined
        const width = Number(body?.width)
        const height = Number(body?.height)
        if (parsed === undefined || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'image data and dimensions are required' })
          return
        }
        try {
          const asset = await canvas.putImage({
            data: parsed.data,
            mime: parsed.mediaType,
            width,
            height,
            origin: body?.origin === 'generated' ? 'generated' : 'upload',
            ...typeof body?.originId === 'string' ? { originId: body.originId } : {},
            ...typeof body?.entryId === 'string' ? { entryId: body.entryId } : {},
            ...Number.isSafeInteger(Number(body?.imageIndex)) ? { imageIndex: Number(body?.imageIndex) } : {},
          })
          writeJson(res, 200, { ok: true, asset })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-asset-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------- canvas layer decomposition
    // The browser sends one image data URL; the host asks the configured chat
    // model (the prompt-enhancement endpoint) for a strict JSON layer plan.
    {
      kind: 'exact',
      path: CANVAS_API.layers,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const raw = typeof body?.image === 'string' ? body.image.trim() : ''
        const image = raw === '' ? undefined : imageDataUrl(raw)
        if (image === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'image data URL is required' })
          return
        }
        if (image.data.byteLength > MAX_LAYER_IMAGE_BYTES) {
          writeJson(res, 200, { ok: false, code: 'image-too-large', message: '图片超过 12MB 上限，请先压缩后再拆分图层' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, plan: await analyzeLayers(resolvePrompt(), raw) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'layer-analysis-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------- canvas asset (prefix)
    {
      kind: 'prefix',
      path: CANVAS_API.asset,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if (req.method !== 'GET') { writeJson(res, 405, { error: `method not allowed: ${req.method}` }); return }
        const file = imageFileFrom(req.url, CANVAS_API.asset)
        const found = file === undefined ? undefined : await canvas.readAsset(file)
        if (found === undefined) { writeJson(res, 404, { error: 'not found' }); return }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        // Image assets stay inline (the canvas renders them). Only an explicit
        // `?inline=1` unlocks the other previewable types (pdf / audio / video),
        // and only from a fixed allow-list: everything else — including any
        // HTML/SVG-shaped payload that slipped past the upload name check — is
        // forced into a download with a neutral content type, so it can never
        // execute in the app's origin.
        const image = CANVAS_INLINE_IMAGE_MIME.test(found.mime)
        const wantsInline = url.searchParams.get('inline') === '1'
        const downloadRequested = url.searchParams.get('download') === '0'
        const inline = (image && !downloadRequested) || (wantsInline && CANVAS_INLINE_MIME.test(found.mime))
        if (!inline) {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': found.data.length,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-disposition': `attachment; filename="${file ?? 'asset'}"`,
          })
          res.end(found.data)
          return
        }
        const headers: Record<string, string | number> = {
          'content-type': found.mime,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename="${file ?? 'asset'}"`,
          'accept-ranges': 'bytes',
        }
        // Media elements ask for byte ranges; answering 200 for every request
        // would break seeking in audio/video previews.
        const range = parseByteRange(req.headers.range, found.data.length)
        if (range !== undefined) {
          const slice = found.data.subarray(range.start, range.end + 1)
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${range.start}-${range.end}/${found.data.length}`,
            'content-length': slice.length,
          })
          res.end(slice)
          return
        }
        res.writeHead(200, { ...headers, 'content-length': found.data.length })
        res.end(found.data)
      },
    },
    // ------------------------------------------------- canvas file upload
    // Raw binary (the browser sends the File object directly), so large files
    // never pay the base64 + JSON round trip the image path uses. Note that
    // this path also prefix-matches CANVAS_API.asset; the host router resolves
    // exact routes first, exactly as it already does for `/canvas/layers`.
    {
      kind: 'exact',
      path: CANVAS_API.fileUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (canvas.putFile === undefined) {
          writeJson(res, 200, { ok: false, code: 'canvas-files-unsupported', message: '当前画布后端不支持文件资产' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const name = safeFileName(url.searchParams.get('name') ?? 'file')
        const header = req.headers['content-type']
        const declared = typeof header === 'string' ? header : ''
        const mime = declared.trim() === '' ? mimeFromFileName(name) : declared
        const data = await readRawBody(req, MAX_CANVAS_FILE_BYTES)
        if (data === undefined || data.byteLength === 0) {
          writeJson(res, 200, { ok: false, code: 'file-too-large', message: `文件为空或超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限` })
          return
        }
        try {
          const asset = await canvas.putFile({ data, mime, name, origin: 'upload' })
          writeJson(res, 200, { ok: true, asset })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-file-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------ canvas file preview
    // One canvas file node asks for its readable content: text / table /
    // office text / archive listing / inline-media descriptor. The bytes stay
    // host-side; the browser only ever receives decoded, bounded content.
    {
      kind: 'exact',
      path: CANVAS_API.filePreview,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const assetId = typeof body?.assetId === 'string' ? body.assetId : ''
        if (assetId === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'assetId 是必填项' })
          return
        }
        const found = await canvas.readAsset(assetId)
        if (found === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '画布资产不存在，可能已被清理。' })
          return
        }
        try {
          // The browser's node metadata knows the original file name and MIME
          // type; the content-addressed store only kept an extension-derived
          // pair, so the hints make the format decision more accurate. They are
          // hints only: the bytes always come from the host-side asset.
          const hintName = typeof body?.name === 'string' ? safeFileName(body.name) : ''
          const rawMime = typeof body?.mime === 'string' && body.mime.length <= 160 ? baseMime(body.mime) : ''
          const mime = rawMime === '' || rawMime === 'application/octet-stream' ? found.mime : rawMime
          writeJson(res, 200, {
            ok: true,
            preview: buildFilePreview({
              data: found.data,
              mime,
              name: hintName === '' ? assetId : hintName,
              url: `${CANVAS_API.asset}/${encodeURIComponent(assetId)}?inline=1`,
            }),
          })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'preview-failed', message: messageOf(error) }) }
      },
    },
    // --------------------------------------------------- canvas skills list
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skills === undefined) {
          writeJson(res, 200, {
            ok: true,
            skills: [],
            agentAvailable: false,
            registryAvailable: false,
            reason: '本宿主未挂载技能注册表（ctx.skills），画布技能不可用。',
          })
          return
        }
        try { writeJson(res, 200, { ok: true, ...await deps.skills.list(parseSkillLanguage(body).language) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skills-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- canvas skills run
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.run,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const request = parseSkillRunRequest(body)
        if (request === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvasId、skillId 与 nodeIds 是必填项' })
          return
        }
        if (deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'skills-unavailable', message: '本宿主未挂载技能运行时，画布技能不可用。' })
          return
        }
        try { writeJson(res, 200, { ok: true, task: await deps.skills.run(request) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skill-run-failed', message: messageOf(error) }) }
      },
    },
    // --------------------------------------------------- canvas skills task
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.task,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        // A canvas id without a task id lists the canvas's unfinished runs:
        // a reopened canvas rebuilds its live run cards from this.
        const canvasId = typeof body?.canvasId === 'string' ? body.canvasId.trim() : ''
        if (canvasId !== '') {
          writeJson(res, 200, { ok: true, tasks: deps.skills.tasksOfCanvas(canvasId) })
          return
        }
        const id = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        const task = deps.skills.task(id)
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    // ------------------------------------------------- canvas skills cancel
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.cancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
        if (id === '' || deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        try { writeJson(res, 200, { ok: true, cancelled: await deps.skills.cancel(id) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skill-cancel-failed', message: messageOf(error) }) }
      },
    },
    // -------------------------------------------------- skill library (local)
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.library,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持管理本机技能库。' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, library: await deps.skillLibrary.list(parseSkillLanguage(body)) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'library-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.install,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持安装技能。' })
          return
        }
        const request = parseSkillInstallRequest(body)
        if (request === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请提供技能来源链接或上传压缩包。' })
          return
        }
        try { writeJson(res, 200, await deps.skillLibrary.install(request)) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'install-failed', message: messageOf(error) }) }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持卸载技能。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        try { writeJson(res, 200, await deps.skillLibrary.remove(name, parseSkillLanguage(body))) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'remove-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------ skill configuration (declared per skill)
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.configSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary?.configSave === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持保存技能配置。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        const values = (Array.isArray(body?.values) ? body.values : [])
          .map(item => {
            if (item === null || typeof item !== 'object') return undefined
            const record = item as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id === '' || typeof record.value !== 'string') return undefined
            return { id, value: record.value }
          })
          .filter((item): item is { id: string; value: string } => item !== undefined)
          .slice(0, 64)
        try {
          writeJson(res, 200, await deps.skillLibrary.configSave({ name, values, ...parseSkillLanguage(body) }))
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'config-save-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.configApply,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary?.configApply === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持应用技能配置。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        try {
          writeJson(res, 200, await deps.skillLibrary.configApply({ name, ...parseSkillLanguage(body) }))
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'config-apply-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------- canvas workflow inspect
    // Resolve the model alias on the configured channel into a workflow
    // path, load the workflow JSON, run it through the inspector, and
    // return a canvas-ready snapshot. The canvas UI uses the snapshot to
    // render the workflow node's text / image ports and advanced-options
    // accordion (round 2). Wiring those ports and feeding them into the
    // engine is round 3+.
    {
      kind: 'exact',
      path: CANVAS_API.workflowInspect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const channelId = typeof body?.channelId === 'string' ? body.channelId.trim() : ''
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        const workflowBody = typeof body?.workflowBody === 'string' ? body.workflowBody : ''
        if (channelId === '' || model === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'channelId 和 model 都必填' })
          return
        }
        const view = channelViewOf()
        const channel = view.channels.find(candidate => candidate.id === channelId)
          ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
          ?? view.channels[0]
        if (channel === undefined) {
          writeJson(res, 200, { ok: false, code: 'no-channels', message: '尚未配置任何渠道' })
          return
        }
        // Library reference: a model string of the shape `library:<id>` is
        // a pointer into the imported workflow library (managed by
        // `src/workflow-library.ts`). We resolve it to the stored absolute
        // path and bypass the channel.models check — these workflows live
        // outside the configured model aliases on purpose, so the canvas
        // can use a previously-uploaded JSON with any ComfyUI channel.
        let libraryWorkflowPath: string | undefined
        if (model.startsWith('library:')) {
          const libraryId = model.slice('library:'.length).trim()
          if (libraryId === '') {
            writeJson(res, 200, { ok: false, code: 'bad-request', message: 'library 别名缺少 id' })
            return
          }
          const resolved = await pathOfImportedWorkflow(libraryId)
          if (resolved === null) {
            writeJson(res, 200, { ok: false, code: 'library-not-found', message: `库中找不到工作流 id「${libraryId}」` })
            return
          }
          libraryWorkflowPath = resolved
        }
        // Only the channel.models lookup is meaningful for non-library
        // aliases; library aliases skip it by design.
        const mapping = libraryWorkflowPath !== undefined
          ? undefined
          : channel.models.find(entry => entry.alias === model || entry.id === model)
        if (libraryWorkflowPath === undefined && mapping === undefined) {
          writeJson(res, 200, { ok: false, code: 'image-model-not-configured', message: `模型「${model}」未在渠道「${channel.name}」配置` })
          return
        }
        // The model alias may carry a family prefix (`comfyui:`) that the
        // engine strips when reading the workflow; mirror that here. For
        // library aliases the workflow "path" is the absolute file path
        // itself, so the loader's absolute-path branch will pick it up.
        const workflowPath = libraryWorkflowPath
          ?? (mapping!.alias.startsWith('comfyui:')
            ? mapping!.alias.slice('comfyui:'.length)
            : (mapping!.id.trim() === '' ? mapping!.alias : mapping!.id))
        try {
          // Round 3.5: an explicit `workflowBody` (e.g. an API-format JSON
          // the user uploaded) lets the canvas preview a workflow that is
          // not on disk yet. We persist it under `imported-workflows/` so
          // the engine's file-fetcher can hand the same body to ComfyUI
          // when the user clicks Run.
          let workflow: ApiWorkflow
          let inspectedFrom = 'channel'
          let importedWorkflowPath: string | undefined
          if (workflowBody !== '') {
            try {
              const parsed = JSON.parse(workflowBody) as unknown
              const probe = inspectWorkflow(parsed)
              if (probe === null) throw new UiFormatWorkflowError('(已导入) workflow JSON')
              workflow = parsed as ApiWorkflow
              inspectedFrom = 'imported'
              const dir = path.join(imageDataRoot(), 'imported-workflows')
              await fsMkdir(dir, { recursive: true })
              importedWorkflowPath = path.join(dir, `${randomUUID()}.json`)
              await fsWriteFile(importedWorkflowPath, workflowBody, 'utf8')
            } catch (parseError) {
              if (parseError instanceof UiFormatWorkflowError) throw parseError
              throw new UiFormatWorkflowError('(已导入) workflow JSON')
            }
          } else {
            // Pull the workflow via the same loader the engine uses for
            // generation. This means inspect and generate share the same
            // fetch logic (HTTP-first with installDir fallback) and the
            // same UiFormatWorkflowError surface.
            const upstream: UpstreamConfig = {
              apiUrl: channel.apiUrl,
              apiKey: channel.apiKey,
              ...channel.installDir === undefined ? {} : { installDir: channel.installDir },
            }
            workflow = await fetchComfyUiWorkflow(upstream, workflowPath, { installDir: upstream.installDir })
          }
          const inspection = inspectWorkflow(workflow)
          if (inspection === null) {
            // Should not happen — fetchComfyUiWorkflow would have
            // raised UiFormatWorkflowError before we got here. Defence
            // in depth: report the friendly path anyway.
            writeJson(res, 200, {
              ok: false,
              code: 'ui-format',
              status: 'ui-format',
              message: `工作流「${workflowPath}」不是 ComfyUI API 格式。请在 ComfyUI 浏览器里用 Save (API Format) 另存。`,
            })
            return
          }
          // Project the scanner output into the canvas metadata shape.
          const workflowName = inspectedFrom === 'imported'
            ? (typeof body?.workflowName === 'string' && body.workflowName.trim() !== '' ? body.workflowName.trim() : '已导入工作流')
            : (workflowPath.includes('/') || workflowPath.includes('\\')
              ? workflowPath.slice(Math.max(workflowPath.lastIndexOf('/'), workflowPath.lastIndexOf('\\')) + 1)
              : workflowPath)
          // Imported workflows need the engine to fetch the file we just
          // wrote; switch the run-time workflowPath to that local path so
          // fetchComfyUiWorkflow picks it up via installDir's local
          // fallback (or absolute path read).
          const runWorkflowPath = importedWorkflowPath ?? workflowPath
          // The runtime alias follows three flavours:
          //  - imported legacy / library: `comfyui:<absolute-path>` so the
          //    loader's absolute-path branch reads the file we just wrote
          //  - regular channel model: the original `mapping.alias`
          // When the user picked from the library, mapping is undefined
          // (we skipped the channel.models lookup) — use the absolute
          // path alias so generateComfyUiImage can find the same file.
          const runModel = importedWorkflowPath !== undefined
            ? `comfyui:${importedWorkflowPath}`
            : libraryWorkflowPath !== undefined
              ? `comfyui:${libraryWorkflowPath}`
              : mapping!.alias
          writeJson(res, 200, {
            ok: true,
            inspection: {
              channelId: channel.id,
              channelName: channel.name,
              model: runModel,
              workflowPath: runWorkflowPath,
              workflowName,
              inspectedFrom,
              fingerprint: inspection.fingerprint,
              textSlots: inspection.text.map(slot => ({
                nodeId: slot.nodeId,
                inputName: slot.inputName,
                classType: slot.classType,
                label: slot.label,
              })),
              imageSlots: inspection.image.map(slot => ({
                nodeId: slot.nodeId,
                inputName: slot.inputName,
                classType: slot.classType,
                label: slot.label,
              })),
              options: inspection.options.map(option => ({
                nodeId: option.nodeId,
                inputName: option.inputName,
                classType: option.classType,
                label: option.label,
                type: option.type,
                // Surface the inline default so the canvas UI can
                // pre-populate the option field. Round 4.3 will let the
                // user override these; round 4.1/4.2 only display them.
                defaultValue: option.defaultValue,
              })),
              size: inspection.size !== null
                ? { nodeId: inspection.size.nodeId, width: inspection.size.width, height: inspection.size.height }
                : null,
              unrecognisedCount: inspection.unrecognised.length,
              status: 'ok',
              advancedOverrides: {},
            },
          })
        } catch (error) {
          if (error instanceof UiFormatWorkflowError) {
            writeJson(res, 200, {
              ok: false,
              code: 'ui-format',
              status: 'ui-format',
              message: error.message,
            })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, code: 'inspect-failed', status: 'error', message })
        }
      },
    },
    // ---------------------------------------------------- workflow run (round 4)
    {
      kind: 'exact',
      path: CANVAS_API.runWorkflow,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const canvasId = typeof body?.canvasId === 'string' ? body.canvasId.trim() : ''
        const workflowNodeId = typeof body?.workflowNodeId === 'string' ? body.workflowNodeId.trim() : ''
        if (canvasId === '' || workflowNodeId === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvasId 和 workflowNodeId 都必填' })
          return
        }
        const document = await canvas.read(canvasId)
        if (document === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '画布不存在' })
          return
        }
        const workflowNode = document.nodes.find(node => node.id === workflowNodeId && node.type === 'workflow')
        if (workflowNode === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '工作流节点不存在' })
          return
        }
        const metadata = workflowNode.metadata?.workflow
        if (metadata === undefined || metadata.status !== 'ok') {
          writeJson(res, 200, { ok: false, code: 'workflow-not-ready', message: '工作流尚未分析完成,请稍候' })
          return
        }
        // Collect text inputs: connections into the workflow node, filtered
        // to text slots whose source is a text node. The first connected
        // text slot's content becomes the prompt (round 4.1 convention;
        // round 4.2 will route per `toHandle`).
        const incoming = document.connections.filter(connection => connection.toNodeId === workflowNodeId)
        const textParts: string[] = []
        for (const connection of incoming) {
          const fromNode = document.nodes.find(node => node.id === connection.fromNodeId)
          if (fromNode?.type !== 'text') continue
          const text = typeof fromNode.metadata?.text === 'string' ? fromNode.metadata.text.trim() : ''
          if (text !== '') textParts.push(text)
        }
        if (textParts.length === 0) {
          writeJson(res, 200, { ok: false, code: 'no-prompt', message: '请先把文本节点连到工作流端口再生成' })
          return
        }
        // Round 4.5: image connections — an image node wired into an image
        // slot (`toHandle` = `${nodeId}:${inputName}`). The asset lives on
        // the host (`asset.url` = /api/dsh-imagegen/canvas/asset/<file>);
        // read the bytes back and forward them to the engine as a data URL,
        // which uploads each to ComfyUI and writes the filename into the
        // workflow's image widget.
        const imageSlots: Array<{ nodeId: string; inputName: string; data: string }> = []
        for (const connection of incoming) {
          const fromNode = document.nodes.find(node => node.id === connection.fromNodeId)
          if (fromNode?.type !== 'image') continue
          const asset = fromNode.metadata?.asset
          if (asset === undefined || typeof connection.toHandle !== 'string') continue
          const separator = connection.toHandle.indexOf(':')
          if (separator <= 0 || separator === connection.toHandle.length - 1) continue
          const file = asset.url.slice(asset.url.lastIndexOf('/') + 1)
          if (file === '') continue
          const read = await canvas.readAsset(file)
          if (read === undefined) continue
          imageSlots.push({
            nodeId: connection.toHandle.slice(0, separator),
            inputName: connection.toHandle.slice(separator + 1),
            data: `data:${read.mime};base64,${read.data.toString('base64')}`,
          })
        }
        // Pick a ComfyUI channel whose model alias matches the workflow's
        // configured model. Round 2 inspection already populated
        // `model` on the workflow metadata; reuse it for the run.
        const channelId = metadata.channelId
        const modelAlias = metadata.model
        // Round 4.6: live progress. Correlate every submitted ComfyUI run
        // back to this workflow node so the canvas can poll a percentage
        // while the run is in flight.
        const channelView = channelViewOf()
        const progressBase = channelView.channels.find(candidate => candidate.id === channelId)?.apiUrl?.trim()
        const progressTracker = progressBase !== undefined && progressBase !== ''
          ? progressTrackerFor(progressBase)
          : undefined
        // Round 4.3: the canvas node owns a `${nodeId}:${inputName}` map of
        // widget overrides plus a run multiplier. Both are re-validated
        // here (the canvas document is just JSON on disk, not a trusted
        // boundary) and handed to the engine, which writes them into the
        // workflow right before submitting.
        const overrides = plainRecordOf(metadata.advancedOverrides)
        const runCount = clampRunCount(metadata.runCount)
        // One budget for the whole run. ComfyUI's own poller has a 600 s
        // deadline, but the *submission* fetch carries no timeout of its own,
        // so a wedged local service could leave the canvas node spinning on
        // "生成中" forever. Abort after the same 600 s window; whichever side
        // trips first (poller deadline or this abort) surfaces as an error.
        const controller = new AbortController()
        const budget = setTimeout(() => {
          controller.abort(new DOMException('生成超时', 'TimeoutError'))
        }, 600_000)
        budget.unref?.()
        try {
          const request: CanvasGenerateRequest = {
            mode: 'text',
            model: modelAlias,
            prompt: textParts.join('\n\n'),
            size: 'auto',
            quality: 'auto',
            n: runCount,
            detail: '',
            // Canvas lineage: the result keeps the run attributable to this
            // canvas and back to the workflow node that triggered it.
            canvas: { canvasId, sourceNodeId: workflowNodeId },
            // Round 4.1 sends text only. Round 4.5 fills `imageSlots`
            // (data URLs) from image nodes wired into the workflow's
            // image ports.
            ...overrides === undefined ? {} : { overrides },
            ...imageSlots.length === 0 ? {} : { imageSlots },
          }
          // Round 4.6: make sure the progress socket is connected BEFORE
          // the run starts — fast workflows finish before any progress
          // frame arrives if the socket is still connecting.
          if (progressTracker !== undefined) await progressTracker.ensureConnected()
          const result = await runtime.run(
            { ...request, channelId },
            controller.signal,
            progressTracker === undefined ? undefined : (promptId => progressTracker.register(workflowNodeId, promptId)),
          )
          const images = result.images
          if (images.length === 0) {
            writeJson(res, 200, { ok: false, code: 'no-output', message: 'ComfyUI 未返回任何图片' })
            return
          }
          writeJson(res, 200, {
            ok: true,
            images,
            canvasId,
            workflowNodeId,
            ...(result.comfy?.params === undefined ? {} : { params: result.comfy.params }),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'run-failed'
          // A budget abort (or the engine translating it to 'cancelled')
          // means the run never settled: tell the user why instead of
          // letting "任务已取消" read like an explicit cancel.
          const finalMessage = code === 'cancelled' && controller.signal.aborted
            ? '生成超时（600 秒）：请检查 ComfyUI 是否卡住、队列是否积压'
            : message
          writeJson(res, 200, { ok: false, code, message: finalMessage })
        } finally {
          clearTimeout(budget)
        }
      },
    },
    // ------------------------------------------- workflow progress (round 4.6)
    {
      kind: 'exact',
      path: CANVAS_API.workflowProgress,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '', 'http://localhost')
        const workflowNodeId = url.searchParams.get('workflowNodeId') ?? ''
        if (workflowNodeId === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'workflowNodeId 必填' })
          return
        }
        // Best-effort: when no WS sample is live (socket down, run finished
        // and TTL expired, or progress never emitted) report "not running"
        // and the canvas keeps the plain spinner.
        const sample = progressForWorkflowNode(workflowNodeId)
        const progress = sample === null || sample.max <= 0
          ? null
          : Math.min(100, Math.max(0, Math.round((sample.value / sample.max) * 100)))
        writeJson(res, 200, {
          ok: true,
          running: sample !== null,
          progress,
          node: sample?.node ?? null,
        })
      },
    },
    // -------------------------------- workflow library: list / rename / delete
    // Round 3.5: imported workflows used to live as `<uuid>.json` files
    // with no manifest; the canvas could not see them again. The library
    // module now keeps a manifest so the picker can list / rename / delete
    // them and re-attach to a channel via the manifest's absolute path.
    {
      kind: 'exact',
      path: CANVAS_API.workflowLibraryImport,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const request = body as Partial<ImportedWorkflowLibraryImportRequest> | null
        const workflowBody = typeof request?.body === 'string' ? request.body : ''
        const originalName = typeof request?.originalName === 'string' ? request.originalName : ''
        if (workflowBody === '' || originalName === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'body 和 originalName 都必填' })
          return
        }
        try {
          const entry = await importWorkflowToLibrary({ body: workflowBody, originalName })
          writeJson(res, 200, { ok: true, entry })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, code: 'library-import-failed', message })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_API.workflowLibraryList,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const entries = await listImportedWorkflows()
          const result: ImportedWorkflowLibraryListResult = { entries }
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, code: 'library-list-failed', message })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_API.workflowLibraryRename,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const request = body as Partial<ImportedWorkflowLibraryRenameRequest> | null
        const id = typeof request?.id === 'string' ? request.id.trim() : ''
        const displayName = typeof request?.displayName === 'string' ? request.displayName : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'id 必填' })
          return
        }
        try {
          const entry = await renameImportedWorkflow(id, displayName)
          if (entry === null) {
            writeJson(res, 200, { ok: false, code: 'not-found', message: '该工作流不在库中' })
            return
          }
          writeJson(res, 200, { ok: true, entry })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, code: 'library-rename-failed', message })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_API.workflowLibraryDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const request = body as Partial<ImportedWorkflowLibraryDeleteRequest> | null
        const id = typeof request?.id === 'string' ? request.id.trim() : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'id 必填' })
          return
        }
        try {
          const removed = await deleteImportedWorkflow(id)
          if (!removed) {
            writeJson(res, 200, { ok: false, code: 'not-found', message: '该工作流不在库中' })
            return
          }
          writeJson(res, 200, { ok: true, removed: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, code: 'library-delete-failed', message })
        }
      },
    },
  ]
}

/** Extract the file name from a path-prefixed request URL. */
function imageFileFrom(rawUrl: string | undefined, basePath: string): string | undefined {
  if (rawUrl === undefined) return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${basePath}/`)) return undefined
  return decodeURIComponent(pathname.slice(basePath.length + 1))
}

/** Narrow an untrusted `advancedOverrides` blob into a flat
 *  `{ '<nodeId>:<inputName>': scalar }` map, dropping malformed entries.
 *  Returns `undefined` when nothing usable survives so the caller can omit
 *  the field entirely. */
function plainRecordOf(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([key, value]) => {
      if (key.trim() === '' || value === undefined || value === null) return false
      // Reject nested structures: a widget value is always a scalar, and
      // letting an object through would hand an arbitrary graph fragment
      // to ComfyUI.
      return typeof value !== 'object'
    })
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** Clamp the canvas's run multiplier into the engine's 1-4 window. */
function clampRunCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.round(n)))
}