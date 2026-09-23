/**
 * The "imported workflows" library.
 *
 * Stores ComfyUI API-format workflow JSON files the user uploaded through the
 * canvas picker, plus a manifest mapping a stable id to each file. The
 * manifest carries the user-facing display name (independent of the disk
 * filename, which is collision-safe and filesystem-friendly) so renaming a
 * library entry does not touch the underlying JSON.
 *
 * Layout under `<imageDataRoot>/imported-workflows/`:
 *   - <file>.json    one per imported workflow (disk filename is sanitised
 *                    from the original upload name with `-N` suffix on clash)
 *   - manifest.json  index `{ entries: ImportedWorkflowLibraryEntry[] }`
 *
 * Concurrency: read-modify-write of the manifest is guarded by an in-process
 * mutex (`libraryLock`) so concurrent list/rename/delete calls during a
 * save refresh cannot interleave a torn write. Multi-process scenarios are
 * out of scope — this directory is owned by the host process.
 */

import { mkdir as fsMkdir, readdir as fsReadDir, readFile as fsReadFile, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises'
import path from 'node:path'
import { safeFileName } from './canvas-store.ts'
import { imageDataRoot } from './image-storage-path.ts'

const MANIFEST_FILENAME = 'manifest.json'

export interface ImportedWorkflowLibraryEntry {
  /** Stable id assigned at import time; survives renames. */
  id: string
  /** Disk filename relative to the library dir (always `<safe>.json`). */
  file: string
  /** Absolute path to the JSON file; cached at write time so the picker
   *  can hand it to the workflow loader without re-resolving. */
  path: string
  /** User-facing name (independent from `file`; rename-only mutates this). */
  displayName: string
  /** ISO timestamp the entry landed in the library. */
  importedAt: string
  /** On-disk JSON size in bytes. */
  bytes: number
}

interface LibraryManifest {
  entries: ImportedWorkflowLibraryEntry[]
}

/** Process-local lock so concurrent library ops can't trample each other. */
let libraryChain: Promise<unknown> = Promise.resolve()
function withLibraryLock<T>(work: () => Promise<T>): Promise<T> {
  const next = libraryChain.then(work, work)
  libraryChain = next.catch(() => undefined)
  return next
}

function libraryDir(): string {
  return path.join(imageDataRoot(), 'imported-workflows')
}

function manifestPath(): string {
  return path.join(libraryDir(), MANIFEST_FILENAME)
}

/** Ensure the directory and an empty manifest exist. Idempotent. */
async function ensureDir(): Promise<void> {
  await fsMkdir(libraryDir(), { recursive: true })
}

/** Read the manifest; return an empty one if missing/freshly created. */
async function readManifest(): Promise<LibraryManifest> {
  await ensureDir()
  try {
    const raw = await fsReadFile(manifestPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return { entries: [] }
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return { entries: [] }
    // Defensive: drop entries whose backing file vanished since last write.
    const survivors: ImportedWorkflowLibraryEntry[] = []
    for (const candidate of entries) {
      if (candidate === null || typeof candidate !== 'object') continue
      const entry = candidate as Partial<ImportedWorkflowLibraryEntry>
      if (typeof entry.id !== 'string' || typeof entry.file !== 'string' || typeof entry.path !== 'string') continue
      try {
        await fsStat(entry.path)
        survivors.push({
          id: entry.id,
          file: entry.file,
          path: entry.path,
          displayName: typeof entry.displayName === 'string' && entry.displayName !== ''
            ? entry.displayName
            : entry.file,
          importedAt: typeof entry.importedAt === 'string' ? entry.importedAt : new Date().toISOString(),
          bytes: typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) ? entry.bytes : 0,
        })
      } catch {
        // backing file gone → drop
      }
    }
    return { entries: survivors }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { entries: [] }
    throw error
  }
}

async function writeManifest(manifest: LibraryManifest): Promise<void> {
  await ensureDir()
  await fsWriteFile(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
}

/** Add `-2`, `-3`, … to a candidate base until it is unique among existing
 *  filenames. Caller passes the `.json` already included. */
async function uniqueFileName(base: string): Promise<string> {
  const manifest = await readManifest()
  const taken = new Set(manifest.entries.map(entry => entry.file))
  if (!taken.has(base)) return base
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${stem}-${counter}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  // Pathological case: 999 collisions. Fall back to a UUID tail.
  const tail = Math.random().toString(36).slice(2, 8)
  return `${stem}-${tail}${ext}`
}

/** Pick a fresh non-clashing id (UUIDv4-ish; sufficient for our scope). */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface ImportWorkflowRequest {
  /** JSON body of the workflow. */
  body: string
  /** Original filename the user picked (used to seed `displayName` and
   *  derive the disk filename; the picker strips the path/extension). */
  originalName: string
}

/** Persist a brand-new workflow file and append a manifest entry. */
export async function importWorkflowToLibrary(request: ImportWorkflowRequest): Promise<ImportedWorkflowLibraryEntry> {
  return withLibraryLock(async () => {
    await ensureDir()
    const safeBase = safeFileName(request.originalName.replace(/\.json$/i, ''))
    const baseFilename = `${safeBase === '' || safeBase === 'file' ? 'workflow' : safeBase}.json`
    const uniqueFilename = await uniqueFileName(baseFilename)
    const fullPath = path.join(libraryDir(), uniqueFilename)
    await fsWriteFile(fullPath, request.body, 'utf8')
    const stat = await fsStat(fullPath)
    const entry: ImportedWorkflowLibraryEntry = {
      id: newId(),
      file: uniqueFilename,
      path: fullPath,
      displayName: safeBase === '' || safeBase === 'file' ? 'workflow' : safeBase,
      importedAt: new Date().toISOString(),
      bytes: stat.size,
    }
    const manifest = await readManifest()
    manifest.entries.unshift(entry)
    await writeManifest(manifest)
    return entry
  })
}

/** Re-read the manifest; newest-imported first. */
export async function listImportedWorkflows(): Promise<ImportedWorkflowLibraryEntry[]> {
  return withLibraryLock(async () => {
    const manifest = await readManifest()
    return manifest.entries.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt))
  })
}

/** Update only the display name; the backing file is not touched. */
export async function renameImportedWorkflow(id: string, displayName: string): Promise<ImportedWorkflowLibraryEntry | null> {
  return withLibraryLock(async () => {
    const manifest = await readManifest()
    const entry = manifest.entries.find(candidate => candidate.id === id)
    if (entry === undefined) return null
    const cleaned = displayName.trim()
    entry.displayName = cleaned === '' ? entry.file.replace(/\.json$/i, '') : cleaned
    await writeManifest(manifest)
    return entry
  })
}

/** Delete the JSON file and drop the manifest entry. */
export async function deleteImportedWorkflow(id: string): Promise<boolean> {
  return withLibraryLock(async () => {
    const manifest = await readManifest()
    const index = manifest.entries.findIndex(candidate => candidate.id === id)
    if (index === -1) return false
    const entry = manifest.entries[index]
    manifest.entries.splice(index, 1)
    try {
      await fsUnlink(entry.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    await writeManifest(manifest)
    return true
  })
}

/** Look up the absolute path of an imported workflow by id; returns null
 *  if the id is unknown or the backing file is gone. Used by the picker
 *  when handing the workflow to `canvasWorkflowInspect` (which expects a
 *  `comfyui:` alias — we feed it `comfyui:<absolute-path>`). */
export async function pathOfImportedWorkflow(id: string): Promise<string | null> {
  const entries = await listImportedWorkflows()
  const entry = entries.find(candidate => candidate.id === id)
  return entry?.path ?? null
}

/** Re-export the directory path so tests / cleanup utilities can find it. */
export function importedWorkflowsDir(): string {
  return libraryDir()
}

/** Pruning helper used by tests: drop stale manifest entries whose file is
 *  missing on disk. Exposed so a startup migration can reconcile an old
 *  `imported-workflows/` directory that pre-dates the manifest (round 3.5
 *  used `<random-uuid>.json` filenames without a manifest). */
export async function reconcileImportedWorkflows(): Promise<ImportedWorkflowLibraryEntry[]> {
  return withLibraryLock(async () => {
    const manifest = await readManifest()
    await writeManifest(manifest)
    return manifest.entries
  })
}