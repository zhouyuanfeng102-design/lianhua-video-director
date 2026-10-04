const { createHash } = require('node:crypto');

const API = 'https://www.runninghub.ai';
const ENTRY = 'https://rhtv.runninghub.ai/projects?model=476';
const MODEL = 'Minimax H3 RH Enhanced';
const modes = { text: '文生视频', first: '首帧', first_last: '首尾帧', reference: '全能参考' };
const subtypes = { text: 'text-video', first: 'start-video', first_last: 'start-end-video', reference: 'multimodal-video' };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const norm = (value) => String(value ?? '').toLowerCase().replace(/[_\s-]/g, '');
const normalizePrompt = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const validRemoteId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);

function unwrap(value) {
  for (let depth = 0; depth < 2 && value && typeof value === 'object' && !Array.isArray(value); depth += 1) {
    if (value.code !== undefined) requireThat(String(value.code) === '0', `rhTV 拒绝请求（${String(value.code).slice(0,40)}），请检查登录或原网页`);
    if (value.data === undefined) break;
    value = value.data;
  }
  return value;
}

function referencePlan(request) {
  const refs = request.mode === 'first_last'
    ? ['first-frame', 'last-frame'].map((role) => request.references.find((ref) => ref.role === role))
    : request.references;
  return refs.map((ref) => {
    requireThat(ref && /^[a-f0-9]{64}_(png|jpeg|webp)$/.test(ref.upload_id), '缺少参考图原文件标识');
    const [checksum, kind] = ref.upload_id.split('_');
    return { ...ref, checksum, mime: `image/${kind}`, name: `slot-${ref.slot_index + 1}-${checksum.slice(0,12)}.${kind === 'jpeg' ? 'jpg' : kind}` };
  });
}

function collectModels(payload) {
  const found = new Map();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const code = value.modelCode || value.code;
    const name = value.modelName || value.name || value.modelNameEn || value.nameEn;
    if (typeof code === 'string' && norm(name) === norm(MODEL) && value.skuId && Array.isArray(value.config)) {
      found.set(code, { ...value, code, name, skuId: String(value.skuId) });
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child, depth + 1);
  }
  visit(unwrap(payload));
  return [...found.values()];
}

function sessionIdentity(headers) {
  const auth = headers.authorization;
  requireThat(typeof auth === 'string' && /^Bearer \S+$/.test(auth), 'rhTV 尚未登录，请在独立 Edge 中登录');
  let identity = auth;
  try {
    const claims = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.sub === 'string' && claims.sub) identity = `subject:${claims.sub}`;
  } catch { /* Opaque tokens can only recover within the same login session. */ }
  return digest(`${identity}\nteam:${headers['x-team-id'] || ''}`);
}

function freeQuote(payload) {
  const value = unwrap(payload);
  const number = (entry) => typeof entry === 'number' || typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : NaN;
  requireThat(value && number(value.totalPrice) === 0, '当前任务报价非零或缺失，已暂停，未提交生成');
  requireThat(value.discountTotalPrice == null || number(value.discountTotalPrice) === 0, '当前任务折后费用未确认为零');
  requireThat(value.paidQuantity == null || number(value.paidQuantity) === 0, '当前任务包含付费数量，已暂停');
  requireThat(value.tokenPriceEstimable !== false && value.tokenPriceEstimable !== 'false', '当前任务费用无法准确估算，已暂停');
  if (value.freeLimit || value.free || value.isFree) {
    const remaining = value.freeLimitCount ?? value.freeRemaining ?? value.freeTimes ?? value.freeCount ?? value.freeQuotaRemaining;
    requireThat(remaining == null || number(remaining) > 0, '当前账号免费次数不足，已暂停');
  }
  return { total: 0, currency: typeof value.currency === 'string' ? value.currency : '', checked_at: Date.now() };
}

function sourceUrl(value) {
  const url = typeof value === 'string' ? value : value?.originalUrl || value?.originUrl || value?.url
    || value?.outputUrl || value?.resultUrl || value?.fileUrl || value?.assetUrl;
  requireThat(typeof url === 'string' && url.length < 8192, '上游素材地址无效');
  const parsed = new URL(url);
  requireThat(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash, '上游素材必须使用 HTTPS');
  return url;
}

function priceFactors(model, params) {
  const empty = (value) => value == null || value === '' || Array.isArray(value) && value.length === 0;
  const configs = new Map(model.config.filter((item) => item?.paramName).map((item) => [item.paramName, item]));
  const keys = new Set([...configs.keys(), ...Object.keys(params)]);
  const factors = [];
  for (const fieldKey of keys) {
    if (fieldKey === 'generateNum') continue;
    const config = configs.get(fieldKey) || {};
    let value = params[fieldKey];
    if (empty(value)) value = [model.params?.[fieldKey], config.paramValue, config.defaultValue].find((entry) => !empty(entry));
    const convert = (kind, input) => {
      if (empty(input)) return kind === 'boolean' ? false : input;
      if (kind === 'boolean') return input === true || input === 1 || input === '1' || input === 'true';
      if (kind === 'string') return String(input);
      if (['int','float','number'].includes(kind)) {
        const number = Number(input);
        requireThat(Number.isFinite(number) && (kind !== 'int' || Number.isInteger(number)), '无法核实网页计费数值参数');
        return number;
      }
      if (['arrayint','arraystring'].includes(kind)) {
        requireThat(Array.isArray(input), '无法核实网页计费数组参数');
        return input.map((entry) => convert(kind === 'arrayint' ? 'int' : 'string', entry));
      }
      return input;
    };
    value = convert(norm(config.paramDataType), value);
    value = convert(norm(config.type), value);
    if (empty(value)) continue;
    const type = [config.type, fieldKey].some((entry) => /^videourls?$/.test(norm(entry))) ? 'VIDEO'
      : [config.type, fieldKey].some((entry) => /^audiourls?$/.test(norm(entry))) ? 'AUDIO' : config.type;
    factors.push({ title: config.title, titleEn: config.titleEn, type, fieldKey, fieldValue: value });
  }
  return factors;
}

// Validate the site's actual outgoing canvas, not just its visible form labels.
function validateSubmission(job, body, models) {
  const request = job.request;
  requireThat(body?.targetType === 'NODE' && validRemoteId(String(body.canvasId)) && validRemoteId(body.targetId), '无法识别唯一的原画布任务');
  const canvas = typeof body.canvas === 'string' ? JSON.parse(body.canvas) : body.canvas;
  requireThat(Array.isArray(canvas?.nodes) && Array.isArray(canvas?.edges), '网页任务结构已变化');
  const nodes = canvas.nodes;
  const target = nodes.find((node) => node.id === body.targetId);
  requireThat(nodes.filter((node) => node.id === body.targetId).length === 1 && target?.type === 'rh-video', '网页不是单个视频生成节点');
  const data = target.data;
  const model = models.find((entry) => entry.code === data?.modelCode);
  requireThat(model && data.subType === subtypes[request.mode], '网页模型或生成模式与本机任务不同');
  const params = data.params;
  requireThat(params && (!params.rhModel || params.rhModel === model.code), '网页模型参数发生变化');
  requireThat(params.generateNum == null || Number(params.generateNum) === 1, '自动接入仅允许单次生成一个视频');
  const field = (type, fallback) => model.config.find((item) => norm(item.type) === norm(type))?.paramName
    || Object.keys(params).find((name) => fallback.test(name));
  const promptKey = field('prompt', /^prompt$/i);
  requireThat(typeof params[promptKey] === 'string' && normalizePrompt(params[promptKey]) === normalizePrompt(request.prompt), '网页提示词与冻结的原任务不一致');
  const durationKey = field('duration', /^(duration|durationSeconds|video_duration)$/i);
  const resolutionKey = field('resolution', /^(resolution|video_resolution)$/i);
  const aspectKey = field('aspectRatio', /^(aspect_?ratio|ratio)$/i);
  requireThat(Number(params[durationKey]) === request.parameters.duration, '网页时长未通过回读');
  requireThat(norm(params[resolutionKey]) === norm(request.parameters.resolution), '网页分辨率未通过回读');
  const aspect = params[aspectKey];
  requireThat(request.parameters.aspect_ratio === '自适应' ? ['auto','adaptive','自适应'].includes(String(aspect).toLowerCase()) : aspect === request.parameters.aspect_ratio, '网页比例未通过回读');
  const plan = referencePlan(request);
  const incoming = canvas.edges.filter((edge) => edge.target === target.id);
  requireThat(nodes.length === plan.length + 1 && incoming.length === plan.length && canvas.edges.length === incoming.length, '画布包含额外节点或丢失参考图');
  const urls = plan.map((ref, index) => {
    const node = nodes.find((entry) => entry.id === incoming[index]?.source);
    requireThat(node?.type === 'rh-image' && node.data?.title === ref.name, '网页参考图顺序或身份不一致');
    const values = node.data.sourceObjects;
    requireThat(Array.isArray(values) && values.length === 1, '原参考图对应多个或缺失上游文件');
    return sourceUrl(values[0]);
  });
  requireThat(new Set(incoming.map((edge) => edge.source)).size === plan.length, '网页重复引用了同一个图片节点');
  // The landing composer links its images in upload order. First/last field values,
  // when materialized by the site, must agree with that explicit role ordering.
  const imageFields = model.config.filter((item) => /^(first(image|frame)url|last(image|frame)url|imageurl|imageurls|imageref)$/i.test(norm(item.type)));
  for (const item of imageFields) {
    if (params[item.paramName] == null || params[item.paramName] === '') continue;
    const type = norm(item.type);
    const expected = type.startsWith('last') ? urls[1] : /^(imageurls|imageref)$/.test(type) ? urls : urls[0];
    requireThat(JSON.stringify(params[item.paramName]) === JSON.stringify(expected), '网页首尾帧或参考图字段发生重排');
  }
  return { canvas_id: String(body.canvasId), node_id: body.targetId, model_code: model.code,
    prompt_hash: digest(params[promptKey]), quoteRequest: { skuId: model.skuId, priceFactors: priceFactors(model, params) },
    references: plan.map((ref, index) => ({ slot_index: ref.slot_index, role: ref.role, checksum: ref.checksum, url: urls[index] })) };
}

function taskResult(payload, upstream) {
  const data = unwrap(payload);
  const matches = Array.isArray(data?.tasks) ? data.tasks.filter((task) => String(task.taskId) === upstream.task_id) : [];
  requireThat(matches.length === 1, '未查到唯一的原任务，保留占位');
  const task = matches[0];
  const plans = Array.isArray(task.plans) ? task.plans : [];
  const selected = plans.length ? plans.filter((plan) => String(plan.nodeId) === upstream.node_id) : [task];
  requireThat(selected.length === 1, '原任务输出节点无法唯一确认');
  const node = selected[0];
  const state = String(node.status ?? task.status).toLowerCase();
  if (['failed','failure','fail','error','upload_error','canceled','cancelled','cancel','timeout'].includes(state)) return { status: 'failed', message: 'rhTV 已确认原任务失败或取消' };
  if (['pending','running','queued','queueing','processing','submitted','created'].includes(state)) return { status: 'running', message: 'rhTV 原任务排队或生成中' };
  requireThat(['finished','success','succeed','succeeded'].includes(state), 'rhTV 原任务状态尚未识别');
  const outputs = node.outputs ?? node.output;
  requireThat(Array.isArray(outputs) && outputs.length === 1, '原任务已完成，但单个成片尚未确认');
  const output = outputs[0];
  const url = sourceUrl(output);
  requireThat(/\.(mp4|webm|mov)(?:[?#]|$)/i.test(url) || /^(video|mp4|webm|mov)$/i.test(output?.outputType || output?.type || ''), '原任务结果不是可识别的视频');
  return { status: 'succeeded', url };
}

module.exports = { API, ENTRY, MODEL, modes, subtypes, digest, validRemoteId, requireThat, unwrap,
  referencePlan, collectModels, sessionIdentity, freeQuote, validateSubmission, taskResult, sourceUrl, normalizePrompt };
