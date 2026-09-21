// Round 4.5 inspect verification: a workflow with a LoadImage node must
// surface `LoadImage.image` as an *image slot* (a port the user wires an
// image node to), not as a free-text advanced option. The txt2img z-turbo
// fixture keeps its old shape (0 image slots, 17 options) so nothing
// regresses for workflows without LoadImage.

import { readFileSync } from 'node:fs'
import { inspectWorkflow } from '../src/comfyui-workflow-inspect.ts'

const BASE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures`

const img2img = JSON.parse(readFileSync(`${BASE}\\verify_img2img_api_format_sample.json`, 'utf8'))
const txt2img = JSON.parse(readFileSync(`${BASE}\\verify_api_format_sample.json`, 'utf8'))

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
}

console.log('img2img fixture inspection…')
const i2i = inspectWorkflow(img2img)
check('inspection returned', i2i !== null, true)
check('text slots = CLIPTextEncode', i2i.text.map(s => s.classType), ['CLIPTextEncode'])
check('image slots = LoadImage.image', i2i.image.map(s => `${s.classType}.${s.inputName}`), ['LoadImage.image'])
check('LoadImage slot label', i2i.image[0]?.label, 'LoadImage · image')
check('LoadImage.image NOT in options', i2i.options.some(o => o.classType === 'LoadImage' && o.inputName === 'image'), false)
check('no latent size (source is the reference image)', i2i.size, null)
check('KSampler widgets still surface', i2i.options.some(o => o.classType === 'KSampler' && o.inputName === 'denoise'), true)

console.log('\ntxt2img fixture regression…')
const t2i = inspectWorkflow(txt2img)
check('inspection returned', t2i !== null, true)
check('image slots stay empty', t2i.image.length, 0)
check('options stay 17', t2i.options.length, 17)
check('size still 1024x1024', `${t2i.size?.width}x${t2i.size?.height}`, '1024x1024')

console.log(failures === 0 ? '\nAll round 4.5 inspect checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
