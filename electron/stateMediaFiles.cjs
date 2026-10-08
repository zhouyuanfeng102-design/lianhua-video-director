const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { decodeReferenceImageDataUrl } = require('./imageReferenceTransport.cjs');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const mapChanged = (items, transform) => {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const result = items.map((item) => { const next = transform(item); changed ||= next !== item; return next; });
  return changed ? result : items;
};

const mediaError = (error, label) => {
  const reason = { ENOSPC: '磁盘空间不足', EDQUOT: '磁盘配额已用尽', EACCES: '没有写入权限',
    EPERM: '系统拒绝写入或文件被占用', EIO: '磁盘读写失败', EROFS: '保存目录为只读' }[error?.code]
    || (error instanceof Error ? error.message : String(error));
  return Object.assign(new Error(`内嵌图片“${label}”保存失败：${reason}。原存档和内嵌图片未修改。`),
    { ...(error?.code ? { code: error.code } : {}), cause: error });
};

const completeGif = (bytes) => {
  if (bytes.length < 14 || !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8)) return false;
  let cursor = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let hasFrame = false;
  const blocks = () => {
    while (cursor < bytes.length) { const size = bytes[cursor++]; if (!size) return true; cursor += size; }
    return false;
  };
  while (cursor < bytes.length) {
    const marker = bytes[cursor++];
    if (marker === 0x3b) return hasFrame && cursor === bytes.length;
    if (marker === 0x21) { cursor += 1; if (!blocks()) return false; }
    else if (marker === 0x2c) {
      if (cursor + 9 > bytes.length || !bytes.readUInt16LE(cursor + 4) || !bytes.readUInt16LE(cursor + 6)) return false;
      const flags = bytes[cursor + 8];
      cursor += 9 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
      if (cursor >= bytes.length || bytes[cursor++] > 12 || !blocks()) return false;
      hasFrame = true;
    } else return false;
  }
  return false;
};

// This is a byte-preserving storage migration, not an API image conversion.
// No image is resized, decoded/re-encoded, or limited by a provider upload quota.
const decodeInlineImage = (value) => {
  const match = value.trim().match(/^data:([^;,]*)(?:;[^,]*)?,([\s\S]*)$/iu);
  if (!match) throw new Error('图片 data URL 格式无效');
  const header = value.trim().slice(0, value.trim().indexOf(','));
  let bytes;
  if (/;base64$/iu.test(header)) {
    const encoded = match[2].replace(/\s+/gu, '');
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1
      || (encoded.includes('=') && encoded.length % 4 !== 0)) throw new Error('图片 Base64 数据损坏');
    bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) throw new Error('图片 Base64 数据损坏');
  } else {
    // FileReader uses Base64; the percent-encoded SVG form is also a valid image data URL.
    if (!/^image\/svg\+xml$/iu.test(match[1])) throw new Error('内嵌图片必须使用 Base64 编码');
    try { bytes = Buffer.from(decodeURIComponent(match[2]), 'utf8'); }
    catch { throw new Error('图片 URL 编码损坏'); }
  }
  if (!bytes.length) throw new Error('图片内容为空');
  let format;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) format = { mimeType: 'image/png', extension: '.png' };
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = { mimeType: 'image/jpeg', extension: '.jpg' };
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') format = { mimeType: 'image/webp', extension: '.webp' };
  if (format) {
    // Reuse the application's container integrity checks without its 32 MiB API quota.
    decodeReferenceImageDataUrl(`data:${format.mimeType};base64,${bytes.toString('base64')}`, Infinity);
    return { bytes, ...format };
  }
  if (/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) {
    if (!completeGif(bytes)) throw new Error('GIF 图片损坏或截断');
    return { bytes, mimeType: 'image/gif', extension: '.gif' };
  }
  if (bytes.toString('ascii', 0, 2) === 'BM') {
    if (bytes.length < 26 || bytes.readUInt32LE(2) !== bytes.length || bytes.readUInt32LE(10) >= bytes.length) throw new Error('BMP 图片损坏或截断');
    return { bytes, mimeType: 'image/bmp', extension: '.bmp' };
  }
  if (bytes.length >= 8 && (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))) {
    const little = bytes[0] === 73;
    const firstIfd = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    if (firstIfd < 8 || firstIfd + 2 > bytes.length) throw new Error('TIFF 图片损坏或截断');
    const entries = little ? bytes.readUInt16LE(firstIfd) : bytes.readUInt16BE(firstIfd);
    if (!entries || firstIfd + 2 + entries * 12 + 4 > bytes.length) throw new Error('TIFF 图片损坏或截断');
    return { bytes, mimeType: 'image/tiff', extension: '.tiff' };
  }
  if (bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4);
    if (!count || 6 + count * 16 > bytes.length) throw new Error('ICO 图片损坏或截断');
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      if (!bytes.readUInt32LE(offset + 8) || bytes.readUInt32LE(offset + 12) + bytes.readUInt32LE(offset + 8) > bytes.length) throw new Error('ICO 图片损坏或截断');
    }
    return { bytes, mimeType: 'image/x-icon', extension: '.ico' };
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > bytes.length) throw new Error('图片容器损坏或截断');
    const brands = bytes.toString('ascii', 8, size);
    const avif = /avif|avis/u.test(brands);
    const heic = /heic|heix|hevc|hevx/u.test(brands);
    if (avif || heic || /mif1|msf1/u.test(brands)) {
      let cursor = 0;
      while (cursor < bytes.length) {
        if (cursor + 8 > bytes.length) throw new Error('图片容器损坏或截断');
        let length = bytes.readUInt32BE(cursor);
        if (length === 0) { cursor = bytes.length; break; }
        if (length === 1) {
          if (cursor + 16 > bytes.length) throw new Error('图片容器损坏或截断');
          length = Number(bytes.readBigUInt64BE(cursor + 8));
          if (!Number.isSafeInteger(length) || length < 16) throw new Error('图片容器损坏或截断');
        }
        if (length < 8 || cursor + length > bytes.length) throw new Error('图片容器损坏或截断');
        cursor += length;
      }
      return { bytes, mimeType: avif ? 'image/avif' : heic ? 'image/heic' : 'image/heif', extension: avif ? '.avif' : heic ? '.heic' : '.heif' };
    }
  }
  const svg = bytes.toString('utf8').replace(/^\uFEFF/u, '').trim();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(svg)
    && (/<\/svg\s*>\s*$/iu.test(svg) || /<svg\b[^>]*\/\s*>\s*$/iu.test(svg))) {
    return { bytes, mimeType: 'image/svg+xml', extension: '.svg' };
  }
  throw new Error('无法确认内嵌图片格式，或图片内容已损坏');
};

const safeStat = (fs, target) => { try { return fs.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } };
const ensureSafeDirectory = (fs, directory) => {
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (parent !== resolved) ensureSafeDirectory(fs, parent);
  let stat = safeStat(fs, resolved);
  if (!stat) { fs.mkdirSync(resolved); stat = fs.lstatSync(resolved); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('图片保存目录包含符号链接或非目录，已停止写入');
};
const assertSafeFile = (fs, root, destination) => {
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('图片保存路径越界');
  ensureSafeDirectory(fs, path.dirname(destination));
  const stat = safeStat(fs, destination);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('图片文件路径包含符号链接或非普通文件，已停止写入');
};
const writeNewFile = (filePath, bytes, fs) => {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx');
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* preserve original error */ } }
    if (safeStat(fs, temporary)) { try { fs.unlinkSync(temporary); } catch { /* leave recoverable temporary */ } }
  }
};

// Traverse only typed media positions. A data URL mentioned in a prompt, source
// document, arbitrary response, or frozen HTTP body is never rewritten.
const mapProjectMedia = (project, transform) => {
  if (!isRecord(project)) return project;
  const replaceProperty = (record, key, next) => next === record[key] ? record : { ...record, [key]: next };
  const mapSnapshot = (snapshot) => isRecord(snapshot)
    ? replaceProperty(snapshot, 'referenceAssetSnapshots', mapChanged(snapshot.referenceAssetSnapshots, transform)) : snapshot;
  const mapTask = (task) => {
    if (!isRecord(task)) return task;
    let next = task.kind === 'image' ? mapSnapshot(task) : task;
    const job = task.videoJob;
    if (isRecord(job)) {
      let nextJob = job;
      if (isRecord(job.snapshot)) nextJob = replaceProperty(nextJob, 'snapshot', replaceProperty(job.snapshot, 'images', mapChanged(job.snapshot.images, transform)));
      if (isRecord(job.tailPreparation?.selection?.frame)) {
        const selection = job.tailPreparation.selection;
        const nextSelection = replaceProperty(selection, 'frame', transform(selection.frame));
        nextJob = replaceProperty(nextJob, 'tailPreparation', replaceProperty(job.tailPreparation, 'selection', nextSelection));
      }
      next = replaceProperty(next, 'videoJob', nextJob);
    }
    return next;
  };
  const assets = mapChanged(project.assets, (asset) => {
    if (!isRecord(asset)) return asset;
    let next = transform(asset);
    if (isRecord(asset.imageRegenerationSnapshot)) next = replaceProperty(next, 'imageRegenerationSnapshot', mapSnapshot(asset.imageRegenerationSnapshot));
    if (isRecord(asset.videoSourceTask)) next = replaceProperty(next, 'videoSourceTask', mapTask(asset.videoSourceTask));
    return next;
  });
  let next = replaceProperty(project, 'assets', assets);
  next = replaceProperty(next, 'generationTasks', mapChanged(project.generationTasks, mapTask));
  return next;
};
const mapStateMedia = (state, transform) => {
  if (!isRecord(state)) return state;
  const project = mapProjectMedia(state.project, transform);
  const projects = mapChanged(state.projects, (item) => mapProjectMedia(item, transform));
  return project === state.project && projects === state.projects ? state : { ...state, project, ...(projects !== undefined ? { projects } : {}) };
};

const createStateMediaExternalizer = ({ assetRoot, fs = nodeFs, atomicWriteFile = writeNewFile }) => {
  if (typeof assetRoot !== 'string' || !assetRoot.trim()) throw new Error('图片保存目录为空');
  const root = path.resolve(assetRoot);
  return {
    externalize(state) {
      const verified = new Map();
      return mapStateMedia(state, (asset) => {
        if (!isRecord(asset)) return asset;
        const dataUrl = typeof asset.dataUrl === 'string' && /^data:/iu.test(asset.dataUrl.trim()) ? asset.dataUrl
          : typeof asset.url === 'string' && /^data:image\//iu.test(asset.url.trim()) ? asset.url : undefined;
        if (!dataUrl) return asset;
        // Video/audio asset payloads are outside this image-only migration.
        if (asset.mediaType === 'video' || asset.mediaType === 'audio' || asset.type === 'video' || asset.type === 'audio') return asset;
        const label = String(asset.name || asset.id || asset.assetId || '未命名图片').slice(0, 160);
        try {
          let metadata = verified.get(dataUrl);
          if (!metadata) {
            const { bytes, mimeType, extension } = decodeInlineImage(dataUrl);
            const checksum = hash(bytes);
            const relativePath = `image/${checksum}${extension}`;
            const destination = path.join(root, 'image', `${checksum}${extension}`);
            assertSafeFile(fs, root, destination);
            if (!safeStat(fs, destination)) atomicWriteFile(destination, bytes, fs);
            assertSafeFile(fs, root, destination);
            const stored = fs.readFileSync(destination);
            if (stored.length !== bytes.length || hash(stored) !== checksum) throw new Error('图片写入后 SHA-256 校验不一致，未切换存档引用');
            metadata = { relativePath, checksum, sizeBytes: bytes.length, mimeType, mediaType: 'image', managed: true,
              missing: false, url: `lianhua-asset://local/${relativePath}` };
            verified.set(dataUrl, metadata);
          }
          if (typeof asset.checksum === 'string' && asset.checksum && asset.checksum.toLowerCase() !== metadata.checksum) {
            throw new Error('图片内容与已保存的 SHA-256 不一致，未替换冻结的原图');
          }
          const { dataUrl: _inline, ...rest } = asset;
          return { ...rest, ...metadata };
        } catch (error) { throw mediaError(error, label); }
      });
    },
  };
};

const externalizeStateMedia = (state, options) => createStateMediaExternalizer(options).externalize(state);
const collectStateMediaFiles = (state) => {
  const files = new Map();
  mapStateMedia(state, (asset) => {
    if (!isRecord(asset) || typeof asset.relativePath !== 'string' || !asset.relativePath) return asset;
    const relativePath = asset.relativePath.replace(/\\/gu, '/');
    if (/^(?:\/|[a-z]:|[a-z]+:)/iu.test(relativePath) || /[\u0000-\u001f]/u.test(relativePath)
      || !relativePath.split('/').every((part) => part && part !== '.' && part !== '..')) throw new Error('媒体文件引用路径无效，已停止备份');
    const checksum = typeof asset.checksum === 'string' ? asset.checksum.toLowerCase() : undefined;
    const existing = files.get(relativePath);
    if (existing?.checksum && checksum && existing.checksum !== checksum) throw new Error(`媒体文件引用 SHA-256 冲突，已停止备份：${relativePath}`);
    if (!existing || !existing.checksum && checksum) files.set(relativePath, {
      id: asset.id || asset.assetId || relativePath, relativePath,
      ...(checksum ? { checksum } : {}), ...(typeof asset.sizeBytes === 'number' ? { sizeBytes: asset.sizeBytes } : {}),
    });
    return asset;
  });
  return [...files.values()];
};

module.exports = { createStateMediaExternalizer, externalizeStateMedia, collectStateMediaFiles };
