(() => {
if (window.__lianhuaRhTv) return;

const API = 'https://www.runninghub.ai';
const ENTRY = 'https://rhtv.runninghub.ai/projects?model=476';
const MODEL = 'Minimax H3 RH Enhanced';
const modes = { text: '文生视频', first: '首帧', first_last: '首尾帧', reference: '全能参考' };
const subtypes = { text: 'text-video', first: 'start-video', first_last: 'start-end-video', reference: 'multimodal-video' };
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value))].map(byte => byte.toString(16).padStart(2,'0')).join('');
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

async function sessionIdentity(headers) {
  const auth = headers.authorization;
  requireThat(typeof auth === 'string' && /^Bearer \S+$/.test(auth), 'rhTV 尚未登录，请在独立 Edge 中登录');
  let identity = auth;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(auth.slice(7).split('.')[1].replace(/-/g,'+').replace(/_/g,'/')), ch => ch.charCodeAt(0))));
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
async function validateSubmission(job, body, models) {
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
    prompt_hash: await digest(params[promptKey]), quoteRequest: { skuId: model.skuId, priceFactors: priceFactors(model, params) },
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

// Same rhTV contract as Electron. Only the browser/runtime transport changes.
const state = { operations: {}, results: Object.create(null), boundary: null, acknowledgements: Object.create(null) };
window.__lianhuaRhTv = state;
const originalFetch = window.fetch.bind(window);
const models = new Map();
let auth, gate, prepared, manual = false;
const waitFor = async (read, timeout = 20000) => {
  const start = Date.now();
  for (;;) {
    const value = read(); if (value) return value;
    if (Date.now() - start >= timeout) throw new Error('rhTV 网页等待超时；请查看原任务，不会自动重新生成。');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
const buttons = label => [...document.querySelectorAll('button, [role="button"]')].filter(element => text(element) === label);
const oneButton = label => { const found = buttons(label); requireThat(found.length === 1, `无法唯一识别 rhTV 网页控件：${label}`); return found[0]; };
function rememberHeaders(address, values) {
  if (!address.startsWith(API + '/canvas/')) return;
  const headers = Object.fromEntries(new Headers(values).entries());
  if (headers.authorization) auth = Object.fromEntries(Object.entries(headers).filter(([key]) => ['authorization','x-team-id','x-rh-lang','user-language','version'].includes(key)));
}
function observe(address, value) {
  if (![API + '/canvas/model/list', API + '/canvas/model/group/list'].includes(address.split('?')[0])) return;
  try { for (const model of collectModels(value)) models.set(model.code, model); } catch {}
}
async function api(pathname, body, headers = auth) {
  requireThat(headers?.authorization, '请先在 rhTV 独立网页中登录并等待页面加载。');
  const response = await originalFetch(API + pathname, { method: 'POST', credentials: 'include', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  requireThat(response.ok, `rhTV 查询失败（HTTP ${response.status}），未重新提交`);
  return response.json();
}
const jobKey = job => `lianhua-rhtv:${job.client_id}`;
async function authorize(address, body, headers) {
  if (new URL(address).pathname !== '/canvas/task/run') {
    requireThat(!/\/(?:task\/(?:create|submit)|generate|execute)(?:\/|$)/i.test(new URL(address).pathname), 'rhTV 未识别的生成入口，未提交');
    return null;
  }
  if (manual) return null;
  const current = gate;
  requireThat(current && !current.used, '没有待提交的原 rhTV 任务；生成请求未放行。');
  current.used = true;
  const outgoing = typeof body === 'string' ? JSON.parse(body) : body;
  const account = await sessionIdentity(headers);
  requireThat(String(outgoing?.teamId || '') === String(headers['x-team-id'] || ''), '网页计费主体发生变化');
  const identity = await validateSubmission(current.job, outgoing, [...models.values()]);
  const quote = freeQuote(await api('/canvas/price/calculate', identity.quoteRequest, headers));
  requireThat(gate === current && account === await sessionIdentity(auth), '自动提交已暂停或登录账号发生变化');
  const upstream = { canvas_id: identity.canvas_id, node_id: identity.node_id, model_code: identity.model_code, prompt_hash: identity.prompt_hash, account,
    page_url: `https://rhtv.runninghub.ai/project/canvas/${identity.canvas_id}` };
  const token = crypto.randomUUID();
  // Both the isolated browser journal and native journal precede the sole POST.
  localStorage.setItem(jobKey(current.job), JSON.stringify({ status: 'submission_unknown', upstream }));
  state.boundary = { token, upstream, quote, reference_receipt: identity.references };
  await waitFor(() => state.acknowledgements[token], 30000);
  requireThat(gate === current && state.acknowledgements[token] === true, '原任务提交边界未保存，未发出生成请求。');
  current.sent = true; current.upstream = upstream;
  return current;
}
function failed(current, error) { if (current && gate === current) current.reject(error); }
async function submitted(current, value) {
  if (!current) return;
  const data = unwrap(value); const id = String(data?.taskId ?? '');
  requireThat(validRemoteId(id), '生成回执未包含可用的原任务编号；保留原任务，不重投。');
  const result = { upstream: { ...current.upstream, task_id: id }, status: 'running' };
  localStorage.setItem(jobKey(current.job), JSON.stringify(result));
  current.resolve(result);
}
window.fetch = async (input, init) => {
  const address = new URL(input instanceof Request ? input.url : String(input), location.href).href;
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)).entries());
  rememberHeaders(address, headers);
  let current;
  try {
    if (address.startsWith(API + '/canvas/') && !['GET','OPTIONS'].includes(method)) {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      current = await authorize(address, body, headers);
    }
    const response = await originalFetch(input, init);
    if (address.startsWith(API + '/canvas/')) {
      const value = await response.clone().json().catch(() => null);
      observe(address, value);
      if (current) { requireThat(response.ok, '生成请求未得到明确回执；保留原任务，不重投。'); await submitted(current, value); }
    }
    return response;
  } catch (error) { failed(current || gate, error); throw error; }
};
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
const xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open = function(method, address, ...rest) {
  this.__lhTv = { method: String(method).toUpperCase(), address: new URL(address, location.href).href, headers: {} };
  return xhrOpen.call(this, method, address, ...rest);
};
XMLHttpRequest.prototype.setRequestHeader = function(key, value) { if (this.__lhTv) this.__lhTv.headers[String(key).toLowerCase()] = String(value); return xhrHeader.call(this, key, value); };
XMLHttpRequest.prototype.send = function(body) {
  const details = this.__lhTv;
  if (!details || !details.address.startsWith(API + '/canvas/')) return xhrSend.call(this, body);
  rememberHeaders(details.address, details.headers);
  const send = async () => {
    let current;
    try {
      if (!['GET','OPTIONS'].includes(details.method)) current = await authorize(details.address, body, details.headers);
      this.addEventListener('load', () => {
        try { const value = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); observe(details.address, value);
          if (current) { requireThat(this.status >= 200 && this.status < 300, '生成请求未取得明确回执'); void submitted(current, value).catch(error => failed(current, error)); }
        } catch (error) { failed(current, error); }
      }, { once: true });
      this.addEventListener('error', () => failed(current, new Error('生成请求连接中断；原任务不会重投。')), { once: true });
      xhrSend.call(this, body);
    } catch (error) { failed(current || gate, error); this.abort(); }
  };
  void send();
};
function setInput(input, value) {
  if (input.matches('input, textarea')) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(value));
  } else { input.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, String(value)); }
  input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur();
}
async function parameters(values) {
  const summary = () => [...document.querySelectorAll('button')].filter(element => /^(?:自适应|\d+:\d+) \/ (?:480p|768p|1080p) \/ (?:\d+秒|默认)$/.test(text(element)));
  for (const name of [values.aspect_ratio, values.resolution]) {
    requireThat(summary().length === 1, '网页参数菜单无法唯一识别'); summary()[0].click();
    const option = await waitFor(() => [...document.querySelectorAll('[role="tooltip"] button')].find(element => text(element) === name)); option.click();
  }
  summary()[0].click();
  const input = await waitFor(() => document.querySelector('[role="tooltip"] input[aria-label="生成时长"], [role="tooltip"] input[placeholder="生成时长"]'));
  setInput(input, values.duration);
  await waitFor(() => buttons(`${values.aspect_ratio} / ${values.resolution} / ${values.duration}秒`).length === 1);
}
async function inspect(job) {
  oneButton(MODEL); const mode = oneButton(modes[job.request.mode]); requireThat(mode.classList.contains('active'), '网页生成模式与原任务不符');
  const prompt = document.querySelector('.home-agent-input-bar--landing .composer-input');
  requireThat(prompt && normalizePrompt(prompt.value ?? prompt.innerText) === normalizePrompt(job.request.prompt), '网页提示词未通过原稿回读');
  const p = job.request.parameters; oneButton(`${p.aspect_ratio} / ${p.resolution} / ${p.duration}秒`);
  await waitFor(() => ![...document.querySelectorAll('.home-att-upload-overlay')].some(element => element.getClientRects().length), 60000);
  const plan = referencePlan(job.request);
  const images = [...document.querySelectorAll('.home-att-stack-item img.home-att-stack-thumb')];
  requireThat(images.length === plan.length, '网页参考图数量与原任务不符');
  for (let i = 0; i < images.length; i++) requireThat(images[i].alt === plan[i].name && images[i].complete && images[i].naturalWidth > 0, '网页参考图身份、顺序或上传状态不符');
  requireThat(!oneButton('开始创作').disabled, '上传未完成或 rhTV 登录失效');
}
state.operations = {
  session: () => ({ loggedIn: Boolean(auth?.authorization), modelCount: models.size }),
  prepare: async ({ job, files, manual: manualMode }) => {
    manual = Boolean(manualMode);
    await waitFor(() => buttons(MODEL).length === 1, 20000);
    const inputs = [...document.querySelectorAll('.home-agent-input-bar--landing .composer-input')]; requireThat(inputs.length === 1, '提示词输入框无法唯一识别'); setInput(inputs[0], job.request.prompt);
    const plan = referencePlan(job.request);
    if (plan.length) {
      const entries = [...document.querySelectorAll('.home-agent-input-bar--landing input[type="file"]:not(:disabled)')];
      requireThat(entries.length === 1 && (plan.length < 2 || entries[0].multiple), '网页多图上传入口已变化');
      const transfer = new DataTransfer();
      for (const ref of plan) {
        const original = files.find(item => item.upload_id === ref.upload_id); requireThat(original, '原图文件缺失');
        const bytes = Uint8Array.from(atob(original.base64), character => character.charCodeAt(0));
        requireThat(await digest(bytes) === ref.checksum, '原图字节与本次选图不符'); transfer.items.add(new File([bytes], ref.name, { type: ref.mime }));
      }
      entries[0].files = transfer.files; entries[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
    const mode = await waitFor(() => buttons(modes[job.request.mode]).find(element => !element.classList.contains('disabled')), 60000); mode.click();
    await parameters(job.request.parameters); await inspect(job);
    prepared = job;
    return { message: `已准备 ${modes[job.request.mode]}、参数与 ${plan.length} 张参考图；提交前核验原画布及零费用报价。` };
  },
  submit: async ({ job }) => {
    const prior = localStorage.getItem(jobKey(job));
    if (prior) return JSON.parse(prior);
    requireThat(prepared?.id === job.id && !gate, '原网页未准备或另一个提交尚未结束');
    await inspect(job); await sessionIdentity(auth); requireThat(models.size > 0, '未取得 H3 网页模型配置');
    manual = false;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        gate = { job, resolve, reject, used: false, sent: false };
        timer = setTimeout(() => reject(new Error('未取得原任务回执；保留占位，不重投。')), 120000);
        oneButton('开始创作').click();
      });
    } finally { clearTimeout(timer); gate = undefined; state.boundary = null; }
  },
  recover: ({ job }) => JSON.parse(localStorage.getItem(jobKey(job)) || '{}'),
  poll: async ({ job }) => {
    const upstream = job.upstream; requireThat(upstream?.task_id, '缺少原任务编号，不会重新提交');
    await waitFor(() => auth?.authorization);
    requireThat(await sessionIdentity(auth) === upstream.account, '登录账号与原任务账号不同，请登录原账号');
    return taskResult(await api('/canvas/task/batchStatus', { taskIds: [upstream.task_id], includeResults: true }), upstream);
  },
  pause: () => { if (gate && !gate.sent) { const current = gate; gate = undefined; current.reject(new Error('自动提交已暂停，未放行生成请求')); } return {}; },
  acknowledge: ({ token, allowed }) => { state.acknowledgements[token] = allowed === true; return {}; }
};
// Exposed for deterministic contract tests; never contains the login headers.
state.contracts = { collectModels, freeQuote, validateSubmission, taskResult, digest, referencePlan };
})();

