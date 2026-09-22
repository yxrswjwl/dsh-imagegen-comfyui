// Round 4.6 host round-trip verify: drive the canvas workflow run route
// with the *real* user canvas + workflow node and confirm the response
// carries `comfy.params` (seed/steps/cfg/width/height/batch_size/...)
// plus the run completed and returned images.

const HOST = 'http://127.0.0.1:5783'
const ORIGIN = 'http://127.0.0.1:5783'
const CANVAS_ID = 'd8973e12-a612-4b01-baa9-a8ed0eaf05fd'
const WORKFLOW_NODE_ID = 'node-36fabe4e-1c72-4666-9e06-213b7b55fc0d'

const fetchOpts = { headers: { Origin: ORIGIN } }

const runResp = await fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...fetchOpts.headers },
  body: JSON.stringify({
    canvasId: CANVAS_ID,
    workflowNodeId: WORKFLOW_NODE_ID,
    overrides: { '70:steps': 4 },
  }),
  signal: AbortSignal.timeout(180000),
})
const runJson = await runResp.json()

console.log('ok =', runJson.ok)
console.log('code =', runJson.code ?? '-')
console.log('message =', runJson.message ?? '-')
console.log('images =', runJson.images?.length ?? 0)
console.log('params =', JSON.stringify(runJson.params ?? {}, null, 2))

let failures = 0
function assert(label, cond) {
  if (cond) console.log('  ok  ', label)
  else { console.log(' FAIL ', label); failures += 1 }
}

const params = runJson.params ?? {}
assert('run succeeded', runJson.ok === true)
assert('images non-empty', (runJson.images?.length ?? 0) >= 1)
assert('params present', Object.keys(params).length > 0)
assert('seed present in params', Object.entries(params).some(([k]) => k.endsWith(':seed')))
assert('seed is a number', typeof Object.entries(params).find(([k]) => k.endsWith(':seed'))?.[1] === 'number')
assert('steps present in params', Object.entries(params).some(([k]) => k.endsWith(':steps')))
// Steps value reflects the node's pinned `advancedOverrides`; we just
// assert it is a positive integer (the route ignores ad-hoc body overrides
// — those have to be pinned on the canvas node first).
const stepsValue = Object.entries(params).find(([k]) => k.endsWith(':steps'))?.[1]
assert('steps value is a positive integer', typeof stepsValue === 'number' && stepsValue > 0 && Number.isInteger(stepsValue))
assert('cfg present in params', Object.entries(params).some(([k]) => k.endsWith(':cfg')))
assert('width present in params', Object.entries(params).some(([k]) => k.endsWith(':width')))
assert('height present in params', Object.entries(params).some(([k]) => k.endsWith(':height')))
assert('batch_size present in params', Object.entries(params).some(([k]) => k.endsWith(':batch_size')))
assert('sampler_name present in params', Object.entries(params).some(([k]) => k.endsWith(':sampler_name')))
assert('scheduler present in params', Object.entries(params).some(([k]) => k.endsWith(':scheduler')))

console.log(failures === 0 ? '\nAll round 4.6 host params checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
