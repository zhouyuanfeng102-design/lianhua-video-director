import assert from 'node:assert/strict';
import { addVideoReference, assertVideoReferenceSlots, removeVideoReference, videoMiddleFrameOrdinal, videoReferenceSelection, videoReferenceSlotIndex } from '../src/videoReferenceSlots';
import { videoReferenceSlotLabels, videoReferenceUsage } from '../src/videoReferenceUsage';
import { bindComfyVideoWorkflow } from '../src/comfyuiVideo';
import { compileRunningHubVideoApi, createRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { buildVideoApiBody, defaultMiniMaxVideoApi } from '../src/videoGenerationApi';
import { readVideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import { prepareVideoSeedanceReferenceDraft } from '../src/videoSeedanceReferenceBinding';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { videoSeedanceReferencePlan } from '../src/videoSeedanceReferencePlan';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { ReferenceAsset, ReferenceRole, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDraft, VideoImageReference } from '../src/videoGenerationTypes';
import type { RunningHubVideoConfig } from '../src/runningHubVideoTypes';

// Synthetic references and pure request builders only: no user data, media
// engine, desktop bridge or network/paid generation is reachable from here.
globalThis.fetch = async () => { throw new Error('Unexpected network request in middle-frame regression'); };
let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const roles: ReferenceRole[] = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame'];
const ids = ['opening', 'middle-one', 'middle-two', 'middle-three', 'ending'];
const references: VideoImageReference[] = ids.map((assetId, index) => ({ assetId, role: roles[index] }));
const prompt = '动作依次发生，原对白：“保持已有提示词。”';
const generic: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', endpoint: 'https://middle-frame-fixture.invalid/generate',
  statusEndpointTemplate: 'https://middle-frame-fixture.invalid/task/{id}', apiKey: '', authHeader: 'Authorization',
  authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
  requestTemplate: JSON.stringify({ prompt: '{{prompt}}', images: '{{images}}', references: '{{references}}',
    first: '{{first_image}}', last: '{{last_image}}', ...Object.fromEntries(ids.map((_, index) => [`slot${index + 1}`, `{{image_${index + 1}}}`])) }),
};
const draft: VideoGenerationDraft = { name: '首帧及三张中间帧与尾帧', backend: 'api', prompt,
  references, referenceSlotRoles: roles, parameters: {} };
const context = { backend: 'api' as const, slotRoles: roles };
const labels = ['首帧（槽1）', '中间帧1（槽2）', '中间帧2（槽3）', '中间帧3（槽4）', '尾帧（槽5）'];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfoAAAAASUVORK5CYII=';
const assets: ReferenceAsset[] = ids.map((id, index) => ({ id, name: `过程图${index + 1}`, type: 'reference',
  role: 'composition', referenceRole: roles[index], mediaType: 'image', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 }));
const cloudWorkflow = {
  ...createRunningHubVideoWorkflow('五槽过程参考测试'), id: 'middle-frame-cloud', remoteId: '1234567890123456789',
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: 'text', fieldName: 'value', fieldValue: '' },
    ...ids.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'None' })),
  ] }),
  mapping: { prompt: [{ nodeId: 'text', inputName: 'value' }],
    images: ids.map((nodeId, index) => ({ nodeId, inputName: 'image', role: roles[index] })) },
};
const cloud: RunningHubVideoConfig = { enabled: true, baseUrl: 'https://middle-frame-fixture.invalid', apiKey: '',
  activeWorkflowId: cloudWorkflow.id, workflows: [cloudWorkflow] };
const cloudApi = compileRunningHubVideoApi(cloud, cloudWorkflow.id);
const comfy: ComfyVideoWorkflowPreset = {
  id: 'middle-frame-comfy', name: '五槽本地过程参考测试', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({ text: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'original' } },
    ...Object.fromEntries(ids.map((id) => [id, { class_type: 'LoadImage', inputs: { image: `original-${id}.png` } }])) }),
  mapping: cloudWorkflow.mapping,
};

test('三张及更多中间帧按物理槽编号，保存通用角色而非固定1/2', () => {
  const before = structuredClone(references);
  assert.deepEqual(videoReferenceSlotLabels(references, context, 0, roles), labels);
  assert.deepEqual(references.slice(1, 4).map((_, index) => videoMiddleFrameOrdinal(references, index + 1, roles)), [1, 2, 3]);
  const manyRoles: ReferenceRole[] = ['first-frame', ...Array.from({ length: 8 }, (): ReferenceRole => 'middle-frame'), 'last-frame'];
  const many = manyRoles.map((role, index) => ({ assetId: `many-${index}`, role }));
  assert.equal(videoReferenceSlotLabels(many, { backend: 'api', slotRoles: manyRoles }, 0, manyRoles)[8], '中间帧8（槽9）');
  assert.deepEqual(videoReferenceUsage(references, context), references);
  assert.deepEqual(references, before);
});

test('删除中间帧保留编号和空槽，重载补图继承原用途', () => {
  let selection = removeVideoReference(videoReferenceSelection(references), 'middle-two');
  assert.deepEqual(selection.references.map(videoReferenceSlotIndex), [0, 1, 3, 4]);
  assert.deepEqual(videoReferenceSlotLabels(selection.references, context, 0, selection.referenceSlotRoles), [labels[0], labels[1], labels[3], labels[4]]);
  assert.equal(videoMiddleFrameOrdinal(selection.references, 3, selection.referenceSlotRoles), 3, 'empty second middle slot participates in numbering');
  selection = addVideoReference(JSON.parse(JSON.stringify(selection)), { assetId: 'replacement', role: 'scene' });
  assert.deepEqual(selection.references.map((entry) => [entry.assetId, entry.role]), [
    ['opening', 'first-frame'], ['middle-one', 'middle-frame'], ['replacement', 'middle-frame'], ['middle-three', 'middle-frame'], ['ending', 'last-frame'],
  ]);
  assert.deepEqual(videoReferenceSlotLabels(selection.references, context, 0, selection.referenceSlotRoles), labels);
  assert.doesNotThrow(() => assertVideoReferenceSlots(selection.references, 5));
  assert.throws(() => assertVideoReferenceSlots(selection.references, 4), /图片槽 5/u, 'workflow capacity remains authoritative');
});

test('自定义API保留全部中间帧用途与顺序，空槽绑定不移动图片', () => {
  const files = ids.map((id) => `${id}.png`);
  const body = buildVideoApiBody(generic, draft, files);
  assert.deepEqual(body.images, files);
  assert.deepEqual(body.references, files.map((image_url, index) => ({ image_url, role: roles[index] })));
  assert.equal(body.first, files[0]); assert.equal(body.last, files[4]); assert.equal(body.prompt, prompt);
  const sparse = removeVideoReference(videoReferenceSelection(references), 'middle-two');
  const sparseFiles = ['opening.png', 'middle-one.png', 'middle-three.png', 'ending.png'];
  const sparseBody = buildVideoApiBody(generic, { ...draft, ...sparse }, sparseFiles);
  assert.deepEqual([sparseBody.slot1, sparseBody.slot2, sparseBody.slot3, sparseBody.slot4, sparseBody.slot5], [sparseFiles[0], sparseFiles[1], '', sparseFiles[2], sparseFiles[3]]);
  assert.deepEqual(sparseBody.references, [
    { image_url: sparseFiles[0], role: 'first-frame' }, { image_url: sparseFiles[1], role: 'middle-frame' },
    { image_url: sparseFiles[2], role: 'middle-frame', slot_index: 3 }, { image_url: sparseFiles[3], role: 'last-frame', slot_index: 4 },
  ]);
  assert.equal(JSON.stringify(body).includes('frame_number'), false, 'no invented native frame-control field');
});

test('RunningHub及ComfyUI沿实际节点传输五张过程图，空槽不挤占后续图', () => {
  for (const selectedSlots of [[0, 1, 2, 3, 4], [0, 1, 3, 4]]) {
    const selected = selectedSlots.map((slotIndex) => ({ ...references[slotIndex], slotIndex }));
    const files = selectedSlots.map((index) => `openapi/${ids[index]}.png`);
    const body = buildVideoApiBody(cloudApi, { ...draft, references: selected }, files);
    const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
    assert.equal(nodes.find((node) => node.nodeId === 'text')!.fieldValue, prompt);
    assert.deepEqual(ids.map((id) => nodes.find((node) => node.nodeId === id)!.fieldValue),
      ids.map((id, index) => selectedSlots.includes(index) ? `openapi/${id}.png` : 'None'));
    const bound = bindComfyVideoWorkflow(comfy, prompt, files, {}, selected);
    assert.equal(bound.text.inputs.value, prompt);
    assert.deepEqual(ids.map((id, index) => bound[id].inputs.image),
      ids.map((id, index) => selectedSlots.includes(index) ? `openapi/${id}.png` : `original-${id}.png`));
  }
  assert.throws(() => buildVideoApiBody({ ...cloudApi, runningHubImageRoles: roles.slice(0, 4) }, draft, ids), /超出容量/u);
  assert.throws(() => buildVideoApiBody(defaultMiniMaxVideoApi, draft, ids), /MiniMax.*首帧.*尾帧/u, 'unsupported middle frames fail explicitly instead of being omitted');
});

test('草稿、空槽、素材分类、任务快照及工作流用途存储往返保留中间帧', () => {
  const sparse = removeVideoReference(videoReferenceSelection(references), 'middle-two');
  const savedDraft = { ...draft, ...sparse };
  const chapter = readVideoDirectorChapterDraft(JSON.parse(JSON.stringify({ draft: savedDraft,
    parameterText: '{}', parameterDrafts: [], generationMode: 'single' })))!;
  assert.deepEqual(chapter.draft.references, sparse.references);
  assert.deepEqual(chapter.draft.referenceSlotRoles, roles);
  const state = createInitialState(); state.project.assets = assets; state.projects = [];
  state.settings.runningHubVideo = cloud;
  state.settings.comfyuiVideo = { enabled: true, baseUrl: 'https://middle-frame-fixture.invalid', apiKey: '', activeWorkflowId: comfy.id, workflows: [comfy] };
  const task: VideoGenerationTask = { id: 'middle-frame-task', kind: 'video', storyboardId: '', targetId: 'fixture',
    status: 'failed', requestBody: {}, createdAt: 1, updatedAt: 1, videoJob: { stage: 'failed', snapshot: {
      projectId: state.project.id, clientId: 'middle-frame-task', draft: savedDraft,
      connection: { backend: 'api', api: cloudApi },
      images: sparse.references.map((entry) => ({ ...entry, name: entry.assetId, dataUrl: png, freezeState: 'frozen', frozenAt: 1 })),
    } } };
  state.project.generationTasks = [task];
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.deepEqual(restored.project.assets.map((entry) => entry.referenceRole), roles);
  assert.deepEqual(restored.settings.runningHubVideo.workflows[0].mapping.images.map((entry) => entry.role), roles);
  assert.deepEqual(restored.settings.comfyuiVideo.workflows[0].mapping.images.map((entry) => entry.role), roles);
  const restoredTask = restored.project.generationTasks.find((entry) => entry.id === task.id) as VideoGenerationTask;
  assert.deepEqual(restoredTask.videoJob!.snapshot.draft.references, sparse.references);
  assert.deepEqual(restoredTask.videoJob!.snapshot.draft.referenceSlotRoles, roles);
  assert.deepEqual(restoredTask.videoJob!.snapshot.images.map((entry) => entry.role), ['first-frame', 'middle-frame', 'middle-frame', 'last-frame']);
});

test('Seedance中英文职责写出3张中间帧的次序，空槽编号稳定且正文对白保留', () => {
  const project = createInitialState().project; project.assets = assets;
  for (const language of ['zh', 'en'] as const) {
    const original = language === 'zh' ? `视频规格：30秒，16:9。\n参考素材与职责：不使用参考素材。\n主体连续性：人物装束保持。\n一句话概述：向门前行。\n连续时间轴：\n${prompt}\n全局约束：顺序保持。`
      : `Video specification: 30 seconds, 16:9.\nReferences and responsibilities: do not use reference material.\nSubject continuity: preserve the outfit.\nOne-sentence summary: walk to the gate.\nContinuous timeline:\n${prompt}\nGlobal constraints: preserve sequence.`;
    const input: VideoGenerationDraft = { ...draft, prompt: original, source: { language, promptFormat: 'seedance' },
      seedanceReferenceBinding: { version: 1, projectId: project.id, basePrompt: original, renderedPrompt: original, sourceLanguage: language, references: [] } };
    const numberedApi = { ...generic, requestTemplate: '{"prompt":"{{prompt}}","references":"{{references}}"}' };
    const result = prepareVideoSeedanceReferenceDraft(project, input, videoSeedanceReferencePlan(input.references, { backend: 'api', api: numberedApi }));
    for (const index of [1, 2, 3]) {
      assert.ok(result.draft.prompt.includes(language === 'zh' ? `中间帧 ${index}：过程画面与连续性参考` : `Intermediate frame ${index}: action progression and continuity reference`));
    }
    assert.ok(result.draft.prompt.includes(prompt));
    const sparse = removeVideoReference(videoReferenceSelection(input.references), 'middle-two');
    const sparseDraft = { ...result.draft, ...sparse };
    const sparseResult = prepareVideoSeedanceReferenceDraft(project, sparseDraft, videoSeedanceReferencePlan(sparse.references, { backend: 'api', api: numberedApi }));
    assert.ok(sparseResult.draft.prompt.includes(language === 'zh' ? '中间帧 3：' : 'Intermediate frame 3:'), 'middle ordinal remains physical-role based although image tokens become dense');
    assert.equal(sparseResult.draft.prompt.includes(language === 'zh' ? '中间帧 2：' : 'Intermediate frame 2:'), false, 'empty middle slot is not invented as an uploaded picture');
    assert.ok(sparseResult.draft.prompt.includes(prompt));
  }
});

test('H3中英文职责写出3张中间帧，原镜头动作时间对白声音逐字保留', () => {
  const project = createInitialState().project; project.assets = assets;
  const original = 'integrated_multimodal_description:\n[Shot 1] At 00:00.000 本段0–4秒：向门前行 <d>[Chinese] 保持已有提示词。</d>。\n[Shot 2] At 00:04.000 停步回头 <sound>脚步声</sound>。\noverall_soundscape: footsteps\nnon_diegetic_music: N/A';
  const numberedApi = { ...generic, requestTemplate: '{"prompt":"{{prompt}}","references":"{{references}}"}' };
  for (const language of ['zh', 'en'] as const) {
    const input: VideoGenerationDraft = { ...draft, prompt: original, source: { language, promptFormat: 'h3' },
      h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: original, renderedPrompt: original,
        sourceLanguage: language, identities: { version: 1, characters: [] } } };
    const result = prepareVideoH3ReferenceDraft(project, input, { backend: 'api', api: numberedApi });
    for (const index of [1, 2, 3]) {
      assert.ok(result.draft.prompt.includes(language === 'zh' ? `中间帧 ${index} 的过程构图与连续性参考`
        : `intermediate frame ${index} progression composition and continuity reference`));
    }
    assert.equal(result.draft.prompt.slice(0, result.draft.prompt.indexOf('[Shot 1]') + '[Shot 1]'.length),
      original.slice(0, original.indexOf('[Shot 1]') + '[Shot 1]'.length));
    assert.ok(result.draft.prompt.endsWith(original.slice(original.indexOf(' At 00:00.000'))), 'only purpose prose is inserted; all authored shot, dialogue and audio bytes stay intact');
    assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api: numberedApi }).draft.prompt,
      result.draft.prompt, 'preview does not accumulate the purpose description');
    const sparse = removeVideoReference(videoReferenceSelection(input.references), 'middle-two');
    const sparseResult = prepareVideoH3ReferenceDraft(project, { ...result.draft, ...sparse }, { backend: 'api', api: numberedApi });
    assert.ok(sparseResult.draft.prompt.includes(language === 'zh' ? '中间帧 3 的' : 'intermediate frame 3 '));
    assert.equal(sparseResult.draft.prompt.includes(language === 'zh' ? '中间帧 2 的' : 'intermediate frame 2 '), false);
    assert.ok(sparseResult.draft.prompt.endsWith(original.slice(original.indexOf(' At 00:00.000'))));
  }
});

console.log(`Middle-frame references: ${groups} focused groups passed; synthetic data and zero API calls.`);
