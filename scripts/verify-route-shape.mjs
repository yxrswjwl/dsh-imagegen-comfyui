// Simulate the route handler's full logic by calling the same helpers the
// route uses, with the exact request body the editor sends.
//
// The editor's fetch is:
//   POST /api/dsh-imagegen/image-models
//   body = { channelId, apiUrl?, apiKey? }
//
// The route's logic:
//   stored = view.channels.find(c => c.id === body.channelId)
//          ?? view.channels.find(c => c.id === view.defaultChannelId)
//          ?? view.channels[0]
//   treatAsComfyUi = isComfyUiPreset(storedPreset) || forceKind === 'comfyui'
//   if (treatAsComfyUi && forceKind === 'comfyui' && storedPreset === '') -> probe
//   else if (treatAsComfyUi) -> workflows
//
// So we need to confirm:
//   1. stored is found via channelId
//   2. storedPreset is the comfyui-local preset
//   3. treatAsComfyUi is true
//   4. forceKind is NOT 'comfyui' (editor doesn't send forceKind)
//   5. So workflows branch runs
//
// The picker sends forceKind=comfyui and no channelId, so:
//   stored = view.channels[0] or default channel; if no saved channels, stored is undefined
//   storedPreset = ''
//   treatAsComfyUi = true (via forceKind)
//   forceKind === 'comfyui' && storedPreset === '' -> probe

const { pathToFileURL } = await import('node:url')
const { resolve, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// Read routes.ts source for inspection
import { readFileSync } from 'node:fs'
const src = readFileSync(resolve(repoRoot, 'src/routes.ts'), 'utf8')
const start = src.indexOf('image model discovery')
const end = src.indexOf('// --------------------------------------------', start + 100)
console.log('--- routes.ts /image-models branch ---')
console.log(src.slice(start, end).split('\n').slice(0, 60).join('\n'))