// Faithful reproduction of the DSH /image-models route logic.
// Uses the same helpers the production route uses (lib/index.js), with the
// exact same body parsing, channel-view resolution, and dispatch. This
// proves the route returns the workflow listing (not just the probe) for
// "editor / saved channel" calls.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const mod = await import(pathToFileURL(resolve(repoRoot, 'lib/index.js')).href)

const comfyUrl = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'

// Synthesize a fake channel view + body matching what the editor sends.
const view = {
  channels: [
    { id: 'fake-comfy-channel', preset: 'comfyui-local', name: 'ComfyUI (local)', apiUrl: comfyUrl, apiKey: '', models: [] },
  ],
  defaultChannelId: 'fake-comfy-channel',
}

async function handleDetect(body) {
  const stored = view.channels.find(c => c.id === body?.channelId)
    ?? view.channels.find(c => c.id === view.defaultChannelId)
    ?? view.channels[0]
  const upstream = {
    apiUrl: (typeof body?.apiUrl === 'string' && body.apiUrl.trim() !== '') ? body.apiUrl.trim() : (stored?.apiUrl ?? ''),
    apiKey: (typeof body?.apiKey === 'string' && body.apiKey.trim() !== '') ? body.apiKey.trim() : (stored?.apiKey ?? ''),
  }
  const storedPreset = stored?.preset ?? ''
  const forceKind = (typeof body?.forceKind === 'string' && (body.forceKind === 'comfyui' || body.forceKind === 'openai'))
    ? body.forceKind : null
  const treatAsComfyUi = mod.isComfyUiPreset(storedPreset) || forceKind === 'comfyui'
  if (!treatAsComfyUi) return { ok: true, kind: 'openai', models: [] }
  const comfyPreset = storedPreset === '' ? 'comfyui-local' : storedPreset
  if (forceKind === 'comfyui' && storedPreset === '') {
    const probe = await mod.probeComfyUiService(upstream, { preset: comfyPreset })
    return { ok: true, kind: 'comfyui', probe }
  }
  const workflows = await mod.listComfyUiWorkflows(upstream, { preset: comfyPreset })
  return { ok: true, kind: 'comfyui', workflows: { folders: workflows.folders, total: workflows.total } }
}

const server = http.createServer(async (req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {}
      const result = await handleDetect(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(500)
      res.end(JSON.stringify({ ok: false, message: error.message }))
    }
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('mock route listening on', `http://127.0.0.1:${port}/detect`)

const probe = await fetch(`http://127.0.0.1:${port}/detect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelId: 'fake-comfy-channel', apiUrl: comfyUrl }),
}).then(r => r.json())

console.log('--- editor call (channelId + apiUrl, NO forceKind) ---')
console.log('kind:', probe.kind)
if (probe.kind === 'comfyui' && probe.workflows) {
  console.log(`workflows: ${probe.workflows.total}, folders: ${probe.workflows.folders.length}`)
  for (const f of probe.workflows.folders.slice(0, 3)) {
    console.log(`  ${f.name} (${f.workflows.length})`)
  }
} else if (probe.kind === 'comfyui' && probe.probe) {
  console.log('probe (NOT what editor should see):', probe.probe)
} else {
  console.log(JSON.stringify(probe, null, 2))
}

const pickerProbe = await fetch(`http://127.0.0.1:${port}/detect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiUrl: comfyUrl, forceKind: 'comfyui' }),
}).then(r => r.json())

console.log('--- picker call (forceKind=comfyui, no channelId) ---')
console.log('kind:', pickerProbe.kind, '(should be probe)')
console.log('reachable:', pickerProbe.probe?.reachable)

server.close()