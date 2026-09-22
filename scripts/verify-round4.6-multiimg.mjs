// Round 4.6 multi-image verification: a workflow with two LoadImage nodes
// must surface two image slots, and the runner must upload BOTH reference
// images and write both filenames back into the workflow before a real
// ComfyUI run completes.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  applyImageFilesIntoWorkflow,
  injectPromptIntoWorkflow,
  uploadComfyUiImages,
} from '../src/comfyui-workflow-loader.ts'
import { inspectWorkflow } from '../src/comfyui-workflow-inspect.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_multiimg_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'
const OUTPUT_DIR = 'D:/ComfyUI-aki/ComfyUI-aki-v3/ComfyUI/output'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
}

// 1) inspect must see both LoadImage ports
const workflow = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const inspection = inspectWorkflow(workflow)
check('two image slots', (inspection.image ?? []).map(s => `${s.classType}.${s.inputName}`), ['LoadImage.image', 'LoadImage.image'])
check('slot targets are 100 and 102', (inspection.image ?? []).map(s => s.nodeId), ['100', '102'])

// 2) upload two real images
const newest = readdirSync(OUTPUT_DIR)
  .filter(file => file.toLowerCase().endsWith('.png'))
  .map(file => ({ file, mtime: statSync(`${OUTPUT_DIR}/${file}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
if (newest.length < 2) {
  console.log('need at least 2 output PNGs for the reference images')
  process.exit(2)
}
const slots = [0, 1].map(i => ({
  nodeId: inspection.image[i].nodeId,
  inputName: inspection.image[i].inputName,
  data: `data:image/png;base64,${readFileSync(`${OUTPUT_DIR}/${newest[i].file}`).toString('base64')}`,
}))
const uploads = await uploadComfyUiImages(COMFY, '', slots)
check('two uploads returned', uploads.length, 2)
check('both filenames distinct', uploads[0].filename !== uploads[1].filename, true)
console.log('  uploaded:', uploads.map(u => u.filename).join(' | '))

// 3) inject both into the workflow
injectPromptIntoWorkflow(workflow, { positive: '一个苹果' })
const applied = applyImageFilesIntoWorkflow(workflow, uploads)
check('both slots applied', applied.applied, 2)
check('LoadImage(100) replaced', workflow['100'].inputs.image, uploads.find(u => u.nodeId === '100').filename)
check('LoadImage(102) replaced', workflow['102'].inputs.image, uploads.find(u => u.nodeId === '102').filename)

// 4) a real run completes with the injected images
const submit = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen-round46-multi' }),
})
const payload = await submit.json()
if (payload.prompt_id === undefined) {
  console.log('SUBMIT REJECTED:', JSON.stringify(payload).slice(0, 800))
  process.exit(1)
}
const entry = await awaitHistory(payload.prompt_id)
check('multi-image run completed', entry.status, 'success')
check('multi-image run produced an image', entry.images.length >= 1, true)

console.log(failures === 0 ? '\nAll round 4.6 multi-image checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

/** Poll /history until the prompt lands, then collect the image list. */
async function awaitHistory(promptId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`${COMFY}/history/${promptId}`)
    const history = await response.json()
    const entry = history[promptId]
    if (entry !== undefined && entry.status?.completed === true) {
      const images = Object.values(entry.outputs ?? {})
        .flatMap(output => output.images ?? [])
      return { images, status: entry.status.status_str }
    }
    if (entry !== undefined && entry.status?.status_str === 'error') {
      return { images: [], status: 'error', detail: JSON.stringify(entry.status).slice(0, 600) }
    }
    if (Date.now() > deadline) return { images: [], status: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}
