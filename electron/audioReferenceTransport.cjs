const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Conservative local limit from RunningHub's published integration example.
// The v2 upload contract does not document a different audio-specific limit.
const MAX_REFERENCE_AUDIO_BYTES = 30 * 1024 * 1024;
const wav = (bytes) => {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return false;
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 44) return false;
  let cursor = 12, format = false, samples = false;
  while (cursor + 8 <= end) {
    const size = bytes.readUInt32LE(cursor + 4), next = cursor + 8 + size;
    if (next > end) return false;
    const tag = bytes.toString('ascii', cursor, cursor + 4);
    if (tag === 'fmt ') format = size >= 16 && bytes.readUInt16LE(cursor + 8) > 0
      && bytes.readUInt16LE(cursor + 10) > 0 && bytes.readUInt32LE(cursor + 12) > 0;
    if (tag === 'data') samples = size > 0;
    cursor = next + (size % 2);
  }
  return format && samples && cursor === end;
};
const mp3 = (bytes) => {
  let cursor = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes[3] < 2 || bytes[3] > 4 || bytes.subarray(6, 10).some((byte) => byte > 127)) return false;
    cursor = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9]) + (bytes[3] === 4 && bytes[5] & 0x10 ? 10 : 0);
  }
  let frames = 0;
  while (cursor + 4 <= bytes.length) {
    if (bytes.length - cursor === 128 && bytes.toString('ascii', cursor, cursor + 3) === 'TAG') return frames > 0;
    const a = bytes[cursor], b = bytes[cursor + 1], c = bytes[cursor + 2];
    if (a !== 255 || (b & 0xe0) !== 0xe0) return frames > 0 && bytes.subarray(cursor).every((byte) => byte === 0);
    const version = b >> 3 & 3, layer = b >> 1 & 3, rateIndex = c >> 2 & 3, bitrateIndex = c >> 4;
    if (version === 1 || layer !== 1 || rateIndex === 3 || !bitrateIndex || bitrateIndex === 15) return false;
    const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrates[bitrateIndex] / sampleRate) + (c >> 1 & 1);
    if (length <= 4 || cursor + length > bytes.length) return false;
    cursor += length; frames += 1;
  }
  return frames > 0 && (cursor === bytes.length || bytes.subarray(cursor).every((byte) => byte === 0));
};
const flac = (bytes) => {
  if (bytes.length < 43 || bytes.toString('ascii', 0, 4) !== 'fLaC') return false;
  let cursor = 4, first = true;
  while (cursor + 4 <= bytes.length) {
    const tag = bytes[cursor], size = bytes.readUIntBE(cursor + 1, 3);
    if (first && ((tag & 127) !== 0 || size !== 34) || cursor + 4 + size > bytes.length) return false;
    first = false; cursor += 4 + size;
    if (tag & 128) return cursor + 2 <= bytes.length && bytes[cursor] === 255 && (bytes[cursor + 1] & 254) === 248;
  }
  return false;
};
const detectReferenceAudio = (bytes) => wav(bytes) ? { mimeType: 'audio/wav', extension: '.wav' }
  : mp3(bytes) ? { mimeType: 'audio/mpeg', extension: '.mp3' }
    : flac(bytes) ? { mimeType: 'audio/flac', extension: '.flac' } : undefined;
const checkedAudio = (bytes, maxBytes = MAX_REFERENCE_AUDIO_BYTES) => {
  if (!bytes.length || bytes.length >= maxBytes) throw new Error('参考音频为空或达到 30 MB 本地上传限制');
  const format = detectReferenceAudio(bytes);
  if (!format) throw new Error('参考音频不是有效的 MP3、WAV 或 FLAC 文件，或内容已截断');
  return { bytes, ...format };
};
const decodeReferenceAudioDataUrl = (dataUrl, maxBytes = MAX_REFERENCE_AUDIO_BYTES) => {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxBytes * 4 / 3) + 1024) throw new Error('参考音频数据为空或超过本地上传限制');
  const match = /^data:audio\/[a-z0-9.+-]+(?:;[^,]*)?;base64,([\s\S]*)$/iu.exec(dataUrl);
  if (!match) throw new Error('参考音频必须是 audio Base64 数据');
  const compact = match[1].replace(/\s+/gu, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) throw new Error('参考音频 Base64 格式无效');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')
    || compact.includes('=') && compact.length % 4 !== 0) throw new Error('参考音频 Base64 格式无效');
  return checkedAudio(bytes, maxBytes);
};
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const readManagedAudioDataUrl = ({ assetRoot, relativePath, expectedChecksum, maxBytes = MAX_REFERENCE_AUDIO_BYTES }) => {
  const root = fs.realpathSync(path.resolve(String(assetRoot || '')));
  const requested = String(relativePath || '').trim();
  if (!requested || path.isAbsolute(requested) || /[:\u0000]/u.test(requested)) throw new Error('托管音频必须使用资产目录内的相对路径');
  const candidate = path.resolve(root, requested.replace(/[\\/]+/gu, path.sep));
  if (!inside(root, candidate)) throw new Error('托管音频路径越界');
  const resolved = fs.realpathSync(candidate);
  if (!inside(root, resolved)) throw new Error('托管音频真实路径越界');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size >= maxBytes) throw new Error('托管音频不是普通文件、为空或达到 30 MB 本地上传限制');
  const audio = checkedAudio(fs.readFileSync(resolved), maxBytes);
  const checksum = createHash('sha256').update(audio.bytes).digest('hex');
  const expected = String(expectedChecksum || '').trim().toLowerCase();
  if (expected && checksum !== expected) throw new Error('托管音频校验失败：文件内容已变化');
  return { dataUrl: `data:${audio.mimeType};base64,${audio.bytes.toString('base64')}`, mimeType: audio.mimeType, sizeBytes: audio.bytes.length, checksum };
};

module.exports = { MAX_REFERENCE_AUDIO_BYTES, decodeReferenceAudioDataUrl, readManagedAudioDataUrl };
