/**
 * Thin adapter from the host `ISessions` surface to a self-contained React
 * snapshot for one bubble node. Round 8 reduced the bubble to a doorway:
 * it only needs to know the bound session id (or the host's current one),
 * whether the binding is following the host's current session, and the
 * resolved title (so the bubble header shows something useful). Every
 * other chat concern — markdown, attachments, reasoning, sending — is
 * delegated to DSH's native conversation panel via `sessions.open`.
 *
 * Contract:
 *   - `ISessions.list.getSnapshot()` carries `{current, byId}` so the hook
 *     can fall back to `byId[id].displayTitle` when the title projection
 *     has not seeded yet.
 *   - `face.projections.faceOf('title')` holds the title projection once
 *     the binding has materialized; we read it through `useSyncExternalStore`
 *     so the bubble re-renders when the host updates the title.
 *   - The host session API is optional: when missing the hook returns
 *     "no session, no title" so consumers render the unavailable hint.
 */

import { useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** Minimal snapshot for one bubble node's doorway panel. */
export interface BubbleSession {
  /** The session id the bubble is actually bound to (resolved after the
   *  "follow current" fallback). */
  sessionId: string | undefined
  /** True when this bubble is following the host's currently-open session
   *  (no explicit `sessionId` bound). Drives the header chip copy. */
  following: boolean
  /** Host-reported title for the bound session (projection → list fallback). */
  title: string
}

/** Subscribe to one `ObservableSnapshot<T>`, picking the latest value with
 *  React's standard hook so the host's stable identity holds across
 *  re-renders. When the source is undefined the hook returns the supplied
 *  fallback so consumers can render an empty UI without throwing. */
function useSnapshot<T>(snapshot: { getSnapshot(): T; subscribe(listener: () => void): () => void } | undefined, fallback: T): T {
  return useSyncExternalStore(
    listener => snapshot?.subscribe(listener) ?? ((): void => {}),
    () => snapshot?.getSnapshot() ?? fallback,
  )
}

/** Read one projection value as a plain string, or fall back to the
 *  default when the projection has not seeded yet. Projections are
 *  `unknown`, so we coerce defensively. */
function projectionAsString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (value !== null && typeof value === 'object') {
    const candidate = (value as { title?: unknown }).title
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Resolve the bubble's bound session id and title without paying for any
 *  of the heavy per-message subscriptions the embedded chat surface needed.
 *  Returns a `disabled` snapshot when the host has no sessions service. */
export function useBubbleSession(sessions: ISessions | undefined, requestedId: string | undefined): BubbleSession {
  const list = useSnapshot(sessions?.list, EMPTY_LIST_STATE)
  const resolvedId = requestedId ?? list.current
  const following = requestedId === undefined

  const face = resolvedId !== undefined
    ? sessions?.binding(resolvedId as unknown as Parameters<NonNullable<typeof sessions>['binding']>[0])?.session
    : undefined

  const titleProjection = useSyncExternalStore(
    listener => face?.projections.faceOf('title').subscribe(listener) ?? ((): void => {}),
    () => face?.projections.faceOf('title').getSnapshot(),
  )

  const fallbackTitle = resolvedId !== undefined
    ? (list.byId as Record<string, { displayTitle: string } | undefined>)[resolvedId]?.displayTitle ?? resolvedId
    : ''
  const title = projectionAsString(titleProjection) ?? fallbackTitle ?? ''

  return { sessionId: resolvedId, following, title }
}

/* ------------------------------------------------------------------ */
/*                          snapshot fallbacks                          */
/* ------------------------------------------------------------------ */

const EMPTY_LIST_STATE = Object.freeze({
  ids: [],
  byId: {},
  current: undefined,
  phase: 'cold' as never,
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
})