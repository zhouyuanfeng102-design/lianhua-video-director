import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A fresh browser and synthetic environment shots only. No desktop bridge,
// production project, credential or paid service is used. Text requests can be
// held at identity preparation; image requests return a neutral color tile.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, 'storyboard-task-preparation');
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA evidence cannot traverse links: ${candidate}`);
}
const relative = path.relative(outputBase, output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
await fs.mkdir(output, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'task-preparation-ui-project';
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__task_preparation_fixture.html';
const textPath = '/__task_preparation_mock__/text/v1/chat/completions';
const imagePaths = ['/__task_preparation_mock__/image/v1/images/generations', '/__task_preparation_mock__/image/v1/images/edits'];
const qa = { pass: false, mockOnly: true, noProductionDataRead: true, origin, stages: [], requests: [], blockedExternalRequests: [], errors: [], screenshots: [] };
const remainingOnly = process.argv.includes('--remaining');
if (remainingOnly) {
  const previous = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(previous.mockOnly, true); assert.equal(previous.noProductionDataRead, true);
  assert.ok(previous.stages.includes('preparation-HTTP-failure-retains-both-failed-task-records-with-reasons-and-no-image-call'));
  qa.stages.push(...previous.stages);
  qa.screenshots.push(...previous.screenshots.filter((file) => !file.endsWith('failure.png')));
  qa.firstBatchVisibleMs = previous.firstBatchVisibleMs;
  qa.targetedRerun = { reason: 'Use the cancellation button accessible name from its title; retain already passed batch, asset and preparation-failure checks.', previouslyPassedStages: previous.stages, previousImageRequests: previous.requests.filter((request) => request.kind === 'image').length };
}
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'storyboard task preparation isolated UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let png = ''; let phase = 'two-batches';
const holds = [];
const holdIdentity = (boardId, outcome = 'success') => {
  let release;
  const hold = { boardId, phase, outcome, started: false, released: false, completed: false, gate: new Promise((done) => { release = done; }) };
  hold.release = () => { hold.released = true; release(); };
  holds.push(hold);
  return hold;
};
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const imageCalls = () => qa.requests.filter((request) => request.kind === 'image');
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); qa.screenshots.push(file); };
const enterDirector = async () => {
  await nav('提示词导演台');
  const resultTab = page.getByRole('button', { name: '结果', exact: true });
  if (await resultTab.isVisible()) await resultTab.click();
  await page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }).waitFor();
};
const enterWorkbench = async (boardId) => {
  await nav('图像工作台');
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '分镜图', exact: true }).click();
  const select = page.getByRole('combobox', { name: '选择分镜', exact: true });
  await select.waitFor();
  if (boardId) await select.selectOption(boardId);
};
const enterTasks = async () => {
  await nav('生成任务');
  const tab = page.getByRole('tab', { name: /图片任务/u });
  if (await tab.count()) await tab.click();
};
const awaitHeld = (hold) => waitForCondition({ label: `held ${hold.boardId} identity request`, timeoutMs: 15_000, intervalMs: 30, check: () => hold.started });
const waitNewTasks = async (oldIds, count, status) => {
  await page.waitForFunction(({ key, oldIds, count, status }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const tasks = state.project.generationTasks.filter((task) => task.kind === 'image' && !oldIds.includes(task.id));
    return tasks.length === count && (!status || tasks.every((task) => task.status === status));
  }, { key: storageKey, oldIds, count, status }, { timeout: status ? 40_000 : 2500 });
  return (await readState()).project.generationTasks.filter((task) => task.kind === 'image' && !oldIds.includes(task.id));
};
const assertPreparingTasksVisible = async (oldIds, count, boardId) => {
  const tasks = await waitNewTasks(oldIds, count);
  assert.ok(tasks.every((task) => task.status === 'queued' && task.preparationStage === 'identity' && task.sourceStoryboardId === boardId), 'all members are saved before identity preparation finishes');
  await enterTasks();
  for (const task of tasks) {
    const card = page.locator(`#image-task-${task.id}`);
    await card.waitFor();
    assert.match(await card.innerText(), /人物|准备/u, 'task center explains the current preparation stage');
  }
  return tasks;
};

async function installRoutes() {
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && ![textPath, ...imagePaths].includes(url.pathname))) {
      qa.blockedExternalRequests.push({ url: request.url(), method: request.method() });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Isolated storyboard task fixture</title><body>程序任务隔离测试</body></html>' }); return;
    }
    if (imagePaths.includes(url.pathname)) {
      qa.requests.push({ phase, kind: 'image', path: url.pathname });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) }); return;
    }
    if (url.pathname === textPath) {
      try {
        const payload = request.postDataJSON();
        const messageText = (role) => payload.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')).join('\n');
        const system = messageText('system'); const user = messageText('user'); let response;
        if (system.includes('实际出镜人物解析器')) {
          const data = JSON.parse(user.slice(user.indexOf('{')));
          const boardId = data.shots[0].id.startsWith('prep-a-') ? 'prep-a' : 'prep-b';
          const hold = holds.find((entry) => entry.phase === phase && entry.boardId === boardId && !entry.started);
          qa.requests.push({ phase, kind: 'identity', boardId, shotCount: data.shots.length });
          if (hold) {
            hold.started = true; await hold.gate;
            if (hold.outcome === 'failure') {
              await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: '隔离测试：人物识别准备失败' } }) }); hold.completed = true; return;
            }
          }
          response = JSON.stringify({ shots: data.shots.map((shot) => ({ shotId: shot.id, visibleCharacterNames: [] })) });
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
          if (hold) hold.completed = true;
          return;
        }
        assert.match(system, /图像|生图|图片/u, 'only the image converter is permitted beyond identity preparation');
        qa.requests.push({ phase, kind: 'conversion' });
        response = 'A single still image of a stone bridge in soft morning fog, complete railing, calm river, medium view, clean spatial depth, no people.';
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
      } catch (error) {
        if (page?.isClosed()) return;
        qa.errors.push(`Mock text route: ${error.message}`);
        await route.fulfill({ status: 500, body: 'Unexpected isolated text request' }).catch(() => {});
      }
      return;
    }
    await route.continue();
  });
}

async function seed() {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  png = await page.evaluate(async ({ key, origin, projectId }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now();
    const characters = [{ ...state.project.characters[0], id: 'prep-character', name: '程序测试假人', gender: '男', apparentAge: '30岁', actualAge: '30岁', race: '展示假人', morphology: 'humanoid', bodyPlan: '完整中性展示假人轮廓', appearance: '蓝色光滑不透明外壳', outfit: '中性外壳', anchor: '蓝色程序测试假人', assetIds: [] }];
    const story = '清晨薄雾缓慢流经青石桥，阳光照在栏杆上，河水平静流动，画面中没有人物。';
    const boards = []; const scenes = [];
    for (const [id, count] of [['prep-a', 2], ['prep-b', 3]]) {
      const scene = { id: `${id}-scene`, title: `${id === 'prep-a' ? '第一' : '第二'}方案石桥`, content: story, summary: '程序环境测试', characterIds: [], locationIds: [], propIds: [], storyboardIds: [id], createdAt: now, updatedAt: now };
      const shots = Array.from({ length: count }, (_, index) => ({ id: `${id}-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5, purpose: '展示环境', subject: '青石桥', action: '晨光照在石栏杆上', camera: '固定中景', lighting: '柔和自然光', sound: '水声', result: '石栏杆完整可见', transition: '顺接', referenceAssetIds: [], prompt: `【${index * 5}s-${(index + 1) * 5}s】青石桥与薄雾，固定中景，柔和晨光，无人物。`, locked: false, authoredBy: 'text-api' }));
      const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
      const board = applyOfficialH3Prompt({ id, sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: count * 5, durationPreset: 'custom', shotMode: 'exact', shotCount: count, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '石桥、晨光、栏杆保持固定', shots, finalPrompt, promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: ['prep-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now }, { assets: [], characters, locations: [], props: [], sceneContent: story });
      scenes.push(scene); boards.push(board);
    }
    const project = { ...state.project, id: projectId, name: '图片任务准备隔离测试', characters, locations: [], props: [], assets: [], sourceDocuments: [{ id: 'prep-source', name: '程序测试章节', content: story, createdAt: now, updatedAt: now }], scenes, storyboards: boards, sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = projectId;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__task_preparation_mock__/text`, apiKey: '', model: 'local-fixture-text' };
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__task_preparation_mock__/image`, apiKey: '', model: 'local-fixture-image', imageProtocol: 'openai-compatible', imageResolutionProfile: 'pixel-long-edge' };
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null; state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.storyboardImageOutputSize = { mode: '1k', width: 1024, height: 1024, resolutionVersion: 1 };
    state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#718ca3'; paint.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/png');
  }, { key: storageKey, origin, projectId });
  await page.goto(origin, { waitUntil: 'networkidle' });
}

async function checkTwoBatchesAndAssetCompletion() {
  phase = 'two-batches';
  const a = holdIdentity('prep-a'); const b = holdIdentity('prep-b');
  await enterDirector();
  const start = Date.now();
  await page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }).click();
  await awaitHeld(a);
  const first = await assertPreparingTasksVisible([], 2, 'prep-a');
  qa.firstBatchVisibleMs = Date.now() - start;
  assert.equal(imageCalls().length, 0, 'no image call while identity is held');
  await capture('first-boundary-batch-visible-during-identity');
  await enterWorkbench('prep-b'); await enterDirector();
  const oldIds = first.map((task) => task.id);
  await page.getByRole('button', { name: '生成分镜图片（3张）', exact: true }).click();
  await awaitHeld(b);
  const second = await assertPreparingTasksVisible(oldIds, 3, 'prep-b');
  assert.equal((await readState()).project.generationTasks.length, 5, 'second batch preserves all previously registered members');
  await capture('two-independent-preparing-batches');

  // Completing an unrelated ordinary image adds an asset while both storyboard
  // identity calls are held. It must not cancel either reserved storyboard batch.
  await nav('图像工作台');
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '人物角色', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('prep-character');
  await page.locator('.image-generate-actions button.primary').click();
  const unrelated = await waitNewTasks([...oldIds, ...second.map((task) => task.id)], 1, 'succeeded');
  assert.ok(unrelated[0].resultAssetId);
  for (const task of (await readState()).project.generationTasks.filter((task) => [...oldIds, ...second.map((entry) => entry.id)].includes(task.id))) assert.equal(task.status, 'queued');
  a.release();
  await page.waitForFunction(({ key, ids }) => JSON.parse(localStorage.getItem(key)).project.generationTasks.filter((task) => ids.includes(task.id)).every((task) => task.status === 'succeeded'), { key: storageKey, ids: oldIds }, { timeout: 40_000 });
  const whileSecondHeld = await readState();
  assert.ok(second.every((task) => whileSecondHeld.project.generationTasks.some((entry) => entry.id === task.id && entry.status === 'queued')));
  b.release();
  await page.waitForFunction((key) => { const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks; return tasks.length === 6 && tasks.every((task) => task.status === 'succeeded'); }, storageKey, { timeout: 40_000 });
  assert.equal(imageCalls().length, 6, 'each original member is submitted once, plus one unrelated ordinary image');
  qa.stages.push('director-boundary-and-all-shots-register-before-held-identity-and-survive-navigation-and-second-batch');
  qa.stages.push('unrelated-asset-completion-does-not-cancel-pending-batches-and-all-six-original-tasks-settle');
}

async function checkFailureAndCancellation() {
  phase = 'failure-and-cancel';
  const imageCount = imageCalls().length;
  if (!remainingOnly) {
  await enterWorkbench('prep-a'); await enterDirector();
  const beforeFailure = (await readState()).project.generationTasks.map((task) => task.id);
  const failedHold = holdIdentity('prep-a', 'failure');
  await page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }).click();
  await awaitHeld(failedHold);
  const reservedFailure = await assertPreparingTasksVisible(beforeFailure, 2, 'prep-a');
  failedHold.release();
  const failed = await waitNewTasks(beforeFailure, 2, 'failed');
  assert.deepEqual(failed.map((task) => task.id), reservedFailure.map((task) => task.id), 'preparation failures retain the original registered records');
  assert.ok(failed.every((task) => task.error), 'preparation failure is explained on each task');
  assert.equal(imageCalls().length, imageCount);
  qa.stages.push('preparation-HTTP-failure-retains-both-failed-task-records-with-reasons-and-no-image-call');
  }

  await enterWorkbench('prep-b'); await enterDirector();
  const beforeCancel = (await readState()).project.generationTasks.map((task) => task.id);
  const cancelledHold = holdIdentity('prep-b');
  await page.getByRole('button', { name: '生成分镜图片（3张）', exact: true }).click();
  await awaitHeld(cancelledHold);
  const reservedCancel = await assertPreparingTasksVisible(beforeCancel, 3, 'prep-b');
  for (const task of reservedCancel) await page.locator(`#image-task-${task.id}`).getByRole('button', { name: '取消此准备中或排队任务，保留一条已取消记录，不影响其他任务', exact: true }).click();
  await waitNewTasks(beforeCancel, 3, 'cancelled');
  cancelledHold.release();
  await waitForCondition({ label: 'cancelled identity mock response released', timeoutMs: 5000, intervalMs: 30, check: () => cancelledHold.completed });
  await enterDirector();
  await page.getByRole('button', { name: '生成分镜图片（3张）', exact: true }).waitFor();
  assert.equal(imageCalls().length, imageCount, 'late identity response cannot submit cancelled members');
  assert.ok((await readState()).project.generationTasks.filter((task) => reservedCancel.some((entry) => entry.id === task.id)).every((task) => task.status === 'cancelled'));
  qa.stages.push('cancel-all-preparing-members-preserves-cancelled-records-and-late-identity-response-makes-no-image-call');
}

async function checkSelectedWorkbenchNavigation() {
  phase = 'selected-workbench';
  await enterWorkbench('prep-a');
  await page.getByRole('checkbox', { name: '选择第 1 镜', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择第 2 镜', exact: true }).check();
  const previousIds = (await readState()).project.generationTasks.map((task) => task.id);
  const beforeImages = imageCalls().length;
  const held = holdIdentity('prep-a');
  await page.getByRole('button', { name: '生成选中分镜图片（2 张）', exact: true }).click();
  await awaitHeld(held);
  const tasks = await assertPreparingTasksVisible(previousIds, 2, 'prep-a');
  await nav('项目总览');
  held.release();
  const completed = await waitNewTasks(previousIds, 2, 'succeeded');
  assert.deepEqual(completed.map((task) => task.id), tasks.map((task) => task.id));
  assert.equal(imageCalls().length - beforeImages, 2);
  await enterTasks(); await capture('selected-workbench-tasks-complete-after-navigation');
  qa.stages.push('workbench-selected-shots-register-during-identity-and-complete-original-tasks-after-leaving-view');
}

async function run() {
  await waitForCondition({ label: 'local Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => qa.errors.push(error.message));
  await installRoutes(); await seed();
  if (!remainingOnly) await checkTwoBatchesAndAssetCompletion();
  await checkFailureAndCancellation();
  await checkSelectedWorkbenchNavigation();
  assert.deepEqual(qa.errors, []); assert.deepEqual(qa.blockedExternalRequests, []);
  qa.finalTaskStatuses = (await readState()).project.generationTasks.map((task) => ({ id: task.id, status: task.status }));
  qa.pass = true;
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  qa.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); qa.failure.bodyText = await page.locator('body').innerText().catch(() => ''); }
  process.exitCode = error.exitCode || 1;
} finally {
  for (const hold of holds) hold.release();
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  harness.markElectronStopping(); await harness.stopAll().catch((error) => { qa.cleanupError = error.message; qa.pass = false; process.exitCode = 1; });
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(qa, null, 2)}\n`);
  await fs.writeFile(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: qa.pass, stages: qa.stages, imageRequests: imageCalls().length, report: path.join(output, 'report.json'), failure: qa.failure?.message }, null, 2));
