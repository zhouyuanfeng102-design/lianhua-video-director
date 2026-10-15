import type { Project, ReferenceAsset, VideoTaskApiConfig } from './types';
import type { VideoTransportImage } from './videoGenerationTypes';
import { generatedImageMime, normalizeGeneratedImageData } from './generatedImageData';
import { videoApiCapabilityScope } from './videoApiCapabilities';
import { normalizeVideoTransportImage } from './videoTransportImage';

export const VIDEO_REFERENCE_COMPRESSION_QUALITY = 0.95;
const aborted = () => Object.assign(new Error('已取消图片轻压缩。'), { name: 'AbortError' });
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw aborted(); };
const hexDigest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const blobDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取图片编码结果。')); reader.readAsDataURL(blob);
});
export const videoImageDataSize = (dataUrl?: string): number | undefined => {
  const encoded = dataUrl?.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/\s]+={0,2})$/iu)?.[1]?.replace(/\s/gu, '');
  return encoded ? Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) : undefined;
};
export const formatVideoImageSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

/** Validate the actual image format without inventing a local model limit.
 * Compression may prepare an original larger than the model's upload limit. */
const normalizeCompressionImage = (value: string): string => {
  let dataUrl: string;
  try { dataUrl = normalizeGeneratedImageData(value); }
  catch (cause) { throw new Error((cause instanceof Error ? cause.message : '图片格式无效。').replace(/生成图片/gu, '原图')); }
  const size = videoImageDataSize(dataUrl);
  if (!size) throw new Error('原图为空，无法读取有效图片。');
  return dataUrl;
};

/** Decode in memory: fetch(data:) is a connection under CSP even though the
 * bytes are local, so it must not be used to construct the original Blob. */
const compressionImageBlob = (dataUrl: string): Blob => {
  const separator = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) });
};

/** A prior response is explicit evidence for this connection/model, not a local model table. */
export const videoReferenceByteLimit = (project: Pick<Project, 'generationTasks'>, api?: Partial<Pick<VideoTaskApiConfig, 'provider' | 'model' | 'baseUrl' | 'endpoint' | 'statusEndpointTemplate'>>): number | undefined => {
  if (!api?.model || api.provider && api.provider !== 'generic') return undefined;
  const scope = videoApiCapabilityScope(api);
  for (const task of [...project.generationTasks].sort((left, right) => right.createdAt - left.createdAt)) {
    if (task.kind && task.kind !== 'video') continue;
    const connection = task.videoJob?.snapshot.connection.api;
    if (!connection || connection.model !== api.model || videoApiCapabilityScope(connection) !== scope || typeof task.error !== 'string' || !task.error.includes('IMAGES_TOO_LARGE')) continue;
    const match = task.error.match(/参考图总大小超过\s*(\d+(?:\.\d+)?)\s*(MiB|MB)/iu);
    const bytes = match && Number(match[1]) * (match[2].toLowerCase() === 'mib' ? 1024 * 1024 : 1_000_000);
    if (bytes && Number.isSafeInteger(bytes) && bytes > 0) return bytes;
  }
  return undefined;
};

export interface VideoCompressionCandidate {
  asset: ReferenceAsset;
  originalUrl: string;
  previewUrl: string;
  dataUrl: string;
  smaller: boolean;
  hasTransparency: boolean;
  image: VideoTransportImage;
}
export const disposeVideoCompressionCandidate = (candidate: VideoCompressionCandidate) => {
  URL.revokeObjectURL(candidate.originalUrl); URL.revokeObjectURL(candidate.previewUrl);
};

/** Read full original pixels; never use the reference thumbnail/downsampling path. */
export async function createVideoCompressionCandidate(asset: ReferenceAsset, quality = VIDEO_REFERENCE_COMPRESSION_QUALITY, signal?: AbortSignal): Promise<VideoCompressionCandidate> {
  active(signal);
  if (![0.95, 0.98].includes(quality)) throw new Error('轻压缩仅使用高质量编码，不会自动降低画质。');
  let originalData: string;
  if (asset.relativePath && window.lianhuaDesktop?.readVideoReferenceImage) {
    originalData = (await window.lianhuaDesktop.readVideoReferenceImage({ relativePath: asset.relativePath, expectedChecksum: asset.checksum })).dataUrl;
  } else if (asset.dataUrl) originalData = asset.dataUrl;
  else {
    const source = asset.url;
    if (!source || !/^https?:\/\//iu.test(source)) throw new Error('原图无法读取，请先将完整原图保存到资产库。');
    if (window.lianhuaDesktop?.videoRequest || window.lianhuaDesktop?.request) {
      const response = window.lianhuaDesktop.videoRequest
        ? await window.lianhuaDesktop.videoRequest({ requestId: `video-compression-${crypto.randomUUID()}`, url: source, method: 'GET', responseType: 'base64' })
        : await window.lianhuaDesktop.request!({ url: source, method: 'GET', responseType: 'base64' });
      if (response.status < 200 || response.status >= 300) throw new Error(`原图读取失败：HTTP ${response.status}`);
      originalData = `data:image/png;base64,${response.body}`;
    } else {
      const response = await fetch(source, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`原图读取失败：HTTP ${response.status}`);
      originalData = await blobDataUrl(await response.blob());
    }
  }
  active(signal);
  originalData = normalizeCompressionImage(originalData);
  const originalBlob = compressionImageBlob(originalData);
  const originalBytes = await originalBlob.arrayBuffer();
  const sourceChecksum = await hexDigest(originalBytes);
  if (asset.checksum && asset.checksum.toLowerCase() !== sourceChecksum) throw new Error('原图内容已变化，请重新选择当前原图；未应用任何压缩结果。');
  active(signal);
  const bitmap = await createImageBitmap(originalBlob, { imageOrientation: 'from-image' });
  let encoded: Blob;
  let width: number, height: number, hasTransparency = false;
  try {
    width = bitmap.width; height = bitmap.height;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法建立本地图片编码画布。');
    context.drawImage(bitmap, 0, 0);
    // Scan strips to bound extra memory while preserving actual alpha, including palette PNGs.
    for (let y = 0; y < height && !hasTransparency; y += 64) {
      const pixels = context.getImageData(0, y, width, Math.min(64, height - y)).data;
      for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] !== 255) { hasTransparency = true; break; }
      active(signal);
      if (y % 512 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('本地图片编码失败，原图未改变。')), hasTransparency ? 'image/webp' : 'image/jpeg', quality));
  } finally { bitmap.close(); }
  active(signal);
  const encodedBytes = await encoded.arrayBuffer();
  const mimeType = generatedImageMime(new Uint8Array(encodedBytes));
  if (!mimeType || hasTransparency && mimeType === 'image/jpeg') throw new Error('编码结果未保留透明通道，原图未改变。');
  const dataUrl = normalizeCompressionImage(await blobDataUrl(encoded));
  active(signal);
  const checksum = await hexDigest(encodedBytes);
  const stem = (asset.fileName || asset.name || 'video-reference').replace(/\.[^.]+$/u, '').replace(/[\\/\u0000-\u001f]/gu, '_').slice(0, 150);
  return {
    asset, dataUrl, smaller: encoded.size < originalBlob.size, hasTransparency,
    originalUrl: URL.createObjectURL(originalBlob), previewUrl: URL.createObjectURL(encoded),
    image: { version: 1, sourceChecksum, checksum, originalSizeBytes: originalBlob.size, sizeBytes: encoded.size,
      originalWidth: width!, originalHeight: height!, width: width!, height: height!, mimeType, quality,
      fileName: `${stem}-视频轻压缩.${mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'}` },
  };
}

export async function saveVideoCompressionCandidate(candidate: VideoCompressionCandidate): Promise<VideoTransportImage> {
  if (!candidate.smaller) throw new Error('轻压缩结果未变小，继续使用原图。');
  if (window.lianhuaDesktop?.storeVideoReferenceImage) {
    const stored = await window.lianhuaDesktop.storeVideoReferenceImage({ dataUrl: candidate.dataUrl, fileName: candidate.image.fileName });
    if (stored.checksum !== candidate.image.checksum || stored.sizeBytes !== candidate.image.sizeBytes || stored.mimeType !== candidate.image.mimeType) throw new Error('视频压缩副本保存结果不一致，原选图未改变。');
    const image = normalizeVideoTransportImage({ ...candidate.image, relativePath: stored.relativePath, fileName: stored.fileName || candidate.image.fileName });
    if (!stored.relativePath || !image) throw new Error('视频压缩副本保存记录无效，原选图未改变。');
    return image;
  }
  return { ...candidate.image, dataUrl: candidate.dataUrl };
}
