const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { isCompleteWebP } = require('./webpValidation.cjs');

// Electron can fully decode PNG/JPEG, but not WebP in the bundled runtime.
// Node-only transport tests still exercise the bounded container checks below.
let nativeImage;
try { ({ nativeImage } = require('electron')); } catch { /* Node-only tooling has no Electron decoder. */ }

const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MULTIPART_BYTES = 96 * 1024 * 1024;

const IMAGE_FORMATS = [
  {
    mimeType: 'image/png',
    extension: '.png',
    matches: (bytes) => bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/jpeg',
    extension: '.jpg',
    matches: (bytes) => bytes.length >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mimeType: 'image/webp',
    extension: '.webp',
    matches: (bytes) => bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

const pathKey = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const isPathInside = (root, candidate) => {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const detectImageFormat = (bytes) => IMAGE_FORMATS.find((format) => format.matches(bytes));

const hasOnlyImagePadding = (bytes, start) => {
  for (let index = start; index < bytes.length; index += 1) {
    if (![0, 9, 10, 13, 32].includes(bytes[index])) return false;
  }
  return true;
};
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const imagePngCrc = (bytes, start, end) => {
  let value = 0xffffffff;
  for (let index = start; index < end; index += 1) value = PNG_CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const isCompletePng = (bytes) => {
  let hasPixels = false;
  let cursor = 8;
  while (cursor + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(cursor);
    const data = cursor + 8;
    const end = data + size;
    if (end + 4 > bytes.length) return false;
    const type = bytes.toString('ascii', cursor + 4, data);
    if (!/^[A-Za-z]{4}$/u.test(type) || imagePngCrc(bytes, cursor + 4, end) !== bytes.readUInt32BE(end)) return false;
    if (cursor === 8 && (type !== 'IHDR' || size !== 13)) return false;
    if (type === 'IHDR') {
      if (cursor !== 8 || size !== 13 || !bytes.readUInt32BE(data) || !bytes.readUInt32BE(data + 4)) return false;
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[bytes[data + 9]]?.includes(bytes[data + 8]) || bytes[data + 10] || bytes[data + 11] || bytes[data + 12] > 1) return false;
    }
    if (type === 'IDAT' && size > 0) hasPixels = true;
    if (type === 'IEND') return size === 0 && hasPixels && hasOnlyImagePadding(bytes, end + 4);
    cursor = end + 4;
  }
  return false;
};
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const isCompleteJpeg = (bytes) => {
  let cursor = 2;
  let hasFrame = false;
  let hasScan = false;
  while (cursor < bytes.length) {
    if (bytes[cursor++] !== 0xff) return false;
    while (bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) return false;
    const marker = bytes[cursor++];
    if (marker === 0xd9) return hasFrame && hasScan && hasOnlyImagePadding(bytes, cursor);
    if (marker === 0 || marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > bytes.length) return false;
    const size = bytes.readUInt16BE(cursor);
    const end = cursor + size;
    if (size < 2 || end > bytes.length) return false;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (size < 8 || !bytes.readUInt16BE(cursor + 3) || !bytes.readUInt16BE(cursor + 5)
        || !bytes[cursor + 7] || size !== 8 + 3 * bytes[cursor + 7]) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || size < 6 || !bytes[cursor + 2] || size !== 6 + 2 * bytes[cursor + 2]) return false;
      hasScan = true;
      cursor = end;
      // Escaped FF bytes and restart markers belong to the entropy stream.
      // Other markers start the next scan/segment or close the JPEG.
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) { cursor += 1; continue; }
        const start = cursor++;
        while (bytes[cursor] === 0xff) cursor += 1;
        if (bytes[cursor] === 0 || (bytes[cursor] >= 0xd0 && bytes[cursor] <= 0xd7)) { cursor += 1; continue; }
        cursor = start;
        break;
      }
    } else cursor = end;
  }
  return false;
};
const assertCompleteReferenceImage = (bytes, format, label = '参考图片') => {
  const complete = format.mimeType === 'image/png' ? isCompletePng(bytes)
    : format.mimeType === 'image/jpeg' ? isCompleteJpeg(bytes) : isCompleteWebP(bytes);
  let decodable = complete;
  if (complete && format.mimeType !== 'image/webp' && nativeImage?.createFromBuffer) {
    try { decodable = !nativeImage.createFromBuffer(bytes).isEmpty(); } catch { decodable = false; }
  }
  if (!decodable) throw new Error(`${label}内容已损坏或截断，无法读取为有效图片`);
};

const decodeReferenceImageDataUrl = (rawValue, maxBytes = DEFAULT_MAX_IMAGE_BYTES) => {
  const raw = String(rawValue || '').trim();
  const match = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/\s]*={0,2})$/iu);
  if (!match) throw new Error('参考图片只允许 PNG、JPEG 或 WebP 的 Base64 data URL');
  const compact = match[2].replace(/\s+/gu, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new Error('参考图片 Base64 格式无效');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(compact.length * 3 / 4) - padding;
  if (estimatedBytes > maxBytes) throw new Error('参考图片超过 32 MB 上限');
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('参考图片为空或超过 32 MB 上限');
  // Buffer.from is permissive about malformed padding and unused trailing bits.
  if (bytes.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')
    || (compact.includes('=') && compact.length % 4 !== 0)) throw new Error('参考图片 Base64 格式无效');
  const format = detectImageFormat(bytes);
  if (!format) throw new Error('参考图片格式或文件签名无效');
  assertCompleteReferenceImage(bytes, format);
  // FileReader derives its MIME from file metadata/extensions, which can be
  // wrong for a valid image. Normalize metadata from verified bytes only.
  return { bytes, mimeType: format.mimeType, extension: format.extension };
};

const readManagedImageDataUrl = ({
  assetRoot,
  relativePath,
  expectedChecksum,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
}) => {
  const root = fs.realpathSync(path.resolve(String(assetRoot || '')));
  const requested = String(relativePath || '').trim();
  if (!requested || path.isAbsolute(requested)) throw new Error('托管图片必须使用资产目录内的相对路径');
  const candidate = path.resolve(root, requested.replace(/[\\/]+/gu, path.sep));
  if (!isPathInside(root, candidate)) throw new Error('托管图片路径越界');
  const resolved = fs.realpathSync(candidate);
  if (!isPathInside(root, resolved)) throw new Error('托管图片真实路径越界');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('托管图片路径不是普通文件');
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error('托管图片为空或超过 32 MB 上限');
  const bytes = fs.readFileSync(resolved);
  const format = detectImageFormat(bytes);
  if (!format) throw new Error('托管图片格式或文件签名无效');
  assertCompleteReferenceImage(bytes, format, '托管图片');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const expected = String(expectedChecksum || '').trim().toLowerCase();
  if (expected && checksum !== expected) throw new Error('托管图片校验失败：文件内容已变化');
  return {
    dataUrl: `data:${format.mimeType};base64,${bytes.toString('base64')}`,
    mimeType: format.mimeType,
    sizeBytes: bytes.length,
    checksum,
  };
};

const safeFieldName = (value) => {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_[\].-]{1,64}$/u.test(name)) throw new Error('multipart 字段名无效');
  return name;
};

const safeFileName = (value, extension) => {
  const base = path.basename(String(value || 'reference-image'))
    .replace(/[\r\n"\\/]/gu, '_')
    .slice(0, 160);
  const stem = path.basename(base, path.extname(base)).trim() || 'reference-image';
  return `${stem}${extension}`;
};

const buildImageEditMultipart = (multipart, options = {}) => {
  const fields = Array.isArray(multipart?.fields) ? multipart.fields : [];
  const files = Array.isArray(multipart?.files) ? multipart.files : [];
  if (!files.length) throw new Error('图片编辑请求缺少参考图');
  // This transport serves configurable OpenAI-compatible providers, whose
  // reference counts differ. Preserve every selected image and leave any
  // provider-specific count limit to that provider; bound local memory by bytes.
  if (fields.length > 32) throw new Error('图片编辑请求字段过多');
  const maxImageBytes = Number(options.maxImageBytes) || DEFAULT_MAX_IMAGE_BYTES;
  const maxMultipartBytes = Number(options.maxMultipartBytes) || DEFAULT_MAX_MULTIPART_BYTES;
  const boundary = `----lianhua-${randomBytes(18).toString('hex')}`;
  const chunks = [];
  let contentLength = 0;
  const appendChunk = (chunk) => {
    if (chunk.length > maxMultipartBytes - contentLength) {
      throw new Error('图片编辑 multipart 请求超过 96 MB 上限');
    }
    contentLength += chunk.length;
    chunks.push(chunk);
  };
  const appendText = (value) => appendChunk(Buffer.from(value, 'utf8'));

  fields.forEach((field) => {
    const name = safeFieldName(field?.name);
    const value = String(field?.value ?? '');
    if (Buffer.byteLength(value, 'utf8') > 256 * 1024) throw new Error(`multipart 字段 ${name} 过大`);
    appendText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  });
  files.forEach((file, index) => {
    const name = safeFieldName(file?.name);
    const decoded = decodeReferenceImageDataUrl(file?.dataUrl, maxImageBytes);
    const fileName = safeFileName(file?.fileName || `reference-${index + 1}`, decoded.extension);
    appendText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${decoded.mimeType}\r\n\r\n`);
    appendChunk(decoded.bytes);
    appendText('\r\n');
  });
  appendText(`--${boundary}--\r\n`);
  const body = Buffer.concat(chunks, contentLength);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: body.length,
  };
};

module.exports = {
  buildImageEditMultipart,
  decodeReferenceImageDataUrl,
  readManagedImageDataUrl,
};
