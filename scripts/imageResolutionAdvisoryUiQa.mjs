import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Fresh browser storage, neutral synthetic mannequin/environment fixtures and
// loopback HTTP mocks only. No production data or desktop bridge is accessed.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, 'image-resolution-advisory');
const relative = path.relative(outputBase, output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output cannot traverse links: ${candidate}`);
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const fixturePath = '/__image_advisory_fixture.html';
const mockPrefix = '/__image_advisory_mock__/';
const qa = { pass: false, mockOnly: true, noProductionDataRead: true, origin, stages: [], requests: [], errors: [], blockedRequests: [], screenshots: [] };
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'image resolution advisory isolated UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let png = ''; let phase = 'modern';
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const mode = (lane = '普通') => page.getByRole('combobox', { name: `${lane}生图分辨率`, exact: true });
const sizeGroup = (lane = '普通') => page.getByRole('group', { name: `${lane}生图分辨率设置`, exact: true });
const generate = () => page.locator('.image-generate-actions button.primary');
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); qa.screenshots.push(file); };
const enterCharacter = async () => {
  await nav('图像工作台'); await mode().waitFor();
  await page.locator('.image-entity-controls select').selectOption('advisory-character');
};
const expectedPixels = async (group, width, height) => {
  assert.match(await group.innerText(), new RegExp(`${width}\\s*×\\s*${height}`, 'u'));
  assert.equal(await group.getByRole('alert').count(), 0, 'capability or layout advisory is not a blocking alert');
};

async function installRoutes() {
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith(mockPrefix))) {
      qa.blockedRequests.push({ url: request.url(), method: request.method() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Isolated image advisory fixture</title><body>合成中性程序测试</body></html>' }); return;
    }
    if (!url.pathname.startsWith(mockPrefix)) { await route.continue(); return; }
    try {
      if (url.pathname.endsWith('/chat/completions')) {
        const payload = request.postDataJSON();
        const text = (role) => payload.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')).join('\n');
        const system = text('system'); const user = text('user');
        let response;
        if (system.includes('实际出镜人物解析器')) {
          const data = JSON.parse(user.slice(user.indexOf('{')));
          qa.requests.push({ phase, kind: 'identity' });
          response = JSON.stringify({ shots: data.shots.map((shot) => ({ shotId: shot.id, visibleCharacterNames: [] })) });
        } else {
          assert.match(system, /图像|生图|图片/u);
          qa.requests.push({ phase, kind: 'conversion', system, user });
          response = 'A single complete neutral display mannequin, full body from head to toe, smooth opaque blue surface, standing on the central vertical axis, plain continuous background on both sides, soft even studio light.';
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) }); return;
      }
      if (/\/images\/(?:generations|edits)$/u.test(url.pathname)) {
        const raw = request.postData() || ''; const multipart = /multipart\/form-data/u.test(request.headers()['content-type'] || '');
        const size = multipart ? raw.match(/name="size"\r?\n\r?\n([^\r\n]+)/u)?.[1] : JSON.parse(raw).size;
        qa.requests.push({ phase, kind: 'image', backend: 'openai', size });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) }); return;
      }
      if (url.pathname.endsWith('/sdapi/v1/txt2img') || url.pathname.endsWith('/sdapi/v1/img2img')) {
        const payload = request.postDataJSON();
        qa.requests.push({ phase, kind: 'image', backend: 'sd_webui', size: `${payload.width}x${payload.height}` });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ images: [png.split(',')[1]] }) }); return;
      }
      if (url.pathname.endsWith('/prompt')) {
        const payload = request.postDataJSON(); const canvas = payload.prompt.canvas.inputs;
        qa.requests.push({ phase, kind: 'image', backend: 'comfyui', size: `${canvas.width}x${canvas.height}`, batchSize: canvas.batch_size });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ prompt_id: 'isolated-advisory-image' }) }); return;
      }
      if (url.pathname.includes('/history/')) {
        const id = url.pathname.split('/').at(-1);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { output: { images: [{ filename: 'isolated.png', subfolder: '', type: 'output' }] } } } }) }); return;
      }
      if (url.pathname.endsWith('/view')) {
        await route.fulfill({ contentType: 'image/png', body: Buffer.from(png.split(',')[1], 'base64') }); return;
      }
      throw new Error(`Unexpected local mock endpoint: ${url.pathname}`);
    } catch (error) {
      qa.errors.push(error.message); await route.fulfill({ status: 500, body: 'Isolated mock rejected an unexpected request' });
    }
  });
}

async function seed(backend = 'openai') {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  png = await page.evaluate(async ({ key, origin, backend }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now();
    const character = { ...state.project.characters[0], id: 'advisory-character', name: '中性程序展示假人', gender: '男', apparentAge: '30岁', actualAge: '30岁', height: '180cm', race: '展示假人', morphology: 'humanoid', bodyPlan: '中性完整展示轮廓', appearance: '蓝色光滑不透明外壳，脸部无细节', outfit: '中性不透明展示外壳', anchor: '蓝色展示假人', assetIds: [], nsfwProfile: { fullBody: '中性展示假人，蓝色光滑不透明外壳，从头到脚完整的中性静态站姿，程序隔离测试。', provenance: 'manual' } };
    const story = '晨光照在青石桥栏杆上，河水平静流动，画面中没有人物。';
    const scene = { id: 'advisory-scene', title: '合成石桥环境', content: story, summary: story, characterIds: [], locationIds: [], propIds: [], storyboardIds: ['advisory-board'], createdAt: now, updatedAt: now };
    const finalPrompt = '【0s-5s】青石桥栏杆完整可见，固定中景，柔和晨光，无人物。';
    const board = applyOfficialH3Prompt({ id: 'advisory-board', sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '3:2', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '', shots: [{ id: 'advisory-shot', index: 1, startSec: 0, endSec: 5, purpose: '展示环境', subject: '青石桥', action: '晨光照在石栏杆上', camera: '固定中景', lighting: '柔和自然光', sound: '水声', result: '石栏杆完整可见', transition: '结束', referenceAssetIds: [], prompt: finalPrompt, locked: false, authoredBy: 'text-api' }], finalPrompt, promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: ['advisory-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now }, { assets: [], characters: [character], locations: [], props: [], sceneContent: story });
    const project = { ...state.project, id: `image-advisory-${backend}-project`, name: '生图能力提醒隔离测试', characters: [character], locations: [], props: [], assets: [], sourceDocuments: [{ id: 'advisory-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: [board], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__image_advisory_mock__/text`, apiKey: '', model: 'local-neutral-text' };
    state.settings.imageApi = { enabled: true, backend, baseUrl: `${origin}/__image_advisory_mock__/${backend}`, apiKey: '', model: backend === 'openai' ? 'gpt-image-2' : 'local-neutral-model', imageProtocol: backend === 'openai' ? 'openai-images' : 'openai-compatible', imageResolutionProfile: backend === 'openai' ? 'gpt-image-modern' : 'pixel-long-edge' };
    if (backend === 'comfyui') {
      const workflow = { checkpoint: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'local-mock.safetensors' } }, text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__', clip: ['checkpoint', 1] } }, negative: { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE_PROMPT__', clip: ['checkpoint', 1] } }, canvas: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } }, sampler: { class_type: 'KSampler', inputs: { model: ['checkpoint', 0], positive: ['text', 0], negative: ['negative', 0], latent_image: ['canvas', 0], seed: 1, steps: 8, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } }, decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['checkpoint', 2] } }, output: { class_type: 'SaveImage', inputs: { images: ['decode', 0] } } };
      state.settings.imageApi.workflowJson = JSON.stringify(workflow); state.settings.imageApi.comfyuiWorkflows = []; state.settings.imageApi.activeComfyuiWorkflowId = null;
    }
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null; state.settings.privateImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { [backend]: 'image-rule-openai-gpt-image' };
    state.settings.privateImagePromptRuleSetIdByBackend = { [backend]: 'image-rule-openai-gpt-image' };
    state.settings.imageOutputSizes = { ordinary: { mode: '1k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 }, private: { mode: '1k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 } };
    state.settings.storyboardImageOutputSize = { mode: '4k', width: 1024, height: 1024, resolutionVersion: 1 };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const paint = canvas.getContext('2d'); paint.fillStyle = '#537596'; paint.fillRect(0, 0, 64, 64); return canvas.toDataURL('image/png');
  }, { key: storageKey, origin, backend });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterCharacter();
}

async function submitAndCheck(button, width, height, label) {
  const before = (await readState()).project.generationTasks.map((task) => task.id);
  const requestIndex = qa.requests.length;
  assert.equal(await button.isEnabled(), true, `${label}: advisory must not disable generation`);
  await button.click();
  await page.waitForFunction(({ key, before }) => { const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks.filter((task) => !before.includes(task.id)); return tasks.length === 1 && ['succeeded', 'failed'].includes(tasks[0].status); }, { key: storageKey, before }, { timeout: 40_000 });
  const state = await readState(); const task = state.project.generationTasks.find((task) => !before.includes(task.id));
  assert.equal(task.status, 'succeeded', `${label}: ${task.error || 'no failure'}`);
  assert.deepEqual([task.width, task.height], [width, height]);
  assert.deepEqual(task.resolutionPlan.expected, { width, height });
  const requests = qa.requests.slice(requestIndex);
  const image = requests.filter((request) => request.kind === 'image');
  assert.equal(image.length, 1, `${label}: exactly one actual image submission`);
  assert.equal(image[0].size, `${width}x${height}`);
  const converter = requests.find((request) => request.kind === 'conversion');
  assert.ok(converter, `${label}: final image prompt conversion occurs`);
  assert.ok(`${converter.system}\n${converter.user}`.includes(String(width)) && `${converter.system}\n${converter.user}`.includes(String(height)), `${label}: actual pixels reach the converter rules and source`);
  qa.stages.push(label);
  return { task, converter };
}

async function checkModernLayoutAndCustom() {
  phase = 'modern'; await seed();
  await page.getByRole('button', { name: '五视图', exact: true }).click();
  await mode().selectOption('4k');
  await expectedPixels(sizeGroup(), 3840, 2160);
  assert.equal(await sizeGroup().getByRole('status').count(), 1, 'mapped fixed layout has an advisory status');
  const ordinary = await submitAndCheck(generate(), 3840, 2160, 'GPT-modern-ordinary-five-view-4K-advisory-submits-3840x2160-with-actual-converter-specification');
  assert.match(`${ordinary.converter.system}\n${ordinary.converter.user}`, /16:9/u);
  const ordinaryAspect = page.getByRole('combobox', { name: '普通生图画面比例', exact: true });
  assert.equal(await ordinaryAspect.isEnabled(), true, 'five-view layout does not lock the aspect selector');
  await ordinaryAspect.selectOption('16:9');
  assert.equal(await ordinaryAspect.inputValue(), '16:9');
  await expectedPixels(sizeGroup(), 3840, 2160);
  await capture('ordinary-five-view-4k-request');

  await mode().selectOption('custom');
  await page.getByRole('spinbutton', { name: '普通生图宽度像素', exact: true }).fill('63');
  await page.getByRole('spinbutton', { name: '普通生图高度像素', exact: true }).fill('2160');
  assert.equal(await generate().isDisabled(), true, 'malformed technical dimensions remain blocked');
  assert.equal(await sizeGroup().getByRole('alert').count(), 1);
  assert.match(await sizeGroup().innerText(), /63\s*×\s*2160/u, 'invalid summary still shows the entered request dimensions');
  await page.getByRole('spinbutton', { name: '普通生图宽度像素', exact: true }).fill('3840');
  await expectedPixels(sizeGroup(), 3840, 2160);
  await submitAndCheck(generate(), 3840, 2160, 'custom-3840x2160-five-view-layout-mismatch-is-advisory-and-submit-enabled');

  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密全身', exact: true }).click();
  await mode('私密').selectOption('4k');
  assert.equal(await page.getByRole('combobox', { name: '私密生图画面比例', exact: true }).isEnabled(), true, 'private layout does not lock the aspect selector');
  await expectedPixels(sizeGroup('私密'), 2160, 3840);
  const fullBody = await submitAndCheck(generate(), 2160, 3840, 'GPT-modern-private-full-body-4K-advisory-submits-2160x3840');
  assert.match(`${fullBody.converter.system}\n${fullBody.converter.user}`, /9:16/u);
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密五视图', exact: true }).click();
  await expectedPixels(sizeGroup('私密'), 3840, 2160);
  await submitAndCheck(generate(), 3840, 2160, 'GPT-modern-private-five-view-4K-layout-advisory-submits-3840x2160');
  await capture('private-five-view-4k-request');

  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '分镜图', exact: true }).click();
  const storyboardGroup = page.getByRole('group', { name: '分镜生图分辨率', exact: true });
  await expectedPixels(storyboardGroup, 3840, 2160);
  assert.equal(await storyboardGroup.getByRole('status').count(), 1);
  await page.getByRole('checkbox', { name: '选择第 1 镜', exact: true }).check();
  const storyboard = await submitAndCheck(page.getByRole('button', { name: '生成选中分镜图片（1 张）', exact: true }), 3840, 2160, 'GPT-modern-storyboard-3to2-4K-native-landscape-advisory-submits-3840x2160');
  assert.match(`${storyboard.converter.system}\n${storyboard.converter.user}`, /16:9/u);
  await capture('storyboard-4k-advisory');
}

async function checkUndeclaredLocalBackend(backend) {
  phase = backend; await seed(backend);
  await page.getByRole('combobox', { name: '普通生图画面比例', exact: true }).selectOption('1:1');
  for (const [tier, edge] of [['2k', 2048], ['4k', 4096]]) {
    await mode().selectOption(tier);
    await expectedPixels(sizeGroup(), edge, edge);
    assert.equal(await sizeGroup().getByRole('status').count(), 1, `${backend}: undeclared tier is a visible advisory`);
    assert.match(await sizeGroup().getByRole('status').innerText(), /声明|确认|支持|能力/u);
    const result = await submitAndCheck(generate(), edge, edge, `${backend}-undeclared-${tier.toUpperCase()}-advisory-keeps-submission-enabled-at-requested-pixels`);
    assert.equal(result.task.backend, backend);
  }
  await capture(`${backend}-undeclared-4k-advisory`);
}

async function run() {
  await waitForCondition({ label: 'local Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', (error) => qa.errors.push(error.message));
  await installRoutes();
  await checkModernLayoutAndCustom();
  await checkUndeclaredLocalBackend('comfyui');
  await checkUndeclaredLocalBackend('sd_webui');
  assert.deepEqual(qa.errors, []); assert.deepEqual(qa.blockedRequests, []); qa.pass = true;
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  qa.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); qa.failure.bodyText = await page.locator('body').innerText().catch(() => ''); }
  process.exitCode = error.exitCode || 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  harness.markElectronStopping(); await harness.stopAll().catch((error) => { qa.cleanupError = error.message; qa.pass = false; process.exitCode = 1; });
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(qa, null, 2)}\n`);
  await fs.writeFile(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: qa.pass, stages: qa.stages, imageRequests: qa.requests.filter((request) => request.kind === 'image').length, report: path.join(output, 'report.json'), failure: qa.failure?.message }, null, 2));
