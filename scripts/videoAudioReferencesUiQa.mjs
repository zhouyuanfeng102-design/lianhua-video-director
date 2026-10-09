import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// Production editor components with synthetic WAVs and isolated browser state.
// Controllers only record drafts. Network mocks must explicitly name permitted
// read-only discovery requests; every other mutation or remote request aborts.
export const videoAudioQaInventory = [
  '真实音频文件输入可发现/映射，不以字段名承诺音色克隆或模式字段支持',
  '独立音频槽保持空位和编号，后续素材不前移，不影响图片槽',
  '人物、旁白、氛围用途及人物ID在单段和批量提交中保留',
  '项目声音预设支持逐段继承、覆盖和明确不用，无对白段不自行发声',
  '音频选择、项目预设及覆盖经真实规范化与隔离保存重载恢复',
  '日间与夜间新音频控件可见，无横向溢出或运行时错误',
  '合成音频和mock transport，无真实上传或收费生成POST',
];

export function syntheticAudioFixture(id, name, frequency = 220) {
  const sampleRate = 8000; const durationSec = 2; const sampleCount = sampleRate * durationSec;
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 600), 44 + index * 2);
  return { id, name, type: 'audio', role: 'audio', referenceRole: 'audio', mediaType: 'audio', mimeType: 'audio/wav',
    fileName: `${id}.wav`, dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`, checksum: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length, durationSec, sampleRate, channelCount: 1, waveform: Array(20).fill(0.02), tags: ['隔离合成音频'], createdAt: 1, updatedAt: 1 };
}

export function assertAudioSelection(draft, expected, label) {
  const references = draft.audioReferences || [];
  assert.equal(new Set(references.map((reference) => reference.slotIndex)).size, references.length, `${label}: each physical audio slot has one binding`);
  assert.ok(references.every((reference) => Number.isSafeInteger(reference.slotIndex) && reference.slotIndex >= 0 && reference.slotIndex < 3), `${label}: valid independent audio slots`);
  const actual = references.map(({ assetId, slotIndex, target, retainMode }) => ({ assetId, slotIndex, target, retainMode })).sort((left, right) => left.slotIndex - right.slotIndex);
  assert.deepEqual(actual, expected, `${label}: captured submission matches reviewed audio, character/purpose, mode and physical slot`);
}

export async function installVideoAudioFixture(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const blockedRequests = []; const discoveryRequests = [];
  const discoveryNodes = [
    { nodeId: '100', fieldName: 'text', fieldValue: '', description: '提示词' },
    ...[1, 2, 3].flatMap((index) => [
      { nodeId: String(200 + index), fieldName: 'audio', fieldValue: ['None', '', 'original-third.wav'][index - 1], description: `参考音频 ${index}`, fieldType: 'AUDIO', classType: 'LoadAudio', audioUpload: true },
      { nodeId: String(200 + index), fieldName: 'retain_mode', fieldValue: 'reference', description: `音频 ${index} 保留方式`, fieldData: JSON.stringify(['COMBO', { options: ['reference', 'fully_copy', 'partially_copy', 'weak_reference'] }]) },
    ]),
    { nodeId: '999', fieldName: 'audio', fieldValue: 'true', description: '生成音频开关（不是上传槽）' },
  ];
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/__qa_audio_discovery/api/openapi/getJsonApiFormat' && request.method() === 'POST') {
      discoveryRequests.push({ url: url.pathname, body: request.postDataJSON() });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { prompt: JSON.stringify({ nodeInfoList: discoveryNodes }) } }) }); return;
    }
    if ((/^https?:$/u.test(url.protocol) && url.origin !== origin) || !['GET', 'HEAD'].includes(request.method())) {
      blockedRequests.push({ method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__video_audio_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${origin}/__video_audio_fixture.html`, { waitUntil: 'networkidle' });
  const audioAssets = [syntheticAudioFixture('aq-a', '甲人物音色'), syntheticAudioFixture('aq-b', '乙人物音色', 330),
    syntheticAudioFixture('aq-ambience', '氛围音频', 80), syntheticAudioFixture('aq-a-alt', '甲人物替代音色', 440)];
  await page.evaluate(async ({ audioAssets, discoveryNodes }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const { createInitialState, normalizeState, saveStateAsync, loadState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    await import('/src/styles.css'); await import('/src/appThemes.css');
    const e = React.createElement; const initial = createInitialState(); const time = 1;
    const characters = ['a', 'b'].map((key, index) => ({ id: `aq-person-${key}`, name: `${index ? '乙' : '甲'}人物`, gender: '未知', apparentAge: '30',
      race: '人类', appearance: '普通人物', outfit: '普通外套', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] }));
    const speakersBySegment = [['a', 'b'], ['b'], []];
    const segments = [1, 2, 3].map((index) => ({ id: `aq-segment-${index}`, index, title: ['两人对话', '乙人物独白', '无对白行走'][index - 1],
      globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10, content: ['甲人物说：“出发。”乙人物说：“好。”', '乙人物说：“到了。”', '两人无对白沿桥行走。'][index - 1],
      summary: '', sourceSceneIds: ['aq-scene'], sourceBeatIds: [], narrativePurpose: '中性对话', entryState: '', exitState: '', transitionHint: '', storyboardId: `aq-board-${index}`, status: 'ready' }));
    const plan = { id: 'aq-plan', chapterId: 'aq-chapter', title: '隔离声音计划', sourceStoryTitle: '隔离声音计划', sourceStoryContent: segments.map((segment) => segment.content).join('\n'),
      durationMode: 'fixed', totalDurationSec: 30, segmentDurationSec: 10, segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: time, updatedAt: time };
    const boards = segments.map((segment, index) => ({ id: segment.storyboardId, chapterId: 'aq-chapter', sceneId: 'aq-scene', sourceStoryTitle: segment.title,
      sourceStoryContent: segment.content, workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1,
      pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: initial.settings.defaultStylePresetId,
      ruleSetId: initial.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', finalPrompt: segment.content,
      englishPrompt: segment.content, englishPromptSource: segment.content, promptMigrationPending: false,
      promptTrace: { modelRuleSetId: initial.settings.defaultRuleSetId, converterPresetId: 'generic-video', stylePresetId: initial.settings.defaultStylePresetId,
        sourceDocumentIds: ['aq-chapter'], referenceAssetIds: [], generatedAt: time, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(segment.content) },
      audioLedger: speakersBySegment[index].map((key, cueIndex) => ({ id: `aq-cue-${index}-${key}`, kind: 'dialogue', label: '对白', speakerId: `aq-person-${key}`,
        speaker: characters.find((character) => character.id === `aq-person-${key}`).name, text: cueIndex ? '好。' : index ? '到了。' : '出发。', startSec: cueIndex * 4, endSec: cueIndex * 4 + 2 })),
      shots: [{ id: `aq-shot-${segment.index}`, index: 1, startSec: 0, endSec: 10, purpose: '', subject: '甲人物、乙人物', action: segment.content,
        camera: '全景', transition: '', lighting: '日光', sound: index === 2 ? '无对白。' : '原人物对白', dialogue: segment.content,
        result: '', referenceAssetIds: [], prompt: segment.content, locked: false }], sequencePlanId: plan.id, segmentId: segment.id,
      segmentIndex: segment.index, segmentCount: 3, createdAt: time, updatedAt: time }));
    const workflow = { id: 'aq-workflow', name: '隔离三音频槽工作流', runKind: 'workflow', remoteId: '1234567890123456789',
      requestTemplate: JSON.stringify({ nodeInfoList: [discoveryNodes[0], discoveryNodes.at(-1)], usePersonalQueue: false }), nodeCatalog: [],
      mapping: { prompt: [{ nodeId: '100', inputName: 'text' }], images: [] }, createdAt: time, updatedAt: time };
    const project = { ...initial.project, id: 'aq-project', name: '隔离参考音频验证', activeChapterId: 'aq-chapter',
      sourceDocuments: [{ id: 'aq-chapter', name: '隔离章节', content: plan.sourceStoryContent, createdAt: time, updatedAt: time }], chapterWorkspaces: {},
      characters, locations: [], props: [], scenes: [{ id: 'aq-scene', chapterId: 'aq-chapter', title: '石桥', content: plan.sourceStoryContent, summary: '',
        characterIds: characters.map((character) => character.id), propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: time, updatedAt: time }],
      storyboards: boards, sequencePlans: [plan], generationTasks: [], assets: audioAssets };
    const settings = { ...initial.settings, videoSource: 'runninghub', videoBackend: 'api', videoApiProfiles: [], activeVideoApiProfileId: null,
      textApi: { ...initial.settings.textApi, enabled: false, apiKey: '' },
      runningHubVideo: { enabled: true, baseUrl: `${location.origin}/__qa_audio_discovery`, apiKey: 'synthetic-key-not-real', activeWorkflowId: workflow.id, workflows: [workflow] } };
    const storageKey = '__isolated_video_audio_qa';
    const qa = window.__videoAudioQa = { submissions: [], importedFiles: [], initialProject: JSON.stringify(project), initialPrompts: boards.map((board) => board.finalPrompt), storageKey };
    const controller = { runtimes: {}, start: async (draft) => { qa.submissions.push({ kind: 'single', draft: structuredClone(draft) }); return 'qa-record-only-task'; },
      startBatch: async (input) => { qa.submissions.push({ kind: 'batch', input: structuredClone(input) }); return { batchId: 'qa-record-only-batch', taskIds: [], skipped: [] }; },
      cancel: async () => {}, resume: async () => {}, retryDownload: async () => {} };
    function Harness() {
      const [value, setValue] = React.useState({ project, settings, chapterDraft: undefined, screen: 'director', epoch: 0 });
      qa.project = value.project; qa.settings = value.settings; qa.chapterDraft = value.chapterDraft;
      qa.update = (patch) => setValue((current) => ({ ...current, ...patch }));
      qa.remount = () => setValue((current) => ({ ...current, chapterDraft: qa.latestDraft || current.chapterDraft, epoch: current.epoch + 1 }));
      qa.persist = async () => {
        const savedProject = { ...value.project, chapterWorkspaces: { ...value.project.chapterWorkspaces, 'aq-chapter': {
          ...value.project.chapterWorkspaces?.['aq-chapter'], videoDirector: qa.latestDraft || value.chapterDraft } } };
        const state = { ...initial, project: savedProject, projects: [savedProject], activeProjectId: savedProject.id, settings: value.settings };
        const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
        const saveResult = await saveStateAsync(normalized); if (!saveResult.ok) throw new Error('isolated save failed');
        const restored = loadState();
        localStorage.setItem(storageKey, JSON.stringify({ project: restored.project, settings: restored.settings, chapterDraft: restored.project.chapterWorkspaces?.['aq-chapter']?.videoDirector }));
        return JSON.parse(localStorage.getItem(storageKey));
      };
      qa.restore = () => {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        setValue((current) => ({ ...current, ...saved, epoch: current.epoch + 1 }));
      };
      const onVoicePresetsChange = (presets) => setValue((current) => ({ ...current, project: { ...current.project, voicePresets: presets } }));
      return e('main', { style: { height: '100dvh', boxSizing: 'border-box', padding: 12 } },
        value.screen === 'manager' ? e(RunningHubWorkflowManager, { key: `manager-${value.epoch}`, config: value.settings.runningHubVideo,
          getCurrentConfig: () => qa.settings.runningHubVideo,
          onChange: (next) => setValue((current) => ({ ...current, settings: { ...current.settings, runningHubVideo: next } })),
          onClose: () => setValue((current) => ({ ...current, screen: 'director' })) })
          : e(VideoDirectorView, { key: `director-${value.epoch}`, project: value.project, chapterId: 'aq-chapter', settings: value.settings, chapterDraft: value.chapterDraft,
            controller, onVoicePresetsChange, onImportAudioFiles: async (files) => { qa.importedFiles.push(...files.map((file) => ({ name: file.name, size: file.size, type: file.type }))); },
            onChapterDraftChange: (_projectId, _chapterId, draft) => { qa.latestDraft = structuredClone(draft); },
            launchRequest: value.chapterDraft ? undefined : { id: `aq-launch-${value.epoch}`, storyboardId: 'aq-board-1', chapterId: 'aq-chapter', language: 'zh', promptFormat: 'ordinary' } }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  }, { audioAssets, discoveryNodes });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).waitFor();
  return { blockedRequests, discoveryRequests };
}

export async function runVideoAudioReferencesUiAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  await page.evaluate(() => window.__videoAudioQa.update({ screen: 'manager' }));
  const manager = page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true });
  await manager.waitFor(); await manager.getByRole('tab', { name: '输入映射', exact: true }).click();
  await manager.getByRole('tab', { name: /^参考音频槽/u }).click();
  assert.equal(await manager.locator('.rhv-audio-slot-card').count(), 0, 'a bare .audio toggle is not an uploaded audio capability');
  await manager.getByRole('button', { name: '读取云端节点', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.rhv-audio-slot-card').length === 3);
  for (let slot = 1; slot <= 3; slot += 1) {
    assert.equal(await manager.getByLabel(`云端音频槽 ${slot} 节点字段`, { exact: true }).innerText(), `${200 + slot}.audio`);
  }
  assert.equal((await page.evaluate(() => window.__videoAudioQa.settings.runningHubVideo.workflows[0].mapping.audios || [])).length, 0,
    'discovery only edits the manager draft before Save');
  await manager.getByLabel('云端音频槽 2 名称', { exact: true }).fill('乙人物或环境参考');
  await manager.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction(() => window.__videoAudioQa.settings.runningHubVideo.workflows[0].mapping.audios?.length === 3);
  const mapping = await page.evaluate(() => window.__videoAudioQa.settings.runningHubVideo.workflows[0].mapping.audios);
  assert.deepEqual(mapping.map(({ nodeId, inputName }) => ({ nodeId, inputName })),
    [1, 2, 3].map((slot) => ({ nodeId: String(200 + slot), inputName: 'audio' })), 'cloud upload slots retain their actual field identities');
  assert.equal(mapping[1].label, '乙人物或环境参考');
  await page.evaluate(() => window.__videoAudioQa.update({ screen: 'director' }));
  stages.push('mock discovery distinguishes audio upload inputs from a named toggle; mapping is explicit and saved');
  const openDetails = async (locator) => {
    await locator.waitFor(); if (!(await locator.evaluate((element) => element.open))) await locator.locator(':scope > summary').click();
  };
  const editor = (scope) => page.locator(`details[aria-label="${scope}参考音频"]`);
  const select = (label) => page.getByLabel(label, { exact: true });
  const expectedRef = (assetId, slotIndex, target, retainMode) => ({ assetId, slotIndex, target, retainMode });
  const personA = { kind: 'character', characterId: 'aq-person-a' };
  const personB = { kind: 'character', characterId: 'aq-person-b' };
  const submitSingle = async () => {
    const previous = await page.evaluate(() => window.__videoAudioQa.submissions.length);
    await page.getByRole('button', { name: '生成视频', exact: true }).click();
    await page.waitForFunction((count) => window.__videoAudioQa.submissions.length === count + 1, previous);
    return await page.evaluate(() => window.__videoAudioQa.submissions.at(-1).draft);
  };
  await editor('本段').waitFor();
  assert.equal(await editor('本段').evaluate((element) => element.open), false, 'audio details default to collapsed');
  await openDetails(editor('本段'));
  assert.equal(await editor('本段').getByRole('group', { name: /^本段音频槽 /u }).count(), 3, 'fixture exposes its three actual mapped slots');
  await select('本段音频选择方式').selectOption('override');
  for (const [slot, assetId, purpose, mode] of [[1, 'aq-a', 'char:aq-person-a', 'reference'], [2, 'aq-b', 'char:aq-person-b', 'fully_copy'], [3, 'aq-ambience', 'ambience', 'weak_reference']]) {
    await select(`本段音频槽 ${slot}音频资产`).selectOption(assetId);
    await select(`本段音频槽 ${slot}声音用途`).selectOption(purpose);
    await select(`本段音频槽 ${slot}保留方式`).selectOption(mode);
    assert.ok(await editor('本段').locator(`audio[aria-label="本段音频槽 ${slot}试听"]`).getAttribute('src'), 'each selected synthetic source can be auditioned');
  }
  await select('本段音频槽 3使用说明').fill('仅在本段已经有氛围时参考');
  await page.getByLabel('导入参考音频文件', { exact: true }).setInputFiles({ name: 'isolated-import.wav', mimeType: 'audio/wav', buffer: Buffer.from(syntheticAudioFixture('qa-import', '合成导入').dataUrl.split(',')[1], 'base64') });
  await page.waitForFunction(() => window.__videoAudioQa.importedFiles.length === 1);
  let captured = await submitSingle();
  assertAudioSelection(captured, [expectedRef('aq-a', 0, personA, 'reference'), expectedRef('aq-b', 1, personB, 'fully_copy'), expectedRef('aq-ambience', 2, { kind: 'ambience' }, 'weak_reference')], 'single-person mapping and ambience');
  assert.deepEqual(captured.references, [], 'audio never appears in image references');
  assert.match(captured.prompt, /<Audio 1>/u); assert.match(captured.prompt, /<Audio 2>/u); assert.match(captured.prompt, /<Audio 3>/u);
  assert.equal(captured.audioReferences[2].notes, '仅在本段已经有氛围时参考');
  await page.getByRole('button', { name: '移除本段音频槽 2', exact: true }).click();
  assert.equal(await select('本段音频槽 2音频资产').inputValue(), '');
  assert.equal(await select('本段音频槽 3音频资产').inputValue(), 'aq-ambience', 'removing the middle slot never shifts slot 3');
  captured = await submitSingle();
  assertAudioSelection(captured, [expectedRef('aq-a', 0, personA, 'reference'), expectedRef('aq-ambience', 2, { kind: 'ambience' }, 'weak_reference')], 'middle audio gap');
  assert.doesNotMatch(captured.prompt, /<Audio 2>/u); assert.match(captured.prompt, /<Audio 3>/u);
  await select('本段音频槽 2音频资产').selectOption('aq-b');
  await select('本段音频槽 2声音用途').selectOption('voiceover');
  await select('本段音频槽 2保留方式').selectOption('partially_copy');
  await select('本次稿件语言').selectOption('en');
  assert.equal(await select('本段音频槽 3音频资产').inputValue(), 'aq-ambience', 'language change keeps independent audio choice');
  await select('本次稿件语言').selectOption('zh');
  captured = await submitSingle();
  assertAudioSelection(captured, [expectedRef('aq-a', 0, personA, 'reference'), expectedRef('aq-b', 1, { kind: 'voiceover' }, 'partially_copy'), expectedRef('aq-ambience', 2, { kind: 'ambience' }, 'weak_reference')], 'all retain modes and voiceover purpose');
  stages.push('single submission preserves characters, voiceover/ambience, all four prompt modes, notes, audition and physical gaps');

  const presets = page.locator('details.project-voice-preset-editor');
  assert.equal(await presets.evaluate((element) => element.open), false);
  await openDetails(presets);
  await select('甲人物声音预设音频').selectOption('aq-a');
  await select('乙人物声音预设音频').selectOption('aq-b');
  await select('乙人物声音预设保留方式').selectOption('fully_copy');
  await select('旁白声音预设音频').selectOption('aq-ambience');
  await select('旁白声音预设保留方式').selectOption('weak_reference');
  await select('本段音频选择方式').selectOption('project');
  captured = await submitSingle();
  assertAudioSelection(captured, [expectedRef('aq-a', 0, personA, 'reference'), expectedRef('aq-b', 1, personB, 'fully_copy')], 'speaking-only project voices');
  await select('甲人物声音预设音频').selectOption('aq-a-alt');
  captured = await submitSingle();
  assertAudioSelection(captured, [expectedRef('aq-a-alt', 0, personA, 'reference'), expectedRef('aq-b', 1, personB, 'fully_copy')], 'project voice updates are reflected');
  await select('本段音频选择方式').selectOption('none');
  captured = await submitSingle(); assertAudioSelection(captured, [], 'explicit no audio');
  assert.doesNotMatch(captured.prompt, /<Audio \d+>/u, 'clearing audio removes old task-only reference instructions');
  stages.push('project defaults update inherited drafts and explicit none clears stale prompt bindings without adding narration');

  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.vd-batch-row').length === 3);
  for (const index of [1, 2, 3]) {
    const settings = page.locator(`.vd-batch-row[data-segment-id="aq-segment-${index}"] > details.vd-batch-row-settings`);
    assert.equal(await settings.evaluate((element) => element.open), false, `segment ${index} settings default to collapsed`);
    await openDetails(settings); await openDetails(editor(`第 ${index} 段`));
  }
  assert.equal(await select('第 1 段音频槽 1音频资产').inputValue(), 'aq-a-alt');
  assert.equal(await select('第 1 段音频槽 2音频资产').inputValue(), 'aq-b');
  assert.equal(await select('第 2 段音频槽 1音频资产').inputValue(), 'aq-b', 'only the speaking character inherits a voice');
  assert.equal(await select('第 3 段音频槽 1音频资产').inputValue(), '', 'visible non-speaking characters never inherit voices');
  await select('第 1 段音频选择方式').selectOption('override');
  await select('第 1 段音频槽 1音频资产').selectOption('aq-a');
  await select('第 1 段音频槽 1保留方式').selectOption('partially_copy');
  await select('第 2 段音频选择方式').selectOption('none');
  await page.getByRole('group', { name: '第 1 段稿件语言', exact: true }).getByRole('button', { name: '英文', exact: true }).click();
  assert.equal(await select('第 1 段音频槽 1音频资产').inputValue(), 'aq-a', 'batch override is per segment across language switches');
  await select('乙人物声音预设音频').selectOption('aq-ambience');
  assert.equal(await select('第 1 段音频槽 2音频资产').inputValue(), 'aq-b', 'explicit segment override stays unchanged by project preset edits');
  assert.equal(await select('第 2 段音频槽 1音频资产').inputValue(), '', 'none stays none');
  await select('第 2 段音频选择方式').selectOption('project');
  assert.equal(await select('第 2 段音频槽 1音频资产').inputValue(), 'aq-ambience', 'inherited segment immediately uses edited default');
  await select('第 2 段音频选择方式').selectOption('none');
  await page.waitForFunction(() => window.__videoAudioQa.latestDraft?.batch?.audioOverrides?.['aq-segment-2']?.mode === 'none');
  const saved = await page.evaluate(() => window.__videoAudioQa.persist());
  await fs.writeFile(path.join(outputDirectory, 'saved-fixture-metadata.json'), JSON.stringify({
    boards: saved.project.storyboards.map(({ id, finalPrompt, englishPrompt, englishPromptSource, sourceStale, chapterId }) => ({ id, finalPrompt, englishPrompt, englishPromptSource, sourceStale, chapterId })),
    plans: saved.project.sequencePlans.map(({ id, sourceStale }) => ({ id, sourceStale })), chapterDraft: saved.chapterDraft,
  }, null, 2));
  assert.deepEqual(saved.project.storyboards.map((board) => board.finalPrompt), await page.evaluate(() => window.__videoAudioQa.initialPrompts), 'normalized authored bodies remain unchanged');
  assert.ok(saved.project.storyboards.every((board) => board.englishPrompt === board.finalPrompt && board.englishPromptSource === board.finalPrompt && !board.sourceStale), 'isolated saved ordinary choices retain valid source pairing');
  assert.equal(saved.project.voicePresets.characters['aq-person-a'].assetId, 'aq-a-alt');
  assert.equal(saved.chapterDraft.batch.audioOverrides['aq-segment-1'].mode, 'override');
  assert.equal(saved.chapterDraft.batch.audioOverrides['aq-segment-2'].mode, 'none');
  await page.evaluate(() => window.__videoAudioQa.restore());
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.vd-batch-row').length === 3);
  await openDetails(presets);
  for (const index of [1, 2, 3]) {
    await openDetails(page.locator(`.vd-batch-row[data-segment-id="aq-segment-${index}"] > details.vd-batch-row-settings`));
    await openDetails(editor(`第 ${index} 段`));
  }
  assert.equal(await select('第 1 段音频槽 1音频资产').inputValue(), 'aq-a');
  assert.equal(await select('第 1 段音频槽 1保留方式').inputValue(), 'partially_copy');
  assert.equal(await select('第 2 段音频选择方式').inputValue(), 'none');
  assert.equal(await select('甲人物声音预设音频').inputValue(), 'aq-a-alt');
  const clear = page.getByRole('button', { name: '清空选择', exact: true }); if (await clear.isEnabled()) await clear.click();
  for (const index of [1, 2, 3]) await page.getByRole('checkbox', { name: `选择第 ${index} 段`, exact: true }).check();
  await page.getByRole('button', { name: '检查并生成 3 段视频', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await confirmation.waitFor(); await confirmation.getByRole('checkbox', { name: '确认批量生成费用', exact: true }).check();
  const count = await page.evaluate(() => window.__videoAudioQa.submissions.length);
  await confirmation.getByRole('button', { name: '确认生成 3 段', exact: true }).click();
  await page.waitForFunction((previous) => window.__videoAudioQa.submissions.length === previous + 1, count);
  const input = await page.evaluate(() => window.__videoAudioQa.submissions.at(-1).input);
  assert.equal(input.items.length, 3);
  assertAudioSelection(input.items[0].draft, [expectedRef('aq-a', 0, personA, 'partially_copy'), expectedRef('aq-b', 1, personB, 'fully_copy')], 'batch explicit override');
  assertAudioSelection(input.items[1].draft, [], 'batch none'); assertAudioSelection(input.items[2].draft, [], 'batch no dialogue');
  assert.ok(input.items.every((item) => item.draft.references.length === 0), 'batch audio does not affect image slots');
  assert.deepEqual(await page.evaluate(() => window.__videoAudioQa.project.storyboards.map((board) => board.finalPrompt)),
    await page.evaluate(() => window.__videoAudioQa.initialPrompts), 'all authored prompt bodies stay unchanged');
  stages.push('batch inherits actual speakers only; per-segment override/none and project presets survive real normalization and save/reload');

  for (const [mode, theme] of [['light', 'classic'], ['dark', 'blue']]) {
    await page.evaluate(({ mode, theme }) => { document.documentElement.dataset.colorMode = mode; document.documentElement.dataset.colorTheme = theme; }, { mode, theme });
    await editor('第 1 段').scrollIntoViewIfNeeded();
    const layout = await editor('第 1 段').evaluate((element) => {
      const input = element.querySelector('select'); const style = getComputedStyle(input);
      return { background: style.backgroundColor, color: style.color, overflow: document.documentElement.scrollWidth - innerWidth,
        editorOverflow: element.scrollWidth - element.clientWidth, disabled: input.disabled };
    });
    assert.notEqual(layout.color, layout.background, `${mode}: controls have separate text and surface colors`);
    assert.ok(layout.overflow <= 2 && layout.editorOverflow <= 2, `${mode}: no horizontal overflow in new controls`);
    assert.equal(layout.disabled, false);
    if (mode === 'dark') assert.ok(Number(layout.background.match(/\d+/gu)[0]) < 90, 'night audio inputs use dark surfaces');
    const screenshotPath = path.join(outputDirectory, `audio-${mode}.png`); await page.screenshot({ path: screenshotPath }); screenshots.push(screenshotPath);
  }
  stages.push('classic day and blue night audio controls remain visible within their panels');
  return { passed: true, inventory: videoAudioQaInventory, stages, screenshots, syntheticAudioCount: 4,
    singleSubmissions: await page.evaluate(() => window.__videoAudioQa.submissions.filter((item) => item.kind === 'single').length), batchSubmissions: 1 };
}

export async function runStandaloneVideoAudioReferencesUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputBase = path.join(root, 'output', 'playwright');
  const outputDirectory = path.join(outputBase, `video-audio-reference-${Date.now()}`);
  const relative = path.relative(outputBase, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
  for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output cannot traverse directory links'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await fs.mkdir(outputDirectory, { recursive: true }); const port = await findAvailableTcpPort();
  const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
  let browser; let page; const errors = []; let blockedRequests = []; let discoveryRequests = [];
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }); page.setDefaultTimeout(15_000);
    page.on('pageerror', (cause) => errors.push(cause.message));
    ({ blockedRequests, discoveryRequests } = await installVideoAudioFixture(page, `http://127.0.0.1:${port}`));
    const report = await runVideoAudioReferencesUiAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no unexpected external, upload or generation request');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, outputDirectory, errors, blockedRequests, discoveryRequests }, null, 2));
    return { ...report, outputDirectory };
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), errors, blockedRequests, discoveryRequests }, null, 2));
    if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoAudioReferencesUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
