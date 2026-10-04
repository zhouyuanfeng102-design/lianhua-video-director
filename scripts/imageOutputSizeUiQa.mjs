import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Run these staged exports from the persistent Playwright Interactive REPL.
// Only a fresh browser context is used. All APIs return synthetic neutral
// color tiles, never actual ordinary/private images or real paid requests.
export const imageOutputSizeQaInventory = [
  '普通/私密的规格默认、1X、2X、比例、自定义宽高独立且重载保留',
  '实际控件产生任务尺寸与Images JSON/multipart size，不能选高清实传1024',
  '后端返回512时资产真实512、请求快照保留、结果/任务明确提醒',
  '四视图锁3:2；非法像素/后端对齐错误禁用生成且不发请求',
  'NAI规则下分类不混入Krea/Comfy，规则中心8个NAI分类可选择',
  'Comfy明确画布可覆盖，固定无关resize不变；无尺寸入口说明并阻止提交',
  '普通/私密生成后的尺寸区域、主操作和警告在固定视口内无重叠',
];
const storageKey = 'lianhua_video_director_state_v22';
const runs = new WeakMap();
const outputCard = (page) => page.locator('.image-output-card');
const sizeGroup = (page, lane = '普通') => page.getByRole('group', { name: `${lane}生图像素设置`, exact: true });
const mode = (page, lane = '普通') => page.getByRole('combobox', { name: `${lane}生图像素规格`, exact: true });
const aspect = (page, lane = '普通') => page.getByRole('combobox', { name: `${lane}生图画面比例`, exact: true });
const width = (page, lane = '普通') => page.getByRole('spinbutton', { name: `${lane}生图宽度像素`, exact: true });
const height = (page, lane = '普通') => page.getByRole('spinbutton', { name: `${lane}生图高度像素`, exact: true });
// Button's existing component uses the preflight title as its accessible name
// while disabled; its visual primary action remains the same DOM control.
const generate = (page) => page.locator('.image-generate-actions button.primary');
const readState = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const enter = async (page) => {
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  await mode(page).waitFor();
};
const selectCharacter = (page) => page.locator('.image-entity-controls select').selectOption('image-size-character');
const capture = async (page, outputDirectory, name) => {
  if (!outputDirectory) return;
  const allowed = path.resolve(import.meta.dirname, '..', 'output', 'playwright');
  const relative = path.relative(allowed, path.resolve(outputDirectory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA evidence must stay under output/playwright');
  await fs.mkdir(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, `${name}.png`);
  await page.screenshot({ path: file, scale: 'css' });
  runs.get(page).screenshots.push(file);
};

export async function installImageOutputSizeFixture(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const qa = { origin, requests: [], errors: [], stages: [], screenshots: [], png: '' };
  runs.set(page, qa);
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => qa.errors.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    qa.errors.push(`Blocked external request: ${route.request().url()}`);
    await route.abort('blockedbyclient');
  });
  await page.route('**/__image_size_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>isolated pixel QA</title><body>本地像素测试资料</body></html>' }));
  await page.route('**/__qa_image_size__/**', async (route) => {
    const request = route.request(); const url = request.url(); const bodyText = request.postData() || '';
    let body;
    try { body = JSON.parse(bodyText); } catch { body = undefined; }
    qa.requests.push({ url, method: request.method(), contentType: request.headers()['content-type'] || '', body, bodyText });
    if (url.includes('/chat/completions')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'A neutral display mannequin stands centered in a clean studio, smooth opaque blue surface, complete silhouette, soft even lighting and a plain background.' } }] }) });
    } else if (url.includes('/images/')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: qa.png.split(',')[1] }] }) });
    } else if (url.endsWith('/prompt')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ prompt_id: 'pixel-qa-job' }) });
    } else if (url.includes('/history/')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ 'pixel-qa-job': { status: { completed: true, status_str: 'success' }, outputs: { output: { images: [{ filename: 'neutral-512.png', type: 'output' }] } } } }) });
    } else if (url.includes('/view?')) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from(qa.png.split(',')[1], 'base64') });
    } else {
      qa.errors.push(`Unhandled local mock request: ${url}`);
      await route.fulfill({ status: 500, body: 'Unknown isolated test route' });
    }
  });
  await page.goto(`${origin}/__image_size_fixture.html`, { waitUntil: 'domcontentloaded' });
  qa.png = await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#4969a4'; paint.fillRect(0, 0, 512, 512); paint.fillStyle = '#d5bd79'; paint.fillRect(128, 128, 256, 256);
    const png = canvas.toDataURL('image/png');
    const reference = { id: 'image-size-reference', name: '中性色块参考图', type: 'character', role: 'character', referenceRole: 'character', referenceScope: 'general', source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: png, width: 512, height: 512, tags: ['隔离测试'], createdAt: now, updatedAt: now };
    const character = { ...state.project.characters[0], id: 'image-size-character', name: '中性测试假人', gender: '男', apparentAge: '30岁', actualAge: '30岁', height: '约180cm', race: '仿生展示假人', morphology: 'humanoid', bodyPlan: '直立展示用假人，完整光滑轮廓', appearance: '蓝色光滑不透明表面，脸部无五官细节', outfit: '中性展示外壳', signatureProps: '无', personality: '静态展示', motionHabits: '中性站姿', anchor: '蓝色光滑展示假人', negativeContinuity: '保持同一外壳', assetIds: [reference.id], nsfwProfile: { fullBody: '中性蓝色展示假人，光滑不透明表面，从头到脚完整中性站姿，只用于程序隔离测试。', provenance: 'manual' } };
    const project = { ...state.project, id: 'image-size-ui-project', name: '像素功能隔离测试', characters: [character], locations: [], props: [], assets: [reference], sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__qa_image_size__/text`, apiKey: '', model: 'neutral-mock-text' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__qa_image_size__/image`, apiKey: '', model: 'mock-image-model' };
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.privateImagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.imageOutputSizes = { ordinary: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 }, private: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 } };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    return png;
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await enter(page); await selectCharacter(page);
  return { inventory: imageOutputSizeQaInventory, fixtureProject: 'image-size-ui-project' };
}

export async function runImageOutputSizeControlsQa(page, outputDirectory) {
  const qa = runs.get(page); const initialRequests = qa.requests.length;
  assert.equal(await mode(page).inputValue(), 'default'); assert.equal(await aspect(page).isDisabled(), true);
  await mode(page).selectOption('1x'); await aspect(page).selectOption('9:16');
  assert.match(await sizeGroup(page).innerText(), /576\s*×\s*1024/u);
  await mode(page).selectOption('2x'); await aspect(page).selectOption('3:4');
  assert.match(await sizeGroup(page).innerText(), /1536\s*×\s*2048/u);
  await mode(page).selectOption('custom'); await width(page).fill('4096'); await height(page).fill('3072');
  assert.match(await sizeGroup(page).innerText(), /4096\s*×\s*3072/u);
  await width(page).fill('4097'); assert.equal(await generate(page).isDisabled(), true); assert.match(await sizeGroup(page).innerText(), /64–4096/u);
  await width(page).fill('2048'); await height(page).fill('2048'); await mode(page).selectOption('2x'); await aspect(page).selectOption('1:1');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await mode(page, '私密').inputValue(), 'default', 'private pixels start independently');
  await mode(page, '私密').selectOption('1x'); await aspect(page, '私密').selectOption('2:3');
  assert.match(await sizeGroup(page, '私密').innerText(), /1024\s*×\s*1536/u);
  await page.getByRole('button', { name: '私密四视图', exact: true }).click(); await mode(page, '私密').selectOption('2x');
  assert.equal(await aspect(page, '私密').isDisabled(), true); assert.match(await sizeGroup(page, '私密').innerText(), /3072\s*×\s*2048.*3:2/u);
  await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密全身', exact: true }).click();
  await mode(page, '私密').selectOption('custom'); await width(page, '私密').fill('1536'); await height(page, '私密').fill('2048');
  await capture(page, outputDirectory, 'private-custom-pixels');
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(await mode(page).inputValue(), '2x'); assert.equal(await aspect(page).inputValue(), '1:1');
  await capture(page, outputDirectory, 'ordinary-2x-pixels');
  await page.waitForFunction((key) => { const prefs = JSON.parse(localStorage.getItem(key)).settings.imageOutputSizes; return prefs.ordinary.mode === '2x' && prefs.private.width === 1536 && prefs.private.height === 2048; }, storageKey);
  await page.reload({ waitUntil: 'networkidle' }); await enter(page); await selectCharacter(page);
  assert.equal(await mode(page).inputValue(), '2x'); assert.equal(await aspect(page).inputValue(), '1:1');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.equal(await mode(page, '私密').inputValue(), 'custom'); assert.equal(await width(page, '私密').inputValue(), '1536'); assert.equal(await height(page, '私密').inputValue(), '2048');
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(qa.requests.length, initialRequests, 'pixel controls never call a model');
  qa.stages.push('independent-size-controls-invalid-input-fixed-layout-and-reload');
  return { stage: qa.stages.at(-1), requests: qa.requests.length };
}

async function generateAndAssert(page, expected, privateLane = false) {
  const before = (await readState(page)).project.generationTasks.length;
  await generate(page).click();
  await page.waitForFunction(({ key, count }) => {
    const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks;
    return tasks.length > count && ['succeeded', 'failed'].includes(tasks[0].status);
  }, { key: storageKey, count: before });
  const state = await readState(page); const task = state.project.generationTasks[0];
  assert.equal(task.status, 'succeeded', task.error);
  assert.deepEqual([task.width, task.height, task.sizeOverride], [...expected, true]);
  assert.equal(task.referenceScope, privateLane ? 'nsfw-private-profile' : 'general');
  const asset = state.project.assets.find((entry) => entry.id === task.resultAssetId);
  assert.deepEqual([asset.width, asset.height], [512, 512]);
  assert.deepEqual([asset.imageRequestSize.width, asset.imageRequestSize.height, asset.imageRequestSize.sizeOverride], [...expected, true]);
  assert.match(task.bindingWarning, /实际返回512×512/u);
  assert.match(await outputCard(page).innerText(), /实际 512×512/u);
  return task;
}

export async function runImageOutputSizeGenerationQa(page, outputDirectory) {
  const qa = runs.get(page);
  const ordinary = await generateAndAssert(page, [2048, 2048]);
  const jsonRequest = qa.requests.find((request) => request.url.includes('/images/generations'));
  assert.equal(jsonRequest.body.size, '2048x2048');
  await capture(page, outputDirectory, 'ordinary-actual-512-requested-2048');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  const privateTask = await generateAndAssert(page, [1536, 2048], true);
  const privateRequest = qa.requests.filter((request) => request.url.includes('/images/generations')).at(-1);
  assert.equal(privateRequest.body.size, '1536x2048');
  await capture(page, outputDirectory, 'private-actual-512-requested-1536x2048');
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  await outputCard(page).getByRole('button', { name: '从资产库选择', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '从资产库选择参考图', exact: true });
  await picker.getByRole('button', { name: /中性色块参考图/u }).click(); await picker.getByRole('button', { name: '使用所选图片', exact: true }).click();
  await page.getByRole('checkbox', { name: '将当前普通图片作为本次图生图参考', exact: true }).check();
  await generateAndAssert(page, [2048, 2048]);
  const edit = qa.requests.find((request) => request.url.includes('/images/edits'));
  assert.match(edit.contentType, /multipart\/form-data/u); assert.match(edit.bodyText, /name="size"\r?\n\r?\n2048x2048/u); assert.match(edit.bodyText, /name="image\[\]"/u);
  const taskIds = [ordinary.id, privateTask.id];
  await page.reload({ waitUntil: 'networkidle' });
  const restored = await readState(page);
  for (const id of taskIds) assert.equal(restored.project.generationTasks.find((task) => task.id === id).sizeOverride, true);
  await enter(page); await selectCharacter(page);
  qa.stages.push('ordinary-private-json-multipart-real-pixel-metadata-and-reload');
  return { stage: qa.stages.at(-1), images: qa.requests.filter((request) => request.url.includes('/images/')).map((request) => ({ url: request.url, size: request.body?.size || 'multipart:2048x2048' })) };
}

export async function stageImageSizeBackend(page, backend, withCanvas = true) {
  await page.evaluate(({ key, backend, withCanvas }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const workflow = { text: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } }, canvas: { class_type: 'EmptyLatentImage', inputs: withCanvas ? { width: 512, height: 512 } : { width: ['size', 0], height: ['size', 1] } }, sampler: { class_type: 'KSampler', inputs: { positive: ['text', 0], latent_image: ['canvas', 0] } }, output: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } }, referenceResize: { class_type: 'ImageScale', inputs: { width: 320, height: 240 } } };
    state.settings.imageApi = { ...state.settings.imageApi, enabled: true, backend, baseUrl: `${location.origin}/__qa_image_size__/${backend === 'comfyui' ? 'comfy' : 'image'}`, model: backend === 'novelai' ? 'nai-diffusion-4-5-full' : 'mock-image-model', apiKey: '', workflowJson: backend === 'comfyui' ? JSON.stringify(workflow) : undefined, comfyuiWorkflows: [], activeComfyuiWorkflowId: null };
    state.settings.imagePromptRuleSetIdByBackend[backend] = backend === 'novelai' ? 'image-rule-novelai' : 'image-rule-openai-gpt-image';
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, backend, withCanvas });
  await page.reload({ waitUntil: 'networkidle' }); await enter(page); await selectCharacter(page);
}

export async function runImageOutputSizeComfyQa(page, outputDirectory) {
  const qa = runs.get(page);
  await stageImageSizeBackend(page, 'comfyui', false);
  const initialRequests = qa.requests.length;
  assert.equal(await generate(page).isDisabled(), true); assert.match(await sizeGroup(page).innerText(), /没有可确认的生成尺寸入口/u);
  await capture(page, outputDirectory, 'comfy-no-pixel-input');
  await mode(page).selectOption('default'); assert.equal(await generate(page).isEnabled(), true);
  await mode(page).selectOption('2x'); assert.equal(await generate(page).isDisabled(), true);
  assert.equal(qa.requests.length, initialRequests);
  await stageImageSizeBackend(page, 'comfyui', true);
  assert.equal(await generate(page).isEnabled(), true);
  const before = (await readState(page)).project.generationTasks.length;
  await generate(page).click();
  await page.waitForFunction(({ key, count }) => { const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks; return tasks.length > count && ['succeeded', 'failed'].includes(tasks[0].status); }, { key: storageKey, count: before });
  const state = await readState(page); assert.equal(state.project.generationTasks[0].status, 'succeeded', state.project.generationTasks[0].error);
  const submitted = qa.requests.filter((request) => request.url.endsWith('/prompt')).at(-1).body;
  assert.deepEqual([submitted.prompt.canvas.inputs.width, submitted.prompt.canvas.inputs.height], [2048, 2048]);
  assert.deepEqual([submitted.prompt.referenceResize.inputs.width, submitted.prompt.referenceResize.inputs.height], [320, 240]);
  await capture(page, outputDirectory, 'comfy-overridden-pixels');
  qa.stages.push('comfy-unsupported-preflight-default-fallback-and-supported-real-payload');
  return { stage: qa.stages.at(-1), requestPixels: [submitted.prompt.canvas.inputs.width, submitted.prompt.canvas.inputs.height] };
}

export async function runImageOutputSizeRulesQa(page, outputDirectory) {
  const qa = runs.get(page); const initialRequests = qa.requests.length;
  await stageImageSizeBackend(page, 'novelai');
  const rule = page.locator('.image-prompt-selection-grid select').nth(0); const preset = page.locator('.image-prompt-selection-grid select').nth(1);
  assert.equal(await rule.inputValue(), 'image-rule-novelai');
  assert.doesNotMatch(await preset.innerText(), /Krea|Comfy/iu); assert.match(await preset.innerText(), /NovelAI/u);
  const naiCharacterOptions = await preset.locator('option').evaluateAll((options) => options.filter((option) => /NovelAI/u.test(option.textContent)).map((option) => option.value));
  for (const value of naiCharacterOptions) { await preset.selectOption(value); assert.equal(await preset.inputValue(), value); }
  await mode(page).selectOption('custom'); await width(page).fill('2050'); await height(page).fill('2048');
  assert.equal(await generate(page).isDisabled(), true); assert.match(await sizeGroup(page).innerText(), /64的倍数/u);
  await width(page).fill('2048'); assert.equal(await generate(page).isEnabled(), true);
  await capture(page, outputDirectory, 'nai-compatible-presets-and-pixels');
  await page.locator('.sidebar').getByRole('button', { name: '规则中心', exact: true }).click();
  await page.getByRole('button', { name: /^生图分类预设/u }).click();
  const entries = page.locator('.list-item').filter({ hasText: 'NovelAI / NAI' });
  assert.equal(await entries.count(), 8, 'all eight NAI category presets are visible and selectable');
  const names = [];
  for (let index = 0; index < 8; index += 1) { const entry = entries.nth(index); names.push(await entry.locator('.list-item-title').innerText()); await entry.click(); assert.match(await entry.getAttribute('class'), /selected/u); }
  assert.equal(qa.requests.length, initialRequests, 'rule/pixel validation controls do not issue model calls');
  qa.stages.push('nai-eight-selectable-categories-compatible-filter-and-alignment');
  return { stage: qa.stages.at(-1), names };
}

export async function runImageOutputSizeVisualExploratoryQa(page, outputDirectory) {
  const qa = runs.get(page); const initialRequests = qa.requests.length;
  await stageImageSizeBackend(page, 'openai'); await page.setViewportSize({ width: 1280, height: 800 });
  await mode(page).selectOption('custom'); await width(page).fill('1000.5');
  assert.equal(await width(page).inputValue(), '1000.5', 'fractional custom input must not be silently rounded');
  assert.equal(await generate(page).isDisabled(), true);
  await width(page).fill('2048'); await height(page).fill('2048');
  await mode(page).selectOption('2x');
  await page.getByRole('group', { name: '选择普通生图画面规格', exact: true }).getByRole('button', { name: '四视图', exact: true }).click();
  assert.equal(await aspect(page).isDisabled(), true); assert.match(await sizeGroup(page).innerText(), /3072\s*×\s*2048/u);
  await sizeGroup(page).locator('summary').click(); await capture(page, outputDirectory, 'explore-fourview-details-1280'); await sizeGroup(page).locator('summary').click();
  const tabs = page.locator('.image-asset-kind-tabs');
  assert.deepEqual((await tabs.getByRole('button').allTextContents()).map((text) => text.trim()), ['人物角色', '场景', '物品', '分镜图']);
  assert.equal(await tabs.getByRole('button', { name: '九宫格', exact: true }).count(), 0, 'retired grid creation is not an image-workbench category');
  assert.equal(await page.locator('.grid-workbench-guide').count(), 0, 'retired grid creation/binding guide stays absent');
  for (const kind of ['场景', '物品']) {
    await tabs.getByRole('button', { name: kind, exact: true }).click();
    assert.equal(await mode(page).inputValue(), '2x', 'ordinary pixel preferences also persist across asset categories');
    assert.equal(await page.getByRole('tab', { name: '私密生图', exact: true }).isDisabled(), true);
  }
  await tabs.getByRole('button', { name: '人物角色', exact: true }).click(); await selectCharacter(page);
  const layouts = [];
  for (const lane of ['普通', '私密']) {
    await page.getByRole('tab', { name: `${lane}生图`, exact: true }).click();
    if (lane === '私密') { assert.equal(await mode(page, lane).inputValue(), 'custom'); assert.equal(await width(page, lane).inputValue(), '1536'); assert.equal(await height(page, lane).inputValue(), '2048'); }
    const layout = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      regions: [...document.querySelectorAll('.image-output-size-controls,.image-generate-actions,.image-generation-mode-tabs,.image-output-card h2')].map((element) => {
        const box = element.getBoundingClientRect();
        return { className: element.className, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      }),
    }));
    assert.deepEqual([...layout.document], [...layout.viewport]);
    for (const box of layout.regions) { assert.ok(box.x >= 0 && box.y >= 0 && box.right <= 1280 && box.bottom <= 800 && box.width > 0 && box.height > 0, `${lane} ${box.className} must fit without clipping`); }
    const sizeBox = layout.regions.find((box) => box.className.includes('image-output-size-controls'));
    const actionBox = layout.regions.find((box) => box.className.includes('image-generate-actions'));
    assert.ok(sizeBox && actionBox && sizeBox.bottom <= actionBox.y, 'pixel controls must not overlap primary actions');
    await capture(page, outputDirectory, `compact-${lane === '普通' ? 'ordinary' : 'private'}-1280`); layouts.push({ lane, ...layout });
  }
  assert.equal(qa.requests.length, initialRequests, 'exploratory toggles and invalid inputs stay local');
  qa.stages.push('exploratory-fractional-input-category-switch-roundtrip-and-1280-fit');
  return { stage: qa.stages.at(-1), layouts };
}

export function imageOutputSizeQaReport(page) {
  const qa = runs.get(page);
  assert.deepEqual(qa.errors, []);
  return { inventory: imageOutputSizeQaInventory, stages: qa.stages, screenshots: qa.screenshots, mockedRequests: qa.requests.length, externalRequests: 0, errors: qa.errors };
}
