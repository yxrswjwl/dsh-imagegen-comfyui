// Build the round-4.5 img2img fixture: the user's z-turbo txt2img workflow
// re-wired into an image-to-image pipeline (LoadImage → VAEEncode →
// KSampler.latent_image) so the canvas image-input feature can be verified
// against a workflow that actually has a LoadImage node.
//
// Outputs:
//   scripts/.fixtures/verify_img2img_api_format_sample.json  (committed)

import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const OUT = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_img2img_api_format_sample.json`

const workflow = JSON.parse(readFileSync(SOURCE, 'utf8'))

// txt2img -> img2img rewiring:
//   - drop EmptySD3LatentImage (68): the input latent now comes from the
//     reference image via VAEEncode
//   - add LoadImage (100) — the canvas image port the runner fills with the
//     uploaded filename at run time ("ref.png" is a placeholder)
//   - add VAEEncode (101) — encodes the reference image into a latent
//   - KSampler (70).latent_image now reads from VAEEncode, and denoise drops
//     to 0.7 so the reference structure survives (img2img strength)
delete workflow['68']

workflow['100'] = {
  inputs: { image: 'ref.png' },
  class_type: 'LoadImage',
  _meta: { title: '加载参考图' },
}
workflow['101'] = {
  inputs: {
    pixels: ['100', 0],
    vae: ['63', 0],
  },
  class_type: 'VAEEncode',
  _meta: { title: 'VAE编码' },
}
workflow['70'].inputs.latent_image = ['101', 0]
workflow['70'].inputs.denoise = 0.7

writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n', 'utf8')
console.log('wrote', OUT)
console.log('nodes:', Object.keys(workflow).join(', '))
