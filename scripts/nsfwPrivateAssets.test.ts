import assert from 'node:assert/strict';
import {
  canUseNsfwPrivateProfileAsset,
  canUseNsfwPrivateProfileAssetForStoryboardShot,
  filterNsfwPrivateProfileAssetsForShot,
  isNsfwPrivateProfileAsset,
  nsfwPrivatePartsInEvidence,
  nsfwPrivateProfilePartsForCharacter,
  nsfwPrivateReferenceResponsibility,
} from '../src/nsfwPrivateAssets';
import type { ReferenceAsset } from '../src/types';
import { availableVideoPrivateParts, selectedVideoPrivateFacts } from '../src/videoPrivateScope';

const asset = (patch: Partial<ReferenceAsset>): ReferenceAsset => ({
  id: 'asset',
  name: 'reference',
  type: 'character',
  role: 'character',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const ordinary = asset({ id: 'ordinary', sourceEntityId: 'a' });
const privateFullBody = asset({
  id: 'private-body',
  sourceEntityId: 'a',
  imageVariant: 'private-full-body',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'full-body',
});
const privateBreasts = asset({
  id: 'private-breasts',
  sourceEntityId: 'a',
  imageVariant: 'private-close-up',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'breasts',
});
const privateFourInOne = asset({
  id: 'private-four-in-one',
  sourceEntityId: 'a',
  imageVariant: 'private-four-in-one',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'full-body',
});
const otherCharacterPrivate = asset({
  id: 'other-private',
  sourceEntityId: 'b',
  imageVariant: 'private-close-up',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'vulva',
});
const otherCharacterBreasts = asset({
  ...privateBreasts,
  id: 'other-breasts',
  sourceEntityId: 'b',
});
const otherCharacterFullBody = asset({
  ...privateFullBody,
  id: 'other-full-body',
  sourceEntityId: 'b',
});

assert.equal(isNsfwPrivateProfileAsset(ordinary), false);
assert.equal(isNsfwPrivateProfileAsset(privateFullBody), true);
assert.deepEqual(nsfwPrivatePartsInEvidence('镜头明确表现胸部与乳头'), ['breasts']);
assert.deepEqual(nsfwPrivatePartsInEvidence('明确表现阴茎和阴囊'), ['penis', 'scrotum']);

assert.equal(canUseNsfwPrivateProfileAsset(privateFullBody, {
  evidence: '人物穿着完整外套站在门口。',
  characterIds: ['a'],
}), false, 'ordinary clothed shots must never receive a private profile image');
assert.equal(canUseNsfwPrivateProfileAsset(privateFourInOne, {
  evidence: '人物穿着完整外套站在门口。',
  characterIds: ['a'],
}), false, 'ordinary clothed shots must never receive a private four-in-one profile image');

assert.equal(canUseNsfwPrivateProfileAsset(privateFullBody, {
  evidence: '人物已经全裸。',
  state: { nudity: '全裸', clothingState: '衣物已放在床边' },
  characterIds: ['a'],
  visiblePrivatePartsByCharacter: { a: ['full-body'] },
}), true, 'a matching visible NSFW state may use the character full-body profile without an age gate');
assert.equal(canUseNsfwPrivateProfileAsset(privateFourInOne, {
  evidence: '镜头明确表现胸部和乳头。',
  state: { nudity: '上身裸露' },
  characterIds: ['a'],
}), false, 'one visible region must not route a multi-panel dossier containing unrelated private regions');

assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterPrivate, {
  evidence: '镜头明确表现外阴。',
  state: { nudity: '下身裸露' },
  characterIds: ['a'],
}), false, 'one performer must not inherit another performer private reference');

assert.equal(canUseNsfwPrivateProfileAsset(privateBreasts, {
  evidence: '人物已经全裸，但镜头只拍背部。',
  state: { nudity: '全裸' },
  characterIds: ['a'],
}), false, 'a private close-up is scoped to the explicitly involved body part');

assert.equal(canUseNsfwPrivateProfileAsset(privateBreasts, {
  evidence: '镜头明确表现胸部和乳头。',
  state: { nudity: '上身裸露' },
  characterIds: ['a'],
  visiblePrivatePartsByCharacter: { a: ['breasts'] },
}), true);

const twoPersonContext = {
  evidence: '阿莲隔着青竹的完整外套轻触胸部位置的衣料。',
  characterIds: ['a', 'b'],
  characterNamesById: { a: '阿莲', b: '青竹' },
};
assert.equal(
  canUseNsfwPrivateProfileAsset(privateBreasts, twoPersonContext),
  false,
  'a nearby anatomy mention owned by another named performer must not unlock A private image',
);
assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterBreasts, twoPersonContext), false);
assert.deepEqual(nsfwPrivateProfilePartsForCharacter(twoPersonContext, 'a'), []);
assert.deepEqual(nsfwPrivateProfilePartsForCharacter(twoPersonContext, 'b'), []);
const visibleRegionContext = {
  ...twoPersonContext,
  evidence: '镜头中青竹的胸部可见。',
  state: { nudity: '阿莲：完整着装；青竹：上身裸露' },
  visiblePrivatePartsByCharacter: { b: ['breasts'] as const },
};
assert.deepEqual(nsfwPrivateProfilePartsForCharacter(visibleRegionContext, 'a'), []);
assert.deepEqual(nsfwPrivateProfilePartsForCharacter(visibleRegionContext, 'b'), ['breasts']);
assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterBreasts, visibleRegionContext), true);
assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterFullBody, visibleRegionContext), false,
  'an upper-body state must not route a complete private-body reference');
for (const nudity of ['完整着装', '未全裸', '尚未上身裸露', 'NSFW']) {
  assert.deepEqual(nsfwPrivateProfilePartsForCharacter({
    evidence: '人物隔着外套碰到胸部位置的衣料。',
    state: { nudity },
    characterIds: ['a'],
  }, 'a'), [], 'only a known established visible state may contribute private-profile fields');
}
assert.equal(canUseNsfwPrivateProfileAsset(privateBreasts, {
  ...twoPersonContext,
  evidence: '她的胸部和乳头进入画面。',
}), false, 'ambiguous pronouns in a multi-person shot fail closed');
assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterBreasts, {
  ...twoPersonContext,
  evidence: '她的胸部和乳头进入画面。',
}), false, 'ambiguous anatomy cannot unlock either performer private image');

const splitNudityContext = {
  evidence: '阿莲穿着完整外套站在床边，青竹全裸，镜头明确表现阴茎。',
  characterIds: ['a', 'b'],
  characterNamesById: { a: '阿莲', b: '青竹' },
  state: { nudity: '阿莲：完整着装；青竹：全裸' },
  visiblePrivatePartsByCharacter: { b: ['full-body'] as const },
};
assert.equal(
  canUseNsfwPrivateProfileAsset(privateFullBody, splitNudityContext),
  false,
  'another performer nudity must not unlock a clothed performer full-body dossier',
);
assert.equal(canUseNsfwPrivateProfileAsset(otherCharacterFullBody, splitNudityContext), true);
assert.deepEqual(nsfwPrivateProfilePartsForCharacter(splitNudityContext, 'a'), []);
assert.ok(nsfwPrivateProfilePartsForCharacter(splitNudityContext, 'b').includes('full-body'));

assert.deepEqual(filterNsfwPrivateProfileAssetsForShot(
  [ordinary, privateFullBody, privateBreasts, otherCharacterPrivate],
  {
    evidence: '人物上身裸露，镜头明确表现胸部。',
    state: { nudity: '上身裸露' },
    characterIds: ['a'],
    visiblePrivatePartsByCharacter: { a: ['breasts'] },
  },
).map((item) => item.id), ['ordinary', 'private-breasts']);

const adultShot = {
  id: 'adult-shot', index: 1, startSec: 0, endSec: 5,
  purpose: '亲密特写镜头', subject: '阿莲', action: '阿莲上身裸露，镜头明确表现胸部和乳头。',
  camera: '', transition: '', lighting: '', sound: '', result: '', referenceAssetIds: [], prompt: '', locked: false,
  nsfwContinuity: { nudity: '上身裸露' },
  visiblePrivatePartsByCharacter: { a: ['breasts'] as ['breasts'] },
};
assert.equal(canUseNsfwPrivateProfileAssetForStoryboardShot(
  privateBreasts,
  { shots: [adultShot], sourceStoryContent: '阿莲上身裸露，镜头明确表现胸部和乳头。' },
  adultShot,
  [{ id: 'a', name: '阿莲' }],
), true);
assert.equal(canUseNsfwPrivateProfileAssetForStoryboardShot(
  privateBreasts,
  { shots: [adultShot], sourceStoryContent: '阿莲上身裸露，镜头明确表现胸部和乳头。' },
  adultShot,
  [{ id: 'a', name: '阿莲' }],
), true, 'age metadata is not part of private-reference routing');

const responsibility = nsfwPrivateReferenceResponsibility(privateFullBody);
assert.match(responsibility, /人物实际出镜.*部位明确呈现/u);
assert.match(responsibility, /当前衣物与裸露状态优先/u);
assert.doesNotMatch(responsibility, /(?:成人|18\+|年龄|不得|禁止|不要)/u);

const scopeCharacter = {
  id: 'scope-character', name: '镜头角色',
  nsfwProfile: { fullBody: 'WHOLE_DOSSIER_SENTINEL', breasts: 'SELECTED_FIELD_SENTINEL', vulva: 'UNSELECTED_FIELD_SENTINEL' },
};
const scopeSnapshot = JSON.stringify(scopeCharacter);
assert.deepEqual(availableVideoPrivateParts(scopeCharacter), ['full-body', 'breasts', 'vulva']);
assert.deepEqual(selectedVideoPrivateFacts([scopeCharacter], undefined), []);
assert.deepEqual(selectedVideoPrivateFacts([scopeCharacter], { other: ['full-body'] }), []);
assert.deepEqual(selectedVideoPrivateFacts([scopeCharacter], { [scopeCharacter.id]: ['breasts'] }), [{
  characterId: scopeCharacter.id, name: scopeCharacter.name,
  parts: ['breasts'], profile: { breasts: 'SELECTED_FIELD_SENTINEL' },
}]);
assert.equal(JSON.stringify(scopeCharacter), scopeSnapshot, 'selection must not change private records');
assert.deepEqual(nsfwPrivateProfilePartsForCharacter({
  evidence: '当前只拍脸部特写。', state: { nudity: '全裸' }, characterIds: ['a'],
}, 'a'), [], 'nudity state is not a current-shot visibility grant');

console.log('NSFW private asset routing tests passed.');
