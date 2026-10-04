import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App, a new non-persistent browser context, synthetic neutral fixtures,
// and loopback mocks only. Never reads desktop data or calls a paid provider.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `private-image-api-picker-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse a link');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'private-image API picker isolated UI', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'private-image-api-picker-isolated-project';
const characterId = 'private-image-api-picker-neutral-character';
const prefix = '/__private_image_api_qa__';
const keys = { default: 'QA_DEFAULT_SENTINEL_NO_REAL_CREDENTIAL', a: 'QA_ALPHA_SENTINEL_NO_REAL_CREDENTIAL', b: 'QA_BETA_SENTINEL_NO_REAL_CREDENTIAL', renewedB: 'QA_RENEWED_BETA_SENTINEL_NO_REAL_CREDENTIAL' };
const errors = []; const consoleMessages = []; const blockedRequests = []; const requests = []; const steps = []; const screenshots = []; const layoutChecks = [];
let browser; let context; let page; let png = ''; let holdFirst = true; let releaseFirst; let failedB = false; let fixtureCredentialB = keys.b;
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); };
const selector = () => page.getByRole('combobox', { name: '私密生图 API 配置', exact: true });
const generate = () => page.locator('.image-generate-actions button.primary');
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const protectedSettings = (state) => ({ imageApi: state.settings.imageApi, imageApiProfiles: state.settings.imageApiProfiles, activeImageApiProfileId: state.settings.activeImageApiProfileId });
const enterWorkbench = async (privateLane = true) => {
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption(characterId);
  if (privateLane) await page.getByRole('tab', { name: '私密生图', exact: true }).click();
};
const waitForTaskCount = async (count, settled = false) => page.waitForFunction(({ key, count, settled }) => {
  const tasks = JSON.parse(localStorage.getItem(key))?.project.generationTasks;
  return tasks?.length === count && (!settled || tasks.every((task) => ['succeeded', 'failed'].includes(task.status)));
}, { key: storageKey, count, settled }, { timeout: 20_000 });
const waitForSelection = async (id) => page.waitForFunction(({ key, id }) => (JSON.parse(localStorage.getItem(key))?.settings.privateImageApiProfileId || '') === id, { key: storageKey, id });
const imageRequests = () => requests.filter((item) => item.kind === 'image');
const assertNoCredentialsInUi = async () => {
  const content = await page.locator('body').innerHTML();
  for (const value of Object.values(keys)) {
    assert.equal(content.includes(value), false, 'API credentials must not enter the picker or DOM');
    assert.equal(consoleMessages.some((line) => line.includes(value)), false, 'API credentials must not enter browser logs');
  }
};
const mutateFixture = async (edit, data) => {
  // Unmount before changing storage so React autosave cannot race this fixture.
  await page.goto(`${origin}/__private_image_api_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, source, data, credentialKeys }) => {
    const state = JSON.parse(localStorage.getItem(key));
    // The function string below is authored in this test, never read from data.
    const update = new Function('state', 'data', `return (${source})(state, data);`);
    update(state, data);
    // Browser caches intentionally redact API keys. The desktop normally loads
    // them from its full protected state; this browser-only fixture restores
    // synthetic tokens only, so refresh tests can also check actual routing.
    for (const config of [state.settings.imageApi, ...state.settings.imageApiProfiles]) {
      const lane = config.baseUrl.split('/').at(-1);
      if (credentialKeys[lane]) config.apiKey = credentialKeys[lane];
    }
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, source: edit.toString(), data, credentialKeys: { ...keys, b: fixtureCredentialB } });
  await page.goto(origin, { waitUntil: 'networkidle' });
};
const assertLayout = async (width, height, label = 'private-picker') => {
  await page.setViewportSize({ width, height }); await selector().scrollIntoViewIfNeeded();
  const metrics = await selector().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const card = element.closest('.image-output-card'); const cardRect = card?.getBoundingClientRect();
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height,
      card: cardRect ? { left: cardRect.left, right: cardRect.right, width: cardRect.width, scrollWidth: card.scrollWidth } : null };
  });
  assert.ok(metrics.documentWidth <= width + 1, `${width}×${height}: no horizontal document overflow`);
  assert.ok(metrics.left >= -1 && metrics.right <= width + 1 && metrics.height > 20, `${width}×${height}: picker fits screen`);
  assert.ok(metrics.top >= -1 && metrics.bottom <= height + 1, `${width}×${height}: picker is reachable`);
  if (metrics.card) assert.ok(metrics.left >= metrics.card.left - 1 && metrics.right <= metrics.card.right + 1, 'picker must remain in output card');
  layoutChecks.push({ label, viewport: `${width}×${height}`, ...metrics }); await capture(`${label}-${width}x${height}`);
};

async function run() {
  await waitForCondition({ label: 'private API QA Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith(`${prefix}/`))) {
      blockedRequests.push({ path: url.pathname, method: request.method() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__private_image_api_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>私密生图API隔离验证</title><body>仅隔离测试</body></html>' }); return;
    }
    if (!url.pathname.startsWith(`${prefix}/`)) { await route.continue(); return; }
    let body; try { body = JSON.parse(request.postData() || '{}'); } catch { body = {}; }
    const lane = url.pathname.split('/')[2];
    if (url.pathname.endsWith('/chat/completions')) {
      requests.push({ kind: 'text', path: url.pathname, model: body.model });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'A neutral adult display mannequin centered in a clean studio, complete single full-body silhouette, smooth opaque blue surface, soft even lighting, plain background.' } }] }) }); return;
    }
    if (url.pathname.includes('/images/')) {
      const authorization = (await request.allHeaders()).authorization || '';
      requests.push({ kind: 'image', path: url.pathname, lane, model: body.model, keyMatches: authorization === `Bearer ${lane === 'b' && authorization.includes(keys.renewedB) ? keys.renewedB : keys[lane]}` });
      if (lane === 'a' && holdFirst) { holdFirst = false; await new Promise((resolve) => { releaseFirst = resolve; }); }
      if (lane === 'b' && !failedB) {
        failedB = true; await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: '隔离测试：本次B图片失败，请手动重试' } }) }); return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) }); return;
    }
    blockedRequests.push({ path: url.pathname, method: request.method() }); await route.abort('blockedbyclient');
  });
  await page.goto(`${origin}/__private_image_api_fixture.html`, { waitUntil: 'domcontentloaded' });
  png = await page.evaluate(async ({ key, origin, prefix, keys, projectId, characterId }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#526db4'; paint.fillRect(0, 0, 64, 64); paint.fillStyle = '#e5cb7a'; paint.fillRect(16, 16, 32, 32);
    const character = { id: characterId, name: '中性展示假人', gender: '男', apparentAge: '30岁成年', actualAge: '30岁成年', height: '180cm', race: '仿生展示假人', morphology: 'humanoid', bodyPlan: '中性展示人台完整结构', appearance: '中性蓝色不透明表面，固定面容', outfit: '中性不透明展示外壳', signatureProps: '无', personality: '静态展示', motionHabits: '中性站姿', anchor: '同一中性展示人台', negativeContinuity: '', assetIds: [], nsfwProfile: { fullBody: '中性蓝色展示人台的完整光滑不透明外壳，仅用于程序隔离测试。', provenance: 'manual' } };
    const project = { ...state.project, id: projectId, name: '私密API切换隔离验证', characters: [character], locations: [], props: [], assets: [], sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}${prefix}/text`, apiKey: '', model: 'fixture-text-converter' };
    const config = (lane) => ({ enabled: true, backend: 'openai', baseUrl: `${origin}${prefix}/${lane}`, apiKey: keys[lane], model: `fixture-image-${lane}`, size: '1024x1024', quality: 'standard' });
    state.settings.imageApi = config('default');
    state.settings.imageApiProfiles = [
      { ...config('default'), id: 'qa-image-default', name: '普通默认配置', createdAt: now, updatedAt: now },
      { ...config('a'), id: 'qa-image-a', name: '配置A·私密快捷生成·长名称布局验证', createdAt: now, updatedAt: now },
      { ...config('b'), id: 'qa-image-b', name: '配置B·另一个图片模型', createdAt: now, updatedAt: now },
    ];
    state.settings.activeImageApiProfileId = 'qa-image-default'; state.settings.privateImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.privateImagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.imageOutputSizes = { ordinary: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 }, private: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 } };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    return canvas.toDataURL('image/png');
  }, { key: storageKey, origin, prefix, keys, projectId, characterId });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterWorkbench();
  assert.equal(await selector().inputValue(), '');
  assert.match(await selector().innerText(), /跟随/u);
  const initialProtected = protectedSettings(await stored());
  assert.equal(initialProtected.imageApi.apiKey, '', 'browser mirror continues to redact credentials');
  await selector().selectOption('qa-image-a'); await waitForSelection('qa-image-a');
  assert.deepEqual(protectedSettings(await stored()), initialProtected, 'private choice cannot mutate global API/current profile or saved profile contents');
  assert.equal(requests.length, 0, 'changing API selection is not an API call');
  await assertNoCredentialsInUi(); await assertLayout(1280, 800); await assertLayout(1120, 720);
  await page.locator('.sidebar').getByRole('button', { name: '项目总览', exact: true }).click(); await enterWorkbench();
  assert.equal(await selector().inputValue(), 'qa-image-a', 'choice survives closing/reopening the workbench');
  await page.reload({ waitUntil: 'networkidle' }); await enterWorkbench();
  assert.equal(await selector().inputValue(), 'qa-image-a', 'choice survives app refresh');
  await mutateFixture(() => {}); await enterWorkbench();
  steps.push('private dropdown present; profile choice persists on navigation/reload; default API unchanged; zero calls during selection; no credential text; 1280×800 and 1120×720 screenshots');

  await generate().click();
  await waitForCondition({ label: 'first image held in local mock', timeoutMs: 20_000, intervalMs: 50, check: () => Boolean(releaseFirst) });
  await selector().selectOption('qa-image-b'); await waitForSelection('qa-image-b');
  await generate().click(); await waitForTaskCount(2);
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.equal(await selector().count(), 0, 'private-only picker cannot replace ordinary global API settings');
  await generate().click(); await waitForTaskCount(3);
  const queuedState = await stored(); const queued = [...queuedState.project.generationTasks].sort((left, right) => left.createdAt - right.createdAt);
  assert.deepEqual(queued.map((task) => task.model), ['fixture-image-a', 'fixture-image-b', 'fixture-image-default']);
  assert.deepEqual(queued.slice(0, 2).map((task) => task.imageApiSnapshot?.profileId), ['qa-image-a', 'qa-image-b']);
  assert.equal(imageRequests().length, 1, 'queued tasks must not submit while prior image is held');
  for (const task of queued.slice(0, 2)) {
    const snapshot = JSON.stringify(task.imageApiSnapshot);
    for (const value of Object.values(keys)) assert.equal(snapshot.includes(value), false, 'task snapshot is credential-free');
    assert.equal(Object.hasOwn(task.imageApiSnapshot.config, 'apiKey'), false);
  }
  releaseFirst(); releaseFirst = undefined; await waitForTaskCount(3, true);
  assert.deepEqual(imageRequests().map((item) => [item.lane, item.model]), [['a', 'fixture-image-a'], ['b', 'fixture-image-b'], ['default', 'fixture-image-default']]);
  assert.ok(imageRequests().every((item) => item.keyMatches), 'actual mock calls use the selected connection credentials');
  assert.deepEqual(protectedSettings(await stored()), initialProtected);
  const originalState = await stored(); const failedTask = originalState.project.generationTasks.find((task) => task.model === 'fixture-image-b');
  assert.equal(failedTask.status, 'failed');
  assert.equal(originalState.project.generationTasks.filter((task) => task.status === 'succeeded').length, 2);
  await assertNoCredentialsInUi();
  steps.push('actual A/B/default model routes verified under held FIFO; private selection does not alter queued A or ordinary default; API-key-free snapshots persisted; one mock failure isolated');

  fixtureCredentialB = keys.renewedB;
  await mutateFixture((state, data) => {
    const profile = state.settings.imageApiProfiles.find((item) => item.id === 'qa-image-b');
    profile.model = 'fixture-image-b-new-setting'; profile.apiKey = data.renewedB; profile.quality = 'hd';
    state.settings.privateImageApiProfileId = 'qa-image-a';
  }, { renewedB: keys.renewedB });
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator(`#image-task-${failedTask.id}`).getByRole('button', { name: /^重新生图/u }).click();
  await page.getByText(/执行.*改变|参数.*改变|配置.*改变|配置.*变更/u).first().waitFor();
  assert.equal((await stored()).project.generationTasks.length, 3, 'retry refuses changed execution parameters before creating a task');
  assert.equal(imageRequests().length, 3, 'quality mismatch cannot submit to image model');
  await mutateFixture((state) => { state.settings.imageApiProfiles.find((item) => item.id === 'qa-image-b').quality = 'standard'; });
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator(`#image-task-${failedTask.id}`).getByRole('button', { name: /^重新生图/u }).click();
  await waitForTaskCount(4, true);
  const retryState = await stored(); const retry = retryState.project.generationTasks.find((task) => task.regenerationSourceTaskId === failedTask.id);
  assert.ok(retry, 'explicit retry produces a new task and leaves original failure untouched');
  assert.equal(retry.status, 'succeeded', retry.error);
  assert.equal(retry.model, 'fixture-image-b'); assert.equal(retry.imageApiSnapshot.profileId, 'qa-image-b');
  assert.deepEqual(imageRequests().at(-1), { kind: 'image', path: `${prefix}/b/v1/images/generations`, lane: 'b', model: 'fixture-image-b', keyMatches: true });
  assert.equal(retryState.project.generationTasks.find((task) => task.id === failedTask.id).status, 'failed');
  await assertNoCredentialsInUi();
  steps.push('after reload, changed execution quality refuses retry without a new task/API call; restoring quality permits manual retry with original B model/channel and refreshed B credential; original task preserved');

  const requestsBeforeInvalid = requests.length;
  await mutateFixture((state) => {
    state.settings.privateImageApiProfileId = 'qa-image-b';
    state.settings.imageApiProfiles = state.settings.imageApiProfiles.filter((item) => item.id !== 'qa-image-b');
  });
  await enterWorkbench();
  assert.equal(await selector().inputValue(), 'qa-image-b'); assert.match(await page.locator('.image-output-card').innerText(), /删除|不存在|失效/u);
  await page.getByText('生图 API 配置不可用', { exact: true }).waitFor();
  assert.equal(await generate().isDisabled(), true, 'deleted explicit choice never falls back to a different paid API');
  await capture('deleted-profile-disabled');
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator(`#image-task-${retry.id}`).getByRole('button', { name: /^重新生图/u }).click();
  await page.getByText(/原.*配置.*删除|配置.*不存在|找不到.*配置/u).first().waitFor();
  assert.equal((await stored()).project.generationTasks.length, 4, 'retry with removed connection cannot create a replacement task');
  assert.equal(requests.length, requestsBeforeInvalid, 'deleted API choice/retry causes zero converter or image calls');
  await mutateFixture((state) => {
    state.settings.privateImageApiProfileId = 'qa-image-a';
    state.settings.imageApiProfiles.find((item) => item.id === 'qa-image-a').enabled = false;
  });
  await enterWorkbench(); assert.equal(await selector().inputValue(), 'qa-image-a');
  assert.match(await page.locator('.image-output-card').innerText(), /未启用|停用|禁用|关闭/u);
  await page.getByText('生图 API 配置不可用', { exact: true }).waitFor();
  assert.equal(await generate().isDisabled(), true, 'disabled explicit profile cannot silently use current/global config');
  assert.equal(requests.length, requestsBeforeInvalid); await capture('disabled-profile-disabled');
  steps.push('deleted choice remains explicit and disables generation; removed profile retry creates no new task; disabled choice blocks without converter/image calls or fallback');

  await mutateFixture((state) => { state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null; state.settings.privateImageApiProfileId = null; });
  await enterWorkbench(); assert.equal(await selector().inputValue(), '');
  assert.equal(await selector().locator('option').count(), 1, 'no saved profiles still exposes follow-current option');
  assert.equal(await generate().isEnabled(), true); await generate().click(); await waitForTaskCount(5, true);
  const fallback = (await stored()).project.generationTasks.find((task) => !originalState.project.generationTasks.some((entry) => entry.id === task.id) && task.id !== retry.id);
  assert.equal(fallback.status, 'succeeded', fallback.error); assert.equal(fallback.model, 'fixture-image-default');
  assert.equal(imageRequests().at(-1).lane, 'default');
  await assertNoCredentialsInUi(); await assertLayout(1280, 800, 'no-profiles-follow-current');
  steps.push('no saved profiles uses explicitly-followed current image API successfully without altering global settings');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const finalState = await stored(); assert.equal(finalState.project.id, projectId); assert.equal(finalState.projects.length, 1);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, mockOnly: true, noProductionDataRead: true, externalRequests: 0,
    imageRequests: imageRequests().length, textRequests: requests.filter((item) => item.kind === 'text').length, requests,
    steps, layoutChecks, screenshots, errors, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), screenshots }));
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await capture('failure').catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, steps, errors, blockedRequests, requests }, null, 2));
  throw error;
} finally {
  releaseFirst?.(); await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
