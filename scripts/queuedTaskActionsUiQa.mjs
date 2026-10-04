import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// A real-App browser regression using only synthetic state and neutral color
// tiles in a fresh browser context. Every provider-shaped request is mocked on
// loopback. No Electron bridge, production project or credential is available.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `queued-task-actions-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Queue QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Queue QA output cannot traverse a link'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });

const key = 'lianhua_video_director_state_v22';
const fixturePath = '/__queued_tasks_fixture.html';
const mockPrefix = '/__queued_tasks_mock__';
const prompt = 'A single neutral opaque blue display mannequin stands centered in a clean studio, full body visible from head to both feet, smooth surface, complete silhouette, even soft light and a plain background.';
const errors = []; const blockedRequests = []; const stages = []; const screenshots = []; const requestLog = [];
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser; let page; let origin; let context; let currentQa;
const read = () => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), key);
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const card = (id) => page.locator(`#image-task-${id}`);
const action = (id, label) => card(id).locator('button').filter({ hasText: new RegExp(`^${label}$`, 'u') });
const capture = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file);
};
const until = async (condition, description) => {
  for (let index = 0; index < 200; index += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
};
const waitTasks = async (predicate, description) => until(async () => predicate((await read()).project.generationTasks), description);
const textContent = (value) => typeof value === 'string' ? value : Array.isArray(value) ? value.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n') : '';

async function install(scenario, holdKind = 'conversion') {
  if (context) await context.close();
  context = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(10_000);
  const qa = currentQa = { scenario, holdKind, held: false, release: undefined, png: '', requests: [], state: undefined };
  page.on('pageerror', (cause) => errors.push({ scenario, message: cause.message }));
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    // Vite's disabled-HMR client may retain configured port 0 instead of the
    // resolved random listener port. Both dev-only sockets are closed here;
    // this exception never opens a connection or permits provider traffic.
    const viteSocket = url.hostname === '127.0.0.1' && ['0', new URL(origin).port].includes(url.port) && url.pathname === '/';
    if (!viteSocket) blockedRequests.push({ scenario, method: 'WEBSOCKET', url: socket.url() });
    socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    const isMock = url.origin === origin && url.pathname.startsWith(`${mockPrefix}/`);
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && !isMock)) {
      blockedRequests.push({ scenario, method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Queued task actions isolated QA</title><body>Only synthetic local QA data</body></html>' }); return;
    }
    if (!isMock) { await route.continue(); return; }
    try {
      assert.equal(request.method(), 'POST');
      const payload = request.postDataJSON();
      const image = /\/images\/(?:generations|edits)$/u.test(url.pathname);
      const system = (payload.messages || []).filter((entry) => entry.role === 'system').map((entry) => textContent(entry.content)).join('\n');
      const user = (payload.messages || []).filter((entry) => entry.role === 'user').map((entry) => textContent(entry.content)).join('\n');
      let kind; let response;
      if (image) { kind = 'image'; response = { data: [{ b64_json: qa.png.split(',')[1] }] }; }
      else if (url.pathname.endsWith('/chat/completions') && system.includes('实际出镜人物解析器')) {
        kind = 'visible-characters'; const evidence = JSON.parse(user.slice(user.indexOf('{')));
        response = { choices: [{ message: { content: JSON.stringify({ shots: evidence.shots.map((shot) => ({ shotId: shot.id, visibleCharacterNames: [] })) }) } }] };
      } else if (url.pathname.endsWith('/chat/completions') && system.includes('分镜静帧规划导演')) {
        kind = 'frame-plan'; const input = JSON.parse(user);
        const frames = Array.from({ length: input.requestedImageCount }, (_value, index) => ({
          sourceShotId: input.source.shots[index % input.source.shots.length].id,
          description: `隔离分镜静帧${index + 1}：完整蓝色立方体停在明亮展台上，保持同一柔和侧光与中景。`,
          timeSec: input.source.shots[index % input.source.shots.length].startSec + 1,
        }));
        response = { choices: [{ message: { content: JSON.stringify(frames) } }] };
      } else if (url.pathname.endsWith('/chat/completions')) {
        kind = 'conversion'; response = { choices: [{ message: { content: scenario === 'storyboard' ? 'A single opaque blue cube rests on a clean studio pedestal, one static moment, complete cube silhouette, stable medium view, soft side lighting and a simple background.' : prompt } }] };
      } else throw new Error(`Unexpected mock route ${url.pathname}`);
      const entry = { scenario, kind, pathname: url.pathname };
      qa.requests.push(entry); requestLog.push(entry);
      if (kind === qa.holdKind && !qa.held) {
        qa.held = true;
        await new Promise((resolve) => { qa.release = resolve; });
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    } catch (cause) {
      errors.push({ scenario, message: String(cause) });
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"Isolated queue mock rejected its input"}}' }).catch(() => {});
    }
  });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  qa.png = await page.evaluate(async ({ storageKey, origin, mockPrefix, scenario, prompt }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { createImageGenerationTask } = await import('/src/generationTasks.ts');
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#42658d'; paint.fillRect(0, 0, 128, 128); paint.fillStyle = '#cbb788'; paint.fillRect(42, 24, 44, 88);
    const character = { ...state.project.characters[0], id: 'queue-person', name: '隔离蓝色假人', gender: '男', apparentAge: '30岁成年', actualAge: '30岁', height: '约180cm', race: '展示假人', morphology: 'humanoid', bodyPlan: '成人展示用假人，完整光滑不透明外壳，双手双足直立', appearance: '蓝色光滑不透明表面，没有细节', outfit: '不透明展示外壳', signatureProps: '无', personality: '中性', motionHabits: '中性站姿', anchor: '蓝色外壳', negativeContinuity: '保持同一外壳', assetIds: [], nsfwProfile: { fullBody: '中性蓝色展示假人，光滑不透明外壳，从头到脚完整展示，仅用于隔离程序测试。', provenance: 'manual' } };
    const scene = { id: 'queue-scene', title: '立方体展示', content: '一枚蓝色立方体在明亮展台上静止，镜头先远景，再中景，最后侧面近景。', summary: '蓝色立方体在展台静止', characterIds: [], locationIds: [], propIds: [], storyboardIds: ['queue-board'], createdAt: now, updatedAt: now };
    const shots = Array.from({ length: 3 }, (_value, index) => ({
      id: `queue-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
      subject: '蓝色立方体', action: '完整蓝色立方体在明亮展台上静止', purpose: '展示同一立方体', camera: ['固定远景', '固定中景', '侧面近景'][index], lighting: '柔和侧光', sound: '无配乐', transition: '自然切换', result: '蓝色立方体仍在展台上', referenceAssetIds: [], locked: false, authoredBy: 'text-api',
      prompt: `【${index * 5}s-${(index + 1) * 5}s】主体：蓝色立方体；空间：明亮展台；光影：柔和侧光；镜头：固定中景；台词：无；音效：无。`,
    }));
    const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
    let board = { id: 'queue-board', sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: scene.content,
      workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '同一蓝色立方体、同一展台和侧光', shots, finalPrompt, targetModelId: 'minimax-h3', globalReferenceAssetIds: [],
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    board = applyOfficialH3Prompt(board, { assets: [], characters: [], locations: [], props: [], sceneContent: scene.content });
    const tasks = ['regeneration', 'all-queued'].includes(scenario) ? ['cancel', 'delete'].map((action, index) => ({
      ...createImageGenerationTask({ id: `queue-old-${action}`, name: `隔离旧任务-${action}`, assetKind: 'character', imageVariant: 'full-body', sourceEntityId: character.id, prompt, backend: 'openai', model: 'qa-image', width: 1024, height: 1536, referenceAssetIds: [], primaryReferenceAssetIds: [] }, now - index - 100, 'failed'), error: '隔离历史任务失败',
    })) : [];
    const hasStoryboard = ['storyboard', 'all-queued'].includes(scenario);
    const project = { ...state.project, id: `queue-${scenario}-project`, name: `排队操作隔离测试-${scenario}`, characters: scenario === 'storyboard' ? [] : [character], locations: [], props: [], assets: [], sourceDocuments: [], scenes: hasStoryboard ? [scene] : [], storyboards: hasStoryboard ? [board] : [], sequencePlans: [], generationTasks: tasks, createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}${mockPrefix}/text`, apiKey: '', model: 'qa-text' };
    state.settings.imageApi = { ...state.settings.imageApi, enabled: true, backend: 'openai', baseUrl: `${origin}${mockPrefix}/image`, apiKey: '', model: 'qa-image' };
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.uiFontScalePercent = 100;
    state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    state.settings.privateImagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(storageKey, JSON.stringify(state));
    return canvas.toDataURL('image/png');
  }, { storageKey: key, origin, mockPrefix, scenario, prompt });
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => typeof window.lianhuaDesktop), 'undefined', 'No desktop storage or transport bridge');
  return qa;
}

async function submitWorkbench(count, privateLane = false) {
  await nav('图像工作台');
  await page.locator('.image-entity-controls select').selectOption('queue-person');
  if (privateLane) {
    await page.getByRole('tab', { name: '私密生图', exact: true }).click();
    await page.getByRole('group', { name: '选择私密生图部位', exact: true }).getByRole('button', { name: '私密全身', exact: true }).click();
  } else {
    await page.getByRole('tab', { name: '普通生图', exact: true }).click();
    await page.getByRole('group', { name: '选择普通生图画面规格', exact: true }).getByRole('button', { name: '全身', exact: true }).click();
  }
  await page.getByRole('combobox', { name: `${privateLane ? '私密' : '普通'}生图数量`, exact: true }).selectOption(String(count));
  await page.locator('.image-generate-actions button.primary').click();
}

async function inspectQueuedAndAct(qa, tasks, label) {
  const running = tasks.find((task) => task.status === 'running');
  const queued = tasks.filter((task) => task.status === 'queued').sort((left, right) => left.createdAt - right.createdAt);
  assert.ok(running); assert.equal(queued.length, 2);
  await nav('生成任务');
  const queuedIds = queued.map((task) => task.id);
  for (const id of queuedIds) {
    assert.equal(await action(id, '取消排队').isEnabled(), true);
    assert.equal(await action(id, '删除').isEnabled(), true);
    assert.equal(await action(id, '不可删除').count(), 0);
  }
  assert.equal(await action(running.id, '取消排队').count(), 0);
  const runningDelete = action(running.id, '不可删除');
  assert.equal(await runningDelete.isDisabled(), true, 'already-running work remains protected');
  await capture(`${label}-queued-actions`);
  await action(queuedIds[0], '取消排队').click();
  await waitTasks((rows) => rows.find((task) => task.id === queuedIds[0])?.status === 'cancelled', `${label} cancellation persisted`);
  assert.match(await card(queuedIds[0]).innerText(), /已取消/u);
  assert.equal(await action(queuedIds[0], '取消排队').count(), 0);
  await action(queuedIds[1], '删除').click();
  await waitTasks((rows) => !rows.some((task) => task.id === queuedIds[1]), `${label} direct deletion persisted`);
  assert.equal(await card(queuedIds[1]).count(), 0);
  assert.equal((await read()).project.generationTasks.find((task) => task.id === running.id)?.status, 'running');
  assert.equal(qa.requests.filter((entry) => entry.kind === 'conversion').length, 1);
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, qa.holdKind === 'image' ? 1 : 0);
  await capture(`${label}-cancelled-and-deleted`);
  qa.release();
  await waitTasks((rows) => rows.find((task) => task.id === running.id)?.status === 'succeeded', `${label} running item finished`);
  // Let the FIFO drain its skipped closures; none may regenerate a deleted row.
  await until(() => page.evaluate(async () => {
    const { enqueueImageTask } = await import('/src/imageTaskQueue.ts');
    await enqueueImageTask(async () => undefined); return true;
  }), `${label} FIFO drained`);
  const after = (await read()).project;
  assert.equal(after.generationTasks.find((task) => task.id === queuedIds[0])?.status, 'cancelled');
  assert.equal(after.generationTasks.some((task) => task.id === queuedIds[1]), false);
  assert.equal(qa.requests.filter((entry) => entry.kind === 'conversion').length, 1, 'only the running image converts');
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 1, 'cancelled/deleted images never reach the image mock');
  assert.equal(after.assets.filter((asset) => asset.source === 'generated').length, 1);
  stages.push({ stage: label, cancelled: queuedIds[0], directlyDeleted: queuedIds[1], runningUnchanged: true, generated: 1, noResurrectionAfterQueueDrain: true });
  return { running, cancelled: queuedIds[0], deleted: queuedIds[1] };
}

async function ordinaryAndPrivate(privateLane) {
  const label = privateLane ? 'private-batch' : 'ordinary-batch';
  const qa = await install(privateLane ? 'private' : 'ordinary', privateLane ? 'image' : 'conversion');
  await submitWorkbench(3, privateLane);
  await until(() => qa.held, `${label} first request held`);
  await waitTasks((rows) => rows.length === 3 && rows.filter((task) => task.status === 'running').length === 1, `${label} entered serial queue`);
  const result = await inspectQueuedAndAct(qa, (await read()).project.generationTasks, label);
  await submitWorkbench(1, privateLane);
  await waitTasks((rows) => rows.filter((task) => task.status === 'succeeded').length === 2, `${label} new task succeeds after cancellations`);
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 2);
  await page.reload({ waitUntil: 'networkidle' }); await nav('生成任务');
  const reloaded = (await read()).project.generationTasks;
  assert.equal(reloaded.find((task) => task.id === result.cancelled)?.status, 'cancelled');
  assert.equal(reloaded.some((task) => task.id === result.deleted), false);
  assert.match(await card(result.cancelled).innerText(), /已取消/u);
  await action(result.cancelled, '删除').click();
  await waitTasks((rows) => !rows.some((task) => task.id === result.cancelled), `${label} cancelled record removable`);
  assert.equal((await read()).project.assets.filter((asset) => asset.source === 'generated').length, 2, 'task removal preserves already-generated assets');
  stages.push({ stage: `${label}-subsequent-generation-and-reload`, additionalGeneration: 1, cancelledStateSurvivesReload: true, cancelledRecordDeletable: true, priorAssetsPreserved: true });
}

async function storyboard() {
  const qa = await install('storyboard');
  await nav('提示词导演台');
  const button = page.getByRole('button', { name: '生成分镜图片（3张）', exact: true });
  await button.waitFor(); assert.equal(await button.isEnabled(), true);
  await button.click(); await until(() => qa.held, 'storyboard first conversion held');
  await waitTasks((rows) => rows.length === 3 && rows.filter((task) => task.status === 'running').length === 1, 'storyboard three tasks entered serial queue');
  const tasks = (await read()).project.generationTasks;
  assert.ok(tasks.every((task) => task.sourceStoryboardId === 'queue-board'));
  assert.ok(tasks.filter((task) => task.status === 'queued').every((task) => !task.prompt), 'queued storyboard cards await their converter');
  const beforeBoard = (await read()).project.storyboards[0];
  await inspectQueuedAndAct(qa, tasks, 'storyboard-batch');
  const after = (await read()).project;
  assert.equal(after.storyboards[0].finalPrompt, beforeBoard.finalPrompt, 'queue actions do not rewrite H3 or story prompts');
  assert.equal(after.storyboards[0].officialPromptZh, beforeBoard.officialPromptZh);
  await nav('提示词导演台'); await button.waitFor();
  await until(() => button.isEnabled(), 'storyboard batch lock released');
  await button.click();
  await waitTasks((rows) => rows.filter((task) => task.status === 'succeeded').length === 4, 'later storyboard batch completes after skipped items');
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 4);
  stages.push({ stage: 'storyboard-next-batch', newImages: 3, batchLockReleased: true, originalH3Preserved: true });
}

async function regeneration() {
  const qa = await install('regeneration');
  await submitWorkbench(1); await until(() => qa.held, 'regeneration blocker held');
  await nav('生成任务');
  for (const suffix of ['cancel', 'delete']) await action(`queue-old-${suffix}`, '重新生图').click();
  await waitTasks((rows) => rows.filter((task) => task.status === 'queued' && task.regenerationSourceTaskId).length === 2, 'two regeneration tasks queued');
  const all = (await read()).project.generationTasks;
  const active = all.filter((task) => task.status === 'queued' || task.status === 'running');
  const result = await inspectQueuedAndAct(qa, active, 'regeneration-queue');
  const final = (await read()).project;
  assert.equal(final.generationTasks.find((task) => task.id === 'queue-old-cancel').status, 'failed');
  assert.equal(final.generationTasks.find((task) => task.id === 'queue-old-delete').status, 'failed');
  assert.equal(final.generationTasks.filter((task) => task.regenerationSourceTaskId).length, 1);
  assert.equal(final.generationTasks.find((task) => task.id === result.cancelled).status, 'cancelled');
  // Reusing the original source after a queued retry was deleted must release
  // its lifecycle guard, rather than leaving the source button disabled.
  await until(() => action('queue-old-delete', '重新生图').isEnabled(), 'deleted regeneration lease released');
  await action('queue-old-delete', '重新生图').click();
  await waitTasks((rows) => rows.some((task) => task.regenerationSourceTaskId === 'queue-old-delete' && task.status === 'succeeded'), 'subsequent regeneration succeeds');
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 2);
  stages.push({ stage: 'regeneration-original-and-retry', originalTasksPreserved: true, cancelledOrDeletedRetryNeverSubmitted: true, retryLeaseReleased: true });
}

async function revokeWholeQueuedBatch() {
  const qa = await install('all-queued', 'image');
  await submitWorkbench(1); await until(() => qa.held, 'whole-batch unrelated generation held');
  await waitTasks((rows) => rows.some((task) => task.status === 'running'), 'unrelated running state persisted');
  const running = (await read()).project.generationTasks.find((task) => task.status === 'running');
  assert.ok(running);
  const batchButton = () => page.getByRole('button', { name: '生成分镜图片（3张）', exact: true });
  await nav('提示词导演台'); await batchButton().click();
  await waitTasks((rows) => rows.filter((task) => task.status === 'queued' && task.sourceStoryboardId === 'queue-board').length === 3, 'whole storyboard batch queued behind unrelated work');
  const firstBatch = (await read()).project.generationTasks.filter((task) => task.sourceStoryboardId === 'queue-board');
  await nav('生成任务');
  await action(firstBatch[0].id, '取消排队').click();
  for (const task of firstBatch.slice(1)) await action(task.id, '删除').click();
  await waitTasks((rows) => rows.find((task) => task.id === firstBatch[0].id)?.status === 'cancelled' && firstBatch.slice(1).every((old) => !rows.some((task) => task.id === old.id)), 'entire waiting storyboard batch revoked');
  await nav('提示词导演台');
  await until(() => batchButton().isEnabled(), 'cancelled whole storyboard batch releases UI lease immediately');
  await batchButton().click();
  await waitTasks((rows) => rows.filter((task) => task.status === 'queued' && task.sourceStoryboardId === 'queue-board').length === 3, 'same storyboard can queue a fresh batch before unrelated task finishes');
  const secondBatch = (await read()).project.generationTasks.filter((task) => task.status === 'queued' && task.sourceStoryboardId === 'queue-board');
  await nav('生成任务');
  for (const task of secondBatch) await action(task.id, '删除').click();
  await waitTasks((rows) => secondBatch.every((old) => !rows.some((task) => task.id === old.id)), 'second waiting batch deleted directly');

  for (const suffix of ['cancel', 'delete']) {
    await action(`queue-old-${suffix}`, '重新生图').click();
    await waitTasks((rows) => rows.some((task) => task.status === 'queued' && task.regenerationSourceTaskId === `queue-old-${suffix}`), `${suffix} regeneration queued behind unrelated task`);
    const retry = (await read()).project.generationTasks.find((task) => task.status === 'queued' && task.regenerationSourceTaskId === `queue-old-${suffix}`);
    await action(retry.id, suffix === 'cancel' ? '取消排队' : '删除').click();
    await until(() => action(`queue-old-${suffix}`, '重新生图').isEnabled(), `${suffix} queued regeneration releases source lease immediately`);
    await action(`queue-old-${suffix}`, '重新生图').click();
    await waitTasks((rows) => rows.some((task) => task.status === 'queued' && task.regenerationSourceTaskId === `queue-old-${suffix}` && task.id !== retry.id), `${suffix} replacement retry accepted before unrelated task finishes`);
    const replacement = (await read()).project.generationTasks.find((task) => task.status === 'queued' && task.regenerationSourceTaskId === `queue-old-${suffix}`);
    await action(replacement.id, '删除').click();
  }
  const held = (await read()).project.generationTasks;
  assert.equal(held.find((task) => task.id === running.id)?.status, 'running');
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 1);
  assert.equal(qa.requests.filter((entry) => entry.kind === 'conversion').length, 1);
  await capture('all-queued-revoked-while-unrelated-task-runs');
  qa.release();
  await waitTasks((rows) => rows.find((task) => task.id === running.id)?.status === 'succeeded', 'unrelated task completes after whole-batch revocation');
  await page.evaluate(async () => { const { enqueueImageTask } = await import('/src/imageTaskQueue.ts'); await enqueueImageTask(async () => undefined); });
  const after = (await read()).project;
  assert.equal(after.generationTasks.filter((task) => task.status === 'succeeded').length, 1);
  assert.equal(after.generationTasks.filter((task) => task.status === 'queued' || task.status === 'running').length, 0);
  assert.equal(after.generationTasks.find((task) => task.id === firstBatch[0].id)?.status, 'cancelled');
  assert.ok([...firstBatch.slice(1), ...secondBatch].every((old) => !after.generationTasks.some((task) => task.id === old.id)));
  assert.equal(qa.requests.filter((entry) => entry.kind === 'image').length, 1);
  assert.equal(qa.requests.filter((entry) => entry.kind === 'conversion').length, 1);
  stages.push({ stage: 'whole-queued-batch-immediate-requeue', unrelatedRunningTaskPreserved: true, storyboardBatchLeaseReleasedImmediately: true, cancelledAndDeletedRetryLeasesReleasedImmediately: true, noRevokedWorkSubmitted: true, noResurrectionAfterQueueDrain: true });
}

try {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  await ordinaryAndPrivate(false);
  await ordinaryAndPrivate(true);
  await storyboard();
  await regeneration();
  await revokeWholeQueuedBatch();
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const report = { mockOnly: true, freshBrowserContexts: true, realApp: true, noProductionDataRead: true, noDesktopBridge: true, paidRequests: 0, stages, requests: requestLog, errors, blockedRequests, screenshots };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, stages: stages.length, requests: requestLog.length, paidRequests: 0, errors, blockedRequests }, null, 2));
} catch (cause) {
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(cause), scenario: currentQa?.scenario, stages, requests: requestLog, errors, blockedRequests }, null, 2));
  throw cause;
} finally {
  currentQa?.release?.();
  await context?.close(); await browser?.close(); await server.close();
}
