/**
 * Bubble node: a small canvas-side panel that anchors a DSH chat session.
 *
 * Round 8 dropped the in-bubble message surface (markdown / image / reasoning
 * were rendered by the node itself and pulled heavy third-party deps).
 * The bubble is now a "doorway": it carries a session id, exposes its title,
 * and lets the user pop the bound session into DSH's native conversation
 * panel — which already does markdown, reasoning, and image rendering the
 * product way. The canvas stays untouched when the user wants to talk to
 * DSH, because the native panel takes over the center column.
 *
 * Two views:
 *   - collapsed: a tiny header strip (icon + title + "open in DSH" button)
 *   - expanded: the same strip plus a short hint list (current session id,
 *     follow-current toggle, an inline "open in DSH" button) so the user can
 *     see which session the node is anchored to without leaving the canvas.
 *
 * No message rendering, no markdown, no image bytes: those are entirely
 * delegated to DSH's native panel. The bubble only talks to the host
 * session API for `list` (current id + byId titles), `binding(id)?.session`
 * (so it can read the title projection), `create()` and `open()`.
 */

import { useCallback } from 'react'
import { ExternalLink, MessageSquare } from 'lucide-react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CanvasBubbleNodeMeta, CanvasNode } from '../protocol.ts'
import { tt } from './helpers.ts'
import { useBubbleSession } from './sessions-controller.ts'
import css from './canvas-workspace.module.css'

/** Mirror of the canvas-local patcher so a bubble node can write back into
 *  its own metadata without having to thread `patchNode` through props. */
interface BubblePatch {
  (updater: (meta: CanvasBubbleNodeMeta) => CanvasBubbleNodeMeta): void
}

/** Open one DSH session through the host service. Creates a fresh session
 *  if the bubble has no binding yet, then hands the center column over to
 *  DSH's native conversation panel via `sessions.open`. */
async function openInDshSession(sessions: ISessions | undefined, sessionId: string | undefined): Promise<string | null> {
  if (sessions === undefined) return null
  const created = await sessions.create()
  const target = (sessionId ?? created) as unknown as Parameters<typeof sessions.open>[0]
  sessions.open(target)
  return target as unknown as string
}

/** Standalone bubble body wrapper used by the canvas workspace. The node
 *  itself owns the collapsed/expanded toggle and the "open in DSH" action;
 *  the canvas only ever imports this single entry point. */
export function BubbleBodyArea(props: {
  node: CanvasNode
  sessions: ISessions | undefined
  patchBubble: (updater: (meta: CanvasBubbleNodeMeta) => CanvasBubbleNodeMeta) => void
  onToggle: () => void
}): React.JSX.Element {
  const { node, sessions, patchBubble, onToggle } = props
  const meta = node.metadata?.bubble ?? { collapsed: false }
  const controller = useBubbleSession(sessions, meta.sessionId)
  const open = useCallback(async (): Promise<void> => {
    const next = await openInDshSession(sessions, controller.sessionId)
    if (next !== null) {
      // Bind the bubble to the id we just opened so a future re-open lands
      // on the same session (the bubble stops following the host's current).
      patchBubble(previous => ({ ...previous, sessionId: next }))
    }
  }, [sessions, controller.sessionId, patchBubble])

  const bindFollowCurrent = useCallback((): void => {
    patchBubble(previous => ({ ...previous, sessionId: undefined }))
  }, [patchBubble])

  const subtitle = controller.following
    ? tt('canvas.bubble.following')
    : (controller.title || controller.sessionId || tt('canvas.bubble.follow'))

  if (meta.collapsed) {
    return <div
      className={css.bubbleCollapsed}
      role="button"
      tabIndex={0}
      onDoubleClick={event => { event.stopPropagation(); onToggle() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}
    >
      <span className={css.bubbleCollapsedIcon} aria-hidden="true"><MessageSquare size={14} /></span>
      <div className={css.bubbleCollapsedBody}>
        <span className={css.bubbleCollapsedTitle}>{controller.title || tt('canvas.bubbleNode')}</span>
        <span className={css.bubbleCollapsedSubtitle}>{subtitle}</span>
      </div>
      <button
        type="button"
        className={css.bubbleCollapsedOpen}
        title={tt('canvas.bubble.open')}
        aria-label={tt('canvas.bubble.open')}
        onClick={event => { event.stopPropagation(); void open() }}
      >
        <ExternalLink size={12} aria-hidden="true" />
      </button>
      {sessions === undefined
        ? <span className={css.bubbleCollapsedSubtitle} aria-hidden="true">{tt('canvas.bubble.unavailable')}</span>
        : null}
    </div>
  }

  return <div className={css.bubbleBody} data-bubble-node={node.id}>
    <header className={css.bubbleHeader}>
      <div className={css.bubbleHeaderMain}>
        <span className={css.bubbleCollapsedIcon} aria-hidden="true"><MessageSquare size={13} /></span>
        <div className={css.bubbleCollapsedBody}>
          <span className={css.bubbleCollapsedTitle}>{controller.title || tt('canvas.bubbleNode')}</span>
          <span className={css.bubbleCollapsedSubtitle}>{subtitle}</span>
        </div>
      </div>
      <div className={css.bubbleHeaderActions}>
        <button
          type="button"
          className={css.bubblePrimaryButton}
          title={tt('canvas.bubble.open')}
          aria-label={tt('canvas.bubble.open')}
          disabled={sessions === undefined}
          onClick={() => void open()}
        >
          <ExternalLink size={12} aria-hidden="true" />{tt('canvas.bubble.open')}
        </button>
        <button
          type="button"
          className={css.bubbleIconButton}
          title={tt('canvas.bubble.collapse')}
          aria-label={tt('canvas.bubble.collapse')}
          onClick={onToggle}
        >
          <span aria-hidden="true">−</span>
        </button>
      </div>
    </header>
    <div className={css.bubbleHint}>
      <span>{tt('canvas.bubble.intro')}</span>
    </div>
    <div className={css.bubbleHintActions}>
      {controller.following
        ? <span className={css.bubbleChip} data-tone="follow">{tt('canvas.bubble.following')}</span>
        : <button type="button" className={css.bubbleGhostButton} onClick={bindFollowCurrent}>{tt('canvas.bubble.follow')}</button>}
    </div>
  </div>
}