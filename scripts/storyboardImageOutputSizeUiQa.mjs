import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Exercise the real App in a brand-new browser context with synthetic state.
// Only the exact local mock endpoints below accept model requests. No desktop
// bridge, real project directory, saved credentials or paid provider is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `storyboard-image-output-size-${Date.now()}`);
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
const fixturePath = '/__storyboard_size_fixture.html';
const textPath = '/__storyboard_size_mock__/text/v1/chat/completions';
const imagePaths = ['/__storyboard_size_mock__/image/v1/images/generations', '/__storyboard_size_mock__/image/v1/images/edits'];
const errors = []; const blockedRequests = []; const requests = []; const stages = []; const screenshots = []; const layouts = [];
let browser; let context; let page; let png = ''; let originalBoard; let originalLanes;
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const sizeMode = () => page.getByRole('combobox', { name: '分镜图分辨率', exact: true });
const sizeGroup = () => page.getByRole('group', { name: '分镜图分辨率', exact: true });
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const videoFacts = (board) => ({ finalPrompt: board.finalPrompt, officialPromptZh: board.officialPromptZh,
  aspectRatio: board.aspectRatio, resolution: board.resolution, durationSec: board.durationSec,
  shots: board.shots.map(({ referenceAssetIds, ...shot }) => shot) });
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
const enterWorkbench = async () => {
  await nav('图像工作台'); await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '分镜图', exact: true }).click();
  await sizeMode().waitFor();
};
const enterDirector = async () => {
  await nav('提示词导演台');
  const resultTab = page.getByRole('button', { name: '结果', exact: true });
  if (await resultTab.isVisible()) await resultTab.click();
  await page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }).waitFor();
};
const assertNoSourceMutation = async () => {
  const current = await readState();
  assert.deepEqual(videoFacts(current.project.storyboards[0]), originalBoard, 'still resolution never rewrites H3, video dimensions, timing or shots');
  assert.deepEqual(current.settings.imageOutputSizes, originalLanes, 'ordinary and private image pixel settings remain independent');
};
async function generate(button, count, expectedSize, contextLabel) {
  const before = await readState(); const oldIds = before.project.generationTasks.map((task) => task.id); const requestIndex = requests.length;
  assert.equal(await button.isEnabled(), true, `${contextLabel}: exact selected resolution must not block generation`);
  await button.click();
  await page.waitForFunction(({ key, oldIds, count }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const tasks = state.project.generationTasks.filter((task) => !oldIds.includes(task.id));
    return tasks.length === count && tasks.every((task) => ['succeeded', 'failed', 'cancelled'].includes(task.status));
  }, { key: storageKey, oldIds, count }, { timeout: 45_000 });
  const current = await readState(); const tasks = current.project.generationTasks.filter((task) => !oldIds.includes(task.id));
  assert.equal(tasks.length, count, contextLabel);
  for (const task of tasks) {
    assert.equal(task.status, 'succeeded', `${contextLabel}: ${task.error || 'no failure'}`);
    assert.deepEqual([task.width, task.height, task.sizeOverride], [...expectedSize, true], `${contextLabel}: frozen task pixels`);
    const asset = current.project.assets.find((entry) => entry.id === task.resultAssetId);
    assert.deepEqual([asset.width, asset.height], [64, 64], `${contextLabel}: actual provider pixels are not relabeled`);
    assert.deepEqual(asset.imageRequestSize, { width: expectedSize[0], height: expectedSize[1], sizeOverride: true });
    assert.match(task.bindingWarning || '', /实际返回64×64/u);
  }
  const imageRequests = requests.slice(requestIndex).filter((entry) => entry.kind === 'image');
  assert.equal(imageRequests.length, count, `${contextLabel}: exactly one model request per selected frame`);
  for (const request of imageRequests) assert.equal(request.size, expectedSize.join('x'), `${contextLabel}: real JSON/multipart request has selected pixels`);
  await assertNoSourceMutation(); stages.push(contextLabel);
  return tasks;
}

try {
  await server.listen(); browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', (error) => errors.push(error.message));
  await context.routeWebSocket('**/*', (socket) => { const url = new URL(socket.url()); if (url.host === new URL(origin).host && url.pathname === '/') return; blockedRequests.push(socket.url()); socket.close(); });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && ![textPath, ...imagePaths].includes(url.pathname))) {
      blockedRequests.push(request.url()); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated storyboard canvas fixture</body></html>' }); return; }
    if (imagePaths.includes(url.pathname)) {
      const raw = request.postData() || ''; const isMultipart = /multipart\/form-data/u.test(request.headers()['content-type'] || '');
      const size = isMultipart ? raw.match(/name="size"\r?\n\r?\n([^\r\n]+)/u)?.[1] : JSON.parse(raw).size;
      requests.push({ kind: 'image', path: url.pathname, size, transport: isMultipart ? 'multipart' : 'json' });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) }); return;
    }
    if (url.pathname === textPath) {
      try {
        const body = request.postDataJSON(); const messages = body.messages;
        const text = (role) => messages.filter((entry) => entry.role === role).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')).join('\n');
        const system = text('system'); const user = text('user'); let response; let kind;
        if (system.includes('实际出镜人物解析器')) {
          const data = JSON.parse(user.slice(user.indexOf('{'))); kind = 'visible-characters';
          response = JSON.stringify({ shots: data.shots.map((shot) => ({ shotId: shot.id, visibleCharacterNames: [] })) });
        } else if (system.includes('分镜静帧规划导演')) {
          const data = JSON.parse(user); kind = 'custom-frame-plan';
          response = JSON.stringify(Array.from({ length: data.requestedImageCount }, (_, index) => ({ sourceShotId: data.source.shots[index % data.source.shots.length].id,
            description: `第${index + 1}张独立静帧：清晨青石桥与薄雾，石栏杆完整可见，固定中景，柔和晨光。` })));
        } else {
          assert.match(system, /图像|生图|图片/u); kind = 'image-conversion';
          response = 'A single still image of a stone bridge in gentle morning fog, complete stone railing, calm river beneath the bridge, medium view, soft natural side light and clean spatial depth, no people.';
        }
        requests.push({ kind, source: user });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
      } catch (cause) { errors.push(String(cause)); await route.fulfill({ status: 500, body: JSON.stringify({ error: { message: 'Isolated mock rejected unexpected text request' } }) }); }
      return;
    }
    await route.continue();
  });
  await page.goto(`${origin}${fixturePath}`);
  png = await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts'); const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts'); const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now(); const story = '青石桥上清晨薄雾缓慢流动，阳光照在青石栏杆，河水轻轻流淌。';
    const scene = { id: 'size-scene', title: '晨雾石桥', content: story, summary: '石桥环境画面', characterIds: [], locationIds: [], propIds: [], storyboardIds: ['size-board'], createdAt: now, updatedAt: now };
    const shots = [1, 2].map((index) => ({ id: `size-shot-${index}`, index, startSec: (index - 1) * 5, endSec: index * 5, purpose: '展示环境', subject: '青石桥', action: '薄雾缓慢流动，晨光照在石栏杆上', camera: '固定中景', lighting: '自然柔光', sound: '水声', result: '石栏杆保持可见', transition: '顺接', referenceAssetIds: [], prompt: `【${(index - 1) * 5}s-${index * 5}s】青石桥与薄雾，固定中景，柔和晨光。`, locked: false, authoredBy: 'text-api' }));
    const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
    const board = applyOfficialH3Prompt({ id: 'size-board', sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story,
      workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: 'custom', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '石桥环境与晨光固定', shots, finalPrompt,
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: ['size-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now },
      { assets: [], characters: [], locations: [], props: [], sceneContent: story });
    const project = { ...state.project, id: 'storyboard-size-ui-project', name: '分镜尺寸隔离测试', characters: [], locations: [], props: [], assets: [], sourceDocuments: [{ id: 'size-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [board], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__storyboard_size_mock__/text`, apiKey: '', model: 'mock-text' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__storyboard_size_mock__/image`, apiKey: '', model: 'mock-image' };
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null; state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.uiFontScalePercent = 100;
    state.settings.imageOutputSizes = { ordinary: { mode: '1x', aspect: '3:4', width: 1024, height: 1024 }, private: { mode: '2x', aspect: '2:3', width: 1024, height: 1024 } };
    state.settings.storyboardImageOutputSize = { mode: 'default', width: 1024, height: 1024 };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const paint = canvas.getContext('2d'); paint.fillStyle = '#789bad'; paint.fillRect(0, 0, 64, 64); return canvas.toDataURL('image/png');
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  const initial = await readState(); originalBoard = videoFacts(initial.project.storyboards[0]); originalLanes = initial.settings.imageOutputSizes;
  await enterWorkbench(); assert.equal(await sizeMode().inputValue(), 'default');
  await sizeMode().selectOption('2k'); assert.match(await sizeGroup().innerText(), /2048\s*×\s*1152/u);
  await page.getByRole('checkbox', { name: '选择第 1 镜', exact: true }).check();
  await generate(page.getByRole('button', { name: '生成选中分镜图片（1 张）', exact: true }), 1, [2048, 1152], 'workbench-2k-real-model-request-and-frozen-task');
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '人物角色', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '普通生图像素规格', exact: true }).inputValue(), '1x');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '私密生图像素规格', exact: true }).inputValue(), '2x');
  await enterWorkbench(); assert.equal(await sizeMode().inputValue(), '2k');
  await page.reload({ waitUntil: 'networkidle' }); await enterWorkbench(); assert.equal(await sizeMode().inputValue(), '2k');
  await sizeMode().selectOption('custom'); await page.getByRole('spinbutton', { name: '分镜图宽度像素', exact: true }).fill('1600'); await page.getByRole('spinbutton', { name: '分镜图高度像素', exact: true }).fill('900');
  await page.getByRole('checkbox', { name: '选择第 2 镜', exact: true }).check();
  await generate(page.getByRole('button', { name: '生成选中分镜图片（1 张）', exact: true }), 1, [1600, 900], 'workbench-custom-real-model-request-and-cross-tab-persistence');
  await page.reload({ waitUntil: 'networkidle' }); await enterWorkbench();
  assert.equal(await sizeMode().inputValue(), 'custom'); assert.equal(await page.getByRole('spinbutton', { name: '分镜图宽度像素', exact: true }).inputValue(), '1600');
  for (const fontScale of [100, 130]) {
    if (fontScale !== 100) {
      await page.goto(`${origin}${fixturePath}`);
      await page.evaluate(({ key, fontScale }) => { const state = JSON.parse(localStorage.getItem(key)); state.settings.uiFontScalePercent = fontScale; localStorage.setItem(key, JSON.stringify(state)); }, { key: storageKey, fontScale });
      await page.goto(origin, { waitUntil: 'networkidle' }); await enterWorkbench();
    }
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const size = document.querySelector('.storyboard-image-output-size-controls'); const action = document.querySelector('.storyboard-shot-picker-actions button');
      return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, size: box(size), action: box(action), controls: [...size.querySelectorAll('input,select')].map((element) => { const r = box(element); const hit = document.elementFromPoint((r.x + r.right) / 2, (r.y + r.bottom) / 2); return { ...r, visible: !!hit && (hit === element || element.contains(hit)) }; }) };
    });
    assert.ok(layout.documentWidth <= viewport.width + 1); assert.ok(layout.size.bottom <= layout.action.y + 1, 'size controls cannot overlap generate action');
    for (const control of layout.controls) assert.ok(control.visible && control.x >= 0 && control.right <= viewport.width && control.bottom <= viewport.height, 'resolution controls are visible and unobscured');
      layouts.push({ fontScale, ...layout }); await capture(`workbench-custom-${viewport.width}x${viewport.height}-${fontScale}percent`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 }); await enterDirector();
  await generate(page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }), 2, [1600, 900], 'director-boundary-frames-read-workbench-custom-setting');
  await generate(page.getByRole('button', { name: '生成分镜图片（2张）', exact: true }), 2, [1600, 900], 'director-per-shot-images-read-shared-custom-setting');
  await page.getByRole('spinbutton', { name: '自定义分镜图片数量', exact: true }).fill('3');
  await generate(page.getByRole('button', { name: '生成分镜图片（3张）', exact: true }), 3, [1600, 900], 'director-custom-frame-count-reads-shared-size-and-keeps-H3');
  await enterWorkbench(); await sizeMode().selectOption('2k'); await enterDirector();
  await generate(page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }), 2, [2048, 1152], 'director-boundary-next-batch-follows-updated-2k-setting');
  await assertNoSourceMutation(); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const report = { passed: true, stages, layouts, screenshots, requests, errors, blockedRequests, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, stages, requests: requests.length, imageRequests: requests.filter((entry) => entry.kind === 'image').length, errors, blockedRequests, report: path.join(output, 'report.json') }, null, 2));
} catch (cause) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); await fs.writeFile(path.join(output, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stages, requests, errors, blockedRequests, output }, null, 2));
  console.error(cause); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
