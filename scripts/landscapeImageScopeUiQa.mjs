import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the actual App, converter service and image adapter. Everything in
// this browser profile is synthetic; no production state or paid API is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `landscape-image-scope-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Landscape QA evidence must stay below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'landscape image scope UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const marker = '[LANDSCAPE_ENVIRONMENT_V1]';
const storySentinel = 'QA_FULL_STORY_TITLE_SENTINEL';
const dossierSentinel = 'QA_CHARACTER_DOSSIER_SENTINEL';
const sceneStyle = '水彩手绘，纸张纹理与青绿色晕染';
const oldPrompt = 'QA_OLD_POLLUTED_PROMPT: a named traveler opens the door in a four panel storyboard with character closeups.';
const landscapeReply = 'A single continuous empty conservatory interior, tall arched windows on the left, pale limestone floor, fixed wooden benches, green foliage along the glass walls, cool dawn light and soft long shadows. An unoccupied environment with no people, silhouettes, reflections of people, text or panels.';
const narrativeReply = 'A traveler in a blue coat stands beside the wooden bench in a glass conservatory, facing the arched doorway, with pale stone tiles underfoot and cool dawn light entering from the left. One coherent single frame with stable spatial depth and a clear visible pose.';
let browser; let context; let page; let png = '';
const requests = []; const errors = []; const blockedRequests = []; const checks = []; const screenshots = []; const layouts = [];
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const textRequests = () => requests.filter((entry) => entry.type === 'converter');
const imageRequests = () => requests.filter((entry) => entry.type === 'image');
const enterImages = async () => { await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click(); };
const enterTasks = async () => { await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click(); };
const awaitNewResult = async (previousIds) => {
  await page.waitForFunction(({ key, previousIds }) => {
    const state = JSON.parse(localStorage.getItem(key));
    return state.project.generationTasks.some((task) => !previousIds.includes(task.id) && ['succeeded', 'failed'].includes(task.status));
  }, { key: storageKey, previousIds }, { timeout: 25_000 });
  const task = (await readState()).project.generationTasks.find((entry) => !previousIds.includes(entry.id));
  assert.equal(task.status, 'succeeded', task.error); assert.ok(task.resultAssetId, 'successful generation owns a saved result asset');
  return task;
};
const assertConversion = (entry, landscape) => {
  assert.ok(entry, 'exactly one captured converter request is available');
  assert.equal(entry.system.includes(marker), landscape, 'requested image variant controls environment contract');
  if (landscape) {
    assert.match(entry.system, /无人|空镜/u);
    assert.doesNotMatch(entry.system, /输入资料中的 gender、性别设定/u, 'landscape route has no generic character identity protocol');
    assert.ok(!entry.user.includes(storySentinel), 'full project story is not sent to landscape converter');
    assert.ok(!entry.user.includes(dossierSentinel), 'character dossier is not sent to landscape converter');
    assert.ok(!entry.user.includes('独立身份来源资料'), 'landscape has no independent identity evidence channel');
  } else {
    assert.match(entry.system, /具名身份/u, 'narrative variants retain character identity mode');
    assert.ok(entry.user.includes(storySentinel), 'narrative variants retain source story evidence');
    assert.ok(entry.user.includes('独立身份来源资料'), 'narrative variants retain independent identity evidence');
  }
};
const generateVariant = async (label, variant) => {
  await page.getByRole('group', { name: '选择普通生图画面规格', exact: true }).getByRole('button', { name: label, exact: true }).click();
  const previousIds = (await readState()).project.generationTasks.map((task) => task.id);
  const textBefore = textRequests().length; const imageBefore = imageRequests().length;
  await page.locator('.image-generate-actions button.primary').click();
  const task = await awaitNewResult(previousIds);
  assert.equal(task.assetKind, 'location'); assert.equal(task.imageVariant, variant);
  assert.equal(textRequests().length, textBefore + 1); assert.equal(imageRequests().length, imageBefore + 1);
  assertConversion(textRequests().at(-1), variant === 'landscape');
  assert.ok(textRequests().at(-1).user.includes(sceneStyle), 'the selected scene style reaches the actual converter request');
  assert.ok(task.conversionSource.includes(sceneStyle), 'task snapshot retains the selected scene style for retries');
  const expected = variant === 'landscape' ? landscapeReply : narrativeReply;
  assert.equal(task.prompt, expected); assert.equal(imageRequests().at(-1).body.prompt, expected, 'image model receives converted prompt, not raw fields');
  assert.equal(Boolean(task.conversionIdentityContext?.includes(storySentinel)), variant !== 'landscape');
  checks.push(`${label}: correct converter scope, isolated evidence, final prompt forwarded once to image model`);
  return task;
};
const run = async () => {
  await waitForCondition({ label: 'landscape QA Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('crash', () => errors.push('renderer crashed'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__landscape_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><title>Isolated landscape QA</title><body>Synthetic fixture</body></html>' }));
  await page.route('**/__qa_landscape__/**', async (route) => {
    const request = route.request(); const url = request.url(); const body = request.postDataJSON();
    if (url.includes('/chat/completions')) {
      const system = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
      const user = body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
      requests.push({ type: 'converter', url, method: request.method(), system, user });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: system.includes(marker) ? landscapeReply : narrativeReply } }] }) });
    } else if (url.includes('/images/generations')) {
      requests.push({ type: 'image', url, method: request.method(), body });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) });
    } else {
      errors.push(`Unexpected synthetic mock request ${url}`); await route.fulfill({ status: 500, body: 'Unknown isolated route' });
    }
  });
  await page.goto(`${origin}/__landscape_fixture.html`, { waitUntil: 'domcontentloaded' });
  png = await page.evaluate(async ({ key, origin, storySentinel, dossierSentinel, oldPrompt }) => {
    const { createInitialState } = await import('/src/storage.ts'); const state = createInitialState(); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#bacbbb'; paint.fillRect(0, 0, 512, 512); paint.fillStyle = '#748972'; paint.fillRect(128, 32, 128, 448);
    const png = canvas.toDataURL('image/png');
    const character = { ...state.project.characters[0], id: 'scope-character', name: '蓝衣旅人', appearance: `${dossierSentinel} 中性蓝衣、完整身形`, anchor: '蓝色长外套', assetIds: [] };
    const location = { id: 'scope-location', name: '晨光玻璃温室', description: '高挑拱窗与浅色石地板，左窗外有树木，窗边固定长凳。', timeWeather: '晴朗清晨', lighting: '左窗冷色晨光', palette: '浅灰与翠绿', fixedProps: '木制固定长凳与墙边绿植', anchor: '蓝衣旅人推门走进温室并坐在长凳上；连续动作依次发生，之后向窗外挥手。QA_MIXED_ANCHOR_RETAINED', assetIds: ['legacy-landscape-asset'] };
    const asset = { id: 'legacy-landscape-asset', name: '旧污染风景图片', type: 'location', role: 'scene', referenceRole: 'scene', referenceScope: 'general', source: 'generated', mediaType: 'image', mimeType: 'image/png', dataUrl: png, width: 512, height: 512, tags: ['合成测试'], prompt: oldPrompt, imageVariant: 'landscape', createdAt: now - 1000, updatedAt: now - 1000 };
    const task = { id: 'legacy-landscape-task', kind: 'image', name: '旧污染风景任务', assetKind: 'location', imageVariant: 'landscape', status: 'succeeded', prompt: oldPrompt, width: 1024, height: 1024,
      backend: 'openai', model: 'mock-image', sourceEntityId: location.id, referenceScope: 'general', imagePromptFormat: 'natural-language',
      conversionSource: '旧地点资料：高挑玻璃温室、石地板与固定长凳。蓝衣旅人走入画面，然后坐下，四格连续分镜。',
      conversionIdentityContext: `${storySentinel}: 旧任务混入的完整故事与人物资料 ${dossierSentinel}`,
      converterSystemPrompt: '旧场景规则：允许有人物活动，保留连续故事与人物站位。', primaryReferenceAssetIds: [], referenceAssetIds: [], resultAssetId: asset.id, createdAt: now - 1000, updatedAt: now - 1000 };
    const project = { ...state.project, id: 'landscape-scope-ui-project', name: '风景范围隔离测试', description: '环境/剧情图片用途隔离测试',
      characters: [character], locations: [location, { ...location, id: 'other-location', name: '另一处庭院', visualStyle: '水墨幻想', assetIds: [] }], props: [], assets: [asset], storyDraft: { name: '未保存故事草稿', content: '蓝衣旅人在玻璃温室与另一名旅人交谈。', updatedAt: now },
      sourceDocuments: [{ id: 'scope-source', name: storySentinel, content: '蓝衣旅人推门进入温室，坐在长凳上看书，再起身望向窗外；这是人物剧情，不能作为无人环境图的出镜名单。', createdAt: now, updatedAt: now }],
      scenes: [], storyboards: [], sequencePlans: [], generationTasks: [task], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__qa_landscape__/text`, apiKey: '', model: 'synthetic-converter' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__qa_landscape__/image`, apiKey: '', model: 'synthetic-image' };
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null; state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); return png;
  }, { key: storageKey, origin, storySentinel, dossierSentinel, oldPrompt });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterImages();
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '场景', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('scope-location');
  const style = page.getByRole('textbox', { name: '视觉风格', exact: true });
  const preset = page.getByRole('combobox', { name: '视觉风格预设', exact: true });
  const inheritedStyle = await style.inputValue();
  assert.ok(inheritedStyle, 'legacy scenes initially inherit the director visual style');
  const saveStyle = async (value) => {
    await page.getByRole('button', { name: '保存当前实体资料', exact: true }).click();
    await waitForCondition({ label: 'scene visual style saved', timeoutMs: 15_000, intervalMs: 100,
      check: async () => (await readState()).project.locations.find((entry) => entry.id === 'scope-location')?.visualStyle === value });
    assert.equal(await style.inputValue(), value);
  };
  await preset.selectOption('动画电影'); await saveStyle('动画电影');
  await page.locator('.image-entity-controls select').selectOption('other-location');
  assert.equal(await style.inputValue(), '水墨幻想');
  await page.locator('.image-entity-controls select').selectOption('scope-location');
  assert.equal(await style.inputValue(), '动画电影', 'saved scene preset is not overwritten by director inheritance');
  await preset.selectOption(''); await saveStyle('');
  await page.reload({ waitUntil: 'networkidle' }); await enterImages();
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '场景', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('scope-location');
  assert.equal(await style.inputValue(), '', 'no-preset choice survives reload');
  await style.fill(sceneStyle); await saveStyle(sceneStyle);
  await page.reload({ waitUntil: 'networkidle' }); await enterImages();
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '场景', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('scope-location');
  assert.equal(await style.inputValue(), sceneStyle); assert.equal(await preset.inputValue(), sceneStyle);
  checks.push('Scene style preset, custom text and no-preset choice persist across selection and reload; legacy scenes inherit the director style');
  const initial = await readState(); const baseline = initial.project; const baselineRules = initial.imagePromptRules;
  const first = await generateVariant('风景场景', 'landscape');
  await generateVariant('故事快照', 'snapshot'); await generateVariant('分镜首帧', 'first-frame');
  const last = await generateVariant('风景场景', 'landscape');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const metrics = await page.getByRole('group', { name: '选择普通生图画面规格', exact: true }).evaluate((group) => ({
      viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
      labels: [...group.querySelectorAll('button')].map((button) => { const r = button.getBoundingClientRect(); return { text: button.textContent, left: r.left, right: r.right }; }),
    }));
    assert.ok(metrics.scrollWidth <= viewport.width); assert.ok(metrics.labels.every((label) => label.left >= 0 && label.right <= viewport.width)); layouts.push(metrics);
    const file = `landscape-workbench-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(output, file), fullPage: false }); screenshots.push(file);
  }
  await enterTasks();
  const regenerate = async (id, expectConversion) => {
    const previousIds = (await readState()).project.generationTasks.map((task) => task.id);
    const textBefore = textRequests().length; const imageBefore = imageRequests().length;
    await page.locator(`#image-task-${id} .image-regenerate-button`).click();
    const task = await awaitNewResult(previousIds);
    assert.equal(textRequests().length, textBefore + Number(expectConversion), 'legacy scope repair converts once; current scope reuses final prompt');
    assert.equal(imageRequests().length, imageBefore + 1);
    assert.equal(task.prompt, landscapeReply); assert.equal(imageRequests().at(-1).body.prompt, landscapeReply);
    assert.ok(task.converterSystemPrompt.includes(marker));
    assert.ok(!task.conversionIdentityContext?.includes(storySentinel));
    if (expectConversion) assertConversion(textRequests().at(-1), true);
    return task;
  };
  const repaired = await regenerate('legacy-landscape-task', true);
  assert.equal(repaired.regenerationRootTaskId, 'legacy-landscape-task');
  checks.push('Legacy polluted landscape regeneration performs a new environment conversion and never reuses its old character storyboard prompt');
  await regenerate(last.id, false);
  checks.push('Current-contract landscape regeneration reuses its valid converted environment prompt without another text call');
  const assertPreserved = (project) => {
    assert.deepEqual(project.generationTasks.find((task) => task.id === 'legacy-landscape-task'), baseline.generationTasks.find((task) => task.id === 'legacy-landscape-task'));
    assert.deepEqual(project.assets.find((asset) => asset.id === 'legacy-landscape-asset'), baseline.assets.find((asset) => asset.id === 'legacy-landscape-asset'));
    const location = project.locations.find((entry) => entry.id === 'scope-location'); const original = baseline.locations[0];
    assert.deepEqual({ ...location, assetIds: [] }, { ...original, assetIds: [] }); assert.ok(location.assetIds.includes('legacy-landscape-asset'));
    assert.deepEqual(project.locations[1], baseline.locations[1], 'saving scene style never changes another scene');
    assert.deepEqual(project.characters, baseline.characters); assert.deepEqual(project.sourceDocuments, baseline.sourceDocuments); assert.deepEqual(project.storyDraft, baseline.storyDraft);
    assert.equal(project.generationTasks.length, 7); assert.equal(project.assets.length, 7);
    for (const task of project.generationTasks.filter((task) => task.id !== 'legacy-landscape-task')) assert.equal(task.status, 'succeeded');
  };
  assertPreserved((await readState()).project); assert.deepEqual((await readState()).imagePromptRules, baselineRules);
  await page.reload({ waitUntil: 'networkidle' }); await enterTasks(); assertPreserved((await readState()).project);
  assert.deepEqual((await readState()).imagePromptRules, baselineRules, 'generation and legacy repair never rewrite saved rules');
  await page.locator(`#image-task-${first.id}`).waitFor();
  checks.push('Original mixed location notes, character records, story, legacy task and old image are unchanged; all six new results survive reload');
  assert.equal(textRequests().length, 5); assert.equal(imageRequests().length, 6); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'landscape-regenerated-tasks.png'), fullPage: false }); screenshots.push('landscape-regenerated-tasks.png');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true,
    converterRequests: textRequests().length, imageRequests: imageRequests().length, checks, layouts, screenshots, errors, blockedRequests,
    evidence: textRequests().map((entry) => ({ landscape: entry.system.includes(marker), sourceStoryIncluded: entry.user.includes(storySentinel), identityEvidenceIncluded: entry.user.includes('独立身份来源资料') })) }, null, 2));
  fs.writeFileSync(path.join(output, 'synthetic-requests.json'), JSON.stringify(requests, null, 2));
  console.log(`Landscape image scope UI QA passed. Report: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blockedRequests, requests, state: page ? await readState().catch(() => null) : null, error: String(error), stack: error?.stack }, null, 2)); throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
