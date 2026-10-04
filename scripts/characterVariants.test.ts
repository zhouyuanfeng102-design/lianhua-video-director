import assert from 'node:assert/strict';
import {
  canonicalCharacterVariantName,
  characterVariantAliases,
  characterVariantMatches,
  characterVariantPromptFacts,
  normalizeCharacterVariantRecord,
} from '../src/characterVariants';
import {
  FEMALE_CHARACTER_IMAGE_WORDING_RULE,
  FEMALE_CHARACTER_NEUTRAL_AGE_STAGE_RULE,
  normalizeFemaleCharacterVocabularyRecord,
} from '../src/characterVocabulary';
import {
  collectAuthoritativeStoryEntityNames,
  mergeCharacterEnrichmentDetails,
  reconcileAuthoritativeStoryEntities,
} from '../src/appEffects';
import { imageWorkbenchEntityToForm } from '../src/imageGeneration';
import type { Character } from '../src/types';

const base = (name: string, formLabel?: string): Character => ({
  id: `${name}-${formLabel || 'ordinary'}`,
  name,
  ...(formLabel ? {
    baseName: '泰罗',
    formLabel,
    variantOf: '泰罗',
    transformationType: formLabel.includes('女性') ? 'gender' : 'appearance',
  } : {}),
  gender: formLabel?.includes('女性') ? '女' : '男',
  apparentAge: '成年',
  actualAge: '成年',
  height: '约180cm',
  race: '人类',
  morphology: 'human-like',
  bodyPlan: '标准人形躯干，双臂双腿',
  appearance: formLabel ? `${formLabel}外貌` : '原始外貌',
  outfit: '固定服装',
  signatureProps: '',
  personality: '',
  motionHabits: '',
  anchor: '',
  negativeContinuity: '',
  assetIds: [],
});

assert.equal(canonicalCharacterVariantName('哈利·波特'), '哈利·波特', 'ordinary dotted names remain ordinary names');
const female = normalizeCharacterVariantRecord({
  name: '泰罗', baseName: '泰罗', formLabel: '女性形态', transformationType: 'gender',
});
assert.equal(female.name, '泰罗·女性形态');
assert.equal(female.baseName, '泰罗');
assert.equal(female.variantOf, '泰罗');
assert.equal(canonicalCharacterVariantName({ name: '泰罗（兽化形态）' }), '泰罗·兽化形态');
assert.equal(
  normalizeCharacterVariantRecord({ name: '泰罗', variant_of: '泰罗', variant: '兽化形态' } as any).name,
  '泰罗·兽化形态',
  'legacy alias fields still produce a concrete form name',
);

const legacySmallFemale = normalizeCharacterVariantRecord({
  name: '露娜·幼体形态',
  baseName: '露娜',
  formLabel: '幼体形态',
  variantOf: '露娜',
  transformationType: 'age-stage',
  gender: '女',
});
assert.equal(legacySmallFemale.name, '露娜·缩小状态');
assert.equal(legacySmallFemale.formLabel, '缩小状态');
assert.deepEqual(characterVariantPromptFacts(legacySmallFemale), [
  '形态设定：缩小状态',
  '同源人物：露娜',
  '转化类型：age-stage',
]);
const neutralFemale = normalizeFemaleCharacterVocabularyRecord({
  name: '露娜·幼体形态', gender: '女', apparentAge: '约十二岁', height: '约140cm',
  race: '人类少女', bodyPlan: '未完全发育的少女骨架，双臂双腿',
  appearance: '幼态脸型与女童身形，身体还没完全长开，来自《魔法少女小圆》',
  outfit: '少女款浅色连衣裙', anchor: '保持幼体形态',
});
assert.equal(neutralFemale.name, '露娜·缩小状态');
assert.equal(neutralFemale.apparentAge, '约十二岁', 'explicit age remains unchanged');
assert.equal(neutralFemale.height, '约140cm', 'explicit height remains unchanged');
assert.doesNotMatch(
  [neutralFemale.name, neutralFemale.race, neutralFemale.bodyPlan,
    neutralFemale.appearance.replace(/《[^》]+》/gu, ''), neutralFemale.outfit, neutralFemale.anchor].join(' '),
  /儿童|孩童|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年|未发育/u,
);
assert.match(neutralFemale.appearance, /《魔法少女小圆》/u, 'work titles remain exact identity evidence');
assert.match(neutralFemale.appearance, /体型较小/u);
const nonFemaleCreatureStage = normalizeCharacterVariantRecord({
  name: '幼龙·幼体形态', baseName: '幼龙', formLabel: '幼体形态', variantOf: '幼龙', gender: '雄性',
});
assert.equal(nonFemaleCreatureStage.name, '幼龙·幼体形态', 'non-female creature lifecycle labels stay intact');
assert.deepEqual(characterVariantPromptFacts(nonFemaleCreatureStage), [
  '形态设定：幼体形态',
  '同源人物：幼龙',
]);
const maleTitleReference = normalizeFemaleCharacterVocabularyRecord({
  gender: '男', appearance: '收藏《魔法少女小圆》画册，少年时期留下短发',
});
assert.equal(maleTitleReference.appearance, '收藏《魔法少女小圆》画册，少年时期留下短发');
assert.match(FEMALE_CHARACTER_NEUTRAL_AGE_STAGE_RULE, /年龄数字.*身高/u);
assert.doesNotMatch(FEMALE_CHARACTER_IMAGE_WORDING_RULE, /18\s*岁|年龄|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b/iu);

const femaleAliases = characterVariantAliases(female);
assert.ok(femaleAliases.includes('泰罗·女性形态'));
assert.ok(!femaleAliases.includes('泰罗'), 'a concrete form must not alias the bare base character');
assert.equal(characterVariantMatches(female, '泰罗·女性形态'), true);
assert.equal(characterVariantMatches(female, '泰罗'), false);
assert.ok(!characterVariantAliases({ name: '泰罗', baseName: '泰罗', formLabel: '女性形态' }).includes('泰罗'));
assert.deepEqual(characterVariantPromptFacts(female), [
  '形态设定：女性形态',
  '同源人物：泰罗',
  '转化类型：gender',
]);

const collected = collectAuthoritativeStoryEntityNames({
  characters: [
    { name: '泰罗', baseName: '泰罗', formLabel: '原始形态' },
    { name: '泰罗', baseName: '泰罗', formLabel: '女性形态', transformationType: 'gender' },
  ],
  scenes: [{
    characters: [
      { name: '泰罗', baseName: '泰罗', formLabel: '原始形态' },
      { name: '泰罗', baseName: '泰罗', formLabel: '女性形态' },
    ],
  }],
}, { characters: [], locations: [], props: [] });
assert.deepEqual(collected.characters, ['泰罗·原始形态', '泰罗·女性形态'], 'analysis keeps both forms as separate names');

const enriched = mergeCharacterEnrichmentDetails([
  { name: '泰罗', baseName: '泰罗', formLabel: '原始形态', gender: '男', appearance: '原始外貌' },
  { name: '泰罗', baseName: '泰罗', formLabel: '女性形态', gender: '女', appearance: '女性外貌' },
]);
assert.deepEqual([...enriched.keys()], ['泰罗·原始形态', '泰罗·女性形态']);
assert.equal(enriched.get('泰罗·女性形态')?.gender, '女');

const reconciled = reconcileAuthoritativeStoryEntities(
  [],
  [base('泰罗·原始形态', '原始形态'), base('泰罗·女性形态', '女性形态')],
  { aiSucceeded: true, kind: 'character' },
);
assert.deepEqual(reconciled.records.map((item) => item.name), ['泰罗·原始形态', '泰罗·女性形态']);
assert.equal(reconciled.records[0].gender, '男');
assert.equal(reconciled.records[1].gender, '女');
assert.equal(
  imageWorkbenchEntityToForm('character', reconciled.records[1]).name,
  '泰罗·女性形态',
  'image workbench keeps the decorated form name visible when a variant is selected',
);

// The AI distinguishes genuine transformation assets from scene-local injury
// states. The identity layer consumes that decision without inventing a form
// from words in appearance, motion or scene text.
const injuredMonster = {
  ...base('邪恶怪兽'),
  id: 'monster-existing',
  morphology: 'monster',
  race: '怪兽',
  bodyPlan: '双角巨兽，双臂双腿，一条尾巴',
  appearance: '肩部受伤，头角破损，血迹与灰尘尚未清理',
  motionHabits: '疲惫地跪地后起身',
  assetIds: ['monster-reference'],
};
const normalizedMonster = normalizeCharacterVariantRecord(injuredMonster);
assert.equal(normalizedMonster.name, '邪恶怪兽');
assert.equal(normalizedMonster.formLabel, undefined);
assert.deepEqual(characterVariantPromptFacts(normalizedMonster), []);
assert.deepEqual(characterVariantAliases(normalizedMonster), ['邪恶怪兽']);
const mixedEntityNames = collectAuthoritativeStoryEntityNames({
  characters: [
    { name: '泰罗', baseName: '泰罗', formLabel: '原始形态' },
    { name: '泰罗', baseName: '泰罗', formLabel: '女性形态', transformationType: 'gender' },
    { name: '邪恶怪兽' },
  ],
  scenes: [
    { characters: ['泰罗·原始形态', '邪恶怪兽'] },
    { characters: ['泰罗·女性形态', '邪恶怪兽'] },
  ],
}, { characters: [], locations: [], props: [] });
assert.deepEqual(mixedEntityNames.characters, ['泰罗·原始形态', '泰罗·女性形态', '邪恶怪兽'],
  'a wounded opponent remains one identity alongside two genuine protagonist forms');

const obsoleteInjuryVariant: Character = {
  ...injuredMonster,
  id: 'monster-old-auto-injury',
  name: '邪恶怪兽·受伤形态',
  baseName: '邪恶怪兽',
  variantOf: '邪恶怪兽',
  formLabel: '受伤形态',
  assetIds: [],
};
const reparsed = reconcileAuthoritativeStoryEntities(
  [...reconciled.records, injuredMonster, obsoleteInjuryVariant],
  [...reconciled.records, { ...injuredMonster, id: 'monster-new-analysis', assetIds: [] }],
  { aiSucceeded: true, kind: 'character', previousSceneEntityIds: [obsoleteInjuryVariant.id] },
);
assert.deepEqual(reparsed.records.map((item) => item.name), mixedEntityNames.characters);
assert.deepEqual(reparsed.removedIds, [obsoleteInjuryVariant.id],
  'a corrected AI reparse may retire an unbound automatic record through existing reconciliation');
const retainedMonster = reparsed.records.find((item) => item.name === '邪恶怪兽')!;
assert.equal(retainedMonster.id, injuredMonster.id);
assert.deepEqual(retainedMonster.assetIds, injuredMonster.assetIds);
assert.equal(imageWorkbenchEntityToForm('character', retainedMonster).name, '邪恶怪兽');
const protectedReparse = reconcileAuthoritativeStoryEntities(
  [{ ...obsoleteInjuryVariant, assetIds: ['user-selected-reference'] }],
  [injuredMonster],
  { aiSucceeded: true, kind: 'character', previousSceneEntityIds: [obsoleteInjuryVariant.id] },
);
assert.deepEqual(protectedReparse.removedIds, [], 'reparsing never silently deletes a record with reference assets');

console.log('character variant tests passed');
