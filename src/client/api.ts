/**
 * Browser-side API client for the canvas surface. The only data access path
 * the canvas uses — every endpoint here is part of /api/dsh-imagegen and is
 * same-origin.
 *
 * Round 5: the panel/ecommerce/generation-studio endpoints (generate proxy,
 * history, gallery, template library, update check, object-storage probe,
 * data-folder reveal) were removed. Canvas persistence, asset upload,
 * workflow inspection + run, and skill control are the only routes left.
 */

import { CANVAS_API, CANVAS_SKILL_API, type CanvasAssetRef, type CanvasDocument, type CanvasFilePreview, type CanvasLayerPlan, type CanvasSkillCatalog, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type CanvasSkillRunRequest, type CanvasSkillTask, type CanvasSummary, type CanvasWorkflowNodeMeta, type GenerateRequest, type GeneratedImage, type GenerationTask } from '../protocol.ts'
import { activeImageGenLanguage } from './helpers.ts'

/** Error carrying the route's JSON error message. */
export class ImageGenApiError extends Error {
  /** Stable wire code from the host. */
  readonly code: string

  constructor(message: string, code = 'generate-failed') {
    super(message)
    this.name = 'ImageGenApiError'
    this.code = code
  }
}

/** Result envelope returned by `canvasWorkflowInspect`. Success carries
 *  a `CanvasWorkflowNodeMeta` snapshot; failure carries a structured
 *  `code`/`status` (the route never throws for the round-2 inspection
 *  paths — every known failure mode has a stable code the UI can
 *  branch on). */
export type CanvasWorkflowInspectResult =
  | { ok: true; inspection: CanvasWorkflowNodeMeta }
  | {
      ok: false
      code: 'bad-request' | 'no-channels' | 'image-model-not-configured' | 'ui-format' | 'inspect-failed' | string
      /** Stable status the canvas UI branches on (independent of `code`). */
      status?: 'ui-format' | 'error'
      message: string
    }

/** Result envelope returned by `canvasRunWorkflow`. Round 4.1. */
export type CanvasWorkflowRunResult =
  | { ok: true; images: GeneratedImage[]; canvasId: string; workflowNodeId: string; params?: Record<string, unknown> }
  | { ok: false; code: string; message: string }

/** Parse the { ok, ... } envelope or throw an ImageGenApiError. */
async function readEnvelope<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ImageGenApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (body === null || typeof body !== 'object') {
    throw new ImageGenApiError(`HTTP ${response.status}: malformed response`)
  }
  const record = body as { ok?: unknown; message?: unknown; code?: unknown }
  if (record.ok !== true) {
    throw new ImageGenApiError(
      typeof record.message === 'string' ? record.message : `HTTP ${response.status}`,
      typeof record.code === 'string' ? record.code : 'generate-failed',
    )
  }
  return body as T
}

/** The browser half's data entry point. */
export class ImageGenApi {
  async canvasList(): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasCreate(title?: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.create, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRead(id: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.read, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasSave(document: CanvasDocument, expectedRevision: number): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.save, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document, expectedRevision }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRemove(id: string): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.remove, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasUpload(dataUrl: string, width: number, height: number, meta: { origin?: string; originId?: string; entryId?: string; imageIndex?: number } = {}): Promise<CanvasAssetRef> {
    const response = await fetch(CANVAS_API.assetUpload, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, width, height, ...meta }) })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  /** Round 5: the host no longer exposes a generation-proxy route. The
   *  legacy canvas code still asks for one; throwing keeps the contract
   *  honest while the surfaces that owned it are gone. */
  async taskSubmit(_request: GenerateRequest): Promise<GenerationTask> {
    throw new ImageGenApiError('画布现在只通过工作流节点生成图片，请使用工作流节点', 'route-removed')
  }

  /** Ask the host's chat model to decompose one image into editable layers. */
  async canvasLayers(image: string): Promise<CanvasLayerPlan> {
    const response = await fetch(CANVAS_API.layers, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) })
    return (await readEnvelope<{ ok: true; plan: CanvasLayerPlan }>(response)).plan
  }

  /**
   * Upload one arbitrary file for a canvas file node. The File object travels
   * as the raw request body (no base64 inflation) with its name in the query
   * and its type in the content-type header.
   */
  async canvasFileUpload(file: File): Promise<CanvasAssetRef> {
    const response = await fetch(`${CANVAS_API.fileUpload}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
    })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  /**
   * Ask the host for one canvas file node's readable content. Media types come
   * back as an inline URL; text, spreadsheets, office documents and archives
   * come back decoded and bounded.
   */
  async canvasFilePreview(asset: { assetId: string; name?: string; mime?: string }): Promise<CanvasFilePreview> {
    const response = await fetch(CANVAS_API.filePreview, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    })
    return (await readEnvelope<{ ok: true; preview: CanvasFilePreview }>(response)).preview
  }

  /** Read the skill catalog offered to canvas nodes. */
  async canvasSkillsList(): Promise<CanvasSkillCatalog> {
    const response = await fetch(CANVAS_SKILL_API.list, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: activeImageGenLanguage() }),
    })
    const body = await readEnvelope<{ ok: true } & CanvasSkillCatalog>(response)
    return {
      skills: body.skills,
      agentAvailable: body.agentAvailable,
      registryAvailable: body.registryAvailable,
      installed: body.installed ?? [],
      ...body.reason === undefined ? {} : { reason: body.reason },
    }
  }

  /** Inspect the local skill library (`~/.dsh/skills`). */
  async canvasSkillLibrary(): Promise<CanvasSkillLibrary> {
    const response = await fetch(CANVAS_SKILL_API.library, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; library: CanvasSkillLibrary }>(response)).library
  }

  /** Install skills from URLs and/or an archive asset uploaded to the canvas. */
  async canvasSkillInstall(request: CanvasSkillInstallRequest): Promise<CanvasSkillInstallResult> {
    const response = await fetch(CANVAS_SKILL_API.install, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillInstallResult>(response)
  }

  /** Remove one installed skill. */
  async canvasSkillRemove(name: string): Promise<CanvasSkillRemoveResult> {
    const response = await fetch(CANVAS_SKILL_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillRemoveResult>(response)
  }

  /** Save the values one skill's own declaration asked for. */
  async canvasSkillConfigSave(request: CanvasSkillConfigSaveRequest): Promise<CanvasSkillConfigSaveResult> {
    const response = await fetch(CANVAS_SKILL_API.configSave, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillConfigSaveResult>(response)
  }

  /** Run a skill declaration's `apply` steps (its CLI or a config file). */
  async canvasSkillConfigApply(request: CanvasSkillConfigApplyRequest): Promise<CanvasSkillConfigApplyResult> {
    const response = await fetch(CANVAS_SKILL_API.configApply, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillConfigApplyResult>(response)
  }

  /** Queue one skill run; the task is polled through {@link canvasSkillTask}. */
  async canvasSkillRun(request: CanvasSkillRunRequest): Promise<CanvasSkillTask> {
    const response = await fetch(CANVAS_SKILL_API.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; task: CanvasSkillTask }>(response)).task
  }

  /** One skill-run snapshot. */
  async canvasSkillTask(taskId: string): Promise<CanvasSkillTask> {
    const response = await fetch(CANVAS_SKILL_API.task, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; task: CanvasSkillTask }>(response)).task
  }

  /** Unfinished skill runs of one canvas (rebuilds run cards after a reload). */
  async canvasSkillTasks(canvasId: string): Promise<CanvasSkillTask[]> {
    const response = await fetch(CANVAS_SKILL_API.task, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; tasks: CanvasSkillTask[] }>(response)).tasks
  }

  /** Ask the host to cancel a queued or running skill run. */
  async canvasSkillCancel(taskId: string): Promise<boolean> {
    const response = await fetch(CANVAS_SKILL_API.cancel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; cancelled: boolean }>(response)).cancelled
  }

  /** Resolve a (channel, model) pair into a ComfyUI workflow inspection
   *  (text/image slots, advanced options, latent size). The host endpoint
   *  returns either `{ ok: true, inspection }` or a structured failure
   *  with `code` and `status` (round 2: `ui-format` when the workflow was
   *  saved in ComfyUI's UI export format rather than API format). */
  async canvasWorkflowInspect(channelId: string, model: string, workflowBody?: string, workflowName?: string): Promise<CanvasWorkflowInspectResult> {
    const response = await fetch(CANVAS_API.workflowInspect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId, model, ...(workflowBody === undefined ? {} : { workflowBody }), ...(workflowName === undefined ? {} : { workflowName }) }),
    })
    // The inspect endpoint is allowed to return a structured failure
    // (`{ ok: false, code, status, message }`) for round-2 cases like
    // UI-format workflows — those are expected outcomes, not transport
    // errors, so we bypass `readEnvelope`'s throw-on-ok-false behaviour
    // and surface them directly. Transport-level failures (non-JSON,
    // HTTP 5xx, etc.) still throw as before.
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ImageGenApiError(`HTTP ${response.status}: invalid JSON response`)
    }
    if (body === null || typeof body !== 'object') {
      throw new ImageGenApiError(`HTTP ${response.status}: malformed response`)
    }
    return body as CanvasWorkflowInspectResult
  }

  /** Run one workflow node: host collects connected text inputs, injects
   *  them into the workflow, submits to ComfyUI, and returns generated
   *  images as inline `data:` URLs. Round 4.1.
   *
   *  Round 4.4: one client-side budget so a wedged host (ComfyUI hung on
   *  submission or polling) can never leave the canvas node on "生成中"
   *  forever. The host aborts its own run at 600 s; this budget is a bit
   *  longer so a normal failure still resolves as a structured `ok:false`
   *  result while a genuinely dead host degrades to a timeout error. */
  async canvasRunWorkflow(canvasId: string, workflowNodeId: string): Promise<CanvasWorkflowRunResult> {
    const controller = new AbortController()
    const budget = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), 660_000)
    try {
      const response = await fetch(CANVAS_API.runWorkflow, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canvasId, workflowNodeId }),
        signal: controller.signal,
      })
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new ImageGenApiError(`HTTP ${response.status}: invalid JSON response`)
      }
      if (body === null || typeof body !== 'object') {
        throw new ImageGenApiError(`HTTP ${response.status}: malformed response`)
      }
      return body as CanvasWorkflowRunResult
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ImageGenApiError('生成超时：请检查 ComfyUI 是否卡住或队列积压')
      }
      throw error
    } finally {
      clearTimeout(budget)
    }
  }

  /** Live ComfyUI progress for one workflow node's most recent run.
   *  Round 4.6: the canvas polls this every ~800 ms while a run is in
   *  flight and shows a percentage on the node's busy overlay. */
  async canvasWorkflowProgress(workflowNodeId: string): Promise<{ ok: boolean; running: boolean; progress: number | null; node: string | null }> {
    const response = await fetch(`${CANVAS_API.workflowProgress}?workflowNodeId=${encodeURIComponent(workflowNodeId)}`, {
      method: 'GET',
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, running: false, progress: null, node: null }
    }
    if (body === null || typeof body !== 'object') {
      return { ok: false, running: false, progress: null, node: null }
    }
    const record = body as { ok?: unknown; running?: unknown; progress?: unknown; node?: unknown }
    return {
      ok: record.ok === true,
      running: record.running === true,
      progress: typeof record.progress === 'number' ? record.progress : null,
      node: typeof record.node === 'string' ? record.node : null,
    }
  }
}