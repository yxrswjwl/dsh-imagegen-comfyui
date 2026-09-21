// Round 4.3 final host sanity check: inspect still works after the
// rebuild, and the run endpoint is registered (a malformed body should
// produce the route's own "canvasId 和 workflowNodeId 都必填" error,
// which proves the route exists and is live).

import { readFileSync } from 'node:fs'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const HOST = 'http://127.0.0.1:5783'

// 1) inspect
const fixture = readFileSync(FIXTURE, 'utf8')
const inspectRes = await fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/inspect`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    channelId: 'f5756e57-c148-4277-9213-d80af04b34c3',
    model: 'comfyui:image_z_image_turbo.json',
    workflowBody: fixture,
    workflowName: 'image_z_image_turbo',
  }),
  signal: AbortSignal.timeout(15000),
})
const inspectJson = await inspectRes.json()
console.log('inspect ok:', inspectJson.ok === true)
if (inspectJson.ok) {
  console.log('  textSlots:', inspectJson.inspection.textSlots.length)
  console.log('  options:', inspectJson.inspection.options.length)
  console.log('  unrecognised:', inspectJson.inspection.unrecognisedCount)
} else {
  console.log('  FAILED:', JSON.stringify(inspectJson).slice(0, 300))
}

// 2) run route liveness (expect the route's own bad-request error)
const runRes = await fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(15000),
})
const runJson = await runRes.json()
console.log('run route live:', runJson.ok === false && runJson.code === 'bad-request')
console.log('  message:', runJson.message)
