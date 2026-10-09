import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Production chunks, a fresh browser profile, synthetic story facts and local
// mocked text calls only. This script never presses a video submit button.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `seedance-motion-${version}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const key = 'lianhua_video_director_state_v22';
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'Seedance production writer checkpoint and source selection', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure; let releaseEnglishFailure;
const errors = []; const externalRequests = []; const apiRequests = []; const checks = [];
const canonical = '【0s-15s】主体：训练者甲与乙；动作：甲持训练棍连续迎击乙，乙用护臂接住后退半步，甲收棍回防；空间：训练场；光影：自然光；镜头：中景保留双方脚步；台词：甲：“左边交给我！”；音效：训练棍与护臂接触声。';
const chinese = '视频规格：时长 15 秒；画面比例 16:9；分辨率 2K；声音模式 stereo。\n\n参考素材与职责：\n本次没有绑定外部参考素材。\n\n主体连续性：\n训练者甲保持手持训练棍，训练者乙持续佩戴护臂。\n\n一句话概述：\n甲在连续近身训练中迎击乙，乙承接后退，两人自然回防。\n\n连续时间轴（覆盖 0–15 秒）：\n【0s-15s】甲持训练棍连续迎击乙，其中一次训练棍接触乙的护臂，乙受力后退半步，甲随即收棍回防。甲：“左边交给我！”镜头保持双方手部接触和脚步可见。\n\n全局约束：\n保持身份、训练器材和空间关系连续。';
const english = 'Video specification: duration 15 seconds; aspect ratio 16:9; resolution 2K; audio mode stereo.\n\nReferences and responsibilities:\nNo external references are bound.\n\nSubject continuity:\nTrainee A keeps the training staff and trainee B keeps the forearm guards.\n\nOne-sentence summary:\nA continuously meets B during close training; B catches the staff, steps back and both return naturally to guard.\n\nContinuous timeline (covering 0–15 seconds):\n【0s-15s】A continuously strikes B with the training staff, including one contact against B\'s forearm guard. B absorbs it and retreats half a step; A retracts and guards. A: “左边交给我！” The camera keeps hand contact and footwork visible.\n\nGlobal constraints:\nKeep identities, training equipment and spatial relations continuous.';

const seed = async () => page.evaluate(({ key, origin, canonical }) => {
  const state = JSON.parse(localStorage.getItem(key)); const now = Date.now(); const chapterId = 'seedance-motion-chapter';
  const hash = (text) => { let value = 0xcbf29ce484222325n; for (let at = 0; at < text.length; at++) { value ^= BigInt(text.charCodeAt(at)); value = BigInt.asUintN(64, value * 0x100000001b3n); } return `src-v1-${value.toString(16).padStart(16, '0')}`; };
  const scene = { id: 'seedance-motion-scene', chapterId, title: '连续训练', content: canonical, summary: '中性训练动作', characterIds: [], locationIds: [], propIds: [], storyboardIds: ['seedance-motion-board'], createdAt: now, updatedAt: now };
  const board = { id: 'seedance-motion-board', chapterId, sceneId: scene.id, sourceStoryTitle: '训练第一段', sourceStoryContent: canonical,
    workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '保持训练者身份和器材连续。',
    finalPrompt: canonical, promptMigrationPending: false, shots: [{ id: 'seedance-motion-shot', index: 1, startSec: 0, endSec: 15, purpose: '连续训练', subject: '训练者甲与乙', action: '甲持训练棍迎击乙，乙接住后退，甲回防', camera: '中景保留手部接触与脚步', lighting: '自然光', sound: '甲：“左边交给我！”', transition: '连续', result: '双方回防', referenceAssetIds: [], prompt: canonical, locked: false, authoredBy: 'text-api' }],
    sequencePlanId: 'seedance-motion-plan', segmentId: 'seedance-motion-segment-1', segmentIndex: 1, segmentCount: 2, createdAt: now, updatedAt: now };
  const second = { ...board, id: 'seedance-motion-board-2', sourceStoryTitle: '训练第二段', targetModelId: 'custom', segmentId: 'seedance-motion-segment-2', segmentIndex: 2, finalPrompt: '【0s-15s】训练者甲乙放下器材，沿训练场走向出口。', shots: [{ ...board.shots[0], id: 'seedance-motion-shot-2', action: '放下器材后离开', prompt: '【0s-15s】训练者甲乙放下器材，沿训练场走向出口。' }] };
  for (const saved of [board, second]) saved.promptTrace = { modelRuleSetId: saved.ruleSetId, converterPresetId: saved.converterPresetId, sourceDocumentIds: [chapterId], referenceAssetIds: [], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: hash(saved.finalPrompt), shotPlanMode: 'ai-complete' };
  scene.storyboardIds.push(second.id);
  const plan = { id: board.sequencePlanId, chapterId, title: '连续训练两段', sourceStoryTitle: '训练剧情', sourceStoryContent: canonical, durationMode: 'fixed', totalDurationSec: 30, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented',
    segments: [board, second].map((saved, index) => ({ id: saved.segmentId, index: index + 1, title: saved.sourceStoryTitle, globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15, content: saved.finalPrompt, summary: '中性训练', sourceSceneIds: [scene.id], sourceBeatIds: [], sourceShotIds: [], narrativePurpose: '连续训练', entryState: '', exitState: '', transitionHint: '', storyboardId: saved.id, status: 'ready' })), createdAt: now, updatedAt: now };
  const project = { ...state.project, id: 'seedance-motion-project', name: 'Seedance 隔离验收', activeChapterId: chapterId, chapterWorkspaces: {}, sourceDocuments: [{ id: chapterId, name: '训练章节', content: canonical, createdAt: now, updatedAt: now }], scenes: [scene], characters: [], locations: [], props: [], assets: [], storyboards: [board, second], sequencePlans: [plan], generationTasks: [], createdAt: now, updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai-compatible', baseUrl: `${origin}/mock`, model: 'synthetic-seedance-text', apiKey: '' };
  for (const name of ['imageApi', 'visionApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
  state.settings.runningHubVideo.enabled = false; state.settings.videoSource = 'api'; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
}, { key, origin, canonical });

const storedOutput = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key))?.project?.storyboards.find((board) => board.id === 'seedance-motion-board')?.seedance25Output, key);
const run = async () => {
  await waitForCondition({ label: 'production preview startup', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { window.__seedanceClipboard = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__seedanceClipboard = value; }, readText: async () => window.__seedanceClipboard } }); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) { externalRequests.push(request.url()); await route.abort('blockedbyclient'); return; }
    if (url.origin === origin && request.method() === 'POST') {
      assert.equal(url.pathname, '/mock/v1/chat/completions', 'the UI must not submit a video or use another endpoint');
      apiRequests.push(JSON.parse(request.postData() || '{}'));
      if (apiRequests.length === 2) { await new Promise((resolve) => { releaseEnglishFailure = resolve; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unexpected: true }) }); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: apiRequests.length === 1 ? chinese : english } }] }) }); return;
    }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('.sidebar').waitFor();
  await waitForCondition({ label: 'initial isolated browser persistence', timeoutMs: 10_000, intervalMs: 100, check: () => page.evaluate((key) => Boolean(localStorage.getItem(key)), key) });
  checks.push('production chunks cold-start without runtime errors'); await seed(); await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: 'Seedance 2.5', exact: true }).click();
  const generate = page.getByRole('button', { name: '生成 Seedance 2.5 官方稿', exact: true });
  assert.equal(await generate.isEnabled(), true, 'Seedance generation must not require an existing H3 delivery');
  await generate.click();
  await waitForCondition({ label: 'Chinese saved before held English response', timeoutMs: 20_000, intervalMs: 100, check: async () => apiRequests.length === 2 && (await storedOutput())?.promptZh === chinese });
  const checkpoint = await storedOutput(); assert.equal(checkpoint.promptEn, undefined);
  checks.push('qualified Chinese checkpoint persisted before English returns, without an H3 prerequisite');
  releaseEnglishFailure(); await page.getByRole('button', { name: '仅重试英文', exact: true }).waitFor();
  assert.equal(apiRequests.length, 2); assert.equal((await storedOutput()).promptZh, chinese);
  await page.getByRole('button', { name: '仅重试英文', exact: true }).click();
  await waitForCondition({ label: 'English-only retry persisted', timeoutMs: 20_000, intervalMs: 100, check: async () => (await storedOutput())?.promptEn === english });
  assert.equal(apiRequests.length, 3, 'retry adds exactly one English call and never regenerates Chinese');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  assert.equal(await page.locator('.director-result-copy pre').innerText(), english);
  await page.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__seedanceClipboard), english);
  checks.push('English failure preserves Chinese; English-only retry and copy use the saved language body');
  await page.screenshot({ path: path.join(output, 'seedance-writer-English-copy.png') });

  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('button', { name: '从提示词导演台选择', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从提示词导演台选择提示词' });
  await dialog.getByLabel('选择提示词格式', { exact: true }).selectOption('seedance');
  await dialog.getByLabel('描述语言', { exact: true }).selectOption('en');
  await dialog.locator('.vd-choice').first().click();
  assert.equal(await dialog.locator('.vd-prompt-preview').innerText(), english);
  await dialog.getByRole('button', { name: '使用这段提示词', exact: true }).click();
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), english);
  await page.getByLabel('本次稿件语言', { exact: true }).selectOption('zh');
  await page.getByLabel('本次提示词格式', { exact: true }).selectOption('ordinary');
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), canonical);
  await page.getByLabel('本次提示词格式', { exact: true }).selectOption('seedance');
  await page.getByLabel('本次稿件语言', { exact: true }).selectOption('en');
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), english, 'linked format/language controls update the actual submission body');
  checks.push('single source picker selects Seedance English and copies the exact body into the actual submission editor');
  await page.screenshot({ path: path.join(output, 'single-Seedance-source.png') });

  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const batch = page.getByRole('region', { name: '长剧情批量视频' });
  const expand = batch.getByRole('button', { name: '展开批量设置', exact: true }); if (await expand.isVisible()) await expand.click();
  await batch.getByLabel('批量提示词格式', { exact: true }).selectOption('seedance');
  assert.ok((await batch.locator('.vd-batch-list').innerText()).includes('训练第一段'));
  assert.equal(await batch.getByLabel('选择第 2 段', { exact: true }).isDisabled(), true, 'a row without Seedance cannot silently use another format');
  const firstRow = batch.locator('[data-segment-id="seedance-motion-segment-1"]');
  await firstRow.getByRole('button', { name: '英文', exact: true }).click();
  await firstRow.getByRole('button', { name: '预览', exact: true }).click();
  assert.equal(await batch.locator('.vd-batch-preview pre.vd-prompt-preview').innerText(), english);
  await batch.getByLabel('第 2 段提示词格式', { exact: true }).selectOption('ordinary');
  assert.equal(await batch.getByLabel('选择第 2 段', { exact: true }).isEnabled(), true);
  await batch.locator('[data-segment-id="seedance-motion-segment-2"]').getByRole('button', { name: '预览', exact: true }).click();
  assert.equal(await batch.locator('.vd-batch-preview pre.vd-prompt-preview').innerText(), '【0s-15s】训练者甲乙放下器材，沿训练场走向出口。');
  checks.push('batch source selector uses saved Seedance English; missing Seedance remains empty; a row override explicitly selects the ordinary body');
  await page.screenshot({ path: path.join(output, 'batch-Seedance-source.png') });
  assert.equal(apiRequests.length, 3, 'navigation and source/language selections add no model requests');
  assert.deepEqual(externalRequests, [], 'all traffic is local and no real video service was contacted');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
  assert.equal(persisted.project.generationTasks.length, 0, 'the smoke test never creates a video task');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, version, productionPreview: true, isolatedBrowserStorage: true, textCalls: apiRequests.length, realVideoRequests: 0, createdTasks: 0, checks, externalRequests, errors }, null, 2));
  console.log(`Seedance production UI checks passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; releaseEnglishFailure?.(); await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks, apiCalls: apiRequests.length, externalRequests, errors }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); }
if (failure) throw failure;
