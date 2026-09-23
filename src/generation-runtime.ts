/**
 * Host-side generation runtime. Single entry point used by the canvas
 * workflow route; the legacy history persistence and task queue were removed
 * with the panel/ecommerce surfaces, so the runtime now just routes one
 * request through the engine after picking the right channel's credentials.
 *
 * Requests carry a channel id (host-filled by the route resolution); the
 * runtime picks that channel's upstream credentials, otherwise the default
 * channel.
 */

import { generateImage, ImageGenError, type UpstreamConfig } from './engine.ts'
import type { ChannelConfig, GenerateRequest, GenerateResult } from './protocol.ts'

/** A channel with its resolved API key (the settings doc holds the key
 *  separately so redacted reads never expose it). */
export interface RuntimeChannel extends ChannelConfig {
  apiKey: string
}

/** The resolved channels view the runtime picks upstream credentials from. */
export interface ChannelsView {
  channels: RuntimeChannel[]
  defaultChannelId: string
}

export class ImageGenerationRuntime {
  constructor(private readonly resolve: () => ChannelsView) {}

  async run(request: GenerateRequest, signal?: AbortSignal, onComfyPrompt?: (promptId: string) => void): Promise<GenerateResult> {
    const view = this.resolve()
    const channel = view.channels.find(candidate => candidate.id === request.channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
    if (channel === undefined) {
      throw new ImageGenError('尚未配置任何渠道：请先在「设置 → 插件 → AI 生图」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    const upstream: UpstreamConfig = {
      apiUrl: channel.apiUrl,
      apiKey: channel.apiKey,
      ...channel.installDir === undefined ? {} : { installDir: channel.installDir },
    }
    return await generateImage(upstream, request, { signal, ...onComfyPrompt === undefined ? {} : { onComfyPrompt } })
  }
}