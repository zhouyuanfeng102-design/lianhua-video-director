export type GeneratedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The response label is only metadata. Detect the format from its signature;
 * the desktop store checks completeness and native decoding where supported. */
export const generatedImageMime = (bytes: Uint8Array): GeneratedImageMime | undefined => {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value)
    && [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value)) return 'image/webp';
  return undefined;
};

/** Correct MIME/padding only. Never transcode, resize, or alter image bytes. */
export const normalizeGeneratedImageData = (value: string): string => {
  const trimmed = String(value || '').trim();
  const data = /^data:/iu.test(trimmed) ? trimmed.match(/^data:[^,]*;base64,([\s\S]+)$/iu)?.[1] : trimmed;
  if (!data) throw new Error('生成图片 Base64 格式无效或内容为空。');
  const compact = data.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/');
  const content = compact.replace(/=+$/u, '');
  if (!content || content.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) throw new Error('生成图片 Base64 格式无效。');
  const requiredPadding = (4 - content.length % 4) % 4;
  if (compact.length !== content.length && compact.length - content.length !== requiredPadding) throw new Error('生成图片 Base64 格式无效。');
  const padded = content.padEnd(Math.ceil(content.length / 4) * 4, '=');
  let signature: Uint8Array;
  try { signature = Uint8Array.from(atob(padded.slice(0, 24)), (character) => character.charCodeAt(0)); }
  catch { throw new Error('生成图片 Base64 格式无效。'); }
  const mime = generatedImageMime(signature);
  if (!mime) throw new Error('生成图片不是有效的 PNG、JPEG 或 WebP 图片（文件签名无效或内容已损坏）。');
  return `data:${mime};base64,${padded}`;
};
