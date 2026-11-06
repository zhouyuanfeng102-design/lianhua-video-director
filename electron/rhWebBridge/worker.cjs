const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = workerData.root;
const uploadsDir = path.join(root, 'uploads');
const resultsDir = path.join(root, 'results');
const jobsFile = path.join(root, 'jobs.json');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const contexts = new Map();
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); if (!Array.isArray(jobs)) jobs = []; } catch { jobs = []; }
const saveJobs = () => fs.writeFileSync(jobsFile, JSON.stringify(jobs));
const publicJob = (job) => ({
  id: job.id,
  client_id: job.client_id,
  status: job.status,
  message: job.message,
  result_url: job.file ? `http://rhweb.localhost/v1/videos/${job.id}/content` : undefined,
  upstream_task_id: job.upstream_task_id,
});

function hostFor(site) {
  return site === 'cn' ? 'https://www.runninghub.cn' : 'https://www.runninghub.ai';
}

async function openContext(accountId, site, headless = false) {
  const existing = contexts.get(accountId);
  if (existing && existing.context.pages().some((page) => !page.isClosed())) {
    if (Boolean(existing.headless) === Boolean(headless)) return existing;
    await existing.context.close().catch(() => {});
    contexts.delete(accountId);
  }
  const { chromium } = require('playwright-core');
  const profile = path.join(root, 'profiles', accountId);
  fs.mkdirSync(profile, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge',
      headless,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      acceptDownloads: true,
      args: headless ? ['--headless=new', '--disable-gpu'] : [],
    });
  } catch {
    throw new Error(headless
      ? '后台读取网页失败。请确认已安装 Microsoft Edge，并先关掉这个账号已经打开的窗口。'
      : '无法打开登录窗口。请确认已安装 Microsoft Edge，并关掉占用这个账号窗口的旧进程。');
  }
  const entry = { context, site: site === 'cn' ? 'cn' : 'ai', busy: false, headless };
  context.on('close', () => { if (contexts.get(accountId) === entry) contexts.delete(accountId); });
  contexts.set(accountId, entry);
  return entry;
}

async function readSession(page) {
  return page.evaluate(() => {
    const ownText = (element) => [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent || '').join('').replace(/\s+/gu, ' ').trim();
    const header = document.querySelector('.header-right') || document.querySelector('.common-header') || document.body;
    const login = [...header.querySelectorAll('button, a, span, div')].some((element) => ownText(element) === '登录/注册' || (element.textContent || '').trim() === '登录/注册');
    const titles = [...header.querySelectorAll('[title]')].map((element) => element.getAttribute('title') || '');
    const coins = titles.find((title) => title.startsWith('RH币')) || '';
    const wallet = titles.find((title) => /\$|美元|钱包/u.test(title) && title !== coins) || '';
    const nickFrom = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return '';
      if (typeof value.nickName === 'string' && value.nickName.trim()) return value.nickName.trim();
      for (const child of Object.values(value)) {
        if (!child || typeof child !== 'object') continue;
        const found = nickFrom(child, depth + 1);
        if (found) return found;
      }
      return '';
    };
    let displayName = '';
    try {
      const raw = localStorage.getItem('rh-login-user-info');
      if (raw) displayName = nickFrom(JSON.parse(raw));
    } catch { /* The login record is optional. */ }
    if (!displayName) {
      const named = header.querySelector('[class*="nick"], [class*="user-name"], [class*="userName"]');
      displayName = named ? ownText(named) || (named.textContent || '').trim() : '';
    }
    return { loggedIn: !login, displayName, coins, wallet };
  });
}

async function pageFor(entry, url) {
  const page = entry.context.pages().find((item) => !item.isClosed()) || await entry.context.newPage();
  const current = page.url();
  if (!current.startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    await page.waitForSelector('.ai-side .media-group-item-label, .ai-side textarea', { timeout: 20000 });
  } catch {
    throw new Error('网页表单还没加载出来，没有提交。');
  }
  return page;
}

async function readForm(page) {
  return page.evaluate(() => {
    const side = document.querySelector('.ai-side');
    if (!side) return { fields: [], instance: '', estimate: '' };
    const fields = [];
    let image = 0;
    let audio = 0;
    let lora = 0;
    let text = 0;
    let number = 0;
    let boolean = 0;
    for (const label of side.querySelectorAll('.media-group-item-label')) {
      const name = (label.getAttribute('title') || label.textContent || '').trim();
      if (!name) continue;
      const isAudio = /^audio/iu.test(name);
      if (isAudio) audio += 1;
      else image += 1;
      fields.push({ key: isAudio ? `audio:${audio}` : `image:${image}`, label: name, kind: isAudio ? 'audio' : 'image', value: '' });
    }
    for (const title of side.querySelectorAll('.plane-top .title')) {
      const name = (title.getAttribute('title') || title.textContent || '').trim();
      if (!name || name === '上传图片' || name === '上传音频') continue;
      const plane = title.closest('.item-plane, .side-plane') || title.parentElement?.parentElement;
      if (!plane) continue;
      if (/^lora_name$/iu.test(name)) {
        lora += 1;
        const shown = [...plane.querySelectorAll('.ant-select-selection-item, .ant-select-selection-search-input')]
          .map((node) => (node.value || node.textContent || '').trim())
          .find((value) => value && !/strength/iu.test(value)) || '';
        fields.push({ key: `lora:${lora}:name`, label: `lora_name ${lora}`, kind: 'text', value: shown });
        const strength = plane.querySelector('input[type="number"]');
        if (strength) fields.push({ key: `lora:${lora}:strength`, label: `strength_model ${lora}`, kind: 'number', value: strength.value });
        continue;
      }
      const toggle = plane.querySelector('[role="switch"]');
      const area = plane.querySelector('textarea');
      const numeric = plane.querySelector('input[type="number"]');
      const selected = plane.querySelector('.ant-select-selection-item');
      if (toggle) {
        boolean += 1;
        const key = name === '自动提示词' ? 'boolean:auto-prompt' : name.includes('输出') ? 'boolean:output' : `boolean:${boolean}`;
        fields.push({ key, label: name, kind: 'boolean', value: toggle.getAttribute('aria-checked') === 'true' });
      } else if (area) {
        text += 1;
        const key = name === '提示词' ? 'text:prompt' : /触发/u.test(name) ? 'text:trigger' : `text:${text}`;
        fields.push({ key, label: name, kind: 'text', value: area.value });
      } else if (numeric && !/aspect|比例/iu.test(name)) {
        number += 1;
        const key = /时长/u.test(name) ? 'number:duration' : /像素|megapixel/iu.test(name) ? 'number:megapixels' : `number:${number}`;
        fields.push({ key, label: name, kind: 'number', value: numeric.value });
      } else if (selected || /aspect|比例/iu.test(name)) {
        fields.push({ key: 'select:aspect', label: name, kind: 'select', value: (selected?.textContent || '').trim(), options: [] });
      }
    }
    const instance = (document.querySelector('.run-mode-current')?.textContent || '').trim();
    const estimate = (document.body.innerText.match(/≈\s*[\d.]+\s*RH币/u) || [])[0] || '';
    const heading = document.querySelector('h1.ai-title');
    const name = (heading?.getAttribute('title') || heading?.textContent || '').replace(/\s+/gu, ' ').trim();
    return { fields, instance, estimate, ...(name ? { name } : {}) };
  });
}

async function readAspectOptions(page) {
  const select = page.locator('.ai-side').locator('.ant-select').first();
  if (await select.count() !== 1) return [];
  await select.click();
  await page.waitForTimeout(400);
  const options = await page.locator('.ant-select-item-option-content').allInnerTexts();
  await page.keyboard.press('Escape');
  return [...new Set(options.map((item) => item.trim()).filter(Boolean))];
}

const exactText = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');

async function mediaItem(page, label) {
  const items = page.locator('.ai-side .media-group-item').filter({
    has: page.locator('.media-group-item-label', { hasText: exactText(label) }),
  });
  const count = await items.count();
  if (!count) throw new Error(`网页上找不到 ${label}`);
  for (let index = 0; index < count; index += 1) {
    const candidate = items.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return items.first();
}

async function clearExampleMedia(item) {
  await item.hover().catch(() => {});
  const remove = item.locator('.removeIcon, .ai-audio-upload__close');
  if (await remove.count() < 1) return;
  await remove.first().click();
  await remove.first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
}

async function setFiles(page, label, filePath) {
  const item = await mediaItem(page, label);
  await clearExampleMedia(item);
  if (!filePath) return;
  const input = item.locator('input[type="file"]').first();
  if (await input.count() > 0) {
    await input.setInputFiles(filePath);
  } else {
    const target = item.locator('.upload-cover-wrap, .ai-audio-upload__title').first();
    const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
    await target.click();
    const dialog = await chooser;
    await dialog.setFiles(filePath);
  }
  await item.locator('.removeIcon, .ai-audio-upload__close, .history-medium').first().waitFor({ state: 'attached', timeout: 60000 });
}

async function planeFor(page, assignment) {
  const loraIndex = /^lora:(\d+):/u.exec(assignment.key);
  if (loraIndex) {
    const planes = page.locator('.ai-side .item-plane, .ai-side .side-plane').filter({ has: page.locator('.title', { hasText: exactText('lora_name') }) });
    const plane = planes.nth(Number(loraIndex[1]) - 1);
    if (await plane.count() !== 1) throw new Error(`网页上找不到第 ${loraIndex[1]} 组 LoRA`);
    return plane;
  }
  const title = assignment.label.replace(/ \d+$/u, '');
  const plane = page.locator('.ai-side .item-plane, .ai-side .side-plane').filter({ has: page.locator('.title', { hasText: exactText(title) }) }).first();
  if (await plane.count() !== 1) throw new Error(`网页上找不到 ${assignment.label}`);
  return plane;
}

async function loraNamePlane(page, index) {
  const planes = page.locator('.ai-side .item-plane').filter({
    has: page.locator('.plane-top > .title', { hasText: exactText('lora_name') }),
  });
  const plane = planes.nth(index - 1);
  if (await plane.count() < 1) throw new Error(`网页上找不到第 ${index} 组 LoRA`);
  return plane;
}

const sameModel = (left, right) => {
  const normalize = (value) => value.trim().toLowerCase().replace(/\.safetensors$/u, '');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a) && a === b;
};

async function fillLoraName(page, assignment) {
  const index = Number(/^lora:(\d+):/u.exec(assignment.key)[1]);
  const plane = await loraNamePlane(page, index);
  const wanted = String(assignment.value || '').trim();
  const shown = plane.locator('.mode-title').first();
  const current = ((await shown.getAttribute('title')) || (await shown.textContent()) || '').trim();
  if (!wanted || sameModel(current, wanted)) return;
  await plane.locator('.change-btn').click();
  const dialog = page.locator('.resource-select-modal');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  const search = dialog.getByPlaceholder('搜索模型');
  const query = wanted.replace(/\.safetensors$/iu, '');
  const quoted = (value) => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  const title = () => dialog.locator(`[title="${quoted(wanted)}"], [title="${quoted(query)}.safetensors"]`).first();
  await search.fill(query);
  await search.press('Enter');
  let found = await title().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!found) {
    const mine = dialog.getByText('我上传的', { exact: true });
    if (await mine.count()) await mine.click();
    await search.fill(query);
    await search.press('Enter');
    found = await title().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  }
  if (!found) {
    await page.keyboard.press('Escape');
    throw new Error(`网页模型列表里没有 ${wanted}，没有点击运行。`);
  }
  const picked = await title().evaluate((node) => {
    let current = node;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const button = [...current.querySelectorAll('button')].find((item) => (item.textContent || '').trim() === '立即使用');
      if (button) { button.click(); return true; }
      current = current.parentElement;
    }
    return false;
  });
  if (!picked) throw new Error(`网页模型列表里没有 ${wanted}，没有点击运行。`);
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
}

async function fillLoraStrength(page, assignment) {
  const index = Number(/^lora:(\d+):/u.exec(assignment.key)[1]);
  const plane = await loraNamePlane(page, index);
  const input = plane.locator('xpath=following-sibling::div[contains(@class,"item-plane")][1]//input[@type="number"]');
  if (await input.count() < 1) throw new Error(`网页上找不到第 ${index} 组 LoRA 强度`);
  await input.fill(String(assignment.value));
  await input.blur();
}

async function fillControl(page, assignment) {
  if (/^lora:\d+:name$/u.test(assignment.key)) {
    await fillLoraName(page, assignment);
    return;
  }
  if (/^lora:\d+:strength$/u.test(assignment.key)) {
    await fillLoraStrength(page, assignment);
    return;
  }
  if (assignment.kind === 'image' || assignment.kind === 'audio') {
    const filePath = typeof assignment.value === 'string' ? assignment.value : '';
    if (filePath) {
      const saved = path.resolve(filePath);
      if (path.relative(path.resolve(uploadsDir), saved).startsWith('..')) throw new Error('网页素材路径无效。');
      await setFiles(page, assignment.label, saved);
      return;
    }
    await setFiles(page, assignment.label, '');
    return;
  }
  const plane = await planeFor(page, assignment);
  if (assignment.kind === 'boolean') {
    const toggle = plane.locator('[role="switch"]').first();
    const checked = (await toggle.getAttribute('aria-checked')) === 'true';
    if (checked !== Boolean(assignment.value)) await toggle.click();
    return;
  }
  if (assignment.kind === 'number') {
    const input = /^lora:\d+:strength$/u.test(assignment.key) ? plane.locator('input[type="number"]').first() : plane.locator('input[type="number"]').first();
    await input.fill(String(assignment.value));
    await input.blur();
    return;
  }
  if (assignment.kind === 'select') {
    await plane.locator('.ant-select').first().click();
    await page.getByText(String(assignment.value), { exact: true }).last().click();
    return;
  }
  const area = plane.locator('textarea');
  if (await area.count()) {
    await area.first().fill(String(assignment.value));
    return;
  }
  const select = plane.locator('.ant-select').first();
  if (await select.count()) {
    await select.click();
    await page.getByText(String(assignment.value), { exact: true }).last().click();
    return;
  }
  throw new Error(`网页上的 ${assignment.label} 不是可填写的文本框。`);
}

async function chooseInstance(page, instance) {
  const current = ((await page.locator('.run-mode-current').first().textContent()) || '').trim();
  if (!instance || current === instance) return;
  await page.locator('.run-mode-current').first().click();
  const option = page.getByText(instance, { exact: true }).last();
  if (await option.count() < 1) throw new Error(`网页运行机型里没有 ${instance}`);
  await option.click();
}

function rememberTask(page) {
  const found = [];
  const onResponse = async (response) => {
    if (response.request().method() !== 'POST') return;
    try {
      const body = await response.json();
      const id = body?.data?.taskId || body?.taskId || body?.data?.id;
      if (id) found.push(String(id));
    } catch { /* The page returns many non-task responses. */ }
  };
  page.on('response', onResponse);
  return { found, stop: () => page.off('response', onResponse) };
}

async function runJob(entry, body) {
  const existing = jobs.find((job) => job.client_id === body.client_id);
  if (existing) return publicJob(existing);
  if (entry.busy) throw new Error('这个账号的网页正在处理上一条任务。');
  entry.busy = true;
  const job = {
    id: randomUUID(),
    client_id: body.client_id,
    account_id: body.account_id,
    page_url: body.page_url,
    status: 'preparing',
    message: '正在按绑定填写网页',
    handed_off: false,
    created_at: Date.now(),
  };
  jobs.push(job);
  saveJobs();
  try {
    const page = await pageFor(entry, body.page_url);
    const login = page.getByText('登录/注册', { exact: true });
    if (await login.count()) throw new Error('这个网页窗口还没登录 RunningHub。请先点登录并在窗口里完成登录。');
    const assignments = body.fields || [];
    for (const assignment of assignments) {
      if (assignment.kind === 'image' || assignment.kind === 'audio') continue;
      await fillControl(page, assignment);
    }
    for (const assignment of assignments) {
      if (assignment.kind !== 'image' && assignment.kind !== 'audio') continue;
      if (typeof assignment.value === 'string' && assignment.value && !assignment.value.startsWith(uploadsDir)) {
        throw new Error('网页素材路径无效。');
      }
      await fillControl(page, assignment);
    }
    await chooseInstance(page, body.instance);
    const quote = ((await page.locator('body').innerText()).match(/≈\s*[\d.]+\s*RH币/u) || [])[0];
    if (!quote) throw new Error('网页上没有读到预估 RH 币，没有点击运行。');
    job.message = `网页预估 ${quote}，正在点击运行`;
    job.handed_off = true;
    job.status = 'submission_unknown';
    saveJobs();
    const watch = rememberTask(page);
    await page.locator('.run-cell-main').filter({ hasText: '立即运行' }).click();
    const started = Date.now();
    while (!watch.found.length && Date.now() - started < 20000) await page.waitForTimeout(500);
    watch.stop();
    if (!watch.found.length) {
      job.message = '已经点击运行，但页面没有返回任务编号。请在网页的“我的生成”里核对，软件不会再点一次。';
      saveJobs();
      return publicJob(job);
    }
    job.upstream_task_id = watch.found[0];
    job.status = 'running';
    job.message = `网页任务 ${job.upstream_task_id} 已提交，预估 ${quote}`;
    saveJobs();
    return publicJob(job);
  } catch (error) {
    if (job.handed_off) {
      job.status = 'submission_unknown';
      job.message = `${error.message} 已经交到网页，不会再点运行。`;
      saveJobs();
      return publicJob(job);
    }
    jobs = jobs.filter((item) => item.id !== job.id);
    saveJobs();
    throw error;
  } finally {
    entry.busy = false;
  }
}

async function openMyGenerations(page) {
  const tab = page.locator('.tab-pill', { hasText: exactText('我的生成') }).last();
  if (await tab.count() < 1) throw new Error('网页上没有「我的生成」。');
  const active = async () => tab.evaluate((node) => node.classList.contains('active'));
  if (!(await active())) await tab.click();
  if (!(await active())) await tab.evaluate((node) => node.click());
}

async function downloadMarkedResult(page, taskId, jobId) {
  await openMyGenerations(page);
  const seen = await page.waitForFunction((id) => {
    const tab = [...document.querySelectorAll('.tab-pill')].find((node) => (node.textContent || '').trim() === '我的生成');
    return Boolean(tab?.classList.contains('active') && document.body.innerText.includes(id));
  }, taskId, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!seen) return '';
  const panel = page.locator('.detail-right');
  const button = (await panel.count() ? panel : page).getByText('下载', { exact: true }).last();
  if (await button.count() < 1) return '';
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await button.click();
  const download = await downloadPromise;
  const extension = (path.extname(download.suggestedFilename() || '').toLowerCase() || '.mp4');
  if (!['.mp4', '.webm', '.mov'].includes(extension)) {
    await download.cancel().catch(() => {});
    throw new Error('网页「下载」得到的不是视频文件，没有入库。');
  }
  const file = path.join(resultsDir, `${jobId}${extension}`);
  await download.saveAs(file);
  return file;
}

async function refreshJob(job) {
  if (job.file || job.status === 'failed' || job.status === 'cancelled' || !job.upstream_task_id) return publicJob(job);
  const entry = contexts.get(job.account_id);
  if (!entry) return publicJob({ ...job, message: '网页窗口已关闭。打开同一账号的窗口后可以继续查看原任务。' });
  if (entry.busy) return publicJob(job);
  entry.busy = true;
  try {
    const page = await pageFor(entry, job.page_url);
    if (job.next_download_at && Date.now() < job.next_download_at) return publicJob(job);
    let file = '';
    try {
      file = await downloadMarkedResult(page, job.upstream_task_id, job.id);
    } catch (error) {
      job.next_download_at = Date.now() + 20000;
      job.status = 'running';
      job.message = `${error.message} 播放器里的预览没有当作成片。`;
      saveJobs();
      return publicJob(job);
    }
    if (!file) {
      const visible = (await page.locator('body').innerText()).includes(job.upstream_task_id);
      job.status = 'running';
      job.message = visible
        ? `网页任务 ${job.upstream_task_id} 已出现，还没有可点的「下载」`
        : `网页任务 ${job.upstream_task_id} 还没出现在“我的生成”里`;
      saveJobs();
      return publicJob(job);
    }
    job.file = file;
    job.status = 'succeeded';
    job.message = `已从网页「我的生成」下载任务 ${job.upstream_task_id}`;
    saveJobs();
    return publicJob(job);
  } finally {
    entry.busy = false;
  }
}

async function handleRequest(payload) {
  const url = new URL(payload.url);
  if (url.hostname !== 'rhweb.localhost') throw new Error('RH 网页桥接拒绝这个地址。');
  if (url.pathname === '/v1/assets' && (payload.method || 'GET').toUpperCase() === 'POST') {
    const file = payload.multipart?.files?.[0];
    const match = String(file?.dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match) throw new Error('网页素材内容无效。');
    const id = randomUUID();
    const extension = match[1].includes('wav') ? '.wav' : match[1].includes('mpeg') || match[1].includes('mp3') ? '.mp3' : match[1].includes('webp') ? '.webp' : match[1].includes('jpeg') ? '.jpg' : '.png';
    const saved = path.join(uploadsDir, `${id}${extension}`);
    fs.writeFileSync(saved, Buffer.from(match[2], 'base64'));
    return { status: 200, body: JSON.stringify({ upload_id: saved }) };
  }
  if (url.pathname === '/v1/videos' && (payload.method || '').toUpperCase() === 'POST') {
    const body = JSON.parse(payload.body || '{}');
    if (!body.client_id || !body.account_id || !body.page_url) throw new Error('RH 网页任务缺少账号或页面。');
    const entry = await openContext(body.account_id, body.page_url.includes('runninghub.cn') ? 'cn' : 'ai', true);
    const job = await runJob(entry, body);
    return { status: 200, body: JSON.stringify(job) };
  }
  const status = url.pathname.match(/^\/v1\/videos\/([0-9a-f-]{36})$/u);
  if (status && (payload.method || 'GET').toUpperCase() === 'GET') {
    const job = jobs.find((item) => item.id === status[1]);
    if (!job) return { status: 404, body: JSON.stringify({ message: '找不到这条网页任务' }) };
    return { status: 200, body: JSON.stringify(await refreshJob(job)) };
  }
  const byClient = url.pathname.match(/^\/v1\/videos\/by-client\/([^/]+)$/u);
  if (byClient) {
    const clientId = decodeURIComponent(byClient[1]);
    const job = jobs.find((item) => item.client_id === clientId);
    if (!job) return { status: 200, body: JSON.stringify({ client_id: clientId }) };
    return { status: 200, body: JSON.stringify(await refreshJob(job)) };
  }
  throw new Error('RH 网页桥接没有这个操作。');
}

parentPort.on('message', async ({ id, action, payload }) => {
  try {
    if (action === 'close') {
      for (const entry of contexts.values()) await entry.context.close().catch(() => {});
      contexts.clear();
      parentPort.postMessage({ id, result: { running: false, message: 'RH 网页窗口已关闭' } });
      return;
    }
    if (action === 'login') {
      const entry = await openContext(payload.accountId, payload.site);
      const page = entry.context.pages().find((item) => !item.isClosed()) || await entry.context.newPage();
      await page.goto(`${hostFor(payload.site)}/zh-cn`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.bringToFront().catch(() => {});
      const session = await readSession(page).catch(() => ({ loggedIn: false, displayName: '', coins: '', wallet: '' }));
      parentPort.postMessage({ id, result: { running: true, open: true, ...session, message: '登录窗口已打开。在窗口里登录后，软件会显示这个窗口里的昵称和 RH 币。' } });
      return;
    }
    if (action === 'session') {
      const entry = contexts.get(payload.accountId);
      const pages = entry ? entry.context.pages().filter((page) => !page.isClosed()) : [];
      if (!pages.length) {
        parentPort.postMessage({ id, result: { open: false, loggedIn: false, displayName: '', coins: '', wallet: '' } });
        return;
      }
      let session = { loggedIn: false, displayName: '', coins: '', wallet: '' };
      for (const page of pages) {
        const read = await readSession(page);
        session = read;
        if (read.loggedIn) break;
      }
      parentPort.postMessage({ id, result: { open: true, ...session } });
      return;
    }
    if (action === 'read') {
      const entry = await openContext(payload.accountId, payload.site, true);
      const page = await pageFor(entry, payload.url);
      const form = await readForm(page);
      const aspect = form.fields.find((item) => item.key === 'select:aspect');
      if (aspect) aspect.options = await readAspectOptions(page);
      if (!form.fields.length) throw new Error('后台没有读到生成表单。请确认应用页地址，登录过的账号会沿用已保存的登录状态。');
      parentPort.postMessage({ id, result: form });
      return;
    }
    if (action === 'request') {
      parentPort.postMessage({ id, result: await handleRequest(payload) });
      return;
    }
    if (action === 'forget') {
      const accountId = String(payload.accountId || '');
      if (!/^[A-Za-z0-9-]{1,80}$/u.test(accountId)) throw new Error('这个登录位编号无效，没有删除网页登录。');
      const entry = contexts.get(accountId);
      if (entry) {
        await entry.context.close().catch(() => {});
        contexts.delete(accountId);
      }
      const profilesRoot = path.resolve(root, 'profiles');
      const profile = path.resolve(profilesRoot, accountId);
      const prefix = profilesRoot.endsWith(path.sep) ? profilesRoot : `${profilesRoot}${path.sep}`;
      if (!profile.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error('登录位路径无效，没有删除网页登录。');
      try { fs.rmSync(profile, { recursive: true, force: true }); }
      catch { throw new Error('这个登录位的网页窗口还占着登录数据。请关掉登录窗口后再删除。'); }
      parentPort.postMessage({ id, result: { running: true, message: '已去掉这个登录位保存的网页登录。' } });
      return;
    }
    if (action === 'result-file') {
      const job = jobs.find((item) => item.id === payload.jobId && item.file);
      if (!job) throw new Error('这条网页任务还没有成片文件。');
      parentPort.postMessage({ id, result: job.file });
      return;
    }
    throw new Error('RH 网页操作无效');
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
