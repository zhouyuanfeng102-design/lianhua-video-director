import type { ImageApiConfig, ImageVariant } from './types';

export type ImageOutputSizeMode = 'default' | '1x' | '2x' | 'custom';
export type ImageOutputAspect = 'variant' | '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '3:2' | '2:3';
export interface ImageOutputSizePreference {
  mode: ImageOutputSizeMode;
  aspect: ImageOutputAspect;
  width: number;
  height: number;
}
export interface ImageOutputSizePreferences {
  ordinary: ImageOutputSizePreference;
  private: ImageOutputSizePreference;
}
export const IMAGE_OUTPUT_MAX_SIDE = 4096;
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
export const defaultImageOutputSize = (): ImageOutputSizePreference => ({ mode: 'default', aspect: 'variant', width: 1024, height: 1024 });

/** Loading repairs only invalid preferences. Valid independent lane choices survive. */
export const normalizeImageOutputSizes = (value: unknown): ImageOutputSizePreferences => {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalize = (input: unknown): ImageOutputSizePreference => {
    const initial = defaultImageOutputSize();
    if (!input || typeof input !== 'object' || Array.isArray(input)) return initial;
    const candidate = input as Record<string, unknown>;
    const dimension = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 64 && value <= IMAGE_OUTPUT_MAX_SIDE ? value : 1024;
    return {
      mode: ['default', '1x', '2x', 'custom'].includes(String(candidate.mode)) ? candidate.mode as ImageOutputSizeMode : initial.mode,
      aspect: IMAGE_OUTPUT_ASPECTS.some((item) => item.value === candidate.aspect) ? candidate.aspect as ImageOutputAspect : initial.aspect,
      width: dimension(candidate.width), height: dimension(candidate.height),
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
    && width >= 64 && height >= 64 && width <= IMAGE_OUTPUT_MAX_SIDE && height <= IMAGE_OUTPUT_MAX_SIDE
    && width * 3 === height * 2) {
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
  layoutNote: string;
}

/** One computation supplies the task and request. Never silently round,
 * clamp, reduce resolution or resize the returned image. */
export const resolveImageOutputSize = (
  preference: ImageOutputSizePreference,
  canvas: { width: number; height: number },
  backend: ImageApiConfig['backend'],
  variant: ImageVariant,
): ResolvedImageOutputSize => {
  const locked = imageOutputAspectLocked(variant);
  const sizeOverride = preference.mode !== 'default';
  const aspect = IMAGE_OUTPUT_ASPECTS.find((item) => item.value === preference.aspect);
  const base = !sizeOverride || locked || !aspect || aspect.value === 'variant' ? canvas : aspect;
  const scale = preference.mode === '2x' ? 2 : 1;
  const width = preference.mode === 'custom' ? preference.width : base.width * scale;
  const height = preference.mode === 'custom' ? preference.height : base.height * scale;
  let issue = '';
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > IMAGE_OUTPUT_MAX_SIDE || height > IMAGE_OUTPUT_MAX_SIDE) {
    issue = `宽、高须为64–${IMAGE_OUTPUT_MAX_SIDE}之间的整数像素；不会自动降档。`;
  } else if (locked && width * canvas.height !== height * canvas.width) {
    issue = variant === 'grid'
      ? '九宫格母版须保持1:1，可增加像素但不能改变网格比例。'
      : variant === 'private-full-body'
        ? '私密全身单主体须保持2:3竖图，可增加像素但不能改成横向画布。'
        : '当前多视图版式须保持3:2，可增加像素但不能改变布局比例。';
  } else if (sizeOverride && backend === 'novelai' && (width % 64 || height % 64)) {
    issue = 'NovelAI宽、高需为64的倍数，请调整自定义像素。';
  } else if (sizeOverride && backend === 'sd_webui' && (width % 8 || height % 8)) {
    issue = 'SD WebUI宽、高需为8的倍数，请调整自定义像素。';
  }
  return { width, height, sizeOverride, issue, layoutNote: locked
    ? variant === 'grid' ? '九宫格固定1:1' : variant === 'private-full-body' ? '私密全身固定2:3竖图' : '多视图固定3:2'
    : '' };
};

export const imageReturnedSizeWarning = (requested: { width: number; height: number }, actual: { width: number; height: number } | undefined): string => {
  if (!actual || requested.width === actual.width && requested.height === actual.height) return '';
  return `后端实际返回${actual.width}×${actual.height}，与请求${requested.width}×${requested.height}不同；原图已保留，未本地放大或伪报像素。请确认模型或工作流的尺寸支持。`;
};
