// Final end-to-end test: simulate exactly what the editor sends (channelId,
// apiUrl, forceKind=comfyui, NO probeOnly) and confirm the route returns
// the workflow listing, not a probe.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const mod = await import(pathToFileURL(resolve(repoRoot, 'lib/index.js')).href)

const comfyUrl = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'

// Simulate a channel with a stored preset (the "happy path" the editor
// should always hit) AND one without (the legacy fallback case).
const view = {
  channels: [
    { id: 'new-channel', preset: 'comfyui-local', name: 'Local', apiUrl: comfyUrl, apiKey: '', models: [] },
    { id: 'legacy-channel', preset: '', name: 'Legacy', apiUrl: comfyUrl, apiKey: '', models: [] },
  ],
  defaultChannelId: 'legacy-channel',
}

async function handle(body) {
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
  const probeOnly = body?.probeOnly === true
  const url = upstream.apiUrl.trim()
  const looksLikeComfyUiUrl = url !== '' && !/\/v\d(?:\/|$)/.test(url) && /^https?:\/\//.test(url)
  const treatAsComfyUi = mod.isComfyUiPreset(storedPreset)
    || forceKind === 'comfyui'
    || (storedPreset === '' && forceKind !== 'openai' && looksLikeComfyUiUrl)
  if (!treatAsComfyUi) {
    const models = await mod.listImageModels ? await mod.listImageModels(upstream) : []
    return { ok: true, kind: 'openai', models }
  }
  const comfyPreset = storedPreset === '' ? 'comfyui-local' : storedPreset
  if (probeOnly) {
    const probe = await mod.probeComfyUiService(upstream, { preset: comfyPreset })
    return { ok: true, kind: 'comfyui', probe }
  }
  const workflows = await mod.listComfyUiWorkflows(upstream, { preset: comfyPreset })
  return { ok: true, kind: 'comfyui', workflows: { folders: workflows.folders, total: workflows.total } }
}

const server = http.createServer(async (req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {}
      const result = await handle(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e) { res.writeHead(500); res.end(e.message) }
  })
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const cases = [
  { label: 'editor · stored preset', body: { channelId: 'new-channel', apiUrl: comfyUrl, forceKind: 'comfyui' } },
  { label: 'editor · legacy (preset empty) + forceKind', body: { channelId: 'legacy-channel', apiUrl: comfyUrl, forceKind: 'comfyui' } },
  { label: 'picker · forceKind + probeOnly', body: { apiUrl: comfyUrl, forceKind: 'comfyui', probeOnly: true } },
  { label: 'editor · no forceKind', body: { channelId: 'new-channel', apiUrl: comfyUrl } },
]

for (const c of cases) {
  const resp = await fetch(`http://127.0.0.1:${port}/detect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c.body),
  }).then(r => r.json())
  const summary = resp.kind === 'comfyui' && resp.workflows
    ? `workflows ${resp.workflows.total}`
    : resp.kind === 'comfyui' && resp.probe
      ? `probe reachable=${resp.probe.reachable}`
      : `${resp.kind}`
  console.log(`${c.label.padEnd(45)} → kind=${resp.kind} (${summary})`)
}

server.close()