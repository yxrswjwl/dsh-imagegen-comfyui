import process from 'node:process'

const HOST = 'http://127.0.0.1:5783'

// Get the actual user's current canvas (first one in index)
const idxRes = await fetch(HOST + '/api/dsh-imagegen/canvas/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
const idx = await idxRes.json()
const canvasId = idx.projects?.[0]?.id
if (!canvasId) { console.log('no canvas'); process.exit(1) }

// Read canvas to find a workflow node
const docRes = await fetch(HOST + '/api/dsh-imagegen/canvas/read', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: canvasId }),
})
const doc = await docRes.json()
const wf = doc.document?.nodes?.find(n => n.type === 'workflow')
if (!wf) { console.log('no workflow node in canvas'); process.exit(1) }
console.log('found workflow node:', wf.id, 'title:', wf.title, 'model:', wf.metadata?.workflow?.model, 'path:', wf.metadata?.workflow?.workflowPath)

// Make sure there's at least one text node connected. If not, create a fake
// text node on the fly — the canvas document is preserved between tests.
const hasTextConn = doc.document.connections.some(c => c.toNodeId === wf.id && doc.document.nodes.some(n => n.id === c.fromNodeId && n.type === 'text'))
if (!hasTextConn) {
  console.log('no text->workflow connection. Creating one...')
  const textNode = {
    id: 'probe-text-' + Date.now(),
    type: 'text',
    title: 'probe text',
    x: wf.x - 200, y: wf.y,
    width: 200, height: 100,
    metadata: { text: 'a small red apple on a white background' },
  }
  doc.document.nodes.push(textNode)
  doc.document.connections.push({ id: 'probe-conn-' + Date.now(), fromNodeId: textNode.id, toNodeId: wf.id, toHandle: '67:text' })
  await fetch(HOST + '/api/dsh-imagegen/canvas/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ document: doc.document }),
  })
  console.log('text node + connection saved')
}

const r = await fetch(HOST + '/api/dsh-imagegen/canvas/workflow/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ canvasId, workflowNodeId: wf.id }),
})
const data = await r.json()
console.log('result:', JSON.stringify(data).slice(0, 2000))