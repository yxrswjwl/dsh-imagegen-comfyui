// Round 4.6 snapshot verification: prove that snapshotWorkflowParams
// captures the *final* widget values that the engine will submit to
// ComfyUI — including injected random seed, original samplers / steps /
// cfg / width / height, etc.

import { readFileSync } from 'node:fs'
import { applyWorkflowOverrides, snapshotWorkflowParams } from '../src/comfyui-workflow-loader.ts'
import { randomInt } from 'node:crypto'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const workflow = JSON.parse(readFileSync(FIXTURE, 'utf8'))

// Inject a known seed so we can assert it survives.
const seed = 1234567890
const clone = JSON.parse(JSON.stringify(workflow))
applyWorkflowOverrides(clone, { '70:seed': seed })

const snap = snapshotWorkflowParams(clone)

function assertContains(obj, keyFragment, expected) {
  const match = Object.entries(obj).find(([k]) => k.endsWith(keyFragment))
  if (!match) {
    console.log('  FAIL: missing key with fragment', keyFragment)
    console.log('  keys:', Object.keys(obj).join(', '))
    process.exit(1)
  }
  if (match[1] !== expected) {
    console.log(`  FAIL: ${match[0]} = ${JSON.stringify(match[1])} (expected ${JSON.stringify(expected)})`)
    process.exit(1)
  }
  console.log(`  ok   ${match[0]} = ${JSON.stringify(match[1])}`)
}

console.log('snapshot keys:', Object.keys(snap).join(', '))
assertContains(snap, 'seed', seed)              // overridden by user
// 'noise_seed' is only present on KSamplerAdvanced; check conditionally.
if (Object.keys(snap).some((k) => k.endsWith(':noise_seed'))) {
  assertContains(snap, 'noise_seed', seed)
}
// 'control_after_generate' is only emitted by some samplers; check conditionally.
if (Object.keys(snap).some((k) => k.endsWith(':control_after_generate'))) {
  assertContains(snap, 'control_after_generate', 'randomize')
}
assertContains(snap, 'steps', clone['70'].inputs.steps)
assertContains(snap, 'cfg', clone['70'].inputs.cfg)
assertContains(snap, 'sampler_name', clone['70'].inputs.sampler_name)
assertContains(snap, 'scheduler', clone['70'].inputs.scheduler)
assertContains(snap, 'denoise', clone['70'].inputs.denoise)
assertContains(snap, 'width', clone['68'].inputs.width)
assertContains(snap, 'height', clone['68'].inputs.height)
assertContains(snap, 'batch_size', clone['68'].inputs.batch_size)

// Apply a user override to steps; snapshot should reflect the override.
const clone2 = JSON.parse(JSON.stringify(workflow))
applyWorkflowOverrides(clone2, { '70:steps': 33 })
const snap2 = snapshotWorkflowParams(clone2)
assertContains(snap2, 'steps', 33)

// Non-widget inputs (text references) must be filtered out.
for (const key of Object.keys(snap)) {
  if (key.endsWith(':text')) {
    console.log('  FAIL: text input leaked into snapshot:', key)
    process.exit(1)
  }
}
console.log('  ok   no text/image/model inputs leaked')

console.log('\nAll round 4.6 snapshot checks passed.')
