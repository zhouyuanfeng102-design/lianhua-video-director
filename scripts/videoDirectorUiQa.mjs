import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Uses the repository's established isolated headless harness. No real project files or APIs.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'video-director-0.5.82'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Video QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Video QA output must not traverse directory links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const viteBootstrap = `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated video QA Vite ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', viteBootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused video director UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const stages = [];
const screenshots = [];
const chinese = '【当前第2段】\n林澜转向门口。第1s @林澜：“别走，我有话要说。”\n韩竹停步。第4s @韩竹：“我会等你。”\n';
const english = '【当前第2段】\nLin Lan turns toward the doorway. At 1s @林澜: “别走，我有话要说。”\nHan Zhu stops. At 4s @韩竹: “我会等你。”\n';
const workflow = JSON.stringify({
  312: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'original prompt' }, _meta: { title: '视频提示词' } },
  335: { class_type: 'LoadImage', inputs: { image: 'old-reference.png' } },
  320: { class_type: 'MiniMaxH3Condition', inputs: { prompt: ['312', 0], image: ['335', 0] } },
  321: { class_type: 'KSampler', inputs: { positive: ['320', 0], seed: 12345, steps: 12, cfg: 3 } },
  322: { class_type: 'VideoAudio', inputs: { samples: ['321', 0] } },
  328: { class_type: 'VHS_VideoCombine', inputs: { images: ['321', 0], audio: ['322', 0], frame_rate: 24, filename_prefix: 'qa-H3', format: 'video/h264-mp4' } },
}, null, 2);

const run = async () => {
  await waitForCondition({ label: 'focused video director Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ origin }) => {
    if (!sessionStorage.getItem('__video_director_focused_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__video_director_focused_qa__', '1'); }
    window.__videoQa = { requests: [], postCount: 0, queryCount: 0, downloads: 0, finish: false, credentials: {}, samplePromise: undefined };
    const sample = () => {
      if (window.__videoQa.samplePromise) return window.__videoQa.samplePromise;
      window.__videoQa.samplePromise = new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 108;
        const paint = canvas.getContext('2d'); paint.fillStyle = '#786390'; paint.fillRect(0, 0, 192, 108); paint.fillStyle = '#ffffff'; paint.font = '18px sans-serif'; paint.fillText('LOCAL VIDEO QA', 12, 55);
        const stream = canvas.captureStream(10); const parts = [];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
        recorder.onerror = reject;
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(parts, { type: 'video/webm' }); const reader = new FileReader();
          reader.onload = () => resolve({ url: reader.result, sizeBytes: blob.size }); reader.onerror = reject; reader.readAsDataURL(blob);
        };
        recorder.start(); setTimeout(() => { paint.fillStyle = '#c84f86'; paint.fillRect(10, 80, 172, 12); }, 80); setTimeout(() => recorder.stop(), 320);
      });
      return window.__videoQa.samplePromise;
    };
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        if (!request.url.startsWith(origin)) throw new Error('QA rejected a non-local video endpoint');
        if (Object.hasOwn(request, 'timeoutMs') || Object.hasOwn(request, 'timeout')) throw new Error('Video request unexpectedly added a timeout');
        window.__videoQa.requests.push({ url: request.url, method: request.method || 'GET', body: request.body });
        if (request.url.includes('/qa-comfy/history/')) return json({});
        if (request.url.endsWith('/qa-comfy/queue')) return json({ queue_running: [], queue_pending: [[1, 'qa-comfy-pending']] });
        if ((request.method || 'GET') === 'POST') { window.__videoQa.postCount += 1; return json({ id: 'qa-video-1', status: 'queued' }); }
        window.__videoQa.queryCount += 1;
        return window.__videoQa.finish
          ? json({ id: 'qa-video-1', status: 'succeeded', progress: 100, result: { url: `${origin}/qa-result.webm` } })
          : json({ id: 'qa-video-1', status: window.__videoQa.queryCount > 1 ? 'running' : 'queued', progress: window.__videoQa.queryCount > 1 ? 37 : 0 });
      },
      cancelVideoRequest: async () => true,
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
      onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { window.__videoQa.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (taskId) => window.__videoQa.credentials[taskId] ?? null,
      downloadGeneratedMedia: async (payload) => {
        if (!payload.noTimeout) throw new Error('Video download unexpectedly has a deadline');
        window.__videoQa.downloads += 1; const generated = await sample();
        return { ...generated, relativePath: 'qa-only/video-director.webm', fileName: 'qa-video-director.webm', checksum: 'qa-synthetic-video', mediaType: 'video', mimeType: 'video/webm', width: 192, height: 108, durationSec: 0.32, managed: true, missing: false };
      },
      assetStatus: async () => ({ exists: true }),
      revealAsset: async () => true,
      saveMedia: async () => 'qa-only/video-director.webm',
    };
  }, { origin: new URL(baseUrl).origin });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push(`Unexpected non-local request: ${route.request().url()}`); await route.abort('blockedbyclient'); });
  await page.route('**/qa-result.webm', async (route) => {
    const dataUrl = await page.evaluate(async () => (await window.__videoQa.samplePromise)?.url || '');
    if (dataUrl) await route.fulfill({ status: 200, contentType: 'video/webm', body: Buffer.from(dataUrl.split(',')[1], 'base64') });
    else await route.fulfill({ status: 204, body: '' });
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, base, zh, en }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const image = (id, color, role) => {
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96; const drawing = canvas.getContext('2d'); drawing.fillStyle = color; drawing.fillRect(0, 0, 128, 96);
      return { id, name: id === 'qa-character' ? '测试人物图' : '测试构图图', type: id === 'qa-character' ? 'character' : 'reference', role, referenceRole: role, mediaType: 'image', dataUrl: canvas.toDataURL('image/png'), width: 128, height: 96, source: 'upload', tags: ['隔离UI测试'], createdAt: now, updatedAt: now };
    };
    const scene = { id: 'qa-scene', title: '门口对白', content: '林澜：“别走，我有话要说。”韩竹：“我会等你。”', summary: '门口对白', characterIds: [], propIds: [], storyboardIds: ['qa-board-2', 'qa-board-3'], createdAt: now, updatedAt: now };
    const board = { id: 'qa-board-2', sceneId: scene.id, sourceStoryTitle: '测试长剧情', workflow: 'drama', inputMode: 'text_reference', durationSec: 6, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: ['qa-character'], finalPrompt: zh, englishPrompt: en, officialPromptZh: zh, officialPromptEn: en, shots: [{ id: 'qa-shot', index: 1, startSec: 0, endSec: 6, purpose: '门口对白', subject: '林澜和韩竹', action: '林澜叫住韩竹，韩竹停步', camera: '中景固定', transition: '自然衔接', lighting: '自然光', sound: '第1秒林澜：“别走，我有话要说。”第4秒韩竹：“我会等你。”', result: '两人停步对视', referenceAssetIds: ['qa-character'], prompt: zh, locked: false }], sequencePlanId: 'qa-sequence', segmentId: 'qa-segment-2', segmentIndex: 2, segmentCount: 3, createdAt: now, updatedAt: now };
    const queuedComfyTask = {
      id: 'qa-comfy-pending-task', kind: 'video', storyboardId: board.id, targetId: 'qa-comfy-workflow', status: 'submitted', remoteTaskId: 'qa-comfy-pending', requestBody: { prompt: zh }, createdAt: now - 360_000, updatedAt: now - 1_000,
      videoJob: {
        stage: 'queued', submittedAt: now - 359_000, message: 'ComfyUI 排队中',
        snapshot: {
          projectId: 'qa-video-project', clientId: 'qa-comfy-client', images: [],
          draft: { name: '排队不计时验证', prompt: zh, backend: 'comfyui', references: [], parameters: {}, source: { storyboardId: board.id } },
          connection: { backend: 'comfyui', comfyui: { enabled: true, baseUrl: `${base}qa-comfy`, promptPath: '/prompt' } },
        },
      },
    };
    state.project = { ...state.project, id: 'qa-video-project', name: '隔离视频导演台验证', sourceDocuments: [], characters: [], locations: [], props: [], scenes: [scene], sequencePlans: [], storyboards: [board, { ...board, id: 'qa-board-3', segmentId: 'qa-segment-3', segmentIndex: 3, finalPrompt: '【第3段独立内容】离开。', officialPromptZh: '【第3段独立内容】离开。', englishPrompt: '', officialPromptEn: '', updatedAt: now - 10 }], assets: [image('qa-character', '#bba7cd', 'character'), image('qa-composition', '#91b4c1', 'composition'), { id: 'qa-audio', name: '保留的测试音频', type: 'audio', role: 'audio', referenceRole: 'audio', mediaType: 'audio', tags: [], createdAt: now, updatedAt: now }], generationTasks: [queuedComfyTask], updatedAt: now };
    state.projects = [state.project];
    state.settings.videoTaskApi = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'qa-local-video', endpoint: `${base}qa-video`, statusEndpointTemplate: `${base}qa-video/{id}`, apiKey: '', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result.url', progressPath: 'progress', requestTemplate: '' };
    state.settings.videoBackend = 'api'; state.settings.activeVideoApiProfileId = null; state.settings.videoApiProfiles = [];
    state.settings.comfyuiVideo = { enabled: true, baseUrl: `${base}qa-comfy`, apiKey: '', promptPath: '/prompt', workflows: [], activeWorkflowId: null };
    for (const api of ['textApi', 'visionApi', 'imageApi']) state.settings[api].enabled = false;
    state.settings.imageApi.backend = 'comfyui'; state.settings.imageApi.baseUrl = `${base}qa-image-untouched`;
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.ui = { ...state.ui, activeView: 'assets' };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, base: baseUrl, zh: chinese, en: english });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  const savedProject = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
  const savedImageSettings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.imageApi, storageKey);
  const sidebar = page.locator('.sidebar');
  const navLabels = await sidebar.locator('button').allTextContents();
  const promptIndex = navLabels.findIndex((text) => text.trim() === '提示词导演台');
  const videoIndex = navLabels.findIndex((text) => text.trim() === '视频导演台');
  assert.ok(promptIndex >= 0 && videoIndex === promptIndex + 1, `director sidebar order: ${JSON.stringify(navLabels)}`);
  const nav = (label) => sidebar.getByRole('button', { name: label, exact: true }).click();
  await nav('资产库');
  await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '资产库首页', exact: true }).count(), 0);
  assert.ok(await page.getByRole('button', { name: '音频参考', exact: true }).isVisible());
  stages.push('sidebar order, direct image library and retained video/audio tabs verified');
  await page.getByRole('checkbox', { name: '选中用于生成视频：测试人物图' }).check();
  await page.getByRole('checkbox', { name: '选中用于生成视频：测试构图图' }).check();
  await page.getByRole('button', { name: '用选中 2 张普通图片生成视频', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  assert.equal(await page.locator('.vd-reference-row').count(), 2);
  assert.equal(await page.evaluate(() => window.__videoQa.postCount), 0);
  // The single-segment reference card is display-only.  Per-segment physical
  // slot purposes are edited in the reference picker, rather than through the
  // old per-image select/reorder controls on the card.
  const referenceCard = page.locator('.vd-reference-card');
  assert.equal(await referenceCard.getByLabel('图片 1 用途', { exact: true }).count(), 0, 'old card-level purpose selector was removed');
  assert.equal(await referenceCard.getByRole('button', { name: '上移图片 1', exact: true }).count(), 0, 'old card-level reorder control was removed');
  await referenceCard.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
  let imageDialog = page.getByRole('dialog', { name: '从图片资产库选择生成参考图' });
  await imageDialog.getByLabel('本段图片槽 1 用途', { exact: true }).waitFor();
  assert.equal(await imageDialog.getByLabel('本段图片槽 2 用途', { exact: true }).inputValue(), 'composition');
  await imageDialog.getByLabel('本段图片槽 2 用途', { exact: true }).selectOption('character');
  await imageDialog.getByRole('button', { name: '使用所选图片', exact: true }).click();
  await imageDialog.waitFor({ state: 'hidden' });
  assert.equal(await referenceCard.getByLabel('图片 1 用途', { exact: true }).count(), 0, 'card does not reintroduce old purpose controls');
  assert.match(await referenceCard.innerText(), /人物2（槽2）/u, 'the slot editor purpose is reflected in the selected-slot badge');
  await page.getByRole('button', { name: '从提示词导演台选择', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '从提示词导演台选择提示词' });
  await dialog.getByLabel('描述语言', { exact: true }).selectOption('zh');
  await dialog.locator('.vd-choice').filter({ hasText: '第 2 段' }).click();
  assert.equal(await dialog.locator('.vd-prompt-preview').textContent(), chinese);
  await dialog.getByRole('button', { name: '使用这段提示词', exact: true }).click();
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), chinese);
  assert.equal(await page.locator('.vd-reference-row').count(), 2, 'existing refs are deduplicated, not bound to a new shot');
  await page.getByRole('button', { name: '从提示词导演台选择', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '从提示词导演台选择提示词' });
  await dialog.getByLabel('描述语言', { exact: true }).selectOption('en');
  await dialog.locator('.vd-choice').filter({ hasText: '第 2 段' }).click();
  assert.equal(await dialog.locator('.vd-prompt-preview').textContent(), english);
  await dialog.getByRole('button', { name: '使用这段提示词', exact: true }).click();
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), english);
  assert.equal(await referenceCard.getByRole('button', { name: '下移图片 1', exact: true }).count(), 0, 'card-level image order remains removed after prompt changes');
  assert.match(await referenceCard.innerText(), /人物2（槽2）/u, 'per-segment slot purpose remains after switching prompt language');
  const currentBoards = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.storyboards, storageKey);
  assert.deepEqual(currentBoards, savedProject.storyboards, 'choosing prompt/images must not mutate source storyboards');
  stages.push('image entry, exact Chinese/English single-segment copy, reference ordering and source immutability verified');
  await page.screenshot({ path: path.join(outputDirectory, 'video-director-setup-1280x800.png'), fullPage: false }); screenshots.push('video-director-setup-1280x800.png');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__videoQa.postCount === 1);
  assert.equal(await page.locator('.video-director-view [data-video-task-id]').count(), 0, 'video task cards belong only to the generation task page');
  assert.equal(await page.locator('.video-director-view').getByRole('heading', { name: '视频生成任务', exact: true }).count(), 0, 'the video director must not duplicate the generation task list');
  const captured = await page.evaluate(() => JSON.parse(window.__videoQa.requests.find((request) => request.method === 'POST').body));
  assert.equal(captured.prompt, english);
  assert.equal(captured.images.length, 2);
  assert.ok(captured.images.every((image) => image.startsWith('data:image/png;base64,')), 'API receives actual image pixels rather than local paths');
  assert.ok(!Object.hasOwn(captured, 'seed'), 'default seed is not overridden');
  await nav('生成任务');
  await page.locator('.jobs-view').waitFor();
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
  const submittedTasks = page.locator('.jobs-view [data-video-task-id]');
  assert.equal(await submittedTasks.count(), 2, 'the queued ComfyUI fixture and newly submitted video task must each appear exactly once');
  const queuedTask = page.locator('[data-video-task-id="qa-comfy-pending-task"]');
  await queuedTask.getByText('尚未开始执行（排队不计时）', { exact: true }).waitFor();
  const queuedMeta = queuedTask.locator('.vd-task-meta').first();
  const queuedTimingText = await queuedMeta.innerText();
  await page.waitForTimeout(1_100);
  assert.equal(await queuedMeta.innerText(), queuedTimingText, 'queued task timing text must remain unchanged across clock ticks');
  assert.equal(await queuedTask.getByText(/执行耗时|累计耗时/u).count(), 0, 'queued ComfyUI task must not expose a growing duration');
  const submittedTask = submittedTasks.filter({ hasText: '测试长剧情 · 第 2 段' });
  assert.equal(await submittedTask.count(), 1, 'the newly submitted generic task remains uniquely identifiable');
  assert.equal(await submittedTasks.locator('video').count(), 0, 'generation-task cards must not mount playable video elements');
  assert.equal(await submittedTask.locator('.vd-task-thumbnail img').count(), 1, 'generation-task video cards must show a static reference thumbnail');
  await submittedTask.getByText('后端进度 37%', { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(await submittedTask.getByText(/执行耗时/u).isVisible());
  await submittedTask.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'generation-task-progress-1280x800.png'), fullPage: false }); screenshots.push('generation-task-progress-1280x800.png');
  await nav('资产库');
  await page.locator('.assets-view').waitFor();
  await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
  await page.getByRole('button', { name: '图片资产库', exact: true }).waitFor();
  await page.evaluate(() => { window.__videoQa.finish = true; });
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks.some((task) => task.resultAssetId), storageKey, { timeout: 35_000 });
  assert.equal(await page.evaluate(() => window.__videoQa.downloads), 1);
  assert.equal(await page.evaluate(() => window.__videoQa.postCount), 1, 'switching views never resubmits');
  await page.getByRole('button', { name: '视频资产库', exact: true }).click();
  // Video cards intentionally render only a static thumbnail.  The native
  // player is mounted on demand in AssetVideoPlayerDialog after clicking the
  // card's playback button; do not regress to requiring an in-card <video>.
  const videoCard = page.locator('.asset-card').filter({ hasText: 'qa-video-director' });
  await videoCard.waitFor();
  assert.equal(await videoCard.count(), 1);
  assert.equal(await videoCard.locator('video').count(), 0, 'video cards do not mount a player before playback');
  await videoCard.getByRole('button', { name: '播放视频：qa-video-director', exact: true }).click();
  const videoDialog = page.getByRole('dialog', { name: '播放视频：qa-video-director', exact: true });
  await videoDialog.waitFor();
  const dialogVideo = videoDialog.locator('video');
  await dialogVideo.waitFor({ state: 'attached' });
  await page.waitForFunction(() => { const video = document.querySelector('.asset-video-dialog video'); return video && video.readyState >= 1 && video.videoWidth === 192; });
  await dialogVideo.evaluate(async (video) => { video.muted = true; video.loop = true; video.currentTime = 0; await video.play(); if (video.paused) throw new Error('Synthetic video did not start playback'); video.pause(); });
  await videoDialog.getByRole('button', { name: '关闭视频播放', exact: true }).click();
  await videoDialog.waitFor({ state: 'detached' });
  await nav('生成任务');
  await page.getByRole('tab', { name: /^视频任务，/u }).click();
  const completedTask = page.locator('.jobs-view [data-video-task-id]').filter({ hasText: '测试长剧情 · 第 2 段' });
  await completedTask.locator('.vd-status').getByText('已完成', { exact: true }).waitFor();
  const completedTimingText = await completedTask.getByText(/执行耗时/u).textContent();
  await page.waitForTimeout(1_100);
  assert.equal(await completedTask.getByText(/执行耗时/u).textContent(), completedTimingText, 'completed execution duration must remain frozen across clock ticks');
  await nav('资产库');
  await page.getByRole('button', { name: '视频资产库', exact: true }).click();
  await videoCard.waitFor();
  await videoCard.getByText('查看本次提示词、图片和参数', { exact: true }).click();
  assert.equal(await videoCard.locator('.asset-video-source pre').first().textContent(), english);
  assert.equal(await videoCard.locator('.asset-video-source-image').count(), 2);
  assert.ok(await videoCard.getByText('192 × 108', { exact: true }).isVisible());
  await page.screenshot({ path: path.join(outputDirectory, 'video-library-result-1280x800.png'), fullPage: false }); screenshots.push('video-library-result-1280x800.png');
  stages.push('task hidden from video director, uniquely visible with 37% progress in generation tasks, background completion, single download, playable video and provenance verified');
  await videoCard.getByRole('button', { name: '载入相同设置再次生成', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), english);
  assert.equal(await page.getByLabel('视频 API 配置', { exact: true }).inputValue(), '__saved');
  assert.equal(await page.evaluate(() => window.__videoQa.postCount), 1, 'reuse only loads a draft');
  await page.getByRole('button', { name: '视频连接设置', exact: true }).click();
  await page.getByRole('tab', { name: 'ComfyUI 视频', exact: true }).click();
  await page.locator('.video-generation-settings input[type="file"]').setInputFiles({ name: 'QA-H3-api-workflow.json', mimeType: 'application/json', buffer: Buffer.from(workflow) });
  await page.locator('.vgs-feedback').getByRole('status').filter({ hasText: '已新增“QA-H3-api-workflow”' }).waitFor();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).settings.comfyuiVideo.workflows.length === 1, storageKey);
  const afterSettings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings, storageKey);
  assert.deepEqual(afterSettings.imageApi, savedImageSettings, 'video import must not change image settings');
  const imported = afterSettings.comfyuiVideo.workflows[0];
  assert.equal(imported.workflowJson, workflow);
  assert.deepEqual(imported.mapping.prompt, [{ nodeId: '312', inputName: 'value' }]);
  assert.deepEqual(imported.mapping.images, [{ nodeId: '335', inputName: 'image' }]);
  assert.equal(imported.mapping.outputNodeId, '328');
  stages.push('same-settings draft does not submit; Comfy H3 API import binds 312/335/328 without changing image settings');
  await page.getByRole('button', { name: '管理 Workflow', exact: true }).click();
  const workflowDialog = page.getByRole('dialog', { name: 'ComfyUI 视频工作流管理', exact: true });
  await workflowDialog.waitFor();
  await workflowDialog.getByRole('tab', { name: 'API JSON', exact: true }).click();
  const secretWorkflow = JSON.parse(workflow); secretWorkflow['320'].inputs.api_key = 'qa-only-key-must-not-persist';
  await workflowDialog.getByLabel('视频工作流 API JSON 编辑稿', { exact: true }).fill(JSON.stringify(secretWorkflow));
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.comfyuiVideo.workflows[0].workflowJson, storageKey), workflow, 'workflow editing is a local unsaved draft');
  await workflowDialog.getByRole('button', { name: '保存工作流', exact: true }).click();
  await workflowDialog.getByRole('alert').filter({ hasText: '包含内嵌凭据' }).waitFor();
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.comfyuiVideo.workflows[0].workflowJson, storageKey), workflow, 'embedded workflow credentials never persist');
  await workflowDialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('alertdialog', { name: '有未保存的工作流编辑', exact: true }).getByRole('button', { name: '放弃编辑并继续', exact: true }).click();
  await workflowDialog.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '视频 API', exact: true }).click();
  await page.getByRole('button', { name: '高级协议与请求模板', exact: true }).click();
  const advancedDialog = page.getByRole('dialog', { name: '视频 API 高级设置', exact: true });
  await advancedDialog.waitFor();
  await page.getByLabel('视频请求模板 JSON', { exact: true }).fill('{"api_key":"qa-only-key-must-not-persist","prompt":"{{prompt}}"}');
  await page.getByRole('button', { name: '保存请求模板', exact: true }).click();
  await page.locator('.video-generation-settings [role="alert"]').filter({ hasText: '包含内嵌凭据' }).waitFor();
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.videoTaskApi.requestTemplate || '', storageKey), '');
  await page.getByRole('dialog', { name: '视频 API 高级设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('workflow and API-template editors reject embedded credentials before saving');
  page.once('dialog', (nativeDialog) => { void nativeDialog.accept(); });
  await advancedDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await advancedDialog.waitFor({ state: 'detached' });
  await nav('视频导演台');
  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator('.video-director-view').waitFor();
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.getBoundingClientRect().width, overflowing: [...document.querySelectorAll('.video-director-view *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => ({ tag: element.tagName, className: element.className, right: Math.round(element.getBoundingClientRect().right) })).slice(0, 8) }));
  await page.screenshot({ path: path.join(outputDirectory, 'video-director-narrow-900x800.png'), fullPage: false }); screenshots.push('video-director-narrow-900x800.png');
  assert.ok(layout.scrollWidth <= layout.width + 1, `narrow video page overflow: ${JSON.stringify(layout)}`);
  assert.deepEqual(errors, []);
  const report = { mockOnly: true, noProductionDataRead: true, stages, screenshots, requests: await page.evaluate(() => ({ postCount: window.__videoQa.postCount, queryCount: window.__videoQa.queryCount, downloads: window.__videoQa.downloads })), layout, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  const notice = page ? await page.locator('.sidebar-notice').textContent().catch(() => '') : '';
  const body = page ? (await page.locator('body').innerText().catch(() => '')).slice(-6500) : '';
  if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ stages, errors, notice, body, error: String(error), cause: error?.cause ? String(error.cause) : undefined }, null, 2));
  throw new Error(`Focused video director UI failed: ${JSON.stringify({ stages, errors, notice })}`, { cause: error });
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
