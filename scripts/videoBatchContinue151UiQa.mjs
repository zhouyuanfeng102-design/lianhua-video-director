import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the real App task-center/controller/engine in a new browser context.
// Desktop transport, journals, video assets and vision are synthetic in-memory
// doubles. No desktop profile, credentials, local media or real API is accessed.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `video-batch-continue-151-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Continue QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Continue QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });

const storageKey = 'lianhua_video_director_state_v22';
const ledgerKey = '__video_batch_continue_151_mock_ledger__';
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'video batch continue 151 isolated UI', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let fixture;
const errors = []; const unexpectedRequests = []; const steps = []; const screenshots = [];
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const ledger = () => page.evaluate(() => structuredClone(window.__continue151Qa));
const screenshot = async (name) => {
  const target = path.join(output, `${name}.png`);
  await page.screenshot({ path: target, fullPage: false }); screenshots.push(target);
};
const openVideoTasks = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator('.jobs-view').waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
};
const assertVisibleWithinViewport = async (locator, label) => {
  const box = await locator.boundingBox(); const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `${label} must be visible without an overlay or horizontal scrolling: ${JSON.stringify(box)}`);
  assert.equal(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }), true, `${label} must not be covered`);
};

async function run() {
  await waitForCondition({ label: 'continue QA Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1430, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ origin, ledgerKey }) => {
    const qa = JSON.parse(sessionStorage.getItem(ledgerKey) || 'null') || {
      mode: 'fixture', posts: [], requests: [], vision: [], downloads: [], extractions: [], credentials: {}, checkpoints: {},
    };
    window.__continue151Qa = qa;
    const flush = () => sessionStorage.setItem(ledgerKey, JSON.stringify(qa));
    window.__flushContinue151Qa = flush;
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#596477'; paint.fillRect(0, 0, 160, 96);
    paint.fillStyle = '#f5e5b8'; paint.fillRect(30, 20, 50, 76); paint.fillStyle = '#bdd9dc'; paint.fillRect(105, 32, 20, 64);
    const png = canvas.toDataURL('image/png');
    window.__continue151Image = png;
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    const exactLocal = (url, prefix) => {
      const parsed = new URL(url);
      if (parsed.origin !== origin || !parsed.pathname.startsWith(prefix)) throw new Error(`QA refused an unexpected endpoint: ${parsed.origin}${parsed.pathname}`);
      return parsed;
    };
    const frame = (name, timeSec, role = 'custom-frame') => ({
      fileName: `${name}.png`, relativePath: `image/${name}.png`, checksum: `mock-${name}`, sizeBytes: 100,
      mediaType: 'image', mimeType: 'image/png', managed: true, missing: false,
      url: `lianhua-asset://local/image/${name}.png`, width: 160, height: 96, timeSec, frameIndex: Math.round(timeSec * 10), role,
    });
    window.__continue151Frame = frame;
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        const url = exactLocal(request.url, '/mock-video');
        const method = request.method || 'GET';
        qa.requests.push({ method, path: url.pathname });
        if (method === 'POST') {
          if (url.pathname !== '/mock-video') throw new Error('QA disallows unrecognized generation routes');
          const ordinal = qa.posts.length + 1;
          const remoteId = `${qa.mode}-remote-${ordinal}`;
          qa.posts.push({ mode: qa.mode, remoteId, body: JSON.parse(request.body) }); flush();
          if (qa.mode === 'fixture' && ordinal === 2) return json({ id: remoteId, status: 'failed', message: '隔离模拟：第二段生成失败' });
          return json({ id: remoteId, status: 'succeeded', url: `${origin}/mock-media/${remoteId}.mp4` });
        }
        flush();
        if (url.pathname.endsWith('/fixture-remote-2')) return json({ id: 'fixture-remote-2', status: 'failed', message: '隔离模拟：第二段生成失败' });
        return json({ id: url.pathname.split('/').pop(), status: 'processing' });
      },
      request: async (request) => {
        const url = exactLocal(request.url, '/mock-vision/');
        if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) throw new Error('QA disallows unrecognized model routes');
        const body = JSON.parse(request.body);
        const user = body.messages.find((message) => message.role === 'user');
        const content = typeof user.content === 'string' ? user.content : user.content.find((part) => part.type === 'text').text;
        const input = JSON.parse(content); const chosen = input.candidates.at(-1);
        qa.vision.push({ previous: input.completePreviousPrompt, next: input.completeNextPrompt, selectedId: chosen.id, candidates: input.candidates.length });
        flush();
        return json({ choices: [{ message: { content: JSON.stringify({ selectedId: chosen.id, reason: '隔离模拟 AI：选定真实末帧承接下一段。' }) } }] });
      },
      cancelModelRequest: async () => true,
      cancelVideoRequest: async () => true,
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { if (apiKey) qa.credentials[taskId] = apiKey; else delete qa.credentials[taskId]; flush(); return { persisted: true }; },
      getVideoTaskCredential: async (taskId) => qa.credentials[taskId] || null,
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints[task.id] = structuredClone(task); flush(); return { persisted: true }; },
      getVideoTaskCheckpoint: async (taskId) => structuredClone(qa.checkpoints[taskId] || null),
      deleteVideoTaskCheckpoint: async (taskId) => { delete qa.checkpoints[taskId]; flush(); return true; },
      downloadGeneratedMedia: async (request) => {
        const url = exactLocal(request.url, '/mock-media/'); const name = url.pathname.split('/').pop();
        qa.downloads.push({ path: url.pathname }); flush();
        // Complete mock managed-video metadata, including a stable path/checksum.
        // The real engine adds task provenance/resultAssetId and saves its journal.
        return { fileName: `${request.fileName}.mp4`, relativePath: `video/${name}`, checksum: `mock-${name}`, sizeBytes: 100,
          mediaType: 'video', mimeType: 'video/mp4', managed: true, missing: false,
          url: `lianhua-asset://local/video/${name}`, width: 160, height: 96, durationSec: 15 };
      },
      readManagedImageDataUrl: async ({ expectedChecksum }) => ({ dataUrl: png, mimeType: 'image/png', sizeBytes: 100, checksum: expectedChecksum }),
      videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'Isolated mock media tools' }),
      extractWorkbenchFrames: async (request) => {
        qa.extractions.push({ source: structuredClone(request.source), mode: request.mode }); flush();
        const suffix = request.jobId.replace(/[^a-z0-9_-]/giu, '-');
        return { probe: { durationSec: 15, width: 160, height: 96, fps: 10, hasAudio: false, videoCodec: 'h264' },
          frames: request.mode === 'last' ? [frame(`last-${suffix}`, 14.9, 'last-frame')]
            : [frame(`candidate-${suffix}`, 13.5)] };
      },
      cancelWorkbenchJob: async () => true, onWorkbenchProgress: () => () => {},
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin, ledgerKey });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  fixture = await page.evaluate(async ({ key, origin }) => {
    const { VideoGenerationEngine } = await import('/src/videoGeneration.ts');
    const { serializeStateForStorage } = await import('/src/storage.ts');
    let state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    state.project = { ...state.project, id: 'continue151-project', name: '批次继续 · 隔离验收', sourceDocuments: [],
      scenes: [], characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], generationTasks: [],
      assets: [{ id: 'continue151-reference', name: '隔离合成构图参考', type: 'reference', role: 'composition', referenceRole: 'composition',
        mediaType: 'image', mimeType: 'image/png', dataUrl: window.__continue151Image,
        relativePath: 'image/continue151-reference.png', checksum: 'mock-composition',
        source: 'upload', width: 160, height: 96, tags: ['隔离测试'], createdAt: now, updatedAt: now }], updatedAt: now };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api';
    state.settings.activeVideoApiProfileId = null; state.settings.videoApiProfiles = [];
    state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'continue151-mock',
      endpoint: `${origin}/mock-video`, statusEndpointTemplate: `${origin}/mock-video/{id}`, apiKey: '',
      taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', requestTemplate: '' };
    state.settings.textApi.enabled = false; state.settings.imageApi.enabled = false;
    state.settings.visionApi = { ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible',
      baseUrl: `${origin}/mock-vision/v1`, model: 'continue151-mock-vision', apiKey: '', maxTokens: 500 };
    state.settings.uiFontScalePercent = 125;
    state.ui = { ...state.ui, activeView: 'jobs' };
    const engine = new VideoGenerationEngine({
      getState: () => state, setState: (update) => { state = update(state); }, desktop: window.lianhuaDesktop,
      persistState: async () => {}, pollIntervalMs: 60_000, onRuntime: () => {},
      selectTailFrame: async (input) => {
        await input.onBeforeAI?.(); const frame = window.__continue151Frame('fixture-parent-tail', 14.9, 'last-frame');
        return { frame, selection: { source: 'ai', selectedId: 'frame-1', reason: '隔离模拟 AI 已选帧',
          selectedTimeSec: 14.9, lastFrameTimeSec: 14.9, offsetFromEndSec: 0, candidateCount: 1 },
          candidates: [{ id: 'frame-1', timeSec: 14.9, isLastFrame: true, frame }] };
      },
    });
    const wait = async (check, label) => {
      const deadline = Date.now() + 15_000;
      while (!check()) { if (Date.now() > deadline) throw new Error(label); await new Promise((resolve) => setTimeout(resolve, 10)); }
    };
    try {
      const batch = await engine.startBatch({ projectId: state.project.id, label: '剧情原文 · 批量视频', concurrency: 1,
        items: Array.from({ length: 3 }, (_, index) => ({
          itemKey: `continue151-board-${index + 1}:en`,
          draft: { name: `市集同行 · 第 ${index + 1} 段 · English`, prompt: `CONTINUE-151 ORIGINAL SEGMENT ${index + 1}`,
            backend: 'api', references: [{ assetId: 'continue151-reference', role: 'composition' }], parameters: { duration: 15, seed: 1510 + index },
            source: { storyboardId: `continue151-board-${index + 1}`, sequencePlanId: 'continue151-plan', segmentId: `continue151-segment-${index + 1}`,
              segmentIndex: index + 1, language: 'en', label: `市集同行 · 第 ${index + 1} 段` } },
          ...(index > 0 ? { previousTail: { predecessorItemKey: `continue151-board-${index}:en`,
            placement: { mode: 'append', index: 1, role: 'first-frame' }, selectionMode: 'ai-assisted', requireAiSelection: true } } : {}),
        })),
      });
      await wait(() => state.project.generationTasks.find((task) => task.id === batch.taskIds[1])?.status === 'failed', 'mock fixture did not fail at segment 2');
      await engine.cancelBatch(batch.batchId);
      await wait(() => state.project.generationTasks.find((task) => task.id === batch.taskIds[2])?.videoJob?.batchQueueState === 'cancelled', 'mock fixture did not stop segment 3');
      const first = state.project.generationTasks.find((task) => task.id === batch.taskIds[0]);
      const asset = state.project.assets.find((entry) => entry.id === first.resultAssetId);
      if (!asset?.relativePath || !asset.checksum || asset.sourceVideoTaskId !== first.id) throw new Error('fixture must contain a complete saved successful asset');
      const fixturePosts = structuredClone(window.__continue151Qa.posts);
      Object.assign(window.__continue151Qa, { mode: 'continue', posts: [], requests: [], vision: [], downloads: [], extractions: [] });
      window.__flushContinue151Qa();
      localStorage.setItem(key, serializeStateForStorage(state).serialized);
      return { batchId: batch.batchId, taskIds: batch.taskIds, assetId: asset.id,
        fixturePosts: fixturePosts.map((post) => ({ prompt: post.body.prompt, remoteId: post.remoteId, firstFrame: post.body.first_frame_image })) };
    } finally { engine.dispose(); }
  }, { key: storageKey, origin });
  assert.equal(fixture.fixturePosts.length, 2, 'fixture includes one success and one acknowledged failure, never a submitted third task');
  await page.reload({ waitUntil: 'networkidle' }); await openVideoTasks();
  const oldBatch = page.locator(`[data-video-batch-id="${fixture.batchId}"]`);
  await oldBatch.getByText('成功 1', { exact: true }).waitFor();
  await oldBatch.getByText('失败 1', { exact: true }).waitFor();
  await oldBatch.getByText('已停止 1', { exact: true }).waitFor();
  // The shared Button uses its longer tooltip as the accessible label. Match
  // visible button text here while retaining the actual rendered event handler.
  const resumeButton = oldBatch.getByRole('button').filter({ hasText: /^继续批次$/u });
  const stopButton = oldBatch.getByRole('button').filter({ hasText: /^停止未提交项$/u });
  assert.equal(await resumeButton.isEnabled(), true);
  assert.equal(await stopButton.isDisabled(), true, 'all pre-POST work is already stopped, but Stop remains visible beside Continue');
  await assertVisibleWithinViewport(resumeButton, 'Continue batch'); await assertVisibleWithinViewport(stopButton, 'Stop unsubmitted');
  assert.equal(await oldBatch.locator('.video-task-batch-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal((await ledger()).posts.length, 0, 'opening the historical batch does not create a generation request');
  const before = await stored();
  const originalSuccess = before.project.generationTasks.find((task) => task.id === fixture.taskIds[0]);
  const originalAsset = before.project.assets.find((asset) => asset.id === fixture.assetId);
  await screenshot('01-success-failure-stopped-with-continue');
  steps.push('actual App shows success 1 / failure 1 / stopped 1, with visible Continue and Stop controls');

  const confirmation = oldBatch.getByRole('region', { name: '确认继续未完成的视频任务', exact: true });
  await resumeButton.click(); await confirmation.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'continuation confirmation stays in the existing batch card');
  assert.equal(await confirmation.evaluate((element) => element.closest('[data-video-batch-id]').getAttribute('data-video-batch-id')), fixture.batchId);
  assert.equal(await confirmation.locator('li').count(), 2);
  assert.match(await confirmation.innerText(), /不重做 1 个成功项/u);
  assert.match(await confirmation.innerText(), /重新生成（可能再次收费）/u);
  assert.match(await confirmation.innerText(), /继续尚未提交的生成/u);
  assert.ok(!(await confirmation.locator('li').allTextContents()).some((text) => text.startsWith('第 1 段')));
  await assertVisibleWithinViewport(confirmation.getByRole('button', { name: '暂不继续', exact: true }), 'Cancel continuation');
  assert.equal((await ledger()).posts.length, 0); assert.equal((await ledger()).vision.length, 0);
  await screenshot('02-inline-cost-confirmation-same-card');
  await confirmation.getByRole('button', { name: '暂不继续', exact: true }).click();
  await confirmation.waitFor({ state: 'detached' });
  await oldBatch.getByRole('status').getByText('已取消本次确认，未提交新的生成。', { exact: true }).waitFor();
  assert.equal((await stored()).project.generationTasks.length, 3);
  assert.equal((await ledger()).posts.length, 0); assert.equal((await ledger()).vision.length, 0);
  steps.push('inline confirmation lists only segments 2/3; preview and cancellation make zero generation/vision calls');

  await resumeButton.click(); await confirmation.waitFor({ state: 'visible' });
  // Two immediate DOM clicks reproduce a rapid repeated click on the real
  // rendered handler; no controller method is invoked directly by the test.
  await confirmation.getByRole('button', { name: '确认继续 2 项（可能收费）', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key));
    const continued = state.project.generationTasks.filter((task) => task.videoJob?.snapshot.continuedFrom);
    return continued.length === 2 && continued.every((task) => task.status === 'succeeded' && task.resultAssetId);
  }, storageKey, { timeout: 30_000 });
  await confirmation.waitFor({ state: 'detached' });
  const completed = await stored(); const calls = await ledger();
  const continued = completed.project.generationTasks.filter((task) => task.videoJob?.snapshot.continuedFrom).sort((a, b) => a.segmentIndex - b.segmentIndex);
  assert.equal(new Set(continued.map((task) => task.batchId)).size, 1);
  assert.notEqual(continued[0].batchId, fixture.batchId);
  assert.deepEqual(continued.map((task) => task.segmentIndex), [2, 3]);
  assert.deepEqual(continued.map((task) => task.videoJob.snapshot.continuedFrom.taskId), fixture.taskIds.slice(1));
  assert.deepEqual(calls.posts.map((post) => post.body.prompt), ['CONTINUE-151 ORIGINAL SEGMENT 2', 'CONTINUE-151 ORIGINAL SEGMENT 3']);
  assert.deepEqual(calls.posts.map((post) => [post.body.duration, post.body.seed]), [[15, 1511], [15, 1512]]);
  assert.equal(calls.posts[0].body.first_frame_image, fixture.fixturePosts[1].firstFrame, 'segment 2 reuses exact previously saved AI-selected parent pixels');
  assert.equal(calls.vision.length, 1, 'only the new third segment asks AI for a new tail; the first saved tail is reused');
  assert.equal(calls.vision[0].previous, 'CONTINUE-151 ORIGINAL SEGMENT 2');
  assert.equal(calls.vision[0].next, 'CONTINUE-151 ORIGINAL SEGMENT 3');
  assert.equal(continued[1].videoJob.snapshot.previousTail.predecessorTaskId, continued[0].id, 'new segment 3 depends on new segment 2, not the old failed task');
  assert.deepEqual(completed.project.generationTasks.find((task) => task.id === fixture.taskIds[0]), originalSuccess, 'successful original task is unchanged');
  assert.deepEqual(completed.project.assets.find((asset) => asset.id === fixture.assetId), originalAsset, 'original successful video is unchanged');
  const newBatch = page.locator(`[data-video-batch-id="${continued[0].batchId}"]`);
  await newBatch.getByText('成功 2', { exact: true }).waitFor();
  assert.equal(await newBatch.getByRole('button').filter({ hasText: /^继续批次$/u }).isDisabled(), true);
  steps.push('double-confirm creates exactly one new 2-item suffix and two mock POSTs; original success is untouched; exact tail reuse and new predecessor binding verified');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await resumeButton.click();
    await oldBatch.getByRole('status').filter({ hasText: '3 项已完成，保持原成片。' }).waitFor();
    assert.equal(await confirmation.count(), 0);
    assert.equal((await ledger()).posts.length, 2); assert.equal((await ledger()).vision.length, 1);
    assert.equal((await stored()).project.generationTasks.length, 5);
  }
  await page.reload({ waitUntil: 'networkidle' }); await openVideoTasks();
  await oldBatch.getByText('成功 1', { exact: true }).waitFor();
  await resumeButton.click();
  await oldBatch.getByRole('status').filter({ hasText: '3 项已完成，保持原成片。' }).waitFor();
  assert.equal(await confirmation.count(), 0); assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await ledger()).posts.length, 2); assert.equal((await ledger()).vision.length, 1);
  assert.equal((await stored()).project.generationTasks.length, 5);
  assert.deepEqual((await stored()).project.generationTasks.find((task) => task.id === fixture.taskIds[0]), originalSuccess);
  await screenshot('03-repeated-old-batch-after-reload-no-new-charge');
  steps.push('repeated old-batch Continue, then actual page reload/normalization and Continue, follow persisted child lineage without another POST/AI call');
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(errors, []);
  const report = { passed: true, actualApp: true, mockOnly: true, isolatedBrowserStorage: true, noProductionDataRead: true,
    originalBatchId: fixture.batchId, continuedBatchId: continued[0].batchId, originalTasks: 3, continuedTasks: 2,
    generationPostsAfterConfirmation: calls.posts.length, visionRequestsAfterConfirmation: calls.vision.length,
    generationPostsAfterRepeatedContinueAndReload: (await ledger()).posts.length,
    steps, screenshots, errors, unexpectedRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Video batch Continue 151 UI passed: ${path.join(output, 'report.json')}`);
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  const diagnostics = page && !page.isClosed() ? await page.evaluate((key) => ({
    tasks: (JSON.parse(localStorage.getItem(key) || 'null')?.project?.generationTasks || []).map((task) => ({
      id: task.id, status: task.status, batchId: task.batchId, segmentIndex: task.segmentIndex, error: task.error,
      stage: task.videoJob?.stage, message: task.videoJob?.message, tail: task.videoJob?.tailPreparation?.phase,
      claim: task.videoJob?.batchContinuation, lineage: task.videoJob?.snapshot.continuedFrom,
    })),
    postCount: window.__continue151Qa?.posts.length, visionCount: window.__continue151Qa?.vision.length,
  }), storageKey).catch(() => undefined) : undefined;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, steps, errors, unexpectedRequests, diagnostics }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
