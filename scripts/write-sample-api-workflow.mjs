// One-shot: copy the user's real z-image-turbo workflow into the
// project's sandbox-friendly fixture folder, stripping the
// `SystemNotification|pysssss` node (a UI-side desktop toast that
// requires a separate notification plugin and is meaningless for
// server-side generation). The user's workflow is already in API
// format (`{ "<id>": { class_type, inputs } }`), so no conversion is
// needed — the round-2 inspect path can probe the `ok: true` branch
// against it directly, and the round-4 run path can execute it
// without the user needing to log into the ComfyUI browser and
// re-save as "API Format".

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = 'C:\\Users\\31604\\.dsh\\attachments\\v1\\files\\04\\045511ad5a6131fba38b16aa921cafe44573b17d696141c1cfe26594bb91c817\\image_z_image_turbo.json'
const TARGET = path.resolve('scripts/.fixtures/verify_api_format_sample.json')

await mkdir(path.dirname(TARGET), { recursive: true })

// Round-4.1 sample uses the user's own z-image-turbo workflow so the
// fixture models actually exist on the user's ComfyUI install (z-image
// + qwen_3_4b + ae). Three reasons this beats a hand-built fixture:
//   1) every model path here has been seen-good by ComfyUI already
//      (the user runs this workflow day-to-day);
//   2) the API format used here is the *exact* shape ComfyUI expects
//      at /prompt — inline scalar values in `inputs[name]`, no widget
//      markers, no widgets_values positional indirection — which is
//      what earlier hand-built attempts got wrong;
//   3) the workflow chain exercises every interesting node type the
//      canvas needs to recognise: CLIPLoader / UNETLoader / VAELoader
//      (model splits), ModelSamplingAuraFlow (sampler shim), KSampler,
//      VAEDecode, SaveImage, plus ConditioningZeroOut (so the canvas
//      can see how a negative-prompt slot is wired through a no-op).
//
// We strip `SystemNotification|pysssss` because it's a UI-side desktop
// toast with no server value and it depends on a notification plugin
// the user's ComfyUI may not have installed.
const SOURCE_TEXT = await readFile(SOURCE, 'utf8')
const SOURCE_WORKFLOW = JSON.parse(SOURCE_TEXT)
const wf = {}
for (const [id, node] of Object.entries(SOURCE_WORKFLOW)) {
  if (node.class_type === 'SystemNotification|pysssss') continue
  wf[id] = node
}

await writeFile(TARGET, JSON.stringify(wf, null, 2), 'utf8')
console.log('wrote', TARGET)
console.log('next: in the canvas, dock → 工作流 → 导入工作流 JSON → 选这个文件,')
console.log('      拖一个文本节点连到 Positive Prompt 端口, 点 workflow 节点的「生成」按钮.')
console.log('      (插件会把 JSON 拷贝到 imported-workflows/<uuid>.json 并通过 engine 直接喂给 ComfyUI)')