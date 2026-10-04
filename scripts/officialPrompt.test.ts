import assert from 'node:assert/strict';
import * as officialPromptModule from '../src/officialPrompt';
import {
  applyOfficialH3Prompt,
  buildOfficialH3CompileInput,
  buildOfficialH3References,
  buildOfficialH3SourceFingerprint,
  collectOfficialH3ReferenceAssets,
  compileOfficialH3Prompt,
  hasCurrentOfficialH3Prompt,
  hasCurrentOfficialH3EnglishPrompt,
  mergeOfficialH3Parameters,
  refreshOfficialH3PromptAfterSourceUpdate,
  type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import type {
  Character,
  Location,
  Prop,
  ReferenceAsset,
  Storyboard,
  VideoShot,
} from '../src/types';
import { nsfwPrivateReferenceResponsibility } from '../src/nsfwPrivateAssets';
import type { PromptReferenceInput } from '../src/promptAdapters';
import { publicVideoContinuityLock } from '../src/videoPrivateScope';
import { sourceContentHash } from '../src/sourceIntegrity';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';

const makeShot = (overrides: Partial<VideoShot> = {}): VideoShot => ({
  id: 'shot-1',
  index: 1,
  startSec: 0,
  endSec: 5,
  purpose: '建立关系',
  subject: '无名主角与小师妹',
  action: '无名主角抬手挡住飞来的木牌，小师妹退到青石演武场边缘',
  camera: '中景缓慢推进',
  transition: '硬切',
  lighting: '冷蓝月光',
  sound: '木牌破空声、脚步声',
  result: '两人保持清晰站位',
  referenceAssetIds: ['picture-1'],
  prompt: '',
  locked: false,
  ...overrides,
});

const makeBoard = (overrides: Partial<Storyboard> = {}): Storyboard => ({
  id: 'board-official-test',
  sceneId: 'scene-official-test',
  workflow: 'drama',
  inputMode: 'text_reference',
  durationSec: 5,
  durationPreset: '5s',
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  stylePresetId: 'style-cinema',
  ruleSetId: 'rule-default',
  converterPresetId: 'converter-default',
  globalLock: '保持人物身份、服装和空间连续。',
  shots: [makeShot()],
  finalPrompt: '【0s-5s】主体：无名主角与小师妹；动作：无名主角抬手挡住飞来的旧木牌，小师妹退到青石演武场边缘；空间：青石演武场；光影：冷蓝月光；镜头：中景缓慢推进；台词：无；音效：旧木牌破空声、脚步声。',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const compositePicture: ReferenceAsset = {
  id: 'picture-1',
  name: '综合角色与场景参考图',
  type: 'reference',
  role: 'composition',
  mediaType: 'image',
  source: 'upload',
  fileName: 'composite.png',
  checksum: 'picture-checksum-v1',
  visualAnchor: '同一画风、冷蓝月光、青石地面',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

const hero: Character = {
  id: 'character-hero',
  name: '无名主角',
  gender: '男',
  apparentAge: '成年',
  race: '人类',
  appearance: '黑发、眉骨清晰',
  outfit: '深青长袍',
  signatureProps: '旧木牌',
  personality: '克制',
  motionHabits: '动作先稳住重心再发力',
  anchor: '左腕红绳',
  negativeContinuity: '',
  assetIds: ['picture-1'],
};

const sidekick: Character = {
  ...hero,
  id: 'character-sidekick',
  name: '小师妹',
  gender: '女',
  appearance: '乌发、圆脸',
  outfit: '浅灰短袍',
  signatureProps: '银色发簪',
  anchor: '银色发簪',
};

const courtyard: Location = {
  id: 'location-courtyard',
  name: '青石演武场',
  description: '开阔的青石练武场',
  timeWeather: '夜间细雨',
  lighting: '冷蓝月光',
  palette: '青灰色',
  fixedProps: '倾倒石柱',
  anchor: '场中央圆形石台',
  assetIds: ['picture-1'],
};

const sword: Prop = {
  id: 'prop-sword',
  name: '旧木牌',
  category: '信物',
  material: '风化木材',
  appearance: '边缘磨损',
  effect: '被击中时发出闷响',
  stateRules: '保持断裂前状态',
  assetIds: ['picture-1'],
};

const context: OfficialH3ProjectContext = {
  assets: [compositePicture],
  characters: [hero, sidekick],
  locations: [courtyard],
  props: [sword],
  sceneContent: '无名主角和小师妹在青石演武场对峙。',
};

// One composite picture may intentionally anchor several semantic subjects.
// This is required for a single uploaded image that contains the cast and set.
const compositeInput = buildOfficialH3CompileInput(makeBoard(), context);
assert.equal(compositeInput.references?.length, 1);
assert.deepEqual(
  compositeInput.subjectDefinitions?.map((subject) => [subject.name, subject.referenceAssetIds]),
  [
    ['无名主角', ['picture-1']],
    ['小师妹', ['picture-1']],
    ['青石演武场', ['picture-1']],
    ['旧木牌', ['picture-1']],
  ],
  'one Picture must be reusable by every semantic subject it depicts',
);
const compositePrompt = compileOfficialH3Prompt(makeBoard(), context).output.prompt;
assert.match(compositePrompt, /^subject_definitions:/u);
const compositeProtocol = readH3PromptProtocol(compositePrompt);
assert.ok(compositeProtocol, 'the compiled full-reference prompt is parseable by the H3 transport contract');
assert.deepEqual(compositeProtocol?.sections, [
  'subject_definitions', 'summary', 'retention_analysis', 'detailed_description',
  'overall_soundscape', 'non_diegetic_music',
]);
assert.deepEqual(compositeProtocol?.shots, [{ marker: '[Shot 1]', cut: null }],
  'the first H3 shot has no synthetic At cut');
assert.match(compositePrompt, /<Subject 1>[\s\S]*<Picture 1>/u);
assert.match(compositePrompt, /<Subject 2>[\s\S]*<Picture 1>/u);
assert.match(compositePrompt, /<Subject 3>[\s\S]*<Picture 1>/u);
assert.match(compositePrompt, /<Subject 4>[\s\S]*<Picture 1>/u);
const compositeDetailed = compositePrompt.split('detailed_description:\n')[1]?.split('\n\noverall_soundscape:')[0] || '';
assert.match(compositeDetailed, /<Subject 1>/u, 'official detailed shots must address the subject tag, not only define it');
assert.match(compositeDetailed, /<Subject 2>/u, 'every named cast member in the canonical shots must map to its subject tag');
assert.doesNotMatch(compositeDetailed, /@?(?:无名主角|小师妹)/u, 'raw character names must not bypass official subject references in detailed shots');

// Without visual references H3 must use the integrated description form and
// must not emit a reference-only subject_definitions block.
const noReferenceBoard = makeBoard({
  inputMode: 'text',
  shots: [makeShot({ referenceAssetIds: [] })],
});
const noReferenceInput = buildOfficialH3CompileInput(noReferenceBoard, {
  ...context,
  assets: [],
});
assert.ok(noReferenceInput.subjectDefinitions?.length, 'project entities remain available to the compiler');
assert.equal(
  noReferenceInput.subjectDefinitions?.find((subject) => subject.name === hero.name)?.outfit,
  hero.outfit,
  'an ordinary clothed board must retain the character wardrobe definition',
);
const noReferencePrompt = compileOfficialH3Prompt(noReferenceBoard, {
  ...context,
  assets: [],
}).output.prompt;
assert.match(noReferencePrompt, /^integrated_multimodal_description:/u);
const noReferenceProtocol = readH3PromptProtocol(noReferencePrompt);
assert.ok(noReferenceProtocol, 'the compiled no-reference prompt is parseable by the H3 transport contract');
assert.deepEqual(noReferenceProtocol?.sections, [
  'integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music',
]);
assert.equal(noReferenceProtocol?.shots.length, noReferenceBoard.shots.length,
  'H3 keeps the authored shot count instead of flattening to a generic timeline');
assert.doesNotMatch(noReferencePrompt, /^subject_definitions:/mu);
assert.doesNotMatch(noReferencePrompt, /<Picture \d+>/u);

// This is the pre-scope v7 payload shape. Keep an ordinary saved artifact's
// fingerprint byte-compatible, including optional fields omitted by JSON.
const legacyPublicFingerprint = `official-h3-v7:${sourceContentHash(noReferenceBoard.finalPrompt)}:${sourceContentHash(JSON.stringify({
  canonicalPrompt: noReferenceInput.canonicalPrompt,
  durationSec: noReferenceInput.durationSec,
  aspectRatio: noReferenceInput.aspectRatio,
  resolution: noReferenceInput.resolution,
  audioMode: noReferenceInput.audioMode,
  references: [],
  subjectDefinitions: noReferenceInput.subjectDefinitions || [],
  constraints: noReferenceInput.constraints || [],
  nsfwDetail: noReferenceInput.nsfwDetail || false,
}))}`;
const unchangedPublicArtifact = applyOfficialH3Prompt(noReferenceBoard, { ...context, assets: [] });
assert.equal(unchangedPublicArtifact.officialPromptSource, legacyPublicFingerprint);
assert.equal(hasCurrentOfficialH3Prompt(unchangedPublicArtifact), true,
  'unaffected public v7 prompts must stay usable without context');
assert.equal(hasCurrentOfficialH3Prompt(unchangedPublicArtifact, { ...context, assets: [] }), true);

const actionOnlyNsfwBoard = makeBoard({
  inputMode: 'text',
  sourceStoryContent: '无名主角与成年伴侣站在街边，隔着完整衣物触碰胸前衣襟。',
  extraRequirement: 'NSFW',
  globalLock: '固定人物：无名主角：黑发、眉骨清晰，默认衣橱/身份服装基底：深青长袍，左腕红绳。',
  shots: [makeShot({
    subject: hero.name,
    action: '无名主角隔着完整衣物触碰成年伴侣的胸前衣襟',
    result: '动作仍在持续',
    referenceAssetIds: [],
  })],
  finalPrompt: '【0s-5s】主体：@无名主角；正在 [隔着完整衣物触碰成年伴侣的胸前衣襟]；空间：街边；镜头：中景固定；台词：无；音效：无。',
});
const actionOnlyNsfwInput = buildOfficialH3CompileInput(actionOnlyNsfwBoard, {
  ...context,
  assets: [],
  characters: [{
    ...hero,
    nsfwBodyAnchors: { stableTraits: ['仅限 NSFW 镜头的稳定身体锚点'] },
  }],
});
const actionOnlyHeroDefinition = actionOnlyNsfwInput.subjectDefinitions
  ?.find((subject) => subject.name === hero.name);
assert.equal(
  actionOnlyHeroDefinition?.outfit,
  hero.outfit,
  'an NSFW setting or covered contact must not suppress the current wardrobe without an authored clothing change',
);
assert.doesNotMatch(
  actionOnlyHeroDefinition?.appearance || '',
  /仅限 NSFW 镜头的稳定身体锚点/u,
  'private body anchors must stay in their canonical shot instead of leaking through a video-wide subject definition',
);
assert.match(
  (actionOnlyNsfwInput.constraints || []).join('\n'),
  /默认衣橱\/身份服装基底：深青长袍/u,
);

const legacyDerivedLock = [
  '动态衣物优先：当前衣物与裸露状态逐镜继承；脱下后不得自动穿回，离身衣物保持位置，只有剧情明确穿回时才恢复对应着装。',
  '承接上一段：无名主角已换上绿色外套，长裤和靴子保持原状。',
  '固定人物：无名主角：黑发，稳定身体锚点：PRIVATE_A_SENTINEL；PRIVATE_B_SENTINEL、小师妹：乌发，NSFW身体锚点：PRIVATE_C_SENTINEL',
  '固定场景：青石演武场，保留庭院灯笼。',
  '固定道具：旧木牌。',
].join('\n');
const publicLegacyLock = publicVideoContinuityLock(legacyDerivedLock);
assert.doesNotMatch(publicLegacyLock, /PRIVATE_[ABC]_SENTINEL|脱下后不得自动穿回/u);
assert.match(publicLegacyLock, /已换上绿色外套.*长裤和靴子保持原状/u);
assert.match(publicLegacyLock, /庭院灯笼|旧木牌/u);
const handwrittenLock = '用户说明：将“稳定身体锚点：CUSTOM_LITERAL_SENTINEL”写在道具卡上；本段保留绿色外套。';
assert.equal(publicVideoContinuityLock(handwrittenLock), handwrittenLock,
  'the request compatibility helper must not scan or redact user-authored prose');
for (const usePromptPlan of [false, true]) {
  const legacyBoard = makeBoard({
    ...actionOnlyNsfwBoard,
    globalLock: legacyDerivedLock,
    extraRequirement: handwrittenLock,
    promptPlan: usePromptPlan ? {
      canonicalPrompt: actionOnlyNsfwBoard.finalPrompt,
      durationSec: 5, aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
      workflow: 'drama', inputMode: 'text', shotIds: ['shot-1'], referenceAssetIds: [],
      constraints: [`连续性锚点：${legacyDerivedLock.replace(/\n/gu, ' ')}`, `制作要求：${handwrittenLock}`],
      trace: { ruleSetId: 'rule-default', converterId: 'converter-default', styleId: 'style-cinema' },
    } : undefined,
  });
  const before = JSON.stringify(legacyBoard);
  const legacyOutput = compileOfficialH3Prompt(legacyBoard, { assets: [], characters: [hero] }).output.prompt;
  assert.doesNotMatch(legacyOutput, /PRIVATE_[ABC]_SENTINEL/u);
  const safeLegacyInput = buildOfficialH3CompileInput(legacyBoard, { assets: [], characters: [hero] });
  assert.match((safeLegacyInput.constraints || []).join('\n'), /绿色外套/u);
  assert.match((safeLegacyInput.constraints || []).join('\n'), /CUSTOM_LITERAL_SENTINEL/u);
  assert.match(legacyOutput, /深青长袍/u, 'ordinary identity projection restores the wardrobe inventory');
  assert.equal(JSON.stringify(legacyBoard), before, 'compatibility cleanup must not rewrite saved prompts or source');
  const safeArtifact = applyOfficialH3Prompt(legacyBoard, { assets: [], characters: [hero] });
  const oldAutomaticArtifact = {
    ...safeArtifact,
    officialPromptSource: safeArtifact.officialPromptSource?.replace(/:private-scope-v1$/u, ''),
  };
  const oldSnapshot = JSON.stringify(oldAutomaticArtifact);
  assert.equal(hasCurrentOfficialH3Prompt(oldAutomaticArtifact), false,
    'context-free checks must not present an old automatic-dossier artifact as current');
  assert.equal(hasCurrentOfficialH3Prompt(oldAutomaticArtifact, { assets: [], characters: [hero] }), false);
  assert.equal(hasCurrentOfficialH3Prompt(safeArtifact), true,
    'an explicitly rebuilt artifact records scope compatibility without mutating the old global lock');
  assert.equal(hasCurrentOfficialH3Prompt(safeArtifact, { assets: [], characters: [hero] }), true);
  assert.strictEqual(refreshOfficialH3PromptAfterSourceUpdate(oldAutomaticArtifact,
    { assets: [], characters: [hero] }, { assets: [], characters: [hero] }), oldAutomaticArtifact);
  assert.equal(JSON.stringify(oldAutomaticArtifact), oldSnapshot, 'checking/refreshing never rewrites a saved old artifact');
}

const scopedSentinelCharacter = {
  ...hero,
  nsfwProfile: { fullBody: 'UNSELECTED_BODY_SENTINEL', breasts: 'SELECTED_PART_SENTINEL', vulva: 'UNSELECTED_PART_SENTINEL' },
  nsfwBodyAnchors: { stableTraits: ['UNSCOPED_AGGREGATE_SENTINEL'] },
};
const scopedSentinelBoard = makeBoard({
  inputMode: 'text', durationSec: 10,
  shots: [
    makeShot({ subject: hero.name, endSec: 5, referenceAssetIds: [] }),
    makeShot({ id: 'scope-shot-2', index: 2, startSec: 5, endSec: 10, subject: hero.name,
      referenceAssetIds: [], visiblePrivatePartsByCharacter: { [hero.id]: ['breasts'] } }),
  ],
  finalPrompt: [
    `【0s-5s】主体：@${hero.name}；动作：抬手整理外套；空间：庭院；镜头：中景；台词：无；音效：无。`,
    `【5s-10s】主体：@${hero.name}；动作：按当前镜头事实保持姿态；空间：庭院；镜头：近景；台词：无；音效：无。`,
  ].join('\n'),
});
const scopedSentinelContext = { assets: [], characters: [scopedSentinelCharacter] };
const selectedInput = buildOfficialH3CompileInput(scopedSentinelBoard, scopedSentinelContext);
assert.doesNotMatch(JSON.stringify(selectedInput.subjectDefinitions), /(?:SELECTED|UNSELECTED|UNSCOPED)_.*SENTINEL/u);
assert.equal(selectedInput.shotPrivateDetails?.length, 1);
assert.equal(selectedInput.shotPrivateDetails?.[0]?.shotIndex, 2);
const selectedPrompt = compileOfficialH3Prompt(scopedSentinelBoard, scopedSentinelContext).output.prompt;
const [publicFirstShot, selectedSecondShot] = selectedPrompt.split('[Shot 2]');
assert.doesNotMatch(publicFirstShot, /SELECTED_PART_SENTINEL/u);
assert.match(selectedSecondShot, /SELECTED_PART_SENTINEL/u);
assert.doesNotMatch(selectedPrompt, /UNSELECTED_BODY_SENTINEL|UNSELECTED_PART_SENTINEL|UNSCOPED_AGGREGATE_SENTINEL/u);
const selectedFingerprint = buildOfficialH3SourceFingerprint(scopedSentinelBoard, scopedSentinelContext);
assert.equal(buildOfficialH3SourceFingerprint(scopedSentinelBoard, {
  ...scopedSentinelContext, characters: [{ ...scopedSentinelCharacter,
    nsfwProfile: { ...scopedSentinelCharacter.nsfwProfile, fullBody: 'CHANGED_UNSELECTED_BODY_SENTINEL' } }],
}), selectedFingerprint, 'unselected private fields must not affect a derived video prompt');
assert.notEqual(buildOfficialH3SourceFingerprint(scopedSentinelBoard, {
  ...scopedSentinelContext, characters: [{ ...scopedSentinelCharacter,
    nsfwProfile: { ...scopedSentinelCharacter.nsfwProfile, breasts: 'CHANGED_SELECTED_PART_SENTINEL' } }],
}), selectedFingerprint);

for (const action of [
  '无名主角与成年伴侣亲吻，衣物保持原状',
  '无名主角隔着长袍触碰胸部位置的衣料，画面只见衣物',
]) {
  const clothedBoard = makeBoard({
    inputMode: 'text',
    sourceStoryContent: `${action}。下一段成年伴侣会换外套，此刻还未发生。`,
    extraRequirement: 'NSFW',
    shots: [makeShot({ subject: hero.name, action, result: '两人衣着保持原状', referenceAssetIds: [] })],
    finalPrompt: `【0s-5s】主体：@无名主角；动作：${action}；空间：街边；光影：日光；镜头：中景；台词：无；音效：无。`,
  });
  const privateSentinelCharacter = {
    ...hero,
    nsfwProfile: { fullBody: 'PRIVATE_FULL_BODY_SENTINEL', breasts: 'PRIVATE_PART_SENTINEL' },
    nsfwBodyAnchors: { stableTraits: ['PRIVATE_ANCHOR_SENTINEL'] },
  };
  const clothedOutput = compileOfficialH3Prompt(clothedBoard, { assets: [], characters: [privateSentinelCharacter] });
  assert.match(clothedOutput.output.prompt, /服装：深青长袍/u);
  assert.doesNotMatch(clothedOutput.output.prompt, /PRIVATE_(?:FULL_BODY|PART|ANCHOR)_SENTINEL/u);
  assert.equal(privateSentinelCharacter.nsfwProfile.fullBody, 'PRIVATE_FULL_BODY_SENTINEL');
}

const dynamicWardrobeCanonical = [
  '【0s-2s】 主体：@无名主角（当前裸露状态〔完整着装〕；当前衣物状态〔深青长袍穿在身上〕）[朝向：镜面] 正在 [站在镜前]（建立）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
  '【2s-4s】 主体：@无名主角（当前裸露状态〔全裸〕；当前衣物状态〔深青长袍已脱下并作为离身道具留在椅背〕）[朝向：镜面] 正在 [脱下深青长袍]（推进）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
  '【4s-6s】 主体：@无名主角（当前裸露状态〔全裸〕；当前衣物状态〔深青长袍已脱下并作为离身道具留在椅背〕）[朝向：窗前] 正在 [走到窗前]（延续）；空间：卧室；镜头：侧向跟拍；台词：无；音效：无。',
  '【6s-8s】 主体：@无名主角（当前裸露状态〔完整着装〕；当前衣物状态〔深青长袍已重新穿在身上〕）[朝向：镜面] 正在 [重新穿回深青长袍]（收束）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
].join('\n');
const dynamicWardrobeShots: VideoShot[] = [
  makeShot({ id: 'dynamic-shot-1', index: 1, startSec: 0, endSec: 2, subject: hero.name, action: '站在镜前', result: '深青长袍穿在身上', referenceAssetIds: [] }),
  makeShot({ id: 'dynamic-shot-2', index: 2, startSec: 2, endSec: 4, subject: hero.name, action: '脱下深青长袍后全裸站立', result: '深青长袍留在椅背', referenceAssetIds: [] }),
  makeShot({ id: 'dynamic-shot-3', index: 3, startSec: 4, endSec: 6, subject: hero.name, action: '走到窗前', result: '保持全裸', referenceAssetIds: [] }),
  makeShot({ id: 'dynamic-shot-4', index: 4, startSec: 6, endSec: 8, subject: hero.name, action: '重新穿回深青长袍', result: '深青长袍已重新穿在身上', referenceAssetIds: [] }),
];
const dynamicWardrobeBoard = makeBoard({
  inputMode: 'text',
  durationSec: 8,
  durationPreset: 'custom',
  shotCount: dynamicWardrobeShots.length,
  shots: dynamicWardrobeShots,
  finalPrompt: dynamicWardrobeCanonical,
  globalLock: [
    '固定人物：无名主角：黑发、眉骨清晰，默认衣橱/身份服装基底：深青长袍，左腕红绳。',
    '同一镜头组中的人物身份、默认衣橱/身份服装基底、空间轴线和主光源保持连续。',
    '当前镜头衣物状态以原文和本镜可见动作为最高优先级。',
  ].join('\n'),
});
const dynamicWardrobeContext: OfficialH3ProjectContext = { assets: [], characters: [hero] };
const dynamicWardrobeInput = buildOfficialH3CompileInput(dynamicWardrobeBoard, dynamicWardrobeContext);
const dynamicHeroDefinition = dynamicWardrobeInput.subjectDefinitions?.find((subject) => subject.name === hero.name);
assert.equal(dynamicHeroDefinition?.outfit, undefined, 'a board with nudity or clothing transitions must not promote the default outfit to a video-wide identity fact');
assert.equal(dynamicHeroDefinition?.wardrobeBaseline, hero.outfit,
  'dynamic wardrobe still retains its inventory so unrelated garments cannot vanish');
assert.doesNotMatch(dynamicHeroDefinition?.anchor || '', /深青长袍/u, 'a clothing-bearing legacy anchor must not restore the default outfit through another subject-definition field');
assert.doesNotMatch((dynamicWardrobeInput.constraints || []).join('\n'), /默认衣橱\/身份服装基底：深青长袍/u, 'automatic global constraints must not re-inject the removed default wardrobe');
const dynamicWardrobePrompt = compileOfficialH3Prompt(dynamicWardrobeBoard, dynamicWardrobeContext).output.prompt;
assert.doesNotMatch(dynamicWardrobePrompt, /服装：深青长袍/u, 'the H3 subject identity must not claim that the dynamically nude character is wearing the default outfit');
assert.doesNotMatch(dynamicWardrobePrompt, /默认衣橱\/身份服装基底：深青长袍/u);
assert.match(dynamicWardrobePrompt, /衣橱基底（不是本镜着装指令）：深青长袍/u);
for (const state of [
  '当前衣物状态〔深青长袍穿在身上〕',
  '当前衣物状态〔深青长袍已脱下并作为离身道具留在椅背〕',
  '当前衣物状态〔深青长袍已重新穿在身上〕',
]) {
  assert.match(dynamicWardrobePrompt, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
}
assert.equal(
  dynamicWardrobePrompt.split('当前衣物状态〔深青长袍已脱下并作为离身道具留在椅背〕').length - 1,
  2,
  'the off-body garment state must remain explicit in both the removal result and the following shot',
);

const makePrivateReference = (
  id: string,
  sourceEntityId: string,
  nsfwPrivatePart: ReferenceAsset['nsfwPrivatePart'],
  visualAnchor: string,
): ReferenceAsset => ({
  id,
  name: `${sourceEntityId}-${nsfwPrivatePart}-私密参考`,
  type: 'reference',
  role: 'character',
  mediaType: 'image',
  source: 'generated',
  sourceEntityId,
  sourceEntityKind: 'character',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart,
  imageVariant: nsfwPrivatePart === 'full-body' ? 'private-full-body' : 'private-close-up',
  visualAnchor,
  checksum: `${id}-checksum-v1`,
  tags: ['nsfw-private-profile'],
  createdAt: 1,
  updatedAt: 1,
});

const heroClothedOnlyPrivate = makePrivateReference(
  'private-hero-clothed-only',
  hero.id,
  'full-body',
  '错误旧锚点：让无名主角在所有镜头永久全裸',
);
const heroFullBodyPrivate = makePrivateReference(
  'private-hero-full-body',
  hero.id,
  'full-body',
  '错误旧锚点：忽略当前衣物并保持裸体',
);
const heroPenisPrivate = makePrivateReference(
  'private-hero-penis',
  hero.id,
  'penis',
  '错误旧锚点：每一镜都展示阴茎',
);
const heroScrotumPrivate = makePrivateReference(
  'private-hero-scrotum',
  hero.id,
  'scrotum',
  '错误旧锚点：每一镜都展示阴囊',
);
const heroGlobalOnlyPenisPrivate = makePrivateReference(
  'private-hero-global-only-penis',
  hero.id,
  'penis',
  '错误旧锚点：项目全局私密图自动应用到全部镜头',
);
const sidekickVulvaPrivate = makePrivateReference(
  'private-sidekick-vulva',
  sidekick.id,
  'vulva',
  '错误旧锚点：每一镜都展示外阴',
);
const unknownAdultCharacter: Character = {
  ...hero,
  id: 'character-unknown-adult',
  name: '路人甲',
  apparentAge: '',
  assetIds: [],
};
const unknownAdultPrivate = makePrivateReference(
  'private-unknown-adult-penis',
  unknownAdultCharacter.id,
  'penis',
  '路人甲阴茎稳定外貌参考',
);
const privateAssets = [
  heroClothedOnlyPrivate,
  heroFullBodyPrivate,
  heroPenisPrivate,
  heroScrotumPrivate,
  heroGlobalOnlyPenisPrivate,
  sidekickVulvaPrivate,
  unknownAdultPrivate,
];

// Merely binding a private-profile image does not make an ordinary board
// NSFW. Negated prose, global ids and boundary ids must all fail closed.
const sfwPrivateBoard = makeBoard({
  sourceStoryContent: '无名主角和小师妹均为成年人，两人约定禁止展示裸体或任何私密部位。',
  globalReferenceAssetIds: [heroFullBodyPrivate.id],
  firstFrameAssetId: heroPenisPrivate.id,
  lastFrameAssetId: sidekickVulvaPrivate.id,
  shots: [makeShot({
    action: '无名主角穿着深青长袍举起旧木牌，小师妹保持浅灰短袍完整着装',
    result: '两人衣物完整，没有展示任何私密部位',
    referenceAssetIds: [compositePicture.id, ...privateAssets.map((asset) => asset.id)],
  })],
});
const sfwPrivateContext: OfficialH3ProjectContext = {
  ...context,
  assets: [compositePicture, ...privateAssets],
};
assert.deepEqual(
  collectOfficialH3ReferenceAssets(sfwPrivateBoard, sfwPrivateContext.assets, sfwPrivateContext.characters)
    .map((asset) => asset.id),
  [compositePicture.id],
  'ordinary/negated shots must reject private images from shot, global and boundary bindings',
);
const sfwPrivateInput = buildOfficialH3CompileInput(sfwPrivateBoard, sfwPrivateContext);
assert.deepEqual(sfwPrivateInput.references?.map((reference) => reference.id), [compositePicture.id]);
assert.ok(
  sfwPrivateInput.subjectDefinitions?.every((definition) => (
    !(definition.referenceAssetIds || []).some((id) => id.startsWith('private-'))
  )),
  'a private image rejected from the manifest must not re-enter through character assetIds or composite fallback',
);

// A mixed clothing board may use a private image only when that exact binding
// points to the same clearly-adult performer and the visible body part matches.
// A global id alone cannot borrow the later NSFW shot as its scope.
const mixedPrivateShots: VideoShot[] = [
  makeShot({
    id: 'mixed-private-shot-1',
    index: 1,
    startSec: 0,
    endSec: 2,
    subject: '无名主角与小师妹',
    action: '无名主角穿着深青长袍站在帘前，小师妹穿浅灰短袍站在一旁',
    result: '两人保持完整着装',
    referenceAssetIds: [compositePicture.id, heroClothedOnlyPrivate.id],
  }),
  makeShot({
    id: 'mixed-private-shot-2',
    index: 2,
    startSec: 2,
    endSec: 5,
    subject: '无名主角、小师妹与路人甲',
    action: '无名主角全裸站立且阴茎清晰可见；小师妹保持浅灰短袍完整着装；路人甲全裸站立且阴茎清晰可见',
    result: '无名主角保持全裸，小师妹仍完整着装，路人甲年龄信息仍不明确',
    referenceAssetIds: [
      compositePicture.id,
      heroFullBodyPrivate.id,
      heroPenisPrivate.id,
      heroScrotumPrivate.id,
      sidekickVulvaPrivate.id,
      unknownAdultPrivate.id,
    ],
    visiblePrivatePartsByCharacter: {
      [hero.id]: ['full-body', 'penis'],
      [unknownAdultCharacter.id]: ['penis'],
    },
  }),
];
const mixedPrivateBoard = makeBoard({
  durationSec: 5,
  sourceStoryContent: '无名主角为成年人，小师妹为成年人，路人甲年龄不明。随后无名主角脱下深青长袍。',
  globalReferenceAssetIds: [heroClothedOnlyPrivate.id, heroGlobalOnlyPenisPrivate.id],
  shots: mixedPrivateShots,
  finalPrompt: [
    '【0s-2s】 主体：@无名主角（当前裸露状态〔完整着装〕；当前衣物状态〔深青长袍穿在身上〕）与@小师妹（当前裸露状态〔完整着装〕；当前衣物状态〔浅灰短袍穿在身上〕）正在 [站在帘前]；空间：卧室；镜头：中景；台词：无；音效：无。',
    '【2s-5s】 主体：@无名主角（当前裸露状态〔全裸〕；当前衣物状态〔深青长袍已脱下并离身〕）与@小师妹（当前裸露状态〔完整着装〕；当前衣物状态〔浅灰短袍穿在身上〕）正在 [保持各自状态]；空间：卧室；镜头：中景；台词：无；音效：无。',
  ].join('\n'),
});
const crossLinkedSidekick: Character = {
  ...sidekick,
  assetIds: [compositePicture.id, heroPenisPrivate.id],
};
const mixedPrivateContext: OfficialH3ProjectContext = {
  assets: [compositePicture, ...privateAssets],
  characters: [hero, crossLinkedSidekick, unknownAdultCharacter],
  locations: [courtyard],
  props: [sword],
};
const mixedPrivateInput = buildOfficialH3CompileInput(mixedPrivateBoard, mixedPrivateContext);
assert.deepEqual(
  mixedPrivateInput.references?.map((reference) => reference.id),
  [compositePicture.id, heroFullBodyPrivate.id, heroPenisPrivate.id, unknownAdultPrivate.id],
  'only same-character, matching-part references in the bound NSFW shot may survive, independent of age metadata',
);
const mixedPrivateHeroDefinition = mixedPrivateInput.subjectDefinitions?.find((definition) => definition.name === hero.name);
assert.deepEqual(
  mixedPrivateHeroDefinition?.referenceAssetIds,
  [compositePicture.id, heroFullBodyPrivate.id, heroPenisPrivate.id],
  'qualified private references must bind to their source character',
);
assert.ok(
  mixedPrivateInput.subjectDefinitions
    ?.filter((definition) => definition.name !== hero.name)
    .every((definition) => (
      !(definition.referenceAssetIds || []).includes(heroFullBodyPrivate.id)
      && !(definition.referenceAssetIds || []).includes(heroPenisPrivate.id)
    )),
  'private references must never cross-bind through stale entity assetIds or the one-picture fallback',
);
const mixedPrivateUnknownDefinition = mixedPrivateInput.subjectDefinitions
  ?.find((definition) => definition.name === unknownAdultCharacter.name);
assert.deepEqual(
  mixedPrivateUnknownDefinition?.referenceAssetIds,
  [unknownAdultPrivate.id],
  'a private reference without age metadata remains bound only to its explicit source character',
);
const privateOnlyBoard: Storyboard = {
  ...mixedPrivateBoard,
  shots: mixedPrivateBoard.shots.map((shot, index) => ({
    ...shot,
    referenceAssetIds: index === 1 ? [heroPenisPrivate.id] : [],
  })),
  globalReferenceAssetIds: [],
};
const bedroom: Location = { ...courtyard, id: 'location-bedroom', name: '卧室', assetIds: [] };
const privateOnlyInput = buildOfficialH3CompileInput(privateOnlyBoard, {
  assets: [heroPenisPrivate],
  characters: [
    { ...hero, assetIds: [] },
    { ...crossLinkedSidekick, assetIds: [heroPenisPrivate.id] },
  ],
  locations: [bedroom],
});
assert.deepEqual(
  privateOnlyInput.subjectDefinitions?.find((definition) => definition.name === hero.name)?.referenceAssetIds,
  [heroPenisPrivate.id],
  'a qualified private-only reference remains available to its owning character',
);
assert.ok(
  privateOnlyInput.subjectDefinitions
    ?.filter((definition) => definition.name !== hero.name)
    .every((definition) => !(definition.referenceAssetIds || []).includes(heroPenisPrivate.id)),
  'a sole private picture must not trigger composite fallback for another character or location',
);
for (const asset of [heroFullBodyPrivate, heroPenisPrivate]) {
  const compiledReference: PromptReferenceInput | undefined = mixedPrivateInput.references
    ?.find((candidate) => candidate.id === asset.id);
  assert.equal(
    compiledReference?.responsibility,
    nsfwPrivateReferenceResponsibility(asset),
    'private reference responsibilities must discard generator anchors and keep current clothing/nudity authoritative',
  );
  assert.doesNotMatch(compiledReference?.responsibility || '', /错误旧锚点/u);
}
assert.equal(
  buildOfficialH3References(mixedPrivateBoard, mixedPrivateContext.assets)
    .some((reference) => String(reference.id || '').startsWith('private-')),
  false,
  'the backwards-compatible overload without character evidence must fail closed for private references',
);
const mixedPrivatePrompt = compileOfficialH3Prompt(mixedPrivateBoard, mixedPrivateContext).output.prompt;
assert.match(mixedPrivatePrompt, /当前衣物与裸露状态优先/u);
assert.doesNotMatch(mixedPrivatePrompt, /错误旧锚点/u);
assert.doesNotMatch(mixedPrivatePrompt, /服装：深青长袍/u, 'private references must not defeat dynamic-clothing subject rules');

const mixedPrivateFingerprint = buildOfficialH3SourceFingerprint(mixedPrivateBoard, mixedPrivateContext);
assert.notEqual(
  buildOfficialH3SourceFingerprint(mixedPrivateBoard, {
    ...mixedPrivateContext,
    assets: mixedPrivateContext.assets.map((asset) => asset.id === heroPenisPrivate.id
      ? { ...asset, checksum: 'qualified-private-reference-changed' }
      : asset),
  }),
  mixedPrivateFingerprint,
  'a qualified private reference must participate in the official source fingerprint',
);
assert.equal(
  buildOfficialH3SourceFingerprint(mixedPrivateBoard, {
    ...mixedPrivateContext,
    assets: mixedPrivateContext.assets.map((asset) => asset.id === heroScrotumPrivate.id
      ? { ...asset, checksum: 'rejected-private-reference-changed' }
      : asset),
  }),
  mixedPrivateFingerprint,
  'a rejected/mismatched private image must not pollute or expire the official prompt',
);

const oversizedOfficialBoard = makeBoard({
  inputMode: 'text',
  finalPrompt: `【0s-5s】主体：@无名主角；动作：${'不可删除的连续剧情动作必须完整发生'.repeat(600)}；空间：青石演武场；光影：冷蓝月光；镜头：中景缓慢推进；台词：无；音效：环境层-[雨声] 动作层-[无] 情绪层-[无配乐]。`,
  shots: [makeShot({ referenceAssetIds: [] })],
});
const oversizedOfficial = applyOfficialH3Prompt(oversizedOfficialBoard, { ...context, assets: [] });
assert.ok(oversizedOfficial.officialPromptZh!.length > 7000, 'the fixture must exceed the retired local limit');
assert.ok(oversizedOfficial.officialPromptZh!.includes('不可删除的连续剧情动作必须完整发生'.repeat(600)), 'long canonical actions must remain complete in the saved official output');
assert.equal(oversizedOfficial.targetOutput!.prompt, oversizedOfficial.officialPromptZh);
assert.equal(hasCurrentOfficialH3Prompt(oversizedOfficial, { ...context, assets: [] }), true);
assert.equal(oversizedOfficial.finalPrompt, oversizedOfficialBoard.finalPrompt);
assert.deepEqual(oversizedOfficial.shots, oversizedOfficialBoard.shots);

// Fingerprints must move when any source that affects the official prompt
// changes: canonical timeline, referenced asset metadata, or entity bible data.
const baselineBoard = makeBoard();
const baselineFingerprint = buildOfficialH3SourceFingerprint(baselineBoard, context);
assert.notEqual(
  buildOfficialH3SourceFingerprint(
    { ...baselineBoard, finalPrompt: `${baselineBoard.finalPrompt} 结果状态改变。` },
    context,
  ),
  baselineFingerprint,
  'changing the canonical timeline must invalidate the official prompt source',
);
assert.notEqual(
  buildOfficialH3SourceFingerprint(
    baselineBoard,
    { ...context, assets: [{ ...compositePicture, visualAnchor: '改后的画风锚点' }] },
  ),
  baselineFingerprint,
  'changing a referenced asset anchor must invalidate the official prompt source',
);
assert.notEqual(
  buildOfficialH3SourceFingerprint(
    baselineBoard,
    { ...context, characters: [{ ...hero, appearance: '银白长发、眉骨清晰' }, sidekick] },
  ),
  baselineFingerprint,
  'changing a visible entity profile must invalidate the official prompt source',
);

const applied = applyOfficialH3Prompt(baselineBoard, context);
assert.equal(hasCurrentOfficialH3Prompt(applied, context), true);
assert.match(applied.officialPromptSource || '', /^official-h3-v7:/u);

// A prompt-only refresh keeps workflow-owned controls, but never imports a
// different target's settings or lets stale compiled fields win over the board.
const workflowParameters = {
  seed: 32550334118382,
  steps: 15,
  cfg: 1,
  sampler_name: 'res_2s',
  scheduler: 'simple',
  audio_denoise_strength: 1,
  customWorkflow: { audioSteps: 15, videoSteps: 15 },
};
for (const targetAlias of ['minimax-h3', 'h3', 'minimaxh3', '']) {
  const parameterBoard = {
    ...applied,
    targetModelId: targetAlias,
    targetOutput: {
      ...applied.targetOutput!,
      targetId: targetAlias || 'minimax-h3',
      parameters: {
        ...workflowParameters,
        ...applied.targetOutput!.parameters,
        model: 'obsolete-model',
        durationSec: 99,
        duration: 99,
        aspectRatio: '9:16',
        resolution: 'obsolete-resolution',
        audioMode: 'none',
      },
    },
  };
  const parameterSnapshot = JSON.stringify(parameterBoard);
  assert.deepEqual(
    mergeOfficialH3Parameters(parameterBoard, applied.targetOutput!.parameters),
    { ...workflowParameters, ...applied.targetOutput!.parameters },
    'the shared single-segment/sequence refresh helper must preserve the same workflow controls',
  );
  assert.deepEqual(
    applyOfficialH3Prompt(parameterBoard, context).targetOutput?.parameters,
    { ...workflowParameters, ...applied.targetOutput!.parameters },
    `same-target ${targetAlias || 'legacy inferred H3'} refresh must preserve workflow controls and recompile standard fields`,
  );
  assert.equal(JSON.stringify(parameterBoard), parameterSnapshot, 'parameter refresh must not mutate its source');
}
for (const [boardTarget, outputTarget] of [
  ['minimax-h3', 'veo-3.1'],
  ['veo-3.1', 'minimax-h3'],
  ['minimax-h3', 'unknown-target'],
]) {
  const switchedTarget = applyOfficialH3Prompt({
    ...applied,
    targetModelId: boardTarget,
    targetOutput: {
      ...applied.targetOutput!,
      targetId: outputTarget,
      parameters: { ...workflowParameters, model: outputTarget },
    },
  }, context);
  assert.deepEqual(
    switchedTarget.targetOutput?.parameters,
    applied.targetOutput?.parameters,
    `switching ${boardTarget}/${outputTarget} to H3 must not import another target's parameters`,
  );
}
assert.deepEqual(
  mergeOfficialH3Parameters({
    ...applied,
    targetOutput: {
      ...applied.targetOutput!,
      parameters: workflowParameters,
    },
  }, { model: 'veo-3.1', generateAudio: true }),
  { model: 'veo-3.1', generateAudio: true },
  'the H3 parameter helper must not leak H3 controls into a different compiled target',
);

// Images generated by this storyboard are downstream outputs, not new source
// facts. Binding one back to its shot (the normal image-batch completion path)
// must not expire an already compiled official H3 delivery prompt. A generated
// image that the user explicitly promotes to a global reference remains a
// source input and must still invalidate the old compilation.
const generatedStoryboardAsset: ReferenceAsset = {
  id: 'generated-storyboard-shot-1',
  name: '剧情分镜 · 第 1 镜分镜图片',
  type: 'reference',
  role: 'composition',
  mediaType: 'image',
  source: 'generated',
  sourceStoryboardId: baselineBoard.id,
  sourceShotId: 'shot-1',
  checksum: 'generated-checksum-v1',
  visualAnchor: '自动生成的本镜连续性画面',
  tags: ['剧情分镜'],
  createdAt: 2,
  updatedAt: 2,
};
const generatedContext: OfficialH3ProjectContext = {
  ...context,
  assets: [...context.assets, generatedStoryboardAsset],
};
const generatedOutputBoard: Storyboard = {
  ...applied,
  shots: applied.shots.map((shot) => shot.id === 'shot-1'
    ? { ...shot, referenceAssetIds: [...shot.referenceAssetIds, generatedStoryboardAsset.id] }
    : shot),
  firstFrameAssetId: generatedStoryboardAsset.id,
};
assert.equal(
  hasCurrentOfficialH3Prompt(generatedOutputBoard, generatedContext),
  true,
  'an automatically generated storyboard output must not expire the official H3 prompt',
);
assert.equal(
  buildOfficialH3CompileInput(generatedOutputBoard, generatedContext).references?.some(
    (reference) => reference.id === generatedStoryboardAsset.id,
  ),
  false,
  'automatic storyboard outputs must stay out of the official source reference manifest',
);
const promotedGeneratedOutputBoard: Storyboard = {
  ...generatedOutputBoard,
  globalReferenceAssetIds: [generatedStoryboardAsset.id],
};
assert.equal(
  hasCurrentOfficialH3Prompt(promotedGeneratedOutputBoard, generatedContext),
  false,
  'a generated image explicitly selected as a global reference must invalidate the old prompt',
);

// Identity enrichment may supply new image-generation facts, but it cannot
// locally overwrite an AI delivery or relabel its old body as newly reviewed.
const enrichedContext: OfficialH3ProjectContext = {
  ...context,
  characters: [
    { ...hero, appearance: '银白长发、左眉有一道浅疤' },
    sidekick,
  ],
};
const refreshedAfterEnrichment = refreshOfficialH3PromptAfterSourceUpdate(
  applied,
  context,
  enrichedContext,
);
assert.strictEqual(refreshedAfterEnrichment, applied);
assert.equal(hasCurrentOfficialH3Prompt(refreshedAfterEnrichment, enrichedContext), false);
assert.equal(refreshedAfterEnrichment.officialPromptZh, applied.officialPromptZh);
assert.equal(refreshedAfterEnrichment.officialPromptSource, applied.officialPromptSource, 'a new source fingerprint is never forged for an old body');
const staleBeforeEnrichment = {
  ...applied,
  finalPrompt: `${applied.finalPrompt} 后续结果。`,
};
assert.equal(
  refreshOfficialH3PromptAfterSourceUpdate(staleBeforeEnrichment, context, enrichedContext),
  staleBeforeEnrichment,
  'a pre-existing stale official prompt must not be silently recompiled by enrichment',
);
const staleDuringEnrichment = refreshOfficialH3PromptAfterSourceUpdate(
  applied,
  { ...context, characters: [{ ...hero, appearance: '用户在等待期间改过的外貌' }, sidekick] },
  enrichedContext,
);
assert.equal(
  staleDuringEnrichment,
  applied,
  'a prompt made stale by a concurrent source-bible edit must not be revived by automatic enrichment',
);

// The converter can leave harmless trailing whitespace on its canonical text.
// Fingerprint creation and freshness checks must use the same exact source so a
// just-generated official artifact is not reported stale immediately.
const trailingCanonicalBoard = {
  ...baselineBoard,
  promptPlan: {
    canonicalPrompt: `${baselineBoard.finalPrompt} `,
    durationSec: baselineBoard.durationSec,
    aspectRatio: baselineBoard.aspectRatio,
    resolution: baselineBoard.resolution,
    audioMode: baselineBoard.audioMode,
    workflow: baselineBoard.workflow,
    inputMode: baselineBoard.inputMode,
    shotIds: baselineBoard.shots.map((shot) => shot.id),
    referenceAssetIds: [],
    constraints: [],
    trace: { ruleSetId: baselineBoard.ruleSetId, converterId: baselineBoard.converterPresetId },
  },
};
const trailingApplied = applyOfficialH3Prompt(trailingCanonicalBoard, {
  ...context,
  assets: [],
});
assert.equal(
  hasCurrentOfficialH3Prompt(trailingApplied, { ...context, assets: [] }),
  true,
  'trailing canonical whitespace must not invalidate the freshly generated official output',
);

// Legacy persisted boards may use the aliases accepted by modelProfiles. They
// still represent the same H3 artifact; unknown/non-H3 targets must remain
// invalid so this does not weaken freshness or target checks.
const aliasedApplied = {
  ...applied,
  targetModelId: 'h3',
  targetOutput: { ...applied.targetOutput!, targetId: 'minimaxh3' },
};
assert.equal(
  hasCurrentOfficialH3Prompt(aliasedApplied, context),
  true,
  'legacy h3/minimaxh3 aliases should resolve to the official H3 target',
);
const padOfficialPrompt = (length: number, base = applied.officialPromptZh!): string => base + '界'.repeat(Math.max(0, length - base.length));
const legacyOverLimitPrompt = `${applied.officialPromptZh}\n${'旧版官方提示词'.repeat(1001)}`;
assert.ok(legacyOverLimitPrompt.length > 7000);
assert.equal(
  hasCurrentOfficialH3Prompt({
    ...applied,
    officialPromptZh: legacyOverLimitPrompt,
    targetOutput: { ...applied.targetOutput!, prompt: legacyOverLimitPrompt },
  }, context),
  true,
  'a persisted long H3 draft must remain eligible when source and saved output still match',
);

// The outgoing HTTP boundary is shared by first submissions and failed-task
// retries. It must keep validating the saved source and exact request body,
// without enforcing a local character limit for any H3 alias.
const getOfficialH3SubmissionIssue = (
  officialPromptModule as typeof officialPromptModule & {
    getOfficialH3SubmissionIssue?: (
      body: Record<string, unknown>,
      board?: Storyboard,
      projectContext?: OfficialH3ProjectContext,
    ) => string | undefined;
  }
).getOfficialH3SubmissionIssue;
assert.equal(
  typeof getOfficialH3SubmissionIssue,
  'function',
  'the video submission boundary must expose one reusable H3 request guard',
);
const exactLimitPrompt = padOfficialPrompt(7000);
const exactLimitBoard: Storyboard = {
  ...applied,
  officialPromptZh: exactLimitPrompt,
  targetOutput: { ...applied.targetOutput!, prompt: exactLimitPrompt },
};
assert.equal(
  getOfficialH3SubmissionIssue!(
    { model: 'h3', prompt: exactLimitPrompt },
    exactLimitBoard,
    context,
  ),
  undefined,
  'an official H3 request of exactly 7000 JavaScript characters must remain submit-ready',
);
const requestOverLimitPrompt = padOfficialPrompt(25000);
for (const model of ['minimax-h3', 'h3', 'minimaxh3']) {
  const issue = getOfficialH3SubmissionIssue!(
    { model, prompt: requestOverLimitPrompt },
    undefined,
    undefined,
  );
  assert.match(
    issue || '',
    /已失效|尚未生成/u,
    `outgoing ${model} requests still need a current saved artifact, regardless of character count`,
  );
  const longBoard = { ...applied, officialPromptZh: requestOverLimitPrompt, targetOutput: { ...applied.targetOutput!, prompt: requestOverLimitPrompt } };
  assert.equal(getOfficialH3SubmissionIssue!({ model, prompt: requestOverLimitPrompt }, longBoard, context), undefined,
    `a matching current ${model} request must not be blocked at 25000 characters`);
}
assert.equal(getOfficialH3SubmissionIssue!({ model: 'minimax-h3', prompt: oversizedOfficial.officialPromptZh }, oversizedOfficial, { ...context, assets: [] }), undefined,
  'a genuinely compiled and saved long Chinese prompt must remain submit-ready');
assert.match(getOfficialH3SubmissionIssue!({ model: 'minimax-h3', prompt: '  ' }, applied, context) || '', /缺少有效提示词/u);
assert.equal(hasCurrentOfficialH3Prompt({ ...applied, officialPromptZh: ' ', targetOutput: { ...applied.targetOutput!, prompt: ' ' } }, context), false);
assert.equal(
  getOfficialH3SubmissionIssue!(
    { model: 'other-video-model', prompt: requestOverLimitPrompt },
    undefined,
    undefined,
  ),
  undefined,
  'unrelated video models must remain outside the H3 request identity guard',
);
assert.match(
  getOfficialH3SubmissionIssue!(
    { model: 'minimax-h3', prompt: applied.officialPromptZh },
    undefined,
    undefined,
  ) || '',
  /已失效|尚未生成/u,
  'an H3 retry without its source storyboard must not bypass official-artifact validation',
);
assert.match(
  getOfficialH3SubmissionIssue!(
    { model: 'minimax-h3', prompt: '被手工替换的提示词' },
    applied,
    context,
  ) || '',
  /不是当前官方 H3 交付稿/u,
  'a current board must not submit a different manually edited H3 prompt',
);
assert.match(
  getOfficialH3SubmissionIssue!(
    { model: 'minimax-h3', prompt: `${applied.officialPromptZh} ` },
    applied,
    context,
  ) || '',
  /不是当前官方 H3 交付稿/u,
  'even a leading/trailing whitespace edit must not change the exact saved H3 payload',
);
assert.equal(
  hasCurrentOfficialH3Prompt({ ...applied, targetModelId: 'other-video-model' }, context),
  false,
  'an unknown target must not be accepted as official H3',
);
assert.equal(
  hasCurrentOfficialH3Prompt({ ...applied, finalPrompt: `${applied.finalPrompt} 后续结果。` }, context),
  false,
  'an edited canonical prompt must not continue to use the previous official output',
);
assert.equal(
  hasCurrentOfficialH3Prompt(
    { ...applied },
    { ...context, assets: [{ ...compositePicture, checksum: 'picture-checksum-v2' }] },
  ),
  false,
  'a changed referenced asset must invalidate the previous official output',
);
assert.equal(
  hasCurrentOfficialH3Prompt(
    { ...applied },
    { ...context, characters: [{ ...hero, outfit: '黑色短斗篷' }, sidekick] },
  ),
  false,
  'a changed visible character profile must invalidate the previous official output',
);
assert.equal(
  hasCurrentOfficialH3Prompt({ ...applied, targetOutput: { ...applied.targetOutput!, prompt: '被篡改的官方稿' } }, context),
  false,
  'a target output that no longer matches the saved official text is stale',
);

// Re-running with an unchanged Chinese source keeps a valid English sibling;
// changing the Chinese source clears it so stale translation cannot be shown.
const withEnglish = {
  ...applied,
  officialPromptEn: `${applied.officialPromptZh}\nEnglish official prompt`,
  officialPromptEnSource: applied.officialPromptZh,
};
assert.equal(hasCurrentOfficialH3EnglishPrompt(withEnglish, context), true);
const referencesWithAbsentBindings = { ...context, assets: context.assets.map((asset) => ({ ...asset, targetBindings: undefined })) };
const referencesWithEmptyBindings = { ...context, assets: context.assets.map((asset) => ({ ...asset, targetBindings: [] })) };
assert.equal(buildOfficialH3SourceFingerprint(withEnglish, referencesWithAbsentBindings), buildOfficialH3SourceFingerprint(withEnglish, referencesWithEmptyBindings),
  'storage adding empty targetBindings must not invalidate unchanged uploaded references after reload');
assert.notEqual(buildOfficialH3SourceFingerprint(withEnglish, referencesWithEmptyBindings), buildOfficialH3SourceFingerprint(withEnglish, {
  ...context, assets: context.assets.map((asset) => ({ ...asset, targetBindings: ['actual-new-binding'] })),
}), 'nonempty reference binding changes must still invalidate the source fingerprint');
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptEn: ' '.repeat(10) }, context), false);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptEnSource: 'old Chinese source' }, context), false);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptEn: padOfficialPrompt(7000, withEnglish.officialPromptEn) }, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptEn: padOfficialPrompt(7001, withEnglish.officialPromptEn) }, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptEn: `${withEnglish.officialPromptEn}\n${'Long complete English. '.repeat(5000)}` }, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...withEnglish, officialPromptSource: 'old-compiler' }, context), false);
assert.equal(hasCurrentOfficialH3EnglishPrompt(withEnglish, { ...context, assets: [{ ...compositePicture, checksum: 'changed-current-reference' }] }), false);
const qualifiedChineseOnly = {
  ...withEnglish,
  officialPromptEn: '', officialPromptEnSource: '', englishPrompt: '', englishPromptSource: '',
  officialPromptEnError: '英文预算返修后仍超限',
};
assert.equal(hasCurrentOfficialH3Prompt(qualifiedChineseOnly, context), true, 'an English-only failure must leave the qualified Chinese artifact current');
assert.equal(hasCurrentOfficialH3EnglishPrompt(qualifiedChineseOnly, context), false);
assert.equal(
  getOfficialH3SubmissionIssue!(
    { model: 'minimax-h3', prompt: qualifiedChineseOnly.officialPromptZh },
    qualifiedChineseOnly,
    context,
  ),
  undefined,
  'qualified Chinese H3 must remain submit-ready while English is pending',
);
assert.equal(applyOfficialH3Prompt(qualifiedChineseOnly, context).officialPromptEnError, qualifiedChineseOnly.officialPromptEnError, 'unchanged Chinese must retain its actionable English failure');
assert.equal(applyOfficialH3Prompt({ ...qualifiedChineseOnly, finalPrompt: `${qualifiedChineseOnly.finalPrompt} 新动作结果。` }, context).officialPromptEnError, '', 'new Chinese must not inherit an error attached to a different translation source');
const unchangedReapply = applyOfficialH3Prompt(withEnglish, context);
assert.equal(unchangedReapply.officialPromptEn, withEnglish.officialPromptEn);
assert.equal(unchangedReapply.officialPromptEnSource, applied.officialPromptZh);
const changedReapply = applyOfficialH3Prompt(
  { ...withEnglish, finalPrompt: `${withEnglish.finalPrompt} 追加一个结果。` },
  context,
);
assert.equal(changedReapply.officialPromptEn, '');
assert.equal(changedReapply.officialPromptEnSource, '');

// A promptPlan canonical source is authoritative when present.  Mutating it
// without changing the display copy must still make a previous official result
// stale (the source fingerprint and validity check must use the same source).
const plannedBoard = makeBoard({
  promptPlan: {
    canonicalPrompt: '【0s-5s】计划底稿 A',
    durationSec: 5,
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'stereo',
    workflow: 'drama',
    inputMode: 'text_reference',
    shotIds: ['shot-1'],
    referenceAssetIds: ['picture-1'],
    constraints: [],
    trace: { ruleSetId: 'rule-default', converterId: 'converter-default' },
  },
});
const plannedApplied = applyOfficialH3Prompt(plannedBoard, context);
assert.equal(hasCurrentOfficialH3Prompt(plannedApplied, context), true);
const changedPlan = {
  ...plannedApplied,
  promptPlan: { ...plannedApplied.promptPlan!, canonicalPrompt: '【0s-5s】计划底稿 B' },
};
assert.equal(
  hasCurrentOfficialH3Prompt(changedPlan, context),
  false,
  'changing the authoritative promptPlan canonical source must invalidate output even when finalPrompt is unchanged',
);
assert.equal(
  hasCurrentOfficialH3Prompt(changedPlan),
  false,
  'the context-free validity check must use promptPlan.canonicalPrompt too',
);

const authoritativePlanSubjectInput = buildOfficialH3CompileInput(makeBoard({
  finalPrompt: '【0s-5s】主体：画面主体；动作：保持站立；空间：空场；光影：冷光；镜头：中景；台词：无；音效：无。',
  promptPlan: {
    canonicalPrompt: '【0s-5s】主体：@小师妹（女）正在 [抽出软剑]；空间：空场；光影：冷光；镜头：中景；台词：无；音效：无。',
    durationSec: 5,
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'stereo',
    workflow: 'drama',
    inputMode: 'text_reference',
    shotIds: ['shot-1'],
    referenceAssetIds: ['picture-1'],
    constraints: [],
    trace: { ruleSetId: 'rule-default', converterId: 'converter-default' },
  },
  shots: [makeShot({
    subject: '画面主体',
    action: '保持站立',
    camera: '中景',
    result: '保持站立',
    prompt: '',
  })],
}), context);
assert.ok(
  authoritativePlanSubjectInput.subjectDefinitions?.some((subject) => subject.name === '小师妹'),
  'subject detection must use the authoritative promptPlan canonical source instead of stale finalPrompt text',
);

// A persisted segment may already have local shot headers while its AI-authored
// sound fields still contain whole-film times. Refresh the derived delivery
// without rewriting the canonical source, shot data, or its converter trace.
const legacySegmentCanonical = [
  '【0s-4s】 主体：@旅人正在 [踩上松板]；空间：木桥；光影：阴天；镜头：中景；台词：第2s @旅人："第20秒再出发。"；音效：环境层-[溪流持续] 动作层-[第15.3s木板断裂，第15.6s鞋底摩擦] 情绪层-[无配乐]',
  '【4s-9s】 主体：@旅人正在 [收臂后撤]；空间：木桥；光影：阴天；镜头：跟拍；台词：无；音效：环境层-[溪流持续] 动作层-[第19.2s后撤脚步，第20s抓扶，第20.8s碰撞] 情绪层-[无配乐]',
  '【9s-15s】 主体：@旅人正在 [稳住并低头]；空间：木桥；光影：阴天；镜头：近景；台词：无；音效：环境层-[第25s起溪流持续] 动作层-[第24s双脚站定，第27s衣领轻响] 情绪层-[无配乐]',
].join('\r\n');
const legacySegmentBoard = makeBoard({
  sequencePlanId: 'plan-legacy-sound',
  segmentId: 'segment-legacy-sound-2',
  globalStartSec: 15,
  globalEndSec: 30,
  durationSec: 15,
  finalPrompt: legacySegmentCanonical,
  promptPlan: {
    ...plannedBoard.promptPlan!,
    canonicalPrompt: legacySegmentCanonical,
    durationSec: 15,
  },
  shots: [
    makeShot({ startSec: 0, endSec: 4, sound: '第15.3s木板断裂' }),
    makeShot({ id: 'shot-2', startSec: 4, endSec: 9, sound: '第19.2s后撤脚步' }),
    makeShot({ id: 'shot-3', startSec: 9, endSec: 15, sound: '第25s起溪流持续' }),
  ],
});
const legacySegmentSnapshot = JSON.stringify(legacySegmentBoard);
const normalizedLegacyInput = buildOfficialH3CompileInput(legacySegmentBoard, context);
assert.equal(
  normalizedLegacyInput.canonicalPrompt,
  legacySegmentCanonical
    .replace('第15.3s', '第0.3s').replace('第15.6s', '第0.6s')
    .replace('第19.2s', '第0.2s').replace('第20s抓扶', '第1s抓扶')
    .replace('第20.8s', '第1.8s').replace('第25s', '第1s')
    .replace('第24s', '第0s').replace('第27s', '第3s'),
  'persisted segment sound cues must be rebased for H3 while preserving dialogue and all other canonical text',
);
const refreshedLegacyBoard = applyOfficialH3Prompt(legacySegmentBoard, context);
assert.equal(JSON.stringify(legacySegmentBoard), legacySegmentSnapshot, 'H3 compatibility compilation must not mutate its source');
assert.strictEqual(refreshedLegacyBoard.shots, legacySegmentBoard.shots, 'refresh must retain the original shots');
assert.equal(refreshedLegacyBoard.finalPrompt, legacySegmentCanonical, 'refresh must retain the raw converter output');
assert.equal(refreshedLegacyBoard.promptPlan?.canonicalPrompt, legacySegmentCanonical, 'refresh must not rewrite the canonical IR');
assert.match(refreshedLegacyBoard.officialPromptZh || '', /第0\.2s后撤脚步/u);
assert.doesNotMatch(refreshedLegacyBoard.officialPromptZh || '', /第(?:15\.3|19\.2|20\.8|24|25|27)s/u);
assert.match(refreshedLegacyBoard.officialPromptZh || '', /第20秒再出发/u, 'quoted dialogue numbers must remain unchanged');
assert.match(refreshedLegacyBoard.officialPromptZh || '', /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A/u);
assert.equal(hasCurrentOfficialH3Prompt(refreshedLegacyBoard, context), true);
for (const oldVersion of ['official-h3-v1:', 'official-h3-v2:', 'official-h3-v3:', 'official-h3-v4:', 'official-h3-v5:', 'official-h3-v6:']) {
  const oldCompilerArtifact = {
    ...refreshedLegacyBoard,
    officialPromptSource: refreshedLegacyBoard.officialPromptSource?.replace(/^official-h3-v\d+:/u, oldVersion),
  };
  assert.equal(hasCurrentOfficialH3Prompt(oldCompilerArtifact, context), false, 'previous compiler artifacts must become refreshable after upgrading');
  assert.equal(hasCurrentOfficialH3Prompt(oldCompilerArtifact), false, 'context-free exports must also reject previous compiler artifacts');
}

const legacyNoisePrompt = [
  'integrated_multimodal_description: [Shot 1] continuous damp forest floor noise',
  '',
  'overall_soundscape: 溪流持续；continuous damp forest floor noise',
  '',
  'non_diegetic_music: N/A',
].join('\n');
const legacyNoiseBoard: Storyboard = {
  ...legacySegmentBoard,
  targetModelId: 'minimax-h3',
  targetOutput: {
    ...refreshedLegacyBoard.targetOutput!,
    prompt: legacyNoisePrompt,
    parameters: { ...refreshedLegacyBoard.targetOutput!.parameters, ...workflowParameters },
  },
  officialPromptZh: legacyNoisePrompt,
  officialPromptSource: refreshedLegacyBoard.officialPromptSource?.replace(/^official-h3-v\d+:/u, 'official-h3-v2:'),
  officialPromptEn: 'old English continuous ambience',
  officialPromptEnSource: legacyNoisePrompt,
  promptTrace: {
    modelRuleSetId: 'rule-default',
    converterPresetId: 'converter-default',
    sourceDocumentIds: ['document-1'],
    referenceAssetIds: ['picture-1'],
    generatedAt: 1,
    mode: 'text-api',
    shotPlanMode: 'ai-complete',
    convertedPromptFingerprint: 'unchanged-converter-trace',
  },
};
const legacyNoiseSnapshot = JSON.stringify(legacyNoiseBoard);
const refreshedNoiseBoard = applyOfficialH3Prompt(legacyNoiseBoard, context);
assert.equal(JSON.stringify(legacyNoiseBoard), legacyNoiseSnapshot, 'noise-policy refresh must not mutate the saved source board');
assert.strictEqual(refreshedNoiseBoard.shots, legacyNoiseBoard.shots, 'noise-policy refresh must not regenerate shots');
assert.strictEqual(refreshedNoiseBoard.promptPlan, legacyNoiseBoard.promptPlan, 'noise-policy refresh must not rewrite canonical IR');
assert.strictEqual(refreshedNoiseBoard.promptTrace, legacyNoiseBoard.promptTrace, 'noise-policy refresh must keep the AI conversion identity');
assert.equal(refreshedNoiseBoard.finalPrompt, legacyNoiseBoard.finalPrompt, 'noise-policy refresh must retain the original converter output');
assert.deepEqual(refreshedNoiseBoard.targetOutput?.parameters, legacyNoiseBoard.targetOutput?.parameters, 'removing the continuous noise bed must not alter seed or any generation parameter');
assert.doesNotMatch(refreshedNoiseBoard.officialPromptZh || '', /溪流持续|continuous damp forest floor noise/u);
assert.match(refreshedNoiseBoard.officialPromptZh || '', /第0\.2s后撤脚步/u, 'discrete action sounds stay in their original shot');
assert.match(refreshedNoiseBoard.officialPromptZh || '', /第20秒再出发/u, 'spoken dialogue must remain intact');
assert.match(refreshedNoiseBoard.officialPromptZh || '', /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A/u);
assert.equal(refreshedNoiseBoard.officialPromptEn, '', 'the old English noise prompt must not survive a changed Chinese delivery');
assert.equal(refreshedNoiseBoard.officialPromptEnSource, '');
assert.equal(hasCurrentOfficialH3Prompt(refreshedNoiseBoard, context), true);

const alreadyRelativeBoard = makeBoard({
  ...legacySegmentBoard,
  finalPrompt: normalizedLegacyInput.canonicalPrompt,
  promptPlan: { ...legacySegmentBoard.promptPlan!, canonicalPrompt: normalizedLegacyInput.canonicalPrompt },
});
assert.equal(
  buildOfficialH3CompileInput(alreadyRelativeBoard, context).canonicalPrompt,
  normalizedLegacyInput.canonicalPrompt,
  'already-relative cues must not be rebased a second time',
);

console.log('official H3 prompt regression checks passed');
