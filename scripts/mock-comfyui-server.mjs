// Mock ComfyUI HTTP server for DSH plugin testing.
// Listens on 127.0.0.1:8188 (the default the plugin pre-fills), exposes the
// `/workflows` endpoint ComfyUI ships, plus a `/system_stats` health probe.
// Run in a second terminal while you exercise the plugin settings panel.
import http from 'node:http'

const PORT = 8188

const mockBody = {
  'SD3/z_image_turbo.json': { path: 'SD3/z_image_turbo.json', name: 'z_image_turbo' },
  'SD3/sd3_base.json': { path: 'SD3/sd3_base.json', name: 'SD3 Base' },
  'Flux/flux_dev.json': { path: 'Flux/flux_dev.json', name: 'Flux Dev' },
  'Flux/flux_schnell.json': { path: 'Flux/flux_schnell.json' },
  'Tools/upscale_x4.json': { path: 'Tools/upscale_x4.json' },
  'Tools/inpaint_default.json': { path: 'Tools/inpaint_default.json', name: 'Inpaint Default' },
  'z_image_turbo_root.json': { path: 'z_image_turbo_root.json', name: 'z_image_turbo (root)' },
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url === '/workflows') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(mockBody))
    return
  }
  if (req.url === '/system_stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ system: { os: 'linux', python_version: '3.11.mock' } }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end(`mock ComfyUI 404: ${req.url}\n`)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock ComfyUI listening on http://127.0.0.1:${PORT}`)
  console.log(`  - GET /workflows returns ${Object.keys(mockBody).length} mock workflows across 3 folders`)
  console.log(`  - GET /system_stats returns a health probe`)
  console.log('press Ctrl+C to stop')
})