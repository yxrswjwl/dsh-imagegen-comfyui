/**
 * The infinite-canvas studio: a single-page surface that fills the panel
 * with the `CanvasWorkspace`. The legacy three-column "AI 生图" studio
 * (mode tabs, prompt composer, result canvas, generation history column,
 * gallery, ecommerce mode) was removed in Round 5: the panel now hosts
 * only the canvas, and the sidebar tab was renamed to "画布" to match.
 *
 * The panel keeps its props and `panel.module.css` skeleton so the shell
 * still treats this as the same surface (mount/unmount paths, settings
 * invalidation, language subscription). Workspace routing happens inside
 * `CanvasWorkspace`, which already understands projects, workflow nodes,
 * and connection lines — there is nothing left for this container to do
 * beyond passing the API surface and channel config through.
 */

import { useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ImageGenApi } from './api.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { CanvasWorkspace } from './CanvasWorkspace.tsx'
import { useImageGenLanguageTick } from './use-language.ts'
import { imageModelOptions } from './settings-scope.ts'
import { isComfyUiPreset } from '../protocol.ts'

/** Subscribe to the live scope snapshot — the same wiring the settings card uses. */
function useScopeSnapshot(scope: ImageGenScope): ImageGenConfig | null {
  return useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => {
      const snapshot = scope.getSnapshot()
      return snapshot.status === 'ready' ? (snapshot.value as ImageGenConfig | null) ?? null : null
    },
  )
}

/** Subscribe to the union "any secret set" flag — equivalent to the card's gate. */
function useAnySecretSet(scope: ImageGenScope): boolean {
  return useSyncExternalStore(
    listener => scope.subscribeKeySet(listener),
    () => scope.getKeySetSnapshot(),
  )
}

/** Render the studio. Round 5: the panel is just a canvas shell now — all
 *  generation, history, gallery, ecommerce UI has been moved out (the
 *  legacy store/route/IPC plumbing is still on the host but no client
 *  surface reads from it any more). */
export function ImageGenPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
  /** Host session API (round 6+). When present, canvas bubble nodes can
   *  embed a chat panel bound to the active DSH session. */
  sessions?: ISessions
}) {
  const { api, scope, sessions } = props
  // The plugin language follows the DSH interface (bridged from ctx.locale);
  // this tick re-renders the tree so every tt() switches live.
  useImageGenLanguageTick()
  const config = useScopeSnapshot(scope) ?? undefined
  const enabled = config?.enabled ?? true
  const modelOptions = imageModelOptions(config)
  const imageModels = modelOptions.models
  const defaultChannelId = modelOptions.defaultChannelId
  const apiUrl = defaultChannelId !== undefined && (config?.channels ?? []).length > 0
    ? (config!.channels!.find(channel => channel.id === defaultChannelId)?.apiUrl ?? '')
    : (config?.apiUrl ?? '')
  const configured = apiUrl.trim() !== ''
  const anySecretSet = useAnySecretSet(scope)
  const channelKeySet = (config?.channels ?? []).some(channel => scope.getSecretSetSnapshot(`channelSecrets.${channel.id}`))
  const defaultChannel = defaultChannelId !== undefined
    ? (config?.channels ?? []).find(channel => channel.id === defaultChannelId)
    : undefined
  const defaultKeyOptional = defaultChannel !== undefined && isComfyUiPreset(defaultChannel.preset ?? '')
  const apiKeySet = (config?.channels ?? []).length > 0
    ? (defaultKeyOptional ? true : channelKeySet)
    : anySecretSet
  const connected = enabled && configured && apiKeySet

  return <CanvasWorkspace
    api={api}
    imageModels={imageModels}
    defaultChannelId={defaultChannelId}
    channels={config?.channels ?? []}
    connected={connected}
    sessions={sessions}
  />
}
