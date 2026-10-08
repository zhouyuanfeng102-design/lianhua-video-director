import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStoryboardImagePromptWithReferences, hasStoryboardImageReferenceMetadata,
  refreshStoryboardImageReferenceMetadata, stripStoryboardImageReferenceMetadata,
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
  const refreshed = refreshStoryboardImageReferenceMetadata(built, [replacement], context);
  assert.equal(stripStoryboardImageReferenceMetadata(refreshed), body);
  assert.match(refreshed, /1\. "replacement" — 人物 "绝死绝命"/u);
  assert.doesNotMatch(refreshed, /"original"/u);
  assert.equal(refreshStoryboardImageReferenceMetadata(refreshed, [], context), body);
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
