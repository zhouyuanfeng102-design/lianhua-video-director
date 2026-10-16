import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the existing App task-card button with isolated state and media.
// Every API request is intercepted by the synthetic desktop bridge.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'storyboard-character-reference'));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const key = 'lianhua_video_director_state_v22';
const mediaKey = '__qa_character_reference_media';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the production dist bundle before running this QA');
const staticServerSource = `import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const base=${JSON.stringify(dist)};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
http.createServer((request,response)=>{try{const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);const target=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative)){response.writeHead(403);response.end();return;}const body=fs.readFileSync(target);response.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});response.end(body);}catch{response.writeHead(404);response.end();}}).listen(${port},'127.0.0.1',()=>console.log('Production bundle QA ready'));`;
const server = spawn(process.execPath, ['--input-type=module', '-e', staticServerSource],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'storyboard character reference UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
const errors = [], results = [];
const pendingRequests = new Map();
const diagnosticUrl = (value) => {
  try { const url = new URL(value); return /^https?:$/u.test(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol; }
  catch { return '[invalid URL]'; }
};
let browser, context, page;
const [{ createInitialState, normalizeState }, { captureImageApiSnapshot }, { createImageReferenceAssetSnapshot }, { withDirectImageRegenerationSnapshot }] = await Promise.all([
  tsImport('../src/storage.ts', import.meta.url), tsImport('../src/imageApiSelection.ts', import.meta.url),
  tsImport('../src/imageGeneration.ts', import.meta.url), tsImport('../src/imageAssetRegenerationSnapshot.ts', import.meta.url),
]);
const waitForApp = async (navigate) => {
  const deadline = Date.now() + 90_000;
  await navigate({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.locator('.sidebar').waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
};

const seed = async (convertedPrompt) => {
  const state = createInitialState(), now = Date.now();
  const pixels = await page.evaluate(() => Object.fromEntries(['#4079b1', '#86724d', '#728946', '#a15568', '#9ba978'].map((color) => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 160, 90);
    return [color, canvas.toDataURL('image/png')];
  })));
  const png = (color) => pixels[color];
  const media = new Map();
  const managed = (dataUrl, fileName) => {
    const checksum = createHash('sha256').update(dataUrl).digest('hex'), relativePath = `images/${checksum}.png`;
    media.set(relativePath, { dataUrl, checksum });
    return { fileName, relativePath, checksum, sizeBytes: dataUrl.length, mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, url: `${baseUrl}__qa_media/${checksum}.png` };
  };
  const makeAsset = async (id, name, color, extra = {}) => ({
    id, name, type: 'character', role: 'character', referenceRole: 'character', mediaType: 'image', source: 'upload',
    width: 160, height: 90, tags: [], createdAt: now, updatedAt: now,
    ...managed(png(color), `${id}.png`), ...extra,
  });
  const a = await makeAsset('qa-ref-a', '青岚人物参考', '#4079b1', { sourceEntityKind: 'character', sourceEntityId: 'qa-a', characterReferenceId: 'qa-a' });
  const scene = await makeAsset('qa-ref-scene', '门廊环境参考', '#86724d', { type: 'location', role: 'scene', referenceRole: 'scene', sourceEntityKind: 'location', sourceEntityId: 'qa-location' });
  const b = await makeAsset('qa-ref-b', '明川人物参考', '#728946', { sourceEntityKind: 'character', sourceEntityId: 'qa-b', characterReferenceId: 'qa-b' });
  const oldPrompt = 'OLD_SAVED_FRAME: 青岚独自站在门廊中央，身穿蓝甲，冷色侧光，中景静帧。';
  const currentH3 = 'integrated_multimodal_description: [Shot 1] CURRENT_H3: 成年战士青岚身穿蓝甲站在门廊左侧，明川身穿绿甲站在右侧，两人相隔三米，各自握杖。摄影机平视中景，石柱与门廊保持固定位置。\n\noverall_soundscape: 微风。\n\nnon_diegetic_music: N/A';
  const story = '成年战士青岚与明川在门廊相隔三米站立。';
  const character = (id, name, assetId) => ({ id, name, gender: '男', apparentAge: '30岁', actualAge: '30岁', race: '人类', morphology: 'humanoid', bodyPlan: '成年战士身体结构', appearance: '成年面孔，深色短发', outfit: '战甲', signatureProps: '长杖', personality: '平静', motionHabits: '', anchor: name, negativeContinuity: '', assetIds: [assetId] });
  const board = {
    id: 'qa-board', chapterId: 'qa-chapter', sceneId: 'qa-scene', sourceStoryTitle: '门廊对峙', sourceStoryContent: story,
    workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
    pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
    ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '两位成年战士身份保持', globalReferenceAssetIds: [],
    shots: [{ id: 'qa-shot', index: 1, startSec: 0, endSec: 5, purpose: '展示门廊对峙', subject: '青岚、明川', action: '两人相隔三米握杖站立',
      camera: '平视中景', lighting: '自然侧光', sound: '微风', transition: '自然结束', result: '两人保持位置', referenceAssetIds: [], prompt: story, locked: false }],
    finalPrompt: story, officialPromptZh: currentH3, officialPromptEn: 'CURRENT_EN_H3: two adult warriors stand three meters apart in a stone corridor.',
    officialPromptEnSource: currentH3, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now,
  };
  state.settings.uiFontScalePercent = 100;
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: 'https://qa-text.invalid/v1/chat/completions', apiKey: '', model: 'qa-text', vision: false };
  state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: 'https://qa-image.invalid/v1', apiKey: '', model: 'qa-image' };
  state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
  state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
  state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
  state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
  // Match the production loader's execution defaults before freezing its API
  // fingerprint; a sparse pre-hydration config would be a different request.
  state.settings = normalizeState(state).settings;
  const oldTask = {
    id: 'qa-old-task', kind: 'image', name: '门廊 · 第1段 · 第1镜分镜图', assetKind: 'storyboard', imageVariant: 'storyboard-frame',
    imageGenerationMode: 'image-to-image', status: 'succeeded', prompt: oldPrompt, width: 160, height: 90, sizeOverride: true,
    backend: 'openai', model: 'qa-image', imageApiSnapshot: await captureImageApiSnapshot(state.settings.imageApi, null),
    sourceStoryboardId: board.id, sourceShotId: 'qa-shot', imagePromptFormat: 'natural-language',
    imagePromptRuleSetId: 'image-rule-openai-gpt-image', imagePromptPresetId: 'image-preset-storyboard',
    referenceAssetIds: [a.id, scene.id], primaryReferenceAssetIds: [a.id, scene.id],
    referenceAssetSnapshots: [a, scene].map((asset) => createImageReferenceAssetSnapshot(asset)),
    conversionSource: 'OLD_SOURCE: only one warrior', converterSystemPrompt: 'OLD_CONVERTER_RULE', resultAssetId: 'qa-old-image', createdAt: now, updatedAt: now,
  };
  const oldImage = withDirectImageRegenerationSnapshot(await makeAsset('qa-old-image', oldTask.name, '#a15568', {
    type: 'reference', role: 'composition', referenceRole: 'composition', source: 'generated', sourceStoryboardId: board.id,
    sourceShotId: 'qa-shot', imageVariant: 'storyboard-frame', prompt: oldPrompt, imageBackend: 'openai',
    imageRequestSize: { width: 160, height: 90, sizeOverride: true },
  }), oldTask);
  const project = {
    ...state.project, id: 'qa-project', name: '角色参考补全隔离测试', activeChapterId: 'qa-chapter', chapterWorkspaces: {},
    sourceDocuments: [{ id: 'qa-chapter', name: '第1章', content: story, createdAt: now, updatedAt: now }], storyDraft: story,
    scenes: [{ id: 'qa-scene', title: '门廊', content: story, summary: story, characterIds: ['qa-a', 'qa-b'], locationId: 'qa-location', locationIds: ['qa-location'], propIds: [], storyboardIds: [board.id], createdAt: now, updatedAt: now }],
    storyboards: [board], assets: [oldImage, a, scene, b], characters: [character('qa-a', '青岚', a.id), character('qa-b', '明川', b.id)],
    locations: [{ id: 'qa-location', name: '门廊', description: '石柱门廊', timeWeather: '', lighting: '自然侧光', palette: '', fixedProps: '', anchor: '', assetIds: [scene.id] }],
    props: [], generationTasks: [oldTask], sequencePlans: [], createdAt: now, updatedAt: now,
  };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  const persisted = normalizeState(state);
  await page.evaluate(({ key, mediaKey, state, media, convertedPrompt, resultPng }) => {
    localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem(mediaKey, JSON.stringify(media));
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('__qa_converted_prompt', convertedPrompt); localStorage.setItem('__qa_result_png', resultPng);
  }, { key, mediaKey, state: persisted, media: [...media], convertedPrompt, resultPng: png('#9ba978') });
  return { pixels: [png('#4079b1'), png('#86724d'), png('#728946')], project: persisted.project };
};

const run = async () => {
  await waitForCondition({ label: 'character-reference QA startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(({ mediaKey }) => {
    const saved = new Map(JSON.parse(sessionStorage.getItem(mediaKey) || '[]'));
    const digest = async (dataUrl) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    window.__qaRequests = [];
    window.__qaNotices = [];
    new MutationObserver(() => {
      const notice = document.querySelector('.sidebar-notice')?.textContent?.trim();
      if (notice && window.__qaNotices.at(-1) !== notice) window.__qaNotices.push(notice);
    }).observe(document, { childList: true, subtree: true, characterData: true });
    window.lianhuaDesktop = {
      onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
      storeGeneratedImage: async ({ dataUrl, fileName }) => {
        const checksum = await digest(dataUrl), relativePath = `images/${checksum}.png`;
        saved.set(relativePath, { dataUrl, checksum }); sessionStorage.setItem(mediaKey, JSON.stringify([...saved]));
        return { fileName: fileName || `${checksum}.png`, relativePath, checksum, sizeBytes: dataUrl.length, mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, url: `${location.origin}/__qa_media/${checksum}.png` };
      },
      readManagedImageDataUrl: async ({ relativePath, expectedChecksum }) => {
        const item = saved.get(relativePath);
        if (!item || item.checksum !== expectedChecksum) throw new Error('Isolated managed reference missing or changed');
        return item.dataUrl;
      },
      request: async (payload) => {
        window.__qaRequests.push(payload);
        if (payload.url.startsWith('https://qa-text.invalid/')) return { status: 200, body: JSON.stringify({ choices: [{ message: { content: localStorage.getItem('__qa_converted_prompt') } }] }) };
        if (payload.url.startsWith('https://qa-image.invalid/')) return { status: 200, body: JSON.stringify({ data: [{ b64_json: localStorage.getItem('__qa_result_png').split(',')[1] }] }) };
        throw new Error(`Unexpected QA bridge URL: ${payload.url}`);
      },
    };
  }, { mediaKey });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) {
      errors.push(`Unexpected network: ${diagnosticUrl(url.href)}`); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname.startsWith('/__qa_media/')) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64') }); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => pendingRequests.set(request, {
    url: diagnosticUrl(request.url()), method: request.method(), resourceType: request.resourceType(), startedAt: Date.now(),
  }));
  page.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('requestfailed', (request) => pendingRequests.delete(request));
  await waitForApp((options) => page.goto(baseUrl, options));
  for (const spec of [
    { name: 'visible-secondary', ids: ['qa-ref-a', 'qa-ref-scene', 'qa-ref-b'], prompt: '青岚身穿蓝甲站在门廊左侧，明川身穿绿甲站在右侧，两人相隔三米，各自握杖，石柱保持固定位置，平视中景静帧。' },
    { name: 'offscreen-secondary', ids: ['qa-ref-a', 'qa-ref-scene'], prompt: '青岚身穿蓝甲站在门廊左侧握杖，石柱与门廊在自然侧光中清晰可见，明川明确在画外，画面仅呈现青岚的中景静帧。' },
  ]) {
    const before = await seed(spec.prompt);
    await waitForApp((options) => page.reload(options));
    await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
    const imageTab = page.getByRole('tab', { name: /图片任务/u }); if (await imageTab.count()) await imageTab.click();
    const card = page.locator('#image-task-qa-old-task'); await card.waitFor();
    before.project = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, key);
    await card.locator('.image-regenerate-button').click();
    await page.waitForFunction((key) => {
      const project = JSON.parse(localStorage.getItem(key)).project;
      return project.generationTasks.length === 2 && ['succeeded', 'failed', 'cancelled'].includes(project.generationTasks[0].status);
    }, key, { timeout: 20_000 });
    const { project, calls } = await page.evaluate((key) => ({ project: JSON.parse(localStorage.getItem(key)).project, calls: window.__qaRequests }), key);
    const task = project.generationTasks[0]; assert.equal(task.status, 'succeeded', task.error);
    const textCalls = calls.filter((call) => call.url.startsWith('https://qa-text.invalid/'));
    const imageCalls = calls.filter((call) => call.url.startsWith('https://qa-image.invalid/'));
    assert.equal(textCalls.length, 1); assert.equal(imageCalls.length, 1); assert.equal(calls.length, 2, 'one conversion and one image request only');
    const messages = JSON.stringify(JSON.parse(textCalls[0].body).messages);
    assert.match(messages, /CURRENT_H3/u); assert.doesNotMatch(messages, /OLD_SAVED_FRAME|OLD_SOURCE|OLD_CONVERTER_RULE/u);
    const multipart = imageCalls[0].multipart; assert.ok(multipart, 'the real image transport must use multipart edits');
    assert.deepEqual(multipart.files.map((file) => file.dataUrl), before.pixels.slice(0, spec.ids.length), 'actual uploads preserve A, scene, then the missing B identity');
    const prompt = multipart.fields.find((field) => field.name === 'prompt').value;
    assert.ok(prompt.startsWith(spec.prompt), 'the complete AI-authored body remains unchanged');
    const map = prompt.slice(prompt.indexOf('本次实际上传图片（严格按此顺序）：'));
    assert.match(map, /1\. 人物 "青岚"[\s\S]*2\. "门廊环境参考"/u);
    if (spec.ids.length === 3) assert.match(map, /3\. 人物 "明川"/u);
    else assert.doesNotMatch(map, /人物 "明川"/u);
    assert.deepEqual(task.referenceAssetIds, spec.ids);
    assert.deepEqual(task.referenceAssetSnapshots.map((snapshot) => snapshot.id), spec.ids);
    const asset = project.assets.find((item) => item.id === task.resultAssetId); assert.ok(asset);
    assert.deepEqual(asset.imageRegenerationSnapshot.referenceAssetSnapshots.map((snapshot) => snapshot.id), spec.ids);
    assert.doesNotMatch(JSON.stringify([task.referenceAssetSnapshots, asset.imageRegenerationSnapshot.referenceAssetSnapshots]), /data:image|https?:|apiKey/u, 'task and result snapshots store managed locators only');
    assert.deepEqual(project.generationTasks.find((item) => item.id === 'qa-old-task'), before.project.generationTasks[0]);
    assert.deepEqual(project.assets.find((item) => item.id === 'qa-old-image'), before.project.assets.find((item) => item.id === 'qa-old-image'));
    assert.deepEqual(project.storyboards, before.project.storyboards, 'old images, old tasks and every H3/video field remain unchanged');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${spec.name}.png`), fullPage: false });
    results.push({ case: spec.name, converterRequests: 1, imageRequests: 1, uploadedReferenceIds: spec.ids, taskAndAssetSnapshotsComplete: true, originalRecordsPreserved: true });
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, viewport: { width: 1366, height: 900 }, results, errors }, null, 2));
  console.log(JSON.stringify({ output, results }));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  const app = page && !page.isClosed() ? await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    return { notices: window.__qaNotices || [], bridgeRequestCount: window.__qaRequests?.length || 0,
      tasks: state?.project?.generationTasks?.map((task) => ({ id: task.id, status: task.status, error: task.error })) || [] };
  }, key).catch(() => undefined) : undefined;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), results, errors,
    app,
    pendingRequests: [...pendingRequests.values()].map(({ startedAt, ...request }) => ({ ...request, pendingMs: Date.now() - startedAt })),
  }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'server.log'), harness.readElectronLog());
}
