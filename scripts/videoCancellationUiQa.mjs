import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App, React, controller, engine and storage Worker. Only the desktop I/O
// bridge is replaced. All records are synthetic and no external request is allowed.
const root = path.resolve(import.meta.dirname, '..');
const batchDeletionMode = process.argv.includes('--batch-delete');
const libraryMiB = Number(process.env.QA_LIBRARY_MIB || 8);
if (!Number.isFinite(libraryMiB) || libraryMiB < 0 || libraryMiB > 200) throw new Error('QA_LIBRARY_MIB must be between 0 and 200');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `video-${batchDeletionMode ? 'batch-deletion' : 'cancellation'}-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cancellation QA output must stay below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'video cancellation UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const blockedRequests = []; const checks = []; const layouts = []; const screenshots = [];
const card = (id) => page.locator(`[data-video-task-id="${id}"]`);
const tasksFromSaved = () => page.evaluate(() => {
  const saved = window.__cancelQa.saved;
  if (!saved) return [];
  const project = saved.project.generationTasks ? saved.project : saved.projects.find((entry) => entry.id === saved.activeProjectId);
  return project.generationTasks.map((task) => ({ id: task.id, remoteTaskId: task.remoteTaskId, status: task.status,
    stage: task.videoJob?.stage, stopped: task.videoJob?.trackingStopped, queue: task.videoJob?.batchQueueState,
    cancelled: task.videoJob?.cancellationConfirmed, historyOnly: task.historyOnly, continuation: task.videoJob?.batchContinuation }));
});
const waitSaved = async (predicate, label) => waitForCondition({ label, timeoutMs: 20_000, intervalMs: 100, check: async () => predicate(await tasksFromSaved()) });
const openTasks = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.getByRole('tab', { name: /视频任务/u }).click();
  await page.locator('.jobs-view').waitFor();
};

const run = async () => {
  await waitForCondition({ label: 'cancellation QA Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1430, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.addInitScript(({ origin, batchDeletionMode }) => {
    const reloadState = batchDeletionMode ? sessionStorage.getItem('__batch_deletion_saved_state__') : null;
    const priorCounts = reloadState ? JSON.parse(sessionStorage.getItem('__batch_deletion_counts__') || '{}') : {};
    if (!reloadState) { localStorage.clear(); sessionStorage.clear(); }
    const qa = window.__cancelQa = { checkpoints: {}, credentials: {}, loads: [], saved: null, input: null,
      requests: [], posts: 0, cancelledRequests: 0, saveCalls: 0, saveActive: 0, maxSaveActive: 0,
      encoderPosts: 0, encoderActive: 0, maxEncoderActive: 0, postsWhileSaveActive: 0, saveDelayMs: 0, ...priorCounts };
    if (reloadState) { qa.input = reloadState; qa.saved = JSON.parse(reloadState); }
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.isEncoder = options?.name === 'lianhua-state-encoder';
        if (this.isEncoder) this.addEventListener('message', () => { qa.encoderActive--; });
      }
      postMessage(value, ...rest) {
        if (this.isEncoder) {
          qa.encoderPosts++; qa.encoderActive++; qa.maxEncoderActive = Math.max(qa.maxEncoderActive, qa.encoderActive);
          if (qa.saveActive) qa.postsWhileSaveActive++;
        }
        return super.postMessage(value, ...rest);
      }
    };
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      loadState: async () => qa.input || new Promise((resolve) => qa.loads.push(resolve)),
      saveState: async (serialized) => {
        qa.saveCalls++; qa.saveActive++; qa.maxSaveActive = Math.max(qa.maxSaveActive, qa.saveActive);
        try {
          await new Promise((resolve) => setTimeout(resolve, qa.saveDelayMs));
          // Native persistence runs in another process. The fixture keeps only
          // task evidence, so its own archive copy does not inflate renderer RSS.
          const saved = JSON.parse(serialized, (key, value) => key === 'content' && typeof value === 'string' && value.length > 20_000 ? '[omitted synthetic archive]' : value);
          if (batchDeletionMode) sessionStorage.setItem('__batch_deletion_saved_state__', JSON.stringify(saved));
          const active = saved.project.generationTasks ? saved.project : saved.projects.find((entry) => entry.id === saved.activeProjectId);
          qa.saved = { project: { generationTasks: active.generationTasks, assets: active.assets } };
          return { ok: true, checksum: `qa-${qa.saveCalls}` };
        }
        finally { qa.saveActive--; }
      },
      videoRequest: async (request) => {
        if (!request.url.startsWith(origin)) throw new Error('Synthetic bridge rejected non-local video URL');
        qa.requests.push({ method: request.method || 'GET', url: request.url });
        if ((request.method || 'GET') === 'POST') { qa.posts++; throw new Error('Cancellation QA must not submit generation'); }
        return json({ id: request.url.split('/').at(-1), status: 'running', progress: 20 });
      },
      cancelVideoRequest: async () => { qa.cancelledRequests++; return true; },
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { qa.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (id) => qa.credentials[id] || null,
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints[task.id] = structuredClone(task); return { persisted: true }; },
      getVideoTaskCheckpoint: async (id) => structuredClone(qa.checkpoints[id] || null),
      deleteVideoTaskCheckpoint: async (id) => { delete qa.checkpoints[id]; return { deleted: true }; },
      downloadGeneratedMedia: async () => { throw new Error('Cancellation QA must not download media'); },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin: new URL(baseUrl).origin, batchDeletionMode });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  const fixture = await page.evaluate(({ base, libraryMiB, batchDeletionMode }) => {
    window.__cancelQa.fixturePromise = (async () => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const api = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', apiKey: '', model: 'cancellation-qa',
      endpoint: `${base}qa/generate`, statusEndpointTemplate: `${base}qa/tasks/{id}`, taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
    Object.assign(state.settings, { videoTaskApi: api, videoExecutionMode: 'queue', videoExecutionConcurrency: 1 });
    const project = { ...state.project, id: 'cancel-project', name: '取消任务隔离验证', assets: [], generationTasks: [] };
    const task = (id, running, batchIndex) => ({ id, kind: 'video', storyboardId: '', targetId: 'cancellation-qa',
      status: running ? 'running' : 'draft', ...(running ? { remoteTaskId: `remote-${id}` } : {}), requestBody: {},
      createdAt: now - 1000, updatedAt: now,
      ...(batchIndex ? { batchId: 'cancel-batch', batchLabel: '尚未提交批次', batchIndex, batchTotal: 3 } : {}),
      videoJob: { stage: running ? 'running' : 'queued', startedAt: running ? now - 1000 : undefined,
        ...(batchIndex ? { batchQueueState: 'ready' } : {}),
        preparation: { version: 1, phase: running ? 'acknowledged' : 'preparing', uploadedImages: [] },
        snapshot: { projectId: project.id, clientId: `client-${id}`, images: [],
          connection: { backend: 'api', api }, draft: { name: `取消验证 ${id}`, backend: 'api', prompt: '仅测试取消流程', references: [], parameters: {} } } } });
    project.generationTasks = [1, 2, 3, 4].map((index) => task(`running-${index}`, true))
      .concat(task('local-queued', false), [1, 2, 3].map((index) => task(`batch-${index}`, false, index)));
    if (batchDeletionMode) {
      const active = project.generationTasks.find((entry) => entry.id === 'running-4');
      Object.assign(active, { batchId: 'active-batch', batchLabel: '仍在运行的其它批次', batchIndex: 1, batchTotal: 1, requestFingerprint: 'fingerprint-active' });
      const ancestor = (id, batchId, next) => {
        const stopped = task(id, false);
        Object.assign(stopped, { batchId, batchLabel: `已停止的旧批次 ${id}`, batchIndex: 1, batchTotal: 1, requestFingerprint: `fingerprint-${id}` });
        Object.assign(stopped.videoJob, { stage: 'stopped', batchQueueState: 'cancelled', trackingStopped: true, cancellationConfirmed: true,
          batchContinuation: { version: 1, planId: `plan-${id}`, batchId: next.batchId, taskId: next.id, revision: 1 } });
        stopped.videoJob.snapshot.batchCompletionOrder = true;
        next.videoJob.snapshot.continuedFrom = { version: 1, planId: `plan-${id}`, batchId, taskId: id, requestFingerprint: stopped.requestFingerprint };
        return stopped;
      };
      const intermediate = ancestor('ancestor-b', 'ancestor-batch-b', active);
      const oldest = ancestor('ancestor-a', 'ancestor-batch-a', intermediate);
      project.generationTasks.push(oldest, intermediate);
      const success = task('batch-success', true, 4);
      Object.assign(success, { status: 'succeeded', resultAssetId: 'batch-result-video' });
      Object.assign(success.videoJob, { stage: 'succeeded', batchQueueState: 'done', generatedAt: now, completedAt: now, remoteGenerationEnded: true });
      project.generationTasks.push(success);
      project.generationTasks.filter((entry) => entry.batchId === 'cancel-batch').forEach((entry) => {
        entry.batchTotal = 4; entry.batchLabel = '完成与待提交混合批次';
      });
      project.assets.push({ id: 'batch-result-video', name: '批次已生成视频', fileName: 'batch-result.mp4', type: 'video', mediaType: 'video',
        mimeType: 'video/mp4', source: 'generated', sourceVideoTaskId: success.id, relativePath: 'video/batch-result.mp4',
        checksum: 'synthetic-video-checksum', sizeBytes: 8, managed: true, missing: false, tags: [], createdAt: now, updatedAt: now });
    }
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    // A modest synthetic library exercises the actual Worker and persistence path.
    state.projects.push(...Array.from({ length: 24 }, (_, index) => ({ ...project, id: `archive-${index}`, name: `合成归档 ${index}`,
      generationTasks: [], assets: [], storyDraft: { name: `合成压力文本 ${index}`, content: `${index}:${'合'.repeat(Math.floor(libraryMiB * 1024 * 1024 / 24 / 3))}`, updatedAt: now } })));
    const qa = window.__cancelQa;
    for (const entry of project.generationTasks) qa.checkpoints[entry.id] = structuredClone(entry);
    qa.input = JSON.stringify(state); qa.saved = { project: { generationTasks: structuredClone(project.generationTasks), assets: structuredClone(project.assets) } };
    return { tasks: project.generationTasks.length, projects: state.projects.length, requestedLibraryMiB: libraryMiB, bytes: new TextEncoder().encode(qa.input).length };
    })();
    return window.__cancelQa.fixturePromise;
  }, { base: baseUrl, libraryMiB, batchDeletionMode });
  await page.evaluate(() => { const qa = window.__cancelQa; qa.loads.splice(0).forEach((resolve) => resolve(qa.input)); });
  await page.locator('.sidebar').waitFor(); await openTasks();
  await card('running-1').waitFor();
  if (batchDeletionMode) {
    for (const batchId of ['active-batch', 'cancel-batch']) {
      const batch = page.locator(`[data-video-batch-id="${batchId}"]`);
      const deletion = batch.getByRole('button', { name: '删除批次', exact: true });
      assert.equal(await deletion.isDisabled(), true, 'active or queued batch deletion must be disabled');
      assert.ok((await deletion.getAttribute('title'))?.trim(), 'disabled deletion explains why in its title');
      const note = batch.locator('[data-video-batch-delete-reason]');
      assert.equal(await note.isVisible(), true, 'delete restriction is visible without hovering a disabled control');
      assert.equal(await note.innerText(), await deletion.getAttribute('title'));
    }
    checks.push('Delete-batch buttons remain visible but disabled with visible explanations for running and queued batches');
  }
  await waitForCondition({ label: 'initial save settled', timeoutMs: 20_000, intervalMs: 100,
    check: async () => page.evaluate(() => window.__cancelQa.saveActive === 0 && window.__cancelQa.encoderActive === 0) });
  await page.evaluate(() => { const qa = window.__cancelQa; qa.input = null; qa.saveDelayMs = 1000; qa.encoderPosts = 0; qa.maxEncoderActive = 0; qa.postsWhileSaveActive = 0; qa.saveCalls = 0; });

  if (batchDeletionMode) {
    const batchA = page.locator('[data-video-batch-id="ancestor-batch-a"]');
    const batchB = page.locator('[data-video-batch-id="ancestor-batch-b"]');
    const deleteA = batchA.getByRole('button', { name: '删除批次', exact: true });
    const deleteB = batchB.getByRole('button', { name: '删除批次', exact: true });
    const count = () => page.getByRole('tab', { name: /视频任务/u }).locator('.generation-task-count').innerText();
    const before = await tasksFromSaved();
    const childBefore = before.find((entry) => entry.id === 'running-4');
    assert.equal(await count(), '11');
    assert.equal(await deleteA.isEnabled(), true, 'stopped ancestor A is deletable while descendant C runs');
    assert.equal(await deleteB.isEnabled(), true, 'stopped middle batch B is deletable while descendant C runs');
    await deleteB.click(); await batchB.waitFor({ state: 'detached' });
    await waitSaved((saved) => saved.find((entry) => entry.id === 'ancestor-b')?.historyOnly, 'middle ancestor retained only as hidden provenance');
    assert.equal(await count(), '10', 'hidden ancestor is excluded from the visible task count');
    assert.equal(await deleteA.isEnabled(), true, 'deleting the middle ancestor does not strand the oldest ancestor');
    assert.deepEqual((await tasksFromSaved()).find((entry) => entry.id === 'running-4'), childBefore, 'active descendant state remains intact');
    await page.getByRole('button', { name: '撤销（Ctrl+Z）', exact: true }).click();
    await batchB.waitFor();
    await waitSaved((saved) => !saved.find((entry) => entry.id === 'ancestor-b')?.historyOnly, 'undo restores the original visible middle ancestor');
    assert.equal(await count(), '11');
    assert.deepEqual((await tasksFromSaved()).filter((entry) => entry.id.startsWith('ancestor-')), before.filter((entry) => entry.id.startsWith('ancestor-')),
      'undo preserves stopped states and exact continuation claims');
    await deleteA.click(); await batchA.waitFor({ state: 'detached' });
    await deleteB.click(); await batchB.waitFor({ state: 'detached' });
    await waitSaved((saved) => ['ancestor-a', 'ancestor-b'].every((id) => saved.find((entry) => entry.id === id)?.historyOnly), 'both stopped ancestors hidden durably');
    assert.equal(await count(), '9');
    assert.deepEqual((await tasksFromSaved()).find((entry) => entry.id === 'running-4'), childBefore);
    assert.equal(await page.locator('[data-video-batch-id="active-batch"]').count(), 1);
    assert.equal(await page.evaluate(() => window.__cancelQa.posts), 0);
    checks.push('A→B→C active chain: delete B, undo, then delete A/B hides old cards and updates counts while preserving exact continuation lineage and active C without POST');
    const runningBatch = page.locator('[data-video-batch-id="active-batch"]');
    await runningBatch.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'batch-delete-disabled-reason.png'), fullPage: false });
    screenshots.push('batch-delete-disabled-reason.png');
  }

  // Exercise the task-card button, then the separate GenerationTasksView action.
  await card('running-1').getByRole('button', { name: '停止 / 取消本任务', exact: true }).click();
  await page.waitForFunction(() => window.__cancelQa.saveActive > 0);
  await card('running-2').locator('xpath=following-sibling::*[1]').getByRole('button').click();
  await card('running-3').getByRole('button', { name: '停止 / 取消本任务', exact: true }).click();
  await waitSaved((tasks) => [1, 2, 3].every((index) => tasks.find((entry) => entry.id === `running-${index}`)?.stopped), 'three submitted cancellations persisted');
  for (const id of ['running-1', 'running-2', 'running-3']) {
    assert.match(await card(id).innerText(), /已停止/u);
    assert.ok(await card(id).getByRole('button', { name: '恢复查询原任务', exact: true }).isVisible());
  }
  let tasks = await tasksFromSaved();
  for (let index = 1; index <= 3; index++) assert.equal(tasks.find((entry) => entry.id === `running-${index}`).remoteTaskId, `remote-running-${index}`);
  assert.equal(tasks.find((entry) => entry.id === 'running-4').stopped, undefined);
  checks.push('Both real cancellation controls stop three submitted tasks during delayed saves and retain their remote IDs; fourth running task unaffected');

  await card('local-queued').locator('xpath=following-sibling::*[1]').getByRole('button').click();
  await card('local-queued').waitFor({ state: 'detached' });
  await waitSaved((saved) => !saved.some((entry) => entry.id === 'local-queued'), 'unsubmitted cancellation and deletion persisted');
  checks.push('Queued-only delete waits for confirmed cancellation then removes only that record without POST');

  const batch = page.locator('[data-video-batch-id="cancel-batch"]');
  const stopBatch = batch.getByRole('button', { name: /^停止此批次中 3 个尚未提交的任务/u });
  assert.match(await stopBatch.innerText(), /3/u);
  await stopBatch.click();
  await waitSaved((saved) => [1, 2, 3].every((index) => saved.find((entry) => entry.id === `batch-${index}`)?.queue === 'cancelled'), 'batch cancellations persisted');
  assert.match(await batch.innerText(), /已停止 3/u);
  checks.push('Stop-unsubmitted batch action stops all three original rows and keeps records');
  if (batchDeletionMode) {
    assert.match(await batch.innerText(), /成功 1/u);
    const deletion = batch.getByRole('button', { name: '删除批次', exact: true });
    assert.equal(await deletion.isEnabled(), true, 'the whole stopped/successful batch becomes deletable');
    assert.equal(await batch.locator('[data-video-batch-delete-reason]').count(), 0, 'stopped batch does not retain a stale delete restriction');
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
      await page.setViewportSize(viewport); await deletion.scrollIntoViewIfNeeded();
      const layout = await deletion.evaluate((element) => {
        const button = element.getBoundingClientRect(); const card = element.closest('[data-video-batch-id]').getBoundingClientRect();
        const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
        return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
          button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom },
          card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
          unobscured: hit === element || element.contains(hit) };
      });
      assert.ok(layout.scrollWidth <= viewport.width + 1, 'batch deletion layout must not overflow horizontally');
      assert.ok(layout.button.left >= 0 && layout.button.right <= viewport.width + 1 && layout.button.top >= 0 && layout.button.bottom <= viewport.height + 1);
      assert.ok(layout.card.right - layout.button.right <= 32 && layout.card.bottom - layout.button.bottom <= 32, 'delete control stays in the card bottom-right footer');
      assert.equal(layout.unobscured, true, 'delete control is visible and receives pointer hits');
      layouts.push(layout);
      const screenshot = `batch-delete-ready-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: path.join(output, screenshot), fullPage: false }); screenshots.push(screenshot);
    }
    const terminalBatch = (await tasksFromSaved()).filter((entry) => /^batch-/u.test(entry.id));
    await deletion.click();
    await batch.waitFor({ state: 'detached' });
    await waitSaved((saved) => !saved.some((entry) => /^batch-/u.test(entry.id)), 'all records in stopped/completed batch deleted durably');
    const asset = await page.evaluate(() => window.__cancelQa.saved.project.assets.find((entry) => entry.id === 'batch-result-video'));
    assert.ok(asset, 'deleting batch records retains the completed video asset');
    assert.equal(asset.relativePath, 'video/batch-result.mp4');
    assert.equal(asset.checksum, 'synthetic-video-checksum');
    assert.equal(asset.sourceVideoTaskId, 'batch-success');
    assert.equal(asset.videoSourceTask?.id, 'batch-success', 'video retains its original generation provenance after deleting its task');
    const otherTasks = await tasksFromSaved();
    assert.deepEqual(otherTasks.filter((entry) => !entry.historyOnly).map((entry) => entry.id).sort(), ['running-1', 'running-2', 'running-3', 'running-4']);
    assert.equal(otherTasks.find((entry) => entry.id === 'running-4').stopped, undefined);
    assert.equal(await page.locator('[data-video-batch-id="active-batch"]').getByRole('button', { name: '删除批次', exact: true }).isDisabled(), true);
    checks.push('Delete-batch removes all four stopped/completed records atomically, retains generated video and its provenance, and preserves other batch/task records');
    await page.getByRole('button', { name: '撤销（Ctrl+Z）', exact: true }).click();
    await batch.waitFor();
    await waitSaved((saved) => saved.filter((entry) => /^batch-/u.test(entry.id)).length === 4, 'undo restored terminal batch durably');
    assert.deepEqual((await tasksFromSaved()).filter((entry) => /^batch-/u.test(entry.id)), terminalBatch, 'undo restores the exact stopped/successful states, never runnable copies');
    assert.equal(await page.evaluate(() => window.__cancelQa.posts), 0, 'undo must not resubmit any restored task');
    await batch.getByRole('button', { name: '删除批次', exact: true }).click();
    await batch.waitFor({ state: 'detached' });
    await waitSaved((saved) => !saved.some((entry) => /^batch-/u.test(entry.id)), 'second batch deletion persisted after undo');
    checks.push('Real topbar undo restores all four original terminal records without POST; a second delete removes them again');
  }

  await page.locator('.sidebar').getByRole('button', { name: '项目总览', exact: true }).click();
  assert.equal(await page.locator('.jobs-view').count(), 0);
  await openTasks(); await card('running-1').waitFor();
  if (batchDeletionMode) {
    assert.equal(await page.locator('[data-video-batch-id="cancel-batch"]').count(), 0);
    assert.equal(await page.locator('[data-video-batch-id="active-batch"]').count(), 1);
    checks.push('Deleted batch stays absent after saving and navigation away/back while the running batch remains');
  }
  assert.equal(await page.getByText('莲华视频导演台界面加载失败', { exact: true }).count(), 0);
  checks.push('After all cancellations the full app navigates away and back with task cards intact');
  await waitForCondition({ label: 'final persistence settled', timeoutMs: 20_000, intervalMs: 100,
    check: async () => page.evaluate(() => window.__cancelQa.saveActive === 0 && window.__cancelQa.encoderActive === 0) });
  if (batchDeletionMode) {
    await page.evaluate(() => {
      const qa = window.__cancelQa;
      sessionStorage.setItem('__batch_deletion_counts__', JSON.stringify({ requests: qa.requests, posts: qa.posts,
        cancelledRequests: qa.cancelledRequests, saveCalls: qa.saveCalls, maxSaveActive: qa.maxSaveActive,
        encoderPosts: qa.encoderPosts, maxEncoderActive: qa.maxEncoderActive, postsWhileSaveActive: qa.postsWhileSaveActive }));
    });
    await page.reload({ waitUntil: 'networkidle' }); await openTasks(); await card('running-1').waitFor();
    assert.equal(await page.locator('[data-video-batch-id="cancel-batch"]').count(), 0, 'saved deletion survives a complete App reload');
    assert.equal(await page.locator('[data-video-batch-id="active-batch"]').count(), 1);
    const reloaded = await tasksFromSaved();
    assert.deepEqual(reloaded.filter((entry) => !entry.historyOnly).map((entry) => entry.id).sort(), ['running-1', 'running-2', 'running-3', 'running-4']);
    assert.equal(await page.locator('[data-video-batch-id="ancestor-batch-a"], [data-video-batch-id="ancestor-batch-b"]').count(), 0);
    assert.equal(await page.getByRole('tab', { name: /视频任务/u }).locator('.generation-task-count').innerText(), '4');
    assert.ok(['ancestor-a', 'ancestor-b'].every((id) => reloaded.find((entry) => entry.id === id)?.historyOnly));
    const asset = await page.evaluate(() => {
      const saved = window.__cancelQa.saved; const project = saved.project.assets ? saved.project : saved.projects.find((entry) => entry.id === saved.activeProjectId);
      return project.assets.find((entry) => entry.id === 'batch-result-video');
    });
    assert.equal(asset?.videoSourceTask?.id, 'batch-success');
    checks.push('Complete App reload retains deletions, excludes hidden ancestors from cards/counts, and preserves active descendants, continuation lineage and generated video provenance');
  }
  const evidence = await page.evaluate(() => { const qa = window.__cancelQa; return { posts: qa.posts, statusQueries: qa.requests.filter((entry) => entry.method === 'GET').length,
    cancelledRequests: qa.cancelledRequests, saveCalls: qa.saveCalls, maxSaveActive: qa.maxSaveActive,
    encoderPosts: qa.encoderPosts, maxEncoderActive: qa.maxEncoderActive, postsWhileSaveActive: qa.postsWhileSaveActive }; });
  assert.equal(evidence.posts, 0); assert.ok(evidence.saveCalls > 0); assert.ok(evidence.encoderPosts > 0);
  assert.equal(evidence.maxSaveActive, 1, 'desktop writes stay FIFO');
  assert.equal(evidence.maxEncoderActive, 1, 'cancellations must not queue multiple full-library Worker clones');
  assert.equal(evidence.postsWhileSaveActive, 0, 'next full-library encode must wait until the previous desktop write settles');
  assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'cancelled-tasks.png'), fullPage: false });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, batchDeletionMode, fixture, checks, layouts, screenshots, evidence, blockedRequests, errors }, null, 2));
  console.log(`Video cancellation UI QA passed. Report: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const taskEvidence = page ? await tasksFromSaved().catch(() => []) : [];
  const batchEvidence = page ? await page.locator('[data-video-batch-id]').allTextContents().catch(() => []) : [];
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blockedRequests, taskEvidence, batchEvidence, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
