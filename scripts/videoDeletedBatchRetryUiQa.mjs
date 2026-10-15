import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Full App/controller/engine/Worker with synthetic project persistence and a
// loopback-only desktop bridge. No user profile, real endpoint or paid call.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `video-deleted-batch-retry-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
// Ignore production build configuration in this dev-only fixture. The health
// probe bypasses HTML transformation; first HTML load gets one full 30s budget.
const bootstrap = `import {createServer} from 'vite'; import react from '@vitejs/plugin-react';
const server = await createServer({configFile:false,root:${JSON.stringify(root)},base:'/',plugins:[react(),{name:'qa-health',configureServer(server){server.middlewares.use('/__qa_ready',(_request,response)=>response.end('ready'));}}],optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','lucide-react']},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});
await server.listen(); console.log('Deleted batch retry isolated Vite ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'deleted batch explicit retry UI QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const checks = []; const errors = []; const blockedRequests = [];
const tasks = () => page.evaluate(() => {
  const saved = window.__deletedBatchQa.saved;
  const project = saved.project?.generationTasks ? saved.project : saved.projects.find((entry) => entry.id === saved.activeProjectId);
  return project.generationTasks.map((task) => ({ id: task.id, status: task.status, historyOnly: task.historyOnly,
    fingerprint: task.requestFingerprint, remoteTaskId: task.remoteTaskId, error: task.error,
    phase: task.videoJob?.preparation?.phase, stage: task.videoJob?.stage, stopped: task.videoJob?.trackingStopped,
    cancelled: task.videoJob?.cancellationConfirmed, remoteEnded: task.videoJob?.remoteGenerationEnded }));
});
const waitSaved = (check, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 100, check: async () => check(await tasks()) });
const posts = () => page.evaluate(() => window.__deletedBatchQa.posts);
const openTasks = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.getByRole('tab', { name: /视频任务/u }).click();
};
const openDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByLabel('批量提示词格式', { exact: true }).selectOption('ordinary');
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
};
const summary = () => page.locator('.vd-batch-summary > strong');
const waitSummary = (text) => waitForCondition({ label: text, timeoutMs: 10_000, intervalMs: 100, check: async () => await summary().innerText() === text });
const settled = () => waitForCondition({ label: 'synthetic persistence settled', timeoutMs: 15_000, intervalMs: 100,
  check: async () => page.evaluate(() => window.__deletedBatchQa.saveActive === 0) });

const run = async () => {
  await waitForCondition({ label: 'minimal Vite health endpoint', timeoutMs: 15_000, intervalMs: 150,
    check: async () => { try { return (await fetch(`${baseUrl}__qa_ready`, { signal: AbortSignal.timeout(3_000) })).ok; } catch { return false; } } });
  checks.push('Minimal Vite config starts; health checks do not repeatedly abort the first HTML transform');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1430, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.addInitScript(({ origin }) => {
    const key = '__deleted_batch_qa_saved__';
    if (!sessionStorage.getItem('__deleted_batch_qa_started__')) {
      localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__deleted_batch_qa_started__', '1');
    }
    const initial = sessionStorage.getItem(key);
    const qa = window.__deletedBatchQa = { input: initial, saved: initial ? JSON.parse(initial) : null,
      loads: [], saveActive: 0, posts: JSON.parse(sessionStorage.getItem('__deleted_batch_qa_posts__') || '[]'),
      requests: [], cancelledRequests: 0, credentials: {},
      checkpoints: JSON.parse(sessionStorage.getItem('__deleted_batch_qa_checkpoints__') || '{}') };
    const persistCheckpoints = () => sessionStorage.setItem('__deleted_batch_qa_checkpoints__', JSON.stringify(qa.checkpoints));
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      loadState: async () => qa.input || new Promise((resolve) => qa.loads.push(resolve)),
      saveState: async (serialized) => {
        qa.saveActive++;
        try { qa.saved = JSON.parse(serialized); sessionStorage.setItem(key, serialized); return { ok: true }; }
        finally { qa.saveActive--; }
      },
      videoRequest: async (request) => {
        if (new URL(request.url).origin !== origin) throw new Error('QA rejected non-local video request');
        const method = request.method || 'GET'; qa.requests.push({ method, url: request.url });
        if (method === 'POST') {
          qa.posts.push({ body: request.body, url: request.url });
          sessionStorage.setItem('__deleted_batch_qa_posts__', JSON.stringify(qa.posts));
          return json({ id: `explicit-new-${qa.posts.length}`, status: 'queued' });
        }
        return json({ id: request.url.split('/').at(-1), status: 'queued', progress: 0 });
      },
      cancelVideoRequest: async () => { qa.cancelledRequests++; return true; },
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { qa.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (id) => qa.credentials[id] || null,
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints[task.id] = structuredClone(task); persistCheckpoints(); return { persisted: true }; },
      getVideoTaskCheckpoint: async (id) => structuredClone(qa.checkpoints[id] || null),
      deleteVideoTaskCheckpoint: async (id) => { delete qa.checkpoints[id]; persistCheckpoints(); return { deleted: true }; },
      downloadGeneratedMedia: async () => { throw new Error('Queued fixture must not download media'); },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin: new URL(baseUrl).origin });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const fixture = await page.evaluate(({ base }) => {
    window.__deletedBatchQa.fixturePromise = (async () => {
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { buildVideoBatchRows } = await import('/src/videoBatch.ts');
    const state = createInitialState(); const now = Date.now();
    Object.assign(state.settings, { videoBackend: 'api', activeVideoApiProfileId: null, videoApiProfiles: [],
      videoExecutionMode: 'concurrent', videoExecutionConcurrency: 3,
      videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'deleted-retry-qa',
        endpoint: `${base}qa-video`, statusEndpointTemplate: `${base}qa-video/{id}`, apiKey: '',
        taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result.url', progressPath: 'progress', requestTemplate: '' } });
    const segments = [1, 2, 3].map((index) => ({ id: `retry-segment-${index}`, index, title: `隔离剧情 ${index}`,
      globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10,
      content: `第${index}段隔离剧情`, summary: '仅验证本地删除后的主动新生成', sourceSceneIds: ['retry-scene'], sourceBeatIds: [],
      narrativePurpose: '推进剧情', entryState: '动作开始', exitState: '动作完成', transitionHint: '连续',
      storyboardId: `retry-board-${index}`, status: 'ready' }));
    const plan = { id: 'retry-plan', title: '三段删除后主动生成验证', sourceStoryTitle: '三段隔离剧情', sourceStoryContent: '仅测试数据',
      durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 10, segmentationMode: 'natural', segmentationSource: 'ai',
      fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const storyboards = segments.map((segment) => {
      const prompt = `【0s-10s】主体：第${segment.index}段人物；动作：向前一步并完成动作；镜头：中景跟拍；光线：自然光；声音：环境声。`;
      const english = `Subject: segment ${segment.index}; one continuous step; medium tracking camera; natural light; ambient sound.`;
      return { id: segment.storyboardId, sceneId: 'retry-scene', sourceStoryTitle: plan.sourceStoryTitle,
        workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1,
        pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
        stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom',
        globalLock: '', globalReferenceAssetIds: [], finalPrompt: prompt, englishPrompt: english, englishPromptSource: prompt,
        officialPromptZh: prompt, officialPromptEn: english, officialPromptSource: prompt, officialPromptEnSource: prompt, promptMigrationPending: false,
        promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', stylePresetId: state.settings.defaultStylePresetId,
          sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(prompt), shotPlanMode: 'ai-complete' },
        shots: [{ id: `retry-shot-${segment.index}`, index: 1, startSec: 0, endSec: 10, purpose: '推进', subject: '人物', action: '迈步', camera: '跟拍',
          transition: '连续', lighting: '自然光', sound: '环境声', result: '动作完成', referenceAssetIds: [], prompt, locked: false }],
        sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, createdAt: now, updatedAt: now };
    });
    const project = { ...state.project, id: 'deleted-retry-project', name: '隔离删除重生成验证', assets: [], characters: [], locations: [], props: [],
      sourceDocuments: [], scenes: [{ id: 'retry-scene', title: '隔离场景', content: '仅测试数据', summary: '三段剧情', characterIds: [], propIds: [],
        storyboardIds: storyboards.map((board) => board.id), createdAt: now, updatedAt: now }], sequencePlans: [plan], storyboards, generationTasks: [] };
    const rows = buildVideoBatchRows(project, plan, state.settings, { promptFormat: 'ordinary' });
    project.generationTasks = rows.map((row, offset) => ({ id: `old-524-${offset + 1}`, kind: 'video', storyboardId: row.storyboardId,
      sequencePlanId: plan.id, segmentId: row.segmentId, segmentIndex: row.segmentIndex, targetId: 'deleted-retry-qa',
      status: 'unknown', error: '接口返回错误（HTTP 524）。', requestBody: { prompt: row.zh.draft.prompt }, requestFingerprint: row.zh.requestFingerprint,
      batchId: 'old-524-batch', batchLabel: 'HTTP 524 后停止追踪', batchItemKey: row.zh.key, batchIndex: offset + 1, batchTotal: 3, batchConcurrency: 3,
      createdAt: now - 10_000, updatedAt: now - 5_000,
      videoJob: { stage: 'stopped', trackingStopped: true, batchQueueState: 'cancelled', cancellationConfirmed: false,
        preparation: { version: 1, phase: 'post-started', uploadedImages: [] },
        snapshot: { projectId: project.id, clientId: `old-client-${offset + 1}`, draft: structuredClone(row.zh.draft),
          connection: { backend: 'api', api: state.settings.videoTaskApi }, images: [] } } }));
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    const qa = window.__deletedBatchQa; qa.saved = structuredClone(state); qa.input = JSON.stringify(state);
    project.generationTasks.forEach((task) => { qa.checkpoints[task.id] = structuredClone(task); });
    return { rows: rows.length, oldIds: project.generationTasks.map((task) => task.id), fingerprints: rows.map((row) => row.zh.requestFingerprint) };
    })();
    return window.__deletedBatchQa.fixturePromise;
  }, { base: baseUrl });
  assert.equal(fixture.rows, 3);
  await page.evaluate(() => { const qa = window.__deletedBatchQa; qa.loads.splice(0).forEach((resolve) => resolve(qa.input)); });
  await page.locator('.sidebar').waitFor(); await openTasks();
  const oldBatch = page.locator('[data-video-batch-id="old-524-batch"]');
  await oldBatch.waitFor(); assert.match(await oldBatch.innerText(), /已停止 3/u);
  const oldTasks = (await tasks()).filter((task) => task.id.startsWith('old-524-'));
  assert.equal(await oldBatch.getByRole('button', { name: '删除批次', exact: true }).isEnabled(), true);
  await oldBatch.getByRole('button', { name: '删除批次', exact: true }).click();
  await oldBatch.waitFor({ state: 'detached' });
  await waitSaved((saved) => saved.length === 3 && saved.every((task) => task.historyOnly), 'three original unknown tasks preserved as hidden history');
  assert.deepEqual(await tasks(), oldTasks.map((task) => ({ ...task, historyOnly: true })));
  assert.equal(await page.getByRole('tab', { name: /视频任务/u }).locator('.generation-task-count').innerText(), '0');
  assert.equal((await posts()).length, 0);
  checks.push('Real delete-batch action leaves video task count 0 while retaining exact unknown/post-started HTTP 524 originals');

  await openDirector();
  await waitSummary('已选 3 段 · 待提交 3 段 · 跳过 0 段');
  assert.equal(await page.locator('.vd-batch-row').filter({ hasText: '已在队列，将跳过' }).count(), 0);
  await page.getByLabel('重新生成已成功项', { exact: true }).check();
  await waitSummary('已选 3 段 · 待提交 3 段 · 跳过 0 段');
  await page.getByLabel('重新生成已成功项', { exact: true }).uncheck();
  assert.equal((await posts()).length, 0);
  await page.screenshot({ path: path.join(output, 'deleted-history-three-pending.png'), fullPage: false });
  await settled(); await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('.sidebar').waitFor(); await openDirector();
  await waitSummary('已选 3 段 · 待提交 3 段 · 跳过 0 段');
  assert.deepEqual(await tasks(), oldTasks.map((task) => ({ ...task, historyOnly: true })));
  assert.equal((await posts()).length, 0);
  checks.push('Director shows selected 3 / pending 3 / skipped 0, including after complete App reload, without a generation POST');

  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await confirmation.waitFor();
  assert.equal(await confirmation.getByLabel('确认批量生成费用', { exact: true }).isChecked(), false);
  const confirm = confirmation.getByRole('button', { name: '确认生成 3 段', exact: true });
  assert.equal(await confirm.isDisabled(), true); assert.equal((await posts()).length, 0);
  await confirmation.getByLabel('确认批量生成费用', { exact: true }).check();
  assert.equal((await posts()).length, 0, 'checking acknowledgement alone does not submit');
  await confirm.click();
  await waitForCondition({ label: 'exactly three explicit mock generation POSTs', timeoutMs: 20_000, intervalMs: 100,
    check: async () => (await posts()).length === 3 });
  await waitSaved((saved) => saved.filter((task) => !task.historyOnly && task.remoteTaskId).length === 3, 'all three new tasks receive their own mock remote IDs');
  const after = await tasks();
  assert.deepEqual(after.filter((task) => task.id.startsWith('old-524-')), oldTasks.map((task) => ({ ...task, historyOnly: true })));
  assert.equal(new Set(after.filter((task) => !task.historyOnly).map((task) => task.remoteTaskId)).size, 3);
  assert.deepEqual(after.filter((task) => !task.historyOnly).map((task) => task.fingerprint).sort(), [...fixture.fingerprints].sort());
  checks.push('Fee confirmation plus explicit confirm creates exactly three new mock POSTs with new identities; unresolved original records remain unchanged');

  await openDirector(); await waitSummary('已选 3 段 · 待提交 0 段 · 跳过 3 段');
  await page.getByLabel('重新生成已成功项', { exact: true }).check();
  await waitSummary('已选 3 段 · 待提交 0 段 · 跳过 3 段');
  assert.equal(await page.getByRole('button', { name: '检查并生成 0 段视频', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'active-three-still-deduplicated.png'), fullPage: false });
  await settled(); await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('.sidebar').waitFor(); await openDirector();
  await waitSummary('已选 3 段 · 待提交 0 段 · 跳过 3 段');
  assert.equal((await posts()).length, 3);
  assert.equal(await page.evaluate(() => window.__deletedBatchQa.cancelledRequests), 0);
  assert.deepEqual((await tasks()).filter((task) => task.id.startsWith('old-524-')), oldTasks.map((task) => ({ ...task, historyOnly: true })));
  checks.push('Three active tasks with the same fingerprints still block resubmission even when regenerate-success is enabled; complete reload adds no POST or cancellation');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, mockOnly: true, noProductionDataRead: true,
    fixture, checks, posts: await posts(), tasks: await tasks(), errors, blockedRequests }, null, 2));
  console.log(`Deleted batch explicit retry UI QA passed. Report: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const body = page ? await page.locator('body').innerText().catch(() => '') : '';
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blockedRequests, body, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
