import assert from 'node:assert/strict';
import {
  checkStoryboardContinuity,
  inferNsfwClothingTransitionKind,
  inferNsfwShotContinuityState,
  resolveNsfwShotContinuityBoundaries,
  resolveNsfwShotContinuityStates,
} from '../src/continuity';
import {
  buildGlobalLock,
  renderFinalPrompt,
} from '../src/promptEngine';
import { compileTargetPrompt } from '../src/promptAdapters';
import { buildStoryboardImageRequests } from '../src/storyboardImages';
import {
  deriveSourceGroundedNsfwBodyAnchors,
  reconcileAuthoritativeStoryEntities,
} from '../src/appEffects';
import {
  createInitialState,
  normalizeState,
} from '../src/storage';
import type {
  Character,
  ConverterPreset,
  RuleSet,
  Scene,
  Storyboard,
  StylePreset,
  VideoShot,
} from '../src/types';
import { DEFAULT_FIRST_PERSON_SUBJECT } from '../src/semanticEvents';

const character: Character = {
  id: 'character-linlan',
  name: '林岚',
  gender: '女',
  apparentAge: '',
  race: '人类',
  appearance: '黑色长发，肩背有一颗小痣',
  outfit: '红色长裙、黑色短靴',
  signatureProps: '',
  personality: '沉静',
  motionHabits: '',
  anchor: '黑色长发与肩背小痣保持一致',
  negativeContinuity: '',
  assetIds: [],
  nsfwBodyAnchors: {
    stableTraits: ['肩背小痣的位置与形状', '腰侧浅色疤痕'],
    sourceEvidence: '人物资料原文明示',
  },
};

const sourceDerivedCharacter: Character = {
  ...character,
  id: 'character-source-derived',
  appearance: '黑色长发、灰色眼睛',
  anchor: '黑色长发与灰色眼睛保持一致',
  nsfwBodyAnchors: undefined,
};
const sourceDerivedAnchors = deriveSourceGroundedNsfwBodyAnchors(
  sourceDerivedCharacter,
  '林岚的乳晕浅粉色，林岚腰侧有一颗小痣，林岚疤痕呈月牙形。她随后走到窗前。',
);
assert.match(sourceDerivedAnchors?.stableTraits.join('、') || '', /乳晕浅粉色/u);
assert.match(sourceDerivedAnchors?.stableTraits.join('、') || '', /腰侧有一颗小痣/u);
assert.match(sourceDerivedAnchors?.stableTraits.join('、') || '', /疤痕呈月牙形/u);
assert.equal(sourceDerivedAnchors?.sourceEvidence, '剧情原文明示');
const analyzedCharacter = reconcileAuthoritativeStoryEntities(
  [],
  [sourceDerivedCharacter],
  {
    aiSucceeded: true,
    kind: 'character',
    sourceText: '林岚的乳晕浅粉色，林岚腰侧有一颗小痣，林岚疤痕呈月牙形。她随后走到窗前。',
  },
).records[0] as Character;
assert.deepEqual(
  analyzedCharacter.nsfwBodyAnchors,
  sourceDerivedAnchors,
  'story analysis reconciliation must create the source-grounded persistent anchor',
);
const returnedDetailCharacter = reconcileAuthoritativeStoryEntities(
  [],
  [{
    ...sourceDerivedCharacter,
    id: 'character-returned-detail',
    appearance: '黑色长发；乳头颜色为浅粉，边缘轮廓清晰',
  }],
  { aiSucceeded: true, kind: 'character' },
).records[0] as Character;
assert.match(
  returnedDetailCharacter.nsfwBodyAnchors?.stableTraits.join('、') || '',
  /乳头颜色为浅粉/u,
  'an explicit stable fact returned by analysis must also create the anchor',
);
const ordinaryCharacter = reconcileAuthoritativeStoryEntities(
  [],
  [{
    ...sourceDerivedCharacter,
    id: 'character-ordinary',
    appearance: '黑色长发、灰色眼睛、身形修长',
  }],
  {
    aiSucceeded: true,
    kind: 'character',
    sourceText: '林岚穿着红色长裙走到窗前。',
  },
).records[0] as Character;
assert.equal(
  ordinaryCharacter.nsfwBodyAnchors,
  undefined,
  'ordinary source and appearance data must not create a private body profile',
);
const firstPersonCharacter: Character = {
  ...sourceDerivedCharacter,
  id: 'character-first-person',
  name: DEFAULT_FIRST_PERSON_SUBJECT,
};
const firstPersonAnchors = deriveSourceGroundedNsfwBodyAnchors(
  firstPersonCharacter,
  '我腰侧有一颗小痣，我的乳晕淡粉色。守卫随后看向窗外。',
);
assert.match(firstPersonAnchors?.stableTraits.join('、') || '', /腰侧有一颗小痣/u);
assert.match(firstPersonAnchors?.stableTraits.join('、') || '', /乳晕淡粉色/u);
assert.equal(
  deriveSourceGroundedNsfwBodyAnchors(
    firstPersonCharacter,
    '守卫看着我，他的乳头呈深褐色。',
  ),
  undefined,
  'a first-person object must not steal another character body fact',
);
const namedWithoutImplicitContinuation = deriveSourceGroundedNsfwBodyAnchors(
  sourceDerivedCharacter,
  '林岚的乳晕浅粉色。腰侧有一颗小痣。',
);
assert.doesNotMatch(
  namedWithoutImplicitContinuation?.stableTraits.join('、') || '',
  /腰侧有一颗小痣/u,
  'an implicit-subject follow-up must not be guessed onto a named character',
);
assert.equal(
  deriveSourceGroundedNsfwBodyAnchors(
    sourceDerivedCharacter,
    '林岚全裸站立，乳头湿润，皮肤留有体液，随后与对方接触。',
  ),
  undefined,
  'temporary nudity, moisture, residue, and contact must never become stable body anchors',
);
const otherCharacter: Character = {
  ...sourceDerivedCharacter,
  id: 'character-yeqingbi',
  name: '叶清碧',
};
const dualCharacterAnchors = reconcileAuthoritativeStoryEntities(
  [],
  [sourceDerivedCharacter, otherCharacter],
  {
    aiSucceeded: true,
    kind: 'character',
    sourceText: '林岚看见叶清碧的乳晕浅粉色。林岚与叶清碧乳晕颜色相近。',
  },
).records as Character[];
assert.equal(
  dualCharacterAnchors.find((item) => item.name === '林岚')?.nsfwBodyAnchors,
  undefined,
  'an observer must not receive the observed character body fact',
);
assert.match(
  dualCharacterAnchors.find((item) => item.name === '叶清碧')?.nsfwBodyAnchors?.stableTraits.join('、') || '',
  /叶清碧的乳晕浅粉色/u,
  'a directly possessed fact must attach only to its named character',
);
assert.doesNotMatch(
  dualCharacterAnchors.find((item) => item.name === '叶清碧')?.nsfwBodyAnchors?.stableTraits.join('、') || '',
  /颜色相近/u,
  'a multi-name ambiguous comparison must not create a stable anchor',
);

const scene: Scene = {
  id: 'scene-clothing-state',
  title: '卧室',
  content: '林岚脱下红色长裙和黑色短靴后全裸站在窗前，脱下的衣物留在床沿。',
  summary: '林岚脱衣后走到窗前。',
  characterIds: [character.id],
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
};

const shot = (index: number, action: string, result: string): VideoShot => ({
  id: `shot-${index}`,
  index,
  startSec: (index - 1) * 3,
  endSec: index * 3,
  purpose: '承接当前身体和衣物状态',
  subject: '林岚',
  action,
  camera: '稳定中景',
  transition: '动作连续衔接',
  lighting: '暖色侧光',
  sound: '',
  result,
  referenceAssetIds: [],
  prompt: '',
  locked: false,
});

const shots = [
  shot(1, '林岚脱下红色长裙和黑色短靴，全裸站起', '红色长裙和黑色短靴留在床沿，林岚保持全裸'),
  shot(2, '林岚从床边走到窗前', '林岚背对床沿停在窗前'),
];

const states = resolveNsfwShotContinuityStates(shots);
assert.equal(states[0]?.nudity, '全裸');
assert.equal(states[1]?.nudity, '全裸', 'an established nude state must carry into the next shot');
assert.match(states[1]?.clothingState || '', /红色长裙/u);
assert.match(states[1]?.clothingState || '', /离身道具/u);
const boundaries = resolveNsfwShotContinuityBoundaries(shots);
assert.match(
  boundaries[0]?.entry?.clothingState || '',
  /红色长裙和黑色短靴.*仍穿在身上/u,
  'a removal shot must begin with the garment still worn',
);
assert.equal(boundaries[0]?.end?.nudity, '全裸');
assert.match(boundaries[0]?.end?.clothingState || '', /离身道具.*床沿/u);
assert.equal(boundaries[1]?.entry?.nudity, '全裸');
assert.equal(boundaries[1]?.end?.nudity, '全裸');

const objectFirstRemovalShots = [
  shot(1, '林岚把红色长裙和黑色短靴脱下后全裸站起', '红色长裙和黑色短靴落在床沿'),
  shot(2, '林岚从床沿走到窗前', '林岚停在窗前'),
];
const objectFirstBoundaries = resolveNsfwShotContinuityBoundaries(objectFirstRemovalShots);
assert.match(
  objectFirstBoundaries[0]?.entry?.clothingState || '',
  /红色长裙和黑色短靴.*仍穿在身上/u,
  'object-first removal must recover the garment before the verb for the entry frame',
);
assert.match(objectFirstBoundaries[0]?.end?.clothingState || '', /红色长裙和黑色短靴.*离身道具.*床沿/u);
assert.doesNotMatch(
  objectFirstBoundaries[0]?.end?.clothingState || '',
  /后全裸.*已脱下/u,
  'text after an object-first removal verb must never become a fake garment name',
);
assert.match(objectFirstBoundaries[1]?.entry?.clothingState || '', /红色长裙和黑色短靴.*离身道具/u);

const layeredRemoval = inferNsfwShotContinuityState(
  shot(1, '林岚脱下白色上衣，仍穿着黑色内裤', '白色上衣搭在椅背，黑色内裤仍穿在身上'),
);
assert.notEqual(layeredRemoval?.nudity, '完整着装', 'removing an outer layer cannot resolve to fully dressed');
assert.match(layeredRemoval?.clothingState || '', /白色上衣.*离身道具.*椅背/u);
assert.match(layeredRemoval?.clothingState || '', /黑色内裤穿在身上/u);

const notCompletedRemovalCases = [
  '林岚尚未脱下红色长裙，仍穿着红色长裙',
  '林岚准备脱下红色长裙，仍穿着红色长裙',
  '林岚拒绝把红色长裙脱下，仍穿着红色长裙',
  '禁止全裸画面，林岚仍穿着红色长裙',
] as const;
notCompletedRemovalCases.forEach((action, index) => {
  const candidate = shot(index + 1, action, '红色长裙保持穿在身上');
  const observed = inferNsfwShotContinuityState(candidate);
  assert.equal(inferNsfwClothingTransitionKind(candidate), undefined, `${action} must not be a completed removal`);
  assert.equal(observed?.nudity, '完整着装');
  assert.match(observed?.clothingState || '', /红色长裙穿在身上/u);
  assert.doesNotMatch(observed?.clothingState || '', /离身道具/u);
});

const objectFirstRedress = inferNsfwShotContinuityState(
  shot(1, '林岚把红色长裙穿回身上', '红色长裙已经穿好'),
);
assert.equal(objectFirstRedress?.nudity, '完整着装');
assert.match(objectFirstRedress?.clothingState || '', /红色长裙.*重新穿在身上/u);

const characterScopedClothingShots: VideoShot[] = [
  {
    ...shot(1, '林岚穿着红色长裙站在镜前', '红色长裙仍穿在林岚身上'),
    id: 'scoped-clothing-1',
    nsfwContinuity: {
      nudity: '完整着装',
      clothingState: '红色长裙穿在林岚身上',
    },
  },
  {
    ...shot(2, '林岚脱下红色长裙后全裸站立', '红色长裙留在椅背'),
    id: 'scoped-clothing-2',
  },
  {
    ...shot(3, '顾舟穿着黑色长袍走入房间', '顾舟在门边停下'),
    id: 'scoped-clothing-3',
    subject: '顾舟',
    nsfwContinuity: {
      nudity: '完整着装',
      clothingState: '黑色长袍穿在顾舟身上',
    },
  },
  {
    ...shot(4, '林岚从椅背旁走到窗前', '林岚停在窗前'),
    id: 'scoped-clothing-4',
  },
  {
    ...shot(5, '林岚重新穿回红色长裙', '红色长裙已重新穿在林岚身上'),
    id: 'scoped-clothing-5',
  },
];
const characterScopedClothingStates = resolveNsfwShotContinuityStates(characterScopedClothingShots);
assert.equal(characterScopedClothingStates[0]?.nudity, '完整着装');
assert.equal(characterScopedClothingStates[1]?.nudity, '全裸');
assert.match(characterScopedClothingStates[1]?.clothingState || '', /红色长裙.*离身道具/u);
assert.equal(characterScopedClothingStates[2]?.nudity, '完整着装');
assert.match(characterScopedClothingStates[2]?.clothingState || '', /黑色长袍/u);
assert.equal(
  characterScopedClothingStates[3]?.nudity,
  '全裸',
  'an intervening dressed character must not overwrite the returning character nude state',
);
assert.match(
  characterScopedClothingStates[3]?.clothingState || '',
  /红色长裙.*离身道具/u,
  'removed clothing must remain off-body when its character returns after another performer shot',
);
assert.doesNotMatch(characterScopedClothingStates[3]?.clothingState || '', /黑色长袍/u);
assert.equal(characterScopedClothingStates[4]?.nudity, '完整着装');
assert.match(characterScopedClothingStates[4]?.clothingState || '', /红色长裙.*重新穿/u);

const mixedSameShotClothingStates = resolveNsfwShotContinuityStates([
  {
    ...shot(1, '林岚穿着红色长裙，顾舟穿着黑色长袍', '两人的衣物仍各自穿在身上'),
    id: 'mixed-clothing-1',
    subject: '林岚与顾舟',
  },
  {
    ...shot(2, '林岚脱下红色长裙后全裸站立，顾舟仍穿黑色长袍', '林岚的红色长裙留在椅背，顾舟的黑色长袍仍穿在身上'),
    id: 'mixed-clothing-2',
    subject: '林岚与顾舟',
  },
  {
    ...shot(3, '两人一同走到窗边', '两人停在窗前'),
    id: 'mixed-clothing-3',
    subject: '林岚与顾舟',
  },
  {
    ...shot(4, '林岚重新穿回红色长裙，顾舟脱下黑色长袍后全裸站立', '两人的衣物状态分别发生变化'),
    id: 'mixed-clothing-4',
    subject: '林岚与顾舟',
  },
]);
assert.match(mixedSameShotClothingStates[1]?.nudity || '', /林岚：全裸/u);
assert.match(mixedSameShotClothingStates[1]?.nudity || '', /顾舟：完整着装/u);
assert.match(mixedSameShotClothingStates[1]?.clothingState || '', /林岚：红色长裙.*离身道具/u);
assert.match(mixedSameShotClothingStates[1]?.clothingState || '', /顾舟：黑色长袍穿在身上/u);
assert.match(
  mixedSameShotClothingStates[2]?.nudity || '',
  /林岚：全裸；顾舟：完整着装/u,
  'one shared shot must inherit a separate clothing state for every visible performer',
);
assert.match(mixedSameShotClothingStates[3]?.nudity || '', /林岚：完整着装；顾舟：全裸/u);
assert.match(mixedSameShotClothingStates[3]?.clothingState || '', /林岚：红色长裙.*重新穿/u);
assert.match(mixedSameShotClothingStates[3]?.clothingState || '', /顾舟：黑色长袍.*离身道具/u);

const mixedNegationAndLocation = resolveNsfwShotContinuityStates([
  {
    ...shot(1, '林岚仍穿红色长裙，顾舟仍穿黑色长袍', '两人的衣物仍各自穿在身上'),
    id: 'mixed-negation-location-1',
    subject: '林岚与顾舟',
  },
  {
    ...shot(2, '林岚拒绝脱下红色长裙并仍穿红色长裙，顾舟把黑色长袍脱下后全裸', '顾舟的黑色长袍落在地面'),
    id: 'mixed-negation-location-2',
    subject: '林岚与顾舟',
  },
]);
assert.match(mixedNegationAndLocation[1]?.clothingState || '', /林岚：红色长裙穿在身上/u);
assert.doesNotMatch(mixedNegationAndLocation[1]?.clothingState || '', /林岚：[^；]*离身道具/u);
assert.match(mixedNegationAndLocation[1]?.clothingState || '', /顾舟：黑色长袍.*离身道具.*地面/u);

const positionedMultiPersonStates = resolveNsfwShotContinuityStates([
  {
    ...shot(1, '林岚穿着红色长裙，顾舟穿着黑色长袍', '两人的衣物仍各自穿在身上'),
    id: 'positioned-multi-person-1',
    subject: '林岚与顾舟同时位于卧室',
  },
  {
    ...shot(2, '林岚脱下红色长裙后全裸，顾舟仍穿着黑色长袍', '林岚的红色长裙留在椅背，顾舟的黑色长袍仍穿在身上'),
    id: 'positioned-multi-person-2',
    subject: '林岚与顾舟分别站在床边和窗前',
  },
]);
assert.match(positionedMultiPersonStates[0]?.clothingState || '', /林岚：红色长裙穿在身上/u);
assert.match(positionedMultiPersonStates[0]?.clothingState || '', /顾舟：黑色长袍穿在身上/u);
assert.match(positionedMultiPersonStates[1]?.nudity || '', /林岚：全裸；顾舟：完整着装/u);
assert.match(positionedMultiPersonStates[1]?.clothingState || '', /林岚：红色长裙.*离身道具.*椅背/u);
assert.match(positionedMultiPersonStates[1]?.clothingState || '', /顾舟：黑色长袍穿在身上/u);

const singleChangedPerformerState = resolveNsfwShotContinuityStates([{
  ...shot(1, '林岚全裸站在床边，顾舟安静站在门旁', '林岚仍保持全裸'),
  id: 'single-changed-performer',
  subject: '林岚与顾舟同时位于卧室',
}])[0];
assert.equal(singleChangedPerformerState?.nudity, '林岚：全裸');
assert.match(singleChangedPerformerState?.clothingState || '', /^林岚：衣物已不在身上/u);
assert.doesNotMatch(
  JSON.stringify(singleChangedPerformerState),
  /顾舟：(?:全裸|衣物已不在身上)/u,
  'one performer\'s nude state must remain explicitly owned in a multi-person shot',
);

const inheritedStaticNudeBoundary = resolveNsfwShotContinuityBoundaries([{
  ...shot(1, '林岚保持全裸站在窗前', '衣物已脱下并留在床沿'),
  id: 'inherited-static-nude',
  purpose: '承接脱衣后的裸体状态',
  nsfwContinuity: {
    nudity: '全裸',
    clothingState: '衣物已脱下并作为离身道具留在床沿',
  },
}])[0];
assert.equal(inheritedStaticNudeBoundary?.entry?.nudity, '全裸');
assert.match(inheritedStaticNudeBoundary?.entry?.clothingState || '', /衣物已脱下.*离身道具.*床沿/u);
assert.doesNotMatch(
  inheritedStaticNudeBoundary?.entry?.clothingState || '',
  /仍穿在身上|尚未执行本镜脱衣动作/u,
  'an inherited off-body result must not be mistaken for a new in-shot removal',
);
assert.deepEqual(inheritedStaticNudeBoundary?.entry, inheritedStaticNudeBoundary?.end);

const globalLock = buildGlobalLock(scene, [character], [], [], []);
assert.doesNotMatch(
  globalLock,
  /默认衣橱\/身份服装基底：红色长裙、黑色短靴/u,
  'an NSFW or dynamic-clothing lock must not expose the default wardrobe as a current identity constraint',
);
assert.match(globalLock, /动态衣物优先：当前衣着以已确认入口和逐镜状态为准/u);
assert.match(globalLock, /未涉及的衣物保持原状.*只有剧情明确穿回时才恢复/u);
assert.match(globalLock, /衣橱基底（不是本镜着装指令）：红色长裙、黑色短靴/u);
assert.doesNotMatch(globalLock, /稳定身体锚点：肩背小痣的位置与形状、腰侧浅色疤痕/u,
  'a video-wide lock must not promote the private dossier into every shot');

const implicitExposureScene: Scene = {
  ...scene,
  id: 'scene-nsfw-without-nude-keyword',
  content: '林岚与成年伴侣亲吻，隔着完整衣物轻触胸部位置的衣料。',
  summary: '成人亲密场景。',
};
const implicitExposureLock = buildGlobalLock(implicitExposureScene, [character], [], [], []);
assert.match(
  implicitExposureLock,
  /红色长裙|黑色短靴/u,
  'intimate contact must retain the wardrobe when the story does not change clothing',
);
assert.doesNotMatch(implicitExposureLock, /动态衣物优先|稳定身体锚点/u);

const ordinaryScene: Scene = {
  ...scene,
  id: 'scene-ordinary-clothed',
  title: '门厅',
  content: '林岚穿着红色长裙和黑色短靴走进门厅。',
  summary: '林岚穿衣入场。',
};
const ordinaryGlobalLock = buildGlobalLock(ordinaryScene, [character], [], [], []);
assert.doesNotMatch(
  ordinaryGlobalLock,
  /稳定身体锚点：肩背小痣的位置与形状、腰侧浅色疤痕/u,
  'private body anchors must not leak into an ordinary clothed scene lock',
);

const style: StylePreset = {
  id: 'style',
  name: '电影写实',
  category: '写实',
  visual: '',
  camera: '',
  lighting: '',
  sound: '',
  updatedAt: 1,
};
const ruleSet: RuleSet = {
  id: 'rule',
  name: '规则',
  description: '',
  mode: 'timeline',
  baseRules: '',
  continuityRules: '',
  outputRules: '',
  enabled: true,
  version: '1',
  updatedAt: 1,
};
const converter: ConverterPreset = {
  id: 'converter',
  name: '转换器',
  workflow: 'all',
  inputMode: 'all',
  scope: 'video',
  systemPrompt: '',
  outputRules: '',
  enabled: true,
  version: '1',
  updatedAt: 1,
};
const canonicalPrompt = renderFinalPrompt({
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock,
  shots,
  assets: [],
  style,
  ruleSet,
  converter,
  extra: '',
  characters: [character],
  locations: [],
  props: [],
});
const secondTimelineLine = canonicalPrompt.split('\n')[1] || '';
const firstTimelineLine = canonicalPrompt.split('\n')[0] || '';
assert.match(firstTimelineLine, /入镜衣物状态〔红色长裙和黑色短靴仍穿在身上/u);
assert.match(firstTimelineLine, /镜尾裸露状态〔全裸〕/u);
assert.match(firstTimelineLine, /镜尾衣物状态〔红色长裙和黑色短靴已脱下.*床沿/u);
assert.match(secondTimelineLine, /入镜裸露状态〔全裸〕/u);
assert.match(secondTimelineLine, /红色长裙.*离身道具/u);
assert.doesNotMatch(secondTimelineLine, /当前穿着[^；]*红色长裙/u);
const h3ClothingTransition = compileTargetPrompt({
  canonicalPrompt,
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  targetId: 'minimax-h3',
  detailMode: 'concise',
});
const firstH3Shot = h3ClothingTransition.prompt.match(
  /\[Shot 1\][\s\S]*?(?=\n\n\[Shot 2\])/u,
)?.[0] || '';
assert.ok(firstH3Shot.indexOf('入镜衣物状态') < firstH3Shot.indexOf('脱下红色长裙'));
assert.ok(firstH3Shot.indexOf('脱下红色长裙') < firstH3Shot.indexOf('镜尾裸露状态'));
assert.match(firstH3Shot, /镜尾衣物状态〔红色长裙和黑色短靴已脱下.*床沿/u);

const board: Storyboard = {
  id: 'board-clothing-state',
  sceneId: scene.id,
  sourceSceneIds: [scene.id],
  sourceStoryTitle: scene.title,
  sourceStoryContent: scene.content,
  workflow: 'drama',
  inputMode: 'text',
  durationSec: 6,
  durationPreset: 'custom',
  shotMode: 'exact',
  shotCount: 2,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  stylePresetId: style.id,
  ruleSetId: ruleSet.id,
  converterPresetId: converter.id,
  globalLock,
  shots,
  finalPrompt: canonicalPrompt,
  createdAt: 1,
  updatedAt: 1,
};
const imageSource = buildStoryboardImageRequests(board, 'storyboard-shots', {
  projectName: '衣物连续性',
  characters: [character],
  locations: [],
  props: [],
  scenes: [scene],
  assets: [],
})[1]?.conversionSource || '';
assert.doesNotMatch(
  imageSource,
  /默认衣橱\/身份服装基底：红色长裙、黑色短靴/u,
  'storyboard image prompts must not reintroduce a removed default outfit',
);
assert.match(imageSource, /目标画面裸露状态：全裸/u);
assert.match(imageSource, /红色长裙.*离身道具/u);
assert.doesNotMatch(imageSource, /稳定身体锚点：肩背小痣的位置与形状、腰侧浅色疤痕/u,
  'a shot state alone must not authorize the whole private dossier');
assert.match(imageSource, /不得把默认衣橱中的衣物重新穿回/u);

const ordinaryPrompt = renderFinalPrompt({
  durationSec: 3,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  workflow: 'drama',
  inputMode: 'text',
  shots: [{
    ...shot(1, '林岚穿着红色长裙走进门厅', '林岚仍穿着红色长裙站在门厅中央'),
    endSec: 3,
  }],
  style,
  ruleSet,
  converter,
  scene: ordinaryScene,
  assets: [],
  characters: [character],
  locations: [],
  props: [],
  globalLock: ordinaryGlobalLock,
  extra: '',
});
assert.doesNotMatch(
  ordinaryPrompt,
  /稳定身体锚点〔肩背小痣的位置与形状/u,
  'private body anchors must not leak through the per-shot performance field in SFW prompts',
);

const discontinuity = checkStoryboardContinuity([
  {
    ...shot(1, '林岚保持全裸且与另一人持续接触，皮肤留有可见湿痕', '动作处于持续阶段'),
    nsfwContinuity: {
      nudity: '全裸',
      contact: '持续身体接触',
      actionStage: '持续',
      residue: '皮肤留有可见湿痕',
    },
  },
  {
    ...shot(2, '林岚静止站立', '状态没有说明变化过程'),
    outfit: '红色长裙穿在身上',
    nsfwContinuity: {
      nudity: '完整着装',
      contact: '无接触',
      actionStage: '开始',
      residue: '皮肤洁净无残留',
    },
  },
]);
for (const code of [
  'nsfw-nudity-state-change',
  'nsfw-contact-state-change',
  'nsfw-action-stage-regression',
  'nsfw-residue-state-change',
] as const) {
  assert.ok(
    discontinuity.issues.some((issue) => issue.code === code),
    `continuity audit must report ${code}`,
  );
}

const persisted = createInitialState();
persisted.project.characters[0] = analyzedCharacter;
persisted.project.storyboards = [
  {
    ...board,
    shots: [{
      ...shots[0],
      nsfwContinuity: {
        nudity: '全裸',
        clothingState: '红色长裙和黑色短靴已脱下并作为离身道具留在床沿',
        contact: '持续身体接触',
        actionStage: '持续',
        residue: '皮肤留有可见湿痕',
      },
    }],
  },
];
persisted.projects = [persisted.project];
const restored = normalizeState(JSON.parse(JSON.stringify(persisted)));
assert.deepEqual(restored.project.characters[0].nsfwBodyAnchors, analyzedCharacter.nsfwBodyAnchors);
assert.deepEqual(
  restored.project.storyboards[0].shots[0].nsfwContinuity,
  persisted.project.storyboards[0].shots[0].nsfwContinuity,
);
const ordinaryLegacy = createInitialState();
delete ordinaryLegacy.project.characters[0].nsfwBodyAnchors;
assert.equal(
  normalizeState(JSON.parse(JSON.stringify(ordinaryLegacy))).project.characters[0].nsfwBodyAnchors,
  undefined,
  'legacy and ordinary characters must not receive an automatic private body profile',
);

console.log('NSFW clothing, body-anchor persistence, and shot-continuity checks passed');
