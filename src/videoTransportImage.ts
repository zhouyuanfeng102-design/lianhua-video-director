import type { ReferenceAsset } from './types';
import type { VideoImageReference, VideoTransportImage } from './videoGenerationTypes';
import { normalizeGeneratedImageData } from './generatedImageData';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const checksum = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/^[\\/]|[:\u0000-\u001f]/u.test(value) && value.replace(/\\/gu, '/').split('/').every((part) => part && part !== '.' && part !== '..');
export const VIDEO_TRANSPORT_IMAGE_INVALID = '视频参考图压缩副本记录无效或文件已变化；请恢复原图或重新轻压缩，不会悄悄改传原图。';

/** New optional metadata never changes how legacy image references are read. */
export const normalizeVideoTransportImage = (value: unknown): VideoTransportImage | undefined => {
  if (!record(value) || value.version !== 1 || !checksum(value.checksum) || !checksum(value.sourceChecksum)
    || !['originalSizeBytes', 'sizeBytes', 'originalWidth', 'originalHeight', 'width', 'height'].every((key) => positiveInteger(value[key]))
    || Number(value.sizeBytes) >= Number(value.originalSizeBytes)
    || value.width !== value.originalWidth || value.height !== value.originalHeight
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mimeType))
    || typeof value.quality !== 'number' || !Number.isFinite(value.quality) || value.quality <= 0 || value.quality > 1
    || value.relativePath !== undefined && !path(value.relativePath)
    || value.dataUrl !== undefined && (typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith(`data:${value.mimeType};base64,`))
    || !value.relativePath && !value.dataUrl
    || value.fileName !== undefined && (typeof value.fileName !== 'string' || !value.fileName || value.fileName.length > 200 || /[\\/\u0000-\u001f]/u.test(value.fileName))
    || value.url !== undefined && (typeof value.url !== 'string' || value.url.length > 8192)) return undefined;
  return {
    version: 1, checksum: value.checksum.toLowerCase(), sourceChecksum: value.sourceChecksum.toLowerCase(),
    originalSizeBytes: value.originalSizeBytes as number, sizeBytes: value.sizeBytes as number,
    originalWidth: value.originalWidth as number, originalHeight: value.originalHeight as number,
    width: value.width as number, height: value.height as number, mimeType: value.mimeType as VideoTransportImage['mimeType'], quality: value.quality,
    ...(typeof value.relativePath === 'string' ? { relativePath: value.relativePath.replace(/\\/gu, '/') } : {}),
    ...(typeof value.dataUrl === 'string' ? { dataUrl: value.dataUrl } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
  };
};

/** Resolve only the sent pixels. Keep asset ID and entity ownership from the original. */
export const videoTransportReferenceAsset = (reference: VideoImageReference, original: ReferenceAsset, frozen = false): ReferenceAsset => {
  if (reference.transportImage === undefined) return original;
  const image = normalizeVideoTransportImage(reference.transportImage);
  if (!image) throw new Error(VIDEO_TRANSPORT_IMAGE_INVALID);
  if (frozen) {
    if (original.checksum !== image.checksum) throw new Error('压缩副本与原任务冻结图片不一致，请作为新的选图任务生成。');
    return original;
  }
  if (original.checksum && original.checksum.toLowerCase() !== image.sourceChecksum) throw new Error('原参考图已变化，请恢复原图或重新轻压缩；原压缩副本不会误用于新图片。');
  return {
    ...original, relativePath: image.relativePath, dataUrl: image.dataUrl, checksum: image.checksum,
    url: image.relativePath ? `lianhua-asset://local/${image.relativePath.split('/').map(encodeURIComponent).join('/')}` : undefined,
    fileName: image.fileName || original.fileName, sizeBytes: image.sizeBytes, width: image.width, height: image.height, mimeType: image.mimeType, missing: false,
  };
};

/** Check the actual encoded bytes before any upload or generation submission. */
export const assertVideoTransportImageData = async (image: VideoTransportImage, dataUrl: string): Promise<void> => {
  const normalized = normalizeGeneratedImageData(dataUrl);
  const match = normalized.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match || match[1] !== image.mimeType) throw new Error(VIDEO_TRANSPORT_IMAGE_INVALID);
  const binary = globalThis.atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== image.sizeBytes) throw new Error(VIDEO_TRANSPORT_IMAGE_INVALID);
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== image.checksum) throw new Error(VIDEO_TRANSPORT_IMAGE_INVALID);
};

/** Inline legacy/browser assets have no saved SHA; compare their current pixels too. */
export const assertVideoTransportImageSource = async (reference: VideoImageReference, original: ReferenceAsset): Promise<void> => {
  if (!reference.transportImage || original.checksum || !original.dataUrl?.startsWith('data:image/')) return;
  const image = normalizeVideoTransportImage(reference.transportImage);
  const mimeType = original.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/u)?.[1] as VideoTransportImage['mimeType'] | undefined;
  if (!image || !mimeType) throw new Error(VIDEO_TRANSPORT_IMAGE_INVALID);
  await assertVideoTransportImageData({ ...image, checksum: image.sourceChecksum, sizeBytes: image.originalSizeBytes, mimeType }, original.dataUrl);
};
