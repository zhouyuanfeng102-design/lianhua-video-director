import assert from 'node:assert/strict';
import {
  getMorphologyPromptLocks,
  hasHumanMorphologyConflict,
  inferCharacterMorphology,
  isHumanLikeMorphology,
  isNonHumanMorphology,
  repairCharacterMorphologyText,
  resolveCharacterMorphology,
} from '../src/characterMorphology';

const resolved = (input: Parameters<typeof resolveCharacterMorphology>[0]) => resolveCharacterMorphology(input);

// Clear species/body-plan signals choose a concrete non-human branch.
assert.equal(resolved({ race: '六足甲壳巨兽', appearance: '昆虫口器、分节甲壳' }).kind, 'monster');
assert.equal(resolved({ race: '四足灵兽', appearance: '狼形，长尾' }).kind, 'animal');
assert.equal(resolved({ race: '菌丝孢子生命', appearance: '菌丝网络和孢子囊' }).kind, 'plant-fungal');
assert.equal(resolved({ race: '无定形能量体', appearance: '流体边界，发光核心' }).kind, 'object-energy');
assert.equal(resolved({ race: '非人型巨型怪兽', appearance: '甲壳、触肢与复眼' }).kind, 'monster');

// Explicitly human-like and explicitly mixed forms remain distinct.
assert.equal(resolved({ morphology: 'human-like', race: '人类', appearance: '短发、标准人形' }).family, 'human-like');
assert.equal(resolved({ race: '人族修仙者', anchor: '黑发马尾、玄色长袍' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '猫眼妆、虎牙、鱼尾纹' }).kind, 'human-like');
assert.equal(resolved({ race: '狼头人', bodyPlan: '狼头、兽毛、双足直立的人形躯干' }).kind, 'anthropomorphic');
// Species words used as metaphors describe temperament, not anatomy.
assert.equal(resolved({ race: '人类', appearance: '怪物般的气势' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '恶魔般威严' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '恶魔般的面容' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '狼一样的眼神' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '非人类般的气势' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '像非人类一样的威严' }).kind, 'human-like');
assert.equal(resolved({ race: '人类', appearance: '狼形头部、兽爪' }).family, 'nonhuman');
assert.equal(resolved({ race: '人类', appearance: '狼一样的耳朵' }).family, 'nonhuman');
// Broad fantasy clan labels are non-human hints, but remain conservative
// until concrete anatomy establishes animal/monster/anthropomorphic form.
for (const race of [
  '龙族', '魔族', '妖族', '兽族', '虫族', '鬼族', '异族',
  '羽族', '海族', '蛇族', '狐族', '鲛族', '蛟族', '龙裔', '魔裔',
  '妖裔', '妖兽', '神兽', '凶兽', '星兽', '虫群', '石像鬼',
]) {
  const clan = resolved({ race });
  assert.equal(clan.kind, 'unknown');
  assert.equal(clan.family, 'nonhuman');
  assert.equal(clan.nonhumanHint, true);
}
assert.equal(resolved({ morphology: '非人类拟人角色' }).kind, 'anthropomorphic');
assert.equal(resolved({ morphology: 'anthropomorphic nonhuman' }).kind, 'anthropomorphic');
assert.equal(
  resolved({ race: '龙族', appearance: '白皙皮肤、黑发、标准人类脸型、双手双脚' }).family,
  'nonhuman',
  'a non-human race label must not be downgraded by incidental human appearance wording',
);
assert.equal(
  resolved({ race: '龙族', appearance: '白皙皮肤、黑发、标准人类脸型、双手双脚' }).kind,
  'unknown',
  'a broad non-human race remains conservative until its body plan is known',
);
const explicitUnknownClan = resolved({ morphology: 'unknown', race: '龙族' });
assert.equal(explicitUnknownClan.kind, 'unknown');
assert.equal(explicitUnknownClan.family, 'nonhuman');
assert.equal(explicitUnknownClan.nonhumanHint, true);
assert.equal(isHumanLikeMorphology(resolved({ morphology: 'human-like' })), true);
assert.equal(isNonHumanMorphology(resolved({ morphology: 'monster' })), true);

// A clan label alone is ambiguous; it must not silently become a quadruped.
const clan = resolved({ race: '狼族' });
assert.equal(clan.kind, 'unknown');
assert.equal(clan.family, 'nonhuman');
assert.equal(resolved({ race: '狼族', bodyPlan: '四足、狼形头部、长尾' }).kind, 'animal');
assert.equal(resolved({ race: '狼' }).kind, 'animal');

// Negated human words do not promote a creature to a human template.
const negated = resolved({
  race: '未知生物',
  bodyPlan: '六足甲壳，禁止人形、禁止人类脸和手掌',
  negativeContinuity: '不得出现人类头部、发型或双足人体比例',
});
assert.equal(negated.family, 'nonhuman');
assert.equal(hasHumanMorphologyConflict(negated, '无脸型、无手掌、无双足人体结构'), false);
assert.equal(hasHumanMorphologyConflict(negated, '黑色短发、白皙皮肤、双手双脚'), true);
assert.equal(
  hasHumanMorphologyConflict(negated, '禁止人类脸型，随后保留人类脸型与五指手掌'),
  true,
  'a later positive anatomy clause must not be hidden by an earlier negated match',
);

// A single generic visual word is not enough to reject an animal; two human
// anatomy groups (or an explicit human-face phrase) are required.
const animal = resolved({ race: '四足灵兽', bodyPlan: '四足、兽爪、皮毛' });
assert.equal(hasHumanMorphologyConflict(animal, '明亮眼睛、湿润皮肤'), false);
assert.equal(hasHumanMorphologyConflict(animal, '人类脸型、五指手掌'), true);
assert.equal(hasHumanMorphologyConflict(animal, '中年母性面容、黑色短发、白皙皮肤'), true);
assert.equal(hasHumanMorphologyConflict(animal, '雌性面容'), true);
assert.equal(hasHumanMorphologyConflict(animal, '禁止中年母性面容'), false);

const locks = getMorphologyPromptLocks(animal);
assert.match(locks.positiveText, /真实动物/u);
assert.match(locks.negativeText, /人类头部/u);
assert.equal(locks.positiveLocks, locks.positiveText);
assert.deepEqual(locks.positiveClauses, locks.positive);

const repaired = repairCharacterMorphologyText('黑色短发、白皙皮肤、双手双脚的六足巨兽', animal);
assert.match(repaired, /物种结构修正/u);
assert.match(repaired, /禁止/u);

assert.equal(inferCharacterMorphology('狼头人，双足直立'), 'anthropomorphic');
assert.equal(inferCharacterMorphology('未知生物，禁止人形'), 'unknown');

console.log('character morphology tests passed');
