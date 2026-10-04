import { generatedImageMime, normalizeGeneratedImageData } from './generatedImageData';

export interface GeneratedImageDimensions {
  width: number;
  height: number;
}

const dimensions = (width: number, height: number): GeneratedImageDimensions | undefined => (
  Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined
);

/** Reads encoded pixel dimensions, not the requested size, filename or response
 * MIME label. This neither resizes nor decodes/re-encodes the image. Undefined
 * means unknown: callers must not replace it with a requested size as fact.
 * Full integrity/native-decode checks remain in the existing image store. */
export const readGeneratedImageDimensions = (dataUrl: string): GeneratedImageDimensions | undefined => {
  try {
    // Remote URLs are intentionally not fetched. Normalize validates Base64 and
    // detects the actual format by signature, including mislabeled responses.
    if (!dataUrl || /^https?:/iu.test(dataUrl.trim())) return undefined;
    const normalized = normalizeGeneratedImageData(dataUrl);
    const bytes = Uint8Array.from(atob(normalized.slice(normalized.indexOf(',') + 1)), (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mime = generatedImageMime(bytes);
    if (mime === 'image/png') {
      if (bytes.length < 33 || view.getUint32(8) !== 13
        || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;
      return dimensions(view.getUint32(16), view.getUint32(20));
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 3 < bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9 || marker === undefined || marker === 0x00) return undefined;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > bytes.length) return undefined;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) return undefined;
        // SOF0-3, SOF5-7, SOF9-11, SOF13-15. DHT/JPG/DAC are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          if (length < 8 || bytes[offset + 7] === 0 || length < 8 + 3 * bytes[offset + 7]) return undefined;
          return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        }
        offset += length;
      }
      return undefined;
    }
    if (mime === 'image/webp') {
      const riffEnd = view.getUint32(4, true) + 8;
      if (riffEnd > bytes.length || riffEnd < 20) return undefined;
      let offset = 12;
      while (offset + 8 <= riffEnd) {
        const chunkName = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const length = view.getUint32(offset + 4, true);
        const start = offset + 8;
        if (length === 0 || start + length > riffEnd) return undefined;
        if (chunkName === 'VP8X') {
          if (length !== 10) return undefined;
          return dimensions(
            1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
            1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16),
          );
        }
        if (chunkName === 'VP8L') {
          if (length < 5 || bytes[start] !== 0x2f) return undefined;
          return dimensions(
            1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8),
            1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 0x0f) << 10),
          );
        }
        if (chunkName === 'VP8 ') {
          if (length < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return undefined;
          return dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
        }
        offset = start + length + (length % 2);
      }
    }
  } catch {
    // Unknown metadata must not turn an otherwise separately validated result
    // into a failed task, or be filled with an invented request dimension.
  }
  return undefined;
};
