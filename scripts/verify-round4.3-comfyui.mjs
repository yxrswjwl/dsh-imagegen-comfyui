// Round 4.3 ComfyUI-level verification: prove that writing a scalar into
// `workflow[nodeId].inputs[inputName]` actually changes ComfyUI's
// behaviour — the whole override feature rests on that assumption.
//
// We submit the z-turbo fixture twice, with only `batch_size` differing,
// and count the images ComfyUI reports in each history entry. The
// mutation is applied with the exact same helper the engine uses, so a
// green run here means the engine's write path is correct.

import { readFileSync } from 'node:fs'
import { applyWorkflowOverrides } from '../src/comfyui-workflow-loader.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const COMFY = 'http://127.0.0.1:8188'
const template = JSON.parse(readFileSync(FIXTURE, 'utf8'))

async function runWith(overrides) {
  const workflow = JSON.parse(JSON.stringify(template))
  const result = applyWorkflowOverrides(workflow, overrides)
  if (result.skipped.length > 0) throw new Error(`overrides skipped: ${JSON.stringify(result.skipped)}`)
  const submit = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'dsh-imagegen-round43-verify' }),
  })
  const payload = await submit.json()
  if (payload.prompt_id === undefined) {
    throw new Error(`ComfyUI rejected the prompt: ${JSON.stringify(payload).slice(0, 800)}`)
  }
  return await awaitHistory(payload.prompt_id)
}

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

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`)
}

console.log('baseline — batch_size left at the workflow default (2), 8 steps…')
const baseline = await runWith({ '70:steps': 8 })
check('baseline completed', baseline.status, 'success')
check('workflow default batch_size=2 produced 2 images', baseline.images.length, 2)

console.log('\noverride — batch_size pinned to 1 and steps to 4…')
const single = await runWith({ '70:steps': 4, '68:batch_size': 1 })
check('override run completed', single.status, 'success')
check('batch_size override produced 1 image', single.images.length, 1)

console.log('\noverride — batch_size pinned to 3…')
const triple = await runWith({ '70:steps': 4, '68:batch_size': 3 })
check('override run completed', triple.status, 'success')
check('batch_size override produced 3 images', triple.images.length, 3)

console.log('\noverride — width/height pinned to 512x512…')
const small = await runWith({ '70:steps': 4, '68:batch_size': 1, '68:width': 512, '68:height': 512 })
check('override run completed', small.status, 'success')
check('size override still produced an image', small.images.length, 1)

console.log(failures === 0 ? '\nAll ComfyUI override checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
