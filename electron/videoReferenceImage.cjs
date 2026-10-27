const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { decodeReferenceImageDataUrl, readManagedImageDataUrl } = require('./imageReferenceTransport.cjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const isInside = (root, value) => {
  const relative = path.relative(pathKey(root), pathKey(value));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
/** Read the checked original bytes, never a thumbnail or a transcoded image. */
const readVideoReferenceImage = ({ assetRoot, relativePath, expectedChecksum } = {}) => {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 1024
    || /[:\u0000-\u001f]/u.test(relativePath)) throw new Error('视频参考原图必须使用受控资产目录中的相对路径。');
  if (expectedChecksum !== undefined && expectedChecksum !== ''
    && (typeof expectedChecksum !== 'string' || !/^[a-f\d]{64}$/iu.test(expectedChecksum))) throw new Error('视频参考原图校验码无效。');
  try {
    // Local preparation does not invent a video-model size limit. Keep the
    // shared reader's path/format/SHA checks while leaving its ordinary budget
    // unchanged for callers outside this dedicated video-image path.
    return readManagedImageDataUrl({ assetRoot, relativePath, expectedChecksum, maxBytes: Number.POSITIVE_INFINITY });
  } catch (error) {
    // With no size cap, this shared diagnostic can only mean an empty file.
    if (error?.message === '托管图片为空或超过 32 MB 上限') throw new Error('视频参考原图为空，无法读取有效图片。');
    throw error;
  }
};

const storedFile = (destination, checksum, expectedSize) => {
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('视频参考副本路径不是受控普通文件。');
  if (stat.size !== expectedSize || sha256(fs.readFileSync(destination)) !== checksum) {
    throw new Error('视频参考副本校验失败，原文件未覆盖。');
  }
  return stat.size;
};
const fileNameForFormat = (rawName, extension) => {
  const requested = path.basename(String(rawName || 'video-reference'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  const stem = path.basename(requested, path.extname(requested)).trim().slice(0, 160) || 'video-reference';
  return `${stem}${extension}`;
};

const safeRelativeDirectory = (value) => {
  const relative = String(value || '').replace(/\\/gu, '/').replace(/^\/+/u, '');
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  return relative;
};

/** Publish an immutable, content-addressed copy. Existing files are verified,
 * never rewritten, including races with another save of the same pixels. */
const storeVideoReferenceImage = ({ assetRoot, dataUrl, fileName, relativeDirectory } = {}) => {
  const decoded = decodeReferenceImageDataUrl(dataUrl, Number.POSITIVE_INFINITY);
  const { bytes, mimeType, extension } = decoded;
  const checksum = sha256(bytes);
  const folder = safeRelativeDirectory(relativeDirectory) || 'image';
  const root = fs.realpathSync(path.resolve(String(assetRoot || '')));
  const requestedDirectory = path.join(root, ...folder.split('/'));
  fs.mkdirSync(requestedDirectory, { recursive: true });
  const directory = fs.realpathSync(requestedDirectory);
  if (!isInside(root, directory)) throw new Error('视频参考副本真实路径越界。');
  const destination = path.join(directory, `${checksum}${extension}`);
  if (!fs.existsSync(destination)) {
    const temporary = path.join(directory, `.video-reference-${randomUUID()}.tmp`);
    let handle;
    let temporaryCreated = false;
    try {
      handle = fs.openSync(temporary, 'wx');
      temporaryCreated = true;
      fs.writeFileSync(handle, bytes); fs.fsyncSync(handle);
      fs.closeSync(handle); handle = undefined;
      // A hard-link publication is atomic and fails if a destination appeared;
      // unlike rename, it cannot replace an existing original or a symlink.
      try { fs.linkSync(temporary, destination); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      if (temporaryCreated) {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  const sizeBytes = storedFile(destination, checksum, bytes.length);
  const relativePath = `${folder}/${checksum}${extension}`;
  return { fileName: fileNameForFormat(fileName, extension), relativePath, checksum, sizeBytes,
    mediaType: 'image', mimeType, managed: true, missing: false,
    url: `lianhua-asset://local/${relativePath.split('/').map(encodeURIComponent).join('/')}` };
};

module.exports = { readVideoReferenceImage, storeVideoReferenceImage };
