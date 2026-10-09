import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Fresh browser storage and local synthetic fixtures only. All external HTTP
// traffic is blocked; the single image request returns a neutral color tile.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.join(outputBase, 'image-resolution');
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const qa = { pass: false, mockOnly: true, noProductionDataRead: true, origin, stages: [], requests: [], blockedExternalRequests: [], errors: [], screenshots: [], png: '' };
const checkRemainingOnly = process.argv.includes('--remaining');

await fs.mkdir(outputBase, { recursive: true });
const relativeOutput = path.relative(outputBase, outputDirectory);
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput));
for (const directory of [path.join(root, 'output'), outputBase, outputDirectory]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow a symbolic link: ${directory}`);
}
await fs.mkdir(outputDirectory, { recursive: true });
if (checkRemainingOnly) {
  const prior = JSON.parse(await fs.readFile(path.join(outputDirectory, 'report.json'), 'utf8'));
  assert.equal(prior.mockOnly, true); assert.equal(prior.noProductionDataRead, true);
  assert.ok(prior.stages.includes('ordinary-and-private-five-view-layout-preserved-across-K-tiers'));
  qa.stages.push(...prior.stages);
  qa.screenshots.push(...prior.screenshots.filter((file) => !file.endsWith('failure.png')));
  qa.targetedRerun = { reason: 'Correct result-warning assertion to the visible sidebar message; preserve already passed control and layout checks.', previouslyPassedStages: prior.stages };
}

const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'image resolution isolated browser QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;

const mode = (lane = '普通') => page.getByRole('combobox', { name: `${lane}生图分辨率`, exact: true });
const aspect = (lane = '普通') => page.getByRole('combobox', { name: `${lane}生图画面比例`, exact: true });
const sizeGroup = (lane = '普通') => page.getByRole('group', { name: `${lane}生图分辨率设置`, exact: true });
const generate = () => page.locator('.image-generate-actions button.primary');
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const enter = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  await mode().waitFor();
  await page.locator('.image-entity-controls select').selectOption('image-resolution-character');
};
const screenshot = async (name) => {
  const file = path.join(outputDirectory, `${name}.png`);
  await page.screenshot({ path: file, scale: 'css' });
  qa.screenshots.push(file);
};
const checkOptions = async (lane) => {
  const options = await mode(lane).locator('option').evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent })));
  assert.deepEqual(options.slice(0, 3), [{ value: '1k', text: '1K' }, { value: '2k', text: '2K' }, { value: '4k', text: '4K' }]);
  assert.ok(options.every((item) => !/^[12]x$/iu.test(item.value) && !/[12]X/iu.test(item.text)));
};

async function installFixture() {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) {
      qa.blockedExternalRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/__image_resolution_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>isolated resolution QA</title><body>隔离的分辨率测试资料</body></html>' });
      return;
    }
    if (url.pathname.startsWith('/__qa_image_resolution__/')) {
      let body;
      try { body = JSON.parse(request.postData() || '{}'); } catch { body = null; }
      qa.requests.push({ url: request.url(), method: request.method(), body: body && { model: body.model, size: body.size, messageCount: Array.isArray(body.messages) ? body.messages.length : undefined } });
      if (url.pathname.endsWith('/chat/completions')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'A single neutral display mannequin centered in a clean studio, smooth opaque blue surface, soft even lighting, plain background.' } }] }) });
      } else if (url.pathname.endsWith('/images/generations')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: qa.png.split(',')[1] }] }) });
      } else {
        qa.errors.push(`Unexpected local mock request: ${request.url()}`);
        await route.fulfill({ status: 500, body: 'Unknown isolated mock route' });
      }
      return;
    }
    await route.continue();
  });
  await page.goto(`${origin}/__image_resolution_fixture.html`, { waitUntil: 'domcontentloaded' });
  qa.png = await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState();
    const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#4969a4'; paint.fillRect(0, 0, 512, 512); paint.fillStyle = '#d5bd79'; paint.fillRect(128, 128, 256, 256);
    const png = canvas.toDataURL('image/png');
    const character = { ...state.project.characters[0], id: 'image-resolution-character', name: '中性测试假人', gender: '男', apparentAge: '30岁', actualAge: '30岁', height: '约180cm', race: '仿生展示假人', morphology: 'humanoid', bodyPlan: '直立展示用假人，完整光滑轮廓', appearance: '蓝色光滑不透明表面，脸部无五官细节', outfit: '中性展示外壳', signatureProps: '无', personality: '静态展示', motionHabits: '中性站姿', anchor: '蓝色光滑展示假人', negativeContinuity: '保持同一外壳', assetIds: [], nsfwProfile: { fullBody: '中性蓝色展示假人，光滑不透明表面，从头到脚完整中性站姿，只用于程序隔离测试。', provenance: 'manual' } };
    const project = { ...state.project, id: 'image-resolution-ui-project', name: '生图分辨率隔离测试', characters: [character], locations: [], props: [], assets: [], sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__qa_image_resolution__/text`, apiKey: '', model: 'neutral-mock-text' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__qa_image_resolution__/image`, apiKey: '', model: 'neutral-mock-image', imageProtocol: 'openai-compatible', imageResolutionProfile: 'pixel-long-edge' };
    state.settings.imageApiProfiles = [{ id: 'private-resolution-gemini', name: '隔离 Gemini 原生档位', enabled: true, backend: 'openai', baseUrl: `${origin}/__qa_image_resolution__/private`, apiKey: '', model: 'gemini-3-pro-image-preview', imageProtocol: 'gemini', imageResolutionProfile: 'gemini-k', createdAt: now, updatedAt: now }];
    state.settings.activeImageApiProfileId = null; state.settings.privateImageApiProfileId = 'private-resolution-gemini';
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.privateImagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.imageOutputSizes = { ordinary: { mode: '1k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 }, private: { mode: '1k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 } };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    return png;
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await enter();
}

async function checkControlsAndPersistence() {
  await checkOptions('普通');
  await mode().selectOption('2k'); await aspect().selectOption('1:1');
  assert.match(await sizeGroup().innerText(), /2048\s*×\s*2048/u);
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  await checkOptions('私密');
  assert.equal(await mode('私密').inputValue(), '1k', 'private preference must start independently');
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密全身', exact: true }).click();
  await mode('私密').selectOption('4k');
  assert.match(await sizeGroup('私密').innerText(), /3392\s*×\s*5056/u);
  assert.match(await sizeGroup('私密').innerText(), /2:3/u);
  assert.equal(await aspect('私密').isEnabled(), true, 'private full-body proportions are selectable; 2:3 is the default recommendation');
  assert.equal(await aspect('私密').inputValue(), 'variant');
  await screenshot('private-native-4k-fullbody');
  await page.waitForFunction((key) => { const preferences = JSON.parse(localStorage.getItem(key)).settings.imageOutputSizes; return preferences.ordinary.mode === '2k' && preferences.private.mode === '4k'; }, storageKey);
  await page.reload({ waitUntil: 'networkidle' }); await enter();
  assert.equal(await mode().inputValue(), '2k'); assert.equal(await aspect().inputValue(), '1:1');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await mode('私密').inputValue(), '4k');
  assert.match(await sizeGroup('私密').innerText(), /3392\s*×\s*5056/u);
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(qa.requests.length, 0, 'controls must not issue model requests');
  qa.stages.push('1K-2K-4K-controls-and-independent-reload-persistence');
  qa.stages.push('private-Gemini-native-4K-3392x5056-recommended-2to3-and-selectable-aspect');
}

async function checkFiveViewLayouts() {
  await page.getByRole('button', { name: '五视图', exact: true }).click();
  await aspect().selectOption('variant');
  const ordinaryLayout = await page.locator('.image-canvas-hint').innerText();
  assert.match(ordinaryLayout, /3:2/u); assert.match(ordinaryLayout, /左侧上下两张头像，右侧正面、侧面、背面全身/u);
  await mode().selectOption('4k');
  const ordinary4kLayout = await page.locator('.image-canvas-hint').innerText();
  assert.match(ordinary4kLayout, /3:2/u); assert.match(ordinary4kLayout, /左侧上下两张头像，右侧正面、侧面、背面全身/u);
  assert.equal(await aspect().isEnabled(), true, 'five-view layout must allow an explicit output aspect');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  await page.getByRole('button', { name: '私密五视图', exact: true }).click();
  const private4kLayout = await page.locator('.image-private-generation-note').innerText();
  assert.match(private4kLayout, /左侧正面\/侧面头像，右侧正面\/侧面\/背面全身/u);
  assert.match(await sizeGroup('私密').innerText(), /5056\s*×\s*3392/u);
  assert.match(await sizeGroup('私密').innerText(), /3:2/u);
  await mode('私密').selectOption('1k');
  assert.equal(await page.locator('.image-private-generation-note').innerText(), private4kLayout);
  assert.equal(await aspect('私密').isEnabled(), true, 'private five-view layout must allow an explicit output aspect');
  await mode('私密').selectOption('4k');
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密全身', exact: true }).click();
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  await page.getByRole('button', { name: '头像', exact: true }).click();
  await mode().selectOption('2k'); await aspect().selectOption('1:1');
  assert.equal(qa.requests.length, 0);
  qa.stages.push('ordinary-and-private-five-view-layout-preserved-across-K-tiers');
}

async function checkSingleGeneration() {
  const before = (await readState()).project.generationTasks.length;
  assert.equal(await generate().isEnabled(), true);
  await generate().click();
  await page.waitForFunction(({ key, count }) => { const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks; return tasks.length > count && ['succeeded', 'failed'].includes(tasks[0].status); }, { key: storageKey, count: before }, { timeout: 20_000 });
  const state = await readState(); const task = state.project.generationTasks[0];
  assert.equal(task.status, 'succeeded', task.error);
  assert.deepEqual([task.width, task.height, task.sizeOverride], [2048, 2048, true]);
  assert.equal(task.resolutionPlan.tier, '2K');
  assert.deepEqual(task.resolutionPlan.expected, { width: 2048, height: 2048 });
  assert.deepEqual(task.resolutionPlan.encoding, { kind: 'size', value: '2048x2048' });
  const imageRequests = qa.requests.filter((request) => request.url.endsWith('/images/generations'));
  assert.equal(imageRequests.length, 1); assert.equal(imageRequests[0].body.size, '2048x2048');
  const asset = state.project.assets.find((entry) => entry.id === task.resultAssetId);
  assert.deepEqual([asset.width, asset.height], [512, 512]);
  assert.deepEqual([asset.imageRequestSize.width, asset.imageRequestSize.height], [2048, 2048]);
  assert.deepEqual(asset.imageRequestSize.resolutionPlan, task.resolutionPlan);
  assert.match(task.bindingWarning, /实际返回512×512/u);
  assert.match(await page.locator('.sidebar').innerText(), /后端实际返回512×512，与请求2048×2048不同/u);
  await screenshot('ordinary-2k-request-actual-pixels-warning');
  qa.generated = { taskId: task.id, requestPixels: [task.width, task.height], tier: task.resolutionPlan.tier, encoding: task.resolutionPlan.encoding, actualPixels: [asset.width, asset.height], warning: task.bindingWarning };
  qa.stages.push('single-mocked-2K-generation-request-plan-actual-pixels-and-warning');
}

async function checkApiSettings() {
  await page.locator('.sidebar').getByRole('button', { name: /^API\s*设置$/u }).click();
  await page.getByRole('tab', { name: '图片 API', exact: true }).click();
  const protocol = page.getByRole('combobox', { name: '生图协议', exact: true });
  const specification = page.getByRole('combobox', { name: '模型分辨率规格', exact: true });
  assert.equal(await protocol.isVisible(), true); assert.equal(await specification.isVisible(), true);
  assert.deepEqual(await protocol.locator('option').evaluateAll((items) => items.map((item) => item.value)), ['openai-compatible', 'openai-images', 'gemini', 'xai']);
  const specifications = await specification.locator('option').evaluateAll((items) => items.map((item) => item.value));
  for (const value of ['auto', 'pixel-long-edge', 'gpt-image-legacy', 'gpt-image-modern', 'gemini-k', 'gemini-1k', 'grok-k']) assert.ok(specifications.includes(value));
  assert.equal(await protocol.inputValue(), 'openai-compatible'); assert.equal(await specification.inputValue(), 'pixel-long-edge');
  qa.stages.push('API-transport-protocol-and-model-resolution-profile-controls-visible');
}

async function checkUndeclaredComfyTierAdvisories() {
  const requestCount = qa.requests.length;
  await page.evaluate(({ key, origin }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const workflow = { text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } }, canvas: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } }, sampler: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['canvas', 0], seed: 1, steps: 8, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } }, output: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } } };
    state.settings.imageApi = { enabled: true, backend: 'comfyui', baseUrl: `${origin}/__qa_image_resolution__/comfy`, apiKey: '', model: 'mock-workflow', workflowJson: JSON.stringify(workflow), comfyuiWorkflows: [], activeComfyuiWorkflowId: null, imageResolutionProfile: 'auto' };
    state.settings.activeImageApiProfileId = null;
    state.settings.imagePromptRuleSetIdByBackend.comfyui = 'image-rule-openai-gpt-image';
    state.settings.imageOutputSizes.ordinary = { mode: '2k', aspect: '1:1', width: 1024, height: 1024, resolutionVersion: 1 };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin });
  await page.reload({ waitUntil: 'networkidle' }); await enter();
  assert.equal(await mode().inputValue(), '2k');
  assert.match(await sizeGroup().getByRole('status').innerText(), /未声明支持2K/u);
  assert.match(await sizeGroup().innerText(), /2048\s*×\s*2048/u);
  assert.equal(await sizeGroup().getByRole('alert').count(), 0, 'undeclared model capability is an advisory');
  assert.equal(await generate().isEnabled(), true);
  await mode().selectOption('4k');
  assert.match(await sizeGroup().getByRole('status').innerText(), /未声明支持4K/u);
  assert.match(await sizeGroup().innerText(), /4096\s*×\s*4096/u);
  assert.equal(await sizeGroup().getByRole('alert').count(), 0);
  assert.equal(await generate().isEnabled(), true);
  assert.equal(qa.requests.length, requestCount, 'changing a tier does not submit without clicking generation');
  qa.stages.push('Comfy-undeclared-2K-and-4K-show-advisory-keep-generation-enabled-and-wait-for-explicit-submit');
}

async function run() {
  await waitForCondition({ label: 'local Vite QA startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => qa.errors.push(error.stack || error.message));
  await installFixture();
  if (checkRemainingOnly) {
    await mode().selectOption('2k'); await aspect().selectOption('1:1');
  } else {
    await checkControlsAndPersistence();
    await checkFiveViewLayouts();
  }
  await checkSingleGeneration();
  await checkApiSettings();
  await checkUndeclaredComfyTierAdvisories();
  assert.deepEqual(qa.errors, [], 'unexpected browser or mock errors');
  assert.deepEqual(qa.blockedExternalRequests, [], 'the fixture must not attempt external access');
  qa.pass = true;
}

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  qa.failure = { message: error.message, stack: error.stack };
  if (page) {
    await screenshot('failure').catch(() => {});
    qa.failure.bodyText = await page.locator('body').innerText().catch(() => '');
  }
  process.exitCode = error.exitCode || 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  harness.markElectronStopping();
  await harness.stopAll().catch((error) => { qa.cleanupError = error.message; qa.pass = false; process.exitCode = 1; });
  delete qa.png;
  await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(qa, null, 2)}\n`);
  await fs.writeFile(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: qa.pass, stages: qa.stages, requestCount: qa.requests.length, screenshots: qa.screenshots, report: path.join(outputDirectory, 'report.json'), failure: qa.failure?.message }, null, 2));
