// Round 4.6.2 polling diagnostic: kick off a real canvas run, then poll
// the progress endpoint every 250 ms for 10 s and print everything that
// comes back. This proves (or disproves) that the canvas client polling
// loop should be seeing `running=true` and `progress>0` while a run is
// in flight.

const HOST = 'http://127.0.0.1:5783'
const ORIGIN = 'http://127.0.0.1:5783'
const CANVAS_ID = 'd8973e12-a612-4b01-baa9-a8ed0eaf05fd'
const WORKFLOW_NODE_ID = 'node-36fabe4e-1c72-4666-9e06-213b7b55fc0d'
const fetchOpts = { headers: { Origin: ORIGIN } }

// Bump steps so the run takes long enough to observe progress.
const patchedCanvasId = `${CANVAS_ID}-poll-test`
// We can't easily mutate the canvas, so we'll patch advancedOverrides
// in a copy by writing it back via the save endpoint. Instead, just kick
// off a run with whatever overrides the canvas has pinned.

const runPromise = fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...fetchOpts.headers },
  body: JSON.stringify({
    canvasId: CANVAS_ID,
    workflowNodeId: WORKFLOW_NODE_ID,
  }),
  signal: AbortSignal.timeout(180000),
})

// Start polling right away.
const pollStart = Date.now()
let pollCount = 0
let observed = 0
let observedRunning = 0
let observedProgress = 0
while (Date.now() - pollStart < 12_000) {
  try {
    const res = await fetch(`${HOST}/api/dsh-imagegen/canvas/workflow/progress?workflowNodeId=${encodeURIComponent(WORKFLOW_NODE_ID)}`, { ...fetchOpts })
    const json = await res.json()
    pollCount += 1
    if (json.running) observedRunning += 1
    if (json.progress !== null) observedProgress += 1
    if (json.running && json.progress !== null) observed += 1
    if (pollCount <= 30) {
      const t = ((Date.now() - pollStart) / 1000).toFixed(2)
      console.log(`t+${t}s running=${json.running} progress=${json.progress} node=${json.node}`)
    }
  } catch (err) {
    console.log('poll err:', err.message)
  }
  await new Promise(r => setTimeout(r, 250))
}

const runJson = await runPromise
const finalRun = await runJson.json()
console.log('--- run finished ---')
console.log('ok =', finalRun.ok, 'images =', finalRun.images?.length ?? 0)
console.log('polls:', pollCount, 'observed running=true:', observedRunning, 'observed progress!=null:', observedProgress, 'observed both:', observed)
