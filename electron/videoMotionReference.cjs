const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const formats = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg' };
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const readManagedVideoDataUrl = ({ assetRoot, relativePath, expectedChecksum }) => {
  const root = fs.realpathSync(assetRoot);
  const candidate = path.resolve(root, String(relativePath || ''));
  if (!inside(root, candidate) || !inside(root, fs.realpathSync(candidate))) throw new Error('托管视频路径越界');
  const bytes = fs.readFileSync(candidate);
  const digest = checksum(bytes);
  if (expectedChecksum && expectedChecksum !== digest) throw new Error('参考视频原文件已变化');
  const mimeType = formats[path.extname(candidate).toLowerCase()] || 'video/mp4';
  return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, checksum: digest, sizeBytes: bytes.length };
};

const decodeReferenceVideoDataUrl = (dataUrl) => {
  const match = /^data:(video\/[a-z0-9.+-]+);base64,([\s\S]*)$/iu.exec(String(dataUrl || ''));
  if (!match) throw new Error('参考视频必须使用视频原文件数据');
  const bytes = Buffer.from(match[2], 'base64');
  const extension = Object.entries(formats).find(([, mime]) => mime === match[1])?.[0] || '.mp4';
  return { bytes, extension, mimeType: match[1] };
};
const storeVideoReferenceVideo = ({ assetRoot, dataUrl, fileName, relativeDirectory }) => {
  const { bytes, extension, mimeType } = decodeReferenceVideoDataUrl(dataUrl);
  const digest = checksum(bytes);
  const folder = String(relativeDirectory || 'video').replace(/\\/gu, '/').replace(/^\/+/u, '');
  const relativeDirectorySafe = folder && folder.split('/').every((part) => part && part !== '.' && part !== '..') ? folder : 'video';
  const relativePath = `${relativeDirectorySafe}/${digest}${extension}`;
  const destination = path.join(assetRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes, { flag: 'wx' });
  return { fileName: path.basename(fileName || `reference-video${extension}`), relativePath, checksum: digest,
    sizeBytes: bytes.length, mediaType: 'video', mimeType, managed: true, missing: false,
    url: `lianhua-asset://local/${relativePath.split('/').map(encodeURIComponent).join('/')}` };
};
module.exports = { readManagedVideoDataUrl, storeVideoReferenceVideo, decodeReferenceVideoDataUrl };
