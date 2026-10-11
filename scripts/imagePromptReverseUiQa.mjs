import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Fresh synthetic project, mocked local APIs, no production profile or external calls.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `image-prompt-reverse-${version}`);
await fs.mkdir(output, { recursive: true });
const result = {
  prompt: '横向构图的写实静物照片。桌面左侧摆放一只青灰色陶杯，右侧是一块浅色木方；柔和左侧窗光，杯口椭圆清晰，陶釉有细小纹理，木纹沿长边展开，背景留白，浅景深，低饱和自然配色。'.repeat(8),
  characters: '未发现可辨人物。', objects: '一只青灰色陶杯及一块浅色木方，分别位于左侧与右侧。',
  scene: '简单室内桌面，背景为空白，主体位于中景。', style: '低饱和自然静物摄影，陶釉和木纹细节清晰。',
  composition: '横构图，中近景，略微俯视，主体左右排列。', lighting: '左侧柔和窗光，阴影朝右。',
  colors: '青灰、浅木色与米白。', readableText: '未发现可辨文字。',
  keyPoints: '保持两件物品的左右关系与陶杯比例。', avoid: '不添加人物或多余物品。', uncertainties: '具体木材品种无法仅凭图片确认。',
};
const report = { passed: false, mockOnly: true, isolatedStorage: true, syntheticImagesOnly: true,
  requests: [], stages: [], layouts: [], screenshots: [], errors: [], expectedDiagnostics: [], blocked: [] };
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser, context, page, storageKey, holdNext = '';
const pending = new Map();
const eventually = async (fn, label, timeout = 16000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Image reverse QA timeout: ${label}`);
};
const readProject = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).project, storageKey);
const reverseTasks = project => project.generationTasks.filter(task => task.kind === 'image-prompt-reverse');
const waitTasks = (fn, label) => eventually(async () => fn(reverseTasks(await readProject())), label);
const nav = name => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const openCustom = async () => { await nav('图像工作台'); await page.getByRole('button', { name: '自定义生图+反推图片提示词', exact: true }).click(); await page.locator('.custom-image-composer').waitFor(); };
const input = () => page.getByLabel('自定义生图要求', { exact: true });
const reverseButton = () => page.getByRole('button', { name: '反推图片提示词', exact: true });
const turn = id => page.locator(`.custom-image-reverse-turn[data-task-id="${id}"]`);
const taskCard = id => page.locator(`#image-prompt-reverse-task-${id}`);
const openDataTasks = async () => { await nav('生成任务'); await page.locator('[data-task-category="autofill"]').click(); };
const capture = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); report.screenshots.push(file); };
const release = async tag => { const held = pending.get(tag); assert.ok(held); held.resolve(); await eventually(() => held.finished, `${tag} response released`); };

try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    // In-memory synthetic media bridge, deliberately without loadState/saveState.
    const media = new Map();
    window.lianhuaDesktop = {
      storeGeneratedImage: async ({ dataUrl, fileName }) => {
        const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0));
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const checksum = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
        const relativePath = `qa/${checksum}.png`; media.set(relativePath, { dataUrl, checksum });
        return { fileName, relativePath, checksum, sizeBytes: bytes.length, mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, url: dataUrl };
      },
      readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
        const item = media.get(relativePath); if (!item || expectedChecksum && item.checksum !== expectedChecksum) throw new Error('Synthetic media missing or checksum mismatch');
        return { dataUrl: item.dataUrl };
      },
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(16000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('[vite] failed to connect to websocket.') || /ERR_ABORTED|ERR_CANCELED|ERR_FAILED/iu.test(message.text())) report.expectedDiagnostics.push(message.text());
    else report.errors.push(message.text());
  });
  await page.routeWebSocket(/.*/u, socket => socket.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) { report.blocked.push(request.url()); await route.abort('blockedbyclient'); return; }
    if (url.pathname === '/__qa_reverse_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>图片反推隔离测试</title><body>合成资料</body></html>' }); return;
    }
    if (url.pathname === '/qa-reverse/vision/v1/chat/completions') {
      let held; const tag = holdNext; holdNext = '';
      try {
        const body = request.postDataJSON(); assert.equal(body.model, 'qa-reverse-vision');
        const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
        assert.equal(images.length, 1, 'reverse analyzes exactly the chosen original'); assert.equal(images[0].image_url.detail, 'high');
        assert.match(images[0].image_url.url, /^data:image\/png;base64,/u);
        report.requests.push({ kind: 'vision', body, tag });
        if (tag) await new Promise(resolve => { held = { resolve, finished: false }; pending.set(tag, held); });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) });
      } catch (error) {
        if (!(tag && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error)))) { report.errors.push(String(error)); await route.fulfill({ status: 500, body: 'Synthetic reverse fixture rejected request' }).catch(() => {}); }
      } finally { if (held) held.finished = true; }
      return;
    }
    if (url.pathname === '/qa-reverse/image/v1/images/generations') {
      const body = request.postDataJSON(); assert.equal(body.prompt, '原生图兼容：生成一只简单陶杯。');
      report.requests.push({ kind: 'image', body });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: await page.evaluate(() => window.__qaOutputImage.split(',')[1]) }] }) }); return;
    }
    if (url.origin === origin && !['GET', 'HEAD'].includes(request.method())) { report.blocked.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  await page.goto(`${origin}/__qa_reverse_fixture.html`);
  storageKey = await page.evaluate(async origin => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts'); const state = createInitialState(), now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const paint = color => { const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 96, 64); ctx.fillStyle = '#75664f'; ctx.fillRect(16, 14, 42, 36); return canvas.toDataURL('image/png'); };
    const library = { id: 'qa-reverse-library', name: '第二张合成参考图', type: 'reference', role: 'composition', referenceRole: 'general',
      dataUrl: paint('#c6d7cc'), mediaType: 'image', mimeType: 'image/png', width: 96, height: 64, source: 'upload', tags: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'qa-reverse-project', name: '图片反推隔离测试', storyDraft: '项目剧情不得加入图片反推。',
      assets: [library], characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], sourceDocuments: [], chapterWorkspaces: {}, customImageDraft: undefined, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.visionApi = { ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible', baseUrl: `${origin}/qa-reverse/vision/v1`, model: 'qa-reverse-vision', apiKey: '' };
    state.settings.imageApi = { ...state.settings.imageApi, enabled: false, backend: 'openai', baseUrl: `${origin}/qa-reverse/image/v1`, model: 'qa-reverse-image', apiKey: '', imageProtocol: 'openai-images', imageResolutionProfile: 'gpt-image-legacy' };
    for (const kind of ['textApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[kind].enabled = false;
    state.settings.textApiProfiles = []; state.settings.visionApiProfiles = []; state.settings.imageApiProfiles = [];
    state.settings.activeTextApiProfileId = null; state.settings.activeVisionApiProfileId = null; state.settings.activeImageApiProfileId = null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return STORAGE_KEY;
  }, origin);
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await openCustom();
  await page.evaluate(() => { window.__qaClipboard = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__qaClipboard = value; } } }); });
  assert.equal(await reverseButton().isEnabled(), false, 'no image disables reverse');
  assert.match(await reverseButton().getAttribute('title'), /先上传|选择参考图/u);
  const uploadPixels = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 112; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d9c2a0'; ctx.fillRect(0, 0, 160, 112); ctx.fillStyle = '#76624d'; ctx.fillRect(32, 18, 68, 74); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('上传自定义生图参考图', { exact: true }).setInputFiles({ name: '第一张合成参考图.png', mimeType: 'image/png', buffer: Buffer.from(uploadPixels, 'base64') });
  await eventually(() => reverseButton().isEnabled(), 'original upload enables reverse with image and text APIs disabled');
  assert.equal(report.requests.length, 0, 'upload does not call AI');
  await reverseButton().click(); await waitTasks(tasks => tasks.length === 1 && tasks[0].status === 'succeeded', 'image-only result saved');
  const first = reverseTasks(await readProject())[0]; assert.equal(first.result.prompt, result.prompt); assert.equal(first.customRequirement || '', '');
  assert.equal(first.width, 160); assert.equal(first.height, 112);
  await eventually(() => turn(first.id).locator('.custom-image-reference-preview img').evaluate(image => image.complete && image.naturalWidth === 160), 'saved original chat thumbnail pixels');
  assert.equal(await turn(first.id).locator('.image-prompt-reverse-section').count(), 5);
  assert.equal(await turn(first.id).locator('.image-prompt-reverse-text').first().textContent(), result.prompt);
  await turn(first.id).getByRole('button', { name: '复制提示词', exact: true }).click(); assert.equal(await page.evaluate(() => window.__qaClipboard), result.prompt);
  await turn(first.id).getByRole('button', { name: '复制全部', exact: true }).click(); assert.match(await page.evaluate(() => window.__qaClipboard), /1、可直接复用[\s\S]*5、具体风格[\s\S]*不确定/u);
  report.stages.push('single original, no requirement, image/text APIs disabled; five sections and complete clipboard');

  await input().fill('重点识别物品材质和光线，不添加人物。'); await reverseButton().click();
  await waitTasks(tasks => tasks.length === 2 && tasks.every(task => task.status === 'succeeded'), 'image plus custom');
  const combined = reverseTasks(await readProject())[0]; assert.equal(combined.customRequirement, '重点识别物品材质和光线，不添加人物。');
  assert.match(JSON.stringify(report.requests[1].body), /重点识别物品材质和光线/u);
  await turn(combined.id).getByRole('button', { name: '填入自定义要求', exact: true }).click();
  await page.getByRole('dialog', { name: '填入反推提示词', exact: true }).waitFor(); assert.equal(await input().inputValue(), combined.customRequirement);
  await page.getByRole('button', { name: '追加到现有要求', exact: true }).click(); assert.equal(await input().inputValue(), `${combined.customRequirement}\n\n${result.prompt}`);
  await turn(combined.id).getByRole('button', { name: '填入自定义要求', exact: true }).click(); await page.getByRole('button', { name: '替换现有要求', exact: true }).click(); assert.equal(await input().inputValue(), result.prompt);
  report.stages.push('custom focus forwarded, unsent draft preserved until explicit append/replace');

  await input().fill('多图中只识别第二张。'); await page.getByRole('button', { name: '从资产库选择', exact: true }).click();
  await page.getByRole('dialog', { name: '从资产库选择参考图', exact: true }).getByRole('button', { name: /第二张合成参考图/u }).click();
  await page.getByRole('button', { name: '使用所选图片', exact: true }).click();
  holdNext = 'background'; await reverseButton().click();
  const picker = page.getByRole('dialog', { name: '选择要反推的图片', exact: true }); await picker.waitFor();
  assert.equal(await picker.locator('.reference-image-picker-item').count(), 2);
  await picker.getByRole('button', { name: /第二张合成参考图/u }).click(); await picker.getByRole('button', { name: '反推所选图片', exact: true }).click();
  await eventually(() => pending.has('background'), 'held analysis starts');
  await waitTasks(tasks => tasks.length === 3 && tasks[0].status === 'running', 'background task recorded');
  const third = reverseTasks(await readProject())[0]; assert.equal(third.referenceAssetId, 'qa-reverse-library');
  await openDataTasks(); await taskCard(third.id).waitFor(); assert.match(await taskCard(third.id).innerText(), /反推中|识别图片细节/u);
  assert.equal(await taskCard(third.id).locator('button').filter({ hasText: /^删除$/u }).isEnabled(), false);
  await release('background'); await waitTasks(tasks => tasks.every(task => task.status === 'succeeded'), 'background task completes on task page');
  await eventually(() => taskCard(third.id).locator('.image-job-preview').evaluate(image => image.tagName === 'IMG' && image.complete && image.naturalWidth === 96), 'saved original task thumbnail pixels');
  assert.equal(await taskCard(third.id).locator('.image-task-prompt-content').textContent(), result.prompt);
  const promptBox = await taskCard(third.id).locator('.image-task-prompt-content').evaluate(element => ({ height: element.getBoundingClientRect().height, overflowY: getComputedStyle(element).overflowY, scrollHeight: element.scrollHeight }));
  assert.ok(promptBox.height <= 132 && promptBox.scrollHeight > promptBox.height); assert.equal(promptBox.overflowY, 'auto');
  await taskCard(third.id).locator('button').filter({ hasText: /^复制提示词$/u }).click(); assert.equal(await page.evaluate(() => window.__qaClipboard), result.prompt);
  await taskCard(third.id).locator('summary').click(); assert.equal(await taskCard(third.id).locator('.image-prompt-reverse-section').count(), 5); await capture('task-card-complete-analysis');
  await taskCard(third.id).getByRole('button', { name: '打开聊天记录', exact: true }).click();
  await turn(third.id).waitFor(); await eventually(() => turn(third.id).evaluate(element => document.activeElement === element), 'task link focuses corresponding chat record');
  report.stages.push('multi-reference single selection; navigation keeps worker alive; same task result, 128px prompt box, full copy and chat focus');

  await input().fill('取消测试的原关注要求。'); holdNext = 'cancel'; await reverseButton().click();
  await page.getByRole('dialog', { name: '选择要反推的图片', exact: true }).getByRole('button', { name: '反推所选图片', exact: true }).click();
  await eventually(() => pending.has('cancel'), 'cancel held request');
  await waitTasks(tasks => tasks.length === 4 && tasks[0].status === 'running', 'cancel task recorded'); const cancelled = reverseTasks(await readProject())[0];
  await turn(cancelled.id).getByRole('button', { name: '停止分析', exact: true }).click();
  await waitTasks(tasks => tasks.find(task => task.id === cancelled.id)?.status === 'cancelled', 'stop locks cancelled state');
  await release('cancel'); assert.equal(reverseTasks(await readProject()).find(task => task.id === cancelled.id).status, 'cancelled');
  await input().fill('这个新草稿不能进入原任务重试。'); await turn(cancelled.id).getByRole('button', { name: '重试反推', exact: true }).click();
  await waitTasks(tasks => tasks.length === 5 && tasks[0].status === 'succeeded', 'retry creates new task'); const retried = reverseTasks(await readProject())[0];
  assert.equal(retried.customRequirement, cancelled.customRequirement); assert.equal(retried.referenceAssetId, cancelled.referenceAssetId);
  assert.equal(await input().inputValue(), '这个新草稿不能进入原任务重试。'); assert.equal(reverseTasks(await readProject()).find(task => task.id === cancelled.id).status, 'cancelled');
  report.stages.push('stop discards late response; retry uses original image and requirement in new task, preserving draft and cancelled history');

  // Fit the renamed entry and all composer controls at both supported scales.
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) for (const scale of [100, 130]) {
    await page.setViewportSize(viewport); await page.getByRole('button', { name: '界面与字体设置', exact: true }).click();
    await page.getByRole('spinbutton', { name: '自定义字体大小百分比', exact: true }).fill(String(scale)); await page.getByRole('button', { name: '关闭界面设置', exact: true }).click();
    const layout = await page.evaluate(() => {
      const entry = [...document.querySelectorAll('button')].find(element => element.textContent === '自定义生图+反推图片提示词');
      const elements = [entry, ...document.querySelectorAll('.custom-image-composer button, .custom-image-composer textarea, .custom-image-controls button, .custom-image-controls select, .custom-image-controls input:not([type=file])')].filter(Boolean);
      const failures = elements.flatMap(element => {
        const r = element.getBoundingClientRect(); if (!r.width || !r.height) return [];
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const clippedBy = [];
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const s = getComputedStyle(parent), b = parent.getBoundingClientRect();
          if ((/(hidden|clip)/u.test(s.overflowX) && (r.x < b.x - 1 || r.right > b.right + 1)) || (/(hidden|clip)/u.test(s.overflowY) && (r.y < b.y - 1 || r.bottom > b.bottom + 1))) clippedBy.push(parent.className);
        }
        return r.x < -1 || r.right > innerWidth + 1 || r.y < -1 || r.bottom > innerHeight + 1 || !(hit === element || element.contains(hit)) || clippedBy.length
          ? [{ name: element.getAttribute('aria-label') || element.textContent, rect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom }, clippedBy }] : [];
      });
      return { width: innerWidth, height: innerHeight, scale: document.querySelector('.app-shell').dataset.uiFontScale,
        failures, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, verticalOverflow: document.documentElement.scrollHeight > innerHeight + 1 };
    });
    assert.deepEqual(layout.failures, []); assert.equal(layout.horizontalOverflow, false); assert.equal(layout.verticalOverflow, false);
    report.layouts.push(layout); await capture(`chat-${viewport.width}x${viewport.height}-${scale}`);
  }
  report.stages.push('renamed tab and complete controls fit 1280/1120 windows at 100/130%');

  const beforeAssets = (await readProject()).assets.map(asset => asset.id); await turn(retried.id).getByRole('button', { name: '删除记录', exact: true }).click();
  await waitTasks(tasks => !tasks.some(task => task.id === retried.id), 'chat deletion removes one shared task'); assert.deepEqual((await readProject()).assets.map(asset => asset.id), beforeAssets);
  await openDataTasks(); assert.equal(await taskCard(retried.id).count(), 0); await openCustom(); assert.equal(await turn(retried.id).count(), 0);
  report.stages.push('deleting chat record also removes task card, retaining original assets');

  const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey); state.settings.imageApi.enabled = true;
  state.project.customImageDraft = { ...state.project.customImageDraft, referenceAssetIds: [], userPrompt: '', promptMode: 'raw', sizePreference: { mode: '1k', width: 1024, height: 1024, aspect: '1:1', resolutionVersion: 1 } };
  state.projects = state.projects.map(project => project.id === state.project.id ? state.project : project);
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: storageKey, state });
  // Reload restores completed task text without touching any desktop profile.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024; canvas.getContext('2d').fillRect(0, 0, 1024, 1024); window.__qaOutputImage = canvas.toDataURL('image/png'); });
  await openCustom(); await input().fill('原生图兼容：生成一只简单陶杯。'); await page.getByRole('button', { name: '发送并生图', exact: true }).click();
  await eventually(async () => (await readProject()).generationTasks.some(task => task.kind === 'image' && task.assetKind === 'custom' && task.status === 'succeeded'), 'original raw image generation completes');
  assert.equal(report.requests.filter(request => request.kind === 'image').length, 1); assert.equal(report.requests.filter(request => request.kind === 'vision').length, 5);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.stages.push('existing raw image generation still sends original prompt once and saves synthetic result');
  report.passed = true; await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, requests: report.requests.length, layoutCases: report.layouts.length, stages: report.stages, report: path.join(output, 'report.json') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure.txt'), `${String(error)}\n\n${await page.locator('body').innerText().catch(() => '')}`); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, error: String(error) }, null, 2)); throw error;
} finally {
  pending.forEach(held => held.resolve()); await context?.close(); await browser?.close(); await server.close();
}
