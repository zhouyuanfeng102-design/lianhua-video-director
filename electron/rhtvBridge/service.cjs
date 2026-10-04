const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const ORIGIN = 'http://rhtv.localhost';
// Bound the optional HTTP JSON envelope. Desktop image uploads use worker RPC
// objects and are not re-encoded into this envelope.
const LIMIT = 28 * 1024 * 1024;
const ASSET_CACHE_LIMIT = 1024 * 1024 * 1024;
const bodyLimitMessage = '本机桥接 JSON 请求超过 28 MB 传输缓冲上限（不是网站图片限制）；桌面原图上传请使用专用通道';
const terminal = (job) => ['succeeded', 'cancelled', 'failed'].includes(job.status);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function parseBody(body) {
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > LIMIT) fail(bodyLimitMessage, 413);
    try { body = JSON.parse(body); } catch { fail('请求必须是 JSON 对象'); }
  }
  if (!object(body)) fail('请求必须是 JSON 对象');
  return body;
}

function createRhTvService({ root, browser, validateResult = async () => { throw new Error('视频校验器不可用'); },
  downloadResult = async () => { throw new Error('自动下载器不可用'); }, pollInterval = 5000 }) {
  fs.mkdirSync(root, { recursive: true });
  const jobsDir = path.join(root, 'jobs');
  const assetsDir = path.join(root, 'assets');
  const resultsDir = path.join(root, 'results', 'video');
  for (const directory of [jobsDir, assetsDir, resultsDir]) fs.mkdirSync(directory, { recursive: true });
  const jobs = new Map();
  for (const name of fs.readdirSync(jobsDir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    // Corrupt journals must stop recovery, never authorize a new submission.
    const job = JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8'));
    if (!validId(job.id) || `${job.id}.json` !== name || !validId(job.client_id) || !object(job.request)
      || job.request.client_id !== job.client_id || !Array.isArray(job.request.references)
      || typeof job.handed_off !== 'boolean' || !Number.isFinite(job.created_at)
      || !['waiting_review', 'submission_unknown', 'cancelled', 'failed', 'succeeded', 'preparing', 'submitting', 'running', 'paused', 'downloading', 'download_failed', 'reconnecting'].includes(job.status)
      || job.fingerprint !== sha(JSON.stringify(canonical(job.request)))
      || [...jobs.values()].some((prior) => prior.client_id === job.client_id)) throw new Error('rhTV 任务日志损坏，未启动自动恢复');
    jobs.set(job.id, job);
  }
  let server;
  let starting;
  let closePromise;
  let closing = false;
  let endpoint;
  let preparing;
  let timer;
  let ticking = false;
  const stopSignal = new AbortController();
  const automationFile = path.join(root, 'automation.json');
  const settings = fs.existsSync(automationFile) ? JSON.parse(fs.readFileSync(automationFile, 'utf8')) : { enabled: false };
  if (typeof settings.enabled !== 'boolean') throw new Error('rhTV 自动化设置损坏，未启用提交');
  let automatic = settings.enabled;
  const busyJobs = new Set();
  const operations = new Set();
  function exclusive(id, operation) {
    if (closing) return Promise.reject(new Error('桥接正在关闭'));
    if (busyJobs.has(id)) return Promise.reject(new Error('原任务仍在处理中，请等待完成后再操作'));
    busyJobs.add(id);
    const pending = Promise.resolve().then(operation).finally(() => { busyJobs.delete(id); operations.delete(pending); });
    operations.add(pending);
    return pending;
  }
  const token = randomBytes(32).toString('hex');
  const save = (job) => { writeJson(path.join(jobsDir, `${job.id}.json`), job); jobs.set(job.id, job); return job; };
  for (const job of jobs.values()) {
    if (job.automatic && ['preparing','submitting'].includes(job.status)) save({ ...job,
      status: job.upstream?.task_id ? 'running' : job.submission_started ? 'submission_unknown' : 'paused',
      message: '上次执行被中断；仅恢复原任务，未自动重投。' });
  }
  const get = (id) => { if (!validId(id) || !jobs.has(id)) fail('未找到原 rhTV 任务', 404); return jobs.get(id); };
  const publicJob = (job) => ({ id: job.id, client_id: job.client_id, status: job.status, message: job.message,
    created_at: job.created_at, mode: job.request.mode, reference_count: job.request.references.length, handed_off: job.handed_off,
    automatic: job.automatic === true, submission_started: job.submission_started === true,
    upstream_task_id: job.upstream?.task_id, page_url: job.upstream?.page_url,
    ...(job.quote ? { quote: job.quote } : {}),
    references: job.request.references.map(({ upload_id, ...ref }) => ({ ...ref, checksum: upload_id.split('_')[0] })),
    ...(job.status === 'succeeded' ? { result_url: `${ORIGIN}/v1/videos/${job.id}/content` } : {}),
    cancellation_confirmed: job.status === 'cancelled',
    terminal_confirmed: terminal(job),
  });
  const status = () => ({ running: Boolean(server?.listening) && !closing, endpoint, browser: browser.state(), automatic_submission: automatic,
    automation_supported: true, live_site_verified: false,
    message: automatic ? '自动上传、零费用核验、生成跟踪和下载已启用。' : '自动提交已暂停；已提交任务继续查询和下载。',
    jobs: [...jobs.values()].sort((a, b) => b.created_at - a.created_at).map(publicJob),
  });
  function upload(data) {
    if (typeof data.data_url !== 'string' || !data.data_url) fail('缺少原图文件');
    if (data.data_url.length > Math.ceil(ASSET_CACHE_LIMIT / 3) * 4 + 64) fail('原图超出本机桥接 1 GB 素材缓存容量（不是网站图片限制）', 413);
    const match = data.data_url.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) fail('仅支持 PNG、JPEG、WebP 原图');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 12) fail('图片文件无效');
    const kind = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
    if (kind !== match[1]) fail('图片内容与 MIME 类型不一致');
    const checksum = sha(bytes);
    const upload_id = `${checksum}_${kind}`;
    const file = path.join(assetsDir, upload_id);
    if (!fs.existsSync(file)) {
      const total = fs.readdirSync(assetsDir).reduce((sum, name) => sum + fs.statSync(path.join(assetsDir, name)).size, 0);
      if (total + bytes.length > ASSET_CACHE_LIMIT) fail('本机桥接素材缓存达到 1 GB 容量（不是网站图片限制），请先管理已完成素材', 413);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { upload_id, checksum, size_bytes: bytes.length };
  }
  function assetFile(uploadId) {
    if (typeof uploadId !== 'string' || !/^[a-f0-9]{64}_(?:png|jpeg|webp)$/.test(uploadId)) fail('图片上传标识无效');
    const file = path.join(assetsDir, uploadId);
    if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== uploadId.split('_')[0]) fail('原图已丢失或发生变化');
    return file;
  }
  function accept(request) {
    if (!validId(request.client_id) || request.protocol_version !== 1 || request.model_key !== 'minimax-h3-rh-enhanced'
      || request.cost_policy !== 'free_only' || !text(request.prompt, 100000) || !object(request.parameters) || !Array.isArray(request.references)) fail('rhTV 任务协议无效');
    const fingerprint = sha(JSON.stringify(canonical(request)));
    const old = [...jobs.values()].find((job) => job.client_id === request.client_id);
    if (old) { if (old.fingerprint !== fingerprint) fail('同一任务标识对应不同输入，未重复生成', 409); return publicJob(old); }
    if (jobs.size >= 1000) fail('桥接任务记录达到上限', 409);
    const refs = request.references;
    const slots = new Set();
    for (const ref of refs) {
      if (!object(ref) || !text(ref.asset_id) || !text(ref.role, 32) || !Number.isSafeInteger(ref.slot_index) || ref.slot_index < 0
        || slots.has(ref.slot_index) || ref.character_ids !== undefined && (!Array.isArray(ref.character_ids) || ref.character_ids.length > 100 || ref.character_ids.some((id) => !text(id)))) fail('参考图绑定清单无效');
      slots.add(ref.slot_index); assetFile(ref.upload_id);
      if (ref.checksum !== undefined && ref.checksum !== ref.upload_id.split('_')[0]) fail('参考图校验值与原图不符');
    }
    const first = refs.filter((r) => r.role === 'first-frame').length;
    const last = refs.filter((r) => r.role === 'last-frame').length;
    if (!['text', 'first', 'first_last', 'reference'].includes(request.mode)
      || request.mode === 'text' && refs.length !== 0
      || request.mode === 'first' && (refs.length !== 1 || first !== 1)
      || request.mode === 'first_last' && (refs.length !== 2 || first !== 1 || last !== 1)
      || request.mode === 'reference' && (refs.length < 1 || refs.length > 9)) fail('图片用途或数量与 rhTV 模式不符');
    const p = request.parameters;
    if (!Number.isInteger(p.duration) || p.duration < 4 || p.duration > 15 || !['480p', '768p', '1080p'].includes(p.resolution)
      || !['自适应','1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'].includes(p.aspect_ratio)
      || Object.keys(p).some((key) => !['duration','resolution','aspect_ratio'].includes(key))) fail('rhTV 参数未通过校验');
    return publicJob(save({ id: randomUUID(), client_id: request.client_id, fingerprint, request: structuredClone(request),
      status: 'waiting_review', handed_off: false, created_at: Date.now(),
      message: automatic ? '已保存原任务，等待 Edge 自动上传和费用核验。' : '已保存原图和参数，等待启用自动执行。' }));
  }
  async function prepare(id) {
    const job = get(id);
    if (terminal(job)) fail('任务已结束，不能再次准备网页', 409);
    if (preparing) fail('另一个网页操作正在执行', 409);
    const active = [...jobs.values()].find((other) => other.id !== id && other.handed_off && !terminal(other));
    if (active) fail('同账号原网页任务尚未确认结束，不能准备另一个任务', 409);
    if (job.handed_off) { await browser.show(job.id, job); return publicJob(job); }
    // Once a live draft is exposed the user may submit it. Never infer that closing it cancels the upstream task.
    preparing = id;
    save({ ...job, handed_off: true, status: 'submission_unknown', message: '已记录网页交接边界；原任务可能已在网页提交，不会自动重投。' });
    try {
      const result = await browser.prepare(job, job.request.references.map((ref) => assetFile(ref.upload_id)), { manual: true });
      const current = get(id);
      save({ ...current, status: 'waiting_review', message: result.message });
    } catch (error) {
      save({ ...get(id), status: 'submission_unknown', message: `网页准备中断：${error.message}；请核对原网页，不会新建重投。` });
    } finally { preparing = undefined; }
    return publicJob(get(id));
  }
  function cancel(id) {
    if (closing || busyJobs.has(id)) fail('原任务仍在处理中或桥接正在关闭，未确认取消', 409);
    const job = get(id);
    if (terminal(job)) return publicJob(job);
    if (job.handed_off && !(job.automatic && !job.submission_started)) return publicJob(save({ ...job, status: 'submission_unknown', message: '网页已交接，无法确认远端取消；保留占位，请核对原网页或导入原任务结果。' }));
    return publicJob(save({ ...job, status: 'cancelled', message: '已取消本机待提交任务，未发出生成请求；已有网页素材草稿保留。' }));
  }
  function materials(id) {
    const job = get(id);
    const folder = path.join(root, 'materials', job.id);
    fs.mkdirSync(folder, { recursive: true });
    const manifest = job.request.references.map((ref, index) => {
      const ext = ref.upload_id.endsWith('_jpeg') ? 'jpg' : ref.upload_id.endsWith('_webp') ? 'webp' : 'png';
      const name = `slot-${ref.slot_index + 1}-${index + 1}.${ext}`;
      fs.copyFileSync(assetFile(ref.upload_id), path.join(folder, name));
      return { ...ref, file_name: name, checksum: ref.upload_id.split('_')[0] };
    });
    writeJson(path.join(folder, 'manifest.json'), { ...job.request, references: manifest });
    fs.writeFileSync(path.join(folder, 'prompt.txt'), job.request.prompt, { mode: 0o600 });
    return path.join(folder, 'manifest.json');
  }
  async function confirmNotSubmitted(id) {
    const job = get(id);
    if (preparing || terminal(job)) fail('当前任务不可解除交接状态', 409);
    if (job.upstream?.task_id) fail('已取得网页任务编号，不能标记为未提交；请核实原任务已结束或导入结果', 409);
    await browser.closeJob?.(id);
    return publicJob(save({ ...job, status: 'cancelled', human_resolution: 'not_submitted', message: '用户已在网页核对未提交，关闭原标签页并取消本机任务。' }));
  }
  async function confirmEnded(id) {
    const job = get(id);
    if (!job.handed_off || preparing || terminal(job)) fail('仅可核实已交接且未结束的原任务', 409);
    await browser.closeJob?.(id);
    return publicJob(save({ ...job, status: 'failed', human_resolution: 'ended', message: '用户已在原网页核实任务失败或取消，本机结束跟踪并释放占位；不代表平台退款。' }));
  }
  async function importResult(id, source, automated = false) {
    const job = get(id);
    if (!job.handed_off || terminal(job)) fail('仅可为已交接且未结束的原任务导入结果', 409);
    const ext = path.extname(source).toLowerCase();
    if (!['.mp4', '.webm', '.mov'].includes(ext)) fail('只接受 MP4、WebM、MOV 成片');
    const info = fs.statSync(source);
    if (!info.isFile() || !info.size || info.size > 2 * 1024 * 1024 * 1024) fail('视频为空、不是文件或超过 2 GB 上限');
    const target = path.join(resultsDir, `${id}${ext}`);
    try {
      await fs.promises.copyFile(source, target);
      await validateResult({ assetId: id, relativePath: `video/${id}${ext}` });
      const checksum = await fileSha(target);
      save({ ...get(id), status: 'succeeded', result: { name: `${id}${ext}`, checksum }, message: automated ? '原任务成片已自动下载并通过视频校验，等待入库。' : '已人工确认原任务结果并通过本地视频校验。' });
    } catch (error) { await fs.promises.rm(target, { force: true }); throw error; }
    return publicJob(get(id));
  }
  async function resultFile(id) {
    const job = get(id);
    if (job.status !== 'succeeded' || !job.result || !new RegExp(`^${id}\\.(mp4|webm|mov)$`).test(job.result.name)) fail('原任务尚无可用结果', 409);
    const file = path.join(resultsDir, job.result.name);
    if (await fileSha(file) !== job.result.checksum) fail('原任务成片已损坏，未返回替换文件', 409);
    return file;
  }
  function automation(enabled) {
    if (typeof enabled !== 'boolean' || closing) fail('自动化开关无效');
    writeJson(automationFile, { enabled });
    automatic = enabled;
    if (!enabled) browser.pause?.();
    return status();
  }
  async function retry(id) {
    const job = get(id);
    if (terminal(job)) fail('原任务已结束，不能重新生成', 409);
    if (job.upstream?.task_id) {
      save({ ...job, status: 'running', next_check: 0, download_attempts: 0, message: '继续查询并下载原任务，不重新提交。' });
    } else {
      if (!job.automatic || job.submission_started) fail('原任务是否已提交不明确，禁止自动重投', 409);
      await browser.closeJob?.(id);
      save({ ...job, handed_off: false, status: 'waiting_review', next_check: 0, message: '已关闭受控草稿，等待重新核验；尚未发出生成请求。' });
    }
    return status();
  }
  async function execute(job) {
    const id = job.id;
    save({ ...job, automatic: true, handed_off: true, status: 'preparing', message: 'Edge 正在上传原图并填写参数。' });
    try {
      await browser.prepare(get(id), job.request.references.map((ref) => assetFile(ref.upload_id)));
      if (!automatic || closing) throw new Error('自动提交已暂停');
      await browser.submit(get(id), {
        onBoundary(receipt) {
          if (!automatic || closing || terminal(get(id)) || get(id).submission_started) throw new Error('当前任务不能重复提交');
          save({ ...get(id), ...receipt, submission_started: true, status: 'submitting', message: '零费用及引用已核验，正在提交；回执丢失不会重投。' });
        },
        onSubmitted(upstream) {
          if (terminal(get(id)) || !get(id).submission_started) throw new Error('原任务已被人工处理，未覆盖结果');
          save({ ...get(id), upstream, status: 'running', next_check: 0, message: '已取得 rhTV 原任务编号，自动跟踪中。' });
        },
      });
    } catch (error) {
      const current = get(id);
      save({ ...current, status: current.upstream?.task_id ? 'running' : current.submission_started ? 'submission_unknown' : 'paused',
        message: `自动执行暂停：${error.message}；不会重复提交。` });
    }
  }
  async function monitor(job) {
    const id = job.id;
    try {
      const result = await browser.poll(job);
      if (closing) return;
      if (result.status === 'failed') {
        save({ ...get(id), status: 'failed', message: result.message });
        await browser.closeJob?.(id).catch(() => {});
        return;
      }
      if (result.status !== 'succeeded') {
        save({ ...get(id), status: 'running', next_check: Date.now() + pollInterval, message: result.message }); return;
      }
      const attempts = (get(id).download_attempts || 0) + 1;
      save({ ...get(id), status: 'downloading', download_attempts: attempts, message: '原任务生成成功，正在自动下载成片。' });
      try {
        const source = await downloadResult({ url: result.url, jobId: id, signal: stopSignal.signal });
        if (closing) throw new Error('下载跟踪已停止');
        await importResult(id, source, true);
        await browser.closeJob?.(id).catch(() => {});
      } catch (error) {
        save({ ...get(id), status: attempts >= 3 ? 'download_failed' : 'downloading', next_check: Date.now() + attempts * 15000,
          message: `原任务已生成，下载或校验失败：${error.message}；仅重试下载，不重新生成。` });
      }
    } catch (error) {
      save({ ...get(id), status: 'reconnecting', next_check: Date.now() + 30000,
        message: `原任务查询暂停：${error.message}；等待恢复，不重新生成。` });
    }
  }
  async function tick() {
    if (closing || ticking || preparing) return;
    const pending = [...jobs.values()].filter((job) => !terminal(job)).sort((a, b) => a.created_at - b.created_at);
    const job = pending.find((entry) => entry.handed_off) || (automatic ? pending[0] : undefined);
    if (!job || busyJobs.has(job.id) || job.next_check > Date.now()) return;
    if (job.handed_off && (!job.automatic || !job.upstream?.task_id || job.status === 'download_failed')) return;
    ticking = true;
    try { await exclusive(job.id, () => job.upstream?.task_id ? monitor(job) : execute(job)); }
    finally { ticking = false; }
  }
  async function dispatch(method, pathname, body) {
    if (closing) fail('桥接正在关闭', 503);
    if (method === 'GET' && pathname === '/v1/health') return { protocol_version: 1, ready: true };
    if (method === 'GET' && pathname === '/v1/session') return status();
    if (method === 'GET' && pathname === '/v1/capabilities') return { model_key: 'minimax-h3-rh-enhanced', automatic_submission: automatic, automation_supported: true, max_images: 9, cost_policy: 'free_only', verified: false };
    if (method === 'POST' && pathname === '/v1/assets') return upload(parseBody(body));
    if (method === 'POST' && pathname === '/v1/videos') return accept(parseBody(body));
    const byClient = pathname.match(/^\/v1\/videos\/by-client\/([a-zA-Z0-9_-]{1,120})$/);
    if (method === 'GET' && byClient) {
      const job = [...jobs.values()].find((entry) => entry.client_id === byClient[1]);
      if (!job) fail('桥接日志中未找到原任务；不会自动重新提交', 404);
      return publicJob(job);
    }
    const match = pathname.match(/^\/v1\/videos\/([a-f0-9-]{36})(?:\/(cancel))?$/);
    if (match && method === 'GET' && !match[2]) return publicJob(get(match[1]));
    if (match && method === 'POST' && match[2] === 'cancel') return cancel(match[1]);
    fail('不支持的桥接端点', 404);
  }
  async function start() {
    if (closing) fail('桥接正在关闭', 503);
    if (starting) return starting;
    if (server?.listening) return status();
    starting = listen().catch((error) => { server = undefined; endpoint = undefined; throw error; }).finally(() => { starting = undefined; });
    return starting;
  }
  async function listen() {
    server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const supplied = Buffer.from(String(req.headers.authorization || ''));
        const expected = Buffer.from(`Bearer ${token}`);
        if (req.headers.origin || req.headers.host !== new URL(endpoint).host || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('桥接认证失败', 401);
        const url = new URL(req.url, endpoint);
        if (url.origin !== endpoint || url.search || url.hash) fail('桥接请求地址无效');
        const content = url.pathname.match(/^\/v1\/videos\/([a-f0-9-]{36})\/content$/);
        if (req.method === 'GET' && content) {
          const file = await resultFile(content[1]);
          res.setHeader('Content-Type', file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
          res.setHeader('Content-Length', fs.statSync(file).size);
          const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        let length = 0; const chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > LIMIT) fail(bodyLimitMessage, 413); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString('utf8');
        const result = await dispatch(req.method, url.pathname, body);
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = error.status || 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: error.status ? error.message : '桥接处理失败，请检查本地任务记录' })); }
    });
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    endpoint = `http://127.0.0.1:${server.address().port}`;
    timer = setInterval(() => { void tick().catch(() => {}); }, pollInterval);
    timer.unref();
    return status();
  }
  return { start, status, dispatch, prepare: (id) => exclusive(id, () => prepare(id)), cancel,
    importResult: (id, source) => exclusive(id, () => importResult(id, source)), resultFile, materials,
    confirmNotSubmitted: (id) => exclusive(id, () => confirmNotSubmitted(id)),
    confirmEnded: (id) => exclusive(id, () => confirmEnded(id)),
    automation, retry: (id) => exclusive(id, () => retry(id)), tick,
    credentials: () => ({ endpoint, token }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(timer); stopSignal.abort(); browser.pause?.();
      closePromise = (async () => {
        await starting?.catch(() => {});
        try { await browser.close(); } finally {
          await Promise.allSettled([...operations]);
          if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); server = undefined; endpoint = undefined; }
        }
      })();
      return closePromise;
    },
  };
}
module.exports = { createRhTvService, ORIGIN };
