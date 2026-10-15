import type { VideoTaskApiConfig } from './types';
import type { VideoDesktopRequest, VideoGenerationDraft } from './videoGenerationTypes';
import { genericVideoSubmitEndpoint } from './genericVideoApi';
import { normalizeGeneratedImageData } from './generatedImageData';

type AddressConfig = Pick<VideoTaskApiConfig, 'endpoint' | 'baseUrl'>;

/** Only the documented v6k operation gets this protocol. Custom templates and
 * other providers/paths retain their explicitly configured transport. */
export const isV6kVideoBuiltinProtocol = (
  config: AddressConfig & Pick<VideoTaskApiConfig, 'provider' | 'requestTemplate'>,
): boolean => {
  if (config.provider && config.provider !== 'generic' || config.requestTemplate?.trim()) return false;
  try {
    const url = new URL(genericVideoSubmitEndpoint(config));
    return /^https?:$/u.test(url.protocol) && /^(?:www\.)?v6k\.top$/u.test(url.hostname.toLowerCase())
      && /^\/v1\/videos\/?$/u.test(url.pathname);
  } catch { return false; }
};

const assertReferences = (draft: VideoGenerationDraft, images: string[]): void => {
  if (draft.references.length !== images.length) throw new Error('v6k 已选参考图与请求图片数量不一致；不会漏图，尚未提交视频。');
  for (let index = 0; index < images.length; index += 1) {
    if (typeof images[index] !== 'string' || !images[index].trim()) throw new Error(`v6k 第 ${index + 1} 张参考图内容为空，尚未提交视频。`);
  }
};

/** v6k consumes one ordered images array. Reference roles remain prompt/UI
 * metadata and never duplicate the same image into guessed frame fields. */
export const buildV6kVideoApiBody = (
  config: Pick<VideoTaskApiConfig, 'model'>, draft: VideoGenerationDraft, images: string[],
): Record<string, unknown> => {
  assertReferences(draft, images);
  return { ...(config.model ? { model: config.model } : {}), ...draft.parameters, prompt: draft.prompt,
    ...(images.length ? { images } : {}) };
};

const assertHttpImageUrl = (value: string, index: number): void => {
  try {
    const url = new URL(value);
    if (/^https?:$/u.test(url.protocol) && !url.username && !url.password && value === value.trim()) return;
  } catch { /* Explain the invalid selected reference without exposing its data. */ }
  throw new Error(`v6k 第 ${index + 1} 张参考图不是有效的 HTTP(S) 图片地址，尚未提交视频。`);
};

/** Binary multipart removes Base64's wire overhead while keeping the exact
 * selected image bytes and order. URL-only requests keep documented JSON. */
export const buildV6kVideoApiRequest = (
  config: AddressConfig & Pick<VideoTaskApiConfig, 'model'>,
  draft: VideoGenerationDraft,
  images: string[],
  headers: Record<string, string>,
): Omit<VideoDesktopRequest, 'requestId'> => {
  const body = buildV6kVideoApiBody(config, draft, images);
  const dataImages = images.map((image) => /^data:/iu.test(image));
  if (!dataImages.some(Boolean)) {
    images.forEach(assertHttpImageUrl);
    return { url: genericVideoSubmitEndpoint(config), method: 'POST',
      headers: { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')), 'Content-Type': 'application/json' },
      body: JSON.stringify(body) };
  }
  if (dataImages.some((isData) => !isData)) {
    throw new Error('v6k 参考图同时包含本地图片和远程 URL，无法保证图片顺序；请统一图片来源后重试，尚未提交视频。');
  }
  const files = images.map((image, index) => {
    let normalized: string;
    try { normalized = normalizeGeneratedImageData(image); }
    catch { throw new Error(`v6k 第 ${index + 1} 张参考图不是有效的 PNG、JPEG 或 WebP 图片，尚未提交视频。`); }
    const mime = normalized.slice(5, normalized.indexOf(';'));
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    return { fieldName: 'images', fileName: `reference-${index + 1}.${extension}`, dataUrl: normalized };
  });
  const fields: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(body)) {
    if (name === 'images') continue;
    // Match JSON serialization for nested parameters, booleans, null and
    // omitted undefined fields; do not rename aliases or rewrite values.
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized !== undefined) fields.push({ name, value: serialized });
  }
  return { url: genericVideoSubmitEndpoint(config), method: 'POST',
    headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')),
    multipart: { fields, files } };
};
