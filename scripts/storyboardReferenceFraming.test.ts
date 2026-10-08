import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCustomStoryboardImageRequests, buildStoryboardImageRequests, mergeStoryboardReferenceInputs, resolveStoryboardReferenceInputs } from '../src/storyboardImages';
import { buildDirectStoryboardImageBatchRequests } from '../src/storyboardImageToImage';
import { buildStoryboardImagePromptWithReferences, storyboardReferenceCharacters } from '../src/storyboardImageReferences';
import type { Character, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

const character = (id: string, name: string): Character => ({
  id, name, gender: '女', apparentAge: '成年', race: '人类', appearance: `${name}黑色长发与银色发饰`,
  outfit: '银色护甲', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
});
const a = character('a', '绝死绝命');
const b = character('b', '马雷');
const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'composition', source: 'upload', mediaType: 'image',
  dataUrl: `data:image/png;base64,${Buffer.from(id).toString('base64')}`, tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const oldShot = image('old-shot', { source: 'generated', sourceStoryboardId: 'board', sourceShotId: 'shot', imageVariant: 'storyboard-frame',
  prompt: '历史构图：正脸朝向观众，两个人全身展开', visualAnchor: '旧图锚点：身体背向敌人而正脸看镜头' });
const oldFirst = image('old-first', { ...oldShot, id: 'old-first', name: 'old-first', imageVariant: 'first-frame' });
const oldLast = image('old-last', { ...oldShot, id: 'old-last', name: 'old-last', imageVariant: 'last-frame' });
const portrait = image('portrait', { sourceEntityKind: 'character', sourceEntityId: a.id, type: 'character', role: 'character',
  prompt: '旧人物全身站姿，头朝向观众', visualAnchor: '旧人物头肩正面海报' });
const free = image('unbound');
const shot: VideoShot = {
  id: 'shot', index: 1, startSec: 0, endSec: 30, purpose: '戒备', subject: '绝死绝命与马雷',
  action: '绝死绝命身体前倾朝向马雷，目光锁定马雷下盘；右手握紧战镰',
  camera: '双人中景，末尾下摇到握镰的手和蓄力的战靴特写', lighting: '走廊冷光', sound: '', result: '战靴踏稳地面',
  referenceAssetIds: [oldShot.id, oldFirst.id, oldLast.id, free.id], prompt: '', transition: '', locked: false,
};
const h3 = `integrated_multimodal_description: [Shot 1] ${shot.action}。${shot.camera}。\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`;
const board: Storyboard = {
  id: 'board', sceneId: 'scene', workflow: 'drama', inputMode: 'text', durationSec: 30, durationPreset: 'custom', shotMode: 'exact',
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '',
  globalLock: '', shots: [shot], finalPrompt: '', officialPromptZh: h3, createdAt: 1, updatedAt: 1,
};
const context = { characters: [a, b], locations: [], props: [], scenes: [], assets: [oldShot, oldFirst, oldLast, portrait, free],
  visibleCharacterNamesByShotId: { shot: [a.name, b.name] } };

test('all boundary and ordinary frames exclude same-shot automatic outputs; explicit selected output remains usable', () => {
  const original = JSON.stringify({ board, context });
  const requests = [
    ...buildStoryboardImageRequests(board, 'storyboard-shots', context),
    ...buildStoryboardImageRequests(board, 'boundary-frames', context),
    ...buildCustomStoryboardImageRequests(board, [{ sourceShotId: shot.id, description: '绝死绝命握镰的手部特写' }], context),
  ];
  for (const request of requests) {
    assert.deepEqual(request.referenceAssetIds, [free.id, portrait.id]);
    assert.doesNotMatch(request.conversionSource, /历史构图|旧图锚点|旧人物全身站姿|旧人物头肩正面海报/u);
    assert.ok(request.conversionSource.includes(a.appearance));
  }
  const explicit = buildStoryboardImageRequests({ ...board, globalReferenceAssetIds: [oldShot.id] }, 'boundary-frames', context);
  assert.ok(explicit.every((request) => request.referenceAssetIds[0] === oldShot.id));
  assert.equal(JSON.stringify({ board, context }), original, 'source video, H3, dossiers and reference metadata are unchanged');
});

test('tail target uses terminal camera crop while start target uses entry crop, preserving the original H3', () => {
  const [first, tail] = buildStoryboardImageRequests(board, 'boundary-frames', context);
  assert.match(first.conversionSource, /首帧取景：按第一镜起始时刻/u);
  assert.match(tail.conversionSource, /尾帧取景：按最后一镜结束时刻/u);
  assert.match(tail.conversionSource, /必须采用运镜终点/u);
  assert.match(tail.conversionSource, /只呈现该局部，其他人物即使仍在场也可在画外/u);
  assert.ok(tail.conversionSource.includes(shot.action));
  assert.ok(tail.conversionSource.includes(shot.camera));
});

test('actual pixel order and prompt bindings remain aligned after primary-first duplicate removal', async () => {
  const first = image('first', { characterReferenceId: a.id });
  const duplicate = image('duplicate', { dataUrl: first.dataUrl, characterReferenceId: a.id });
  const second = image('second', { characterReferenceId: b.id });
  const all = [duplicate, second, first, free];
  const primary = await resolveStoryboardReferenceInputs([second.id, first.id], all, {});
  const resolved = await resolveStoryboardReferenceInputs([duplicate.id, second.id, free.id], all, {});
  const merged = mergeStoryboardReferenceInputs(primary, resolved);
  assert.deepEqual(merged.referenceAssets.map((asset) => asset.id), ['second', 'first', 'unbound']);
  assert.deepEqual(merged.referenceImages, [second.dataUrl, first.dataUrl, free.dataUrl]);
  assert.equal(merged.primaryReferenceImageCount, 2);
  const body = '绝死绝命侧身面对右侧的马雷，自然侧脸看向马雷下盘。';
  const prompt = buildStoryboardImagePromptWithReferences(body, merged.referenceAssets, context);
  assert.ok(prompt.startsWith(body));
  assert.match(prompt, /1\. "second" — 人物 "马雷"/u);
  assert.match(prompt, /2\. "first" — 人物 "绝死绝命"/u);
  assert.match(prompt, /3\. "unbound" — 普通画面参考/u);
  assert.match(prompt, /允许侧脸、背面和局部特写/u);
  assert.equal(buildStoryboardImagePromptWithReferences(body, [], context), body);
});

test('manual binding and unbinding override provenance without requiring binding', () => {
  assert.deepEqual(storyboardReferenceCharacters({ ...portrait, characterReferenceId: b.id }, context).map((owner) => owner.id), [b.id]);
  assert.deepEqual(storyboardReferenceCharacters({ ...portrait, characterReferenceId: null }, context), []);
  assert.deepEqual(storyboardReferenceCharacters({ ...portrait, characterReferenceId: 'missing' }, context), []);
  assert.match(buildStoryboardImagePromptWithReferences('当前镜头', [{ ...portrait, characterReferenceId: null }], context), /未绑定当前人物的普通画面参考/u);
});

test('direct image-to-image shares boundary framing and actual character mapping, preserving explicit images', () => {
  const bound = { ...portrait, characterReferenceId: b.id };
  const direct = buildDirectStoryboardImageBatchRequests(board,
    { mode: 'boundary-frames', referenceAssetIds: [bound.id, oldShot.id, free.id] },
    { ...context, assets: [bound, oldShot, free], includeReferenceMetadata: true });
  assert.equal(direct.length, 2);
  assert.deepEqual(direct[1].referenceAssetIds, [bound.id, oldShot.id, free.id]);
  assert.match(direct[1].directPrompt, /尾帧取景：按最后一镜结束时刻/u);
  assert.match(direct[1].directPrompt, /1\. "portrait" — 人物 "马雷"/u);
  assert.match(direct[1].directPrompt, /3\. "unbound" — 普通画面参考/u);
  assert.doesNotMatch(direct[1].directPrompt, /历史构图：|旧图锚点：/u);
});
