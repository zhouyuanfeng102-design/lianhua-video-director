const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveManagedSource, resolveMediaBinary } = require('./videoWorkbench.cjs');

const MAX_WIDTH = 480;
const MAX_HEIGHT = 270;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const CACHE_FILE = /^[a-f\d]{64}\.png$/u;
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const pngCrc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const abortError = () => Object.assign(new Error('视频缩略图请求已取消'), { name: 'AbortError' });
const assertActive = (job) => { if (job.cancelled) throw abortError(); };
const validId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) throw new Error(`${label}无效`);
  return value;
};
const normalizeRequest = (request) => {
  const projectId = validId(request?.projectId, '项目 ID');
  const assetId = validId(request?.assetId, '素材 ID');
  const relative = request?.relativePath;
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[:\u0000-\u001f]/u.test(relative) || path.isAbsolute(relative)) throw new Error('缩略图仅支持资产库中的本地视频');
  const parts = relative.replace(/\\/gu, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('资产路径越界');
  if (!['.mp4', '.mov', '.webm', '.mkv'].includes(path.extname(relative).toLowerCase())) throw new Error('不支持的视频格式');
  const expectedChecksum = request.expectedChecksum === '' ? undefined : request.expectedChecksum;
  if (expectedChecksum !== undefined && (typeof expectedChecksum !== 'string' || !/^[a-f\d]{64}$/iu.test(expectedChecksum))) throw new Error('素材校验码无效');
  return { projectId, assetId, relativePath: parts.join('/'), expectedChecksum: expectedChecksum?.toLowerCase() };
};
const statIdentity = (source) => [source.path, source.stat.size, source.stat.mtimeMs, source.stat.ctimeMs, source.stat.ino, source.stat.dev];
const thumbnailPng = (bytes) => {
  if (bytes.length < 57 || bytes.length > MAX_PNG_BYTES
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw new Error('视频缩略图格式无效');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_WIDTH || height > MAX_HEIGHT) throw new Error('视频缩略图尺寸无效');
  let hasPixels = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('视频缩略图格式无效');
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length || pngCrc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('视频缩略图格式无效');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if ((type === 'IHDR' && offset !== 8) || (type === 'IEND' && end !== bytes.length)) throw new Error('视频缩略图格式无效');
    if (type === 'IDAT') hasPixels = true;
    offset = end;
  }
  if (!hasPixels) throw new Error('视频缩略图格式无效');
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, mimeType: 'image/png', width, height, sizeBytes: bytes.length };
};

/** A read-only video worker: one decoder, bounded pending jobs, coalesced sources, disposable cache. */
const createVideoThumbnailService = (options) => {
  const assetRoot = path.resolve(options.assetRoot);
  const cacheRoot = path.resolve(options.cacheRoot);
  const cacheDirectory = path.join(cacheRoot, 'video-thumbnails');
  const spawnProcess = options.spawn || spawn;
  const maxPending = options.maxPending ?? 48;
  const maxCacheEntries = options.maxCacheEntries ?? 512;
  const maxCacheBytes = options.maxCacheBytes ?? 128 * 1024 * 1024;
  const jobs = new Map();
  const queue = [];
  let active;
  let closed = false;
  let disabledError;
  let unconfirmedDecoder;

  const ensureCacheDirectory = async () => {
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const root = await fs.promises.realpath(cacheRoot);
    const actual = await fs.promises.realpath(cacheDirectory);
    const relative = path.relative(root, actual);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('视频缩略图缓存路径越界');
    return actual;
  };
  const pruneCache = async (directory) => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !CACHE_FILE.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try { const stat = await fs.promises.lstat(filePath); if (stat.isFile()) files.push({ filePath, size: stat.size, time: stat.mtimeMs }); } catch { /* another cleanup */ }
    }
    files.sort((a, b) => a.time - b.time);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    while (files.length > maxCacheEntries || totalBytes > maxCacheBytes) {
      const file = files.shift();
      if (!file) break;
      // Only this worker's hashed cache files; never recurse or touch source media.
      try { await fs.promises.unlink(file.filePath); totalBytes -= file.size; } catch { /* cache cleanup is best-effort */ }
    }
  };
  const decode = (source, binary, job) => new Promise((resolve, reject) => {
    assertActive(job);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-f', source.format];
    if (source.format === 'mov') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
    args.push('-i', source.path, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=w='min(${MAX_WIDTH},iw)':h='min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,setsar=1`, '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1');
    let child;
    try { child = spawnProcess(binary.path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: cacheRoot }); }
    catch (error) { reject(error); return; }
    let error;
    let size = 0;
    let stderr = '';
    const chunks = [];
    let killTimer;
    let closeTimer;
    let settled = false;
    let exited = false;
    const finish = (failure, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer); job.stop = null;
      if (failure) reject(failure); else resolve(bytes);
    };
    const requireDecoderExit = () => {
      if (settled) return;
      if (!exited) {
        // Do not release the single-decoder slot into another live process. Reject all
        // subscribers and suspend this worker when even SIGKILL has no confirmed exit.
        disabledError = new Error('视频缩略图进程未能退出，已暂停缩略图加载；仍可点击播放，重启软件后可重试');
        closed = true; unconfirmedDecoder = child;
        for (const queued of jobs.values()) {
          queued.cancelled = true;
          for (const waiter of queued.waiters.values()) waiter.reject(disabledError);
          queued.waiters.clear();
        }
        jobs.clear(); queue.length = 0;
      }
      finish(disabledError || (job.cancelled ? abortError() : error || new Error('视频缩略图进程异常退出')));
      child.stdout.destroy(); child.stderr.destroy();
    };
    const stop = () => {
      if (settled || killTimer) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        closeTimer = setTimeout(requireDecoderExit, options.closeGraceMs ?? 1000);
        closeTimer.unref?.();
        try { child.kill('SIGKILL'); } catch { /* watchdog verifies the actual exit */ }
      }, options.killGraceMs ?? 1000);
      killTimer.unref?.();
      try { child.kill(); } catch { /* watchdog verifies the actual exit */ }
    };
    job.stop = stop;
    const timer = setTimeout(() => { error = new Error('视频缩略图生成超时，可点击播放查看视频'); stop(); }, options.timeoutMs ?? 20000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      if (settled || error) return;
      size += chunk.length;
      if (size > MAX_PNG_BYTES) { error = new Error('视频缩略图输出过大'); stop(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (!settled) stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.once('error', (caught) => { if (!settled) { error = caught; stop(); } });
    child.once('exit', () => { exited = true; if (unconfirmedDecoder === child) unconfirmedDecoder = undefined; });
    child.once('close', (code) => {
      exited = true;
      if (unconfirmedDecoder === child) unconfirmedDecoder = undefined;
      if (job.cancelled) finish(abortError());
      else if (error) finish(error);
      else if (code !== 0) finish(new Error(`无法生成视频缩略图：${stderr.trim() || '视频可能损坏或格式不受支持'}`));
      else finish(null, Buffer.concat(chunks));
    });
  });
  const assertSourceUnchanged = async (job, identity) => {
    const current = await resolveManagedSource(assetRoot, { assetId: job.request.assetId, relativePath: job.request.relativePath }, 'video', job);
    if (JSON.stringify(statIdentity(current)) !== identity) throw new Error('视频文件在准备缩略图时发生变化，请刷新后重试');
    assertActive(job);
  };
  const execute = async (job) => {
    assertActive(job);
    // Cheap path/stat validation happens on every request; full checksum verification only
    // on an uncached identity. A replaced/modified file automatically gets a new cache key.
    const source = await resolveManagedSource(assetRoot, { assetId: job.request.assetId, relativePath: job.request.relativePath }, 'video', job);
    const identity = JSON.stringify(statIdentity(source));
    const cacheKey = createHash('sha256').update(JSON.stringify(['thumbnail-v1', identity, job.request.expectedChecksum || ''])).digest('hex');
    const directory = await ensureCacheDirectory();
    const target = path.join(directory, `${cacheKey}.png`);
    let cached;
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isFile() && stat.size <= MAX_PNG_BYTES) {
        const bytes = await fs.promises.readFile(target);
        assertActive(job);
        cached = { ...thumbnailPng(bytes), cacheKey };
      }
    } catch (error) { if (job.cancelled) throw error; /* missing or invalid cache is regenerated */ }
    if (cached) {
      // readFile yields: the source may be replaced while its previous cached PNG is read.
      // Keep this check outside the cache-corruption catch; a changed source must fail closed.
      await assertSourceUnchanged(job, identity);
      return cached;
    }
    assertActive(job);
    if (job.request.expectedChecksum) await resolveManagedSource(assetRoot, job.request, 'video', job);
    const binary = resolveMediaBinary('ffmpeg', options);
    if (!binary) throw new Error('未找到 FFmpeg，缩略图暂不可用；仍可点击播放视频');
    const bytes = await decode(source, binary, job);
    const result = { ...thumbnailPng(bytes), cacheKey };
    await assertSourceUnchanged(job, identity);
    const temporary = path.join(directory, `${cacheKey}.${randomUUID()}.pending`);
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
      assertActive(job);
      await fs.promises.rename(temporary, target);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
    // The cache is expendable and bounded. Its cleanup must not make a valid thumbnail fail.
    await pruneCache(directory).catch(() => {});
    assertActive(job);
    return result;
  };
  const pump = () => {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) return;
    if (job.cancelled) { pump(); return; }
    active = job;
    const finish = (error, result) => {
      const waiters = [...job.waiters.values()];
      job.waiters.clear();
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      active = undefined;
      pump();
      for (const waiter of waiters) { if (error) waiter.reject(error); else waiter.resolve(result); }
    };
    execute(job).then((result) => finish(null, result), (error) => finish(error));
  };
  const cancel = (ownerId, projectId) => {
    let cancelled = 0;
    for (const job of jobs.values()) {
      for (const [key, waiter] of job.waiters) {
        if (waiter.ownerId !== ownerId || (projectId !== undefined && waiter.projectId !== projectId)) continue;
        job.waiters.delete(key); waiter.reject(abortError()); cancelled += 1;
      }
      if (!job.waiters.size) {
        job.cancelled = true; job.stop?.();
        jobs.delete(job.key);
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
      }
    }
    return cancelled;
  };
  return {
    get(request, ownerId) {
      try {
        if (disabledError) throw disabledError;
        if (closed) throw abortError();
        if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error('缩略图请求来源无效');
        const normalized = normalizeRequest(request);
        const normalizedPath = process.platform === 'win32' ? normalized.relativePath.toLowerCase() : normalized.relativePath;
        const key = JSON.stringify([normalizedPath, normalized.expectedChecksum || '']);
        let job = jobs.get(key);
        if (!job) {
          if (jobs.size >= maxPending) throw new Error('视频缩略图队列已满，请稍后刷新');
          job = { key, request: normalized, waiters: new Map(), cancelled: false, stop: null };
          jobs.set(key, job); queue.push(job);
        }
        const waiterKey = JSON.stringify([ownerId, normalized.projectId]);
        const previous = job.waiters.get(waiterKey);
        if (previous) return previous.promise;
        if (job.waiters.size >= 128) throw new Error('视频缩略图请求过多');
        let resolve; let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        job.waiters.set(waiterKey, { promise, resolve, reject, ownerId, projectId: normalized.projectId });
        pump();
        return promise;
      } catch (error) { return Promise.reject(error); }
    },
    cancelProject(projectId, ownerId) { validId(projectId, '项目 ID'); return cancel(ownerId, projectId); },
    cancelOwner(ownerId) { return cancel(ownerId); },
    canRestart() { return closed && !active && !unconfirmedDecoder; },
    close() {
      closed = true;
      try { unconfirmedDecoder?.kill('SIGKILL'); } catch { /* keep the worker disabled until exit is confirmed */ }
      for (const job of jobs.values()) {
        job.cancelled = true; job.stop?.();
        for (const waiter of job.waiters.values()) waiter.reject(abortError());
        job.waiters.clear();
      }
      jobs.clear(); queue.length = 0;
    },
  };
};

module.exports = { createVideoThumbnailService, normalizeRequest, thumbnailPng, MAX_WIDTH, MAX_HEIGHT };
