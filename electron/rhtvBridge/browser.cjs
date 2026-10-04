const path = require('node:path');
const fs = require('node:fs');
const { API, ENTRY, MODEL, modes, digest, validRemoteId, requireThat, unwrap, referencePlan,
  collectModels, sessionIdentity, freeQuote, validateSubmission, taskResult, normalizePrompt } = require('./contracts.cjs');

function createRhTvBrowser({ root, chromium }) {
  let context;
  let opening;
  let closing = false;
  let auth;
  let gate;
  const pages = new Map();
  const prepared = new Map();
  const manualPages = new WeakSet();
  const models = new Map();
  const observations = new Set();

  async function api(pathname, body, headers = auth) {
    requireThat(!closing && headers?.authorization, '请先在独立 Edge 中登录 rhTV');
    const response = await context.request.post(`${API}${pathname}`, {
      headers, data: body, timeout: 30000, maxRedirects: 0, maxRetries: 0,
    });
    try {
      requireThat(response.ok(), `rhTV 查询失败（HTTP ${response.status()}），未重新提交`);
      return await response.json();
    } finally { await response.dispose(); }
  }

  function captureRequest(request) {
    const url = new URL(request.url());
    if (url.origin !== API || !url.pathname.startsWith('/canvas/')) return;
    const headers = request.headers();
    if (headers.authorization) auth = Object.fromEntries(Object.entries(headers).filter(([key]) =>
      ['authorization','x-team-id','x-rh-lang','user-language','version'].includes(key)));
  }

  async function observe(response) {
    const url = new URL(response.url());
    if (url.origin !== API || !['/canvas/model/list','/canvas/model/group/list'].includes(url.pathname) || !response.ok()) return;
    for (const model of collectModels(await response.json())) models.set(model.code, model);
  }

  async function routeRequest(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== API || request.method() === 'GET' || request.method() === 'OPTIONS') return route.continue();
    if (url.pathname === '/canvas/task/run') {
      if (manualPages.has(request.frame().page())) return route.continue();
      const current = gate;
      if (!current || current.used || request.frame().page() !== current.page || closing) return route.abort('blockedbyclient');
      current.used = true;
      try {
        const headers = request.headers();
        const account = sessionIdentity(headers);
        const body = request.postDataJSON();
        requireThat(String(body?.teamId || '') === String(headers['x-team-id'] || ''), '网页计费主体发生变化');
        const identity = validateSubmission(current.job, body, [...models.values()]);
        const quoteHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) =>
          ['authorization','x-team-id','x-rh-lang','user-language','version'].includes(key)));
        const quote = freeQuote(await api('/canvas/price/calculate', identity.quoteRequest, quoteHeaders));
        requireThat(gate === current && !closing && account === sessionIdentity(auth), '自动提交已暂停或登录账号发生变化');
        // The durable boundary must be saved before releasing the sole upstream POST.
        const upstream = { canvas_id: identity.canvas_id, node_id: identity.node_id,
          model_code: identity.model_code, prompt_hash: identity.prompt_hash, account,
          page_url: `https://rhtv.runninghub.ai/project/canvas/${identity.canvas_id}` };
        await current.onBoundary({ upstream, quote, reference_receipt: identity.references });
        requireThat(gate === current && !closing, '提交前已停止，不再放行请求');
        current.sent = true;
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 60000 });
        try {
          requireThat(response.ok(), '生成请求未得到明确回执，保留原任务，不重投');
          const data = unwrap(await response.json());
          requireThat(typeof data?.taskId === 'string' || Number.isSafeInteger(data?.taskId), '生成回执未包含可用的原任务编号');
          const task_id = String(data.taskId);
          requireThat(validRemoteId(task_id), '生成回执任务编号无效');
          await current.onSubmitted({ ...upstream, task_id });
          await route.fulfill({ response });
          current.resolve({ upstream: { ...upstream, task_id } });
        } finally { await response.dispose(); }
      } catch (error) {
        await route.abort('blockedbyclient').catch(() => {});
        current.reject(error);
      }
      return;
    }
    if (/\/(?:task\/(?:run|create|submit)|generate|execute)(?:\/|$)/i.test(url.pathname)) return route.abort('blockedbyclient');
    return route.continue();
  }

  async function open() {
    if (closing) throw new Error('受控浏览器正在关闭，未重新打开');
    if (context) return context;
    if (opening) return opening;
    opening = (async () => {
      const engine = chromium || require('playwright-core').chromium;
      try {
        context = await engine.launchPersistentContext(path.join(root, 'browser-profile'), {
          channel: 'msedge', headless: false, acceptDownloads: true, viewport: null, serviceWorkers: 'block',
        });
      } catch { throw new Error('无法启动独立 Microsoft Edge，请检查 Edge 安装或浏览器目录占用'); }
      await context.route('**/*', routeRequest);
      context.on('request', captureRequest);
      context.on('response', (response) => {
        const pending = observe(response).catch(() => {}).finally(() => observations.delete(pending));
        observations.add(pending);
      });
      context.on('close', () => { context = undefined; auth = undefined; pages.clear(); prepared.clear(); });
      return context;
    })();
    try { return await opening; } finally { opening = undefined; }
  }

  async function login() {
    const session = await open();
    let page = pages.get('login');
    if (!page || page.isClosed()) { page = await session.newPage(); pages.set('login', page); await page.goto(ENTRY, { waitUntil: 'domcontentloaded' }); }
    await page.bringToFront();
  }

  async function parameters(page, values) {
    const summary = page.getByRole('button', { name: /^(?:自适应|\d+:\d+) \/ (?:480p|768p|1080p) \/ (?:\d+秒|默认)$/ });
    for (const name of [values.aspect_ratio, values.resolution]) {
      requireThat(await summary.count() === 1, '无法唯一识别网页参数菜单，未使用默认参数代替');
      await summary.click();
      const option = page.getByRole('tooltip').getByRole('button', { name, exact: true });
      requireThat(await option.count() === 1, `当前网页不支持所选参数 ${name}`);
      await option.click();
    }
    await summary.click();
    await page.getByRole('tooltip').getByRole('textbox', { name: '生成时长', exact: true }).fill(String(values.duration));
    await page.getByRole('button', { name: `${values.aspect_ratio} / ${values.resolution} / ${values.duration}秒`, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  }

  async function inspectDraft(page, job, plan, preparedImages) {
    await page.getByRole('button', { name: MODEL, exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: modes[job.request.mode], exact: true }).and(page.locator('.video-mode-tab.active')).waitFor({ state: 'visible', timeout: 15000 });
    const prompt = page.locator('.home-agent-input-bar--landing .composer-input');
    requireThat(await prompt.count() === 1 && normalizePrompt(await prompt.innerText()) === normalizePrompt(job.request.prompt), '网页提示词未通过回读');
    const p = job.request.parameters;
    await page.getByRole('button', { name: `${p.aspect_ratio} / ${p.resolution} / ${p.duration}秒`, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const uploads = page.locator('.home-att-upload-overlay');
    for (let index = 0, count = await uploads.count(); index < count; index += 1) {
      await uploads.nth(index).waitFor({ state: 'hidden', timeout: 60000 });
    }
    const images = await page.locator('.home-att-stack-item img.home-att-stack-thumb').evaluateAll((elements) => elements.map((image) => ({
      name: image.getAttribute('alt'), source: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight, complete: image.complete,
    })));
    requireThat(images.length === plan.length, '网页参考图数量不一致');
    const previews = images.map((image, index) => {
      requireThat(image.name === plan[index].name, '网页参考图名称或顺序与本机上传不一致');
      requireThat(image.complete && image.width > 0 && image.height > 0 && typeof image.source === 'string' && image.source.length > 0, '网页参考图尚未加载完成，请查看原网页上传结果');
      // The site may compress, resize or use blob/CDN previews. These are not
      // the original file bytes; freeze the accepted preview, not its encoding.
      const preview = { name: image.name, source_hash: digest(image.source), width: image.width, height: image.height };
      requireThat(!preparedImages || JSON.stringify(preparedImages[index]) === JSON.stringify(preview), '网页参考图在准备后发生变化，请重新核验原任务');
      return preview;
    });
    requireThat(await page.getByRole('button', { name: '开始创作', exact: true }).isEnabled(), '上传未完成、登录失效或网页暂不可提交');
    return previews;
  }

  async function prepare(job, files, { manual = false } = {}) {
    const session = await open();
    requireThat(!prepared.has(job.id), '原网页已准备，不重复上传');
    const page = await session.newPage(); pages.set(job.id, page);
    if (manual) manualPages.add(page);
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: MODEL, exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    const prompt = page.locator('.home-agent-input-bar--landing .composer-input');
    requireThat(await prompt.count() === 1, '无法唯一识别提示词输入框');
    await prompt.fill(job.request.prompt);
    const plan = referencePlan(job.request);
    if (plan.length) {
      const input = page.locator('.home-agent-input-bar--landing input[type="file"]:not(:disabled)');
      requireThat(await input.count() === 1 && (plan.length < 2 || await input.getAttribute('multiple') !== null), '无法唯一识别网页多图上传控件');
      const payloads = plan.map((ref) => {
        const index = job.request.references.findIndex((entry) => entry.slot_index === ref.slot_index);
        const buffer = fs.readFileSync(files[index]);
        requireThat(digest(buffer) === ref.checksum, '本机原图校验失败');
        return { name: ref.name, mimeType: ref.mime, buffer };
      });
      await input.setInputFiles(payloads);
    }
    const mode = page.getByRole('button', { name: modes[job.request.mode], exact: true });
    requireThat(await mode.count() === 1, '网页模式控件发生变化');
    await mode.and(page.locator('.video-mode-tab:not(.disabled)')).waitFor({ state: 'visible', timeout: 60000 });
    await mode.click();
    await parameters(page, job.request.parameters);
    const previews = await inspectDraft(page, job, plan);
    await Promise.allSettled([...observations]);
    prepared.set(job.id, { page, plan, previews });
    return { message: `已回读 ${modes[job.request.mode]}、参数及 ${plan.length} 张参考图；网页可自行处理图片，提交时将重新核验引用和零费用报价。` };
  }

  async function submit(job, callbacks) {
    const draft = prepared.get(job.id);
    requireThat(draft && !draft.page.isClosed() && !gate, '原网页不可用或另一提交正在执行');
    await inspectDraft(draft.page, job, draft.plan, draft.previews);
    sessionIdentity(auth);
    requireThat(models.size > 0, '未取得 H3 网页模型配置，已暂停');
    let timer;
    const result = new Promise((resolve, reject) => {
      gate = { ...callbacks, job, page: draft.page, resolve, reject, used: false, sent: false };
      timer = setTimeout(() => reject(new Error('未取得生成回执，保留原任务，不自动重投')), 120000);
    });
    const current = gate;
    void draft.page.getByRole('button', { name: '开始创作', exact: true }).click().catch(current.reject);
    try { return await result; }
    finally { clearTimeout(timer); if (gate === current) gate = undefined; }
  }

  async function resumePage(job) {
    const upstream = job.upstream;
    requireThat(validRemoteId(upstream?.canvas_id) && validRemoteId(upstream?.node_id), '缺少原画布标识，不能自动恢复');
    const session = await open();
    let page = pages.get(job.id);
    if (!page || page.isClosed()) {
      page = await session.newPage(); pages.set(job.id, page);
      await page.goto(`https://rhtv.runninghub.ai/project/canvas/${upstream.canvas_id}`, { waitUntil: 'domcontentloaded' });
    }
    requireThat(auth && sessionIdentity(auth) === upstream.account, '原任务账号尚未连接或账号已改变，请登录原账号');
    return page;
  }

  return {
    state: () => context ? auth ? 'Edge 已连接 rhTV 登录会话' : 'Edge 已打开，等待登录' : 'Edge 未启动',
    login, prepare, submit,
    async poll(job) {
      await resumePage(job);
      requireThat(validRemoteId(job.upstream.task_id), '任务回执丢失，请在原网页核实；不会自动重新生成');
      return taskResult(await api('/canvas/task/batchStatus', { taskIds: [job.upstream.task_id], includeResults: true }), job.upstream);
    },
    async closeJob(id) { const page = pages.get(id); if (page && !page.isClosed()) await page.close(); pages.delete(id); prepared.delete(id); },
    async show(id, job) {
      let page = pages.get(id);
      if ((!page || page.isClosed()) && job?.upstream) page = await resumePage(job);
      if (!page || page.isClosed()) { await login(); throw new Error('原标签页已关闭，请在网页历史中查找原任务；没有新建生成任务'); }
      await page.bringToFront();
    },
    pause() { if (gate && !gate.sent) { const current = gate; gate = undefined; current.reject(new Error('自动提交已暂停')); } },
    async close() {
      closing = true;
      gate?.reject(new Error('Edge 正在关闭，原任务保留')); gate = undefined;
      if (opening) await opening.catch(() => {});
      if (context) await context.close();
      await Promise.allSettled([...observations]);
    },
  };
}
module.exports = { createRhTvBrowser };
