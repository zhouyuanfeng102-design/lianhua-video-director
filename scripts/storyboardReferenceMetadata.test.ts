import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStoryboardImagePromptWithReferences, hasStoryboardImageReferenceMetadata,
  refreshStoryboardImageReferenceMetadata, stripStoryboardImageReferenceMetadata,
  STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY,
} from '../src/storyboardImageReferences';
import { buildDirectStoryboardImagePromptWithReferences } from '../src/storyboardImageToImage';
import { assertValidFinalImagePrompt } from '../src/imagePromptRules';
import type { Character, ReferenceAsset } from '../src/types';

const actor: Character = {
  id: 'actor', name: '绝死绝命', gender: '女', apparentAge: '成年', race: '半精灵', appearance: '黑白长发', outfit: '银色护甲',
  personality: '', motionHabits: '', signatureProps: '', anchor: '', negativeContinuity: '', assetIds: [],
};
const asset = (id: string): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'character',
  characterReferenceId: actor.id, tags: [], createdAt: 1, updatedAt: 1 });
const first = asset('original');
const replacement = asset('replacement');
const context = { characters: [actor] };
const body = '绝死绝命侧脸朝向马雷，眼神锁定马雷下盘。\n结尾仅拍战靴，人物脸部在画外。';

test('build and direct OpenAI metadata are idempotent and stripping keeps authored body exactly', () => {
  const built = buildStoryboardImagePromptWithReferences(body, [first], context);
  assert.equal(buildStoryboardImagePromptWithReferences(built, [first], context), built);
  assert.equal(stripStoryboardImageReferenceMetadata(built), body);
  assert.equal(hasStoryboardImageReferenceMetadata(built), true);
  const direct = buildDirectStoryboardImagePromptWithReferences(body, [first], context, true);
  assert.equal(buildDirectStoryboardImagePromptWithReferences(direct, [first], context, true), direct);
});

test('refresh changes only application-owned reference metadata and can remove all image slots', () => {
  const built = buildStoryboardImagePromptWithReferences(body, [first], context);
  const refreshed = refreshStoryboardImageReferenceMetadata(built, [{ ...replacement, characterReferenceId: null }], context);
  assert.equal(stripStoryboardImageReferenceMetadata(refreshed), body);
  assert.match(refreshed, /1\. "replacement" — 未绑定当前人物的普通画面参考/u);
  assert.notEqual(refreshed, built);
  assert.doesNotMatch(refreshed, /"original"/u);
  assert.equal(refreshStoryboardImageReferenceMetadata(refreshed, [], context), body);
});

test('three character references keep actual ordered bindings and one shared identity-pose boundary', () => {
  const actors = ['夏提雅', '新贝•里尤洛', '亚乌拉'].map((name, index) => ({ ...actor, id: `actor-${index}`, name }));
  const images = actors.map((character, index) => ({ ...asset(`image-${index}`), name: character.name,
    characterReferenceId: character.id }));
  const prompt = buildStoryboardImagePromptWithReferences('双方在沙地相互注视。', [images[1], images[0], images[2]], { characters: actors });
  const metadata = prompt.slice(prompt.indexOf('【莲华程序参考用途 v1 开始】'));
  assert.match(metadata, /1\. 人物 "新贝•里尤洛" — 身份、外貌与服装设计参考\n2\. 人物 "夏提雅" — 身份、外貌与服装设计参考\n3\. 人物 "亚乌拉" — 身份、外貌与服装设计参考/u);
  for (const character of actors) assert.equal(metadata.split(character.name).length - 1, 1, 'bound character names do not repeat asset labels');
  assert.equal(metadata.split(STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY).length - 1, 1,
    'multiple character references share one identity-only pose boundary');
  assert.match(metadata, /参考仅用于上述用途；动作、站位与构图以正文为准。/u);
  assert.doesNotMatch(metadata, /门|柱|室内|场景和道具|Subject|Picture|合照|精确米数/u);
});

test('pose inheritance boundary follows actual character identity use, not a reference filename or historical role', () => {
  const cases: { name: string; image: ReferenceAsset; identity: boolean }[] = [
    { name: 'current entity binding', image: { ...first, referenceEntityBinding: { kind: 'character', entityId: actor.id } }, identity: true },
    { name: 'legacy current character binding', image: first, identity: true },
    { name: 'legacy unspecified character identity', image: { ...first, characterReferenceId: undefined }, identity: true },
    { name: 'cleared entity binding', image: { ...first, referenceEntityBinding: null }, identity: false },
    { name: 'stale entity binding', image: { ...first, referenceEntityBinding: { kind: 'character', entityId: 'missing' } }, identity: false },
    { name: 'cleared character binding', image: { ...first, characterReferenceId: null }, identity: false },
    { name: 'stale character binding', image: { ...first, characterReferenceId: 'missing' }, identity: false },
    { name: 'explicit composition', image: { ...first, role: 'composition', characterReferenceId: undefined, name: '构图与首尾姿态参考' }, identity: false },
    { name: 'prop appearance', image: { ...first, role: 'prop', characterReferenceId: undefined }, identity: false },
  ];
  for (const fixture of cases) {
    const prompt = buildStoryboardImagePromptWithReferences(body, [fixture.image], context);
    assert.equal(prompt.includes(STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY), fixture.identity, fixture.name);
    assert.equal(stripStoryboardImageReferenceMetadata(prompt), body, `${fixture.name} preserves authored gaze and crop`);
  }
  const continuityOnly = buildStoryboardImagePromptWithReferences(body, [first], { ...context, continuityAssetId: first.id });
  assert.equal(continuityOnly.includes(STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY), false,
    'an appearance-continuity first image is not relabeled as a character identity reference');
  assert.match(continuityOnly, /本批已成功首图 — 仅作人物外观、场景外观与光线连续参考/u);
  const mixed = buildStoryboardImagePromptWithReferences(body, [first, replacement], { ...context, continuityAssetId: first.id });
  assert.equal(mixed.split(STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY).length - 1, 1);
  assert.match(mixed, /1\. 本批已成功首图[\s\S]*2\. 人物 "绝死绝命" — 身份、外貌与服装设计参考/u);
});

test('current character bindings override provenance while cleared and stale bindings retain unbound uses', () => {
  const other = { ...actor, id: 'other', name: '马雷' };
  const original = { ...first, name: '旧角色原图', sourceEntityKind: 'character' as const, sourceEntityId: actor.id };
  const refs = [
    { ...original, characterReferenceId: other.id },
    { ...original, characterReferenceId: null },
    { ...original, characterReferenceId: 'missing' },
    { ...original, id: 'free', name: '未归属构图', role: 'composition' as const,
      characterReferenceId: undefined, sourceEntityKind: undefined, sourceEntityId: undefined },
  ];
  const prompt = buildStoryboardImagePromptWithReferences('当前画面。', refs, { characters: [actor, other] });
  assert.match(prompt, /1\. 人物 "马雷" — 身份、外貌与服装设计参考/u);
  assert.match(prompt, /2\. "旧角色原图" — 未绑定当前人物的普通画面参考，由本镜画面决定用途/u);
  assert.match(prompt, /3\. "旧角色原图" — 未绑定当前人物的普通画面参考，由本镜画面决定用途/u);
  assert.match(prompt, /4\. "未归属构图" — 普通画面参考，由本镜画面决定用途/u);
  assert.doesNotMatch(prompt, /人物 "绝死绝命"/u);
});

test('refresh recognizes old long v1 blocks and replaces only their application-owned text', () => {
  const authored = `  ${body}\n作者保留的柱廊描述。  `;
  const legacy = [authored, '', '【莲华程序参考用途 v1 开始】', '本次实际上传图片（严格按此顺序）：',
    '1. "旧资产名" — 人物 "绝死绝命" 的身份、外貌与服装设计参考',
    '人物参考只保持对应身份、外貌和服装设计；本镜当前衣着状态、姿态、身体朝向、视线对象、世界位置、真实距离、机位、景别和裁切以以上画面描述为准。不要复制参考图中朝向观众的头部、正脸展示、临时持物、动作或背景，也不把参考图的合照间距当成本镜间距；允许侧脸、背面和局部特写，未入画的脸与身体不必补全。',
    '场景和道具参考只保持相关外观，不带入历史动作与人物站位，不覆盖本镜已确认的距离端点、地标内外关系、可通行路径及动作起始所需空间。参考图中的门、柱列和透视只提供当前职责下的外观依据，没有可靠比例尺不推定精确米数；不得为贴近参考构图将室内远处人物搬到门口。上传顺序不代表人物左右站位；原视频 Subject/Picture 编号不是本次图片编号。',
    '【莲华程序参考用途 v1 结束】'].join('\n');
  assert.equal(stripStoryboardImageReferenceMetadata(legacy), authored);
  const refreshed = refreshStoryboardImageReferenceMetadata(legacy, [replacement], context);
  assert.equal(stripStoryboardImageReferenceMetadata(refreshed), authored);
  assert.equal(refreshed, buildStoryboardImagePromptWithReferences(authored, [replacement], context));
  assert.doesNotMatch(refreshed, /旧资产名|不要复制参考图中朝向观众的头部|参考图中的门、柱列/u);
  assert.equal(refreshed.split(STORYBOARD_CHARACTER_REFERENCE_POSE_BOUNDARY).length - 1, 1);
});

test('natural-language protocol cleaning preserves recognizable complete metadata and exact cleaned body', () => {
  const built = buildStoryboardImagePromptWithReferences(body, [first], context);
  const cleaned = assertValidFinalImagePrompt(built, 'natural-language');
  assert.equal(hasStoryboardImageReferenceMetadata(cleaned), true);
  assert.equal(stripStoryboardImageReferenceMetadata(cleaned), assertValidFinalImagePrompt(body, 'natural-language'));
  const refreshed = refreshStoryboardImageReferenceMetadata(cleaned, [replacement], context);
  assert.equal(stripStoryboardImageReferenceMetadata(refreshed), assertValidFinalImagePrompt(body, 'natural-language'));
  assert.equal((refreshed.match(/【莲华程序参考用途 v1 开始】/gu) || []).length, 1);
});

test('legacy, incomplete, misplaced and authored marker mentions remain byte-for-byte', () => {
  const examples = [
    `  ${body}\n本次实际上传图片（严格按此顺序）：旧软件文字  `,
    `${body}\n【莲华程序参考用途 v1 开始】\n本次实际上传图片（严格按此顺序）：未完成`,
    `${body}\n【莲华程序参考用途 v1 开始】\n普通剧情文字\n【莲华程序参考用途 v1 结束】`,
    `${body}\n【莲华程序参考用途 v2 开始】\n本次实际上传图片（严格按此顺序）：未知版本\n【莲华程序参考用途 v2 结束】`,
    '【莲华程序参考用途 v1 开始】这只是字面文字【莲华程序参考用途 v1 结束】',
    `${buildStoryboardImagePromptWithReferences(body, [first], context)}\n作者追加的剧情文本`,
  ];
  for (const original of examples) {
    assert.equal(hasStoryboardImageReferenceMetadata(original), false);
    assert.equal(stripStoryboardImageReferenceMetadata(original), original);
    assert.equal(refreshStoryboardImageReferenceMetadata(original, [replacement], context), original);
  }
});

test('direct paths without explicit OpenAI-natural-language opt-in keep legacy upload labels without new mapping metadata', () => {
  const legacyDirect = buildDirectStoryboardImagePromptWithReferences(body, [first], context);
  assert.equal(hasStoryboardImageReferenceMetadata(legacyDirect), false);
  assert.match(legacyDirect, /1\. "original" — 人物身份与外貌/u);
  assert.ok(legacyDirect.endsWith(body));
});
