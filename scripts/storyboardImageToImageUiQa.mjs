import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// A real App mounted with a synthetic localStorage project and isolated media
// bridge only. No loadState/saveState bridge or real desktop/project is opened.
// All non-local requests and all unexpected POSTs are blocked before delivery.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `storyboard-image-to-image-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA evidence must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA evidence must not traverse symlinks'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
const storageKey = 'lianhua_video_director_state_v22';
const fixturePath = '/__storyboard_i2i_fixture.html';
const imagePath = '/__storyboard_i2i_mock__/image/v1/images/edits';
const textPath = '/__storyboard_i2i_mock__/text/v1/chat/completions';
const errors = []; const blockedRequests = []; const requests = []; const textRequests = []; const stages = []; const screenshots = []; const layouts = [];
let browser; let context; let page; let pixels; let originalBoards;
let allowFramePlanning = false;
const names = ['青石桥人物外貌参考 · 第 23 段 · 第 19 镜', '晨雾桥面场景参考 · 第 3 段'];
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const videoFacts = (board) => { const { imageToImage, storyboardImageCount, ...rest } = board; return rest; };
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const panel = () => page.getByRole('region', { name: '本段分镜参考图', exact: true });
const refCheck = (index) => panel().getByRole('checkbox', { name: `选择参考图：${names[index]}`, exact: true });
const sizeMode = () => page.getByRole('combobox', { name: '分镜图分辨率', exact: true });
const waitReferences = (boardId, expected) => page.waitForFunction(({ key, boardId, expected }) => {
  const actual = JSON.parse(localStorage.getItem(key)).project.storyboards.find((board) => board.id === boardId).imageToImage.referenceAssetIds;
  return JSON.stringify(actual) === JSON.stringify(expected);
}, { key: storageKey, boardId, expected });
const assertH3Unchanged = async () => {
  const state = await readState();
  for (const board of state.project.storyboards) assert.deepEqual(videoFacts(board), originalBoards[board.id], 'image work must preserve every H3, shot, frame and video-reference field byte-for-byte');
};
const enterDirector = async () => {
  await nav('提示词导演台');
  assert.equal(await page.locator('.storyboard-i2i-entry').count(), 0, 'the duplicate upper reference card is removed');
  assert.equal(await page.getByRole('button', { name: '选择参考图', exact: true }).count(), 0, 'the duplicate upper reference button is removed');
  const referenceTab = page.locator('.reference-result-tabs').getByRole('button', { name: /^参考图(?:（\d+）)?$/u });
  assert.equal(await referenceTab.count(), 1, 'exactly one director reference-selection tab remains');
  await referenceTab.click();
  await panel().waitFor();
};
const enterWorkbench = async () => {
  await nav('图像工作台');
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '分镜图', exact: true }).click();
  await page.locator('.storyboard-image-mode-tabs').getByRole('button', { name: /^参考图(?:（\d+）)?$/u }).click();
  await panel().waitFor();
};
const directorResult = async () => {
  await page.locator('.director-panel-tabs').getByRole('button', { name: '提示词结果', exact: true }).click();
  await page.locator('.director-result-actions').waitFor();
};
const workbenchResult = async () => {
  await page.locator('.storyboard-image-mode-tabs').getByRole('button', { name: '分镜生图', exact: true }).click();
  await page.getByRole('group', { name: '选择分镜镜头', exact: true }).waitFor();
};
const setTextEnabled = async (enabled) => {
  await nav('API 设置');
  await page.getByRole('tab', { name: '文本 API', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用文本模型接口', exact: true }).setChecked(enabled);
  await page.waitForFunction(({ key, enabled }) => JSON.parse(localStorage.getItem(key)).settings.textApi.enabled === enabled, { key: storageKey, enabled });
};
const capture = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file);
};
async function inspectReferenceLayout(view, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForFunction(() => document.querySelector('.storyboard-i2i-panel')?.clientHeight > 0);
  const layout = await page.evaluate(() => {
    const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const panel = document.querySelector('.storyboard-i2i-panel'); const header = panel.querySelector('.storyboard-i2i-header'); const hint = panel.querySelector('.storyboard-i2i-hint');
    const modeRow = document.querySelector('.director-mode-row');
    const controls = [...panel.querySelectorAll('.storyboard-i2i-header button, .storyboard-i2i-search input')].map((element) => {
      const r = box(element); const hit = document.elementFromPoint((r.x + r.right) / 2, (r.y + r.bottom) / 2);
      return { name: element.textContent || element.getAttribute('placeholder'), ...r, visible: !!hit && (hit === element || element.contains(hit)) };
    });
    return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
      modeRow: modeRow ? { ...box(modeRow), cards: [...modeRow.children].map(box) } : null,
      panel: { ...box(panel), scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }, header: box(header), hint: box(hint),
      lists: [...panel.querySelectorAll('.storyboard-i2i-asset-list')].map((element) => ({ ...box(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })),
      images: [...panel.querySelectorAll('.storyboard-i2i-thumb img')].map((element) => ({ fit: getComputedStyle(element).objectFit })),
      names: [...panel.querySelectorAll('.reference-image-name-text')].map((element) => ({ text: element.textContent, overflow: getComputedStyle(element).textOverflow, whiteSpace: getComputedStyle(element).whiteSpace })), controls };
  });
  layouts.push({ view, ...layout }); await capture(`${view}-${viewport.width}x${viewport.height}`);
  assert.ok(layout.documentWidth <= viewport.width + 1, `${view}: no document horizontal overflow`);
  assert.ok(layout.panel.bottom <= viewport.height + 1 && layout.panel.y >= 0, `${view}: panel stays inside the viewport`);
  assert.ok(layout.panel.scrollHeight <= layout.panel.clientHeight + 2, `${view}: only inner lists scroll, not the whole panel`);
  if (view === 'director-references') {
    assert.equal(layout.modeRow, null, 'the redundant director-mode banner is removed without an empty row');
  }
  for (const list of layout.lists) assert.ok(list.clientHeight >= 80 && list.y >= layout.header.bottom && list.bottom <= layout.hint.y + 1, `${view}: references retain visible height without overlapping header or hint`);
  for (const image of layout.images) assert.equal(image.fit, 'contain');
  for (const name of layout.names) assert.ok(name.overflow !== 'ellipsis' && name.whiteSpace !== 'nowrap', `${view}: full image names stay wrapped`);
  for (const control of layout.controls) assert.ok(control.visible && control.x >= 0 && control.right <= viewport.width + 1 && control.bottom <= viewport.height + 1, `${view}: ${control.name} is visible and unobscured`);
}
async function inspectResultLayout(viewport) {
  await page.setViewportSize(viewport);
  const layout = await page.evaluate(() => {
    const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const actions = document.querySelector('.director-result-actions');
    const row = [...actions.children].filter((element) => element.matches('button, .storyboard-image-count-control')).map((element) => ({ name: element.textContent.trim(), ...box(element) }));
    const controls = [...actions.querySelectorAll(':scope > button, input')].map((element) => { const r = box(element); const hit = document.elementFromPoint((r.x + r.right) / 2, (r.y + r.bottom) / 2); return { name: element.textContent || element.getAttribute('aria-label'), ...r, visible: !!hit && (hit === element || element.contains(hit)) }; });
    const pane = document.querySelector('.director-result-pane'); const prompt = document.querySelector('.director-result-copy');
    return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, actions: box(actions), prompt: box(prompt), pane: { ...box(pane), scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight }, row, controls };
  });
  layouts.push({ view: 'director-result', ...layout }); await capture(`director-result-${viewport.width}x${viewport.height}`);
  assert.equal(layout.row.length, 4, 'original result row contains first/last, quantity, storyboard generation and edit controls');
  assert.ok(Math.max(...layout.row.map((item) => item.y)) - Math.min(...layout.row.map((item) => item.y)) <= 2, 'old result buttons and quantity input remain on one row');
  for (let index = 1; index < layout.row.length; index++) assert.ok(layout.row[index - 1].right <= layout.row[index].x + 1, 'result controls do not overlap');
  assert.ok(layout.prompt.bottom <= layout.actions.y + 1, 'scrollable prompt never covers fixed controls');
  assert.ok(layout.documentWidth <= viewport.width + 1 && layout.pane.bottom <= viewport.height + 1, 'result panel stays inside the viewport');
  for (const control of layout.controls) assert.ok(control.visible && control.bottom <= viewport.height + 1 && control.right <= viewport.width + 1, `${control.name} is visible and unobscured`);
}
async function generate(button, expectedIds, expectedSize, stage, { count = 1, boardId = 'i2i-board', planningCalls = 0 } = {}) {
  const before = await readState(); const oldIds = before.project.generationTasks.map((task) => task.id); const firstRequest = requests.length; const firstTextRequest = textRequests.length;
  await button.click();
  await page.waitForFunction(({ key, oldIds, count }) => {
    const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks.filter((task) => task.kind === 'image' && !oldIds.includes(task.id));
    return tasks.length === count && tasks.every((task) => ['succeeded', 'failed', 'cancelled'].includes(task.status));
  }, { key: storageKey, oldIds, count }, { timeout: 30_000 });
  const state = await readState(); const tasks = state.project.generationTasks.filter((entry) => entry.kind === 'image' && !oldIds.includes(entry.id));
  for (const task of tasks) {
    assert.equal(task.status, 'succeeded', `${stage}: ${task.error || 'no failure'}`);
    assert.equal(task.imageGenerationMode, 'image-to-image'); assert.equal(task.sourceStoryboardId, boardId);
    assert.deepEqual(task.referenceAssetIds, expectedIds); assert.deepEqual([task.width, task.height], expectedSize);
    const asset = state.project.assets.find((entry) => entry.id === task.resultAssetId);
    assert.equal(asset.sourceStoryboardId, task.sourceStoryboardId); assert.equal(asset.sourceShotId, task.sourceShotId);
    assert.deepEqual([asset.imageRequestSize.width, asset.imageRequestSize.height], expectedSize, `${stage}: output records requested pixels`);
    assert.equal(asset.imageGenerationMode, 'image-to-image', `${stage}: result asset retains direct-mode provenance after the task is deleted`);
    assert.ok(asset.imageRegenerationSnapshot, `${stage}: result asset carries a safe self-contained regeneration snapshot`);
    assert.deepEqual(asset.imageRegenerationSnapshot.referenceAssetSnapshots.map((reference) => reference.id), expectedIds);
    assert.doesNotMatch(JSON.stringify(asset.imageRegenerationSnapshot), /data:image|https?:|apiKey|baseUrl/u, 'asset snapshots contain no image bytes, endpoints or credentials');
  }
  const actual = requests.slice(firstRequest);
  assert.equal(actual.length, count, `${stage}: requested image count is exact`);
  for (const request of actual) { assert.equal(request.path, imagePath); assert.equal(request.model, 'mock-image'); assert.equal(request.size, expectedSize.join('x')); assert.deepEqual(request.images, expectedIds.map((id) => pixels[id].split(',')[1]), `${stage}: every actual multipart contains exact original pixels in order`); }
  assert.equal(textRequests.length - firstTextRequest, planningCalls, `${stage}: only the custom count may call the text-only still planner`);
  await assertH3Unchanged(); stages.push(stage); return tasks;
}

try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => {
    // Test media survives reload in this fresh browser context only. The real
    // app data folder, desktop files and user browser storage remain untouched.
    const mediaKey = '__storyboard_i2i_isolated_managed_media';
    let saved = new Map();
    try { saved = new Map(JSON.parse(sessionStorage.getItem(mediaKey) || '[]')); } catch { /* blank fixture origin */ }
    // This bridge is deliberately restricted to test-session media. State
    // persistence still uses this fresh browser context's own localStorage.
    window.lianhuaDesktop = {
      storeGeneratedImage: async ({ dataUrl, fileName }) => {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const relativePath = `images/${hash}.png`; saved.set(relativePath, { dataUrl, hash });
        sessionStorage.setItem(mediaKey, JSON.stringify([...saved]));
        return { fileName: fileName || `${hash}.png`, relativePath, checksum: hash, sizeBytes: dataUrl.length, mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, url: dataUrl };
      },
      readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
        const item = saved.get(relativePath);
        if (!item || item.hash !== expectedChecksum) throw new Error('Isolated image snapshot is missing or changed');
        return item.dataUrl;
      },
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => errors.push(error.message));
  await context.routeWebSocket('**/*', (socket) => { const url = new URL(socket.url()); if (url.host === new URL(origin).host && url.pathname === '/') return; blockedRequests.push(socket.url()); socket.close(); });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && ![imagePath, textPath].includes(url.pathname))) {
      blockedRequests.push(request.url()); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated direct storyboard fixture</body></html>' }); return; }
    if (url.pathname === textPath) {
      try {
        assert.ok(allowFramePlanning, 'default, boundary, workbench and retry paths must not call a text API');
        const body = request.postDataJSON(); assert.equal(body.model, 'mock-static-frame-planner');
        assert.ok(body.messages.every((message) => typeof message.content === 'string'), 'the still planner receives no multimodal/image content');
        const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
        assert.match(system, /分镜静帧规划导演/u); assert.doesNotMatch(JSON.stringify(body), /data:image|image_url|image_base64/u);
        const input = JSON.parse(body.messages.find((message) => message.role === 'user').content);
        assert.equal(input.requestedImageCount, 5); assert.equal(input.source.storyboardId, 'i2i-board'); assert.equal(input.source.shots.length, 2);
        assert.ok(input.source.confirmedH3, 'custom count plans from confirmed H3 as well as source story');
        const frames = Array.from({ length: 5 }, (_, index) => {
          const timeSec = (index + 0.5) * input.source.durationSec / 5;
          const shot = input.source.shots.find((item) => item.startSec <= timeSec && item.endSec > timeSec);
          return { sourceShotId: shot.id, description: `AI规划静帧${index + 1}：第${timeSec}秒，原机位下青石桥和薄雾的独立静态画面。`, timeSec };
        });
        textRequests.push({ path: url.pathname, model: body.model, requestedImageCount: input.requestedImageCount, sourceStoryboardId: input.source.storyboardId, sourceShotCount: input.source.shots.length, imageParts: 0, frames });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(frames) }, finish_reason: 'stop' }] }) });
      } catch (cause) { errors.push(String(cause)); await route.fulfill({ status: 500, body: JSON.stringify({ error: { message: 'Only the isolated text-only static-frame plan is allowed' } }) }); }
      return;
    }
    if (url.pathname === imagePath) {
      try {
        const boundary = request.headers()['content-type']?.match(/boundary=([^;]+)/u)?.[1]; assert.ok(boundary, 'image edits must carry multipart image files');
        const entry = { path: url.pathname, images: [], size: '', prompt: '', model: '' };
        for (const part of request.postDataBuffer().toString('latin1').split(`--${boundary}`)) {
          const split = part.indexOf('\r\n\r\n'); if (split < 0) continue;
          const headers = part.slice(0, split); let body = part.slice(split + 4); if (body.endsWith('\r\n')) body = body.slice(0, -2);
          const name = headers.match(/name="([^"]+)"/u)?.[1];
          if (/filename="/u.test(headers)) { assert.equal(name, 'image[]'); entry.images.push(Buffer.from(body, 'latin1').toString('base64')); }
          else if (['size', 'prompt', 'model'].includes(name)) entry[name] = Buffer.from(body, 'latin1').toString('utf8');
        }
        assert.ok(entry.images.length > 0); requests.push(entry);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: pixels.a.split(',')[1] }] }) });
      } catch (cause) { errors.push(String(cause)); await route.fulfill({ status: 500, body: JSON.stringify({ error: { message: 'Isolated image mock rejected request' } }) }); }
      return;
    }
    await route.continue();
  });
  await page.goto(`${origin}${fixturePath}`);
  pixels = await page.evaluate(async ({ key, origin, names }) => {
    const { createInitialState } = await import('/src/storage.ts'); const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts'); const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now(); const story = '青石桥上清晨薄雾缓慢流动，阳光照在青石栏杆，河水轻轻流淌。';
    const scene = { id: 'i2i-scene', title: '晨雾石桥', content: story, summary: '石桥环境画面', characterIds: [], locationIds: [], propIds: [], storyboardIds: ['i2i-board'], createdAt: now, updatedAt: now };
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const paint = canvas.getContext('2d');
    paint.fillStyle = '#729aaf'; paint.fillRect(0, 0, 64, 64); const a = canvas.toDataURL('image/png');
    paint.fillStyle = '#b68591'; paint.fillRect(0, 0, 64, 64); const b = canvas.toDataURL('image/png');
    const assets = [a, b].map((dataUrl, index) => ({ id: index ? 'b' : 'a', name: names[index], type: 'reference', role: index ? 'scene' : 'character', referenceScope: 'general', mediaType: 'image', dataUrl, width: 64, height: 64, tags: [], createdAt: now, updatedAt: now }));
    const shots = [1, 2].map((index) => ({ id: `i2i-shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5, purpose: '展示环境', subject: '青石桥', action: index === 1 ? '薄雾缓慢流动，晨光照在石栏杆上' : '河水轻轻流淌，固定镜头呈现远处桥头', camera: '固定中景', lighting: '自然柔光', sound: '水声', result: '石栏杆保持可见', transition: '顺接', referenceAssetIds: ['b'], prompt: `【${(index - 1) * 5}s-${index * 5}s】青石桥与薄雾，固定中景，柔和晨光。`, locked: false, authoredBy: 'text-api' }));
    const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
    const board = applyOfficialH3Prompt({ id: 'i2i-board', sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story,
      workflow: 'drama', inputMode: 'reference', durationSec: 10, durationPreset: 'custom', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', segmentIndex: 2,
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '石桥环境与晨光固定', globalReferenceAssetIds: ['b'], shots, finalPrompt,
      imageToImage: { referenceAssetIds: [], selectedShotIds: ['i2i-shot-2'], referenceAssetIdsByShotId: { 'i2i-shot-1': ['b'] } },
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: ['i2i-source'], referenceAssetIds: ['b'], generatedAt: now }, createdAt: now, updatedAt: now },
      { assets, characters: [], locations: [], props: [], sceneContent: story });
    const otherBoard = applyOfficialH3Prompt({ ...board, id: 'i2i-board-other', sourceStoryTitle: '桥尾远景', segmentIndex: 3,
      shots: shots.map((shot) => ({ ...shot, id: `${shot.id}-other` })), imageToImage: { referenceAssetIds: [], selectedShotIds: [], referenceAssetIdsByShotId: {} } },
      { assets, characters: [], locations: [], props: [], sceneContent: story });
    scene.storyboardIds.push(otherBoard.id);
    const project = { ...state.project, id: 'storyboard-i2i-ui-project', name: '分镜图生图隔离测试', characters: [], locations: [], props: [], assets, sourceDocuments: [{ id: 'i2i-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [board, otherBoard], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: false, provider: 'openai_compatible', baseUrl: `${origin}/__storyboard_i2i_mock__/text`, apiKey: '', model: 'mock-static-frame-planner' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__storyboard_i2i_mock__/image`, apiKey: '', model: 'mock-image' };
    state.settings.imageApiProfiles = [{ ...state.settings.imageApi, id: 'i2i-original-image-api', name: '隔离原图生图 API', createdAt: now, updatedAt: now }];
    state.settings.activeImageApiProfileId = 'i2i-original-image-api'; state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.uiFontScalePercent = 100; state.settings.storyboardImageOutputSize = { mode: 'default', width: 1024, height: 1024 };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); return { a, b };
  }, { key: storageKey, origin, names });
  await page.goto(origin, { waitUntil: 'networkidle' }); originalBoards = Object.fromEntries((await readState()).project.storyboards.map((board) => [board.id, videoFacts(board)]));
  await enterDirector();
  assert.equal(await page.getByRole('button', { name: '纯文字', exact: true }).count(), 0);
  assert.equal(await panel().locator('button').count(), 2, 'the reference-only column has just upload and clear buttons');
  assert.doesNotMatch(await panel().innerText(), /选择目标分镜|应用参考图|清除绑定|用参考图生成所选分镜/u);
  await refCheck(0).check(); await refCheck(1).check(); await waitReferences('i2i-board', ['a', 'b']);
  assert.equal(await page.locator('.director-panel-tabs').getByRole('button', { name: '参考图（2）', exact: true }).count(), 1);
  stages.push('reference-only-panel-reuses-existing-generation-controls');
  for (const viewport of [{ width: 1366, height: 900 }, { width: 1280, height: 800 }]) await inspectReferenceLayout('director-references', viewport);

  await enterWorkbench(); assert.equal(await refCheck(0).isChecked(), true); assert.equal(await refCheck(1).isChecked(), true);
  assert.equal(await page.locator('.storyboard-image-mode-tabs').getByRole('button', { name: '参考图（2）', exact: true }).count(), 1);
  await sizeMode().selectOption('2k'); await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).settings.storyboardImageOutputSize.mode === '2k', storageKey);
  for (const viewport of [{ width: 1366, height: 900 }, { width: 1280, height: 800 }]) await inspectReferenceLayout('workbench-references', viewport);

  await enterDirector(); await directorResult();
  assert.match(await page.getByLabel('当前分镜图分辨率', { exact: true }).innerText(), /2048×1152/u);
  for (const viewport of [{ width: 1366, height: 900 }, { width: 1280, height: 800 }]) await inspectResultLayout(viewport);
  assert.equal((await readState()).settings.textApi.enabled, false);
  const defaults = await generate(page.getByRole('button', { name: '生成分镜图片（2张）', exact: true }), ['a', 'b'], [2048, 1152], 'default-original-button-two-shots-two-originals-no-text', { count: 2 });
  assert.deepEqual(new Set(defaults.map((task) => task.sourceShotId)), new Set(['i2i-shot-1', 'i2i-shot-2']));
  assert.equal(textRequests.length, 0);

  await setTextEnabled(true); await enterDirector(); await directorResult();
  await page.getByRole('spinbutton', { name: '自定义分镜图片数量', exact: true }).fill('5');
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.storyboards[0].storyboardImageCount === 5, storageKey);
  allowFramePlanning = true;
  const custom = await generate(page.getByRole('button', { name: '生成分镜图片（5张）', exact: true }), ['a', 'b'], [2048, 1152], 'custom-five-images-one-text-only-still-plan-shared-originals', { count: 5, planningCalls: 1 });
  allowFramePlanning = false;
  assert.deepEqual(custom.map((task) => task.imageFrameIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  for (const task of custom) { assert.equal(task.imageFrameCount, 5); assert.match(task.imageFrameDescription, /AI规划静帧/u); }
  const originalSecond = custom.find((task) => task.imageFrameIndex === 2);
  assert.ok(originalSecond);

  await setTextEnabled(false); await enterDirector(); await directorResult();
  assert.equal(await page.getByRole('spinbutton', { name: '自定义分镜图片数量', exact: true }).inputValue(), '5');
  const boundary = await generate(page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }), ['a', 'b'], [2048, 1152], 'original-first-last-button-two-images-independent-of-custom-five', { count: 2 });
  assert.deepEqual(new Set(boundary.map((task) => task.imageVariant)), new Set(['first-frame', 'last-frame']));

  await enterWorkbench(); await workbenchResult();
  const shotPicker = page.getByRole('group', { name: '选择分镜镜头', exact: true });
  await shotPicker.getByRole('checkbox', { name: '选择第 2 镜', exact: true }).check();
  const workbench = await generate(shotPicker.getByRole('button', { name: '生成选中分镜图片（1 张）', exact: true }), ['a', 'b'], [2048, 1152], 'workbench-original-shot-picker-and-button-use-current-originals');
  assert.equal(workbench[0].sourceShotId, 'i2i-shot-2');

  await page.locator('.storyboard-image-mode-tabs').getByRole('button', { name: '参考图（2）', exact: true }).click();
  await refCheck(0).uncheck(); await waitReferences('i2i-board', ['b']);
  assert.equal(await refCheck(1).isChecked(), true, 'cancelling the first image preserves the other selected reference');
  await sizeMode().selectOption('1k'); await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).settings.storyboardImageOutputSize.mode === '1k', storageKey);
  await page.getByRole('combobox', { name: '选择分镜', exact: true }).selectOption('i2i-board-other');
  assert.equal(await refCheck(0).isChecked(), false); assert.equal(await refCheck(1).isChecked(), false);
  await refCheck(0).check(); await waitReferences('i2i-board-other', ['a']);
  await workbenchResult();
  await page.getByRole('group', { name: '选择分镜镜头', exact: true }).getByRole('checkbox', { name: '选择第 1 镜', exact: true }).check();
  await generate(page.getByRole('button', { name: '生成选中分镜图片（1 张）', exact: true }), ['a'], [1024, 576], 'different-segment-keeps-its-own-reference-selection', { boardId: 'i2i-board-other' });
  await page.getByRole('combobox', { name: '选择分镜', exact: true }).selectOption('i2i-board');
  await page.locator('.storyboard-image-mode-tabs').getByRole('button', { name: '参考图（1）', exact: true }).click();
  assert.equal(await refCheck(0).isChecked(), false); assert.equal(await refCheck(1).isChecked(), true);
  assert.deepEqual((await readState()).project.storyboards.map((board) => board.imageToImage.referenceAssetIds), [['b'], ['a']]);

  await nav('生成任务');
  const originalCard = page.locator(`[id="image-task-${originalSecond.id}"]`);
  await originalCard.waitFor();
  const [retry] = await generate(originalCard.locator('.image-regenerate-button'), ['a', 'b'], [2048, 1152], 'custom-task-retry-keeps-original-pixels-size-and-static-frame');
  assert.equal(retry.regenerationSourceTaskId, originalSecond.id); assert.equal(retry.imageFrameIndex, 2); assert.equal(retry.imageFrameCount, 5); assert.equal(retry.imageFrameDescription, originalSecond.imageFrameDescription);
  assert.equal(textRequests.length, 1); assert.equal((await readState()).settings.textApi.enabled, false);

  // This is an isolated restore fixture, not a mutation of real user data:
  // original tasks and reference-asset metadata disappear, but managed image
  // snapshots remain on the result asset and in the test's media store.
  const recoveredAssetId = originalSecond.resultAssetId;
  const invalidAssetId = 'i2i-direct-result-without-snapshot';
  await page.evaluate(({ key, recoveredAssetId, invalidAssetId, origin }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const source = state.project.assets.find((asset) => asset.id === recoveredAssetId);
    if (!source?.imageRegenerationSnapshot) throw new Error('No recoverable direct result was generated');
    const invalid = { ...source, id: invalidAssetId, name: '隔离验证 · 原图快照缺失的图生图结果', imageGenerationMode: 'image-to-image' };
    delete invalid.imageRegenerationSnapshot;
    const project = { ...state.project, generationTasks: [], assets: [invalid, source, ...state.project.assets.filter((asset) => !['a', 'b', recoveredAssetId].includes(asset.id))] };
    state.project = project; state.projects = state.projects.map((item) => item.id === project.id ? project : item);
    const alternate = { ...state.settings.imageApi, baseUrl: `${origin}/__storyboard_i2i_mock__/must-not-use-current-image-api`, model: 'must-not-use-current-model' };
    state.settings.imageApi = alternate;
    state.settings.imageApiProfiles.push({ ...alternate, id: 'i2i-current-other-api', name: '隔离另一生图 API', createdAt: Date.now(), updatedAt: Date.now() });
    state.settings.activeImageApiProfileId = 'i2i-current-other-api';
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, recoveredAssetId, invalidAssetId, origin });
  await page.reload({ waitUntil: 'networkidle' }); await nav('资产库');
  const restoredState = await readState();
  assert.equal(restoredState.project.generationTasks.length, 0);
  assert.equal(restoredState.project.assets.some((asset) => ['a', 'b'].includes(asset.id)), false);
  assert.equal(restoredState.settings.imageApi.model, 'must-not-use-current-model');
  await assertH3Unchanged();
  const invalidCard = page.locator(`[id="asset-card-${invalidAssetId}"]`); await invalidCard.waitFor();
  const invalidButton = invalidCard.locator('.asset-regenerate-button');
  assert.equal(await invalidButton.isDisabled(), true);
  assert.match(await invalidCard.getByRole('status').innerText(), /重新生成不可用[\s\S]*快照缺失\/损坏[\s\S]*不会改用当前选图、文字转换或文生图/u);
  const errorLayout = await invalidCard.getByRole('status').evaluate((element) => {
    const style = getComputedStyle(element);
    const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const card = element.closest('.asset-card');
    return { whiteSpace: style.whiteSpace, overflow: style.textOverflow, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      message: box(element), card: box(card), actions: box(card.querySelector('.asset-actions')),
      buttons: [...card.querySelectorAll('.asset-actions button')].map(box) };
  });
  assert.ok(errorLayout.whiteSpace !== 'nowrap' && errorLayout.overflow !== 'ellipsis'
    && errorLayout.scrollWidth <= errorLayout.clientWidth + 1 && errorLayout.scrollHeight <= errorLayout.clientHeight + 1,
  'the concrete missing-snapshot reason must be fully readable, not truncated by ordinary asset metadata styles');
  assert.ok(errorLayout.message.x >= errorLayout.card.x && errorLayout.message.right <= errorLayout.card.right + 1
    && errorLayout.message.y >= errorLayout.card.y && errorLayout.message.bottom <= errorLayout.card.bottom + 1,
  'the complete error reason stays inside its asset card');
  assert.ok(errorLayout.message.bottom <= errorLayout.actions.y + 1, 'the wrapped error reason never overlaps the action row');
  for (const button of errorLayout.buttons) assert.ok(errorLayout.message.bottom <= button.y + 1, 'all asset buttons remain below the error reason');
  layouts.push({ view: 'asset-regeneration-error', ...errorLayout });
  const requestsBeforeInvalid = requests.length; const textBeforeInvalid = textRequests.length;
  await invalidButton.evaluate((button) => button.click());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await readState()).project.generationTasks.length, 0, 'unrecoverable direct assets cannot create a downgraded task');
  assert.equal(requests.length, requestsBeforeInvalid); assert.equal(textRequests.length, textBeforeInvalid);
  assert.deepEqual(errors, [], 'an invalid direct asset must not crash the asset library');
  await invalidCard.scrollIntoViewIfNeeded(); await capture('asset-missing-snapshot-visible-error');
  stages.push('missing-direct-asset-snapshot-shows-reason-without-crash-or-request');

  const recoveredCard = page.locator(`[id="asset-card-${recoveredAssetId}"]`); await recoveredCard.waitFor();
  assert.equal(await recoveredCard.locator('.asset-regenerate-button').isEnabled(), true);
  const [assetRetry] = await generate(recoveredCard.locator('.asset-regenerate-button'), ['a', 'b'], [2048, 1152], 'asset-card-regeneration-after-task-and-reference-deletion-uses-frozen-originals');
  assert.equal(assetRetry.regenerationSourceTaskId, `asset-regeneration-${recoveredAssetId}`);
  assert.equal(assetRetry.imageApiSnapshot.profileId, 'i2i-original-image-api');
  assert.equal(assetRetry.imageFrameIndex, 2); assert.equal(assetRetry.imageFrameCount, 5); assert.equal(assetRetry.imageFrameDescription, originalSecond.imageFrameDescription);
  assert.equal(textRequests.length, 1); await capture('asset-snapshot-recovered-with-original-api');
  await assertH3Unchanged(); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, stages, layouts, screenshots, requests, textRequests, errors, blockedRequests, output }, null, 2));
  console.log(JSON.stringify({ passed: true, stages, imageRequests: requests.length, textRequests: textRequests.length, errors, blockedRequests, report: path.join(output, 'report.json') }, null, 2));
} catch (cause) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); await fs.writeFile(path.join(output, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stages, layouts, requests, textRequests, errors, blockedRequests, output }, null, 2));
  console.error(cause); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
