// Probe: what does ComfyUI's /history/{prompt_id} look like after the
// user manually cancels a running job (POST /interrupt)? Our poller must
// recognise that state immediately instead of waiting out the 600 s
// deadline. This script submits a deliberately long run (100 steps),
// interrupts it after 3 s, then dumps the history entry status.

import { readFileSync } from 'node:fs'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'
const template = JSON.parse(readFileSync(FIXTURE, 'utf8'))

const workflow = JSON.parse(JSON.stringify(template))
workflow['70'].inputs.steps = 100
workflow['70'].inputs.batch_size = 1

const submit = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen-cancel-probe' }),
})
const payload = await submit.json()
if (payload.prompt_id === undefined) {
  console.log('SUBMIT REJECTED:', JSON.stringify(payload).slice(0, 800))
  process.exit(1)
}
const promptId = payload.prompt_id
console.log('submitted prompt_id:', promptId)

await new Promise(resolve => setTimeout(resolve, 3000))
console.log('sending POST /interrupt…')
const interrupt = await fetch(`${COMFY}/interrupt`, { method: 'POST' })
console.log('interrupt status:', interrupt.status)

// Poll history and print every status we observe (with timestamps).
for (let i = 0; i < 20; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const response = await fetch(`${COMFY}/history/${promptId}`)
  if (response.status === 404) {
    console.log(`t+${i + 1}s  history: 404 (not written yet)`)
    continue
  }
  const history = await response.json()
  const entry = history[promptId]
  if (entry === undefined) {
    console.log(`t+${i + 1}s  history: entry missing (${JSON.stringify(history).slice(0, 200)})`)
    continue
  }
  console.log(`t+${i + 1}s  status=${JSON.stringify(entry.status)}`)
  console.log(`          outputs=${JSON.stringify(entry.outputs ?? {}).slice(0, 200)}`)
  if (entry.status?.completed === true || entry.status?.status_str === 'error') break
}
