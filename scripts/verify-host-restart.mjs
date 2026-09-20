// Post-restart verification for the dsh-imagegen plugin host.
//
// Run with `node scripts/verify-host-restart.mjs` AFTER the DSH host has
// loaded the freshly-built `lib/index.js` (round-1 changes: UI taskError
// display, Config schema installDir, local fallback path fix,
// UiFormatWorkflowError, workflow inspector).
//
// The script:
//
//   1. Pings `/settings/describe` and confirms the upgraded schema
//      references `installDir` (round-1 evidence the new code is loaded).
//   2. Pings `/tasks/list` to confirm the runtime is alive.
//   3. Submits a deliberately malformed generation request and
//      confirms the error path returns the structured `code` field
//      (early-return path: never creates a stuck 'running' task).
//   4. Submits a real (UI-format) workflow load via the task API and
//      confirms the UiFormatWorkflowError surfaces in `task.error` (the
//      previous failure mode was: response said "running" forever, UI
//      showed no reason — see the round-1 session for the diagnosis).
//
// Exit codes:
//   0  every probe succeeded
//   1  one or more probes failed (the script prints the failing reason)
//   2  host is unreachable (assumed not yet restarted)

import process from 'node:process'

const HOST = 'http://127.0.0.1:5783'

const failures = []
function assert(cond, message) {
  if (!cond) failures.push(message)
}

async function probeDescribe() {
  const r = await fetch(HOST + '/api/dsh-imagegen/settings/describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) {
    failures.push(`describe: HTTP ${r.status}`)
    return null
  }
  const payload = await r.json()
  const namespaces = payload?.value?.namespaces
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    failures.push('describe: no namespaces in response')
    return null
  }
  const namespace = namespaces[0]
  // The schema is built from src/index.ts; with the new `installDir`
  // field the schemastery library emits a fresh uid (was 616 before
  // the round-1 changes, became 618 with the two extra fields). Both
  // checks below distinguish old vs. new build:
  //   - schema uid >= 618 → new build very likely loaded
  //   - flat schema text mentions 'installDir' anywhere → new build
  //     confirmed even if uid-based heuristics race against other
  //     unrelated schema bumps.
  const schemaUid = namespace?.schema?.uid
  const flatSchema = JSON.stringify(namespace.schema ?? {})
  const hasInstallDir = flatSchema.includes('installDir')
  if (!hasInstallDir) {
    failures.push(`describe: schema (uid=${schemaUid}) does not reference 'installDir'. Host may be running an old build.`)
  }
  return { schemaUid, hasInstallDir }
}

/** Resolve the qwen_Image_2512 model alias on the configured channel.
 *  Both round-1 and round-2 probes depend on it; the alias comes from
 *  the channel view, never hard-coded (CJK characters are easy to
 *  mangle in shell-transport). */
async function resolveQwenAlias() {
  const r = await fetch(HOST + '/api/dsh-imagegen/settings/describe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const payload = await r.json()
  const channel = payload?.value?.namespaces?.[0]?.value?.channels?.find(c => c.id === 'f5756e57-c148-4277-9213-d80af04b34c3')
  const alias = channel?.models?.find(m => typeof m.id === 'string' && m.id.endsWith('.json') && m.id.includes('image_qwen'))?.alias
  return { channelId: channel?.id ?? '', alias: typeof alias === 'string' ? alias : null }
}

/** Round-2 inspect endpoint. With the qwen workflow still in UI
 *  format, the inspector returns `code: 'ui-format'` /
 *  `status: 'ui-format'` rather than throwing. A 404 means the host is
 *  still on the round-1 lib. */
async function probeWorkflowInspect() {
  const { channelId, alias } = await resolveQwenAlias()
  if (alias === null) {
    failures.push('inspect: could not resolve the image_qwen model alias from the configured channel.')
    return null
  }
  console.log(`      resolved alias: ${alias}`)

  const r = await fetch(HOST + '/api/dsh-imagegen/canvas/workflow/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId, model: alias }),
  })
  if (r.status === 404) {
    failures.push('inspect: HTTP 404 — host is still running the round-1 lib (no /canvas/workflow/inspect route registered).')
    return null
  }
  if (!r.ok) {
    failures.push(`inspect: HTTP ${r.status}`)
    return null
  }
  const payload = await r.json()
  if (payload?.ok === true) {
    failures.push(`inspect: expected ok=false (workflow is UI format), got ok=true`)
    return null
  }
  if (payload?.code !== 'ui-format' || payload?.status !== 'ui-format') {
    failures.push(`inspect: expected code='ui-format' status='ui-format', got code='${payload?.code}' status='${payload?.status}'`)
  }
  return { code: payload?.code, status: payload?.status, message: payload?.message }
}

async function probeTaskList() {
  const r = await fetch(HOST + '/api/dsh-imagegen/tasks/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) {
    failures.push(`tasks/list: HTTP ${r.status}`)
    return null
  }
  const payload = await r.json()
  if (!Array.isArray(payload.tasks)) {
    failures.push('tasks/list: response has no `tasks` array')
    return null
  }
  return payload.tasks.length
}

async function probeBadModel() {
  // Submit with a deliberately unknown model id so we exercise the
  // `image-model-not-configured` early-return path. The host should
  // answer with `{ ok: false, code: 'image-model-not-configured', ... }`
  // synchronously — no stuck 'running' task should be created.
  const r = await fetch(HOST + '/api/dsh-imagegen/tasks/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'text',
      model: 'comfyui:nonexistent_for_verify.json',
      prompt: 'verification probe',
      size: 'auto',
      quality: 'auto',
      n: 1,
      detail: '',
    }),
  })
  if (!r.ok) {
    failures.push(`tasks/submit (bad model): HTTP ${r.status}`)
    return null
  }
  const payload = await r.json()
  if (payload?.ok === true) {
    failures.push('tasks/submit (bad model): expected ok=false but got ok=true; the early-return path is broken.')
    return null
  }
  return { code: payload?.code, message: payload?.message }
}

async function probeUiFormatWorkflow() {
  // First resolve the actual model alias on the configured channel
  // (the workflow path contains CJK characters that bash/PowerShell
  // can mangle when hard-coded). The describe endpoint returns the
  // canonical alias; we mirror that here.
  const describe = await fetch(HOST + '/api/dsh-imagegen/settings/describe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const describePayload = await describe.json()
  const channel = describePayload?.value?.namespaces?.[0]?.value?.channels?.find(c => c.id === 'f5756e57-c148-4277-9213-d80af04b34c3')
  const alias = channel?.models?.find(m => typeof m.id === 'string' && m.id.endsWith('.json') && m.id.includes('image_qwen'))?.alias
  if (typeof alias !== 'string') {
    failures.push('ui-format: could not resolve the image_qwen_Image_2512 model alias from the configured channel.')
    return null
  }
  console.log(`      resolved alias: ${alias}`)

  // Submit a real workflow path (the one you already have in your
  // channel catalog). The workflow file is in ComfyUI's UI export
  // format, so the engine should reject it with `UiFormatWorkflowError`
  // and the task should end up in status='failed' with the actionable
  // "Save (API Format)" message. Before round 1 the same call produced
  // a stuck 'running' task that silently disappeared.
  const r = await fetch(HOST + '/api/dsh-imagegen/tasks/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'text',
      model: alias,
      prompt: '一个测试苹果 (verification probe)',
      size: 'auto',
      quality: 'auto',
      n: 1,
      detail: '',
      channelId: 'f5756e57-c148-4277-9213-d80af04b34c3',
      channel: 'ComfyUI（本地服务）',
    }),
  })
  if (!r.ok) {
    failures.push(`tasks/submit (ui-format): HTTP ${r.status}`)
    return null
  }
  const payload = await r.json()
  if (!payload?.ok) {
    failures.push(`tasks/submit (ui-format): expected ok=true; got ${JSON.stringify(payload)}`)
    return null
  }
  const taskId = payload.task.id
  // Wait up to 8 s for the task to settle into a terminal state.
  const deadline = Date.now() + 8000
  let final = null
  while (Date.now() < deadline) {
    const list = await fetch(HOST + '/api/dsh-imagegen/tasks/list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const listPayload = await list.json()
    final = listPayload.tasks.find(t => t.id === taskId)
    if (final && (final.status === 'completed' || final.status === 'failed' || final.status === 'cancelled')) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (final === null || final === undefined) {
    failures.push('ui-format: task did not appear in /tasks/list')
    return null
  }
  return final
}

async function main() {
  console.log('=== dsh-imagegen post-restart verification ===')
  console.log(`target: ${HOST}`)
  console.log()

  let reachable = true
  try {
    console.log('[1/4] /settings/describe …')
    const described = await probeDescribe()
    if (described === null) { reachable = false } else {
      console.log(`      schema uid: ${described.schemaUid}`)
      console.log(`      installDir present in schema: ${described.hasInstallDir ? 'YES ✓' : 'NO ✗'}`)
    }
  } catch (e) {
    if (e?.cause?.code === 'ECONNREFUSED') reachable = false
    else failures.push(`describe threw: ${e?.message ?? e}`)
  }

  if (!reachable) {
    console.error('host unreachable — did you restart DSH?')
    console.error('expected:  dsh web GUI is open and listening on http://127.0.0.1:5783')
    console.error('how to fix:')
    console.error('  - close the DSH window (system tray → Quit, or close the window)')
    console.error('  - reopen the DSH app and wait for the AI 生图 sidebar to load')
    console.error('  - rerun this script')
    process.exit(2)
  }

  console.log()
  console.log('[2/4] /tasks/list …')
  try {
    const taskCount = await probeTaskList()
    console.log(`      task count: ${taskCount}`)
  } catch (e) {
    failures.push(`tasks/list threw: ${e?.message ?? e}`)
  }

  console.log()
  console.log('[3/4] /tasks/submit (unknown model → expect ok:false, code:image-model-not-configured) …')
  try {
    const probe = await probeBadModel()
    if (probe === null) {
      console.log('      probe unreachable — see failures below')
    } else {
      console.log(`      code:    ${probe.code}`)
      console.log(`      message: ${probe.message}`)
      assert(probe.code === 'image-model-not-configured', `bad-model probe returned code '${probe.code}', expected 'image-model-not-configured'`)
    }
  } catch (e) {
    failures.push(`bad-model probe threw: ${e?.message ?? e}`)
  }

  console.log()
  console.log('[4/5] /tasks/submit (real workflow in UI format → expect failed with actionable error) …')
  try {
    const final = await probeUiFormatWorkflow()
    if (final !== null && final !== undefined) {
      console.log(`      task id:     ${final.id}`)
      console.log(`      status:      ${final.status}`)
      console.log(`      error:       ${final.error === undefined || final.error === null ? '(none)' : final.error.slice(0, 100) + (final.error.length > 100 ? '…' : '')}`)
      assert(final.status === 'failed', `expected status 'failed', got '${final.status}'. If 'running', the engine is hanging — restart host needed.`)
      const errorText = final.error ?? ''
      assert(
        errorText.includes('UI 导出格式') || errorText.includes('Save (API Format)'),
        `expected task.error to mention UI format / Save (API Format); got: '${errorText.slice(0, 120)}'`,
      )
    } else {
      console.log('      probe returned no task — see failures below')
    }
  } catch (e) {
    failures.push(`ui-format probe threw: ${e?.message ?? e}`)
  }

  console.log()
  console.log('[5/5] /canvas/workflow/inspect (round 2: UI format → expect code=ui-format) …')
  try {
    const inspect = await probeWorkflowInspect()
    if (inspect !== null && inspect !== undefined) {
      console.log(`      code:    ${inspect.code}`)
      console.log(`      status:  ${inspect.status}`)
      console.log(`      message: ${inspect.message?.slice(0, 100) ?? '(none)'}${(inspect.message?.length ?? 0) > 100 ? '…' : ''}`)
    } else {
      console.log('      probe returned no payload — see failures below')
    }
  } catch (e) {
    failures.push(`inspect probe threw: ${e?.message ?? e}`)
  }

  console.log()
  if (failures.length === 0) {
    console.log('OK — host is up, schema includes installDir, all error paths return structured codes.')
    console.log('next step: open the AI 生图 sidebar in the GUI, generate once, and confirm the task row shows the actual error (not just "生成中").')
    process.exit(0)
  }
  console.error(`FAILED — ${failures.length} assertion(s):`)
  for (const message of failures) console.error('  • ' + message)
  process.exit(1)
}

main().catch(error => {
  console.error('unexpected:', error)
  process.exit(2)
})