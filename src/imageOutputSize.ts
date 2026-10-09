import type { ImageApiConfig, ImageVariant } from './types';
import { IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE, imageResolutionAspectRatio, resolveImageResolution, type ImageResolutionPlan } from './imageResolution';

export type ImageOutputSizeMode = 'default' | '1x' | '2x' | '1k' | '2k' | '4k' | 'custom';
export type ImageOutputAspect = 'variant' | '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '3:2' | '2:3';
export interface ImageOutputSizePreference {
  mode: ImageOutputSizeMode;
  aspect: ImageOutputAspect;
  width: number;
  height: number;
  resolutionVersion?: 1;
}
export interface ImageOutputSizePreferences {
  ordinary: ImageOutputSizePreference;
  private: ImageOutputSizePreference;
}
export const IMAGE_OUTPUT_MAX_SIDE = IMAGE_RESOLUTION_TECHNICAL_MAX_SIDE;
export const IMAGE_OUTPUT_ASPECTS: ReadonlyArray<{ value: ImageOutputAspect; label: string; width: number; height: number }> = [
  { value: 'variant', label: '跟随画面规格', width: 1024, height: 1024 },
  { value: '1:1', label: '1:1 方形', width: 1024, height: 1024 },
  { value: '3:4', label: '3:4 竖图', width: 768, height: 1024 },
  { value: '4:3', label: '4:3 横图', width: 1024, height: 768 },
  { value: '9:16', label: '9:16 竖屏', width: 576, height: 1024 },
  { value: '16:9', label: '16:9 横屏', width: 1024, height: 576 },
  { value: '3:2', label: '3:2 横图', width: 1536, height: 1024 },
  { value: '2:3', label: '2:3 竖图', width: 1024, height: 1536 },
];
export const defaultImageOutputSize = (): ImageOutputSizePreference => ({ mode: '1k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 });
const legacyImageOutputSize = (): ImageOutputSizePreference => ({ mode: 'default', aspect: 'variant', width: 1024, height: 1024 });

/** Loading repairs only invalid preferences. Valid independent lane choices survive. */
export const normalizeImageOutputSizes = (value: unknown): ImageOutputSizePreferences => {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalize = (input: unknown): ImageOutputSizePreference => {
    const initial = legacyImageOutputSize();
    if (!input || typeof input !== 'object' || Array.isArray(input)) return initial;
    const candidate = input as Record<string, unknown>;
    const custom = candidate.mode === 'custom';
    const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : custom ? 0 : 1024;
    return {
      mode: ['default', '1x', '2x', '1k', '2k', '4k', 'custom'].includes(String(candidate.mode)) ? candidate.mode as ImageOutputSizeMode : initial.mode,
      aspect: IMAGE_OUTPUT_ASPECTS.some((item) => item.value === candidate.aspect) ? candidate.aspect as ImageOutputAspect : initial.aspect,
      width: dimension(candidate.width), height: dimension(candidate.height),
      ...(candidate.resolutionVersion === 1 ? { resolutionVersion: 1 as const } : {}),
    };
  };
  return { ordinary: normalize(object.ordinary), private: normalize(object.private) };
};

export const imageOutputAspectLocked = (variant: ImageVariant): boolean => (
  ['grid', 'five-view', 'turnaround', 'private-full-body', 'private-five-view', 'private-turnaround', 'private-four-in-one'].includes(variant)
);

export const normalizePrivateFullBodyOutputSize = (
  width: number,
  height: number,
): { width: number; height: number } => {
  if (Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width >= 64 && height >= 64 && width <= IMAGE_OUTPUT_MAX_SIDE && height <= IMAGE_OUTPUT_MAX_SIDE) {
    return { width, height };
  }
  const shortSide = Number.isSafeInteger(width) && Number.isSafeInteger(height)
    ? Math.max(64, Math.min(width, height))
    : 1024;
  const unit = Math.max(32, Math.min(Math.floor(shortSide / 2), Math.floor(IMAGE_OUTPUT_MAX_SIDE / 3)));
  return { width: unit * 2, height: unit * 3 };
};
export interface ResolvedImageOutputSize {
  width: number;
  height: number;
  sizeOverride: boolean;
  issue: string;
  warning?: string;
  layoutNote: string;
  resolutionPlan?: ImageResolutionPlan;
}

/** One computation supplies the task and request. Never silently round,
 * clamp, reduce resolution or resize the returned image. */
export const resolveImageOutputSize = (
  preference: ImageOutputSizePreference,
  canvas: { width: number; height: number },
  api: ImageApiConfig['backend'] | ImageApiConfig,
  variant: ImageVariant,
): ResolvedImageOutputSize => {
  const locked = imageOutputAspectLocked(variant);
  const backend = typeof api === 'string' ? api : api.backend;
  const sizeOverride = preference.mode !== 'default';
  const aspect = IMAGE_OUTPUT_ASPECTS.find((item) => item.value === preference.aspect);
  const base = !sizeOverride || !aspect || aspect.value === 'variant' ? canvas : aspect;
  if (['1k', '2k', '4k'].includes(preference.mode) || preference.mode === 'custom' && preference.resolutionVersion === 1) {
    const custom = preference.mode === 'custom';
    const logicalAspectRatio = !custom ? imageResolutionAspectRatio(base.width, base.height)
      : imageResolutionAspectRatio(preference.width, preference.height) || imageResolutionAspectRatio(base.width, base.height);
    const resolved = resolveImageResolution({
      tier: custom ? 'custom' : preference.mode.toUpperCase() as '1K' | '2K' | '4K',
      logicalAspectRatio, width: preference.width, height: preference.height, exactAspect: locked && !custom, config: api,
    });
    const layout = locked ? variant === 'grid' ? '九宫格推荐1:1' : variant === 'private-full-body' ? '私密全身推荐2:3竖图' : '多视图推荐3:2' : '';
    const actualAspect = resolved.resolutionPlan?.logicalAspectRatio || imageResolutionAspectRatio(resolved.width, resolved.height);
    const recommendedAspect = imageResolutionAspectRatio(canvas.width, canvas.height);
    const differs = locked && actualAspect !== recommendedAspect;
    const warning = [resolved.warning, differs ? `${layout}；本次按${actualAspect}及实际像素提交，请按实际画布组织布局。` : ''].filter(Boolean).join(' ');
    return { ...resolved, ...(warning ? { warning } : {}), ...(resolved.resolutionPlan && warning ? { resolutionPlan: { ...resolved.resolutionPlan, verified: false } } : {}),
      sizeOverride: true, layoutNote: [layout, resolved.layoutNote].filter(Boolean).join(' · ') };
  }
  const scale = preference.mode === '2x' ? 2 : 1;
  const width = preference.mode === 'custom' ? preference.width : base.width * scale;
  const height = preference.mode === 'custom' ? preference.height : base.height * scale;
  let issue = '';
  const warnings: string[] = [];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > IMAGE_OUTPUT_MAX_SIDE || height > IMAGE_OUTPUT_MAX_SIDE) {
    issue = `宽、高须为64–${IMAGE_OUTPUT_MAX_SIDE}之间的整数像素；不会自动降档。`;
  } else {
    if (locked && width * canvas.height !== height * canvas.width) {
    warnings.push(variant === 'grid'
      ? '九宫格母版推荐1:1；本次按自定义像素提交，请按实际画布组织网格。'
      : variant === 'private-full-body'
        ? '私密全身单主体推荐2:3竖图；本次按自定义像素提交，请保持完整主体构图。'
        : '当前多视图版式推荐3:2；本次按自定义像素提交，请按实际画布组织布局。');
    }
    if (sizeOverride && backend === 'novelai' && (width % 64 || height % 64)) {
      warnings.push('NovelAI宽、高建议为64的倍数；本次按输入原样提交，由后端决定是否支持。');
    } else if (sizeOverride && backend === 'sd_webui' && (width % 8 || height % 8)) {
      warnings.push('SD WebUI宽、高建议为8的倍数；本次按输入原样提交，由后端决定是否支持。');
    }
  }
  return { width, height, sizeOverride, issue, ...(warnings.length ? { warning: warnings.join(' ') } : {}), layoutNote: locked
    ? variant === 'grid' ? '九宫格推荐1:1' : variant === 'private-full-body' ? '私密全身推荐2:3竖图' : '多视图推荐3:2'
    : '' };
};

export const imageReturnedSizeWarning = (requested: { width: number; height: number; resolutionPlan?: ImageResolutionPlan }, actual: { width: number; height: number } | undefined): string => {
  if (!actual || requested.width === actual.width && requested.height === actual.height) return '';
  const plan = requested.resolutionPlan;
  if (plan?.encoding.kind === 'tier') {
    if (plan.profile === 'grok-k') {
      return `本次按${plan.encoding.value}原生档位和${plan.logicalAspectRatio}画幅提交，此前${requested.width}×${requested.height}为档位估算；后端实际返回${actual.width}×${actual.height}，实际像素以返回图片为准，原图已保留。`;
    }
    return `后端实际返回${actual.width}×${actual.height}，与${plan.encoding.value}原生预期${plan.expected.width}×${plan.expected.height}不同；原图已保留，实际像素以返回图片为准。请确认当前模型与通道的原生分辨率支持。`;
  }
  return `后端实际返回${actual.width}×${actual.height}，与请求${requested.width}×${requested.height}不同；原图已保留，未本地放大或伪报像素。请确认模型或工作流的尺寸支持。`;
};
