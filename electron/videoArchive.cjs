const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { crc32: nativeCrc32 } = require('node:zlib');
const yauzl = require('yauzl');
const { resolveMediaBinary, parseProbe } = require('./videoWorkbench.cjs');

const LIMITS = Object.freeze({ archiveBytes: 4 * 1024 ** 3, expandedBytes: 4 * 1024 ** 3, entryBytes: 4 * 1024 ** 3, entries: 1024, videos: 128, metadataBytes: 8 * 1024 ** 2, ratio: 1000, ratioThreshold: 16 * 1024 ** 2, timeoutMs: 10 * 60_000, probeTimeoutMs: 30_000 });
const VIDEO_FORMATS = { '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska' };
const MIME_TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const ZIP_MIME_TYPES = new Set(['application/zip', 'application/x-zip', 'application/x-zip-compressed']);
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const hasZipSignature = (bytes) => Buffer.isBuffer(bytes) && bytes.length >= 4 && [0x04034b50, 0x06054b50, 0x06064b50].includes(bytes.readUInt32LE(0));
const isZipContentType = (value) => ZIP_MIME_TYPES.has(String(value || '').split(';')[0].trim().toLowerCase());
const abortError = () => Object.assign(new Error('ZIP 视频接收已取消，未保存半成品'), { name: 'AbortError', code: 'ABORT_ERR' });
const assertActive = (signal) => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(); };
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); return value >>> 0; });
const updateCrc32 = nativeCrc32 || ((bytes, previous = 0) => { let value = (previous ^ 0xffffffff) >>> 0; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; });
const fileHash = async (filePath, signal) => { const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(filePath, { signal })) { assertActive(signal); hash.update(bytes); } return hash.digest('hex'); };
const safeFileName = (value, extension, fallback = '云端视频') => {
  const base = path.posix.basename(String(value || '').replace(/\\/gu, '/'));
  const stem = base.replace(/\.[^.]+$/u, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 100).replace(/[\uD800-\uDBFF]$/u, '') || fallback;
  return `${RESERVED_WINDOWS_NAME.test(stem) ? `_${stem}` : stem}${extension}`;
};

const validateEntry = (entry, state, limits) => {
  const name = entry.fileName;
  if (typeof name !== 'string' || !name || name.length > 1024 || /[\\:\u0000-\u001f\u007f<>"|?*\ufffd]/u.test(name) || name.startsWith('/')) throw new Error('ZIP 包含不安全或无法识别的成员路径');
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || RESERVED_WINDOWS_NAME.test(part))) throw new Error('ZIP 包含路径越界、设备名或歧义路径');
  const key = parts.join('/').normalize('NFC').toLowerCase();
  if (state.names.has(key)) throw new Error('ZIP 包含重复或大小写歧义的成员路径');
  state.names.add(key);
  if (directory && entry.uncompressedSize !== 0) throw new Error('ZIP 目录成员不应包含文件内容');
  const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (fileType && fileType !== (directory ? 0o040000 : 0o100000)) throw new Error('ZIP 包含符号链接或特殊文件，不会执行或导入');
  if (Boolean(entry.externalFileAttributes & 0x10) && !directory) throw new Error('ZIP 成员目录标记与路径不一致');
  if (entry.generalPurposeBitFlag & 0x41 || entry.extraFields.some((field) => field.id === 0x9901)) throw new Error('ZIP 已加密，无法自动提取视频；请输出未加密 ZIP');
  if (![0, 8].includes(entry.compressionMethod)) throw new Error('ZIP 压缩方式暂不支持，请使用标准存储或 Deflate ZIP');
  if (state.offsets.has(entry.relativeOffsetOfLocalHeader)) throw new Error('ZIP 成员重复引用相同文件数据');
  state.offsets.add(entry.relativeOffsetOfLocalHeader);
  for (const size of [entry.compressedSize, entry.uncompressedSize, entry.relativeOffsetOfLocalHeader]) if (!Number.isSafeInteger(size) || size < 0) throw new Error('ZIP 成员大小或偏移无效');
  if (entry.compressedSize > limits.archiveBytes || entry.uncompressedSize > limits.entryBytes) throw new Error('ZIP 成员超过视频提取大小限制');
  if (entry.uncompressedSize > limits.ratioThreshold && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.ratio) throw new Error('ZIP 解压倍率异常，已停止以防止内存或磁盘耗尽');
  state.expanded += entry.uncompressedSize;
  state.metadata += Buffer.byteLength(name) + Buffer.byteLength(entry.fileComment || '') + entry.extraFields.reduce((sum, field) => sum + field.data.length + 4, 0) + 46;
  if (state.expanded > limits.expandedBytes || state.metadata > limits.metadataBytes) throw new Error('ZIP 展开总量或目录信息超过安全限制');
  return { entry, directory };
};

const scanEntries = (zip, signal, limits) => new Promise((resolve, reject) => {
  const entries = [], state = { names: new Set(), offsets: new Set(), expanded: 0, metadata: 0 };
  const finish = (error) => { zip.removeListener('entry', next); zip.removeListener('end', ended); zip.removeListener('error', failed); signal.removeEventListener('abort', aborted); if (error) reject(error); else resolve(entries); };
  const failed = (error) => finish(error);
  const aborted = () => finish(abortError());
  const ended = () => finish();
  const next = (entry) => { try { assertActive(signal); if (entries.length >= limits.entries) throw new Error('ZIP 文件数量过多，已停止自动提取'); entries.push(validateEntry(entry, state, limits)); zip.readEntry(); } catch (error) { finish(error); } };
  zip.on('entry', next); zip.once('end', ended); zip.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
  try { assertActive(signal); if (zip.entryCount > limits.entries) throw new Error('ZIP 文件数量过多，已停止自动提取'); zip.readEntry(); } catch (error) { finish(error); }
});

const validateLocalHeaders = async (zip, entries, centralOffset, signal) => {
  const ranges = [];
  const memberTypes = new Map(entries.map(({ entry, directory }) => [entry.fileName.replace(/\/$/u, '').normalize('NFC').toLowerCase(), directory]));
  for (const { entry } of entries) {
    assertActive(signal);
    const segments = entry.fileName.replace(/\/$/u, '').normalize('NFC').toLowerCase().split('/');
    for (let index = 1; index < segments.length; index += 1) if (memberTypes.get(segments.slice(0, index).join('/')) === false) throw new Error('ZIP 同一路径同时作为文件和目录，存在歧义');
    const local = await zip.readLocalFileHeaderPromise(entry);
    const localExtra = yauzl.parseExtraFields(local.extraField);
    // Use the central Unicode-path extension when decoding the original filename;
    // common ZIP tools store this extension only in the central directory.
    const name = yauzl.getFileNameLowLevel(local.generalPurposeBitFlag, local.fileName, entry.extraFields, true);
    if (name !== entry.fileName || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || local.compressionMethod !== entry.compressionMethod || localExtra.some((field) => field.id === 0x9901)) throw new Error('ZIP 本地文件头与目录声明不一致');
    const descriptor = Boolean(local.generalPurposeBitFlag & 8);
    if (local.crc32 !== entry.crc32 && !(descriptor && local.crc32 === 0)) throw new Error('ZIP 文件头 CRC 与目录声明不一致');
    for (const property of ['compressedSize', 'uncompressedSize']) {
      if (local[property] !== entry[property] && !(descriptor && local[property] === 0) && !(local[property] === 0xffffffff && localExtra.some((field) => field.id === 1))) throw new Error('ZIP 文件头大小与目录声明不一致');
    }
    const end = local.fileDataStart + entry.compressedSize;
    if (end > centralOffset) throw new Error('ZIP 成员数据越过目录边界');
    ranges.push({ start: entry.relativeOffsetOfLocalHeader, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index].start < ranges[index - 1].end) throw new Error('ZIP 成员数据范围互相重叠');
};

const probeVideo = (filePath, extension, binary, signal, limits) => new Promise((resolve, reject) => {
  assertActive(signal);
  const args = ['-v', 'error', '-max_alloc', '268435456', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', VIDEO_FORMATS[extension]];
  if (VIDEO_FORMATS[extension] === 'mov') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
  args.push('-show_streams', '-show_format', '-of', 'json', filePath);
  const child = spawn(binary.path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(filePath) });
  let stdout = '', stderr = '', failure, killTimer, settled = false;
  const stop = (error) => { if (failure) return; failure = error; try { child.kill(); } catch { /* already stopped */ } killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already stopped */ } }, 1000); killTimer.unref?.(); };
  const onAbort = () => stop(abortError());
  const timer = setTimeout(() => stop(new Error('ZIP 内视频校验超时；云端任务已完成，可重试接收结果')), limits.probeTimeoutMs); timer.unref?.();
  const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', onAbort); if (error) reject(error); else resolve(result); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  child.stdout.on('data', (chunk) => { if (failure || settled) return; stdout += chunk.toString('utf8'); if (stdout.length > 1024 * 1024) stop(new Error('ZIP 视频校验返回的数据过大')); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-1200); });
  child.once('error', (error) => finish(error));
  child.once('close', (code) => { if (failure) { finish(failure); return; } if (code !== 0) { finish(new Error(`ZIP 内文件不是完整可用的视频：${stderr.trim() || '媒体解析失败'}`)); return; } try { finish(null, parseProbe(JSON.parse(stdout)).probe); } catch { finish(new Error('ZIP 内文件没有有效的视频画面或时长，未作为视频保存')); } });
});

const verifyPublishedDirectory = async (directory, files, signal) => {
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const names = await fs.promises.readdir(directory);
    if (names.length !== files.length || files.some((file) => !names.includes(file.fileName))) return false;
    for (const file of files) { assertActive(signal); const target = path.join(directory, file.fileName); const current = await fs.promises.lstat(target); if (!current.isFile() || current.isSymbolicLink() || current.size !== file.sizeBytes || await fileHash(target, signal) !== file.checksum) return false; }
    return true;
  } catch (error) { assertActive(signal); if (error.code === 'ENOENT') return false; throw error; }
};

/** Only ordinary media files are emitted. Names inside the ZIP are never used as extraction paths. */
const importVideoArchive = async (options) => {
  const limits = { ...LIMITS, ...options.limits };
  const controller = new AbortController();
  const cancelled = () => controller.abort(abortError());
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('ZIP 视频提取超时；云端结果仍可重新接收，无需重新生成')), limits.timeoutMs); timer.unref?.();
  let directory, publicationStage, zip, zipClosed = false, activeStream, zipFailure;
  const closeZip = async () => { if (!zip || zipClosed) return; await new Promise((resolve) => { zip.once('close', resolve); zip.close(); }); };
  try {
    assertActive(signal);
    if (!/^[a-f\d]{64}$/u.test(options.checksum)) throw new Error('ZIP 下载校验码无效');
    const stat = await fs.promises.lstat(options.archivePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > limits.archiveBytes) throw new Error('ZIP 文件为空、不是普通文件或超过 4 GB 限制');
    const tempRoot = await fs.promises.realpath(options.tempRoot);
    if (!inside(tempRoot, await fs.promises.realpath(options.archivePath))) throw new Error('ZIP 只能从本次隔离下载目录提取');
    directory = await fs.promises.mkdtemp(path.join(tempRoot, 'video-archive-'));
    zip = await new Promise((resolve, reject) => yauzl.open(options.archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
    zip.on('close', () => { zipClosed = true; });
    zip.on('error', (error) => { zipFailure = error; activeStream?.destroy(error); });
    const centralOffset = zip.readEntryCursor;
    const entries = await scanEntries(zip, signal, limits);
    await validateLocalHeaders(zip, entries, centralOffset, signal);
    const files = [];
    let expanded = 0, lastProgress = 0;
    const binary = resolveMediaBinary('ffprobe', options);
    if (!binary) throw new Error('自动接收 ZIP 视频需要 FFprobe，请使用带媒体工具的完整便携包');
    for (const { entry, directory: isDirectory } of entries) {
      assertActive(signal); if (zipFailure) throw zipFailure;
      if (isDirectory) continue;
      const candidatePath = path.join(directory, `${randomUUID()}.media`);
      const handle = await fs.promises.open(candidatePath, 'wx');
      let signature = Buffer.alloc(0), sizeBytes = 0, crc = 0;
      const hash = createHash('sha256');
      try {
        activeStream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
        const stream = activeStream;
        const onAbort = () => stream.destroy(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          assertActive(signal);
          for await (const chunk of stream) {
            assertActive(signal); sizeBytes += chunk.length; expanded += chunk.length;
            if (sizeBytes > entry.uncompressedSize || sizeBytes > limits.entryBytes || expanded > limits.expandedBytes) throw new Error('ZIP 实际展开大小超过声明或安全限制');
            crc = updateCrc32(chunk, crc); hash.update(chunk);
            if (signature.length < 4096) signature = Buffer.concat([signature, chunk.subarray(0, 4096 - signature.length)]);
            await handle.writeFile(chunk);
            if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); options.onProgress?.({ phase: 'extracting', extractedBytes: expanded, files: files.length }); }
          }
        } finally { signal.removeEventListener('abort', onAbort); stream.destroy(); activeStream = undefined; }
        if (sizeBytes !== entry.uncompressedSize || (crc >>> 0) !== (entry.crc32 >>> 0)) throw new Error('ZIP 文件校验失败（大小或 CRC 不符），请重新接收云端结果');
        await handle.sync();
      } finally { await handle.close(); }
      assertActive(signal);
      let extension;
      try { extension = options.sniffMediaExtension(signature); } catch { extension = ''; }
      if (!VIDEO_FORMATS[extension]) {
        if (VIDEO_FORMATS[path.posix.extname(entry.fileName).toLowerCase()]) throw new Error('ZIP 内标记为视频的文件没有有效视频容器签名');
        await fs.promises.unlink(candidatePath); continue;
      }
      if (files.length >= limits.videos) throw new Error('ZIP 中视频数量过多，已停止自动接收');
      options.onProgress?.({ phase: 'verifying', extractedBytes: expanded, files: files.length });
      const probe = await probeVideo(candidatePath, extension, binary, signal, limits);
      files.push({ temporaryPath: candidatePath, originalFileName: entry.fileName, fileName: safeFileName(entry.fileName, extension), extension, sizeBytes, checksum: hash.digest('hex'), probe });
    }
    await closeZip();
    assertActive(signal);
    if (!files.length) {
      const fileCount = entries.filter(({ directory: isDirectory }) => !isDirectory).length;
      throw Object.assign(new Error('当前 ZIP 已接收，但没有可用的 MP4、MOV 或 WebM 视频候选；这不代表云端任务没有其他视频输出'), {
        code: 'VIDEO_ARCHIVE_NO_VIDEO',
        // Only counts leave the extractor: no upstream URLs, credentials,
        // member filenames or text contents belong in task diagnostics.
        details: { entryCount: entries.length, fileCount, skippedFileCount: fileCount, videoCandidateCount: 0 },
      });
    }
    if (files.length === 1 && String(options.fileName || '').trim()) files[0].fileName = safeFileName(options.fileName, files[0].extension);
    const usedNames = new Set();
    for (const file of files) { const original = file.fileName; let suffix = 1; while (usedNames.has(file.fileName.normalize('NFC').toLowerCase())) { suffix += 1; file.fileName = `${path.basename(original, file.extension)} (${suffix})${file.extension}`; } usedNames.add(file.fileName.normalize('NFC').toLowerCase()); }
    const assetRoot = await fs.promises.realpath(options.assetRoot);
    const videoRoot = path.join(assetRoot, 'video');
    await fs.promises.mkdir(videoRoot, { recursive: true });
    if ((await fs.promises.lstat(videoRoot)).isSymbolicLink() || !inside(assetRoot, await fs.promises.realpath(videoRoot))) throw new Error('托管视频目录不允许指向资产库外部');
    publicationStage = await fs.promises.mkdtemp(path.join(videoRoot, '.archive-pending-'));
    for (const file of files) {
      assertActive(signal);
      const target = path.join(publicationStage, file.fileName);
      try { await fs.promises.link(file.temporaryPath, target); } catch (error) { if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error; await fs.promises.copyFile(file.temporaryPath, target, fs.constants.COPYFILE_EXCL); }
    }
    let destination = path.join(videoRoot, `archive-${options.checksum}`);
    for (let attempt = 0; ; attempt += 1) {
      assertActive(signal);
      let exists = false;
      try { await fs.promises.lstat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) { if (await verifyPublishedDirectory(destination, files, signal)) break; destination = path.join(videoRoot, `archive-${options.checksum}-${randomUUID()}`); }
      if (attempt > 8) throw new Error('无法分配 ZIP 视频的安全保存目录');
      assertActive(signal);
      try { await fs.promises.rename(publicationStage, destination); publicationStage = undefined; break; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; }
    }
    // Publication is atomic. Never remove a published directory after cancellation:
    // another successful task may already share it. Only our private stages are cleaned.
    const results = files.map((file) => {
      const relativePath = path.relative(assetRoot, path.join(destination, file.fileName)).replace(/\\/gu, '/');
      return { fileName: file.fileName, relativePath, checksum: file.checksum, sizeBytes: file.sizeBytes, mediaType: 'video', mimeType: MIME_TYPES[file.extension], managed: true, missing: false, url: `lianhua-asset://local/${relativePath.split('/').map(encodeURIComponent).join('/')}`, probe: file.probe };
    });
    return { ...results[0], additionalVideos: results.length > 1 ? results.slice(1) : undefined, archiveFileName: safeFileName(options.archiveFileName, '.zip', '云端视频') };
  } catch (error) {
    assertActive(signal);
    if (/ZIP|视频|FFprobe|托管/u.test(error.message || '')) throw error;
    throw new Error(`ZIP 视频接收失败：${String(error.message || '压缩包无法读取').slice(0, 400)}`);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled);
    activeStream?.destroy();
    await closeZip();
    if (publicationStage) await fs.promises.rm(publicationStage, { recursive: true, force: true });
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

module.exports = { importVideoArchive, hasZipSignature, isZipContentType, validateEntry, LIMITS, updateCrc32 };
