// Round 4.4 cancel verification: prove that a manual ComfyUI cancel
// (POST /interrupt while the job runs) surfaces on the canvas node almost
// immediately, instead of polling to the 600 s deadline. We submit a
// deliberately long run, interrupt it after 3 s, and feed the prompt id
// into the exact poller the engine uses (`waitForComfyUiOutputs`).

import { readFileSync } from 'node:fs'
import { applyWorkflowOverrides } from '../src/comfyui-workflow-loader.ts'
import { waitForComfyUiOutputs } from '../src/comfyui-history.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'

const template = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const workflow = JSON.parse(JSON.stringify(template))
// Long run (100 steps) so there is time to interrupt it.
const applied = applyWorkflowOverrides(workflow, { '70:steps': 400, '68:batch_size': 2 })
if (applied.skipped.length > 0) throw new Error(`overrides skipped: ${JSON.stringify(applied.skipped)}`)

const submit = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen-round44-cancel' }),
})
const payload = await submit.json()
if (payload.prompt_id === undefined) {
  console.log('SUBMIT REJECTED:', JSON.stringify(payload).slice(0, 600))
  process.exit(1)
}
const promptId = payload.prompt_id
console.log('submitted long run:', promptId)

await new Promise(resolve => setTimeout(resolve, 3000))
await fetch(`${COMFY}/interrupt`, { method: 'POST' })
console.log('interrupt sent — waiting for the poller to notice…')

const started = Date.now()
// The poller's internal sleeps use `timer.unref()` (fine inside the
// long-lived host). In a standalone script that leaves the event loop
// empty, so keep the process alive until the awaited run settles.
const keepAlive = setInterval(() => {}, 1000)
try {
  const images = await waitForComfyUiOutputs(COMFY, '', promptId)
  clearInterval(keepAlive)
  console.log(`FAIL: expected a cancel error, got ${images.length} image(s)`)
  process.exit(1)
} catch (error) {
  clearInterval(keepAlive)
  const elapsed = Date.now() - started
  const message = error instanceof Error ? error.message : String(error)
  const ok = message.includes('取消') && elapsed < 30000
  console.log(`cancel surfaced immediately: ${ok}`)
  console.log(`  message: ${message}`)
  console.log(`  elapsed: ${elapsed} ms (must be far below the 600 000 ms deadline)`)
  if (!ok) process.exit(1)
}
console.log('\nOK: manual cancel reaches the canvas node without waiting out the deadline.')
