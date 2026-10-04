import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const baseOutput = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(baseOutput, 'asset-library-direct-0.5.89'));
const relative = path.relative(baseOutput, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Asset QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Asset QA output must not traverse directory links');
fs.mkdirSync(output, { recursive: true });
const key = 'lianhua_video_director_state_v22'; const port = await findAvailableTcpPort(); const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await s.listen(); console.log('Direct asset library isolated QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'direct asset library UI QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; const results = []; const errors = []; const screenshots = [];

const seed = (fontScale) => page.evaluate(async ({ storageKey, font }) => {
  const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
  const state = JSON.parse(localStorage.getItem(storageKey)); const now = Date.now();
  const image = (id, name, color, role) => { const c = document.createElement('canvas'); c.width = 144; c.height = 108; const p = c.getContext('2d'); p.fillStyle = color; p.fillRect(0, 0, 144, 108); p.fillStyle = '#fff'; p.fillText('SAFE ASSET QA', 14, 55); return { id, name, type: role === 'character' ? 'character' : 'reference', role, referenceRole: role, mediaType: 'image', dataUrl: c.toDataURL('image/png'), width: 144, height: 108, source: 'upload', tags: ['隔离SFW'], createdAt: now, updatedAt: now }; };
  const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 108; const paint = canvas.getContext('2d'); paint.fillStyle = '#91a8bb'; paint.fillRect(0, 0, 144, 108);
  const video = await new Promise((resolve, reject) => { const stream = canvas.captureStream(10); const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); }; recorder.onerror = reject; recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); const blob = new Blob(chunks, { type: 'video/webm' }); const reader = new FileReader(); reader.onload = () => resolve({ dataUrl: reader.result, sizeBytes: blob.size }); reader.onerror = reject; reader.readAsDataURL(blob); }; recorder.start(); setTimeout(() => recorder.stop(), 230); });
  const videoDuration = await new Promise((resolve, reject) => {
    const probe = document.createElement('video'); probe.preload = 'metadata';
    probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration * 100) / 100 : undefined);
    probe.onerror = () => reject(new Error('Synthetic video metadata could not be read'));
    probe.src = video.dataUrl;
  });
  const wav = new ArrayBuffer(1644); const w = new DataView(wav); const ascii = (offset, text) => [...text].forEach((char, index) => w.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF'); w.setUint32(4, 1636, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); w.setUint32(16, 16, true); w.setUint16(20, 1, true); w.setUint16(22, 1, true); w.setUint32(24, 8000, true); w.setUint32(28, 16000, true); w.setUint16(32, 2, true); w.setUint16(34, 16, true); ascii(36, 'data'); w.setUint32(40, 1600, true);
  const audioUrl = `data:audio/wav;base64,${btoa(String.fromCharCode(...new Uint8Array(wav)))}`;
  const projects = ['A', 'B'].map((prefix) => {
    const projectId = `asset-direct-${prefix}`; const first = image(`${prefix}-image-1`, `${prefix}-构图图`, '#86a6b7', 'composition'); const second = image(`${prefix}-image-2`, `${prefix}-人物图`, '#b392b6', 'character');
    const story = `${prefix}项目：林澜来到廊桥，推开木门并说：“我在这里等你。”`;
    const scene = { id: `${prefix}-scene`, title: `${prefix}廊桥门口`, content: story, summary: '推门后等候', characterIds: [], locationIds: [], propIds: [], storyboardIds: [`${prefix}-board`], createdAt: now, updatedAt: now };
    const prompt = '【0s-5s】 主体：@林澜（平静）[朝向：同伴] 正在 [推开木门→停步回望]（发出回应）；空间：林澜站在廊桥门口，同伴在身后；光影：自然侧光；镜头：中景固定；台词：第1s @林澜：“我在这里等你。”；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]';
    const board = applyOfficialH3Prompt({ id: `${prefix}-board`, sceneId: scene.id, sourceStoryContent: story, sourceStoryTitle: `${prefix}廊桥剧情`, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', shots: [{ id: `${prefix}-shot`, index: 1, startSec: 0, endSec: 5, subject: '林澜', action: '推门后回望', purpose: '回应', camera: '中景固定', lighting: '自然侧光', sound: '', transition: '自然承接', result: '停步等候', referenceAssetIds: [], prompt, locked: false }], finalPrompt: prompt, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now }, { assets: [first, second], characters: [], locations: [], props: [], sceneContent: story });
    const task = { id: `${prefix}-task`, kind: 'video', storyboardId: board.id, targetId: 'mock-video', status: 'succeeded', resultAssetId: `${prefix}-video-1`, requestBody: {}, createdAt: now, updatedAt: now, videoJob: { stage: 'succeeded', completedAt: now, snapshot: { projectId, clientId: `${prefix}-client`, draft: { name: `${prefix}-关联成片`, prompt: board.officialPromptZh, backend: 'api', parameters: {}, references: [{ assetId: first.id, role: first.role }], source: { storyboardId: board.id, language: 'zh' } }, connection: { backend: 'api', api: { enabled: false, endpoint: '', statusEndpointTemplate: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' } }, images: [{ assetId: first.id, name: first.name, role: first.role, dataUrl: first.dataUrl, freezeState: 'frozen' }] } } };
    const movie = { ...video, id: `${prefix}-video-1`, name: `${prefix}-关联成片`, type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', mimeType: 'video/webm', width: 144, height: 108, durationSec: videoDuration, source: 'generated', sourceStoryboardId: board.id, sourceVideoTaskId: task.id, videoSourceTask: structuredClone(task), tags: ['隔离SFW'], createdAt: now, updatedAt: now };
    const otherMovie = { ...video, id: `${prefix}-video-2`, name: `${prefix}-其他成片`, type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', mimeType: 'video/webm', width: 144, height: 108, durationSec: videoDuration, source: 'upload', tags: ['隔离SFW'], createdAt: now, updatedAt: now };
    const audio = { id: `${prefix}-audio`, name: `${prefix}-音频参考`, type: 'audio', role: 'audio', referenceRole: 'audio', mediaType: 'audio', mimeType: 'audio/wav', dataUrl: audioUrl, durationSec: 0.1, source: 'upload', tags: ['静音合成WAV'], createdAt: now, updatedAt: now };
    return { ...state.project, id: projectId, name: `资产直达项目${prefix}`, sourceDocuments: [{ id: `${prefix}-source`, name: `${prefix}廊桥剧情`, content: story, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [board], sequencePlans: [], assets: [first, second, movie, otherMovie, audio], generationTasks: [task], characters: [], locations: [], props: [], updatedAt: now };
  });
  state.project = projects[0]; state.projects = projects; state.activeProjectId = projects[0].id; state.settings.uiFontScalePercent = font;
  for (const kind of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[kind].enabled = false; state.settings[kind].apiKey = ''; }
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null; state.settings.videoBackend = 'api';
  localStorage.setItem(storageKey, JSON.stringify(state));
}, { storageKey: key, font: fontScale });

const assertLibrary = async (section, prefix, expectedCount) => {
  await page.getByRole('heading', { name: section, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '资产库首页', exact: true }).count(), 0);
  assert.equal(await page.locator('.asset-library-entry').count(), 0);
  const tabs = page.locator('.asset-library-tabs button'); assert.deepEqual(await tabs.allTextContents(), ['图片资产库', '视频资产库', '音频参考']);
  const visible = await tabs.evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return box.y >= 0 && box.bottom <= innerHeight && box.x >= 0 && box.right <= innerWidth && (hit === button || button.contains(hit)); }));
  assert.ok(visible.every(Boolean), 'all library tabs must be fully visible and reachable');
  const cards = page.locator('.asset-card'); assert.equal(await cards.count(), expectedCount);
  assert.ok((await cards.allTextContents()).every((text) => text.includes(`${prefix}-`)), 'the library must remain scoped to the current project');
};

const run = async () => {
  await waitForCondition({ label: 'asset direct Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  for (const spec of [{ width: 1280, height: 800, font: 100 }, { width: 1366, height: 768, font: 125 }]) {
    context = await browser.newContext({ viewport: { width: spec.width, height: spec.height } }); page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__asset_direct_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__asset_direct_qa__', '1'); }
      window.__assetDirectQa = { requests: [] }; window.lianhuaDesktop = { onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true, videoRequest: async (payload) => { window.__assetDirectQa.requests.push(payload.url); throw new Error('No real generation in direct-library QA'); } };
    });
    await page.route('**/*', async (route) => { const req = route.request(); const url = new URL(req.url()); if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(req.method()))) { errors.push(`Unexpected API request: ${url.href}`); await route.abort('blockedbyclient'); } else await route.continue(); });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 }); await page.waitForFunction((storageKey) => Boolean(localStorage.getItem(storageKey)), key); await seed(spec.font); await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
    const original = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)).projects.map((project) => ({ id: project.id, assets: project.assets, storyboards: project.storyboards })), key);
    const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
    const tab = (name) => page.locator('.asset-library-tabs').getByRole('button', { name, exact: true }).click();
    await nav('资产库'); await assertLibrary('图片资产库', 'A', 2);
    const screenshot = `direct-image-library-${spec.width}x${spec.height}-font${spec.font}.png`; await page.screenshot({ path: path.join(output, screenshot), fullPage: false }); screenshots.push(screenshot);
    await tab('视频资产库'); await assertLibrary('视频资产库', 'A', 2);
    await tab('音频参考'); await assertLibrary('音频参考', 'A', 1); assert.equal(await page.locator('.asset-card audio').count(), 1);
    await nav('资产库'); await assertLibrary('图片资产库', 'A', 2);
    await page.locator('.asset-card').filter({ hasText: 'A-构图图' }).getByRole('button', { name: '用此图生成视频', exact: true }).click();
    await page.locator('.video-director-view').waitFor(); assert.equal(await page.locator('.vd-reference-row').count(), 1); assert.ok((await page.locator('.vd-reference-row').innerText()).includes('A-构图图')); assert.equal(await page.getByLabel('图片 1 用途', { exact: true }).inputValue(), 'composition');
    await nav('资产库'); await assertLibrary('图片资产库', 'A', 2);
    await page.getByRole('checkbox', { name: '选中用于生成视频：A-构图图', exact: true }).check(); await page.getByRole('checkbox', { name: '选中用于生成视频：A-人物图', exact: true }).check();
    await page.getByRole('button', { name: '用选中 2 张图片生成视频', exact: true }).click(); await page.locator('.video-director-view').waitFor();
    assert.equal(await page.locator('.vd-reference-row').count(), 2); assert.equal(await page.getByLabel('图片 1 用途', { exact: true }).inputValue(), 'composition'); assert.equal(await page.getByLabel('图片 2 用途', { exact: true }).inputValue(), 'character');
    await nav('提示词导演台'); await page.getByRole('button', { name: /^查看关联成片/u }).click(); await assertLibrary('视频资产库', 'A', 1); assert.ok((await page.locator('.asset-card').innerText()).includes('A-关联成片'));
    await nav('资产库'); await assertLibrary('图片资产库', 'A', 2); await tab('音频参考');
    await page.locator('.top-action-library').click(); await page.getByRole('dialog', { name: '项目库', exact: true }).locator('.project-library-select').filter({ hasText: '资产直达项目B' }).click();
    // Follow the real workbench route after a project switch: it must open the
    // new project's image library directly, without an intermediary home page.
    await nav('图像工作台'); await page.locator('.image-view > .section-heading').getByRole('button', { name: '打开资产库', exact: true }).click(); await assertLibrary('图片资产库', 'B', 2);
    await tab('视频资产库'); await assertLibrary('视频资产库', 'B', 2); await tab('音频参考'); await assertLibrary('音频参考', 'B', 1);
    await nav('资产库'); await assertLibrary('图片资产库', 'B', 2);
    const after = await page.evaluate((storageKey) => { const state = JSON.parse(localStorage.getItem(storageKey)); return state.projects.map((project) => ({ id: project.id, assets: project.assets, storyboards: project.storyboards })); }, key);
    assert.deepEqual(after, original, 'navigation and sending selected references must not delete, rebind or mutate any original image/video/audio or storyboard');
    assert.deepEqual(await page.evaluate(() => window.__assetDirectQa.requests), []); assert.deepEqual(errors, []);
    results.push({ ...spec, directImageEntry: true, threeTabsWithoutHome: true, reentryAndProjectReset: true, singleAndMultiImageDraft: true, relatedVideosDirect: true, originalDataUnchanged: true, apiRequests: 0 });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, results, screenshots, errors }, null, 2)); console.log(JSON.stringify(results.at(-1)));
    await context.close(); context = undefined;
  }
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), results, errors }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
