import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A single focused run of the real App: synthetic task history only. No desktop
// bridge, credentials, worker, generation action or external request is used.
const root = path.resolve(import.meta.dirname, '..');
const runId = Date.now();
const output = path.join(root, 'output', 'playwright', `image-task-generation-mode-${runId}`);
const cacheDir = path.join(root, `.qa-image-task-generation-mode-${runId}`, 'vite');
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({cacheDir:${JSON.stringify(cacheDir)},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Image task generation mode QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'image task generation mode', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let page; let storageKey;
const checks = []; const errors = []; const blockedRequests = []; const screenshots = []; const layout = [];
const mark = (label) => { checks.push(label); console.log(label); };
const card = (id) => page.locator(`#image-task-${id}`);
const cases = [
  { id: 'qa-text', name: '普通人物 · 空参考文生图', label: '文生图' },
  { id: 'qa-reference', name: '普通人物 · 已选参考图', label: '图生图' },
  { id: 'qa-primary', name: '普通人物 · 已保存主参考图', label: '图生图' },
  { id: 'qa-frozen', name: '失败 · 已冻结参考图', label: '图生图' },
  { id: 'qa-direct', name: '分镜 · 已取消直接图生图', label: '图生图' },
  { id: 'qa-storyboard-text', name: '分镜 · 明确空参考图片输入', label: '文生图' },
  { id: 'qa-unknown', name: '旧记录 · 生图模式未保存', label: '方式未记录' },
  { id: 'qa-converted-reference', name: '分镜 · 转换路径仍传参考图', label: '图生图' },
  { id: 'qa-upload-preview', name: '普通人物 · 直接上传预览输入', label: '图生图' },
  { id: 'qa-primary-only-empty', name: '旧记录 · 仅主参考为空', label: '方式未记录' },
];
const badge = ({ id, name }) => card(id).getByLabel(`「${name}」的生图方式`, { exact: true });
const capture = async (name, locator) => {
  const file = path.join(output, `${name}.png`);
  if (locator) await locator.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, animations: 'disabled', fullPage: false });
  screenshots.push(file);
};

async function checkBadges(view) {
  for (const item of cases) {
    await card(item.id).scrollIntoViewIfNeeded();
    assert.equal(await badge(item).textContent(), item.label, item.id);
    await badge(item).waitFor({ state: 'visible' });
    const geometry = await badge(item).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const container = element.closest('.image-job-card').getBoundingClientRect();
      const previous = element.previousElementSibling;
      const title = previous?.getBoundingClientRect(); const style = getComputedStyle(element);
      return { text: element.textContent, previousTag: previous?.tagName, previousText: previous?.textContent,
        title: title && { top: title.top, bottom: title.bottom, left: title.left, right: title.right },
        badge: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height },
        background: style.backgroundColor, foreground: style.color,
        clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
        insideCard: bounds.left >= container.left - 1 && bounds.right <= container.right + 1,
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    assert.equal(geometry.previousTag, 'STRONG', `${item.id}: badge must immediately follow task title`);
    assert.equal(geometry.previousText, item.name);
    assert.equal(geometry.clipped || !geometry.insideCard || geometry.documentOverflow, false, `${item.id}: mode badge must fit`);
    assert.ok(geometry.badge.width > 0 && geometry.badge.height > 0);
    assert.ok(geometry.badge.top >= geometry.title.top - 6, `${item.id}: mode follows title in reading order`);
    if (Math.abs(geometry.badge.top - geometry.title.top) < 6) {
      assert.ok(geometry.badge.left >= geometry.title.right - 1, `${item.id}: mode is to the right of title`);
    }
    assert.notEqual(geometry.foreground, geometry.background, `${item.id}: readable foreground`);
    layout.push({ view, id: item.id, ...geometry });
  }
}

async function updateFixture(patch) {
  await page.locator('.jobs-view').evaluate((element, patch) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let component = key && element[key];
    while (component && !(typeof component.memoizedProps?.setBackgroundState === 'function' && component.memoizedProps?.state)) component = component.return;
    if (!component) throw new Error('Cannot locate real generation task context');
    component.memoizedProps.setBackgroundState((current) => {
      if (current.project.id !== 'qa-image-task-generation-mode-project') throw new Error('Only the synthetic fixture may be changed');
      const project = { ...current.project,
        ...(patch.removeCurrentReference ? { assets: current.project.assets.filter((asset) => asset.id !== 'qa-reference-asset') } : {}),
        ...(patch.liveStatuses ? { generationTasks: current.project.generationTasks.map((task) => task.id === 'qa-text' || task.id === 'qa-reference'
          ? { ...task, status: task.id === 'qa-text' ? 'queued' : 'running', error: undefined } : task) } : {}),
      };
      return { ...current, project, projects: current.projects.map((item) => item.id === project.id ? project : item),
        ...(patch.theme ? { settings: { ...current.settings, theme: patch.theme } } : {}),
      };
    });
  }, patch);
}

const run = async () => {
  assert.match(fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8'), /的生图方式/u, 'Product must be ready before this focused run');
  await waitForCondition({ label: 'image generation mode App Vite', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.hostname === '127.0.0.1' && url.port === String(port) && url.pathname === '/') { socket.connectToServer(); return; }
    blockedRequests.push(`WEBSOCKET ${socket.url()}`); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== base || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__image_mode_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Neutral image mode fixture</title><body>Only synthetic task history</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${base}/__image_mode_fixture.html`);
  storageKey = await page.evaluate(async (cases) => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const { createImageGenerationTask } = await import('/src/generationTasks.ts');
    const state = createInitialState(); const now = 1791561900000;
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#a9c5cc'; paint.fillRect(0, 0, 80, 80);
    paint.fillStyle = '#e8e3d2'; paint.fillRect(20, 25, 40, 35); const dataUrl = canvas.toDataURL();
    const reference = { id: 'qa-reference-asset', name: '合成中性参考图', type: 'reference', role: 'character', mediaType: 'image', source: 'upload', dataUrl, tags: [], createdAt: now, updatedAt: now };
    const frozen = { id: reference.id, name: reference.name, type: reference.type, role: reference.role, mediaType: 'image', managed: true, relativePath: 'assets/image/qa-neutral.png', checksum: 'a'.repeat(64) };
    const task = (index, status, extra = {}) => ({ ...createImageGenerationTask({ id: cases[index].id, name: cases[index].name,
      assetKind: index === 4 || index === 5 || index === 7 ? 'storyboard' : 'character', imageVariant: 'reference',
      prompt: 'A neutral ceramic cube on a clean studio table in soft daylight.', backend: 'openai', model: 'isolated-no-api', width: 1024, height: 1024,
    }, now + index, status), resultUrl: dataUrl, ...extra });
    const tasks = [
      task(0, 'failed', { referenceAssetIds: [] }),
      task(1, 'failed', { referenceAssetIds: [reference.id] }),
      task(2, 'succeeded', { primaryReferenceAssetIds: [reference.id] }),
      task(3, 'failed', { referenceAssetSnapshots: [frozen], error: '纯合成历史失败，无请求。' }),
      task(4, 'cancelled', { imageGenerationMode: 'image-to-image', referenceAssetIds: [] }),
      task(5, 'succeeded', { primaryReferenceAssetIds: [], referenceAssetSnapshots: [] }),
      task(6, 'failed', { error: '纯合成旧记录，无请求。' }),
      task(7, 'succeeded', { imageGenerationMode: 'text-to-image', referenceAssetIds: [reference.id] }),
      task(8, 'succeeded', { imageInputMode: 'image-to-image', referenceAssetIds: [], primaryReferenceAssetIds: [], referenceAssetSnapshots: [] }),
      task(9, 'failed', { primaryReferenceAssetIds: [], error: '纯合成旧记录，无请求。' }),
    ];
    const project = { ...state.project, id: 'qa-image-task-generation-mode-project', name: '生图方式隔离检查', description: '纯合成中性数据',
      sourceDocuments: [], scenes: [], characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets: [reference], generationTasks: tasks, createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name] = { ...state.settings[name], enabled: false, apiKey: '' };
    for (const kind of ['Text', 'Vision', 'Image', 'Video']) { state.settings[`${kind.toLowerCase()}ApiProfiles`] = []; state.settings[`active${kind}ApiProfileId`] = null; }
    state.settings.apiCredentialBook = []; state.settings.uiFontScalePercent = 100; state.settings.theme = 'light'; state.settings.themeColor = 'classic';
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return STORAGE_KEY;
  }, cases);
  await page.goto(base, { waitUntil: 'networkidle', timeout: 50000 });
  assert.equal(await page.evaluate(() => typeof window.lianhuaDesktop), 'undefined');
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click(); await page.locator('.jobs-view').waitFor();
  // Reload normalizes interrupted work; set live display statuses only through
  // the existing App state setter. No task worker is invoked.
  await updateFixture({ liveStatuses: true });
  await card('qa-text').locator('button').filter({ hasText: /^取消排队$/u }).waitFor();
  await card('qa-reference').locator('button').filter({ hasText: /^不可删除$/u }).waitFor();
  await checkBadges('light-1480x1100');
  await card('qa-text').scrollIntoViewIfNeeded(); await capture('light-desktop');
  mark('queued/running/succeeded/failed/cancelled ordinary and storyboard tasks show saved generation mode immediately after task title');
  mark('saved empty references display text-to-image; saved reference IDs/primary IDs/frozen snapshots display image-to-image; explicit direct mode and unrecorded legacy history remain distinct');
  mark('converter text-to-image path with submitted references stays image-to-image; explicit actual-input mode records uploaded preview despite empty IDs; primary-only empty history remains unrecorded');
  await updateFixture({ theme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'dark');
  await page.setViewportSize({ width: 1040, height: 1100 }); await checkBadges('dark-1040x1100');
  await card('qa-text').scrollIntoViewIfNeeded(); await capture('dark-narrow'); await capture('dark-narrow-direct-mode-card', card('qa-direct'));
  mark('classic light desktop and night narrow desktop keep badges visible, positioned after title and within card without horizontal overflow');
  const originalTaskFacts = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks.map(({ id, imageInputMode, imageGenerationMode, referenceAssetIds, primaryReferenceAssetIds, referenceAssetSnapshots }) => ({ id, imageInputMode, imageGenerationMode, referenceAssetIds, primaryReferenceAssetIds, referenceAssetSnapshots })), storageKey);
  assert.equal(originalTaskFacts.find((task) => task.id === 'qa-upload-preview').imageInputMode, 'image-to-image', 'normalize and initial save retain actual preview input mode');
  await updateFixture({ removeCurrentReference: true });
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.assets.length === 0, storageKey);
  for (const item of cases) assert.equal(await badge(item).textContent(), item.label, `${item.id}: current asset removal must not rewrite history`);
  await page.reload({ waitUntil: 'networkidle', timeout: 50000 });
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click(); await page.locator('.jobs-view').waitFor();
  for (const item of cases) assert.equal(await badge(item).textContent(), item.label, `${item.id}: saved generation mode survives reload`);
  const reloadedTaskFacts = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks.map(({ id, imageInputMode, imageGenerationMode, referenceAssetIds, primaryReferenceAssetIds, referenceAssetSnapshots }) => ({ id, imageInputMode, imageGenerationMode, referenceAssetIds, primaryReferenceAssetIds, referenceAssetSnapshots })), storageKey);
  assert.deepEqual(reloadedTaskFacts, originalTaskFacts);
  mark('saving/reloading and removing current reference asset from synthetic project leave immutable task history and displayed generation mode unchanged');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  mark('zero page/console errors, zero provider requests, zero generation actions; production data untouched');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, errors, blockedRequests, layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks, screenshots }));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
    await page.locator('body').innerText({ timeout: 3000 }).then((body) => fs.writeFileSync(path.join(output, 'failure.txt'), body)).catch(() => {});
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: String(error), checks, errors, blockedRequests, layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.error(JSON.stringify({ output, error: String(error), errors })); throw error;
}
finally { await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
