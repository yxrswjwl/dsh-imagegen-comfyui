// Round 4.4 host sanity check after the rebuild:
//  1. inspect still works (host loaded the new lib)
//  2. the run route is live (malformed body -> its own bad-request error)
//  3. a run against an unknown canvas resolves to a structured
//     `{ ok: false, code: 'not-found' }` instead of hanging — the round-4.4
//     budget wiring must never leave the canvas node on "生成中" forever.

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

// 3) unknown canvas -> structured not-found (the canvas-node error path)
const missRes = await fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ canvasId: '00000000-0000-0000-0000-000000000000', workflowNodeId: 'node-missing' }),
  signal: AbortSignal.timeout(15000),
})
const missJson = await missRes.json()
console.log('unknown canvas -> structured failure:', missJson.ok === false && missJson.code === 'not-found')
console.log('  message:', missJson.message)
