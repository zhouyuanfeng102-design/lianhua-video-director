import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Use a fresh browser context and synthetic state only. No production data or API is read.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'character-voice-profile'));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const { createInitialState, normalizeState, STORAGE_KEY } = await tsImport('../src/storage.ts', import.meta.url);
const key = STORAGE_KEY;
const requestsKey = '__qa_voice_profile_bridge_calls';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the production dist bundle before running this QA');
const staticServerSource = `import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const base=${JSON.stringify(dist)};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
http.createServer((request,response)=>{try{const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);const target=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative)){response.writeHead(403);response.end();return;}const body=fs.readFileSync(target);response.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});response.end(body);}catch{response.writeHead(404);response.end();}}).listen(${port},'127.0.0.1',()=>console.log('Production bundle voice-profile QA ready'));`;
const server = spawn(process.execPath, ['--input-type=module', '-e', staticServerSource],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'character voice profile UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
const errors = [], blockedRequests = [], screenshots = [], results = [];
let browser, context, page;
const actorId = 'qa-voice-character-a', actorName = '甲人物';
const boardId = 'qa-voice-historical-board', taskId = 'qa-voice-historical-task';

const fixture = () => {
  const state = createInitialState(), now = Date.now(), chapterId = state.project.sourceDocuments[0].id;
  const story = '甲人物站在门廊前，平静地说：“请在这里等候。”';
  const actor = { ...state.project.characters[0], id: actorId, name: actorName, gender: '女性', apparentAge: '18岁',
    actualAge: '280岁', appearance: '年轻女性，短发，深色外套', outfit: '深色外套', assetIds: [] };
  delete actor.voiceProfile;
  const prompt = 'integrated_multimodal_description: [Shot 1] HOLD_OLD_BOARD 甲人物站在门廊前。<d>请在这里等候。</d>\noverall_soundscape: 微风。\nnon_diegetic_music: N/A';
  const board = { id: boardId, chapterId, sceneId: 'qa-voice-scene', sourceStoryTitle: '声音档案历史保留', sourceStoryContent: story,
    workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard',
    aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
    ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', globalReferenceAssetIds: [],
    shots: [{ id: 'qa-voice-shot', index: 1, startSec: 0, endSec: 5, purpose: '等待', subject: actorName, action: '站立说话', camera: '平视中景',
      lighting: '自然光', sound: '微风', transition: '自然结束', result: '保持站位', referenceAssetIds: [], prompt: story, locked: false }],
    finalPrompt: story, officialPromptZh: prompt, officialPromptEn: 'HOLD_OLD_EN: a young woman says, "Please wait here."',
    officialPromptEnSource: prompt, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now };
  state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: 'https://qa-text.invalid/v1/chat/completions', model: 'qa-text', apiKey: '' };
  state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
  state.settings.imageApi = { ...state.settings.imageApi, enabled: false, apiKey: '' };
  state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
  state.settings.visionApi = { ...state.settings.visionApi, enabled: false, apiKey: '' };
  state.settings.visionApiProfiles = []; state.settings.activeVisionApiProfileId = null;
  state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: false, provider: 'generic', baseUrl: 'https://qa-video.invalid', model: 'qa-video', apiKey: '' };
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
  const task = { id: taskId, kind: 'video', name: '既有声音成片快照', status: 'succeeded', model: 'qa-video', request: 'HOLD_OLD_REQUEST',
    createdAt: now, updatedAt: now, videoJob: { stage: 'succeeded', remoteGenerationEnded: true, snapshot: {
      projectId: 'qa-voice-project', clientId: 'qa-voice-frozen-client', images: [], audios: [],
      draft: { name: '既有声音成片', prompt: 'HOLD_OLD_VIDEO_SNAPSHOT: 甲人物说：“请在这里等候。”', backend: 'api', references: [], parameters: { duration: 5 } },
      connection: { backend: 'api', api: { ...state.settings.videoTaskApi, apiKey: undefined } },
    } } };
  state.project = { ...state.project, id: 'qa-voice-project', name: '人物声音档案隔离验证', activeChapterId: chapterId, chapterWorkspaces: {},
    sourceDocuments: [{ id: chapterId, name: '声音档案测试章', content: story, createdAt: now, updatedAt: now }], storyDraft: story,
    characters: [actor], locations: [], props: [], assets: [], generationTasks: [task], storyboards: [board], sequencePlans: [], voicePresets: undefined,
    scenes: [{ id: board.sceneId, chapterId, title: '门廊等待', content: story, summary: story, characterIds: [actorId], locationIds: [], propIds: [],
      storyboardIds: [boardId], createdAt: now, updatedAt: now }] };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  return normalizeState(state);
};

const capture = async (name) => {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: false }); screenshots.push(file);
};
const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null')?.project, key);
const readProfile = async () => (await readProject()).characters.find((actor) => actor.id === actorId)?.voiceProfile;
const waitSavedProfile = (version, absent = false) => page.waitForFunction(({ key, actorId, version, absent }) => {
  const profile = JSON.parse(localStorage.getItem(key) || 'null')?.project?.characters?.find((actor) => actor.id === actorId)?.voiceProfile;
  return absent ? !profile : profile?.version === version;
}, { key, actorId, version, absent }, { timeout: 15_000 });
const waitForApp = async (navigate) => {
  await navigate({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 45_000 });
};
const openVoiceEditor = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.getByRole('button', { name: /^实体资料/u }).click();
  await page.locator('.entity-detail-card').filter({ hasText: actorName }).click();
  const modal = page.locator('.entity-editor-modal');
  await modal.locator('h3').filter({ hasText: actorName }).waitFor();
  const editor = modal.locator('.character-voice-profile-editor');
  await editor.locator('summary').click();
  await editor.getByRole('textbox', { name: `${actorName}声音年龄`, exact: true }).waitFor();
  await editor.scrollIntoViewIfNeeded();
  return editor;
};
const historyOf = (project) => {
  const board = project.storyboards.find((item) => item.id === boardId);
  return { boardPrompts: Object.fromEntries(['finalPrompt', 'officialPromptZh', 'officialPromptEn', 'officialPromptEnSource',
    'seedance25Output', 'targetOutput', 'revisions'].filter((field) => field in board).map((field) => [field, board[field]])),
  videoSnapshot: project.generationTasks.find((item) => item.id === taskId)?.videoJob?.snapshot };
};

const run = async () => {
  await waitForCondition({ label: 'voice-profile QA static server', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({ key, state, requestsKey }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    window.lianhuaDesktop = {
      onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
      request: async (payload) => {
        const calls = JSON.parse(sessionStorage.getItem(requestsKey) || '[]');
        calls.push({ url: payload.url, method: payload.method || 'GET' }); sessionStorage.setItem(requestsKey, JSON.stringify(calls));
        throw new Error('Model/API requests are forbidden in the isolated voice-profile UI QA');
      },
    };
  }, { key, state: fixture(), requestsKey });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push({ url: `${url.origin}${url.pathname}`, method: request.method() }); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await waitForApp((options) => page.goto(baseUrl, options));
  let editor = await openVoiceEditor();
  assert.equal(await readProfile(), undefined, 'a young appearance and an old actual age do not infer a voice');
  const historical = historyOf(await readProject());
  assert.ok(historical.videoSnapshot, 'fixture must contain a frozen historical video snapshot');
  await editor.getByRole('textbox', { name: `${actorName}声音年龄`, exact: true }).fill('18—22岁的年轻女性');
  await editor.getByRole('textbox', { name: `${actorName}基础音色`, exact: true }).fill('清亮、轻盈，中高音区，咬字清楚');
  await editor.getByRole('button', { name: '保存声音档案', exact: true }).click();
  await waitSavedProfile(1);
  const first = await readProfile();
  assert.deepEqual(first, { version: 1, perceivedAge: '18—22岁的年轻女性', timbre: '清亮、轻盈，中高音区，咬字清楚', source: 'manual' });
  assert.deepEqual(historyOf(await readProject()), historical, 'saving a voice preserves authored board prompts and frozen videos');
  await capture('01-saved-voice-profile'); results.push({ case: 'save-explicit-profile', revision: 1, historicalRecordsUnchanged: true });

  await waitForApp((options) => page.reload(options)); editor = await openVoiceEditor();
  assert.equal(await editor.getByRole('textbox', { name: `${actorName}声音年龄`, exact: true }).inputValue(), first.perceivedAge);
  assert.equal(await editor.getByRole('textbox', { name: `${actorName}基础音色`, exact: true }).inputValue(), first.timbre);
  await editor.getByRole('textbox', { name: `${actorName}基础音色`, exact: true }).fill(` ${first.timbre} `);
  assert.equal(await editor.getByRole('button', { name: '保存声音档案', exact: true }).isDisabled(), true, 'same normalized content cannot create a new revision');
  assert.deepEqual(await readProfile(), first);
  assert.deepEqual(historyOf(await readProject()), historical);
  await capture('02-reloaded-and-no-op'); results.push({ case: 'reload-and-no-op', revision: 1 });

  await editor.getByRole('textbox', { name: `${actorName}基础音色`, exact: true }).fill('清亮、轻盈，声音细腻，保持年轻声线');
  await editor.getByRole('button', { name: '保存声音档案', exact: true }).click();
  await waitSavedProfile(2);
  assert.equal((await readProfile()).version, 2);
  assert.equal((await readProfile()).timbre, '清亮、轻盈，声音细腻，保持年轻声线');
  assert.deepEqual(historyOf(await readProject()), historical);
  await capture('03-edited-voice-revision-2'); results.push({ case: 'meaningful-change', revision: 2 });

  await editor.getByRole('button', { name: '清空声音档案', exact: true }).click(); await waitSavedProfile(undefined, true);
  await waitForApp((options) => page.reload(options)); editor = await openVoiceEditor();
  assert.equal(await readProfile(), undefined);
  for (const field of ['声音年龄', '基础音色', '对白语言', '口音', '稳定说话习惯', '声音一致性补充']) {
    assert.equal(await editor.getByRole('textbox', { name: `${actorName}${field}`, exact: true }).inputValue(), '');
  }
  const finalProject = await readProject();
  assert.equal(Object.hasOwn(finalProject.characters.find((actor) => actor.id === actorId), 'voiceProfile'), false);
  assert.deepEqual(historyOf(finalProject), historical, 'clearing and reloading never restores voices or rewrites historical prompts/tasks');
  const bridgeRequests = await page.evaluate((requestsKey) => JSON.parse(sessionStorage.getItem(requestsKey) || '[]'), requestsKey);
  assert.deepEqual(bridgeRequests, [], 'editing voices makes no model/API requests');
  assert.deepEqual(blockedRequests, [], 'no external HTTP request was attempted'); assert.deepEqual(errors, []);
  await capture('04-cleared-after-reload'); results.push({ case: 'clear-and-reload', noInferredVoice: true, historicalRecordsUnchanged: true });
  const report = { passed: true, mockOnly: true, productionDataRead: false, paidApiCalls: 0, bridgeRequests, blockedRequests,
    viewport: { width: 1366, height: 1000 }, results, screenshots, errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await capture('failure').catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => ''));
  }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, results, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'server.log'), harness.readElectronLog());
}
