// Simulate exactly what the channel-editor "Detect" button sends to the
// /image-models route, then check the response. We have to stand up a
// minimal DSH route mock because the real route lives inside the DSH
// host process — but we can exercise the route's logic directly via the
// exported listComfyUiWorkflows helper (the exact same call the route
// makes after it sees a ComfyUI preset).
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const mod = await import(pathToFileURL(resolve(repoRoot, 'lib/index.js')).href)

const url = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'
const preset = 'comfyui-local'

// 1) Direct probe call (what the picker does)
console.log('--- probeComfyUiService ---')
const probe = await mod.probeComfyUiService({ apiUrl: url, apiKey: '' }, { preset })
console.log(probe)

// 3) Workflow listing (what the editor "Detect" button does)
console.log('--- listComfyUiWorkflows ---')
const wf = await mod.listComfyUiWorkflows({ apiUrl: url, apiKey: '' }, { preset })
console.log(`folders: ${wf.folders.length}, total: ${wf.total}`)
for (const f of wf.folders.slice(0, 2)) {
  console.log(`  ${f.name} (${f.workflows.length})`)
  for (const w of f.workflows.slice(0, 3)) console.log(`    - ${w.name}`)
}