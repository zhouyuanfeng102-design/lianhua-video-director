import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Fresh browser storage + synthetic projects. All non-loopback requests and
// generation requests are forbidden. This never loads the desktop user profile.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `release151-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'release151 isolated UI', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const steps = []; const requests = [];
const nav = (label) => page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const waitSavedCount = (count) => page.waitForFunction(({ key, count }) => {
  const value = JSON.parse(localStorage.getItem(key)).project.storyboards.find((board) => board.id === 'release151-board-1').storyboardImageCount;
  return count === null ? value === undefined : value === count;
}, { key: storageKey, count });
const screenshot = (name) => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false });

async function run() {
  await waitForCondition({ label: 'release151 Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1430, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__release151Qa = { externalUrls: [], mediaCalls: 0 };
    window.lianhuaDesktop = {
      videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'Isolated mock media tools' }),
      onWorkbenchProgress: () => () => {},
      cancelWorkbenchJob: async () => true,
      probeWorkbenchVideo: async () => { throw new Error('QA must not probe media for configuration'); },
      extractWorkbenchFrames: async () => { window.__release151Qa.mediaCalls += 1; throw new Error('QA must not extract media for configuration'); },
      openExternal: async (url) => { window.__release151Qa.externalUrls.push(url); return true; },
    };
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(route.request().method()))) {
      requests.push({ origin: url.origin, method: route.request().method() });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(async ({ key, origin }) => {
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { createRunningHubTutorialVideoWorkflow, defaultRunningHubVideoConfig } = await import('/src/runningHubVideo.ts');
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const source = '旅人沿廊桥向木门走去，然后推门进入。';
    const scene = { id: 'release151-scene', title: '廊桥', content: source, summary: source, characterIds: [], locationIds: [], propIds: [], storyboardIds: ['release151-board-1'], createdAt: now, updatedAt: now };
    const segments = Array.from({ length: 3 }, (_, index) => ({ id: `release151-segment-${index + 1}`, index: index + 1, title: `廊桥第${index + 1}段`, globalStartSec: index * 5, globalEndSec: (index + 1) * 5, durationSec: 5, content: source, summary: source, sourceSceneIds: [scene.id], sourceBeatIds: [], narrativePurpose: '进入木门', entryState: '', exitState: '', transitionHint: '', storyboardId: `release151-board-${index + 1}`, status: 'ready' }));
    const plan = { id: 'release151-plan', title: '隔离连续剧情', sourceStoryTitle: '廊桥', sourceStoryContent: source, durationMode: 'ai-estimated', totalDurationSec: 15, segmentDurationSec: 5, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const boards = segments.map((segment) => {
      const prompt = '【0s-5s】 主体：旅人沿廊桥向木门走去；空间：旅人在木门外；光影：自然光；镜头：中景固定；台词：无；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]';
      const board = { id: segment.storyboardId, sceneId: scene.id, sourceStoryTitle: '廊桥', sourceStoryContent: source, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', globalReferenceAssetIds: [], shots: [{ id: `release151-shot-${segment.index}`, index: 1, startSec: 0, endSec: 5, subject: '旅人', action: '沿廊桥走向木门', purpose: '进入木门', camera: '中景固定', transition: '自然承接', lighting: '自然光', sound: '', result: '抵达门口', referenceAssetIds: [], prompt, locked: false }], finalPrompt: prompt, targetModelId: 'minimax-h3', promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', stylePresetId: state.settings.defaultStylePresetId, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(prompt), shotPlanMode: 'ai-complete' }, sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, createdAt: now - segment.index, updatedAt: now - segment.index };
      return applyOfficialH3Prompt(board, { assets: [], characters: [], locations: [], props: [], sceneContent: source });
    });
    state.project = { ...state.project, id: 'release151-project', name: '新版隔离验证', sourceDocuments: [{ id: 'release151-source', name: '廊桥', content: source, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: boards, sequencePlans: [plan], assets: [], characters: [], locations: [], props: [], generationTasks: [], updatedAt: now };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[name].enabled = false;
    const workflow = createRunningHubTutorialVideoWorkflow();
    state.settings.runningHubVideo = { ...defaultRunningHubVideoConfig, enabled: true, apiKey: '', baseUrl: origin, workflows: [workflow], activeWorkflowId: workflow.id };
    state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api';
    state.ui = { ...state.ui, activeView: 'director' };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin });
  await page.reload({ waitUntil: 'networkidle' }); await nav('提示词导演台');
  await page.getByRole('button', { name: '单段直出', exact: true }).click();
  const count = page.getByLabel('自定义分镜图片数量', { exact: true });
  await count.waitFor();
  assert.match(await page.locator('.director-result-copy').innerText(), /integrated_multimodal_description:/u);
  assert.equal(await count.inputValue(), '');
  await page.getByRole('button', { name: '生成分镜图片（1张）', exact: true }).waitFor();
  await count.fill('3'); await waitSavedCount(3);
  await page.getByRole('button', { name: '生成分镜图片（3张）', exact: true }).waitFor();
  assert.equal((await stored()).project.storyboards[0].shots.length, 1);
  await screenshot('count-three-valid-h3');
  await page.reload({ waitUntil: 'networkidle' }); await nav('提示词导演台');
  await page.getByRole('button', { name: '单段直出', exact: true }).click();
  assert.equal(await count.inputValue(), '3');
  await count.fill('101');
  assert.equal(await count.getAttribute('aria-invalid'), 'true');
  assert.equal(await page.getByRole('button', { name: /^生成分镜图片/u }).isDisabled(), true);
  assert.equal((await stored()).project.storyboards[0].storyboardImageCount, 3);
  await count.fill('100'); await waitSavedCount(100);
  await page.getByRole('button', { name: '生成分镜图片（100张）', exact: true }).waitFor();
  await count.fill(''); await waitSavedCount(null);
  await page.getByRole('button', { name: '生成首尾帧图片（2张）', exact: true }).waitFor();
  steps.push('H3 rendered as H3; custom 1/3/100, invalid101, reload, clear, fixed two boundary frames; original shot unchanged');

  await nav('视频导演台'); await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.locator('.vd-batch-row').first().waitFor();
  assert.equal(await page.locator('.vd-batch-row').count(), 3);
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  await page.getByRole('button', { name: '第 2 段用上段尾帧', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await page.locator('.vd-batch-row').nth(1).innerText(), /AI/u);
  const bulk = page.getByRole('button', { name: '已选后续段自动衔接', exact: true });
  await bulk.click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await page.locator('.vd-batch-row').nth(2).innerText(), /AI/u);
  assert.equal(await page.getByText('直接使用原尾帧', { exact: false }).count(), 0);
  assert.equal((await stored()).project.generationTasks.length, 0);
  assert.equal(await page.evaluate(() => window.__release151Qa.mediaCalls), 0);
  await screenshot('oneclick-ai-tail-no-dialog');
  steps.push('row one-click and selected successors configure AI with no dialog, no raw-tail choice, no tasks/media requests');
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, mockOnly: true, noProductionDataRead: true, steps, errors, requests }, null, 2));
  console.log(`release151 UI passed: ${path.join(output, 'report.json')}`);
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, steps, errors, requests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
