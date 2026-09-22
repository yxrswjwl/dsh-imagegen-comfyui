// Round 4.6 progress verification: register a real ComfyUI run against a
// fake workflow-node id, then confirm the tracker surfaces step-level
// progress (value climbing toward max) from the live WS socket.

import { readFileSync } from 'node:fs'
import { applyWorkflowOverrides } from '../src/comfyui-workflow-loader.ts'
import { progressForWorkflowNode, progressTrackerFor } from '../src/comfyui-progress.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'
const NODE = 'verify-progress-node-1'

const template = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const workflow = JSON.parse(JSON.stringify(template))
applyWorkflowOverrides(workflow, { '70:steps': 60, '68:batch_size': 1 })

const tracker = progressTrackerFor(COMFY)
console.log('tracker state (fresh):', JSON.stringify(tracker.debugState()))
// Warm the socket up FIRST: register a throwaway id, wait for the WS to
// connect and the client_id switch to land, then submit the real run so
// no early progress messages are missed.
tracker.register('verify-warmup', 'warmup-prompt')
await new Promise(resolve => setTimeout(resolve, 2500))
console.log('tracker state (after warmup):', JSON.stringify(tracker.debugState()))
tracker.register('verify-warmup', 'warmup-prompt')

const submit = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen' }),
})
const payload = await submit.json()
if (payload.prompt_id === undefined) {
  console.log('SUBMIT REJECTED:', JSON.stringify(payload).slice(0, 600))
  process.exit(1)
}
const promptId = payload.prompt_id
console.log('submitted:', promptId)

tracker.register(NODE, promptId)

let sample = null
let sawValue = null
const samples = []
for (let i = 0; i < 120; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 500))
  sample = progressForWorkflowNode(NODE)
  if (sample !== null) {
    if (sawValue === null || sample.value > sawValue) {
      sawValue = sample.value
      samples.push(`${sample.value}/${sample.max}`)
    }
  }
  if (i === 5 || i === 10 || i === 20) {
    console.log(`  t+${(i + 1) * 0.5}s tracker:`, JSON.stringify(tracker.debugState()))
  }
  // stop once the run finishes
  const history = await (await fetch(`${COMFY}/history/${promptId}`)).json()
  if (history[promptId]?.status?.completed === true) break
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
}

check('progress sample observed', sample !== null, true)
check('step value climbed past 1', sawValue !== null && sawValue > 1, true)
console.log('  progress samples (value/max):', samples.slice(0, 24).join('  '))

tracker.release(promptId)
console.log(failures === 0 ? '\nAll round 4.6 progress checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
