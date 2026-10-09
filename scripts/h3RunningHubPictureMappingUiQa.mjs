import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App, director and generation engine. Only the desktop transport/media
// boundary is mocked. The mock accepts loopback-only endpoints and synthetic
// color tiles; no project directory, real credential or provider is accessed.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, 'h3-runninghub-picture-mapping');
const tailOnly = process.argv.includes('--tail-only');
const reportFile = path.join(output, tailOnly ? 'report-tail.json' : 'report.json');
assert.ok(path.relative(outputBase, output) && !path.relative(outputBase, output).startsWith('..'));
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output cannot traverse links: ${candidate}`);
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const key = 'lianhua_video_director_state_v22'; const fixturePath = '/__h3_rh_picture_fixture.html';
const fixtureImagesKey = '__h3_rh_picture_images';
const qa = { pass: false, mockOnly: true, noProductionDataRead: true, tailOnly, stages: [], errors: [], blockedRequests: [], cases: [], screenshots: [] };
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'H3 RunningHub picture mapping isolated UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); qa.screenshots.push(file); };
const state = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);

async function installMockDesktop() {
  await page.addInitScript(({ origin, fixtureImagesKey }) => {
    const ledger = window.__h3RunningHubQa = { requests: [], uploads: [], runs: [], queries: [], extractions: [], downloads: [], checkpoints: {}, credentials: {} };
    const json = (value) => ({ status: 200, body: JSON.stringify(value) });
    const images = () => JSON.parse(sessionStorage.getItem(fixtureImagesKey) || '{}');
    const local = (url) => { const parsed = new URL(url); if (parsed.origin !== origin || !parsed.pathname.startsWith('/__h3_rh_mock__/')) throw new Error(`Isolated mock rejected endpoint: ${url}`); return parsed; };
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        const url = local(request.url); ledger.requests.push({ method: request.method, path: url.pathname });
        if (url.pathname.endsWith('/media/upload/binary')) {
          const file = request.multipart?.files?.[0];
          if (!file?.dataUrl || !Object.values(images()).includes(file.dataUrl)) throw new Error('Upload is not a synthetic fixture color tile');
          const assetId = Object.entries(images()).find(([, dataUrl]) => dataUrl === file.dataUrl)?.[0];
          const fileName = `openapi/${assetId}-${ledger.uploads.length + 1}.png`;
          ledger.uploads.push({ assetId, fileName }); return json({ code: 0, data: { fileName } });
        }
        if (url.pathname.includes('/run/')) {
          const taskId = `fixture-remote-${ledger.runs.length + 1}`; const body = JSON.parse(request.body);
          ledger.runs.push({ taskId, body }); return json({ taskId, status: 'QUEUED', results: null, errorCode: '' });
        }
        if (url.pathname.endsWith('/query')) {
          const { taskId } = JSON.parse(request.body); ledger.queries.push(taskId);
          return json({ taskId, status: 'SUCCESS', results: [{ outputType: 'mp4', nodeId: 'output-video', url: `${origin}/__h3_rh_mock__/media/${taskId}.mp4` }], errorCode: '' });
        }
        throw new Error(`Unexpected local RunningHub request: ${url.pathname}`);
      },
      request: async () => { throw new Error('This picture mapping QA must not call text or vision AI'); },
      cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { ledger.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (taskId) => ledger.credentials[taskId] || null,
      saveVideoTaskCheckpoint: async (task) => { ledger.checkpoints[task.id] = structuredClone(task); return { persisted: true }; },
      getVideoTaskCheckpoint: async (taskId) => structuredClone(ledger.checkpoints[taskId] || null),
      deleteVideoTaskCheckpoint: async (taskId) => { delete ledger.checkpoints[taskId]; return true; },
      downloadGeneratedMedia: async (request) => {
        const url = local(request.url); const name = url.pathname.split('/').at(-1); ledger.downloads.push(name);
        return { fileName: name, relativePath: `video/${name}`, checksum: `fixture-video-${name}`, mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 100, managed: true, missing: false, url: 'data:video/mp4;base64,AAAA', durationSec: 10, width: 160, height: 96 };
      },
      readManagedImageDataUrl: async ({ relativePath }) => ({ dataUrl: images()[relativePath.includes('synthetic-tail') ? 'synthetic-tail' : relativePath.split('/').at(-1).replace(/\.png$/u, '')] }),
      videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'Synthetic isolated media tools' }),
      probeWorkbenchVideo: async () => ({ durationSec: 10, width: 160, height: 96, fps: 10, hasAudio: false, videoCodec: 'h264' }),
      onWorkbenchProgress: () => () => {}, cancelWorkbenchJob: async () => true,
      extractWorkbenchFrames: async (request) => {
        if (request.mode !== 'last') throw new Error('QA allows local last-frame extraction only');
        ledger.extractions.push({ mode: request.mode, source: request.source });
        return { probe: { durationSec: 10, width: 160, height: 96, fps: 10, hasAudio: false, videoCodec: 'h264' }, frames: [{ role: 'last-frame', dataUrl: images()['synthetic-tail'], relativePath: 'images/synthetic-tail.png', fileName: 'synthetic-tail.png', checksum: 'fixture-tail-checksum', mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, sizeBytes: 100, width: 160, height: 96, timeSec: 9.9, frameIndex: 99 }] };
      },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin, fixtureImagesKey });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      qa.blockedRequests.push({ url: request.url(), method: request.method() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Synthetic H3 picture fixture</title><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root">合成中性人物参考测试</div></body></html>' }); return; }
    await route.continue();
  });
}

async function checkManualSnapshotRemoval() {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { createInitialState } = await import('/src/storage.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    const state = createInitialState(); const now = Date.now();
    const assets = ['manual-image-a', 'manual-image-b'].map((id, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
      const paint = canvas.getContext('2d'); paint.fillStyle = index ? '#436587' : '#678345'; paint.fillRect(0, 0, 160, 96);
      return { id, name: id, type: 'reference', role: 'composition', referenceRole: 'composition', source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 160, height: 96, tags: [], createdAt: now, updatedAt: now };
    });
    const draft = { name: '合成旧任务设置', backend: 'api', prompt: 'Two neutral opaque display mannequins stand beside a bridge.', references: assets.map((asset, index) => ({ assetId: asset.id, role: 'composition', slotIndex: index * 2 })), parameters: { seed: 123 } };
    const project = { ...state.project, id: 'manual-snapshot-removal-project', assets, storyboards: [], sequencePlans: [], generationTasks: [] };
    const settings = { ...state.settings, videoBackend: 'api', videoSource: 'api', activeVideoApiProfileId: null, videoApiProfiles: [], videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'isolated-video', endpoint: `${location.origin}/__h3_rh_mock__/unused`, requestTemplate: '' } };
    const oldTask = { id: 'manual-frozen-task', kind: 'video', status: 'failed', requestBody: {}, createdAt: now, updatedAt: now, videoJob: { stage: 'failed', snapshot: { projectId: project.id, clientId: 'manual-frozen-task', draft, connection: { backend: 'api', api: settings.videoTaskApi }, images: draft.references.map((reference, index) => ({ ...reference, ...assets[index], assetId: reference.assetId, freezeState: 'frozen', frozenAt: now })) } } };
    project.generationTasks = [oldTask];
    const qa = window.__h3ManualSnapshotQa = { submissions: [], persisted: [], original: structuredClone(oldTask), project };
    const controller = { runtimeById: {}, start: async (value) => { qa.submissions.push(structuredClone(value)); return 'mock-task'; }, startBatch: async () => { throw new Error('Manual removal fixture never submits a batch'); }, cancel: async () => {}, cancelBatch: async () => ({ canceled: [], skipped: [] }), resume: async () => {}, retryDownload: async () => {} };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(VideoDirectorView, { project, settings, chapterId: 'manual-fixture-chapter', controller, launchRequest: { id: 'manual-reuse-launch', taskId: oldTask.id }, onChapterDraftChange: (_projectId, _chapterId, value) => qa.persisted.push(structuredClone(value)) }));
  });
  const unfreeze = page.getByRole('button', { name: '改用当前图片（解除原快照）', exact: true });
  await unfreeze.waitFor();
  assert.equal(await page.locator('.vd-reference-row').count(), 2);
  await page.getByRole('button', { name: '移除图片 1', exact: true }).click();
  await page.waitForFunction(() => window.__h3ManualSnapshotQa.persisted.at(-1)?.draft.references.length === 1);
  assert.equal(await unfreeze.count(), 0, 'explicitly removing an image clears old-task snapshot reuse immediately');
  assert.equal(await page.getByRole('button', { name: '移除图片 3', exact: true }).count(), 1, 'remaining image keeps its physical slot');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__h3ManualSnapshotQa.submissions.length === 1);
  const result = await page.evaluate(() => window.__h3ManualSnapshotQa);
  assert.equal(result.submissions[0].reuseTaskId, undefined, 'submission resolves current selected images instead of reusing the old snapshot');
  assert.equal(result.submissions[0].prompt, result.original.videoJob.snapshot.draft.prompt);
  assert.deepEqual(result.submissions[0].parameters, { seed: 123 });
  assert.deepEqual(result.submissions[0].references.map(({ assetId, slotIndex }) => ({ assetId, slotIndex })), [{ assetId: 'manual-image-b', slotIndex: 2 }]);
  assert.deepEqual(result.project.generationTasks[0], result.original, 'manual editing leaves the archived failed task unchanged');
  qa.stages.push('manual-removal-clears-reused-task-snapshot-preserving-prompt-seed-and-remaining-slot');
}

async function seed() {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  const original = await page.evaluate(async ({ key, origin, fixtureImagesKey }) => {
    const { createInitialState } = await import('/src/storage.ts'); const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now();
    const names = ['QAAlpha', 'QABeta', 'QAGamma', 'QADelta', 'QAEpsilon']; const oldNumbers = [2, 4, 7, 8, 9];
    const images = {}; const makeImage = (id, index, characterId) => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96; const paint = canvas.getContext('2d'); paint.fillStyle = `hsl(${index * 37} 32% 50%)`; paint.fillRect(0, 0, 160, 96); paint.fillStyle = '#fff'; paint.fillRect(index + 2, 10, 8, 8); const dataUrl = canvas.toDataURL('image/png'); images[id] = dataUrl;
      return { id, name: id, type: characterId ? 'character' : 'reference', role: characterId ? 'character' : 'composition', referenceRole: characterId ? 'character' : 'composition', source: 'upload', sourceEntityKind: characterId ? 'character' : undefined, sourceEntityId: characterId, characterReferenceId: characterId, dataUrl, mediaType: 'image', mimeType: 'image/png', width: 160, height: 96, tags: ['Synthetic neutral color tile'], createdAt: now, updatedAt: now };
    };
    const selected = ['scene-image', ...names.map((_, index) => `person-image-${index + 1}`)];
    const assets = selected.map((id, index) => makeImage(id, index, index ? `person-${index}` : undefined));
    assets.push(...[3, 5, 6].map((number) => makeImage(`old-unselected-${number}`, number + 6)));
    makeImage('synthetic-tail', 20);
    const characters = names.map((name, index) => ({ id: `person-${index + 1}`, name, gender: '男', apparentAge: '30岁', actualAge: '30岁', race: '展示假人', morphology: 'humanoid', bodyPlan: '完整中性展示轮廓', appearance: '光滑不透明蓝色外壳', outfit: '中性展示外壳', anchor: '程序测试假人', personality: '', signatureProps: '', motionHabits: '', negativeContinuity: '', assetIds: [`person-image-${index + 1}`] }));
    const anchor = (name) => `Identity: ${name}, a neutral opaque blue display mannequin.`;
    const prompt = (language, index) => [
      'integrated_multimodal_description:', '[Shot 1] At 00:00.000,',
      ...names.map((name, offset) => `${anchor(name)} Appearance follows <Picture ${oldNumbers[offset]}>.`),
      `QA_SEGMENT_${index}_${language.toUpperCase()}: The five mannequins stand beside a stone bridge from <Picture 1>. The appearances shown in <Picture 7>, <Picture 8> and <Picture 9> remain distinct.`,
      'overall_soundscape: Quiet river.', 'non_diegetic_music: N/A',
    ].join('\n');
    const manifest = Array.from({ length: 9 }, (_, offset) => { const number = offset + 1; const person = oldNumbers.indexOf(number); return { id: number === 1 ? 'scene-image' : person >= 0 ? `person-image-${person + 1}` : `old-unselected-${number}`, token: `<Picture ${number}>` }; });
    const segments = [1, 2].map((index) => ({ id: `picture-segment-${index}`, index, title: `合成分段 ${index}`, globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10, content: '中性展示假人位于青石桥旁。', summary: '程序测试', sourceSceneIds: ['picture-scene'], sourceBeatIds: [], narrativePurpose: '保持连续', entryState: '', exitState: '', transitionHint: '', storyboardId: `picture-board-${index}`, status: 'ready' }));
    const plan = { id: 'picture-plan', title: 'H3图片编号隔离测试', sourceStoryTitle: '合成剧情', sourceStoryContent: '中性展示假人位于青石桥旁。', durationMode: 'ai-estimated', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural', segmentationSource: 'ai', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const bindings = { version: 1, characters: characters.map((character) => ({ characterId: character.id, name: character.name, referenceAnchor: anchor(character.name) })) };
    const boards = segments.map((segment) => {
      const zh = prompt('zh', segment.index); const en = prompt('en', segment.index);
      return { id: segment.storyboardId, sceneId: 'picture-scene', sourceStoryTitle: segment.title, sourceStoryContent: plan.sourceStoryContent, workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [...selected], finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh, officialPromptEn: en, officialPromptEnSource: zh, englishPrompt: en, englishPromptSource: zh, h3IdentityBindings: bindings, h3IdentityBindingsEn: bindings, promptMigrationPending: false, targetOutput: { prompt: zh, referenceManifest: manifest }, promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', sourceDocumentIds: [], referenceAssetIds: [...selected], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete' }, shots: [{ id: `picture-shot-${segment.index}`, index: 1, startSec: 0, endSec: 10, purpose: '展示', subject: names.join('、'), action: '中性站立', camera: '固定中景', lighting: '自然光', sound: '水声', transition: '顺接', result: '站姿保持', referenceAssetIds: [...selected], prompt: zh, locked: false }], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 2, createdAt: now, updatedAt: now };
    });
    const imageNodes = ['438', '435', '437', '439', '431', '429'];
    const workflow = { id: 'picture-cloud', name: 'Synthetic MiniMax H3 six-image workflow', runKind: 'ai-app', remoteId: '2104753059472990209', outputNodeId: 'output-video', requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'prompt', fieldName: 'text', fieldValue: '' }, ...imageNodes.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'example.png' })), { nodeId: '827', fieldName: 'value', fieldValue: '6' }], usePersonalQueue: false }), mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: imageNodes.map((nodeId, index) => ({ nodeId, inputName: 'image', role: index ? 'character' : 'first-frame' })) }, createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'h3-picture-ui-project', name: 'H3图片编号隔离测试', sourceDocuments: [], characters, locations: [], props: [], assets, scenes: [{ id: 'picture-scene', title: '青石桥', content: plan.sourceStoryContent, summary: '', characterIds: characters.map((character) => character.id), locationIds: [], propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }], storyboards: boards, sequencePlans: [plan], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api'; state.settings.activeVideoApiProfileId = null; state.settings.videoApiProfiles = [];
    state.settings.runningHubVideo = { enabled: true, baseUrl: `${origin}/__h3_rh_mock__`, apiKey: 'synthetic-local-key', activeWorkflowId: workflow.id, workflows: [workflow] };
    state.settings.videoTaskApi.enabled = false; state.settings.textApi.enabled = false; state.settings.visionApi.enabled = false;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); sessionStorage.setItem(fixtureImagesKey, JSON.stringify(images));
    return { boards: boards.map((board) => ({ id: board.id, zh: board.officialPromptZh, en: board.officialPromptEn, manifest: board.targetOutput.referenceManifest })), selected, imageNodes, oldNumbers };
  }, { key, origin, fixtureImagesKey });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByRole('button', { name: '全选英文', exact: true }).click();
  return original;
}

async function checkCase(tail) {
  const original = await seed();
  if (tail) {
    const toggle = page.locator('[data-segment-id="picture-segment-2"]').getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', `tail mode must be enabled before generating: ${await page.locator('[role="alert"]').allInnerTexts()}`);
  }
  await page.getByRole('button', { name: '检查并生成 2 段视频', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await dialog.waitFor(); await dialog.getByLabel('确认批量生成费用', { exact: true }).check();
  await dialog.getByRole('button', { name: '确认生成 2 段', exact: true }).click();
  await page.waitForFunction((key) => { const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks.filter((task) => task.kind === 'video'); return tasks.length === 2 && tasks.every((task) => ['succeeded', 'failed'].includes(task.status)); }, key, { timeout: 65_000 });
  const current = await state(); const ledger = await page.evaluate(() => window.__h3RunningHubQa);
  const tasks = current.project.generationTasks.filter((task) => task.kind === 'video');
  for (const task of tasks) assert.equal(task.status, 'succeeded', task.error);
  assert.equal(ledger.runs.length, 2); assert.equal(ledger.uploads.length, 12, 'six actual images per segment without duplicated filler images');
  assert.equal(ledger.extractions.length, tail ? 1 : 0, 'only tail inheritance extracts exactly one local last frame');
  const records = [];
  for (const [offset, run] of ledger.runs.entries()) {
    const nodes = run.body.nodeInfoList; const value = (nodeId, fieldName) => nodes.find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;
    const prompt = value('prompt', 'text');
    assert.match(prompt, new RegExp(`QA_SEGMENT_${offset + 1}_EN`, 'u'), 'the actual POST uses the selected English source');
    assert.doesNotMatch(prompt, /<Picture [789]>/u, 'stale source numbering does not survive six-image submission');
    const actualPictures = [...new Set([...prompt.matchAll(/<Picture ([1-9]\d*)>/gu)].map((match) => Number(match[1])))];
    assert.ok(actualPictures.every((number) => number >= 1 && number <= 6));
    assert.equal(Number(value('827', 'value')), 6, 'actual image count equals the six connected files');
    const connectedAssets = original.imageNodes.map((nodeId) => ledger.uploads.find((upload) => upload.fileName === value(nodeId, 'image'))?.assetId);
    const expectedAssets = tail && offset === 1 ? ['synthetic-tail', ...original.selected.slice(1)] : original.selected;
    assert.deepEqual(connectedAssets, expectedAssets, 'each actual Picture number points to its intended uploaded asset');
    for (let index = 1; index <= 5; index += 1) {
      const name = ['QAAlpha', 'QABeta', 'QAGamma', 'QADelta', 'QAEpsilon'][index - 1];
      assert.match(prompt, new RegExp(`${name}[^\\n]*<Picture ${index + 1}>`, 'u'), `identity ${name} binds to its own actual file`);
    }
    const task = tasks.find((task) => task.remoteTaskId === run.taskId);
    assert.equal(task.videoJob.snapshot.draft.prompt, prompt, 'saved task snapshot matches the final submitted H3');
    records.push({ segment: offset + 1, pictureNumbers: actualPictures, connectedAssets, count: Number(value('827', 'value')) });
  }
  for (const board of original.boards) {
    const actual = current.project.storyboards.find((entry) => entry.id === board.id);
    assert.equal(actual.officialPromptZh, board.zh); assert.equal(actual.officialPromptEn, board.en);
    assert.deepEqual(actual.targetOutput.referenceManifest, board.manifest, 'request remapping does not rewrite the saved source manifest');
  }
  await capture(tail ? 'tail-chain-six-pictures' : 'ordinary-batch-six-pictures');
  qa.cases.push({ tail, tasks: 2, uploads: ledger.uploads.length, extractions: ledger.extractions.length, records });
  qa.stages.push(tail ? 'English-H3-local-tail-inheritance-remaps-original-nine-picture-manifest-to-six-real-files-and-keeps-source' : 'English-H3-ordinary-batch-remaps-original-nine-picture-manifest-to-six-real-files-and-keeps-source');
}

async function run() {
  await waitForCondition({ label: 'local Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => qa.errors.push(error.message));
  await installMockDesktop();
  if (!tailOnly) { await checkManualSnapshotRemoval(); await checkCase(false); }
  await checkCase(true);
  assert.deepEqual(qa.errors, []); assert.deepEqual(qa.blockedRequests, []); qa.pass = true;
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  qa.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); qa.failure.bodyText = await page.locator('body').innerText().catch(() => ''); qa.failure.ledger = await page.evaluate(() => window.__h3RunningHubQa).catch(() => undefined); }
  process.exitCode = error.exitCode || 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {}); harness.markElectronStopping();
  await harness.stopAll().catch((error) => { qa.cleanupError = error.message; qa.pass = false; process.exitCode = 1; });
  await fs.writeFile(reportFile, `${JSON.stringify(qa, null, 2)}\n`); await fs.writeFile(path.join(output, tailOnly ? 'vite-process-tail.log' : 'vite-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: qa.pass, stages: qa.stages, cases: qa.cases, report: reportFile, failure: qa.failure?.message }, null, 2));
