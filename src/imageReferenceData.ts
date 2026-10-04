import { normalizeGeneratedImageData, type GeneratedImageMime } from './generatedImageData';

const MAX_REFERENCE_IMAGE_BYTES = 32 * 1024 * 1024;

/** File names and MIME labels are metadata, not proof of the encoded format.
 * Normalize only the data URL envelope; keep the reference pixels untouched. */
export const normalizeReferenceImageDataUrl = (value: string): string => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:[^,]*;base64,([\s\S]+)$/iu);
  if (!match) throw new Error('参考图片需要有效的 PNG、JPEG 或 WebP Base64 data URL。');
  const compact = match[1].replace(/\s+/gu, '');
  const content = compact.replace(/=+$/u, '');
  if (Math.floor(content.length * 3 / 4) > MAX_REFERENCE_IMAGE_BYTES) throw new Error('参考图片超过 32 MB 上限。');
  try {
    return normalizeGeneratedImageData(raw);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : '图片格式无效。').replace(/生成图片/gu, '参考图片'));
  }
};

/** Read the canonical label returned by the normalizer or canvas encoder. */
export const referenceImageMimeType = (dataUrl: string): GeneratedImageMime | undefined => (
  dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/iu)?.[1].toLowerCase() as GeneratedImageMime | undefined
);

export const referenceImageFileName = (fileName: string, dataUrl: string): string => {
  const mime = referenceImageMimeType(dataUrl);
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const stem = fileName.replace(/\.[^.\\/]*$/u, '') || 'reference';
  return `${stem}.${extension}`;
};
