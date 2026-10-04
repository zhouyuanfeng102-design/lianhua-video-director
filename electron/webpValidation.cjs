/** Electron nativeImage does not decode WebP in the bundled runtime. Check
 * the RIFF/chunk/frame structure without transcoding or claiming pixel-level
 * validation of the VP8/VP8L compressed stream. */
const isCompleteWebP = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  const end = bytes.readUInt32LE(4) + 8;
  if (end < 20 || end > bytes.length) return false;
  for (let index = end; index < bytes.length; index += 1) if (![0, 9, 10, 13, 32].includes(bytes[index])) return false;
  const checkChunks = (start, limit, animatedFrame = false) => {
    let hasImage = false;
    let extendedFlags;
    let animationHeader = false;
    let cursor = start;
    while (cursor < limit) {
      if (cursor + 8 > limit) return false;
      const type = bytes.toString('ascii', cursor, cursor + 4);
      const size = bytes.readUInt32LE(cursor + 4);
      const data = cursor + 8;
      const chunkEnd = data + size;
      const next = chunkEnd + (size & 1);
      if (chunkEnd > limit || next > limit) return false;
      if (type === 'VP8 ') {
        if (size < 10 || (bytes[data] & 1) !== 0 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return false;
        if (!(bytes.readUInt16LE(data + 6) & 0x3fff) || !(bytes.readUInt16LE(data + 8) & 0x3fff)) return false;
        const firstPartition = (bytes[data] | bytes[data + 1] << 8 | bytes[data + 2] << 16) >>> 5;
        if (!firstPartition || firstPartition + 3 > size) return false;
        hasImage = true;
      } else if (type === 'VP8L') {
        if (size < 6 || bytes[data] !== 0x2f || (bytes.readUInt32LE(data + 1) >>> 29) !== 0) return false;
        hasImage = true;
      } else if (type === 'VP8X') {
        if (animatedFrame || cursor !== 12 || size !== 10 || (bytes[data] & 0xc1) !== 0 || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) return false;
        extendedFlags = bytes[data];
      } else if (type === 'ANMF') {
        if (animatedFrame || !(extendedFlags & 2) || !animationHeader || size < 24 || (bytes[data + 15] & 0xfc) !== 0 || !checkChunks(data + 16, chunkEnd, true)) return false;
        hasImage = true;
      } else if (type === 'ANIM') {
        if (animatedFrame || !(extendedFlags & 2) || size !== 6) return false;
        animationHeader = true;
      }
      cursor = next;
    }
    return cursor === limit && hasImage;
  };
  return checkChunks(12, end);
};

module.exports = { isCompleteWebP };
