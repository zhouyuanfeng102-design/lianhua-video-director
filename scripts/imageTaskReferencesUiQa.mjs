import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';
import { createInitialState, STORAGE_KEY } from '../src/storage.ts';
import { createImageGenerationTask } from '../src/generationTasks.ts';

// Run after the normal package/build: node --import tsx scripts/imageTaskReferencesUiQa.mjs
// One focused production-App run, using an isolated browser and synthetic history.
// No desktop bridge, provider credentials, generation actions or user projects.
const root = path.resolve(import.meta.dirname, '..');
const runId = Date.now();
const output = path.join(root, 'output', 'playwright', `image-task-references-${runId}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}}); console.log('Image task references production preview ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'image task references', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let page; let records;
const checks = []; const errors = []; const blockedRequests = []; const screenshots = []; const layout = [];
const stages = []; const pendingRequests = new Map();
const stage = (label) => {
  const item = { elapsedMs: Date.now() - runId, label };
  stages.push(item); console.log(`[image-reference-qa ${item.elapsedMs}ms] ${label}`);
};
const within = async (label, promise, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms; last stage: ${stages.at(-1)?.label}; pending local requests: ${JSON.stringify([...pendingRequests.values()])}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};
const projectId = 'qa-image-task-references-project';
const longNames = Array.from({ length: 7 }, (_, index) => `长名称参考图${index + 1}：庭院茶桌旁的人物服装轮廓与石台灯笼竹林水榭及远山建筑细节`);
const cases = [
  { id: 'qa-snapshot', name: '快照名称优先', expected: ['提交时角色正面图', '提交时道具细节图'] },
  { id: 'qa-legacy', name: '多张旧参考图编号', expected: ['旧人物参考图', '旧场景参考图'] },
  { id: 'qa-primary', name: '仅保存主参考图', expected: ['主参考图'] },
  { id: 'qa-deleted', name: '已删除参考图保持编号', expected: ['旧人物参考图', '名称未记录'] },
  { id: 'qa-upload', name: '直接上传未记录名称', expected: [], fallback: '参考图名称未记录' },
  { id: 'qa-text', name: '普通文生图', expected: [], textOnly: true },
  { id: 'qa-long', name: '七张长名称自适应字号', expected: longNames },
];
const card = (id) => page.locator(`#image-task-${id}`);
const mark = (label) => { checks.push(label); console.log(label); };
const settle = async () => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
});
const capture = async (name, locator) => {
  const file = path.join(output, `${name}.png`);
  if (locator) await locator.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, animations: 'disabled', fullPage: false });
  screenshots.push(file);
};

async function updateFixture({ references, theme, scale }) {
  await page.locator('.jobs-view').evaluate((element, patch) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let component = key && element[key];
    while (component && !(typeof component.memoizedProps?.setBackgroundState === 'function' && component.memoizedProps?.state)) component = component.return;
    if (!component) throw new Error('Cannot locate real generation task context');
    component.memoizedProps.setBackgroundState((current) => {
      if (current.project.id !== patch.projectId) throw new Error('Only synthetic fixture may be changed');
      const project = { ...current.project, generationTasks: current.project.generationTasks.map((task) => {
        const record = patch.records.find((item) => item.id === task.id);
        if (!record) throw new Error(`Unexpected synthetic task: ${task.id}`);
        return { ...task, ...(patch.references ? record : {
          imageInputMode: 'text-to-image', imageGenerationMode: 'text-to-image',
          referenceAssetIds: [], primaryReferenceAssetIds: [], referenceAssetSnapshots: [],
        }) };
      }) };
      return { ...current, project, projects: [project], settings: { ...current.settings, theme: patch.theme, uiFontScalePercent: patch.scale } };
    });
  }, { projectId, references, theme, scale, records });
  await page.waitForFunction(({ theme, scale }) => document.documentElement.dataset.colorMode === theme
    && document.querySelector('[data-ui-font-scale]')?.getAttribute('data-ui-font-scale') === String(scale), { theme, scale });
  await settle();
}

async function dimensions(id) {
  return card(id).evaluate((element) => {
    const height = (selector) => element.querySelector(selector).getBoundingClientRect().height;
    return { card: element.getBoundingClientRect().height, header: height('.job-card-header'),
      summary: height('.image-task-summary-copy'), prompt: height('.image-task-prompt-panel') };
  });
}

async function checkView({ width, theme, scale = 100, name }) {
  stage(`layout ${name}: baseline and submitted history`);
  await page.setViewportSize({ width, height: 1100 });
  await updateFixture({ references: false, theme, scale });
  const before = Object.fromEntries(await Promise.all(cases.map(async ({ id }) => [id, await dimensions(id)])));
  for (const { id } of cases) assert.equal(await card(id).locator('.image-task-reference-list').count(), 0, `${id}: baseline has no reference list`);
  await updateFixture({ references: true, theme, scale });
  for (const item of cases) {
    const currentCard = card(item.id);
    await currentCard.scrollIntoViewIfNeeded();
    const list = currentCard.locator('.image-task-reference-list[aria-label="本次任务参考图"]');
    if (item.textOnly) assert.equal(await list.count(), 0, 'text-to-image must not display references');
    else {
      await list.waitFor({ state: 'visible' });
      const text = await list.innerText();
      if (item.fallback) assert.ok(text.includes(item.fallback), `${item.id}: explicit missing-name fallback`);
      if (item.expected.length) assert.ok(text.includes(`（${item.expected.length} 张）`), `${item.id}: reference count matches the actual ordered input list`);
      for (const [index, referenceName] of item.expected.entries()) {
        const position = text.indexOf(referenceName);
        assert.ok(position >= 0, `${item.id}: visible name ${referenceName}`);
        const preceding = text.slice(index ? text.indexOf(item.expected[index - 1]) + item.expected[index - 1].length : 0, position);
        assert.match(preceding, new RegExp(`(?:^|[^0-9])${index + 1}(?:[^0-9]|$)`, 'u'), `${item.id}: reference ${index + 1} retains its number`);
      }
      if (item.id === 'qa-snapshot') assert.equal(text.includes('资产当前新名称'), false, 'frozen submitted names take precedence over renamed current assets');
      if (item.id === 'qa-legacy') assert.equal(text.includes('旧选择未实际输入图'), false, 'stale primary choices must not be appended to the actual saved inputs');
    }
    const after = await dimensions(item.id);
    for (const field of ['card', 'header', 'summary', 'prompt']) assert.ok(Math.abs(after[field] - before[item.id][field]) <= 1,
      `${name}/${item.id}: adding reference history must not change ${field} height (${before[item.id][field]} -> ${after[field]})`);
    assert.ok(Math.abs(after.summary - 128) <= 1, `${item.id}: fixed summary height`);
    assert.ok(Math.abs(after.prompt - 128) <= 1, `${item.id}: existing prompt height`);
    const geometry = await currentCard.evaluate((element) => {
      const metadata = element.querySelector('.image-task-metadata');
      const content = element.querySelector('.image-task-metadata-content');
      const summary = element.querySelector('.image-task-summary-copy');
      const styles = getComputedStyle(content); const metadataStyle = getComputedStyle(metadata);
      const bounds = content.getBoundingClientRect(); const region = metadata.getBoundingClientRect(); const summaryBox = summary.getBoundingClientRect();
      return { fontSize: parseFloat(styles.fontSize), foreground: styles.color, contentVisible: styles.visibility === 'visible' && styles.display !== 'none',
        metadataHeight: metadata.clientHeight, metadataScrollHeight: metadata.scrollHeight,
        metadataOverflowY: metadataStyle.overflowY, contentWidth: bounds.width,
        insideSummary: region.top >= summaryBox.top - 1 && region.bottom <= summaryBox.bottom + 1,
        horizontalOverflow: metadata.scrollWidth > metadata.clientWidth + 1 || content.scrollWidth > content.clientWidth + 1,
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    assert.ok(geometry.fontSize >= 7 * scale / 100 - 0.11 && geometry.fontSize <= 9 * scale / 100 + 0.11, `${name}/${item.id}: readable bounded adaptive font`);
    assert.ok(geometry.contentVisible && geometry.contentWidth > 0 && geometry.metadataHeight > 0 && geometry.insideSummary, `${item.id}: metadata remains visible inside fixed summary`);
    assert.ok(!geometry.horizontalOverflow && !geometry.documentOverflow, `${name}/${item.id}: no horizontal overflow`);
    assert.notEqual(geometry.foreground, 'rgba(0, 0, 0, 0)', `${item.id}: readable foreground`);
    if (geometry.metadataScrollHeight > geometry.metadataHeight + 1) {
      assert.match(geometry.metadataOverflowY, /^(auto|scroll)$/u, `${item.id}: excess references remain reachable by local scrolling`);
      const scroll = await currentCard.locator('.image-task-metadata').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        const bottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        const moved = element.scrollTop > 0; element.scrollTop = 0; return { moved, bottom };
      });
      assert.ok(scroll.moved && scroll.bottom, `${item.id}: metadata can scroll to the last reference without growing the card`);
    }
    if (item.id === 'qa-long') assert.ok(geometry.fontSize < 9 * scale / 100 - 0.05, `${name}: seven long names trigger automatic shrinking`);
    layout.push({ view: name, id: item.id, before: before[item.id], after, ...geometry });
  }
  await card('qa-snapshot').scrollIntoViewIfNeeded(); await capture(name);
  await capture(`${name}-long`, card('qa-long'));
  stage(`layout ${name}: complete`);
}

async function run() {
  stage('wait for isolated production preview');
  assert.match(fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8'), /image-task-reference-list/u, 'Product must be ready before this focused run');
  assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')), 'Run the normal package/build before this production UI check');
  await waitForCondition({ label: 'image reference production preview', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  stage('production preview ready; prepare plain synthetic state in Node');
  const initialState = JSON.parse(JSON.stringify(createInitialState()));
  const taskSkeletons = cases.map((item, index) => createImageGenerationTask({ id: item.id, name: item.name,
    assetKind: 'character', imageVariant: 'reference', prompt: 'A neutral ceramic cube on a clean studio table in soft daylight.',
    backend: 'openai', model: 'isolated-no-api', width: 1024, height: 1024 }, 1791561900000 + index, 'succeeded'));
  stage('plain synthetic state ready; launch isolated Chromium');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.text().startsWith('[image-reference-fixture] ')) stage(message.text());
  });
  page.on('request', (request) => {
    if (request.url().startsWith(`${base}/`)) pendingRequests.set(request, { url: request.url(), method: request.method(), elapsedMs: Date.now() - runId });
  });
  page.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('requestfailed', (request) => {
    const item = pendingRequests.get(request);
    if (item) stage(`local request failed: ${item.method} ${item.url}: ${request.failure()?.errorText || 'unknown'}`);
    pendingRequests.delete(request);
  });
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
    if (url.pathname === '/__image_references_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Isolated image reference fixture</title><body>Only synthetic task history</body></html>' }); return;
    }
    await route.continue();
  });
  stage('open neutral fixture document');
  await page.goto(`${base}/__image_references_fixture.html`);
  stage('seed fixture from Node-prepared state; no browser source-module imports');
  records = await within('synthetic fixture evaluation', page.evaluate(({ cases, projectId, initialState, taskSkeletons, storageKey }) => {
    const log = (label) => console.info(`[image-reference-fixture] ${label}`);
    const state = initialState; const now = 1791561900000;
    log('create neutral preview pixels and synthetic history');
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#a9c5cc'; paint.fillRect(0, 0, 80, 80);
    paint.fillStyle = '#e8e3d2'; paint.fillRect(20, 25, 40, 35); const dataUrl = canvas.toDataURL();
    const asset = (id, name) => ({ id, name, type: 'reference', role: 'character', mediaType: 'image', source: 'upload', dataUrl, tags: [], createdAt: now, updatedAt: now });
    const assets = [asset('qa-renamed', '资产当前新名称'), asset('qa-legacy-one', '旧人物参考图'), asset('qa-legacy-two', '旧场景参考图'), asset('qa-primary-asset', '主参考图'), asset('qa-stale-primary', '旧选择未实际输入图'),
      ...cases.find((item) => item.id === 'qa-long').expected.map((name, index) => asset(`qa-long-${index + 1}`, name))];
    const snapshot = (id, name) => ({ id, name, type: 'reference', role: 'character', mediaType: 'image', managed: true, relativePath: `assets/image/${id}.png`, checksum: 'a'.repeat(64) });
    const empty = { referenceAssetIds: [], primaryReferenceAssetIds: [], referenceAssetSnapshots: [], imageInputMode: 'image-to-image', imageGenerationMode: 'image-to-image' };
    const records = cases.map(({ id }) => ({ id, ...empty }));
    Object.assign(records[0], { referenceAssetIds: ['qa-renamed', 'qa-frozen-only'], primaryReferenceAssetIds: ['qa-renamed'],
      referenceAssetSnapshots: [snapshot('qa-renamed', '提交时角色正面图'), snapshot('qa-frozen-only', '提交时道具细节图')] });
    Object.assign(records[1], { referenceAssetIds: ['qa-legacy-one', 'qa-legacy-two'], primaryReferenceAssetIds: ['qa-stale-primary'] });
    Object.assign(records[2], { primaryReferenceAssetIds: ['qa-primary-asset'] });
    Object.assign(records[3], { referenceAssetIds: ['qa-legacy-one', 'qa-deleted-asset'] });
    Object.assign(records[5], { imageInputMode: 'text-to-image', imageGenerationMode: 'text-to-image' });
    Object.assign(records[6], { referenceAssetIds: assets.filter((item) => item.id.startsWith('qa-long-')).map((item) => item.id) });
    const tasks = taskSkeletons.map((task) => ({ ...task,
      resultUrl: dataUrl, ...empty, imageInputMode: 'text-to-image', imageGenerationMode: 'text-to-image' }));
    const project = { ...state.project, id: projectId, name: '参考图名称隔离检查', description: '纯合成中性数据',
      sourceDocuments: [], scenes: [], characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets, generationTasks: tasks, createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name] = { ...state.settings[name], enabled: false, apiKey: '' };
    for (const kind of ['Text', 'Vision', 'Image', 'Video']) { state.settings[`${kind.toLowerCase()}ApiProfiles`] = []; state.settings[`active${kind}ApiProfileId`] = null; }
    state.settings.apiCredentialBook = []; state.settings.uiFontScalePercent = 100; state.settings.theme = 'light'; state.settings.themeColor = 'classic';
    log('synthetic tasks ready; serialize isolated localStorage');
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(storageKey, JSON.stringify(state));
    log('isolated localStorage seeded'); return records;
  }, { cases, projectId, initialState, taskSkeletons, storageKey: STORAGE_KEY }), 15_000);
  stage('fixture seeded; open real App');
  await page.goto(base, { waitUntil: 'networkidle', timeout: 50000 });
  stage('real App loaded; open generation tasks');
  assert.equal(await page.evaluate(() => typeof window.lianhuaDesktop), 'undefined');
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click(); await page.locator('.jobs-view').waitFor();
  await checkView({ width: 1480, theme: 'light', name: 'light-1480-100' });
  await checkView({ width: 1040, theme: 'dark', name: 'dark-1040-100' });
  mark('snapshot names, ordered legacy IDs, primary-only IDs, deleted references and uploaded inputs display the expected reference history; text-to-image has no list');
  mark('light 1480px and dark 1040px keep card/header/prompt heights unchanged; seven long names shrink inside the fixed 128px summary without horizontal overflow');
  await checkView({ width: 1040, theme: 'dark', scale: 125, name: 'dark-1040-125' });
  await updateFixture({ references: true, theme: 'dark', scale: 100 });
  const restoredSize = await card('qa-long').locator('.image-task-metadata-content').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const originalSize = layout.find((item) => item.view === 'dark-1040-100' && item.id === 'qa-long').fontSize;
  assert.ok(Math.abs(restoredSize - originalSize) <= 0.11, 'font adapts again after restoring global UI scale');
  mark('125% global font scaling preserves the 7–9px scaled font bounds and fixed layout, then restores the original adaptive size at 100%');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  mark('zero page/console errors, provider requests and generation actions; user project data untouched');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, errors, blockedRequests, stages, pendingRequests: [...pendingRequests.values()], layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks, screenshots }));
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
    await page.locator('body').innerText({ timeout: 3000 }).then((body) => fs.writeFileSync(path.join(output, 'failure.txt'), body)).catch(() => {});
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: String(error), checks, errors, blockedRequests, stages, pendingRequests: [...pendingRequests.values()], layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.error(JSON.stringify({ output, error: String(error), lastStage: stages.at(-1), pendingRequests: [...pendingRequests.values()], errors })); throw error;
}
finally { await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
