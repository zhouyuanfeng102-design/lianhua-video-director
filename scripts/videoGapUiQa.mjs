import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Focused continuation of videoDirectorUiQa. Fixtures live only in this new
// browser context; no user project files, real endpoints or generation tasks.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'video-gaps-0.5.83'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Gap QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Gap QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Video gap UI fixture ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused video gap UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const stages = [];
const screenshots = [];
const expectedB2 = '【计划B·第2段】\n韩竹来到桥边。第1s @韩竹：“我会在桥边等你。”\n林澜停步回望。第4s @林澜：“我知道了。”\n';

const run = async () => {
  await waitForCondition({ label: 'video gap Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__video_gap_fixture__')) {
      localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__video_gap_fixture__', '1');
    }
    window.__videoGapQa = { requests: [], postCount: 0, downloads: 0, credentials: {}, sample: undefined };
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        window.__videoGapQa.requests.push({ url: request.url, method: request.method || 'GET' });
        if ((request.method || 'GET') === 'POST') window.__videoGapQa.postCount += 1;
        throw new Error('Gap QA forbids any actual video request: only saved synthetic videos are used');
      },
      cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
      onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { window.__videoGapQa.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (taskId) => window.__videoGapQa.credentials[taskId] ?? null,
      downloadGeneratedMedia: async () => { window.__videoGapQa.downloads += 1; throw new Error('Saved fixture videos must not download again'); },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true, saveMedia: async () => 'qa-only/video-gap.webm',
    };
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push(`Unexpected non-local request: ${route.request().url()}`); await route.abort('blockedbyclient');
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  const fixtureSummary = await page.evaluate(async ({ key, base, b2 }) => {
    const { buildOfficialH3SourceFingerprint } = await import('/src/officialPrompt.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const sample = await new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 108;
      const paint = canvas.getContext('2d'); paint.fillStyle = '#62789a'; paint.fillRect(0, 0, 192, 108); paint.fillStyle = '#ffffff'; paint.font = '17px sans-serif'; paint.fillText('LOCAL SAVED VIDEO', 8, 56);
      const stream = canvas.captureStream(10); const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = reject;
      recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); const blob = new Blob(chunks, { type: 'video/webm' }); const reader = new FileReader(); reader.onload = () => resolve({ dataUrl: reader.result, sizeBytes: blob.size }); reader.onerror = reject; reader.readAsDataURL(blob); };
      recorder.start(); setTimeout(() => { paint.fillStyle = '#d8aa5e'; paint.fillRect(12, 83, 168, 12); }, 80); setTimeout(() => recorder.stop(), 280);
    });
    const image = (id, name, color, role) => {
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96; const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 128, 96);
      return { id, name, type: role === 'character' ? 'character' : 'reference', role, referenceRole: role, mediaType: 'image', dataUrl: canvas.toDataURL('image/png'), width: 128, height: 96, source: 'upload', tags: ['隔离来源验收'], createdAt: now, updatedAt: now };
    };
    const images = [image('gap-composition', '原始桥边构图图', '#7b99a1', 'composition'), image('gap-character', '原始人物林澜', '#b791ba', 'character')];
    const scenes = ['a1', 'a2', 'b1', 'b2'].map((suffix) => ({ id: `gap-scene-${suffix}`, title: `场景${suffix.toUpperCase()}`, content: suffix === 'b2' ? '韩竹：“我会在桥边等你。”林澜：“我知道了。”' : `计划${suffix.toUpperCase()}的独立动作`, summary: `仅属于${suffix.toUpperCase()}的场景`, characterIds: [], locationIds: [], propIds: [], storyboardIds: [`gap-board-${suffix}`], createdAt: now, updatedAt: now }));
    const boards = scenes.map((scene, index) => {
      const suffix = ['a1', 'a2', 'b1', 'b2'][index]; const letter = suffix[0].toUpperCase(); const segmentIndex = Number(suffix[1]);
      const prompt = suffix === 'b2' ? b2 : `【计划${letter}·第${segmentIndex}段】\n该段独立动作：${suffix.toUpperCase()}，与桥边对白无关。\n`;
      return { id: `gap-board-${suffix}`, sceneId: scene.id, sourceStoryTitle: `计划${letter}剧情`, sourceStoryContent: scene.content,
        workflow: 'drama', inputMode: 'text_reference', durationSec: 6, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '', globalReferenceAssetIds: images.map((asset) => asset.id),
        finalPrompt: prompt, officialPromptZh: prompt, officialPromptEn: '', targetOutput: { targetId: 'minimax-h3', prompt, parameters: {}, referenceManifest: [], warnings: [], generatedAt: now },
        promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', convertedPromptFingerprint: sourceContentHash(prompt), modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [], referenceAssetIds: images.map((asset) => asset.id), generatedAt: now },
        shots: [{ id: `gap-shot-${suffix}`, index: 1, startSec: 0, endSec: 6, purpose: '保留独立剧情', subject: suffix === 'b2' ? '韩竹和林澜' : suffix.toUpperCase(), action: suffix === 'b2' ? '韩竹来到桥边，林澜回望' : scene.content, camera: '中景固定', transition: '自然承接', lighting: '自然光', sound: suffix === 'b2' ? '第1s韩竹：“我会在桥边等你。”第4s林澜：“我知道了。”' : '无对白', result: '状态保持', referenceAssetIds: images.map((asset) => asset.id), prompt, locked: false }],
        sequencePlanId: `gap-plan-${suffix[0]}`, segmentId: `gap-segment-${suffix}`, segmentIndex, segmentCount: 2, createdAt: now, updatedAt: now + index };
    });
    const plans = ['a', 'b'].map((letter) => ({ id: `gap-plan-${letter}`, title: `独立计划${letter.toUpperCase()}`, sourceStoryTitle: `计划${letter.toUpperCase()}剧情`, sourceStoryContent: scenes.filter((scene) => scene.id.includes(`-${letter}`)).map((scene) => scene.content).join('\n'), durationMode: 'fixed', requestedTotalDurationSec: 12, totalDurationSec: 12, segmentDurationSec: 6, segmentationMode: 'fixed', fitStatus: 'balanced', estimateReason: '隔离导航验收，不执行生成', planningStage: 'segmented',
      segments: [1, 2].map((number) => { const suffix = `${letter}${number}`; const scene = scenes.find((entry) => entry.id === `gap-scene-${suffix}`); return { id: `gap-segment-${suffix}`, index: number, title: `计划${letter.toUpperCase()}第${number}段`, globalStartSec: (number - 1) * 6, globalEndSec: number * 6, durationSec: 6, content: scene.content, summary: scene.summary, sourceSceneIds: [scene.id], sourceBeatIds: [`gap-beat-${suffix}`], narrativePurpose: '独立剧情', entryState: '进入画面', exitState: '停步', transitionHint: '自然承接', storyboardId: `gap-board-${suffix}`, status: 'ready', locked: false }; }), createdAt: now, updatedAt: now }));
    const projectId = 'gap-isolated-project';
    const safeApi = { enabled: true, endpoint: `${base}original-video-api`, statusEndpointTemplate: `${base}original-video-api/{id}`, authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'result.url', provider: 'generic', model: 'original-frozen-model' };
    const makeTask = (suffix, take) => {
      const board = boards.find((item) => item.id === `gap-board-${suffix}`); const name = `计划${suffix[0].toUpperCase()}第${suffix[1]}段成片-${take}`; const taskId = `gap-task-${suffix}-${take}`; const assetId = `gap-video-${suffix}-${take}`;
      const source = { storyboardId: board.id, sequencePlanId: board.sequencePlanId, segmentId: board.segmentId, segmentIndex: board.segmentIndex, language: 'zh', label: `${name}来源`, promptVersion: `revision-${take}` };
      const parameters = { seed: suffix === 'b2' && take === 1 ? 424242 : 123456, steps: 30 };
      return { id: taskId, kind: 'video', storyboardId: board.id, targetId: 'original-frozen-model', status: 'succeeded', resultAssetId: assetId, requestBody: { prompt: board.finalPrompt, parameters }, sequencePlanId: board.sequencePlanId, segmentId: board.segmentId, segmentIndex: board.segmentIndex, createdAt: now - 10000, updatedAt: now,
        videoJob: { stage: 'succeeded', message: '已保存的本地隔离测试成片', submittedAt: now - 10000, generatedAt: now - 2000, completedAt: now,
          snapshot: { projectId, clientId: `client-${taskId}`, draft: { name, prompt: board.finalPrompt, backend: 'api', references: images.map((asset) => ({ assetId: asset.id, role: asset.referenceRole })), parameters, source }, connection: { backend: 'api', api: safeApi }, images: images.map((asset) => ({ assetId: asset.id, role: asset.referenceRole, name: asset.name, dataUrl: asset.dataUrl, freezeState: 'frozen', frozenAt: now - 10000 })) } } };
    };
    const tasks = [makeTask('a1', 1), makeTask('a2', 1), makeTask('b1', 1), makeTask('b2', 1), makeTask('b2', 2)];
    const videos = tasks.map((task) => ({ id: task.resultAssetId, name: task.videoJob.snapshot.draft.name, type: 'video', role: 'motion', referenceRole: 'motion', mediaType: 'video', mimeType: 'video/webm', ...sample, width: 192, height: 108, durationSec: 0.28, source: 'generated', sourceVideoTaskId: task.id, sourceStoryboardId: task.storyboardId, prompt: task.videoJob.snapshot.draft.prompt, tags: ['隔离来源验收'], createdAt: now, updatedAt: now,
      // Simulate one pre-upgrade asset. Deletion must backfill its provenance.
      ...(task.id === 'gap-task-b2-1' ? {} : { videoSourceTask: structuredClone(task) }) }));
    state.project = { ...state.project, id: projectId, name: '两计划多段：视频升级缺口验收', sourceDocuments: [], characters: [], locations: [], props: [], scenes, storyboards: boards, sequencePlans: plans, assets: [...images, ...videos], generationTasks: tasks, updatedAt: now };
    for (const board of boards) board.officialPromptSource = buildOfficialH3SourceFingerprint(board, { assets: state.project.assets, characters: [], locations: [], props: [], sceneContent: scenes.find((scene) => scene.id === board.sceneId).content });
    state.projects = [state.project]; state.activeProjectId = projectId;
    // Current configuration intentionally differs from frozen completed tasks.
    state.settings.videoTaskApi = { ...safeApi, apiKey: '', model: 'new-current-model', endpoint: `${base}different-current-api` };
    state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null; state.settings.videoBackend = 'api';
    for (const name of ['textApi', 'visionApi', 'imageApi']) state.settings[name].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
    return { plans: plans.map((plan) => plan.id), boards: boards.map((board) => board.id), originalImageIds: images.map((image) => image.id), taskIds: tasks.map((task) => task.id) };
  }, { key: storageKey, base: baseUrl, b2: expectedB2 });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.id === 'gap-isolated-project', storageKey);
  const originalImages = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.assets.filter((asset) => asset.mediaType === 'image'), storageKey);
  const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  await nav('视频导演台');
  await page.locator('.video-director-view').waitFor();
  assert.equal(await page.locator('.video-director-view [data-video-task-id]').count(), 0, 'persisted video tasks must not be duplicated in the video director');
  assert.equal(await page.locator('.video-director-view').getByRole('heading', { name: '视频生成任务', exact: true }).count(), 0);
  await nav('生成任务');
  await page.locator('.jobs-view').waitFor();
  const historicalTaskCards = page.locator('.jobs-view [data-video-task-id]');
  assert.equal(await historicalTaskCards.count(), fixtureSummary.taskIds.length, 'every persisted video task must appear exactly once on the generation task page');
  await page.locator('.jobs-view [data-video-task-id="gap-task-a1-1"]').getByRole('button', { name: '查看来源提示词', exact: true }).click();
  await page.locator('.sequence-director-strip .sequence-segment-chip.active').filter({ hasText: '计划A第1段' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '长剧情拆段', exact: true }).getAttribute('aria-pressed'), 'true');
  stages.push('opened saved plan A segment 1 as initial director context');
  await nav('生成任务');
  await page.locator('.jobs-view').waitFor();
  assert.equal(await page.locator('.jobs-view [data-video-task-id]').count(), fixtureSummary.taskIds.length);
  await page.locator('.jobs-view [data-video-task-id="gap-task-b2-1"]').getByRole('button', { name: '查看来源提示词', exact: true }).click();
  await page.locator('.sequence-director-strip .sequence-segment-chip.active').filter({ hasText: '计划B第2段' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '长剧情拆段', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('.sequence-director-strip').innerText()).includes('计划B第1段'));
  assert.ok(!(await page.locator('.sequence-director-strip').innerText()).includes('计划A第1段'));
  await page.locator('.director-result-copy').filter({ hasText: '我会在桥边等你。' }).waitFor();
  assert.equal(await page.locator('.director-result-copy').textContent(), expectedB2);
  await page.locator('.director-result-copy').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'correct-plan-b-segment-2.png'), fullPage: false }); screenshots.push('correct-plan-b-segment-2.png');
  stages.push('generation tasks → source links open plan A then plan B segment 2 in the director without duplicating task cards');
  await page.getByRole('button', { name: /查看关联成片/u }).click();
  await page.getByRole('heading', { name: '视频资产库', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2);
  const relatedNames = await page.locator('.asset-card .asset-card-title, .asset-card h3').allTextContents();
  const relatedCardText = await page.locator('.asset-card').allTextContents();
  assert.ok(relatedCardText.every((text) => text.includes('计划B第2段成片-')));
  assert.ok(relatedCardText.some((text) => text.includes('计划B第2段成片-1')));
  assert.ok(relatedCardText.some((text) => text.includes('计划B第2段成片-2')));
  stages.push('related videos include both B2 takes and exclude plan A / B1 videos');
  await nav('生成任务');
  const deletedTask = page.locator('.jobs-view [data-video-task-id="gap-task-b2-1"]');
  await deletedTask.waitFor();
  await page.locator('.jobs-view [data-video-task-id="gap-task-b2-1"] + .row').getByRole('button', { name: '删除任务记录（保留成片）', exact: true }).click();
  await page.waitForFunction((key) => !JSON.parse(localStorage.getItem(key)).project.generationTasks.some((task) => task.id === 'gap-task-b2-1'), storageKey);
  const retained = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.assets.find((asset) => asset.id === 'gap-video-b2-1'), storageKey);
  assert.equal(retained.videoSourceTask.id, 'gap-task-b2-1');
  assert.equal(retained.videoSourceTask.videoJob.snapshot.draft.parameters.seed, 424242);
  assert.equal(retained.videoSourceTask.videoJob.snapshot.draft.prompt, expectedB2);
  assert.deepEqual(retained.videoSourceTask.videoJob.snapshot.images.map((image) => image.assetId), fixtureSummary.originalImageIds);
  await nav('资产库');
  await page.getByRole('button', { name: '视频资产库', exact: true }).click();
  const assetCard = page.locator('.asset-card').filter({ hasText: '计划B第2段成片-1' });
  await assetCard.getByText('查看本次提示词、图片和参数', { exact: true }).click();
  assert.equal(await assetCard.locator('.asset-video-source pre').first().textContent(), expectedB2);
  assert.equal(await assetCard.locator('.asset-video-source-image').count(), 2);
  assert.ok((await assetCard.locator('.asset-video-source').innerText()).includes('424242'));
  await assetCard.locator('.asset-video-source').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'deleted-task-preserved-provenance.png'), fullPage: false }); screenshots.push('deleted-task-preserved-provenance.png');
  await assetCard.getByRole('button', { name: '载入相同设置再次生成', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), expectedB2);
  assert.equal(await page.getByLabel('视频 API 配置', { exact: true }).inputValue(), '__saved');
  assert.equal(await page.locator('.vd-reference-row').count(), 2);
  assert.equal(await page.getByLabel('图片 1 用途', { exact: true }).inputValue(), 'composition');
  assert.equal(await page.getByLabel('图片 2 用途', { exact: true }).inputValue(), 'character');
  await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
  assert.equal(JSON.parse(await page.locator('label.field').filter({ hasText: '额外参数 JSON（仅显式覆盖字段）' }).locator('textarea').inputValue()).seed, 424242);
  assert.ok((await page.locator('.video-director-view').innerText()).includes('original-frozen-model'));
  // Also enter from single mode: navigation must restore productionMode,
  // not merely leave an already-selected sequence tab unchanged.
  await page.getByRole('button', { name: '查看原稿', exact: true }).click();
  await page.getByRole('button', { name: '单段直出', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '单段直出', exact: true }).getAttribute('aria-pressed'), 'true');
  await nav('视频导演台');
  await page.getByRole('button', { name: '查看原稿', exact: true }).click();
  await page.locator('.sequence-director-strip .sequence-segment-chip.active').filter({ hasText: '计划B第2段' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '长剧情拆段', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.director-result-copy').textContent(), expectedB2);
  const afterImages = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.assets.filter((asset) => asset.mediaType === 'image'), storageKey);
  assert.deepEqual(afterImages, originalImages, 'source images and roles remain byte-for-byte unchanged');
  assert.equal(await page.evaluate(() => window.__videoGapQa.postCount), 0);
  assert.equal(await page.evaluate(() => window.__videoGapQa.downloads), 0);
  assert.deepEqual(await page.evaluate(() => window.__videoGapQa.requests), []);
  stages.push('deleting task keeps video + complete source; reuse restores frozen prompt, images, seed and API without submitting; source from single mode restores B2 sequence');
  // Replace one current image and delete another only inside this isolated
  // fixture. Archived thumbnails must still show the captured original bytes.
  const replacementPixels = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key));
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#1ee632'; paint.fillRect(0, 0, 128, 96); paint.fillStyle = '#000'; paint.fillText('CURRENT BBBB', 5, 50);
    const replacement = canvas.toDataURL('image/png');
    state.project.assets = state.project.assets.filter((asset) => asset.id !== 'gap-character').map((asset) => asset.id === 'gap-composition' ? { ...asset, name: '后来替换的图片BBBB', dataUrl: replacement } : asset);
    state.projects = state.projects.map((project) => project.id === state.project.id ? state.project : project);
    localStorage.setItem(key, JSON.stringify(state));
    return replacement;
  }, storageKey);
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  await nav('资产库');
  await page.getByRole('button', { name: '视频资产库', exact: true }).click();
  const frozenCard = page.locator('.asset-card').filter({ hasText: '计划B第2段成片-1' });
  await frozenCard.getByText('查看本次提示词、图片和参数', { exact: true }).click();
  assert.deepEqual(await frozenCard.locator('.asset-video-source-image img').evaluateAll((elements) => elements.map((element) => element.getAttribute('src'))), originalImages.map((asset) => asset.dataUrl));
  await frozenCard.getByRole('button', { name: '载入相同设置再次生成', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  assert.deepEqual(await page.locator('.vd-reference-thumb img').evaluateAll((elements) => elements.map((element) => element.getAttribute('src'))), originalImages.map((asset) => asset.dataUrl));
  assert.equal(await page.locator('.vd-reference-row .vd-error').count(), 0, 'deleting the current asset must not falsely hide its frozen pixels');
  await page.getByRole('button', { name: '预览 原始桥边构图图', exact: true }).click();
  let imageDialog = page.getByRole('dialog', { name: '图片预览 · 原始桥边构图图', exact: true });
  assert.equal(await imageDialog.locator('img').getAttribute('src'), originalImages[0].dataUrl);
  await imageDialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: '改用当前图片（解除原快照）', exact: true }).isVisible());
  await page.locator('.vd-reference-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'frozen-reference-after-live-replacement.png'), fullPage: false }); screenshots.push('frozen-reference-after-live-replacement.png');
  await page.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
  const libraryDialog = page.getByRole('dialog', { name: '从图片资产库选择生成参考图', exact: true });
  assert.equal(await libraryDialog.locator('.vd-image-choice').count(), 1);
  assert.equal(await libraryDialog.locator('.vd-image-choice img').getAttribute('src'), replacementPixels, 'library picker must intentionally show the current replacement');
  await libraryDialog.getByRole('button', { name: '放大预览', exact: true }).click();
  imageDialog = page.getByRole('dialog', { name: '图片预览 · 后来替换的图片BBBB', exact: true });
  assert.equal(await imageDialog.locator('img').getAttribute('src'), replacementPixels);
  await imageDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await libraryDialog.getByRole('button', { name: '使用所选图片', exact: true }).click();
  assert.equal(await page.locator('.vd-reference-row').count(), 1);
  assert.equal(await page.locator('.vd-reference-thumb img').getAttribute('src'), replacementPixels);
  assert.equal(await page.getByLabel('视频 API 配置', { exact: true }).inputValue(), '', 'explicit current-image confirmation unbinds the frozen connection too');
  assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), expectedB2);
  await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
  assert.equal(JSON.parse(await page.locator('label.field').filter({ hasText: '额外参数 JSON（仅显式覆盖字段）' }).locator('textarea').inputValue()).seed, 424242);
  assert.deepEqual(await page.evaluate(() => window.__videoGapQa.requests), []);
  assert.equal(await page.evaluate(() => window.__videoGapQa.downloads), 0);
  stages.push('frozen originals survive same-ID replacement and deleted live image; draft and enlarged preview keep old bytes; explicit library selection uses BBBB while preserving prompt/seed with zero POST');
  assert.deepEqual(errors, []);
  const report = { mockOnly: true, noProductionDataRead: true, fixtureSummary, stages, screenshots, relatedNames, requests: await page.evaluate(() => ({ postCount: window.__videoGapQa.postCount, downloads: window.__videoGapQa.downloads })), errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  const notice = page ? await page.locator('.sidebar-notice').textContent().catch(() => '') : '';
  const body = page ? (await page.locator('body').innerText().catch(() => '')).slice(-9000) : '';
  if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ stages, errors, notice, body, error: String(error), cause: error?.cause ? String(error.cause) : undefined }, null, 2));
  throw new Error(`Video gap UI QA failed: ${JSON.stringify({ stages, errors, notice })}`, { cause: error });
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
