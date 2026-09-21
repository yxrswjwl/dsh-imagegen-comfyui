// Round 4.3 host-side verification: exercise `applyWorkflowOverrides`
// against the real z-image-turbo fixture. Runs the TS source directly
// (Node 24 strips the type annotations), so no build step is needed.
//
// Checks:
//   1. a number override lands as a number on the right node/input
//   2. a string override (sampler_name) lands as a string
//   3. malformed keys and unknown node ids are reported, not silently lost
//   4. a bad numeric value is rejected instead of poisoning the workflow
//   5. overriding `seed` also mirrors onto `noise_seed` when present
//   6. overrides survive the ordering contract: inject-then-override keeps
//      the user's pinned seed while a normal run still randomises

import { readFileSync } from 'node:fs'
import { applyWorkflowOverrides, injectPromptIntoWorkflow } from '../src/comfyui-workflow-loader.ts'

const FIXTURE = String.raw`D:\Code\game\dsh-imagegen-comfyui\scripts\.fixtures\verify_api_format_sample.json`
const template = JSON.parse(readFileSync(FIXTURE, 'utf8'))

const clone = () => JSON.parse(JSON.stringify(template))
let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`}`)
}

// ---- 1. numeric override -------------------------------------------------
{
  const wf = clone()
  const result = applyWorkflowOverrides(wf, { '68:batch_size': 4, '70:steps': '12' })
  check('batch_size written as number', wf['68'].inputs.batch_size, 4)
  check('steps coerced from string to number', wf['70'].inputs.steps, 12)
  check('two overrides applied', result.applied.length, 2)
  check('nothing skipped', result.skipped.length, 0)
}

// ---- 2. string override --------------------------------------------------
{
  const wf = clone()
  applyWorkflowOverrides(wf, { '70:sampler_name': 'euler', '9:filename_prefix': 'round43' })
  check('sampler_name written as string', wf['70'].inputs.sampler_name, 'euler')
  check('filename_prefix written as string', wf['9'].inputs.filename_prefix, 'round43')
}

// ---- 3. malformed / unknown keys ----------------------------------------
{
  const wf = clone()
  const result = applyWorkflowOverrides(wf, { 'nocolon': 1, ':leadingColon': 2, 'trailing:': 3, '999:steps': 4 })
  check('four bad keys skipped', result.skipped.length, 4)
  check('malformed reasons', result.skipped.map(s => s.reason), ['malformed-key', 'malformed-key', 'malformed-key', 'node-not-found'])
  check('no overrides applied', result.applied.length, 0)
}

// ---- 4. invalid value ----------------------------------------------------
{
  const wf = clone()
  const result = applyWorkflowOverrides(wf, { '70:steps': 'not-a-number' })
  check('non-numeric steps rejected', result.skipped.map(s => s.reason), ['invalid-value'])
  check('steps left untouched', wf['70'].inputs.steps, 8)
}

// ---- 5. seed mirrors onto noise_seed when present ------------------------
{
  const wf = clone()
  wf['70'].inputs.noise_seed = 777
  applyWorkflowOverrides(wf, { '70:seed': 4242 })
  check('seed pinned', wf['70'].inputs.seed, 4242)
  check('noise_seed mirrored', wf['70'].inputs.noise_seed, 4242)
}
{
  const wf = clone()
  applyWorkflowOverrides(wf, { '70:seed': 4242 })
  check('no noise_seed added when the node lacks one', 'noise_seed' in wf['70'].inputs, false)
}

// ---- 6. ordering: inject first, override second --------------------------
{
  const wf = clone()
  const summary = injectPromptIntoWorkflow(wf, { positive: 'a red apple' })
  check('inspector found the prompt node', summary.positiveNodeId, '67')
  check('prompt injected', wf['67'].inputs.text, 'a red apple')
  const injectedSeed = wf['70'].inputs.seed
  applyWorkflowOverrides(wf, { '70:seed': 1234, '68:width': 512 })
  check('pinned seed wins over the injected random seed', wf['70'].inputs.seed, 1234)
  check('injected seed really was random', typeof injectedSeed === 'number' && injectedSeed !== 1234, true)
  check('width override applied', wf['68'].inputs.width, 512)
}
{
  // Without a seed override the injected random seed must still stand.
  const wf = clone()
  injectPromptIntoWorkflow(wf, { positive: 'x' })
  const before = wf['70'].inputs.seed
  applyWorkflowOverrides(wf, { '68:batch_size': 1 })
  check('randomised seed survives when not overridden', wf['70'].inputs.seed, before)
}

console.log(failures === 0 ? '\nAll applyWorkflowOverrides checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
