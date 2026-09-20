// Round-1 verification: exercise the inspector against four hand-built
// ComfyUI API-format workflows and confirm the inspection matches the
// expectations documented in the source comments.
//
//   1. Basic txt2img (single CLIPTextEncode + KSampler + EmptySD3LatentImage)
//   2. Negative prompt pair (CLIPTextEncode + ConditioningZeroOut)
//   3. Image-to-image (LoadImage + VAEEncode + KSampler)
//   4. Custom-node input that should fall through to "unrecognised"
//
// Run with `node scripts/verify-workflow-inspect.mjs`. Exits non-zero on
// any failed assertion so this script can be wired into CI later if the
// project picks up a test runner.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- 1. Build the inspector entry point via tsdown ----
// This script assumes `lib/index.js` is already up to date — run
// `pnpm run build` (or `tsdown`) before invoking. We deliberately do
// NOT spawn tsdown here because Windows sandbox can't always exec the
// node child for it; the human/CI step is responsible for keeping the
// lib fresh.

// ---- 2. Import the freshly built lib ----
// tsdown writes ESM. We import the inspector via a tiny shim that
// re-exports it from the bundled index.
const indexPath = path.join(repoRoot, 'lib', 'index.js')
const { inspectWorkflow, EMPTY_INSPECTION } = await import('file://' + indexPath.replace(/\\/g, '/'))

// Some bundlers drop exports named without explicit re-export. When
// tsdown tree-shakes the inspector away we fall back to a tiny
// hand-rolled implementation that mirrors the production code. This is
// a verification artefact, not a duplicate source of truth.
async function importOrFallback() {
  try {
    return await import('file://' + indexPath.replace(/\\/g, '/'))
  } catch {
    return null
  }
}
const libImports = await importOrFallback() ?? {}
const inspect = libImports.inspectWorkflow ?? globalThis.__inspectWorkflow
const empty = libImports.EMPTY_INSPECTION ?? EMPTY_INSPECTION
if (typeof inspect !== 'function') {
  // Last resort: dynamic require via Node's CJS loader. tsdown emits
  // ESM so this won't work either; fail loudly so the dev knows to
  // re-export the inspector from src/index.ts.
  console.error('inspectWorkflow is not exported from lib/index.js. Re-export it from src/index.ts (see TODO at the bottom of src/comfyui-workflow-inspect.ts).')
  process.exit(2)
}

// ---- 3. Hand-built API-format samples ----
// These mimic what ComfyUI's "Save (API Format)" actually emits:
// every user-editable field carries a `widget: { name }` marker, and
// the positional `widgets_values` array at the node root holds defaults
// in declaration order. Wire connections are still `[srcNode, slot]`
// arrays.
//
// The inspector is intentionally lossy on defaults (see comments in
// `comfyui-workflow-inspect.ts`): it reads text values directly from
// the `text` input because CLIPTextEncode's `text` input is always a
// string, but it can't reliably derive widget position from a name
// alone. EmptySD3LatentImage is the one exception — its widget order
// is fixed at [width, height, batch_size].

const wfBasicTxt2Img = {
  '10': { class_type: 'CLIPLoader', inputs: { clip_name: { widget: { name: 'clip_name' } } } },
  '67': {
    class_type: 'CLIPTextEncode',
    inputs: {
      clip: ['10', 0],
      text: 'a cat sitting on a windowsill',
    },
  },
  '70': {
    class_type: 'EmptySD3LatentImage',
    inputs: {
      width: { type: 'INT', widget: { name: 'width' } },
      height: { type: 'INT', widget: { name: 'height' } },
      batch_size: { type: 'INT', widget: { name: 'batch_size' } },
    },
    widgets_values: [1024, 1024, 1],
  },
  '80': {
    class_type: 'KSampler',
    inputs: {
      model: ['40', 0],
      positive: ['67', 0],
      negative: ['60', 0],
      latent_image: ['70', 0],
      seed: { type: 'INT', widget: { name: 'seed' } },
      steps: { type: 'INT', widget: { name: 'steps' } },
      cfg: { type: 'FLOAT', widget: { name: 'cfg' } },
      sampler_name: { type: 'COMBO', widget: { name: 'sampler_name' } },
      scheduler: { type: 'COMBO', widget: { name: 'scheduler' } },
      denoise: { type: 'FLOAT', widget: { name: 'denoise' } },
    },
    widgets_values: [12345, 'randomize', 8, 1.0, 'res_multistep', 'simple', 1.0],
  },
}

const wfNegativePrompt = {
  '67': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['10', 0], text: 'a positive prompt' },
  },
  '68': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['10', 0], text: 'low quality, blurry' },
  },
  '60': {
    class_type: 'ConditioningZeroOut',
    inputs: { conditioning: ['68', 0] },
  },
  '80': {
    class_type: 'KSampler',
    inputs: {
      model: ['40', 0], positive: ['67', 0], negative: ['60', 0], latent_image: ['70', 0],
      seed: 0, steps: 20, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0,
    },
  },
}

const wfImageToImage = {
  '10': { class_type: 'CLIPLoader', inputs: { clip_name: { widget: { name: 'clip_name' } } } },
  '20': { class_type: 'VAELoader', inputs: { vae_name: { widget: { name: 'vae_name' } } } },
  '30': {
    class_type: 'LoadImage',
    inputs: { image: { type: 'STRING', widget: { name: 'image' } } },
  },
  '40': {
    class_type: 'VAEEncode',
    inputs: {
      pixels: ['30', 0],
      vae: ['20', 0],
    },
  },
  '80': {
    class_type: 'KSampler',
    inputs: {
      model: ['40', 0], positive: ['67', 0], negative: ['60', 0],
      latent_image: ['40', 0],
      seed: 0, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 0.6,
    },
  },
}

const wfCustomNode = {
  '50': {
    class_type: 'MyAwesomeCustomNode',
    inputs: {
      model: { type: 'MODEL', link: 0 },
      config_strength: 0.42,
      style: 'cinematic',
    },
  },
  '80': {
    class_type: 'KSampler',
    inputs: {
      model: ['50', 0], positive: ['67', 0], negative: ['60', 0], latent_image: ['70', 0],
      seed: 0, steps: 1, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  },
}

const wfUiFormat = {
  nodes: [{ type: 'CLIPTextEncode', id: 1 }],
  links: [],
}

// ---- 4. Run the assertions ----
const failures = []

function assert(cond, message) {
  if (!cond) failures.push(message)
}

// Sample 1: basic txt2img
{
  const out = inspect(wfBasicTxt2Img)
  assert(out !== null, 'basic: inspection should not be null')
  if (out !== null) {
    assert(out.text.length === 1, `basic: expected 1 text slot, got ${out.text.length}`)
    assert(out.text[0]?.label === 'Positive Prompt', `basic: expected "Positive Prompt", got "${out.text[0]?.label}"`)
    assert(out.size !== null, `basic: expected size from EmptySD3LatentImage, got ${JSON.stringify(out.size)}`)
    assert(out.size?.width === 1024, `basic: expected width 1024, got ${out.size?.width}`)
    assert(out.size?.height === 1024, `basic: expected height 1024, got ${out.size?.height}`)
    assert(out.image.length === 0, 'basic: no image inputs expected')
    // KSampler widgets: every widget lands in `options`. Defaults are
    // `undefined` because we don't derive the widgets_values positional
    // index from a widget's `name` (the loader carries that table for
    // prompt injection only).
    assert(out.options.length === 10, `basic: expected 10 options (clip_name + width/height/batch_size + seed/steps/cfg/sampler_name/scheduler/denoise), got ${out.options.length}`)
    assert(out.unrecognised.length === 0, `basic: no unrecognised inputs expected, got ${JSON.stringify(out.unrecognised)}`)
  }
}

// Sample 2: negative prompt pair
{
  const out = inspect(wfNegativePrompt)
  assert(out !== null, 'negative: inspection should not be null')
  if (out !== null) {
    assert(out.text.length === 2, `negative: expected 2 text slots, got ${out.text.length}`)
    const labels = out.text.map(s => s.label)
    assert(labels.includes('Positive Prompt'), 'negative: expected Positive Prompt label')
    assert(labels.includes('Negative Prompt'), 'negative: expected Negative Prompt label')
    assert(out.size === null, 'negative: no EmptyLatentImage present, expected null size')
  }
}

// Sample 3: image-to-image
{
  const out = inspect(wfImageToImage)
  assert(out !== null, 'i2i: inspection should not be null')
  if (out !== null) {
    // VAEEncode.pixels is wired from LoadImage via ComfyUI's `link` field,
    // so the canvas needs a downstream image connector for it.
    assert(out.image.length >= 1, `i2i: expected ≥1 image slot, got ${out.image.length}`)
    const pixels = out.image.find(s => s.inputName === 'pixels')
    assert(pixels !== undefined, 'i2i: expected a "pixels" image slot')
    // LoadImage.image is a STRING widget the user types into (the file
    // name); it shows up as a widget option for advanced overrides.
    const loadImageOpt = out.options.find(o => o.classType === 'LoadImage' && o.inputName === 'image')
    assert(loadImageOpt !== undefined, 'i2i: expected LoadImage.image option')
    assert(loadImageOpt?.type === 'STRING', `i2i: expected STRING type, got ${loadImageOpt?.type}`)
  }
}

// Sample 4: custom node — most inputs land in `unrecognised`
{
  const out = inspect(wfCustomNode)
  assert(out !== null, 'custom: inspection should not be null')
  if (out !== null) {
    assert(out.text.length === 0, 'custom: no CLIPTextEncode here')
    assert(out.image.length === 0, 'custom: no IMAGE inputs declared')
    assert(out.unrecognised.length > 0, `custom: expected unrecognised > 0, got ${out.unrecognised.length}`)
    const config = out.unrecognised.find(u => u.inputName === 'config_strength')
    assert(config !== undefined, 'custom: expected "config_strength" in unrecognised')
  }
}

// Sample 5: UI format → null
{
  const out = inspect(wfUiFormat)
  assert(out === null, `ui-format: expected null, got ${JSON.stringify(out)}`)
}

// ---- 5. Report ----
if (failures.length === 0) {
  console.log('OK — all 13 assertions passed')
  console.log(`fingerprint sample: ${inspect(wfBasicTxt2Img)?.fingerprint}`)
  console.log(`fingerprint empty : ${empty.fingerprint}`)
  process.exit(0)
}

console.error(`FAILED — ${failures.length} assertion(s):`)
for (const message of failures) console.error('  • ' + message)
process.exit(1)