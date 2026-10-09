import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { buildOfficialH3SourceFingerprint } from '../src/officialPrompt';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import { applyVideoPromptChoice, draftFromVideoTask, emptyVideoDraft, videoPromptChoices } from '../src/videoDirectorDraft';
import { buildVideoBatchRows, videoBatchPromptFingerprint, videoBatchRequestFingerprint, videoPromptChoiceKey } from '../src/videoBatch';
import { sourceContentHash } from '../src/sourceIntegrity';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { prepareVideoSeedanceReferenceDraft } from '../src/videoSeedanceReferenceBinding';
import type { AppState, Storyboard, VideoGenerationTask, VideoSequencePlan, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const state = createInitialState();
const project = state.project;
const canonical = '【0s-15s】主体：甲与乙；动作：甲持训练棍连续迎击乙，乙用护臂接住后退半步，甲收棍回防；空间：训练场；镜头：中景保留双方脚步；台词：甲：“左边交给我！”；音效：训练棍与护臂接触声。';
const h3 = 'integrated_multimodal_description: [Shot 1] At 00:00.000–00:15.000, 甲持训练棍连续迎击乙，乙用护臂接住后退半步，甲收棍回防。甲：“左边交给我！”\noverall_soundscape: 训练棍与护臂接触声。\nnon_diegetic_music: N/A';
const seedanceZh = '视频规格：时长 15 秒；画面比例 16:9；分辨率 2K。\n参考素材与职责：本次没有绑定外部参考素材。\n主体连续性：甲持续持训练棍，乙佩戴护臂。\n一句话概述：甲连续迎击乙，乙承接后退，两人回到防守位置。\n连续时间轴（覆盖 0–15 秒）：\n【0s-15s】甲持训练棍连续迎击乙，乙用护臂接住后退半步，甲收棍回防。甲：“左边交给我！”\n全局约束：保持双方身份与脚步连续。';
const seedanceEn = 'Video specification: duration 15 seconds; aspect ratio 16:9; resolution 2K.\nReferences and responsibilities: no external references.\nSubject continuity: A keeps the training staff and B keeps the forearm guard.\nOne-sentence summary: A continuously meets B, B catches the staff and steps back, then both recover their guard.\nContinuous timeline (covering 0–15 seconds):\n【0s-15s】A continuously strikes B with the training staff. B catches it on the guard and steps back half a step; A retracts and guards. A: “左边交给我！”\nGlobal constraints: keep identities and footwork continuous.';
const board: Storyboard = {
  id: 'seedance-source-board', sceneId: project.scenes[0].id, sourceStoryTitle: '训练交接', sourceStoryContent: canonical,
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  targetModelId: 'minimax-h3', finalPrompt: canonical, englishPrompt: 'ordinary English only', englishPromptSource: canonical,
  officialPromptZh: h3, officialPromptEn: h3.replace('训练棍与护臂接触声', 'Training staff contact'), officialPromptEnSource: h3,
  targetOutput: { targetId: 'minimax-h3', prompt: h3, parameters: {}, referenceManifest: [], warnings: [], generatedAt: 1 },
  shots: [{ id: 'training-shot', index: 1, startSec: 0, endSec: 15, purpose: '连续训练', subject: '甲与乙', action: '甲持训练棍迎击乙，乙接住后退，甲回防', camera: '中景', lighting: '自然光', sound: '甲：“左边交给我！”', transition: '连续', result: '双方回防', referenceAssetIds: [], prompt: canonical, locked: false }],
  sequencePlanId: 'seedance-source-plan', segmentId: 'seedance-segment-1', segmentIndex: 1, createdAt: 1, updatedAt: 2,
};
const h3Context = { assets: [], characters: project.characters, locations: project.locations, props: project.props, sceneContent: project.scenes[0].content };
board.officialPromptSource = buildOfficialH3SourceFingerprint(board, h3Context);
project.assets = [];
project.storyboards = [board];
const input = buildOfficialSeedanceInput(project, board);
assert.ok(input, 'a current ordinary source can build Seedance input independently of H3 delivery');
const seedanceFingerprint = getOfficialSeedanceSourceFingerprint(input!);
board.seedance25Output = { targetId: 'seedance-2.5', promptZh: seedanceZh, promptEn: seedanceEn, durationSec: 15, sourceFingerprint: seedanceFingerprint, englishSourceFingerprint: seedanceFingerprint, referenceManifest: [], warnings: [], generatedAt: 3 };
assert.equal(hasCurrentSeedancePrompt(project, board), true);
assert.equal(hasCurrentSeedancePrompt(project, board, 'en'), true);
const roundtrip = normalizeState(JSON.parse(serializeStateForStorage({ ...state, project, projects: [project], activeProjectId: project.id }).serialized));
const reloaded = roundtrip.project.storyboards.find((saved) => saved.id === board.id)!;
assert.equal(hasCurrentSeedancePrompt(roundtrip.project, reloaded), true, 'storage defaults after restart cannot mark a newly saved Seedance body stale');
assert.equal(hasCurrentSeedancePrompt(roundtrip.project, reloaded, 'en'), true, 'English uses the same persistent source identity after restart');
assert.equal(reloaded.seedance25Output?.promptZh, seedanceZh);

const before = structuredClone(project);
const legacy = videoPromptChoices(project);
assert.equal(legacy.find((choice) => choice.language === 'zh')?.prompt, h3, 'existing default H3 selection remains unchanged');
assert.ok(legacy.every((choice) => !choice.promptFormat && !choice.sourceFingerprint), 'historical source identity keeps its legacy keys');
const h3Choice = videoPromptChoices(project, undefined, 'h3').find((choice) => choice.language === 'zh')!;
const seedanceChoice = videoPromptChoices(project, undefined, 'seedance').find((choice) => choice.language === 'zh')!;
const seedanceEnglish = videoPromptChoices(project, undefined, 'seedance').find((choice) => choice.language === 'en')!;
const ordinaryChoice = videoPromptChoices(project, undefined, 'ordinary').find((choice) => choice.language === 'zh')!;
assert.equal(h3Choice.prompt, h3);
assert.equal(seedanceChoice.prompt, seedanceZh);
assert.equal(seedanceEnglish.prompt, seedanceEn);
assert.equal(ordinaryChoice.prompt, canonical, 'ordinary explicitly selects the ordinary body even on an H3 storyboard');
assert.equal(seedanceChoice.id, `${board.id}:seedance:zh`);
assert.equal(seedanceChoice.sourceFingerprint, seedanceFingerprint);
assert.deepEqual(project, before, 'reading each format never rewrites the storyboard or historical deliveries');

const selected = applyVideoPromptChoice(emptyVideoDraft(state.settings), seedanceChoice, project, false);
assert.equal(selected.prompt, seedanceZh, 'single submission uses the selected Seedance body byte for byte');
assert.equal(selected.source?.promptFormat, 'seedance');
assert.equal(selected.source?.sourceFingerprint, seedanceFingerprint);
assert.equal(selected.source?.promptFingerprint, sourceContentHash(seedanceZh), 'snapshot identity identifies the selected body rather than its H3 alternative');
const enDraft = applyVideoPromptChoice(selected, seedanceEnglish, project, false);
assert.equal(enDraft.prompt, seedanceEn);
assert.equal(enDraft.source?.language, 'en');
assert.equal(enDraft.source?.promptFingerprint, sourceContentHash(seedanceEn));

const staleBoard = { ...board, shots: [{ ...board.shots[0], action: '用户重新确认了另一个动作' }] };
assert.equal(hasCurrentSeedancePrompt({ ...project, storyboards: [staleBoard] }, staleBoard), false, 'changed source/shot facts mark the saved strategy output stale');
assert.equal(staleBoard.seedance25Output?.promptZh, seedanceZh, 'staleness preserves historical Chinese for review');
assert.equal(videoPromptChoices({ ...project, storyboards: [staleBoard] }, undefined, 'seedance').length, 0);
assert.equal(videoPromptChoices({ ...project, storyboards: [{ ...board, seedance25Output: { ...board.seedance25Output, sourceFingerprint: 'old-before-strategy' } }] }, undefined, 'seedance').length, 0, 'old strategy output cannot become a current submission by switching tabs');
assert.notEqual(getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, { ...board, shots: [{ ...board.shots[0], endSec: 14.5 }] })), seedanceFingerprint, 'a confirmed fractional shot-time change invalidates the exact old source');
const referenceAsset = { id: 'image-a', name: '甲的训练外观', type: 'reference' as const, role: 'character' as const, referenceRole: 'character' as const, mediaType: 'image' as const, checksum: 'real-image-checksum-a', dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1 };
const referenceBoard = { ...board, globalReferenceAssetIds: [referenceAsset.id] };
const referenceProject = { ...project, assets: [referenceAsset], storyboards: [referenceBoard] };
const referenceFingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(referenceProject, referenceBoard));
referenceBoard.seedance25Output = { ...board.seedance25Output!, sourceFingerprint: referenceFingerprint, englishSourceFingerprint: referenceFingerprint };
const referenceReload = normalizeState(JSON.parse(serializeStateForStorage({ ...state, project: referenceProject, projects: [referenceProject], activeProjectId: referenceProject.id }).serialized));
assert.equal(hasCurrentSeedancePrompt(referenceReload.project, referenceReload.project.storyboards[0]), true, 'normalizing real reference metadata after restart preserves its saved generation identity');
assert.notEqual(getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput({ ...referenceProject, assets: [{ ...referenceAsset, checksum: 'replacement-image-checksum' }] }, referenceBoard)), referenceFingerprint, 'replacing binary image evidence invalidates the old saved delivery');
assert.notEqual(getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput({ ...referenceProject, assets: [{ ...referenceAsset, name: '用户重新确认了参考职责' }] }, referenceBoard)), referenceFingerprint, 'changed reference facts invalidate the old saved delivery');

const plan: VideoSequencePlan = {
  id: 'seedance-source-plan', title: '连续训练', sourceStoryTitle: '训练剧情', sourceStoryContent: canonical,
  durationMode: 'fixed', totalDurationSec: 30, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced',
  segments: [1, 2].map((index) => ({ id: `seedance-segment-${index}`, index, title: `训练${index}`, globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15, content: canonical, summary: '连续训练', sourceSceneIds: [board.sceneId], sourceBeatIds: [], sourceShotIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: index === 1 ? board.id : 'ordinary-second-board', status: 'ready' as const })),
  createdAt: 1, updatedAt: 1,
};
const board2: Storyboard = { ...board, id: 'ordinary-second-board', segmentId: 'seedance-segment-2', segmentIndex: 2, seedance25Output: undefined, targetModelId: 'custom', officialPromptZh: 'legacy ordinary stored text' };
project.storyboards = [board, board2]; project.sequencePlans = [plan];
const rows = buildVideoBatchRows(project, plan, state.settings, { promptFormat: 'seedance', includeStoryboardReferences: false });
assert.equal(rows[0].zh?.draft.prompt, seedanceZh);
assert.equal(rows[0].en?.draft.prompt, seedanceEn);
assert.equal(rows[0].zh?.key, videoPromptChoiceKey(board.id, 'zh', 'seedance'));
assert.equal(rows[0].zh?.draft.source?.promptFormat, 'seedance');
assert.equal(rows[1].zh, undefined, 'missing Seedance in a row cannot silently submit its ordinary or H3 text');
const mixed = buildVideoBatchRows(project, plan, state.settings, { promptFormat: 'seedance', promptFormats: { 'seedance-segment-2': 'ordinary' }, includeStoryboardReferences: false });
assert.equal(mixed[0].zh?.draft.prompt, seedanceZh);
assert.equal(mixed[1].zh?.draft.prompt, canonical);
assert.equal(mixed[1].zh?.draft.source?.promptFormat, 'ordinary');
const legacyIdentity = { key: `${board.id}:zh`, language: 'zh', prompt: h3 };
assert.equal(videoBatchPromptFingerprint({ storyboardId: board.id, language: 'zh', prompt: h3 }), `video-prompt-v1-${sourceContentHash(JSON.stringify(legacyIdentity)).slice('src-v1-'.length)}`, 'an absent format preserves the existing completed/in-flight prompt identity');
assert.notEqual(videoBatchPromptFingerprint({ ...seedanceChoice, prompt: h3 }), videoBatchPromptFingerprint(h3Choice), 'an explicit format remains part of the new source identity even when bodies happen to match');
assert.notEqual(videoBatchRequestFingerprint({ ...selected, prompt: h3 }, [], {}), videoBatchRequestFingerprint(applyVideoPromptChoice(selected, h3Choice, project, false), [], {}));

// Real media identity owns ordinals; ordering controls cannot turn one person's
// image tag into another person's image, and literal dialogue remains literal.
const mappedPrompt = `${seedanceZh}\n@Image 1：训练者甲。@Image 2：训练者乙。@Video 1：实际动作参考。@Audio 1：实际声效参考。@Clay Render 1：实际空间参考。\n甲说：“屏幕上是 @Image 1。”`;
const mappedBoard = { ...board, seedance25Output: { ...board.seedance25Output!, promptZh: mappedPrompt, referenceManifest: [{ id: 'image-a', token: '@Image 1' }, { id: 'image-b', token: '@Image 2' }, { id: 'video-a', token: '@Video 1' }, { id: 'audio-a', token: '@Audio 1' }, { id: 'clay-a', token: '@Clay Render 1' }] } };
const mappedProject = { ...project, storyboards: [mappedBoard] };
const mappedDraft: VideoGenerationDraft = { ...selected, prompt: mappedPrompt, references: [{ assetId: 'image-b', role: 'character' }, { assetId: 'image-a', role: 'character' }] };
const remapped = prepareVideoSeedanceReferenceDraft(mappedProject, mappedDraft, { numbers: [1, 2] });
assert.ok(remapped.draft.prompt.includes('@Image 2：训练者甲。@Image 1：训练者乙。'), 'reordering references maps tokens by saved asset identity');
assert.ok(remapped.draft.prompt.includes('甲说：“屏幕上是 @Image 1。”'), 'reference serialization never rewrites quoted dialogue');
assert.deepEqual(mappedDraft.references.map((reference) => reference.assetId), ['image-b', 'image-a']);
assert.equal(mappedDraft.prompt, mappedPrompt, 'preview mapping does not mutate the saved authored body');
assert.equal(remapped.draft.source?.promptFingerprint, sourceContentHash(remapped.draft.prompt), 'the frozen submission fingerprint follows the actually rendered body');
for (const token of ['@Video 1', '@Audio 1', '@Clay Render 1']) {
  assert.ok(remapped.draft.prompt.includes(token));
  assert.ok(remapped.warnings.some((warning) => warning.includes(token) && warning.includes('专用上传槽')), 'unimplemented media transport is explicitly advisory and never faked');
}
const removed = prepareVideoSeedanceReferenceDraft(mappedProject, { ...remapped.draft, references: [mappedDraft.references[0]] }, { numbers: [1] });
assert.ok(!removed.draft.prompt.includes('@Image 2：训练者甲'), 'a removed identity cannot leave a live token pointing at a different image');
assert.ok(removed.draft.prompt.includes('@Image 1：训练者乙'));
assert.ok(removed.draft.prompt.includes('甲持训练棍连续迎击乙'), 'missing-image handling retains the source action body');
assert.ok(removed.warnings.some((warning) => warning.includes('image-a')));
const laterSource = { ...mappedProject, storyboards: [{ ...mappedBoard, seedance25Output: { ...mappedBoard.seedance25Output, referenceManifest: [{ id: 'wrong-new-image', token: '@Image 1' }] } }] };
assert.equal(prepareVideoSeedanceReferenceDraft(laterSource, { ...remapped.draft, reuseTaskId: 'frozen-old-task' }, { numbers: [1, 2] }).draft.prompt, remapped.draft.prompt, 'frozen reference binding remains valid after the live source manifest changes');

// Actual task engine transport: source selection reaches the frozen POST and a
// later query uses that old task without resubmitting or reading the new draft.
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', model: 'configured-video-model', endpoint: 'https://seedance-mock.test/generate', statusEndpointTemplate: 'https://seedance-mock.test/tasks/{id}', apiKey: 'synthetic-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'output.url' };
let live: AppState = normalizeState({ ...state, project, projects: [project], activeProjectId: project.id });
live.settings.videoTaskApi = api;
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const requests: Request[] = [];
let authorized = false;
const desktop = { videoRequest: async (request: Request) => {
  requests.push(structuredClone(request));
  if (request.method === 'POST') return { status: 200, body: JSON.stringify({ id: `seedance-remote-${requests.length}`, status: 'queued' }) };
  return authorized ? { status: 200, body: JSON.stringify({ status: 'processing' }) } : { status: 401, body: '{}' };
} } as unknown as VideoGenerationDesktop;
const engine = new VideoGenerationEngine({ getState: () => live, setState: (update) => { live = update(live); }, desktop, onRuntime: () => {}, pollIntervalMs: 5 });
const taskById = (id: string) => live.project.generationTasks.find((task) => task.id === id) as VideoGenerationTask;
const until = async (test: () => boolean) => { for (let i = 0; i < 100; i += 1) { if (test()) return; await new Promise((done) => setTimeout(done, 5)); } assert.fail('mock source task did not settle'); };
try {
  const taskId = await engine.start({ ...selected, backend: 'api', workflowId: undefined, runningHubWorkflowId: undefined });
  await until(() => taskById(taskId).videoJob?.trackingStopped === true);
  const posted = JSON.parse(requests.find((request) => request.method === 'POST')!.body!);
  assert.equal(posted.prompt, seedanceZh);
  assert.equal(posted.model, api.model, 'delivery format must not overwrite the configured service model');
  const frozen = structuredClone(taskById(taskId));
  assert.equal(frozen.videoJob?.snapshot.draft.source?.promptFormat, 'seedance');
  assert.equal(frozen.videoJob?.snapshot.draft.source?.promptFingerprint, sourceContentHash(seedanceZh));
  const reused = draftFromVideoTask(frozen)!;
  assert.equal(reused.prompt, seedanceZh);
  assert.equal(reused.source?.promptFormat, 'seedance');
  reused.prompt = '用户现在选择了另一份新稿';
  assert.equal(frozen.videoJob?.snapshot.draft.prompt, seedanceZh, 'editing a reused draft cannot rewrite the historical snapshot');
  live.project.storyboards = live.project.storyboards.map((saved) => ({ ...saved, seedance25Output: undefined, finalPrompt: '源剧情后来修改' }));
  authorized = true; live.settings.videoTaskApi = { ...api, apiKey: 'fixed-mock-key' };
  const count = requests.length;
  await engine.resume(taskId);
  await until(() => requests.length > count);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1, 'query-only resume never submits a new request after source/format changes');
  assert.equal(taskById(taskId).videoJob?.snapshot.draft.prompt, seedanceZh);

  live.settings.videoExecutionMode = 'concurrent';
  live.settings.videoExecutionConcurrency = 3;
  const batch = await engine.startBatch({ projectId: live.project.id, label: 'explicit format mock batch', items: mixed.map((row, index) => ({ itemKey: row.zh!.key, draft: { ...row.zh!.draft, backend: 'api', workflowId: undefined, runningHubWorkflowId: undefined, parameters: { seed: index + 41 } } })), force: true });
  await until(() => requests.filter((request) => request.method === 'POST').length >= 3);
  const batchBodies = requests.filter((request) => request.method === 'POST').slice(1).map((request) => JSON.parse(request.body!));
  assert.deepEqual(batchBodies.map((body) => body.prompt), [seedanceZh, canonical], 'batch transport sends each row\'s explicitly chosen format, without appending its other delivery');
  assert.deepEqual(batch.taskIds.map((id) => taskById(id).videoJob?.snapshot.draft.source?.promptFormat), ['seedance', 'ordinary']);
} finally { engine.dispose(); }

console.log('Seedance sources: explicit Chinese/English/single/mixed-batch selection, legacy identities, stale strategy, frozen POST snapshots and query-only recovery passed (mock video transport only).');
