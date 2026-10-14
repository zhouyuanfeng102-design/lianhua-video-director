const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { resolveMediaBinary } = require('./videoWorkbench.cjs');

const MAX_SIDE = 160;
const MAX_PNG_BYTES = 256 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif']);
const CACHE_FILE = /^[a-f\d]{64}\.png$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
const abortError = () => Object.assign(new Error('图片缩略图请求已取消'), { name: 'AbortError' });
const assertActive = (job) => { if (job.cancelled) throw abortError(); };
const pathKey = (filePath) => process.platform === 'win32' ? filePath.toLowerCase() : filePath;
const isInside = (root, candidate) => {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const normalizeRequest = (request) => {
  const relative = request?.relativePath;
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[:\u0000-\u001f]/u.test(relative) || path.isAbsolute(relative)) throw new Error('缩略图仅支持资产库中的本地图片');
  const parts = relative.replace(/\\/gu, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('资产路径越界');
  if (!IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error('不支持的图片格式');
  const expectedChecksum = request.expectedChecksum === '' ? undefined : request.expectedChecksum;
  if (expectedChecksum !== undefined && (typeof expectedChecksum !== 'string' || !/^[a-f\d]{64}$/iu.test(expectedChecksum))) throw new Error('素材校验码无效');
  return { relativePath: parts.join('/'), expectedChecksum: expectedChecksum?.toLowerCase() };
};

const thumbnailResult = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_PNG_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('图片缩略图格式无效');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) throw new Error('图片缩略图尺寸无效');
  let hasPixels = false;
  let complete = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('图片缩略图格式无效');
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length || pngCrc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('图片缩略图格式无效');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if ((type === 'IHDR' && offset !== 8) || (type === 'IEND' && (length !== 0 || end !== bytes.length))) throw new Error('图片缩略图格式无效');
    if (type === 'IDAT' && length) hasPixels = true;
    if (type === 'IEND') complete = true;
    offset = end;
  }
  if (!hasPixels || !complete) throw new Error('图片缩略图格式无效');
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, mimeType: 'image/png', width, height, sizeBytes: bytes.length };
};

const decodeThumbnail = (filePath, options, onUnconfirmedExit, job) => new Promise((resolve, reject) => {
  const binary = resolveMediaBinary('ffmpeg', options);
  if (!binary) { reject(new Error('未找到 FFmpeg，图片缩略图暂不可用')); return; }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', `scale=w='min(${MAX_SIDE},iw)':h='min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease,setsar=1`,
    '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'];
  let child;
  try { child = (options.spawn || spawn)(binary.path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { reject(error); return; }
  if (child.pid) options.onChildSpawn?.(child.pid);
  let failure;
  let size = 0;
  let stderr = '';
  const chunks = [];
  let settled = false;
  let exited = false;
  let killTimer;
  let closeTimer;
  const finish = (error, bytes) => {
    if (settled) return;
    settled = true;
    job.stop = undefined;
    clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
    if (error) reject(error); else resolve(bytes);
  };
  const stop = () => {
    if (settled || killTimer) return;
    try { child.kill(); } catch { /* force kill follows */ }
    killTimer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* verify exit before releasing decoder capacity */ }
      closeTimer = setTimeout(() => {
        if (settled) return;
        if (!exited) onUnconfirmedExit(new Error('图片缩略图进程未能退出，已暂停缩略图加载；重启软件后可重试'));
        finish(failure || new Error('图片缩略图进程未能正常退出'));
        child.stdout.destroy(); child.stderr.destroy();
      }, options.closeGraceMs ?? 1000);
      closeTimer.unref?.();
    }, options.killGraceMs ?? 1000);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => { failure = new Error('图片缩略图生成超时'); stop(); }, options.timeoutMs ?? 20000);
  timer.unref?.();
  job.stop = () => { failure = abortError(); stop(); };
  child.stdout.on('data', (chunk) => {
    if (settled || failure) return;
    size += chunk.length;
    if (size > MAX_PNG_BYTES) { failure = new Error('图片缩略图输出过大'); stop(); return; }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => { if (!settled) stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
  child.once('error', (error) => { failure = error; if (child.pid) stop(); else finish(error); });
  child.once('exit', () => { exited = true; });
  child.once('close', (code) => {
    exited = true;
    if (failure) finish(failure);
    else if (code !== 0) finish(new Error(`无法生成图片缩略图：${stderr.trim() || '图片可能损坏或格式不受支持'}`));
    else finish(null, Buffer.concat(chunks));
  });
});

const createWorkerDecoder = (options, onFailure) => {
  const binary = resolveMediaBinary('ffmpeg', options);
  if (!binary) throw new Error('未找到 FFmpeg，图片缩略图暂不可用');
  const worker = new Worker(path.join(__dirname, 'imageThumbnailWorker.cjs'), {
    workerData: { ffmpegPath: binary.path, timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs, closeGraceMs: options.closeGraceMs },
  });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  worker.unref();
  const killChildren = () => {
    for (const request of pending.values()) {
      if (request.pid) { try { process.kill(request.pid, 'SIGKILL'); } catch { /* child may have already exited */ } }
    }
  };
  const fail = (error) => {
    closed = true; killChildren();
    for (const request of pending.values()) { request.job.stop = undefined; request.reject(error); }
    pending.clear(); worker.unref();
    onFailure(error);
  };
  worker.on('message', (message) => {
    if (message.type === 'suspended') { fail(new Error(message.message)); return; }
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === 'started') { request.pid = message.pid; return; }
    pending.delete(message.id); request.job.stop = undefined;
    if (!pending.size) worker.unref();
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
    else request.resolve(Buffer.from(message.bytes));
  });
  worker.on('error', fail);
  worker.on('exit', (code) => { if (!closed || pending.size) fail(new Error(`图片缩略图后台进程异常退出（${code}）`)); });
  return {
    decode(filePath, job) {
      if (closed) return Promise.reject(abortError());
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { job, resolve, reject }));
      job.stop = () => worker.postMessage({ type: 'cancel', id });
      worker.ref(); worker.postMessage({ type: 'decode', id, filePath });
      return promise;
    },
    close() {
      closed = true;
      worker.postMessage({ type: 'close' });
      killChildren();
      // The worker kills and confirms child exits, then closes its port naturally.
    },
  };
};

/** Source files stay read-only; only small PNGs enter the bounded preview caches. */
const createImageThumbnailService = (options) => {
  const assetRoot = path.resolve(options.assetRoot);
  const cacheRoot = path.resolve(options.cacheRoot);
  const cacheDirectory = path.join(cacheRoot, 'image-thumbnails');
  let workerDecoder;
  // Both native thumbnail APIs and Windows process creation can block the caller.
  // Keep original decoding AND hidden FFmpeg process creation on a background worker.
  const generateThumbnail = options.generateThumbnail || ((filePath, _size, job) => {
    if (options.spawn) return decodeThumbnail(filePath, options, suspendDecoder, job);
    workerDecoder ||= createWorkerDecoder(options, suspendDecoder);
    return workerDecoder.decode(filePath, job);
  });
  const concurrency = options.concurrency ?? 2;
  const maxPending = options.maxPending ?? 48;
  const maxMemoryEntries = options.maxMemoryEntries ?? 128;
  const maxMemoryBytes = options.maxMemoryBytes ?? 8 * 1024 * 1024;
  const maxCacheEntries = options.maxCacheEntries ?? 512;
  const maxCacheBytes = options.maxCacheBytes ?? 32 * 1024 * 1024;
  const jobs = new Map();
  const queue = [];
  const memory = new Map();
  const disk = new Map();
  let memoryBytes = 0;
  let diskBytes = 0;
  let active = 0;
  let closed = false;
  let directoryPromise;
  let cacheMaintenance = Promise.resolve();

  const suspendDecoder = (error) => {
    closed = true;
    for (const job of jobs.values()) {
      job.cancelled = true;
      job.stop?.();
      for (const waiter of job.waiters.values()) waiter.reject(error);
      job.waiters.clear();
    }
    jobs.clear(); queue.length = 0;
  };

  const resolveSource = async (request) => {
    const root = await fs.promises.realpath(assetRoot);
    const filePath = await fs.promises.realpath(path.resolve(root, ...request.relativePath.split('/')));
    if (!isInside(root, filePath)) throw new Error('图片真实路径越界');
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size <= 0 || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('图片文件不可用');
    const identity = JSON.stringify([pathKey(filePath), stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]);
    // Preview identity is cheap metadata, never a synchronous read/hash of the original.
    const cacheKey = createHash('sha256').update(JSON.stringify(['image-thumbnail-v1', MAX_SIDE, identity, request.expectedChecksum || ''])).digest('hex');
    return { filePath, identity, cacheKey };
  };
  const remember = (key, result) => {
    const previous = memory.get(key);
    if (previous) { memoryBytes -= previous.bytes; memory.delete(key); }
    // Base64 strings cost more than their PNG byte buffers.
    const bytes = result.dataUrl.length * 2;
    if (bytes > maxMemoryBytes) return;
    memory.set(key, { result, bytes }); memoryBytes += bytes;
    while (memory.size > maxMemoryEntries || memoryBytes > maxMemoryBytes) {
      const oldest = memory.keys().next().value;
      memoryBytes -= memory.get(oldest).bytes; memory.delete(oldest);
    }
  };
  const pruneDisk = async (directory) => {
    while (disk.size > maxCacheEntries || diskBytes > maxCacheBytes) {
      const [name, size] = disk.entries().next().value;
      disk.delete(name); diskBytes -= size;
      await fs.promises.unlink(path.join(directory, name)).catch(() => {});
    }
  };
  const ensureDirectory = () => {
    if (!directoryPromise) directoryPromise = (async () => {
      await fs.promises.mkdir(cacheDirectory, { recursive: true });
      const root = await fs.promises.realpath(cacheRoot);
      const directory = await fs.promises.realpath(cacheDirectory);
      if (!isInside(root, directory)) throw new Error('图片缩略图缓存路径越界');
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || !CACHE_FILE.test(entry.name)) continue;
        try {
          const stat = await fs.promises.lstat(path.join(directory, entry.name));
          if (stat.isFile()) files.push({ name: entry.name, size: stat.size, time: stat.mtimeMs });
        } catch { /* cache entries are disposable */ }
      }
      files.sort((left, right) => left.time - right.time);
      for (const file of files) { disk.set(file.name, file.size); diskBytes += file.size; }
      await pruneDisk(directory);
      return directory;
    })().catch((error) => { directoryPromise = undefined; disk.clear(); diskBytes = 0; throw error; });
    return directoryPromise;
  };
  const assertSourceUnchanged = async (job, source) => {
    const current = await resolveSource(job.request);
    assertActive(job);
    if (current.identity !== source.identity) throw new Error('图片在准备缩略图时发生变化，请重新打开后重试');
  };
  const readCache = async (directory, name) => {
    const target = path.join(directory, name);
    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.size > MAX_PNG_BYTES) return undefined;
      return thumbnailResult(await fs.promises.readFile(target));
    } catch { return undefined; }
  };
  const writeCache = (directory, name, bytes, job) => {
    // Serialize cache accounting and eviction, not decoding or source reads.
    const pending = cacheMaintenance.then(async () => {
      assertActive(job);
      const temporary = path.join(directory, `${name}.${randomUUID()}.pending`);
      try {
        await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
        assertActive(job);
        await fs.promises.rename(temporary, path.join(directory, name));
      } finally { await fs.promises.unlink(temporary).catch(() => {}); }
      if (disk.has(name)) { diskBytes -= disk.get(name); disk.delete(name); }
      disk.set(name, bytes.length); diskBytes += bytes.length;
      await pruneDisk(directory);
    });
    cacheMaintenance = pending.catch(() => {});
    return pending;
  };
  const execute = async (job) => {
    assertActive(job);
    const source = await resolveSource(job.request);
    assertActive(job);
    const cached = memory.get(source.cacheKey);
    if (cached) {
      memory.delete(source.cacheKey); memory.set(source.cacheKey, cached);
      return cached.result;
    }
    let directory;
    try { directory = await ensureDirectory(); } catch { /* previews also work with memory cache alone */ }
    assertActive(job);
    const name = `${source.cacheKey}.png`;
    const stored = directory && await readCache(directory, name);
    assertActive(job);
    if (stored) {
      await assertSourceUnchanged(job, source);
      remember(source.cacheKey, stored);
      return stored;
    }
    let image = await generateThumbnail(source.filePath, { width: MAX_SIDE, height: MAX_SIDE }, job);
    assertActive(job);
    let bytes;
    if (Buffer.isBuffer(image)) bytes = image;
    else {
      if (!image || image.isEmpty()) throw new Error('无法生成图片缩略图');
      const size = image.getSize();
      if (!size.width || !size.height) throw new Error('图片缩略图尺寸无效');
      // Allow an injected native generator without ever encoding its oversized result.
      if (size.width > MAX_SIDE || size.height > MAX_SIDE) {
        const ratio = MAX_SIDE / Math.max(size.width, size.height);
        image = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' });
      }
      bytes = image.toPNG();
    }
    const result = thumbnailResult(bytes);
    await assertSourceUnchanged(job, source);
    if (directory) {
      try { await writeCache(directory, name, bytes, job); } catch (error) { if (job.cancelled) throw error; /* cache failure must not hide a valid preview */ }
    }
    assertActive(job);
    remember(source.cacheKey, result);
    return result;
  };
  const pump = () => {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      active += 1; job.active = true;
      const finish = (error, result) => {
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        active -= 1;
        for (const waiter of job.waiters.values()) { if (error) waiter.reject(error); else waiter.resolve(result); }
        job.waiters.clear();
        pump();
      };
      execute(job).then((result) => finish(null, result), (error) => finish(error));
    }
  };
  const cancelOwner = (ownerId) => {
    let count = 0;
    for (const job of jobs.values()) {
      const waiter = job.waiters.get(ownerId);
      if (!waiter) continue;
      job.waiters.delete(ownerId); waiter.reject(abortError()); count += 1;
      if (!job.waiters.size) {
        job.cancelled = true;
        job.stop?.();
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
        // Keep the decoder slot until its exit is confirmed, including after cancellation.
      }
    }
    return count;
  };
  return {
    get(request, ownerId) {
      try {
        if (closed) throw abortError();
        if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error('缩略图请求来源无效');
        const normalized = normalizeRequest(request);
        const key = JSON.stringify([pathKey(normalized.relativePath), normalized.expectedChecksum || '']);
        let job = jobs.get(key);
        if (!job) {
          if (jobs.size >= maxPending) throw new Error('图片缩略图队列已满，请稍后重试');
          job = { key, request: normalized, waiters: new Map(), cancelled: false, active: false };
          jobs.set(key, job); queue.push(job);
        }
        const previous = job.waiters.get(ownerId);
        if (previous) return previous.promise;
        if (job.waiters.size >= 128) throw new Error('图片缩略图请求过多');
        let resolve; let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        job.waiters.set(ownerId, { promise, resolve, reject });
        pump();
        return promise;
      } catch (error) { return Promise.reject(error); }
    },
    cancelOwner,
    close() {
      closed = true;
      for (const job of jobs.values()) {
        job.cancelled = true;
        job.stop?.();
        for (const waiter of job.waiters.values()) waiter.reject(abortError());
        job.waiters.clear();
      }
      jobs.clear(); queue.length = 0; memory.clear(); memoryBytes = 0;
      workerDecoder?.close();
    },
  };
};

module.exports = { createImageThumbnailService, normalizeRequest, thumbnailResult, decodeThumbnail, MAX_SIDE };
