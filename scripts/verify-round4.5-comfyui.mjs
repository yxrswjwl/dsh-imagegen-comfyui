// Round 4.5 end-to-end ComfyUI verification: upload a real canvas-style
// image to `/upload/image`, write the returned filename into the img2img
// fixture's `LoadImage.image`, inject the prompt, submit, and confirm the
// img2img run actually completes and produces an image. This proves the
// whole canvas image-input chain (upload → inject → submit → poll).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  applyImageFilesIntoWorkflow,
  injectPromptIntoWorkflow,
  uploadComfyUiImages,
} from '../src/comfyui-workflow-loader.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_img2img_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'
const OUTPUT_DIR = 'D:/ComfyUI-aki/ComfyUI-aki-v3/ComfyUI/output'

// Pick the newest output PNG as the "canvas reference image".
const newest = readdirSync(OUTPUT_DIR)
  .filter(file => file.toLowerCase().endsWith('.png'))
  .map(file => ({ file, mtime: statSync(`${OUTPUT_DIR}/${file}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0]
if (newest === undefined) {
  console.log('no output PNG found to use as the reference image')
  process.exit(2)
}
const bytes = readFileSync(`${OUTPUT_DIR}/${newest.file}`)
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
console.log('reference image:', newest.file, bytes.length, 'bytes')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
}

// 1) upload
const uploads = await uploadComfyUiImages(COMFY, '', [{ nodeId: '100', inputName: 'image', data: dataUrl }])
check('upload returned exactly one filename', uploads.length, 1)
check('filename is non-empty', uploads[0].filename !== '', true)
console.log('  uploaded as:', uploads[0].filename)

// 2) inject prompt + image into the fixture
const workflow = JSON.parse(readFileSync(FIXTURE, 'utf8'))
injectPromptIntoWorkflow(workflow, { positive: '一个苹果' })
const applied = applyImageFilesIntoWorkflow(workflow, uploads)
check('image slot applied', applied.applied, 1)
check('LoadImage.image replaced with the uploaded filename', workflow['100'].inputs.image, uploads[0].filename)
check('KSampler still reads VAEEncode', JSON.stringify(workflow['70'].inputs.latent_image), JSON.stringify(['101', 0]))

// 3) submit + poll history
const submit = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen-round45-img2img' }),
})
const payload = await submit.json()
if (payload.prompt_id === undefined) {
  console.log('SUBMIT REJECTED:', JSON.stringify(payload).slice(0, 800))
  process.exit(1)
}
const entry = await awaitHistory(payload.prompt_id)
check('img2img run completed', entry.status, 'success')
check('img2img produced at least one image', entry.images.length >= 1, true)

console.log(failures === 0 ? '\nAll round 4.5 ComfyUI checks passed.' : `\n${failures} check(s) FAILED.`)
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
