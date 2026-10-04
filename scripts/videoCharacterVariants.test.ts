import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Character,
  ReferenceAsset,
  Scene,
  Storyboard,
} from '../src/types';
import {
  characterVariantBaseName,
  characterVariantDisplayName,
  characterVariantFormLabel,
  characterVariantMatches,
  normalizeCharacterVariantRecord,
} from '../src/characterVariants';
import { buildGlobalLock, buildShots, renderShotPrompt } from '../src/promptEngine';
import { buildOfficialH3SubjectDefinitions } from '../src/officialPrompt';
import { defaultConverterPresets, defaultRuleSets, defaultStylePresets } from '../src/storage';

const makeCharacter = (
  id: string,
  name: string,
  formLabel = '',
): Character => ({
  id,
  name,
  ...(formLabel ? {
    baseName: '泰罗',
    formLabel,
    variantOf: '泰罗',
    transformationType: 'gender',
  } : {}),
  gender: formLabel === '女性形态' ? '女' : '男',
  apparentAge: '青年',
  actualAge: '青年',
  height: '约178cm',
  race: '人类',
  appearance: formLabel === '女性形态' ? '女性面容、长发' : '男性面容、短发',
  outfit: '深色长袍',
  signatureProps: '',
  personality: '克制',
  motionHabits: '动作稳定',
  anchor: `${name}身份与外观保持稳定`,
  negativeContinuity: '',
  assetIds: [],
});

const makeAsset = (id: string, name: string, sourceEntityId: string): ReferenceAsset => ({
  id,
  name,
  type: 'reference',
  role: 'character',
  source: 'generated',
  sourceEntityId,
  sourceEntityKind: 'character',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
});

const makeScene = (content: string, characterIds: string[]): Scene => ({
  id: 'variant-scene',
  title: '形态转化场景',
  content,
  summary: content,
  characterIds,
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
});

test('variant records receive stable display names without splitting ordinary dotted names', () => {
  const female = normalizeCharacterVariantRecord({
    name: '泰罗', baseName: '泰罗', formLabel: '女性形态', variantOf: '泰罗',
    transformationType: 'gender',
  });
  assert.equal(female.name, '泰罗·女性形态');
  assert.equal(characterVariantDisplayName(female), '泰罗·女性形态');
  assert.equal(characterVariantBaseName(female), '泰罗');
  assert.equal(characterVariantFormLabel(female), '女性形态');
  assert.equal(characterVariantMatches(female, '泰罗·女性形态'), true);
  assert.equal(characterVariantMatches(female, '泰罗'), false);

  const ordinary = normalizeCharacterVariantRecord({ name: '哈利·波特' });
  assert.equal(ordinary.name, '哈利·波特');
  assert.equal(characterVariantFormLabel(ordinary), '');
  assert.equal(characterVariantBaseName(ordinary), '哈利·波特');
});

test('AI shot materialization binds each transformed form to its own character asset', () => {
  const original = makeCharacter('char-original', '泰罗·原始形态', '原始形态');
  const female = makeCharacter('char-female', '泰罗·女性形态', '女性形态');
  const originalAsset = makeAsset('asset-original', '泰罗·原始形态参考图', original.id);
  const femaleAsset = makeAsset('asset-female', '泰罗·女性形态参考图', female.id);
  const scene = makeScene(
    '泰罗·原始形态站在门前。泰罗·女性形态走入门内。',
    [original.id, female.id],
  );
  const shots = buildShots({
    scene,
    characters: [original, female],
    locations: [],
    props: [],
    assets: [originalAsset, femaleAsset],
    workflow: 'drama',
    durationSec: 10,
    shotMode: 'auto',
    shotCount: 2,
    pace: 'standard',
    camera: '稳定推进',
    lighting: '柔光',
    style: defaultStylePresets[0],
    extra: '',
    aiPlan: {
      shots: [
        {
          startSec: 0, endSec: 5, sourceExcerpt: '泰罗·原始形态站在门前。',
          purpose: '原始状态', subject: '泰罗·原始形态', action: '泰罗·原始形态站在门前。',
          camera: '中景', transition: '建立', lighting: '柔光', sound: '无', result: '保持原始形态',
        },
        {
          startSec: 5, endSec: 10, sourceExcerpt: '泰罗·女性形态走入门内。',
          purpose: '转化后状态', subject: '泰罗·女性形态', action: '泰罗·女性形态走入门内。',
          camera: '跟拍', transition: '门框切换', lighting: '柔光', sound: '脚步声', result: '女性形态进入',
        },
      ],
    },
  });
  assert.deepEqual(shots.map((shot) => shot.referenceAssetIds), [
    [originalAsset.id],
    [femaleAsset.id],
  ]);

  const femalePrompt = renderShotPrompt(
    shots[1], 5, [originalAsset, femaleAsset], shots, 'stereo', defaultRuleSets[0],
    { characters: [original, female] },
  );
  assert.match(femalePrompt, /主体：@泰罗·女性形态/u);
  assert.match(femalePrompt, /形态设定：女性形态/u);
  assert.match(femalePrompt, /同源人物：泰罗/u);
  assert.doesNotMatch(femalePrompt, /主体：@泰罗（/u);
});

test('global lock and H3 subject definitions do not leak the original form into a transformed shot', () => {
  const original = makeCharacter('char-original', '泰罗·原始形态', '原始形态');
  const female = makeCharacter('char-female', '泰罗·女性形态', '女性形态');
  const originalAsset = makeAsset('asset-original', '泰罗·原始形态参考图', original.id);
  const femaleAsset = makeAsset('asset-female', '泰罗·女性形态参考图', female.id);
  const scene = makeScene('泰罗·女性形态走入门内。', [female.id]);
  const lock = buildGlobalLock(scene, [original, female], [], [], [originalAsset, femaleAsset]);
  assert.match(lock, /泰罗·女性形态/u);
  assert.match(lock, /形态设定：女性形态/u);
  assert.doesNotMatch(lock, /固定人物：泰罗·原始形态/u);

  const board = {
    id: 'board-variant',
    finalPrompt: '【0s-5s】 主体：@泰罗·女性形态（形态设定：女性形态）正在走入门内',
    promptPlan: { canonicalPrompt: '主体：@泰罗·女性形态' },
    shots: [{
      id: 'shot-variant', index: 1, startSec: 0, endSec: 5,
      subject: '泰罗·女性形态', action: '泰罗·女性形态走入门内', camera: '中景',
      transition: '建立', lighting: '柔光', sound: '无', purpose: '转化后', result: '进入',
      referenceAssetIds: [femaleAsset.id], prompt: '', locked: false,
    }],
    globalReferenceAssetIds: [],
  } as unknown as Storyboard;
  const definitions = buildOfficialH3SubjectDefinitions(board, {
    assets: [originalAsset, femaleAsset],
    // Include a stale sibling id in the female card to ensure H3 binding uses
    // the explicit sourceEntityId instead of trusting a legacy assetIds list.
    characters: [original, { ...female, assetIds: [originalAsset.id, femaleAsset.id] }],
  });
  assert.deepEqual(definitions.map((definition) => definition.name), ['泰罗·女性形态']);
  assert.deepEqual(definitions[0].referenceAssetIds, [femaleAsset.id]);
  assert.equal(definitions[0].formLabel, '女性形态');
});
