import { resolveImageOutputSize, type ResolvedImageOutputSize } from './imageOutputSize';
import type { ImageApiConfig } from './types';
import { resolveImageResolution } from './imageResolution';

export type StoryboardImageOutputSizeMode = 'default' | '1k' | '2k' | '4k' | 'custom';

/** Shared only by storyboard stills, including opening/ending frames. */
export interface StoryboardImageOutputSizePreference {
  mode: StoryboardImageOutputSizeMode;
  width: number;
  height: number;
  resolutionVersion?: 1;
}

const MODES: readonly StoryboardImageOutputSizeMode[] = ['default', '1k', '2k', '4k', 'custom'];
const PRESET_MODES = ['1k', '2k', '4k'] as const;

export const defaultStoryboardImageOutputSize = (): StoryboardImageOutputSizePreference => ({
  mode: '1k', width: 1024, height: 1024, resolutionVersion: 1,
});
const legacyStoryboardImageOutputSize = (): StoryboardImageOutputSizePreference => ({ mode: 'default', width: 1024, height: 1024 });

/** Missing old settings keep the previous default. A malformed explicit custom
 * dimension remains visibly invalid instead of silently becoming 1024 px. */
export const normalizeStoryboardImageOutputSize = (input: unknown): StoryboardImageOutputSizePreference => {
  const initial = legacyStoryboardImageOutputSize();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return initial;
  const candidate = input as Record<string, unknown>;
  const mode = MODES.includes(candidate.mode as StoryboardImageOutputSizeMode)
    ? candidate.mode as StoryboardImageOutputSizeMode : initial.mode;
  const dimension = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return mode === 'custom' ? 0 : 1024;
  };
  return { mode, width: dimension(candidate.width), height: dimension(candidate.height),
    ...(candidate.resolutionVersion === 1 ? { resolutionVersion: 1 as const } : {}) };
};

interface AspectRatio { width: number; height: number; ratio: number; label: string }

const parseAspectRatio = (value: string): AspectRatio | undefined => {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/u);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  if (!Number.isFinite(ratio) || width <= 0 || height <= 0) return undefined;
  return { width, height, ratio, label: `${width}:${height}` };
};

/** This is intentionally the legacy orientation canvas, not a new preset. */
const defaultCanvas = (aspectRatio: string): { width: number; height: number } => {
  const match = String(aspectRatio || '').match(/(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)/u);
  const ratio = match ? Number(match[1]) / Number(match[2]) : 16 / 9;
  if (ratio < 0.9) return { width: 1024, height: 1536 };
  if (ratio <= 1.1) return { width: 1024, height: 1024 };
  return { width: 1536, height: 1024 };
};

const customAspectLabel = (width: number, height: number): string => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return '';
  let divisor = width;
  let remainder = height;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  return `${width / divisor}:${height / divisor}`;
};

/** The displayed size and submitted request share one result. Versioned presets
 * use model-native sizes or a declared pixel mapping; old presets keep their
 * original long-edge semantics. Custom pixels are never resized or reduced. */
export const resolveStoryboardImageOutputSize = (
  preference: StoryboardImageOutputSizePreference,
  aspectRatio: string,
  api: ImageApiConfig['backend'] | ImageApiConfig,
): ResolvedImageOutputSize => {
  const canvas = defaultCanvas(aspectRatio);
  const aspect = parseAspectRatio(aspectRatio);
  if (preference.mode === 'default') {
    return { ...canvas, sizeOverride: false, issue: '', layoutNote: '规格默认 · 保留原分镜画布' };
  }

  if (preference.mode === 'custom') {
    const resolved = resolveImageOutputSize(
      { mode: 'custom', aspect: 'variant', width: preference.width, height: preference.height, resolutionVersion: preference.resolutionVersion },
      canvas, api, 'reference',
    );
    const label = customAspectLabel(resolved.width, resolved.height);
    const nativeAspect = resolved.resolutionPlan?.logicalAspectRatio;
    const nominalMatches = aspect && nativeAspect && Math.abs(Number(nativeAspect.split(':')[0]) / Number(nativeAspect.split(':')[1]) - aspect.ratio) < 1e-8;
    const differs = aspect && !nominalMatches && Math.abs(resolved.width * aspect.height - resolved.height * aspect.width) > 1e-8;
    return { ...resolved, ...(differs ? { warning: [resolved.warning, `自定义画幅与分镜推荐比例${aspect!.label}不同；按实际像素提交。`].filter(Boolean).join(' ') } : {}), layoutNote: label
      ? `自定义比例 ${label}${nativeAspect && nativeAspect !== label ? ` · 原生${nativeAspect}画幅` : ''}${differs ? ` · 与分镜比例 ${aspect.label} 不同，按自定义像素提交` : ''}`
      : '自定义宽高按输入原样提交，不自动降档' };
  }

  if (!(PRESET_MODES as readonly string[]).includes(preference.mode)) {
    return { width: preference.width, height: preference.height, sizeOverride: true,
      issue: '分镜图分辨率规格无效，请重新选择；不会自动改用默认尺寸。', layoutNote: '' };
  }
  if (!aspect) {
    return { width: 0, height: 0, sizeOverride: true,
      issue: '分镜画面比例无效，无法计算所选分辨率；请设置有效比例，例如16:9，不会自动降档。', layoutNote: '' };
  }
  if (preference.resolutionVersion !== 1) {
    const backend = typeof api === 'string' ? api : api.backend;
    const longSide = preference.mode === '4k' ? 4096 : preference.mode === '2k' ? 2048 : 1024;
    const step = backend === 'novelai' ? 64 : backend === 'sd_webui' ? 8 : 1;
    const shortSide = Math.ceil((longSide / Math.max(aspect.ratio, 1 / aspect.ratio) - 1e-8) / step) * step;
    const width = aspect.ratio >= 1 ? longSide : shortSide; const height = aspect.ratio >= 1 ? shortSide : longSide;
    const resolved = resolveImageOutputSize({ mode: 'custom', aspect: 'variant', width, height }, canvas, api, 'reference');
    return { ...resolved, sizeOverride: true, layoutNote: `旧规格 · 保留长边${longSide}px及原像素对齐；重新选择K档位后使用当前模型规格` };
  }
  const resolved = resolveImageResolution({ tier: preference.mode.toUpperCase() as '1K' | '2K' | '4K', logicalAspectRatio: aspect.label, config: api });
  return { ...resolved, sizeOverride: true, layoutNote: `按分镜 ${aspect.label} · ${resolved.layoutNote}`,
    issue: resolved.height < 64 || resolved.width < 64
      ? '按分镜比例计算的短边不足64像素，请提高分辨率或使用自定义尺寸；不会暗中更改画面比例。'
      : resolved.issue };
};
