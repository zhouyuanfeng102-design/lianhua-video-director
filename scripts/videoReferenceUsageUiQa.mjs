import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Mount the real director only. The production App, saved projects, desktop
// bridge and generation engines are never mounted. Controllers only record
// submissions, and every non-local request is blocked before network access.
export const videoReferenceUsageQaInventory = [
  'RunningHub 首帧槽接受普通构图图；本段用途可自选，素材分类不改',
  '选图器可将任意普通场景图移至第1槽，不要求先给素材打首帧标签',
  '选中卡片显示首帧/人物编号和真实槽位，取消不前移，补图继承空槽用途',
  '图片选择与槽位用途独立分栏，默认选图，切换保留搜索、选图和空槽用途',
  '六个槽全展示；只选两张或完全不选时不会要求补满',
  '已启用本地末帧组合的选图器保留槽1，改人物图后组合不取消且不重复抽帧',
  '文本API关闭：选图、用途、复制、静态/依赖末帧组合与最终提交不重写已有H3正文',
  '本段槽位用途可编辑，修改只影响本段，分类不匹配仅提示',
  '切换普通图片槽工作流不猜首帧，原素材用途和顺序可恢复',
  '批量首段成功核对，第二段本地末帧组合仍是尾帧1、人物2起',
  '单段 RunningHub / ComfyUI 与批量显示和实际提交一致',
  '普通图片也可用于明确尾帧槽，角色适配不修改H3原提示词',
  '槽位不足保留所有选图，不截断、不提交、不发收费请求',
  '1120×760 / 1280×800 选图与用途可见可操作，无横向溢出',
];

export async function showVideoReferencePickerPane(dialog, name) {
  const tab = dialog.getByRole('tab', { name, exact: true });
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  const panel = dialog.getByRole('tabpanel', { name, exact: true });
  await panel.waitFor();
  assert.equal(await dialog.getByRole('tabpanel').count(), 1, 'only the active column is exposed to users and accessibility');
  return panel;
}

export async function assertVideoReferencePickerStartsWithImages(dialog) {
  assert.equal(await dialog.getByRole('tab', { name: '图片选择', exact: true }).getAttribute('aria-selected'), 'true', 'each opening starts in the picture library');
  const panel = dialog.getByRole('tabpanel', { name: '图片选择', exact: true });
  await panel.waitFor();
  assert.equal(await panel.locator('.vd-slot-usage-editor').count(), 0, 'slot purpose controls never occupy the picture selection column');
  assert.equal(await panel.getByRole('combobox', { name: /图片槽\s+\d+\s+用途/u }).count(), 0, 'the library may filter image categories but never edits slot purposes');
  assert.equal(await dialog.locator('.vd-slot-usage-editor:visible').count(), 0, 'hidden purpose editor cannot crowd out selectable images');
  assert.equal(await dialog.getByRole('tab', { name: '槽位用途', exact: true }).count(), 1, 'purpose editing has its own column');
}

export async function installVideoReferenceUsageFixture(page, baseUrl, fixtureOptions = {}) {
  const origin = new URL(baseUrl).origin;
  const blockedRequests = [];
  const textRequests = [];
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__unused-video-reference-api/**', async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__unused-text-reference-api/**', async (route) => {
    textRequests.push(route.request().url()); blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__video_reference_usage_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__video_reference_usage_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async (fixtureOptions) => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { resolveConfiguredVideoApi } = await import('/src/runningHubVideo.ts');
    await import('/src/styles.css');
    const e = React.createElement; const state = createInitialState(); const now = Date.now();
    const qa = window.__videoReferenceUsageQa = { submissions: [], aiCalls: 0, extractionCalls: 0, resetCount: 0 };
    const asset = (id, name, role, entityId) => {
      name = fixtureOptions.assetNames?.[id] || name;
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 150;
      const paint = canvas.getContext('2d'); paint.fillStyle = role === 'character' ? '#426386' : '#6b8861'; paint.fillRect(0, 0, 240, 150);
      paint.fillStyle = '#fff'; paint.font = '17px sans-serif'; paint.fillText(name, 10, 78);
      return { id, name, type: 'reference', role, referenceRole: role, source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 240, height: 150, relativePath: `assets/${id}.png`, checksum: `checksum-${id}`, sourceEntityId: entityId, sourceEntityKind: entityId ? 'character' : undefined, tags: [], createdAt: now, updatedAt: now };
    };
    const assets = [
      asset('ruq-composition', '分镜构图原图', 'composition'),
      ...['a', 'b', 'c'].map((key, index) => asset(`ruq-${key}`, `${['甲', '乙', '丙'][index]}人物参考`, 'character', `ruq-person-${key}`)),
      asset('ruq-scene', '普通场景照片', 'scene'), asset('ruq-style', '普通风格照片', 'style'),
      asset('ruq-a-alt', '甲人物另一张参考', 'character', 'ruq-person-a'),
    ];
    const refs = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-c'];
    const characters = ['a', 'b', 'c'].map((key, index) => ({ id: `ruq-person-${key}`, name: `${['甲', '乙', '丙'][index]}人物`, gender: index === 0 ? '女' : '男', apparentAge: '30', race: '人类', appearance: '固定身份', outfit: '普通外套', signatureProps: '', personality: '', motionHabits: '', anchor: '隔离测试人物', negativeContinuity: '', assetIds: [`ruq-${key}`] }));
    const prompt = (index) => [
      'subject_definitions:', '<Subject 1> is 甲人物 referenced from <Picture 2>: 普通外套。',
      '<Subject 2> is 乙人物 referenced from <Picture 3>: 普通外套。', '<Subject 3> is 丙人物 referenced from <Picture 4>: 普通外套。',
      'summary:', `第${index}段，三人沿山路前行。Scene composition from <Picture 1>.`,
      'retention_analysis:', '所有人物身份与剧情保持。',
      'detailed_description:', 'Shot 1 【0s-15s】<Subject 1>、<Subject 2>与<Subject 3>继续前行。<Subject 1>说：“明天出发。”',
      'overall_soundscape:', '脚步与风声。', 'non_diegetic_music:', '保持已有音乐状态。',
    ].join('\n');
    const segments = [1, 2, 3].map((index) => ({ id: `ruq-segment-${index}`, index, title: `山路同行${index}`, globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15, content: '三人沿山路前行。', summary: '连续前行', sourceSceneIds: ['ruq-scene-story'], sourceBeatIds: [], narrativePurpose: '连续动作', entryState: '', exitState: '', transitionHint: '', storyboardId: `ruq-board-${index}`, status: 'ready' }));
    const plan = { id: 'ruq-plan', title: '自选图片与输入槽隔离测试', sourceStoryTitle: '隔离测试剧情', sourceStoryContent: '三人沿山路前行。', durationMode: 'ai-estimated', totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const makeProject = (options = {}) => {
      const boards = segments.map((segment) => {
        const text = prompt(segment.index);
        return { id: segment.storyboardId, sceneId: 'ruq-scene-story', sourceStoryTitle: segment.title, workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [...refs], finalPrompt: text, officialPromptZh: text, officialPromptSource: text, promptMigrationPending: false,
          targetOutput: { prompt: text, referenceManifest: refs.map((id, index) => ({ id, token: `<Picture ${index + 1}>` })) },
          promptTrace: { sourceDocumentIds: [], referenceAssetIds: [...refs], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(text), shotPlanMode: 'ai-complete' },
          shots: [{ id: `ruq-shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, subject: '甲人物、乙人物、丙人物', action: '并肩前行', camera: '跟拍', lighting: '自然光', sound: '风声', referenceAssetIds: [...refs], prompt: text, locked: false }], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, createdAt: now, updatedAt: now };
      });
      const video = { id: 'ruq-video-1', name: '上一段隔离成片', type: 'video', mediaType: 'video', mimeType: 'video/mp4', role: 'motion', referenceRole: 'motion', source: 'generated', sourceStoryboardId: 'ruq-board-1', relativePath: 'assets/ruq-video-1.mp4', checksum: 'checksum-ruq-video-1', durationSec: 15, width: 480, height: 270, tags: [], createdAt: now, updatedAt: now };
      return { ...state.project, id: `ruq-project-${++qa.resetCount}`, name: '自选首帧隔离测试', sourceDocuments: [], characters: structuredClone(characters), locations: [], props: [], scenes: [{ id: 'ruq-scene-story', title: '山路', content: '三人沿山路前行。', summary: '', characterIds: characters.map((entry) => entry.id), propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }], sequencePlans: [structuredClone(plan)], storyboards: boards, assets: [...structuredClone(assets), ...(options.withVideo ? [video] : [])], generationTasks: [] };
    };
    const makeCloud = (id, name, roles) => ({
      id, name, runKind: 'workflow', remoteId: '1234567890', requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: '' }, ...roles.map((_, index) => ({ nodeId: String(index + 2), fieldName: 'image', fieldValue: '' }))], usePersonalQueue: false }),
      mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: roles.map((role, index) => ({ nodeId: String(index + 2), inputName: 'image', role })) }, createdAt: now, updatedAt: now,
    });
    const makeComfy = (id, name, roles) => {
      const nodes = { 1: { class_type: 'Text', inputs: { text: '' } } };
      roles.forEach((_, index) => { nodes[String(index + 2)] = { class_type: 'LoadImage', inputs: { image: '' } }; });
      return { id, name, workflowJson: JSON.stringify(nodes), mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images: roles.map((role, index) => ({ nodeId: String(index + 2), inputName: 'image', role })) }, createdAt: now, updatedAt: now };
    };
    const makeSettings = (options = {}) => {
      const boundary = ['first-frame', 'character', 'character', 'character']; const ordinary = ['general', 'character', 'character', 'character'];
      const ending = ['general', 'character', 'character', 'last-frame'];
      const six = [...boundary, 'general', 'general'];
      const selected = options.workflow || 'boundary'; const source = options.source || 'runninghub';
      return { ...state.settings, videoBackend: source === 'comfyui' ? 'comfyui' : 'api', videoSource: source, activeVideoApiProfileId: null, videoApiProfiles: [],
        textApi: { ...state.settings.textApi, enabled: false, apiKey: '', baseUrl: `${location.origin}/__unused-text-reference-api/rewrite` }, textApiProfiles: [], activeTextApiProfileId: null,
        videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'isolated-video', apiKey: '', endpoint: `${location.origin}/__unused-video-reference-api/generate`, statusEndpointTemplate: `${location.origin}/__unused-video-reference-api/status/{id}`, requestTemplate: '' },
        runningHubVideo: { enabled: true, baseUrl: `${location.origin}/__unused-video-reference-api/`, apiKey: '', activeWorkflowId: `ruq-cloud-${selected}`, workflows: [makeCloud('ruq-cloud-boundary', '四槽首帧工作流', boundary), makeCloud('ruq-cloud-ordinary', '四槽普通工作流', ordinary), makeCloud('ruq-cloud-last', '四槽尾帧工作流', ending), makeCloud('ruq-cloud-narrow', '两槽工作流', boundary.slice(0, 2)), makeCloud('ruq-cloud-six', '六槽工作流', six)] },
        comfyuiVideo: { enabled: true, baseUrl: `${location.origin}/__unused-video-reference-api/comfy`, apiKey: '', activeWorkflowId: `ruq-comfy-${selected}`, workflows: [makeComfy('ruq-comfy-boundary', '本地四槽首帧工作流', boundary), makeComfy('ruq-comfy-ordinary', '本地四槽普通工作流', ordinary), makeComfy('ruq-comfy-last', '本地四槽尾帧工作流', ending), makeComfy('ruq-comfy-narrow', '本地两槽工作流', boundary.slice(0, 2)), makeComfy('ruq-comfy-six', '本地六槽工作流', six)] } };
    };
    const makeState = (options = {}) => {
      const project = makeProject(options); const settings = makeSettings(options);
      if (options.retryMappings) {
        project.generationTasks = [1, 2].map((index) => {
          const board = project.storyboards[index - 1]; const id = `ruq-retry-${index}`;
          const draft = { name: `冻结第${index}段`, prompt: board.officialPromptZh, backend: options.source === 'comfyui' ? 'comfyui' : 'api', references: refs.map((assetId) => ({ assetId, role: project.assets.find((entry) => entry.id === assetId).referenceRole })), parameters: {}, source: { storyboardId: board.id, sequencePlanId: 'ruq-plan', segmentId: board.segmentId, segmentIndex: index, language: 'zh' }, ...(options.source === 'comfyui' ? { workflowId: 'ruq-comfy-boundary' } : { runningHubWorkflowId: 'ruq-cloud-boundary' }) };
          const frozenSettings = structuredClone(settings);
          if (options.source === 'comfyui') frozenSettings.comfyuiVideo.workflows[0].mapping.images[0].role = index === 1 ? 'first-frame' : 'general';
          else frozenSettings.runningHubVideo.workflows[0].mapping.images[0].role = index === 1 ? 'first-frame' : 'general';
          const connection = options.source === 'comfyui'
            ? { backend: 'comfyui', workflow: frozenSettings.comfyuiVideo.workflows[0], comfyui: { enabled: true, baseUrl: frozenSettings.comfyuiVideo.baseUrl } }
            : { backend: 'api', api: resolveConfiguredVideoApi(frozenSettings, draft) };
          const images = draft.references.map((reference) => ({ ...reference, ...Object.fromEntries(['name', 'dataUrl', 'relativePath', 'checksum'].map((key) => [key, project.assets.find((entry) => entry.id === reference.assetId)[key]])), freezeState: 'frozen', frozenAt: now }));
          return { id, kind: 'video', targetId: 'frozen-video', storyboardId: board.id, sequencePlanId: 'ruq-plan', segmentId: board.segmentId, status: 'failed', requestBody: {}, createdAt: now + index, updatedAt: now + index, videoJob: { stage: 'failed', snapshot: { projectId: project.id, clientId: id, draft, connection, images } } };
        });
      }
      qa.submissions = []; qa.aiCalls = 0; qa.extractionCalls = 0; qa.generatedFrameIds = []; qa.allowTailMock = Boolean(options.withVideo); qa.originalProject = JSON.stringify(project); qa.originalSettings = JSON.stringify(settings);
      return { project, settings, launchRequest: options.retryMappings ? { id: `ruq-launch-${project.id}`, batchTaskIds: ['ruq-retry-1', 'ruq-retry-2'] } : options.single ? { id: `ruq-launch-${project.id}`, storyboardId: 'ruq-board-1', language: 'zh' } : undefined };
    };
    const controller = { runtimes: {}, start: async (draft) => { qa.submissions.push({ kind: 'single', draft: structuredClone(draft) }); return 'mock-task'; }, startBatch: async (input) => { qa.submissions.push({ kind: 'batch', input: structuredClone(input) }); return { batchId: 'mock-batch', taskIds: [], skipped: [] }; }, cancel: async () => {}, resume: async () => {}, retryDownload: async () => {} };
    const tailFrameTools = { available: true, busy: false, extract: async (source) => {
      if (!qa.allowTailMock) throw new Error('Unexpected extraction; fixture accepts only the synthetic predecessor exact last frame');
      qa.extractionCalls += 1;
      const frame = { ...asset('ruq-local-frame', '本地真实最后一帧', 'last-frame'), source: 'derived', sourceVideoAssetId: source.assetId, sourceVideoChecksum: source.expectedChecksum, sourceTimeSec: 14.96, sourceFrameIndex: 374 };
      qa.generatedFrameIds.push(frame.id); qa.appendFrame(frame);
      return frame;
    }, selectFrame: async () => { qa.aiCalls += 1; throw new Error('New local-tail selection must not call visual AI'); }, cancel: async () => {} };
    function Harness() {
      const [value, setValue] = React.useState(makeState); qa.project = value.project; qa.settings = value.settings;
      qa.reset = (options) => setValue(makeState(options));
      qa.appendFrame = (frame) => setValue((current) => ({ ...current, project: { ...current.project, assets: [frame, ...current.project.assets] } }));
      return e('main', { style: { height: '100dvh', padding: 12, boxSizing: 'border-box', '--ui-font-scale': fixtureOptions.fontScale ?? 1.5 } }, e(VideoDirectorView, { key: value.project.id, ...value, controller, tailFrameTools }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  }, fixtureOptions);
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).waitFor();
  return { blockedRequests, textRequests };
}

export async function runVideoReferenceUsageUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = []; const layouts = [];
  const ids = ['ruq-composition', 'ruq-a', 'ruq-b', 'ruq-c'];
  const row = (index) => page.locator(`[data-segment-id="ruq-segment-${index}"]`);
  const showList = async () => { const tab = page.getByRole('tab', { name: '分段清单', exact: true }); if (await tab.isVisible()) await tab.click(); };
  const reset = async (options = {}) => { await page.evaluate((value) => window.__videoReferenceUsageQa.reset(value), options); if (!options.single) await page.getByRole('tab', { name: '长剧情批量', exact: true }).click(); };
  const preview = async (index = 1) => { await showList(); await row(index).getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '参考图与用途', exact: true }).click(); return page.locator('.vd-batch-reference-preview > div').allInnerTexts(); };
  const capture = async (name) => { if (!outputDirectory) return; const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file); };
  const count = () => page.evaluate(() => window.__videoReferenceUsageQa.submissions.length);
  const integrity = async (expectedExtractions = 0) => assert.deepEqual(await page.evaluate(() => { const qa = window.__videoReferenceUsageQa; const project = { ...qa.project, assets: qa.project.assets.filter((entry) => !qa.generatedFrameIds.includes(entry.id)) }; return { project: JSON.stringify(project) === qa.originalProject, settings: JSON.stringify(qa.settings) === qa.originalSettings, textApiEnabled: qa.settings.textApi.enabled, aiCalls: qa.aiCalls, extractionCalls: qa.extractionCalls }; }), { project: true, settings: true, textApiEnabled: false, aiCalls: 0, extractionCalls: expectedExtractions });
  const originalPrompt = () => page.evaluate(() => window.__videoReferenceUsageQa.project.storyboards[0].officialPromptZh);
  const submitBatch = async (total = 1) => {
    const before = await count(); await showList(); const button = page.getByRole('button', { name: `检查并生成 ${total} 段视频`, exact: true });
    assert.equal(await button.isDisabled(), false, 'selected ordinary image is valid in a declared first-frame slot'); await button.click();
    const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true }); await dialog.waitFor(); assert.equal(await count(), before);
    const confirm = dialog.getByRole('button', { name: `确认生成 ${total} 段`, exact: true }); assert.equal(await confirm.isDisabled(), true);
    await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await confirm.click();
    await page.waitForFunction((expected) => window.__videoReferenceUsageQa.submissions.length === expected, before + 1);
    const input = await page.evaluate(() => window.__videoReferenceUsageQa.submissions.at(-1).input);
    const originals = await page.evaluate(() => JSON.parse(window.__videoReferenceUsageQa.originalProject).storyboards);
    for (const item of input.items) assert.equal(item.draft.prompt, originals.find((board) => board.id === item.draft.source.storyboardId).officialPromptZh, 'unchanged image numbering must preserve the entire original prompt exactly through selection, preview and submission');
    return input;
  };
  const chooseFirst = async () => { await showList(); await row(1).getByLabel('选择第 1 段', { exact: true }).check(); };
  const picker = async (index = 1) => { await showList(); await row(index).getByRole('button', { name: `第 ${index} 段选择参考图`, exact: true }).click(); const dialog = page.getByRole('dialog', { name: `第 ${index} 段 · 选择参考图`, exact: true }); await dialog.waitFor(); await assertVideoReferencePickerStartsWithImages(dialog); return dialog; };
  const slotUsage = (dialog) => dialog.locator('.vd-slot-usage-editor');
  const pickedCard = (dialog, name) => dialog.getByRole('button', { name: `取消选择图片 ${name}`, exact: true });
  const assertSlotLabel = async (dialog, name, role, slot) => assert.match(await pickedCard(dialog, name).innerText(), new RegExp(`${role}\\s*[（(]\\s*槽\\s*${slot}\\s*[）)]`, 'u'), `${name} must show its actual ${role} slot ${slot}`);
  const assertReferences = (references, assetIds = ids, roles = ['composition', 'character', 'character', 'character']) => { assert.deepEqual(references.map((entry) => entry.assetId), assetIds); assert.deepEqual(references.map((entry) => entry.role), roles); };

  await reset(); await chooseFirst();
  const before = await preview(); assert.equal(before.length, 4); assert.match(before[0], /分镜构图原图[\s\S]*构图参考/u);
  assert.doesNotMatch(await page.locator('.vd-batch-footer').innerText(), /用途不匹配|未识别的错误|所选用途/u);
  await capture('runninghub-original-composition-is-first-frame');
  const initialInput = await submitBatch(); assertReferences(initialInput.items[0].draft.references); assert.equal(initialInput.items[0].draft.prompt, await originalPrompt()); await integrity();
  stages.push('runninghub-original-composition-to-declared-first-frame-without-changing-assets-or-prompt');

  await reset(); let dialog = await picker();
  const imageTab = dialog.getByRole('tab', { name: '图片选择', exact: true });
  const purposeTab = dialog.getByRole('tab', { name: '槽位用途', exact: true });
  await imageTab.focus(); await imageTab.press('End');
  assert.equal(await purposeTab.getAttribute('aria-selected'), 'true');
  assert.equal(await purposeTab.evaluate((element) => element === document.activeElement), true, 'keyboard switch focuses the active purpose column');
  await purposeTab.press('Home'); assert.equal(await imageTab.getAttribute('aria-selected'), 'true');
  await imageTab.press('ArrowLeft'); assert.equal(await purposeTab.getAttribute('aria-selected'), 'true');
  await purposeTab.press('ArrowRight'); assert.equal(await imageTab.getAttribute('aria-selected'), 'true');
  assert.equal(await dialog.getByRole('tabpanel').count(), 1);
  stages.push('reference-picker-columns-support-arrow-home-end-navigation');
  await assertSlotLabel(dialog, '分镜构图原图', '构图1', 1);
  for (const [index, name] of ['甲人物参考', '乙人物参考', '丙人物参考'].entries()) await assertSlotLabel(dialog, name, `人物${index + 1}`, index + 2);
  await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor();
  await showVideoReferencePickerPane(dialog, '图片选择');
  await pickedCard(dialog, '乙人物参考').click(); await assertSlotLabel(dialog, '甲人物参考', '人物1', 2); await assertSlotLabel(dialog, '丙人物参考', '人物3', 4);
  await dialog.getByRole('button', { name: '选择图片 乙人物参考', exact: true }).click(); await assertSlotLabel(dialog, '乙人物参考', '人物2', 3);
  await capture('selected-card-labels-follow-reorder-and-deselect'); await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await integrity();
  stages.push('selected-library-cards-show-numbered-purpose-and-live-actual-slots');

  await reset(); await chooseFirst(); dialog = await picker();
  await dialog.getByRole('button', { name: '取消选择图片 分镜构图原图', exact: true }).click();
  await dialog.getByRole('button', { name: '选择图片 普通场景照片', exact: true }).click();
  await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor();
  assert.match(await dialog.locator('.vd-slot-usage-row').first().innerText(), /普通场景照片/u);
  const firstUsage = dialog.getByLabel('第 1 段图片槽 1 用途', { exact: true });
  await firstUsage.selectOption('first-frame'); assert.equal(await firstUsage.isEnabled(), true, 'segment slot purpose is editable and never locally blocking');
  assert.equal(await dialog.getByLabel('第 1 段图片槽 2 用途', { exact: true }).inputValue(), 'character'); await capture('picker-arbitrary-scene-moved-to-first-slot');
  await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
  const arbitraryPreview = await preview(); assert.match(arbitraryPreview[0], /普通场景照片[\s\S]*首帧/u);
  const arbitrary = await submitBatch(); assertReferences(arbitrary.items[0].draft.references, ['ruq-scene', 'ruq-a', 'ruq-b', 'ruq-c'], ['first-frame', 'character', 'character', 'character']); assert.equal(arbitrary.items[0].draft.prompt, await originalPrompt()); await integrity();
  stages.push('picker-can-replace-first-slot-with-any-ordinary-image-without-moving-other-slots');

  // A workflow's physical capacity remains visible only in the purpose pane.
  // Search, draft roles and vacancies share one state across both panes.
  for (const source of ['runninghub', 'comfyui']) {
    await reset({ source, workflow: 'six' }); await chooseFirst(); dialog = await picker();
    await pickedCard(dialog, '乙人物参考').click(); await pickedCard(dialog, '丙人物参考').click();
    const search = dialog.getByRole('searchbox', { name: '批量参考图搜索', exact: true });
    await search.fill('普通场景');
    let purposePane = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposePane.locator('.vd-slot-usage-row').count(), 6, 'all six physical slots are visible even with only two selected images');
    assert.equal(await purposePane.locator('.vd-slot-empty').count(), 4);
    assert.equal(await purposePane.locator('.vd-image-picker-grid, input[type="search"]').count(), 0, 'purpose column does not duplicate picture library or its search');
    await purposePane.getByLabel('第 1 段图片槽 1 用途', { exact: true }).selectOption('prop');
    await purposePane.getByLabel('第 1 段图片槽 3 用途', { exact: true }).selectOption('last-frame');
    assert.match(await purposePane.innerText(), /仅提示，不阻止生成/u, 'category/old-workflow mismatch is advisory');
    assert.equal(await dialog.getByRole('button', { name: '使用本段图片', exact: true }).isEnabled(), true);
    await showVideoReferencePickerPane(dialog, '图片选择');
    assert.equal(await search.inputValue(), '普通场景', 'switching columns retains the exact search text');
    assert.equal(await dialog.getByRole('tabpanel', { name: '图片选择', exact: true }).locator('.vd-image-choice').count(), 1, 'search result stays filtered after returning');
    await search.fill('');
    await assertSlotLabel(dialog, '分镜构图原图', '道具1', 1);
    await pickedCard(dialog, '分镜构图原图').click();
    await assertSlotLabel(dialog, '甲人物参考', '人物1', 2);
    await dialog.getByRole('button', { name: '选择图片 普通场景照片', exact: true }).click();
    await assertSlotLabel(dialog, '普通场景照片', '道具1', 1);
    purposePane = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposePane.getByLabel('第 1 段图片槽 3 用途', { exact: true }).inputValue(), 'last-frame', 'an empty slot purpose survives selection in the other pane');
    await capture(`${source}-separate-six-slot-purposes-two-images`);
    await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
    const sparse = await submitBatch();
    assertReferences(sparse.items[0].draft.references, ['ruq-scene', 'ruq-a'], ['prop', 'character']);
    assert.equal(sparse.items[0].draft.referenceSlotRoles[2], 'last-frame');
    dialog = await picker();
    await assertSlotLabel(dialog, '普通场景照片', '道具1', 1); await assertSlotLabel(dialog, '甲人物参考', '人物1', 2);
    await pickedCard(dialog, '普通场景照片').click(); await pickedCard(dialog, '甲人物参考').click();
    purposePane = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposePane.locator('.vd-slot-usage-row').count(), 6, 'all slots remain available without manually adding them');
    assert.equal(await purposePane.locator('.vd-slot-empty').count(), 6, 'zero selected images leaves six editable empty slots');
    assert.equal(await purposePane.getByLabel('第 1 段图片槽 1 用途', { exact: true }).inputValue(), 'prop');
    assert.equal(await dialog.getByRole('button', { name: '使用本段图片', exact: true }).isEnabled(), true, 'no fill-all selection gate');
    await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
    dialog = await picker();
    assert.equal(await dialog.locator('.vd-image-pick[aria-pressed="true"]').count(), 0);
    purposePane = await showVideoReferencePickerPane(dialog, '槽位用途');
    assert.equal(await purposePane.locator('.vd-slot-empty').count(), 6, 'zero-image selection and purposes persist across reopen');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await integrity();
    stages.push(`${source}-separate-panes-retain-search-six-empty-slots-custom-purposes-and-nonblocking-mismatches`);
  }

  await reset(); await chooseFirst(); dialog = await picker(); await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('ruq-cloud-ordinary');
  const ordinaryPreview = await preview(); assert.match(ordinaryPreview[0], /构图参考/u); assert.doesNotMatch(ordinaryPreview[0], /首帧/u);
  const ordinary = await submitBatch(); assertReferences(ordinary.items[0].draft.references, ids, ['composition', 'character', 'character', 'character']);
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('ruq-cloud-boundary');
  const boundaryAgain = await submitBatch(); assertReferences(boundaryAgain.items[0].draft.references); await integrity(); stages.push('switching-workflows-keeps-original-usage-and-does-not-guess-first-frame');

  for (const action of ['previous', 'all-selected']) {
    await reset(); await chooseFirst(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
    if (action === 'previous') await row(2).getByRole('button', { name: '第 2 段复制上一段参考图', exact: true }).click();
    else { await preview(); await page.getByRole('button', { name: '本段图片应用到全部已选', exact: true }).click(); }
    await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('ruq-cloud-ordinary');
    const copiedPreview = await preview(2); assert.match(copiedPreview[0], /构图参考/u); assert.doesNotMatch(copiedPreview[0], /首帧/u, `${action} copy must not freeze a derived boundary role onto ordinary references`);
    const copied = await submitBatch(2); for (const item of copied.items) assertReferences(item.draft.references, ids, ['composition', 'character', 'character', 'character']);
    await integrity(); stages.push(`${action}-copy-keeps-original-reference-roles-when-boundary-workflow-changes`);
  }

  await reset(); await chooseFirst(); await row(2).getByLabel('选择第 2 段', { exact: true }).check();
  await row(2).getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await count(), 0);
  const combination = await preview(2); assert.equal(combination.length, 4); assert.match(combination[0], /等待上一段本地真实末帧/u);
  for (const [index, letter] of ['甲', '乙', '丙'].entries()) assert.match(combination[index + 1], new RegExp(`${letter}人物参考[\\s\\S]*人物参考`, 'u'));
  const chain = await submitBatch(2); assertReferences(chain.items[0].draft.references);
  const successor = chain.items[1]; assert.equal(successor.previousTail.placement.mode, 'prepend'); assert.equal(successor.previousTail.placement.index, 0); assert.equal(successor.previousTail.requireAiSelection, undefined); assert.equal(successor.previousTail.selectionMode, undefined);
  assertReferences(successor.draft.references, ['ruq-a', 'ruq-b', 'ruq-c'], ['character', 'character', 'character']);
  assert.equal(successor.previousTail.predecessorItemKey, chain.items[0].itemKey);
  assert.match(successor.draft.prompt, /<Subject 1> is 甲人物 referenced from <Picture 2>/u); await integrity(); stages.push('first-segment-user-image-and-successor-local-frame-dependency-keep-correct-slot-offset');

  for (const mode of ['automatic', 'static']) {
    await reset({ withVideo: mode === 'static' });
    if (mode === 'automatic') await chooseFirst();
    await row(2).getByLabel('选择第 2 段', { exact: true }).check(); await row(2).getByRole('button', { name: '第 2 段本地末帧加参考图', exact: true }).click();
    await row(2).getByRole('button', { name: '第 2 段取消尾帧加参考图', exact: true }).waitFor();
    if (mode === 'static') await page.waitForFunction(() => window.__videoReferenceUsageQa.extractionCalls === 1 && window.__videoReferenceUsageQa.project.assets.some((entry) => entry.id === 'ruq-local-frame'));
    dialog = await picker(2); assert.equal(await dialog.locator('.vd-image-pick[aria-pressed="true"]').count(), 3, 'local last frame is reserved separately from editable identity selections');
    assert.match(await dialog.innerText(), /槽\s*1/u); assert.match(await dialog.innerText(), /本地真实末帧/u);
    for (const [index, name] of ['甲人物参考', '乙人物参考', '丙人物参考'].entries()) await assertSlotLabel(dialog, name, `人物${index + 1}`, index + 2);
    await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor();
    assert.deepEqual(await slotUsage(dialog).locator('.vd-slot-usage-row select').evaluateAll((elements) => elements.map((element) => element.value)), ['character', 'character', 'character'], 'first editable identity never takes reserved boundary usage');
    assert.equal(await slotUsage(dialog).locator('.vd-slot-reserved').count(), 1, 'local continuity slot is preserved in the purpose column');
    await showVideoReferencePickerPane(dialog, '图片选择');
    await pickedCard(dialog, '甲人物参考').click();
    await assertSlotLabel(dialog, '乙人物参考', '人物2', 3); await assertSlotLabel(dialog, '丙人物参考', '人物3', 4);
    await dialog.getByRole('button', { name: '选择图片 甲人物另一张参考', exact: true }).click(); await assertSlotLabel(dialog, '甲人物另一张参考', '人物1', 2);
    await capture(`${mode}-composite-picker-reserves-first-slot`); await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click();
    assert.equal(await row(2).getByRole('button', { name: '第 2 段取消尾帧加参考图', exact: true }).count(), 1, 'using selected identity pictures preserves composite mode');
    assert.equal(await count(), 0, 'confirming pictures does not submit video');
    const selectedPreview = await preview(2); assert.equal(selectedPreview.length, 4); assert.match(selectedPreview[0], mode === 'static' ? /本地真实最后一帧/u : /等待上一段本地真实末帧/u);
    for (const [index, name] of ['甲人物另一张参考', '乙人物参考', '丙人物参考'].entries()) assert.ok(selectedPreview[index + 1].includes(name), 'confirmed character order matches picker slot labels');
    dialog = await picker(2); await pickedCard(dialog, '甲人物另一张参考').click();
    await dialog.getByRole('button', { name: '选择图片 甲人物参考', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(await preview(2), selectedPreview, 'closing an unconfirmed picker preserves the active references and their exact slot labels');
    const changed = await submitBatch(mode === 'static' ? 1 : 2); const item = changed.items.find((entry) => entry.draft.source.segmentIndex === 2);
    assertReferences(item.draft.references, mode === 'static' ? ['ruq-local-frame', 'ruq-a-alt', 'ruq-b', 'ruq-c'] : ['ruq-a-alt', 'ruq-b', 'ruq-c'], mode === 'static' ? ['first-frame', 'character', 'character', 'character'] : ['character', 'character', 'character']);
    if (mode === 'static') assert.equal(item.previousTail, undefined); else { assert.equal(item.previousTail.placement.index, 0); assert.equal(item.previousTail.placement.mode, 'prepend'); assert.equal(item.previousTail.requireAiSelection, undefined); assert.equal(item.previousTail.selectionMode, undefined); }
    assert.match(item.draft.prompt, /<Subject 1> is 甲人物 referenced from <Picture 2>/u); assert.match(item.draft.prompt, /<Subject 2> is 乙人物 referenced from <Picture 3>/u); assert.match(item.draft.prompt, /<Subject 3> is 丙人物 referenced from <Picture 4>/u);
    await integrity(mode === 'static' ? 1 : 0); stages.push(`${mode}-composite-picker-preserves-tail-and-rebinds-new-identity-slots-without-new-ai-call`);
  }

  for (const source of ['runninghub', 'comfyui']) {
    await reset({ single: true, source }); const section = page.locator('.vd-reference-card');
    await section.locator('.vd-reference-row').first().waitFor();
    assert.equal(await section.getByLabel('图片 1 用途', { exact: true }).count(), 0, '用途仅在选择参考图里修改');
    assert.match(await section.locator('.vd-reference-row').first().innerText(), /分镜构图原图/u);
    const expectedPrompt = await originalPrompt(); await page.getByRole('button', { name: '生成视频', exact: true }).click(); await page.waitForFunction(() => window.__videoReferenceUsageQa.submissions.length === 1);
    const submission = await page.evaluate(() => window.__videoReferenceUsageQa.submissions[0]); assert.equal(submission.kind, 'single'); assertReferences(submission.draft.references); assert.equal(submission.draft.prompt, expectedPrompt);
    await section.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
    const singlePicker = page.getByRole('dialog', { name: '从图片资产库选择生成参考图', exact: true });
    await assertVideoReferencePickerStartsWithImages(singlePicker); await showVideoReferencePickerPane(singlePicker, '槽位用途');
    const firstSlot = singlePicker.getByLabel('本段图片槽 1 用途', { exact: true });
    assert.equal(await firstSlot.inputValue(), 'composition');
    await firstSlot.selectOption('first-frame');
    await showVideoReferencePickerPane(singlePicker, '图片选择');
    await singlePicker.getByRole('button', { name: '取消选择图片 分镜构图原图', exact: true }).click(); await singlePicker.getByRole('button', { name: '选择图片 普通风格照片', exact: true }).click();
    await singlePicker.getByRole('button', { name: '使用所选图片', exact: true }).click();
    assert.match(await section.locator('.vd-reference-row').first().innerText(), /普通风格照片[\s\S]*首帧/u);
    assert.match(await section.locator('.vd-reference-row').nth(1).innerText(), /人物1/u);
    await page.getByRole('button', { name: '生成视频', exact: true }).click(); await page.waitForFunction(() => window.__videoReferenceUsageQa.submissions.length === 2);
    const replaced = await page.evaluate(() => window.__videoReferenceUsageQa.submissions[1]); assertReferences(replaced.draft.references, ['ruq-style', 'ruq-a', 'ruq-b', 'ruq-c'], ['first-frame', 'character', 'character', 'character']); assert.equal(replaced.draft.prompt, expectedPrompt);
    await integrity(); stages.push(`${source}-single-preview-and-recorded-submission-agree-after-arbitrary-image-replacement`);
  }

  await reset({ source: 'comfyui' }); await chooseFirst(); const local = await submitBatch(); assertReferences(local.items[0].draft.references); await integrity(); stages.push('comfyui-batch-uses-same-declared-slot-adaptation');

  for (const source of ['runninghub', 'comfyui']) {
    await reset({ source, retryMappings: true });
    const firstFrozen = await preview(1); const secondFrozen = await preview(2); assert.match(firstFrozen[0], /首帧/u); assert.doesNotMatch(secondFrozen[0], /首帧/u); assert.match(secondFrozen[0], /构图参考/u);
    dialog = await picker(2); await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor();
    const frozenUsage = dialog.getByLabel('第 2 段图片槽 1 用途', { exact: true }); assert.equal(await frozenUsage.inputValue(), 'composition'); assert.equal(await frozenUsage.isEnabled(), true);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); const frozen = await submitBatch(2);
    assertReferences(frozen.items[0].draft.references, ids, ['first-frame', 'character', 'character', 'character']); assertReferences(frozen.items[1].draft.references, ids, ['composition', 'character', 'character', 'character']);
    assert.equal(frozen.items[0].draft.reuseTaskId, 'ruq-retry-1'); assert.equal(frozen.items[1].draft.reuseTaskId, 'ruq-retry-2');
    await integrity(); stages.push(`${source}-retry-items-with-same-workflow-id-honor-individual-frozen-mappings`);
  }

  await reset({ source: 'api', single: true });
  assert.match(await page.locator('.vd-reference-card .vd-reference-row').first().innerText(), /构图1/u);
  assert.equal(await page.locator('.vd-reference-card').getByLabel('图片 1 用途', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '生成视频', exact: true }).click(); await page.waitForFunction(() => window.__videoReferenceUsageQa.submissions.length === 1);
  const generic = await page.evaluate(() => window.__videoReferenceUsageQa.submissions[0]); assertReferences(generic.draft.references, ids, ['composition', 'character', 'character', 'character']); await integrity(); stages.push('generic-api-with-no-declared-boundary-does-not-guess-first-frame');

  await reset({ workflow: 'last' }); await chooseFirst();
  const endPreview = await preview(); assert.match(endPreview[3], /丙人物参考[\s\S]*人物参考/u); assert.doesNotMatch(endPreview[3], /尾帧/u);
  dialog = await picker(); await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor(); const lastSlot = dialog.getByLabel('第 1 段图片槽 4 用途', { exact: true }); assert.equal(await lastSlot.inputValue(), 'character'); assert.equal(await lastSlot.isEnabled(), true); await lastSlot.selectOption('last-frame');
  await dialog.getByRole('button', { name: '使用本段图片', exact: true }).click(); const last = await submitBatch(); assertReferences(last.items[0].draft.references, ids, ['composition', 'character', 'character', 'last-frame']); assert.equal(last.items[0].draft.prompt, await originalPrompt()); await integrity(); stages.push('ordinary-image-can-also-serve-an-explicit-last-frame-slot');

  for (const source of ['runninghub', 'comfyui']) {
    await reset({ source, workflow: 'narrow' }); await chooseFirst();
    assert.equal((await preview()).length, 4, 'slot shortage must retain every selected reference'); await showList();
    assert.equal(await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).isDisabled(), true);
    assert.match(await page.locator('.vd-batch-panel').innerText(), /(?:4 张|4 个)[\s\S]*(?:2 个|2 张)/u);
    assert.equal(await count(), 0); await integrity(); stages.push(`${source}-slot-shortage-does-not-drop-or-submit-images`);
  }

  for (const viewport of [{ width: 1120, height: 760 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport); await reset(); await chooseFirst(); await preview(); await capture(`reference-usage-preview-${viewport.width}x${viewport.height}`);
    dialog = await picker(); await capture(`reference-usage-picture-pane-${viewport.width}x${viewport.height}`); await showVideoReferencePickerPane(dialog, '槽位用途'); await slotUsage(dialog).waitFor();
    const usage = dialog.getByLabel('第 1 段图片槽 1 用途', { exact: true }); await usage.scrollIntoViewIfNeeded();
    const layout = await usage.evaluate((element) => { const box = element.getBoundingClientRect(); const dialog = element.closest('[role="dialog"]'); return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, usageLeft: box.left, usageRight: box.right, usageWidth: box.width, dialogWidth: dialog.getBoundingClientRect().width, dialogScrollWidth: dialog.scrollWidth }; });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1, 'no horizontal page overflow'); assert.ok(layout.usageWidth > 0 && layout.usageLeft >= 0 && layout.usageRight <= layout.viewportWidth); assert.ok(layout.dialogScrollWidth <= layout.dialogWidth + 2, 'picker content stays within dialog');
    const apply = dialog.getByRole('button', { name: '使用本段图片', exact: true }); await apply.scrollIntoViewIfNeeded(); assert.equal(await apply.isEnabled(), true);
    layouts.push({ viewport, ...layout }); await capture(`reference-usage-picker-${viewport.width}x${viewport.height}`); await apply.click(); await integrity();
  }
  stages.push('responsive-preview-and-separate-picture-purpose-columns');
  return { passed: true, inventory: videoReferenceUsageQaInventory, stages, screenshots, layouts };
}

export async function runStandaloneVideoReferenceUsageUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputDirectory = path.join(root, 'output', 'playwright', 'video-reference-usage');
  await fs.mkdir(outputDirectory, { recursive: true }); const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); let browser;
  try {
    await server.listen(); const address = server.httpServer.address(); browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1120, height: 760 } }); page.setDefaultTimeout(20_000); const errors = [];
    page.on('pageerror', (cause) => errors.push(cause.message)); const { blockedRequests, textRequests } = await installVideoReferenceUsageFixture(page, `http://127.0.0.1:${address.port}`);
    const report = await runVideoReferenceUsageUiAssertions(page, outputDirectory); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no external or paid API request was even attempted'); assert.deepEqual(textRequests, [], 'reference controls do not call the text API');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, errors, blockedRequests, textRequests }, null, 2)); return report;
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause) }, null, 2));
    if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); } }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoReferenceUsageUiQa(), null, 2)); } catch (cause) { console.error(cause); process.exitCode = 1; }
}
