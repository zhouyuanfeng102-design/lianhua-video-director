import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { videoH3MediaModeContract, refreshVideoH3MediaModeDraft } from '../src/videoH3MediaMode';
import { renderVideoAudioDraft, stripVideoAudioPromptBinding } from '../src/videoAudioReferences';
import { prepareVideoMotionDraft, stripVideoMotionPromptBinding } from '../src/videoMotionReferences';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { readExistingH3PromptProtocol } from '../src/h3PromptProtocol';
import { cleanSeedanceReferenceClaims } from '../src/seedanceReferenceClaims';
import { readSeedanceSections } from '../src/seedanceSections';
import type { Character, ReferenceAsset, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

const project = createInitialState().project;
project.id = 'motion-integration';
project.characters = [{ id: 'a', name: '甲', assetIds: ['portrait'], gender: '女', race: '', apparentAge: '成年',
  appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' } as Character];
project.assets = [
  { id: 'portrait', name: '人物图', type: 'character', role: 'character', mediaType: 'image',
    referenceEntityBinding: { kind: 'character', entityId: 'a' } },
  { id: 'voice', name: '声线', type: 'audio', role: 'audio', mediaType: 'audio' },
  { id: 'motion', name: '动作视频', type: 'video', role: 'motion', mediaType: 'video' },
].map((asset) => ({ ...asset, tags: [], createdAt: 1, updatedAt: 1 } as ReferenceAsset));
project.storyboards = []; project.generationTasks = [];
const fields: NonNullable<VideoTaskApiConfig['runningHubMappedFields']> = [
  { kind: 'prompt', nodeId: 'p', fieldName: 'text' },
  { kind: 'image', nodeId: 'i', fieldName: 'image', imageIndex: 0 },
  { kind: 'audio', nodeId: 'a', fieldName: 'audio', audioIndex: 0 },
  { kind: 'video', nodeId: 'v', fieldName: 'video', videoIndex: 0 },
];
const api: VideoTaskApiConfig = { enabled: true, provider: 'runninghub', model: 'named-workflow', runningHubAppId: '123',
  endpoint: 'https://fixture.invalid/openapi/v2/run/ai-app/123', statusEndpointTemplate: '', apiKey: '',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'url',
  runningHubMappedFields: fields, runningHubImageRoles: ['character'],
  requestTemplate: JSON.stringify({ nodeInfoList: fields.map((field) => ({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: '' })) }) };
const context = { backend: 'api' as const, api };
const anchor = '甲 (S1) 是蓝衣成年女性。';
const source = `integrated_multimodal_description:\n[Shot 1] ${anchor}甲左拳连击三次，右掌持续按住对手左肩。甲 (S1) 说：<d>[Chinese] 接招。</d>\n[Shot 2] At 00:07.500 甲左腿低扫两次；对手下沉后脱开按肩。\noverall_soundscape: 原有拳脚接触声随事件发生。\nnon_diegetic_music: N/A`;
const draft: VideoGenerationDraft = { name: '三类参考', backend: 'api', prompt: source, parameters: {}, source: { promptFormat: 'h3', language: 'zh' },
  references: [{ assetId: 'portrait', role: 'character', characterIds: ['a'] }],
  audioReferences: [{ assetId: 'voice', bindingId: '["a","audio"]', slotIndex: 0, target: { kind: 'character', characterId: 'a' }, retainMode: 'reference', notes: '' }],
  videoReferences: [{ assetId: 'motion', bindingId: '["v","video"]', slotIndex: 0 }],
  h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: source, renderedPrompt: source,
    identities: { version: 1, characters: [{ characterId: 'a', name: '甲', speakerToken: '(S1)', referenceAnchor: anchor }] } } };
let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`PASS ${++groups} ${name}`); };
const pipeline = (input: VideoGenerationDraft) => {
  const withoutMotion = { ...input, prompt: stripVideoMotionPromptBinding(input), videoReferenceBinding: undefined };
  const unbound = { ...withoutMotion, prompt: stripVideoAudioPromptBinding(withoutMotion.prompt, withoutMotion.audioReferenceBinding), audioReferenceBinding: undefined };
  const images = prepareVideoH3ReferenceDraft(project, unbound, context);
  return { ...images, draft: prepareVideoMotionDraft(project, renderVideoAudioDraft(project, images.draft), context) };
};

await test('real video changes H3 mode and input identity without changing existing image-only modes', () => {
  const firstLast = { ...draft, references: [{ assetId: 'portrait', role: 'first-frame' as const }], audioReferences: [], videoReferences: [] };
  assert.equal(videoH3MediaModeContract(firstLast, context).mode, 'keyframe');
  const withVideo = { ...firstLast, videoReferences: draft.videoReferences };
  const contract = videoH3MediaModeContract(withVideo, context);
  assert.equal(contract.mode, 'full-reference'); assert.equal(contract.videoCount, 1);
  assert.equal(videoH3MediaModeContract({ ...withVideo, references: [] }, context).mode, 'full-reference');
  assert.notEqual(contract.inputIdentity, videoH3MediaModeContract({ ...withVideo,
    videoReferences: [{ ...draft.videoReferences![0], assetId: 'another-clip' }] }, context).inputIdentity);
  assert.notEqual(contract.inputIdentity, videoH3MediaModeContract(withVideo, { ...context, api: { ...api,
    runningHubMappedFields: fields.map((field) => field.kind === 'video' ? { ...field, nodeId: 'other-video-node' } : field) } }).inputIdentity);
});

await test('image then audio then motion reaches one request with identity, actions and cuts retained', () => {
  const before = structuredClone(draft);
  const result = pipeline(draft);
  assert.equal(result.issue, undefined);
  assert.equal(result.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
  assert.equal(result.draft.h3MediaMode?.mode, 'full-reference');
  assert.match(result.draft.prompt, /<Subject 1> is 甲 \(S1\) referenced from <Picture 1>/u);
  assert.match(result.draft.prompt, /<Audio 1>/u); assert.match(result.draft.prompt, /<Video 1>/u);
  assert.match(result.draft.prompt, /左拳连击三次/u); assert.match(result.draft.prompt, /左腿低扫两次/u);
  assert.match(result.draft.prompt, /右掌持续按住对手左肩/u);
  assert.deepEqual(readExistingH3PromptProtocol(result.draft.prompt)?.shots, readExistingH3PromptProtocol(source)?.shots);
  assert.match(result.draft.prompt, /<d>\[Chinese\] 接招。<\/d>/u);
  const body = buildVideoApiBody(api, result.draft, ['portrait.png'], ['voice.wav'], ['motion.mp4']);
  const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
  assert.equal(nodes.find((node) => node.nodeId === 'v')?.fieldValue, 'motion.mp4');
  assert.equal(nodes.find((node) => node.nodeId === 'i')?.fieldValue, 'portrait.png');
  assert.equal(nodes.find((node) => node.nodeId === 'a')?.fieldValue, 'voice.wav');
  assert.equal(nodes.find((node) => node.nodeId === 'p')?.fieldValue, result.draft.prompt);
  assert.deepEqual(pipeline(result.draft).draft.prompt, result.draft.prompt, 'reopening the submitted draft never loses identity or stacks bindings');
  assert.deepEqual(draft, before);
});

await test('explicit H3 reference refresh unwraps prior motion/audio before using trusted identity metadata', async () => {
  const submitted = pipeline(draft).draft;
  let calls = 0;
  const updated = await refreshVideoH3MediaModeDraft({ project, draft: submitted, context, request: async () => { calls++; return ''; } });
  assert.equal(calls, 0);
  assert.equal(updated.h3MediaMode?.mode, 'full-reference');
  assert.ok(updated.h3ReferenceBinding?.executionIdentities);
  assert.deepEqual(updated.videoReferences, draft.videoReferences);
  assert.equal(pipeline(updated).characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
});

const seedance = `视频规格：时长15秒，16:9，720p。\n参考素材与职责：没有视频参考素材。未提供图片参考素材。未提供音频参考素材。不使用参考素材。\n主体连续性：甲保持蓝衣。\n一句话概述：甲进攻。\n连续时间轴（覆盖0–15秒）：\n0–7.5秒，甲左拳连击三次。7.5–15秒，甲左腿低扫两次。甲说：“没有视频参考素材。”\n全局约束：动作次数与对白原字保留。`;
const seedanceDraft = (): VideoGenerationDraft => ({ ...draft, source: { promptFormat: 'seedance', language: 'zh' }, prompt: seedance,
  references: [], audioReferences: [], h3ReferenceBinding: undefined,
  seedanceReferenceBinding: { version: 1, projectId: project.id, basePrompt: seedance, renderedPrompt: seedance, references: [] } });

await test('video-only Seedance resolves stale media absence without treating the video as an identity image', () => {
  const result = pipeline(seedanceDraft());
  assert.equal(result.issue, undefined);
  assert.doesNotMatch(result.draft.prompt, /参考素材与职责：没有视频参考素材/u);
  assert.doesNotMatch(result.draft.prompt, /不使用参考素材/u);
  assert.match(result.draft.prompt, /未提供图片参考素材/u);
  assert.match(result.draft.prompt, /未提供音频参考素材/u);
  assert.match(result.draft.prompt, /甲说：“没有视频参考素材。”/u);
  assert.match(result.draft.prompt, /@Video 1/u);
  assert.deepEqual(result.draft.references, []); assert.deepEqual(result.draft.videoReferences, draft.videoReferences);
  assert.equal(result.warnings.some((warning) => /只传图片|未配置该类型/u.test(warning)), false);
  assert.ok(readSeedanceSections(result.draft.prompt));
});

await test('Seedance image identity and motion video coexist in the same actual array request', () => {
  const generic: VideoTaskApiConfig = { ...api, provider: 'generic',
    requestTemplate: JSON.stringify({ prompt: '{{prompt}}', images: '{{images}}', videos: '{{videos}}' }) };
  const input = { ...seedanceDraft(), references: draft.references,
    videoReferences: [{ assetId: 'motion', slotIndex: 0, bindingId: 'template-video-1' }] };
  const images = prepareVideoH3ReferenceDraft(project, input, { backend: 'api', api: generic });
  assert.equal(images.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
  const rendered = prepareVideoMotionDraft(project, images.draft, { backend: 'api', api: generic });
  assert.match(rendered.prompt, /@Image 1/u); assert.match(rendered.prompt, /@Video 1/u);
  assert.doesNotMatch(readSeedanceSections(rendered.prompt)!.sections.references
    ? rendered.prompt.slice(readSeedanceSections(rendered.prompt)!.sections.references.start,
      readSeedanceSections(rendered.prompt)!.sections.references.end) : '', /没有视频参考素材|未提供图片参考素材/u);
  const body = buildVideoApiBody(generic, rendered, ['portrait.png'], [], ['motion.mp4']);
  assert.deepEqual(body.images, ['portrait.png']); assert.deepEqual(body.videos, ['motion.mp4']);
  assert.equal(body.prompt, rendered.prompt);
});

await test('Seedance known video source follows the selected physical slot without changing its timeline', () => {
  const base = seedance.replace('没有视频参考素材。', '@Video 1：只参考动作轨迹。').replace('不使用参考素材。', '');
  const input = { ...seedanceDraft(), prompt: base,
    videoReferences: [{ ...draft.videoReferences![0], slotIndex: 1, bindingId: '["v2","video"]' }],
    seedanceReferenceBinding: { version: 1 as const, projectId: project.id, basePrompt: base, renderedPrompt: base,
      references: [{ token: '@Video 1', assetId: 'motion' }] } };
  const rebound = prepareVideoH3ReferenceDraft(project, input, context);
  assert.match(rebound.draft.prompt, /@Video 2：只参考动作轨迹/u);
  assert.equal(rebound.warnings.some((warning) => /@Video/u.test(warning)), false);
  assert.ok(rebound.draft.prompt.includes('0–7.5秒，甲左拳连击三次。7.5–15秒，甲左腿低扫两次。'));
  const arrayApi: VideoTaskApiConfig = { ...api, provider: 'generic', requestTemplate: '{"prompt":"{{prompt}}","images":"{{images}}","videos":"{{videos}}"}' };
  const arrayInput = { ...input, videoReferences: [{ ...input.videoReferences[0], bindingId: 'template-video-2' }] };
  const dense = prepareVideoH3ReferenceDraft(project, arrayInput, { backend: 'api', api: arrayApi }).draft;
  const submitted = prepareVideoMotionDraft(project, dense, { backend: 'api', api: arrayApi });
  assert.match(submitted.prompt, /@Video 1：只参考动作轨迹/u);
  assert.doesNotMatch(submitted.prompt, /@Video 2/u);
  assert.equal(submitted.videoReferences![0].slotIndex, 1, 'transport ordinals do not rewrite the saved input slot');
});

await test('media absence cleanup stays scoped to the selected modality and protects quoted story text', () => {
  const body = '没有视频参考素材。未提供图片、音频参考素材。甲说：“没有视频参考素材。”';
  const cleaned = cleanSeedanceReferenceClaims(body, { hasImages: false, hasAudio: false, hasVideo: true }).text;
  assert.equal(cleaned, '未提供图片、音频参考素材。甲说：“没有视频参考素材。”');
  assert.equal(cleanSeedanceReferenceClaims('No images or audio reference materials are provided. No video reference material is provided.',
    { hasImages: false, hasAudio: false, hasVideo: true }).text, 'No images or audio reference materials are provided.');
  assert.equal(cleanSeedanceReferenceClaims('没有视频参考素材。', { hasImages: true, hasAudio: true }).text, '没有视频参考素材。');
});

console.log(`motion reference integration: ${groups} groups passed; no external requests`);
