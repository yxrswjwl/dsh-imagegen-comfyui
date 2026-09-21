/**
 * ComfyUI workflow inspector: a pure function that turns a workflow JSON
 * (API submission format, `{ "<node_id>": { class_type, inputs, widgets_values } }`)
 * into a structured `WorkflowInspection` describing what the user has to
 * provide to run it.
 *
 * The output drives the canvas "workflow node" UX (round 1 of the canvas
 * roadmap). It deliberately does NOT touch ComfyUI HTTP, file IO, or any
 * plugin state — those are the loader's job (`comfyui-workflow-loader.ts`).
 *
 * What the inspector recognises
 * ----------------------------
 *   1. **Text inputs** — any node whose `class_type` is a known prompt
 *      carrier (the same set `comfyui-workflow-loader.ts` uses to inject
 *      prompts). Each `text` input on that node is exposed as a separate
 *      text slot so the canvas can render one connector per prompt.
 *
 *   2. **Image inputs** — any node input whose declared ComfyUI type is
 *      `IMAGE` (from `node.inputs[name].type`). Image-to-image workflows
 *      typically route this to a `LoadImage` or directly into a sampler;
 *      either way the user has to drop in a reference picture.
 *
 *   3. **Widget options** — every input that has a `widget` marker but no
 *      `link` (i.e. it's user-editable, not a wire). The default value
 *      comes from `widgets_values[widgetIndex]`, and the type comes from
 *      `inputs[name].type` (`INT` / `FLOAT` / `COMBO` / `STRING` /
 *      `BOOLEAN`). KSampler seed/steps/cfg/sampler_name/scheduler/
 *      denoise and EmptyLatentImage width/height all fall into this bucket.
 *
 *   4. **Output size** — for `EmptyLatentImage*` nodes, the width and
 *      height are split out under `size` so the canvas can render two
 *      labelled connectors instead of forcing the user to key in
 *      arbitrary integers.
 *
 * What the inspector explicitly does NOT do
 * -----------------------------------------
 *   - It does not call /object_info. We only read the static schema that
 *     the saved workflow itself declares. A workflow that hides a
 *     `STRING` input behind a missing `widget` flag will silently drop
 *     it — that's a workflow-author problem, not ours.
 *   - It does not classify custom-node inputs. They land under
 *     `unrecognised` so the canvas UI can show a non-blocking warning
 *     rather than silently ignore them.
 *   - It does not validate wiring. A prompt slot with no incoming text
 *     is still listed; whether the workflow can run without it is up to
 *     ComfyUI.
 */
import {
  PROMPT_NODE_CLASSES,
  SAMPLER_NODE_CLASSES,
  type ApiWorkflow,
} from './comfyui-workflow-loader.ts'

/** One text prompt slot the user has to fill (CLIPTextEncode etc.). */
export interface WorkflowTextSlot {
  /** Node id as it appears in the workflow (string form). */
  nodeId: string
  /** Input field name on the node (always 'text' for CLIPTextEncode). */
  inputName: string
  /** Class name, for the canvas UI to label the slot. */
  classType: string
  /** Stable, human-readable label ("Positive Prompt", "Negative Prompt"…). */
  label: string
  /** Whether the saved value is non-empty (helps the canvas choose a
   *  default seed for the connector). */
  hasDefault: boolean
}

/** One image-reference slot (LoadImage / direct IMAGE input). */
export interface WorkflowImageSlot {
  nodeId: string
  inputName: string
  /** Class name, for the canvas UI. */
  classType: string
  /** Friendly label like "Reference Image". */
  label: string
}

/** One widget-style user-editable option (seed / steps / sampler_name …). */
export interface WorkflowOption {
  nodeId: string
  /** Field name on the node — unique within a single node, may repeat
   *  across nodes. The canvas uses `<nodeId>:<inputName>` as its key. */
  inputName: string
  classType: string
  /** Friendly label, derived from inputName when not annotated. */
  label: string
  /** ComfyUI field type: INT / FLOAT / COMBO / STRING / BOOLEAN. */
  type: string
  /** Default value read from `widgets_values[widgetIndex]`. */
  defaultValue: unknown
  /** When `type === 'COMBO'`, the documented choices (if any). */
  options: readonly string[] | null
}

/** Output canvas size derived from an `EmptyLatentImage*` node. */
export interface WorkflowSize {
  nodeId: string
  widthNodeId: string
  heightNodeId: string
  width: number
  height: number
  classType: string
}

/** Inputs the inspector couldn't classify — kept so the canvas UI can
 *  render an honest warning instead of pretending they don't exist. */
export interface WorkflowUnknownInput {
  nodeId: string
  inputName: string
  classType: string
  type: string
  reason: 'no-widget-flag' | 'linked-edge-input' | 'unknown-class'
}

/** Full inspection of one ComfyUI workflow. */
export interface WorkflowInspection {
  /** Workflow nodes that the inspector classified. */
  text: WorkflowTextSlot[]
  image: WorkflowImageSlot[]
  /** Widget options in the order they were encountered (stable across
   *  re-runs of the same workflow JSON). */
  options: WorkflowOption[]
  size: WorkflowSize | null
  /** Anything we couldn't classify. The canvas renders these as a
   *  read-only badge, never as a connector. */
  unrecognised: WorkflowUnknownInput[]
  /** Stable hash for memoisation / change detection. */
  fingerprint: string
}

/** Empty inspection used when the workflow JSON is malformed. */
export const EMPTY_INSPECTION: WorkflowInspection = {
  text: [],
  image: [],
  options: [],
  size: null,
  unrecognised: [],
  fingerprint: 'empty',
}

/* ------------------------------------------------------------------------- */
/*  Inspect                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Inspect a workflow in ComfyUI API format.
 *
 * @param workflow  parsed API workflow JSON
 * @returns         structured inspection; `null` if the input is not a
 *                  node map (`{ "<id>": { class_type, ... } }`).
 */
export function inspectWorkflow(workflow: unknown): WorkflowInspection | null {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return null
  }
  // Reject UI export format explicitly so the caller can't accidentally
  // feed us a `{ nodes: [], links: [] }` document (the loader already
  // surfaces a friendly error for that case, but defence in depth is
  // cheap).
  const record = workflow as Record<string, unknown>
  if (Array.isArray(record['nodes'])) return null

  const text: WorkflowTextSlot[] = []
  const image: WorkflowImageSlot[] = []
  const options: WorkflowOption[] = []
  const unrecognised: WorkflowUnknownInput[] = []
  let size: WorkflowSize | null = null

  // First pass: derive which node ids output IMAGE so the second pass can
  // recognise wired image inputs. ComfyUI's API format doesn't carry type
  // information across wires, so we map by class name. Anything not in
  // this list is treated as opaque (we don't try to guess).
  const imageOutputClasses = new Set([
    'LoadImage',
    'LoadImageMask',
    'ImageScale',
    'ImageScaleBy',
    'ImagePadForOutpaint',
    'ImageBatch',
    'ImageRepeat',
    'ImageCompositeMasked',
    'VAEEncode',
    'VAEEncodeForInpaint',
    'VAEDecode',
  ])
  // Second carve-out: nodes that have IMAGE *inputs* but are themselves
  // terminal — they consume the IMAGE just to serialise it (write to
  // disk / preview in the browser). Their `images` link is the END of a
  // graph branch, not the start, so treating it as a "canvas image port"
  // would invite the user to feed something in that ComfyUI would
  // immediately overwrite. Skip them in the second pass.
  const terminalImageSinkClasses = new Set([
    'SaveImage',
    'PreviewImage',
    'SaveAnimatedWEBP',
    'SaveAnimatedPNG',
    'SaveVideo',
    'SaveJPG',
  ])
  const outputsImage = new Set<string>()
  for (const id of Object.keys(record)) {
    const node = record[id]
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
    const typed = node as Record<string, unknown>
    const classType = typeof typed['class_type'] === 'string' ? typed['class_type'] as string : ''
    if (imageOutputClasses.has(classType)) outputsImage.add(id)
  }

  // Sort the ids so the output is stable across iterations of the same
  // workflow (Object key order is technically insertion order, but the
  // saved JSON can come from many tools).
  const ids = Object.keys(record).sort((a, b) => {
    const na = Number(a); const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    if (Number.isFinite(na)) return -1
    if (Number.isFinite(nb)) return 1
    return a.localeCompare(b)
  })

  for (const id of ids) {
    const node = record[id]
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
    const typed = node as Record<string, unknown>
    const classType = typeof typed['class_type'] === 'string' ? typed['class_type'] as string : ''
    if (classType === '') continue
    const inputs = isPlainRecord(typed['inputs']) ? typed['inputs'] as Record<string, unknown> : {}
    const widgetsValues = Array.isArray(typed['widgets_values']) ? typed['widgets_values'] as unknown[] : []

    // ---- 1. text inputs (CLIPTextEncode & friends) -----------------------
    if (PROMPT_NODE_CLASSES.has(classType)) {
      for (const [inputName, value] of Object.entries(inputs)) {
        if (inputName !== 'text') continue
        const widgetMeta = widgetOf(value)
        const defaultText = widgetMeta !== null ? readWidgetValue(widgetsValues, widgetMeta.widgetIndex) : ''
        const hasDefault = typeof defaultText === 'string' && defaultText.trim() !== ''
        text.push({
          nodeId: id,
          inputName,
          classType,
          label: textLabel(classType, id, inputs),
          hasDefault,
        })
      }
      continue
    }

    // ---- 4. output size (EmptyLatentImage* etc.) -------------------------
    const isLatentImage = classType === 'EmptyLatentImage'
      || classType === 'EmptySD3LatentImage'
      || classType === 'EmptyHunyuanLatentImage'
      || /^Empty(SD3|Hunyuan|SVD)?LatentImage$/.test(classType)
    if (isLatentImage) {
      // ComfyUI's API format declares width/height two ways depending on
      // exporter age: either as a plain number (`"width": 1024`) or as
      // a widget object (`"width": { "type": "INT", "widget": { "name": "width" } }`).
      // Tolerate both so hand-written samples and real exports agree.
      const w = numericWidgetValue(inputs['width'], widgetsValues)
      const h = numericWidgetValue(inputs['height'], widgetsValues)
      if (w !== null && h !== null && w > 0 && h > 0) {
        size = {
          nodeId: id,
          widthNodeId: `${id}#width`,
          heightNodeId: `${id}#height`,
          width: w,
          height: h,
          classType,
        }
      }
    }

    // ---- 2. image inputs + 3. widget options + unrecognised -------------
    if (terminalImageSinkClasses.has(classType)) {
      // Terminal image sinks (SaveImage, PreviewImage, …) still have
      // widget-style options (filename_prefix, fps, quality, …) that the
      // user might want to override. We deliberately fall through to the
      // widget-input branch below so those are surfaced under `options`,
      // but we skip the LINK-input handling that would otherwise turn
      // the upstream VAEDecode wire into a phantom image port.
      // (There is no `continue` here on purpose.)
    }
    for (const [inputName, value] of Object.entries(inputs)) {
      // SaveImage.images / PreviewImage.images are the END of the graph
      // branch, not an input the user can wire a different picture to.
      // Skip them so the canvas doesn't render a stray image port.
      if (terminalImageSinkClasses.has(classType) && inputName === 'images') continue
      // LINK inputs (`[srcNode, slot]` arrays) are graph edges the workflow
      // author already wired — they are NOT inputs the user can feed a
      // picture to, so they never become image ports. A workflow's real
      // image inputs are `LoadImage.image` (handled below) and IMAGE-typed
      // inputs that were left unwired (handled in the `inputType ===
      // 'IMAGE'` branch). (Round 4.5: earlier builds surfaced wired links
      // like `KSampler.latent_image` / `VAEEncode.pixels` as phantom ports;
      // the engine cannot replace a link with a filename anyway.)
      if (isLinkedInput(value)) {
        continue
      }

      const inputType = inputTypeOf(value) ?? literalTypeOf(value)
      const widgetMeta = widgetOf(value)

      // Image inputs we recognise regardless of node class.
      if (inputType === 'IMAGE') {
        // A free IMAGE widget — but ComfyUI almost never lets a user
        // type an image directly; these are usually wires from LoadImage.
        // We still surface the slot so the canvas can show a placeholder
        // when the workflow author wired `LoadImage.image` directly into
        // a sampler input that carries a type annotation.
        image.push({
          nodeId: id,
          inputName,
          classType,
          label: `${classType} · ${inputName}`,
        })
        continue
      }

      // `LoadImage.image` is a string *widget* in API format, but
      // semantically it IS the workflow's image input: the canvas renders
      // it as a port the user wires an image node to, and the runner
      // uploads the picture and writes the returned filename back here
      // (round 4.5). Skip the generic widget-option handling so it does
      // not also appear as a free-text advanced field.
      if (classType === 'LoadImage' && inputName === 'image' && typeof value === 'string') {
        image.push({
          nodeId: id,
          inputName,
          classType,
          label: `${classType} · ${inputName}`,
        })
        continue
      }

      // Inline-value widget inputs. ComfyUI's API format has two shapes
      // for the same kind of widget: either the value sits in
      // `widgets_values` positionally and `inputs[name]` is a
      // `{ type, widget: { name } }` marker, OR (newer exporters, and any
      // workflow that's been re-saved with the value in place) the
      // scalar lives INLINE in `inputs[name]` and `widgets_values` is
      // either absent or only contains widgets the author exposed on the
      // node. We must recognise the latter or we silently drop the
      // most-common case today (KSampler.seed, EmptySD3LatentImage.width
      // / height / batch_size, KSampler.sampler_name, …).
      if (
        widgetMeta === null
        && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
      ) {
        // Best-effort type: explicit `type` annotation wins, otherwise
        // we infer from the JS type. STRING inputs containing 'a','b','c'
        // are often COMBO values (sampler_name, scheduler) but ComfyUI
        // doesn't tag them as such in the inline-value form — the
        // canvas UI can offer a free-text field, and round 4.3 will
        // surface a "known enum?" hint from a class-specific table.
        const inferred = typeof value === 'number'
          ? (Number.isInteger(value) ? 'INT' : 'FLOAT')
          : typeof value === 'boolean' ? 'BOOLEAN' : 'STRING'
        const type = inputType ?? inferred
        options.push({
          nodeId: id,
          inputName,
          classType,
          label: inputName,
          type,
          defaultValue: value,
          options: null,
        })
        continue
      }

      // Widget inputs (have the `widget` marker).
      if (widgetMeta !== null) {
        const type = inputType ?? 'STRING'
        const defaultValue = readWidgetValue(widgetsValues, widgetMeta.widgetIndex)
        const optionChoices: readonly string[] | null = null
        options.push({
          nodeId: id,
          inputName,
          classType,
          label: inputName,
          type,
          defaultValue,
          options: optionChoices,
        })
        continue
      }

      // Anything else with a recognisable type (literal numerics, strings,
      // booleans typed directly into the workflow) gets surfaced as
      // unrecognised — the canvas UI can flag a custom-node input that
      // the inspector doesn't know how to render as a connector.
      if (inputType !== undefined) {
        unrecognised.push({
          nodeId: id, inputName, classType, type: inputType,
          reason: 'no-widget-flag',
        })
      }
    }
  }

  const fingerprint = fingerprintOf({ text, image, options, size, unrecognised })
  return { text, image, options, size, unrecognised, fingerprint }
}

// `ApiWorkflow` is `Record<string, WorkflowNode>` where WorkflowNode is
// `{ inputs?, class_type?, _meta?, [key: string]: unknown }`. `inputs` is
// optional so `record[id]` resolves to `unknown`; we narrow inline.

/* ------------------------------------------------------------------------- */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------- */

/** Loose plain-record check (rejects arrays, dates, class instances). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Pull the declared input type out of an input value, tolerating both
 *  plain string forms and the `{ "type": "..." }` wrapper used by some
 *  custom nodes. */
function inputTypeOf(value: unknown): string | undefined {
  if (typeof value === 'string') return undefined
  if (!isPlainRecord(value)) return undefined
  const t = value['type']
  if (typeof t === 'string') return t
  return undefined
}

/** Best-effort type inference for hand-written literal inputs that the
 *  workflow author typed directly instead of routing through ComfyUI's
 *  widget metadata. Only used as a fallback when `inputTypeOf` returned
 *  undefined; we deliberately do NOT call this for `[srcNode, slot]`
 *  link arrays. */
function literalTypeOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? 'INT' : 'FLOAT'
  if (typeof value === 'string') return 'STRING'
  if (typeof value === 'boolean') return 'BOOLEAN'
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
    return 'LINK'
  }
  return undefined
}

/** Read the `widget` sub-document if present. Returns null when the input
 *  doesn't carry a `widget` marker — the inspector treats those as either
 *  wired links or hand-typed literals that the workflow author expects
 *  to stay where they are.
 *
 *  Note: ComfyUI's API format indexes widgets positionally in
 *  `widgets_values`, and the index is *not* derivable from a widget's
 *  `name` alone — it depends on the node's class-specific declaration
 *  order. The loader carries that knowledge for the small set of classes
 *  it injects into; the canvas runner (round 3+) will hold a richer table.
 *  Until then we don't try to guess; the canvas UI shows
 *  `defaultValue: undefined` honestly. */
function widgetOf(value: unknown): null | { widgetIndex: null } {
  if (!isPlainRecord(value)) return null
  const widget = value['widget']
  if (!isPlainRecord(widget)) return null
  return { widgetIndex: null }
}

function isLinkedInput(value: unknown): boolean {
  // API format: connections are arrays like `[sourceNodeId, sourceSlot]`.
  if (Array.isArray(value) && value.length >= 1 && typeof value[0] === 'string') return true
  if (!isPlainRecord(value)) return false
  // Some custom nodes write `{ "link": <id> }`. We don't have a link
  // table in API format, but the marker alone is enough to mean "wired".
  if (typeof value['link'] === 'number') return true
  return false
}

/** Pull a `[sourceNodeId, sourceSlot]` tuple out of an input value, or
 *  null when the value isn't a link. */
function parseLink(value: unknown): { sourceNodeId: string; sourceSlot: number } | null {
  if (Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'string' && typeof value[1] === 'number') {
    return { sourceNodeId: value[0], sourceSlot: value[1] }
  }
  return null
}

function readWidgetValue(widgets: unknown[], widgetIndex: number | null): unknown {
  // We deliberately accept widgetIndex === null and return `undefined`:
  // ComfyUI's API format indexes widgets positionally in `widgets_values`,
  // and the index isn't derivable from an input's `widget.name` alone —
  // it depends on the node's class-specific declaration order. The loader
  // carries that knowledge for the small set of classes it injects into;
  // the canvas runner (round 3+) will hold a richer table. Until then,
  // `defaultValue: undefined` is honest: the canvas UI shows the field as
  // "no default".
  if (widgetIndex === null) return undefined
  if (widgetIndex < 0 || widgetIndex >= widgets.length) return undefined
  return widgets[widgetIndex]
}

/** Read a numeric widget value from `inputs[name]`, tolerating plain
 *  numbers, widget wrappers, and indexed widgets_values lookups. Used by
 *  the EmptyLatentImage size probe where width/height always have a
 *  positional widget in `widgets_values` (position 0 and 1 by class
 *  convention). */
function numericWidgetValue(input: unknown, widgets: unknown[]): number | null {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input
  if (typeof input === 'string') {
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return n
  }
  if (isPlainRecord(input)) {
    // 1) widget object with an inline value (some custom nodes do this)
    if (typeof input['value'] === 'number' && Number.isFinite(input['value'])) return input['value']
    // 2) widget object that names its slot — best-effort positional lookup
    //    against EmptyLatentImage's known widget order: [width, height, batch_size].
    const widget = input['widget']
    if (isPlainRecord(widget)) {
      const name = widget['name']
      if (name === 'width') {
        const v = readWidgetValue(widgets, 0)
        return typeof v === 'number' ? v : null
      }
      if (name === 'height') {
        const v = readWidgetValue(widgets, 1)
        return typeof v === 'number' ? v : null
      }
      if (name === 'batch_size') {
        const v = readWidgetValue(widgets, 2)
        return typeof v === 'number' ? v : null
      }
    }
  }
  return null
}

/** Render a friendly label for a text slot. CLIPTextEncode doesn't carry
 *  its own title metadata; we synthesise one from the class name and
 *  position. Stable across runs so the canvas UI doesn't shuffle. */
function textLabel(classType: string, nodeId: string, inputs: Record<string, unknown>): string {
  if (classType === 'CLIPTextEncode' || classType === 'CLIPTextEncodeSDXL') {
    // Heuristic: the first CLIPTextEncode connected to a sampler
    // "positive" input is the positive prompt; the "negative" one is
    // negative. Without sampling graph we can't tell for sure, so we
    // fall back to a position-based name. The runner can rename later
    // when it knows the topology.
    const id = Number(nodeId)
    if (Number.isFinite(id)) {
      // Convention used by the docs in this repo: CLIPTextEncode #67
      // is positive, #68 is negative.
      if (id === 67) return 'Positive Prompt'
      if (id === 68) return 'Negative Prompt'
    }
    void inputs
    return 'Prompt'
  }
  if (classType === 'TextEncodeQwenImageEdit') return 'Edit Instruction'
  if (classType === 'TextEncodeHunyuanDiT') return 'Prompt'
  return classType
}

/** Stable fingerprint over the inspection result so the canvas can
 *  cheaply tell whether a workflow re-inspection produced any change. */
function fingerprintOf(inspection: Omit<WorkflowInspection, 'fingerprint'>): string {
  // Cheap: serialise the structural parts only (skip unrecognised ordering
  // jitter, which can come from link resolution in the future).
  const stable = {
    text: inspection.text.map(s => `${s.nodeId}:${s.inputName}:${s.classType}`),
    image: inspection.image.map(s => `${s.nodeId}:${s.inputName}:${s.classType}`),
    options: inspection.options.map(o => `${o.nodeId}:${o.inputName}:${o.type}`),
    size: inspection.size !== null
      ? `${inspection.size.nodeId}:${inspection.size.width}x${inspection.size.height}`
      : null,
    unrecognisedCount: inspection.unrecognised.length,
  }
  // FNV-1a 32-bit, base64url-friendly. Avoids importing a hash lib.
  let hash = 0x811c9dc5
  const bytes = JSON.stringify(stable)
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/* ------------------------------------------------------------------------- */
/*  Guard against accidental re-exports                                       */
/* ------------------------------------------------------------------------- */

/** Re-exported here so canvas code can `import { ApiWorkflow, … }` from a
 *  single place without depending on the loader internals. */
export type { ApiWorkflow }

// Sampler class list is unused by the inspector for now but kept
// available so the canvas runner can decide which widget to seed
// ("randomise" the seed widget only on the sampler node, not on every
// INT input). Round 3+ will need it; exporting now avoids another round
// of dependency churn.
export { PROMPT_NODE_CLASSES, SAMPLER_NODE_CLASSES }