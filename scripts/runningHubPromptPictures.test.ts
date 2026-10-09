import assert from 'node:assert/strict';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { runningHubWholePromptPictureNumbers } from '../src/runningHubPromptPictures';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import type { AppState, ReferenceAsset } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const nodeIds = ['438', '435', '437', '439', '431', '429'];
const workflow = { ...createRunningHubVideoWorkflow('合成 H3 六图协议'), runKind: 'ai-app' as const, remoteId: '2104753059472990209',
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: '' },
    ...nodeIds.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'example.png' })),
    { nodeId: '827', fieldName: 'value', fieldValue: 6 },
    { nodeId: 'strict', fieldName: 'strict_prompt_tags', fieldValue: true },
  ], instanceType: 'default', usePersonalQueue: false }),
  mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: nodeIds.map((nodeId) => ({ nodeId, inputName: 'image' })) },
};
const api = compileRunningHubVideoApi({ enabled: true, baseUrl: 'https://fixture.invalid', apiKey: '',
  workflows: [workflow], activeWorkflowId: workflow.id });
assert.equal(api.runningHubMappedFields?.find((field) => field.kind === 'image-count')?.imageCountMode, 'prefix');
const refs: VideoGenerationDraft['references'] = Array.from({ length: 6 }, (_, index) => ({ assetId: `reference-${index + 1}`, role: 'character' }));
const draft: VideoGenerationDraft = { backend: 'api', name: '本地合成资料', prompt: '', parameters: {}, references: refs };
const images = Array.from({ length: 6 }, (_, index) => `openapi/synthetic-${index + 1}.png`);
const bad = { ...draft, prompt: 'subject_definitions: 甲 referenced from <Picture 7>; 乙 referenced from <Picture 8>; 场景 reference <Picture 9>.' };
const originalBad = structuredClone(bad);
assert.throws(() => buildVideoApiBody(api, bad, images), /实际连接 6 张图片.*1、2、3、4、5、6.*<Picture 7>、<Picture 8>、<Picture 9>/u);
assert.deepEqual(bad, originalBad, 'transport refuses invalid references without guessing identities or rewriting the authored prompt');
assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, bad, images), /没有提交视频生成/u);

for (const literal of ['<d>[Chinese] 请读出 <Picture 9>。</d>', '"Picture #8"', 'sound_effects: <Image7>', '[Picture 9]']) {
  assert.throws(() => buildVideoApiBody(api, { ...draft, prompt: `subject_definitions: 测试角色\nintegrated_multimodal_description: ${literal}` }, images),
    /未连接的 <Picture [789]>.*对白或引号/u, 'T8 strict validation sees the entire prompt, even literals protected from identity editing');
}
assert.deepEqual(runningHubWholePromptPictureNumbers('Picture #007; < image 8 >; <Picture9>; xPicture 99; <Picture 0>'), ['7', '8', '9', '0']);
assert.deepEqual(runningHubWholePromptPictureNumbers('名字Picture 9; Picture 8角色; <Picture 7>'), ['7'],
  'bare aliases use the upstream Unicode word boundaries, while explicit official tags remain recognized');

const sparse = { ...draft, prompt: 'subject_definitions: 角色 reference <Picture 3>', references: [
  { assetId: 'first', role: 'character' as const, slotIndex: 0 }, { assetId: 'third', role: 'character' as const, slotIndex: 2 },
] };
assert.throws(() => buildVideoApiBody(api, sparse, images.slice(0, 2)), /从图片槽 1 起连续选择 2 个槽位/u,
  'a verified prefix-count graph cannot compact sparse physical slots behind the prompt');

const unknown = { ...api, runningHubMappedFields: api.runningHubMappedFields!.filter((field) => field.kind !== 'image-count') };
const unknownBody = buildVideoApiBody(unknown, { ...sparse, prompt: 'subject_definitions: 角色 reference <Picture 3>; 固定未映射图片 <Picture 9>' }, images.slice(0, 2));
const unknownNodes = unknownBody.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
assert.equal(unknownNodes.find((node) => node.nodeId === nodeIds[0])?.fieldValue, images[0]);
assert.equal(unknownNodes.find((node) => node.nodeId === nodeIds[2])?.fieldValue, images[1]);
assert.match(String(unknownNodes.find((node) => node.nodeId === 'prompt')?.fieldValue), /<Picture 9>/u,
  'editable slot metadata alone cannot establish an unknown graph final media count');

const withTail = { ...draft, prompt: 'subject_definitions: 角色 reference <Picture 2>, <Picture 3>, <Picture 4>, <Picture 5>, <Picture 6>\nintegrated_multimodal_description: 延续上一段 <Picture 1>',
  references: [{ assetId: 'tail-frame', role: 'first-frame' as const }, ...refs.slice(1)] };
const frozenTail = structuredClone(withTail);
const tailBody = buildVideoApiBody(api, withTail, images);
const tailNodes = tailBody.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>;
assert.equal(tailNodes.find((node) => node.nodeId === nodeIds[0])?.fieldValue, images[0]);
assert.equal(tailNodes.find((node) => node.nodeId === nodeIds[1])?.fieldValue, images[1]);
assert.equal(tailNodes.find((node) => node.fieldName === 'strict_prompt_tags')?.fieldValue, true);
assert.equal(tailNodes.find((node) => node.nodeId === 'prompt')?.fieldValue, withTail.prompt);
assert.deepEqual(withTail, frozenTail, 'the continuity tail occupies its chosen first slot without shifting proven character references or prompt facts');

// The request binder is also used by engine preflight: malformed six-image
// prompts fail before any image read/upload, saved task or billable POST.
{
  let state = createInitialState();
  state.settings.runningHubVideo = { enabled: true, baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-test-key',
    workflows: [workflow], activeWorkflowId: workflow.id };
  state.project.assets.push(...refs.map((reference): ReferenceAsset => ({ id: reference.assetId, name: reference.assetId,
    type: 'reference', role: 'character', tags: [], createdAt: 1, updatedAt: 1,
    relativePath: `images/${reference.assetId}.png`, checksum: `synthetic-${reference.assetId}`,
    fileName: `${reference.assetId}.png`, mediaType: 'image', managed: true })));
  state.projects = [state.project];
  let sideEffects = 0;
  const unexpected = async (): Promise<never> => { sideEffects += 1; throw new Error('Invalid prompt must fail before any external or persistence action'); };
  const desktop: VideoGenerationDesktop = { videoRequest: unexpected, readManagedImageDataUrl: unexpected,
    storeGeneratedImage: unexpected, downloadGeneratedMedia: unexpected, setVideoTaskCredential: unexpected,
    saveVideoTaskCheckpoint: unexpected, getVideoTaskCredential: async () => null, getVideoTaskCheckpoint: async () => null,
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {}, deleteVideoTaskCheckpoint: async () => false };
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater: (current: AppState) => AppState) => { state = updater(state); },
    desktop, onRuntime: () => {}, persistState: unexpected });
  const badInput = { ...bad, runningHubWorkflowId: workflow.id };
  try {
    await assert.rejects(() => engine.start(badInput), /实际连接 6 张图片.*<Picture 7>、<Picture 8>、<Picture 9>/u);
    await assert.rejects(() => engine.startBatch({ projectId: state.project.id, label: '六图不一致预检',
      items: [{ itemKey: 'invalid-h3', draft: badInput }] }), /实际连接 6 张图片.*<Picture 7>、<Picture 8>、<Picture 9>/u);
    assert.equal(sideEffects, 0, 'single and batch preflight must not read/upload references, persist shells or send any provider request');
    assert.equal(state.project.generationTasks.length, 0);
    assert.deepEqual(badInput.references, refs, 'preflight does not add references or mutate selected identities');
  } finally { engine.dispose(); }
}
console.log('RunningHub H3 picture transport: six-image overflow, whole-prompt aliases/literals, sparse-prefix safety, unknown-graph preservation, first-slot tail and upload-free single/batch preflight passed without network calls.');
