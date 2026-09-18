// Verify the new workflow discovery path against the user's live ComfyUI.
// Connects to GET /api/workflow_templates, parses the response, and prints
// the folder-grouped structure the panel will render.
const url = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'
const resp = await fetch(`${url}/api/workflow_templates`)
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${await resp.text()}`)
  process.exit(1)
}
const raw = await resp.json()

const folders = []
let total = 0
for (const [name, entries] of Object.entries(raw)) {
  if (!Array.isArray(entries)) continue
  const workflows = entries.filter(e => typeof e === 'string' && e !== '').map(name => ({
    id: `${name}/${name}`,
    name,
    folder: name,
    path: name,
  }))
  if (workflows.length === 0) continue
  folders.push({ name, workflows })
  total += workflows.length
}
folders.sort((a, b) => {
  if (a.name === '' && b.name !== '') return -1
  if (a.name !== '' && b.name === '') return 1
  return a.name.localeCompare(b.name)
})

console.log('folders:', folders.length)
console.log('total workflows:', total)
console.log('first 3 folders:')
for (const folder of folders.slice(0, 3)) {
  console.log(`  ${folder.name} (${folder.workflows.length} workflows)`)
  for (const wf of folder.workflows.slice(0, 5)) console.log(`    - ${wf.name}`)
  if (folder.workflows.length > 5) console.log(`    ... +${folder.workflows.length - 5} more`)
}

const ok = folders.length > 0 && total > 0
console.log(ok ? '✓ /api/workflow_templates parsing works' : '✗ empty result')