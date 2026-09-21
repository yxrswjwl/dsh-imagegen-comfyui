/**
 * Localized labels for ComfyUI widget names on canvas workflow nodes.
 *
 * The inspector returns the raw ComfyUI input names (`seed`, `steps`,
 * `cfg`, `sampler_name`, `width` …) in `options[].inputName`. The canvas
 * renders a Chinese translation when the DSH interface language is
 * Chinese and falls back to the raw name otherwise — there is no
 * convention for translating widget ids into en/ru, and English ids are
 * already the shared vocabulary across ComfyUI installations.
 *
 * This is a client-side, per-option overlay: the workflow JSON and the
 * override keys always keep the raw input name, so the mapping is purely
 * a display concern and can never corrupt the submitted workflow.
 */

import { activeImageGenLanguage } from './helpers.ts'

/** 参数名 → 中文（仅 zh 生效）。 */
const ZH_WIDGET_LABELS: Record<string, string> = {
  // KSampler / sampler family
  seed: '种子',
  noise_seed: '噪声种子',
  steps: '步数',
  cfg: 'CFG 强度',
  sampler_name: '采样器',
  scheduler: '调度器',
  denoise: '重绘幅度',
  control_after_generate: '生成后控制',
  // Latent / output size
  batch_size: '批次数',
  width: '宽度',
  height: '高度',
  // Model loaders
  model: '模型',
  unet_name: 'UNET 模型',
  clip_name: 'CLIP 模型',
  vae_name: 'VAE 模型',
  ckpt_name: '检查点',
  lora_name: 'LoRA 模型',
  strength_model: '模型强度',
  strength_clip: 'CLIP 强度',
  // Prompt inputs
  text: '文本',
  positive: '正向提示词',
  negative: '负向提示词',
  empty_prompt_image: '空白图像',
  // Common advanced fields
  shift: '采样偏移',
  clip_skip: 'CLIP 跳过层',
  start_percent: '起始百分比',
  end_percent: '结束百分比',
  strength: '强度',
  guide: '引导强度',
  scale: '缩放',
  offset: '偏移',
  image: '图片',
  images: '图片',
  aspect_ratio: '宽高比',
  megapixels: '兆像素',
  quality: '质量',
  preview_method: '预览方式',
  highres_scale: '高清倍率',
  highres_denoise: '高清重绘幅度',
  first_pass_steps: '首轮步数',
  second_pass_steps: '次轮步数',
  refiner_switch: '精修切换',
  refine: '精修',
  gamma: '伽马',
}

/** Render a friendly label for a widget input name in the current
 *  language. Unknown names pass through unchanged. */
export function localizeWidgetName(name: string): string {
  if (activeImageGenLanguage() !== 'zh') return name
  const localized = ZH_WIDGET_LABELS[name]
  return localized === undefined ? name : localized
}
