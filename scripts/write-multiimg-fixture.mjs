// Build the round-4.6 multi-image fixture: the img2img workflow plus a
// second LoadImage node (unused by the graph) so the multi-port path can
// be verified — inspect must surface two image slots and the runner must
// upload and inject both reference images.

import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_img2img_api_format_sample.json`
const OUT = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_multiimg_api_format_sample.json`

const workflow = JSON.parse(readFileSync(SOURCE, 'utf8'))
workflow['102'] = {
  inputs: { image: 'ref2.png' },
  class_type: 'LoadImage',
  _meta: { title: '第二参考图（悬空）' },
}
writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n', 'utf8')
console.log('wrote', OUT)
console.log('LoadImage nodes:', Object.entries(workflow).filter(([, n]) => n.class_type === 'LoadImage').map(([id]) => id).join(', '))
