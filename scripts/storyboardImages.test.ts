import assert from 'node:assert/strict';
import * as storyboardImageHelpers from '../src/storyboardImages';
import {
  bindStoryboardImageAsset,
  buildStoryboardImageAssetVisualAnchor,
  buildCustomStoryboardImageRequests,
  buildStoryboardImageRequestFromFrame,
  buildSelectedStoryboardImageRequests,
  buildStoryboardImageRequests,
  runStoryboardImageBatch,
  selectStoryboardImageReferences,
  storyboardImageSourceFingerprint,
} from '../src/storyboardImages';
import type { StoryboardImageGenerationRequest, StoryboardImageRequest } from '../src/storyboardImages';
import { createStoryboardImageNameAllocator, storyboardImageBoardLabel } from '../src/storyboardImageNames';
import { safeFileName } from '../src/storage';
import {
  createImageGenerationTask,
  isImageGenerationTask,
  patchImageGenerationTask,
} from '../src/generationTasks';
import { enqueueImageTask } from '../src/imageTaskQueue';
import type {
  Character,
  GenerationTask,
  Location,
  Prop,
  ReferenceAsset,
  Scene,
  Storyboard,
  VideoShot,
} from '../src/types';

const makeShot = (index: number, patch: Partial<VideoShot> = {}): VideoShot => ({
  id: `shot-${index}`,
  index,
  startSec: (index - 1) * 3,
  endSec: index * 3,
  purpose: `推进第${index}段剧情`,
  subject: index === 1 ? '阿莲站在封闭石门前' : index === 3 ? '阿莲与石门后的守卫' : '阿莲穿过石门甬道',
  action: index === 1 ? '右手按住门环，身体前倾准备推门' : index === 3 ? '收剑停步，与守卫对视' : '沿甬道快速前行并警觉观察两侧',
  camera: index === 1 ? '低机位中景缓慢推进' : index === 3 ? '双人对峙中景，镜头静止' : '侧后方跟拍',
  transition: '动作连续衔接',
  lighting: index === 1 ? '冷月光勾勒轮廓，门缝透出暖光' : index === 3 ? '火把暖光照亮双方脸部' : '墙面蓝色反光与远处火光交替',
  sound: '环境声',
  result: index === 1 ? '石门刚被推开一道缝隙' : index === 3 ? '双方隔着三步距离形成僵持' : '阿莲抵达甬道尽头',
  referenceAssetIds: [],
  prompt: `第${index}镜权威剧情画面描述`,
  locked: false,
  ...patch,
});

const storyboard: Storyboard = {
  id: 'board-story',
  sceneId: 'scene-story',
  sourceStoryTitle: '石门后的守卫',
  sourceStoryContent: '阿莲在月夜推开封闭石门，穿过狭长甬道，最终在火把前与守卫对峙。',
  workflow: 'drama',
  inputMode: 'text',
  durationSec: 9,
  durationPreset: '10s',
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  stylePresetId: 'cinematic',
  ruleSetId: 'rule',
  converterPresetId: 'converter',
  visualStyle: '电影写实，冷暖对比，人物造型连续',
  globalLock: '阿莲始终是黑色长发、青色长衣、腰间铜铃；石门纹样和甬道结构保持一致。',
  shots: [makeShot(1), makeShot(2), makeShot(3)],
  finalPrompt: '完整视频提示词',
  createdAt: 1,
  updatedAt: 1,
};

const shotRequests = buildStoryboardImageRequests(storyboard, 'storyboard-shots');
assert.deepEqual(
  buildSelectedStoryboardImageRequests(storyboard, ['shot-2'], undefined).map((request) => request.shotId),
  ['shot-2'],
  'selected storyboard image generation must create requests only for checked shots',
);
const namingContext = {
  characters: [], locations: [], props: [], scenes: [], assets: [], projectName: '云海归舟',
};
const namedStoryboard = { ...storyboard, id: 'storyboard_mtny5043_hsfw90' };
const projectNameRequests = buildStoryboardImageRequests(namedStoryboard, 'storyboard-shots', namingContext);
assert.deepEqual(
  projectNameRequests.map((request) => request.name),
  [1, 2, 3].map((index) => `云海归舟 · 方案 HSFW90 · 第 ${index} 镜分镜图片`),
  'generated image names must identify both the project and the originating storyboard',
);
const otherBoardRequests = buildStoryboardImageRequests(
  { ...namedStoryboard, id: 'storyboard_mtnw19t4_gwa72z' }, 'storyboard-shots', namingContext,
);
assert.equal(new Set([...projectNameRequests, ...otherBoardRequests].map((request) => request.name)).size, 6,
  'two storyboard plans for the same scene and shot numbers must have different names');
assert.equal(storyboardImageBoardLabel(namedStoryboard.id), '方案 HSFW90');
assert.notEqual(storyboardImageBoardLabel('imported-board-1'), storyboardImageBoardLabel('imported-board-2'));
const priorAsset: ReferenceAsset = {
  id: 'prior-frame', name: projectNameRequests[0].name,
  type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1,
};
const repeatedRequests = buildSelectedStoryboardImageRequests(namedStoryboard, ['shot-1'], {
  ...namingContext,
  assets: [priorAsset, { ...priorAsset, id: 'duplicate-legacy-output' }],
  generationTaskNames: [`${priorAsset.name} · 第 2 版`],
});
assert.equal(repeatedRequests[0].name, `${priorAsset.name} · 第 3 版`,
  're-generation must reserve existing asset names and queued task names before creating results');
assert.equal(priorAsset.name, projectNameRequests[0].name, 'naming must not mutate existing assets');
const renamedAssetRequest = buildSelectedStoryboardImageRequests(namedStoryboard, ['shot-1'], {
  ...namingContext,
  assets: [{ ...priorAsset, name: '手工改名后的旧图片', fileName: `${priorAsset.name}.png` }],
})[0];
assert.equal(renamedAssetRequest.name, `${priorAsset.name} · 第 2 版`,
  'renaming an old display name must not allow its unchanged export filename to collide with a new image');
const duplicateIndexRequests = buildStoryboardImageRequests({
  ...namedStoryboard,
  shots: [makeShot(1), makeShot(1, { id: 'another-shot-1' })],
}, 'storyboard-shots', namingContext);
assert.equal(new Set(duplicateIndexRequests.map((request) => request.name)).size, 2,
  'even imported duplicate shot numbers must reserve separate names inside one batch');
const segmentRequest = buildStoryboardImageRequests({ ...namedStoryboard, segmentIndex: 2 }, 'storyboard-shots', namingContext)[0];
assert.match(segmentRequest.name, /方案 HSFW90 · 第 2 段 · 第 1 镜分镜图片$/u);
const firstBoundaryNames = buildStoryboardImageRequests(namedStoryboard, 'boundary-frames', namingContext);
const repeatedBoundaries = buildStoryboardImageRequests(namedStoryboard, 'boundary-frames', {
  ...namingContext, generationTaskNames: firstBoundaryNames.map((request) => request.name),
});
assert.deepEqual(repeatedBoundaries.map((request) => request.name), firstBoundaryNames.map((request) => `${request.name} · 第 2 版`));
const longTitleNames = buildStoryboardImageRequests(namedStoryboard, 'storyboard-shots', {
  ...namingContext, projectName: '超长项目名称'.repeat(50),
}).map((request) => request.name);
assert.equal(new Set(longTitleNames.map((name) => safeFileName(name).slice(0, 160))).size, 3,
  'filename truncation must retain the distinguishing storyboard and shot suffixes');
assert.ok(longTitleNames.every((name) => name.length <= 140 && /镜分镜图片$/u.test(name)));
const emojiName = buildStoryboardImageRequests(namedStoryboard, 'storyboard-shots', {
  ...namingContext, projectName: `${'a'.repeat(59)}😀`,
})[0].name;
assert.doesNotMatch(emojiName, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, 'clipping a long title must not split an emoji');
const allocateWindowsName = createStoryboardImageNameAllocator(['A_B', 'a_b · 第 2 版']);
assert.equal(allocateWindowsName('A:B'), 'A:B · 第 3 版', 'case and illegal-character sanitization must not create duplicate Windows filenames');
assert.equal(createStoryboardImageNameAllocator(['Σ'])('ς'), 'ς · 第 2 版', 'Windows-equivalent Unicode case variants must also reserve a unique export name');
const allocateLongName = createStoryboardImageNameAllocator([]);
const longBase = '长'.repeat(200);
assert.notEqual(allocateLongName(longBase), allocateLongName(longBase));
assert.equal(repeatedRequests[0].conversionSource, projectNameRequests[0].conversionSource,
  'unique names must not change the image prompt or story facts',
);
const imagePromptTrace = {
  imagePromptRuleSetId: 'image-rule-openai-gpt-image',
  imagePromptRuleSetVersion: '1.0.0',
  imagePromptPresetId: 'image-preset-storyboard',
  imagePromptPresetVersion: '1.0.0',
  imagePromptFormat: 'natural-language',
} as const;
type StoryboardImagePromptTracePatch = Partial<Pick<
  StoryboardImageGenerationRequest,
  | 'imagePromptRuleSetId'
  | 'imagePromptRuleSetVersion'
  | 'imagePromptPresetId'
  | 'imagePromptPresetVersion'
  | 'imagePromptFormat'
>>;
const withImagePromptTrace = <T extends StoryboardImageRequest>(
  request: T,
  patch: StoryboardImagePromptTracePatch = {},
): StoryboardImageGenerationRequest => ({
  ...request,
  ...imagePromptTrace,
  ...patch,
});
const tracedShotRequests = shotRequests.map((request) => withImagePromptTrace(request));
const customFramePlans = [
  { sourceShotId: 'shot-1', description: '阿莲右手刚握住门环，石门仍闭合。', timeSec: 0.2 },
  { sourceShotId: 'shot-1', description: '阿莲身体微微前倾，门环受力，石门仍未开启。', timeSec: 1.1 },
  { sourceShotId: 'shot-1', description: '石门刚开出一道窄缝，阿莲保持前倾姿势。', timeSec: 2.6 },
  { sourceShotId: 'shot-2', description: '阿莲位于甬道中部，侧脸受墙面蓝色反光照亮。', timeSec: 4.2 },
  { sourceShotId: 'shot-3', description: '阿莲停步与守卫隔着三步距离对视，火把位于画面右侧。', timeSec: 8.4 },
];
const beforeCustomPlanning = JSON.stringify(storyboard);
const customFrameRequests = buildCustomStoryboardImageRequests(storyboard, customFramePlans, namingContext);
assert.equal(customFrameRequests.length, 5, 'custom image total is independent of the three video shots');
assert.deepEqual(customFrameRequests.map((request) => request.shotId), customFramePlans.map((frame) => frame.sourceShotId));
assert.deepEqual(customFrameRequests.map((request) => request.imageFrameIndex), [1, 2, 3, 4, 5]);
assert.ok(customFrameRequests.every((request) => request.imageFrameCount === 5));
assert.equal(JSON.stringify(storyboard), beforeCustomPlanning, 'image planning must not mutate the video shots, timing or source');
customFrameRequests.forEach((request, offset) => {
  assert.equal(request.imageFrameDescription, customFramePlans[offset].description);
  assert.equal(request.imageFrameTimeSec, customFramePlans[offset].timeSec);
  assert.ok(request.conversionSource.includes(customFramePlans[offset].description));
  assert.match(request.conversionSource, /^当前图片规划优先：只表现 AI 选定的本张静帧中实际可见的人物、局部与单个瞬间/u);
  assert.match(request.conversionSource, /完整人物名单、动作过程和结束状态不要求全部入画/u);
  assert.match(request.conversionSource, /最终 H3 明确的站位、机位、身体侧别与在画\/画外状态始终有效/u);
  assert.match(request.name, new RegExp(`第 ${offset + 1}/5 张分镜图片$`, 'u'));
  assert.match(request.conversionSource, /来源镜头.*连续性背景/u);
  assert.equal(
    buildStoryboardImageRequestFromFrame(storyboard, request.shotId, request, namingContext).conversionSource,
    request.conversionSource,
    'regeneration must restore the same AI-selected moment rather than reverting to one default frame per shot',
  );
});
assert.equal(new Set(customFrameRequests.map((request) => safeFileName(request.name))).size, 5);
assert.equal(buildCustomStoryboardImageRequests(storyboard, customFramePlans.slice(0, 1)).length, 1,
  'a custom count smaller than the video shot count is also supported');
const customSingleShot = { ...storyboard, shots: [storyboard.shots[0]], shotCount: 1, durationSec: 3 };
assert.equal(buildCustomStoryboardImageRequests(customSingleShot, customFramePlans.slice(0, 3)).length, 3,
  'one long video shot may produce several AI-selected stills without becoming several video shots');
assert.deepEqual(customSingleShot.shots, [storyboard.shots[0]]);
const repeatedCustomFrames = buildCustomStoryboardImageRequests(storyboard, customFramePlans, {
  ...namingContext, generationTaskNames: customFrameRequests.map((request) => request.name),
});
assert.deepEqual(repeatedCustomFrames.map((request) => request.name), customFrameRequests.map((request) => `${request.name} · 第 2 版`));
assert.throws(
  () => buildCustomStoryboardImageRequests(storyboard, [{ sourceShotId: 'deleted-shot', description: '已不存在的镜头。' }]),
  /来源镜头已不存在/u,
  'missing source IDs are a data-integrity error, never a reason to choose another shot locally',
);
const customFingerprint = storyboardImageSourceFingerprint(storyboard, withImagePromptTrace(customFrameRequests[0]));
assert.notEqual(customFingerprint, storyboardImageSourceFingerprint(storyboard, tracedShotRequests[0]));
for (const changedFrame of [
  { imageFrameDescription: 'AI 重新选择了同一来源镜头内的另一个瞬间。' },
  { imageFrameIndex: 2 },
  { imageFrameCount: 6 },
  { imageFrameTimeSec: 0.9 },
]) {
  assert.notEqual(
    storyboardImageSourceFingerprint(storyboard, withImagePromptTrace({ ...customFrameRequests[0], ...changedFrame })),
    customFingerprint,
    'distinct AI frame descriptors and image positions need distinct stale-result identities',
  );
}
assert.notEqual(
  storyboardImageSourceFingerprint({ ...storyboard, shots: storyboard.shots.map((shot, index) => index === 0
    ? { ...shot, action: '用户把原动作改成松开门环。' } : shot) }, withImagePromptTrace(customFrameRequests[0])),
  customFingerprint,
  'a frozen frame descriptor must not conceal edits to its underlying source shot',
);
assert.equal(shotRequests.length, storyboard.shots.length, 'one storyboard image is required for every actual generated shot');
assert.match(shotRequests[0].conversionSource, /^当前镜事实优先：先确定本张时刻的机位、取景与可见范围/u,
  'ordinary one-frame-per-shot generation resolves framing before visible identity detail');
shotRequests.forEach((request, offset) => {
  const shot = storyboard.shots[offset];
  assert.equal(request.purpose, 'storyboard-shot');
  assert.equal(request.storyboardId, storyboard.id);
  assert.equal(request.shotId, shot.id);
  assert.equal(request.shotIndex, shot.index);
  assert.equal(request.assetKind, 'storyboard');
  assert.equal(request.assetType, 'reference');
  assert.equal(request.assetRole, 'composition');
  assert.equal(request.referenceRole, 'composition');
  assert.equal(request.imageVariant, 'storyboard-frame');
  assert.ok(request.width > request.height, 'a 16:9 storyboard must request a landscape canvas');
  assert.match(request.conversionSource, new RegExp(storyboard.sourceStoryContent || '', 'u'));
  for (const detail of [shot.purpose, shot.subject, shot.action, shot.camera, shot.lighting, shot.result, shot.prompt]) {
    assert.match(request.conversionSource, new RegExp(detail, 'u'), `shot ${shot.index} converter source omitted its own plot detail: ${detail}`);
  }
  assert.match(request.conversionSource, /严格依据当前剧情和当前镜头/u);
  assert.match(request.conversionSource, /禁止字幕、文字、Logo、水印/u);
});
assert.match(
  shotRequests[1]?.conversionSource || '',
  new RegExp(storyboard.shots[0]?.result || '', 'u'),
  'a later storyboard image must inherit the previous shot visible result as its entry state',
);

const contextCharacter: Character = {
  id: 'character-a-lian',
  name: '阿莲',
  gender: '女',
  apparentAge: '',
  race: '人类',
  appearance: '乌黑长发，眉间一颗小痣，窄长眼形',
  outfit: '青色棉麻长衣、黑色布靴、深灰护腕',
  signatureProps: '腰间铜铃',
  personality: '沉静果断',
  motionHabits: '移动时右手下意识护住腰间铜铃',
  anchor: '所有镜头保持乌黑长发、眉间小痣和青色长衣',
  negativeContinuity: '不得改变发色、服装主色或铜铃位置',
  assetIds: ['asset-character-a-lian'],
};
const contextLocation: Location = {
  id: 'location-stone-gate',
  name: '石门甬道',
  description: '两人宽的狭长青石甬道，墙面有连续莲纹凹槽',
  timeWeather: '月夜，室内干燥',
  lighting: '入口冷月光，尽头火把暖光',
  palette: '青灰与暗橙',
  fixedProps: '铜质门环、右墙三支火把',
  anchor: '甬道始终沿东西轴延伸，火把固定在右墙',
  assetIds: [],
};
const contextProp: Prop = {
  id: 'prop-bell',
  name: '铜铃',
  category: '随身物品',
  material: '旧铜',
  appearance: '拇指大小，表面有莲瓣刻纹，系黑色短绳',
  effect: '移动时轻微摆动',
  stateRules: '始终固定在阿莲右侧腰间，不得凭空消失',
  assetIds: ['asset-prop-bell'],
};
const contextScene: Scene = {
  id: storyboard.sceneId,
  title: '进入石门',
  content: storyboard.sourceStoryContent || '',
  summary: '阿莲穿过石门甬道',
  characterIds: [contextCharacter.id],
  locationId: contextLocation.id,
  locationIds: [contextLocation.id],
  propIds: [contextProp.id],
  storyboardIds: [storyboard.id],
  createdAt: 1,
  updatedAt: 1,
};
const explicitShotReference: ReferenceAsset = {
  id: 'asset-shot-explicit',
  name: '用户绑定的阿莲构图图',
  type: 'reference',
  role: 'composition',
  dataUrl: 'data:image/png;base64,AA==',
  mediaType: 'image',
  referenceRole: 'composition',
  source: 'upload',
  visualAnchor: '阿莲右手按住门环的推门构图',
  prompt: '旧版资产最终生图提示词：阿莲左耳后有金色三角印记',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const globalStoryboardReference: ReferenceAsset = {
  ...explicitShotReference,
  id: 'asset-global-storyboard-reference',
  name: '第10镜全局人物与画风参考',
  dataUrl: 'data:image/png;base64,BA==',
};
const characterReference: ReferenceAsset = {
  id: 'asset-character-a-lian',
  name: '阿莲角色参考图',
  type: 'character',
  role: 'character',
  dataUrl: 'data:image/png;base64,AQ==',
  mediaType: 'image',
  referenceRole: 'character',
  source: 'generated',
  sourceEntityId: contextCharacter.id,
  sourceEntityKind: 'character',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const locationReference: ReferenceAsset = {
  id: 'asset-location-stone-gate',
  name: '石门甬道参考图',
  type: 'location',
  role: 'scene',
  dataUrl: 'data:image/png;base64,Ag==',
  mediaType: 'image',
  referenceRole: 'scene',
  source: 'generated',
  sourceEntityId: contextLocation.id,
  sourceEntityKind: 'location',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const propReference: ReferenceAsset = {
  id: 'asset-prop-bell',
  name: '铜铃参考图',
  type: 'prop',
  role: 'prop',
  dataUrl: 'data:image/png;base64,Aw==',
  mediaType: 'image',
  referenceRole: 'prop',
  source: 'generated',
  sourceEntityId: contextProp.id,
  sourceEntityKind: 'prop',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const boardWithExplicitShotReference: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.map((shot, index) => index === 0
    ? { ...shot, referenceAssetIds: [explicitShotReference.id] }
    : shot),
};
type StoryboardImageBuildContextFixture = {
  characters: readonly Character[];
  locations: readonly Location[];
  props: readonly Prop[];
  scenes: readonly Scene[];
  assets: readonly ReferenceAsset[];
  visibleCharacterNamesByShotId?: Readonly<Record<string, readonly string[]>>;
  projectName?: string;
};
const buildRequestsWithContext = buildStoryboardImageRequests as unknown as (
  board: Storyboard,
  mode: 'storyboard-shots',
  context: StoryboardImageBuildContextFixture,
) => Array<(typeof shotRequests)[number] & { referenceAssetIds?: string[] }>;
const contextRequests = buildRequestsWithContext(boardWithExplicitShotReference, 'storyboard-shots', {
  characters: [contextCharacter],
  locations: [contextLocation],
  props: [contextProp],
  scenes: [contextScene],
  assets: [explicitShotReference, characterReference, locationReference, propReference],
});
const tracedContextRequests = contextRequests.map((request) => withImagePromptTrace(request));
const contextualSource = contextRequests[0]?.conversionSource || '';
const closeupCustomSource = buildCustomStoryboardImageRequests(boardWithExplicitShotReference, [{
  sourceShotId: 'shot-1', description: '门环与阿莲握住门环的右手特写，画面内不见人物的脸或身体。',
}], {
  characters: [contextCharacter], locations: [contextLocation], props: [contextProp], scenes: [contextScene],
  assets: [explicitShotReference, characterReference, locationReference, propReference],
})[0].conversionSource;
assert.match(closeupCustomSource, /来源视频镜头人物身份资料：以下资料仅供 AI 已选定静帧中的实际可见人物保持身份/u);
assert.match(closeupCustomSource, /未在本张静帧中出现的人物不必入画，不得为了列全身份资料而添加人物/u);
assert.doesNotMatch(closeupCustomSource, /以下每名人物的全部非空身份与外貌事实都必须逐人写入最终提示词/u,
  'a hand close-up must not inherit a rule that forces every source-shot character into the picture');
assert.ok(closeupCustomSource.includes(contextCharacter.appearance),
  'source-shot identity facts remain available to the AI as context without becoming required visible subjects');
assert.match(contextualSource, /按本镜可见范围保留对应人物必要身份与外貌/u,
  'ordinary per-shot sources must also avoid turning invisible dossier facts into mandatory pixels');
for (const detail of [
  contextCharacter.gender,
  contextCharacter.appearance,
  contextCharacter.outfit,
  contextCharacter.anchor,
  contextLocation.description,
  contextLocation.lighting,
  contextLocation.fixedProps,
  contextProp.appearance,
  contextProp.stateRules,
]) {
  assert.match(contextualSource, new RegExp(detail, 'u'), `converter input omitted project continuity detail: ${detail}`);
}
assert.doesNotMatch(
  contextualSource,
  /左耳后有金色三角印记/u,
  '历史资产的完整生图 prompt 不再回灌当前构图；稳定身份使用人物资料与实际参考像素',
);
assert.deepEqual(
  contextRequests[0]?.referenceAssetIds,
  [explicitShotReference.id, characterReference.id, locationReference.id, propReference.id],
  'explicit shot references must lead matched character, location and prop references without duplicates',
);
assert.deepEqual(
  contextRequests[0]?.primaryReferenceAssetIds,
  [explicitShotReference.id],
  'a user-selected per-shot reference must be mandatory while inferred entity assets remain supplemental',
);

const temporaryFoodProp: Prop = {
  ...contextProp,
  id: 'prop-lotus-dish',
  name: '灵藕小碟',
  category: '临时购买的食物',
  appearance: '荷叶小碟中盛着数片浅白灵藕',
  stateRules: '只在当前剧情仍持有或桌面可见时出现，不是人物长期装备。',
  assetIds: ['asset-lotus-dish'],
};
const temporarySwordProp: Prop = {
  ...contextProp,
  id: 'prop-borrowed-sword',
  name: '借来的短剑',
  category: '武器',
  stateRules: '本场较量结束后已经交还主人。',
  assetIds: ['asset-borrowed-sword'],
};
const temporaryFoodReference: ReferenceAsset = {
  ...propReference,
  id: temporaryFoodProp.assetIds[0],
  name: '灵藕小碟参考图',
  sourceEntityId: temporaryFoodProp.id,
  visualAnchor: '旧时刻人物手捧灵藕小碟的画面',
};
const temporarySwordReference: ReferenceAsset = {
  ...propReference,
  id: temporarySwordProp.assetIds[0],
  name: '借来的短剑参考图',
  sourceEntityId: temporarySwordProp.id,
};
const transientPropBoard: Storyboard = {
  ...storyboard,
  sourceStoryContent: '阿莲在集市买过灵藕小碟，又借过借来的短剑；这些事件结束后，她独自穿过石门甬道。',
  shots: [makeShot(1, {
    subject: '阿莲在石门甬道中行走',
    action: '双手自然下垂，向前走去',
    result: '阿莲站在甬道尽头',
    prompt: '阿莲独自穿过青灰甬道，双手自然下垂。',
  })],
  shotCount: 1,
};
const transientPropContext = {
  characters: [contextCharacter],
  locations: [contextLocation],
  props: [contextProp, temporaryFoodProp, temporarySwordProp],
  scenes: [{
    ...contextScene,
    propIds: [contextProp.id, temporaryFoodProp.id, temporarySwordProp.id],
  }],
  assets: [characterReference, locationReference, propReference, temporaryFoodReference, temporarySwordReference],
};
const transientPropSnapshot = JSON.stringify({ board: transientPropBoard, context: transientPropContext });
const transientPropRequest = buildStoryboardImageRequests(transientPropBoard, 'storyboard-shots', transientPropContext)[0];
assert.ok(!transientPropRequest.referenceAssetIds.includes(temporaryFoodReference.id),
  'a scene-level or past-story food prop must not automatically attach its pixels to every later shot');
assert.ok(!transientPropRequest.referenceAssetIds.includes(temporarySwordReference.id),
  'a sword is not automatically stable equipment merely because it belongs to the weapon category');
assert.ok(transientPropRequest.referenceAssetIds.includes(propReference.id),
  'genuine stable equipment must retain its supplementary reference');
for (const detail of [storyboard.visualStyle, contextCharacter.outfit, contextLocation.description, temporaryFoodProp.appearance]) {
  assert.ok(detail);
  assert.ok(transientPropRequest.conversionSource.includes(detail),
    'routing fewer prop images must not erase world, wardrobe, setting or candidate prop facts');
}
assert.match(transientPropRequest.conversionSource, /场景道具“灵藕小碟”候选资料（只在本张可见时采用）/u);
assert.match(transientPropRequest.conversionSource, /自动关联的道具参考图都是候选依据/u);
assert.match(transientPropRequest.conversionSource, /AI 按当前镜头或选帧的时刻判断实际可见道具/u);
assert.match(transientPropRequest.conversionSource, /手持、交接、放下、吃完等动作状态不得从别的时刻或参考图姿态继承/u);
assert.equal(JSON.stringify({ board: transientPropBoard, context: transientPropContext }), transientPropSnapshot,
  'reference routing must not rewrite saved character, scene, storyboard or asset data');

const foodActionBoard: Storyboard = {
  ...transientPropBoard,
  shots: [{
    ...transientPropBoard.shots[0],
    action: '阿莲接过灵藕小碟',
    result: '阿莲把灵藕小碟放在石桌上，双手离开小碟',
    prompt: '阿莲把灵藕小碟放下，最后小碟留在石桌上，双手已空。',
  }],
};
const foodActionRequest = buildStoryboardImageRequests(foodActionBoard, 'storyboard-shots', transientPropContext)[0];
assert.ok(foodActionRequest.referenceAssetIds.includes(temporaryFoodReference.id),
  'a currently named prop stays available even after a put-down action; name routing must not classify visible state');
assert.match(foodActionRequest.conversionSource, /不沿用旧图的手持动作/u);
const foodBoundaries = buildStoryboardImageRequests(foodActionBoard, 'boundary-frames', transientPropContext);
assert.ok(!foodBoundaries[0].referenceAssetIds.includes(temporaryFoodReference.id),
  'a future handover must not attach its food image to an entry frame that has no such prop');
assert.ok(foodBoundaries[1].referenceAssetIds.includes(temporaryFoodReference.id));
const foodCustomFrames = buildCustomStoryboardImageRequests(foodActionBoard, [
  { sourceShotId: 'shot-1', description: '阿莲走到石桌前，双手自然下垂，桌面尚空。' },
  { sourceShotId: 'shot-1', description: '灵藕小碟已经放在石桌上，阿莲双手离开小碟。' },
], transientPropContext);
assert.ok(!foodCustomFrames[0].referenceAssetIds.includes(temporaryFoodReference.id),
  'an AI-selected intermediate still uses its own text for supplementary prop references, not the whole shot ending');
assert.ok(foodCustomFrames[1].referenceAssetIds.includes(temporaryFoodReference.id));

for (const selection of ['shot', 'global'] as const) {
  const explicitlySelectedFood = buildStoryboardImageRequests({
    ...transientPropBoard,
    globalReferenceAssetIds: selection === 'global' ? [temporaryFoodReference.id] : [],
    shots: transientPropBoard.shots.map((shot) => ({
      ...shot, referenceAssetIds: selection === 'shot' ? [temporaryFoodReference.id] : [],
    })),
  }, 'storyboard-shots', transientPropContext)[0];
  assert.ok(explicitlySelectedFood.primaryReferenceAssetIds.includes(temporaryFoodReference.id),
    'an explicit user selection must remain primary even when not inferred from current moment text');
}
const dossierOnlyPropContext = {
  ...transientPropContext,
  characters: [{ ...contextCharacter, signatureProps: '腰间铜铃，随身灵藕小碟是用户明确设定的身份辨识物' }],
  scenes: [{ ...contextScene, propIds: [contextProp.id] }],
};
const dossierOnlyPropRequest = buildStoryboardImageRequests({
  ...transientPropBoard, sourceStoryContent: '阿莲独自穿过石门甬道。',
}, 'storyboard-shots', dossierOnlyPropContext)[0];
assert.ok(dossierOnlyPropRequest.referenceAssetIds.includes(temporaryFoodReference.id),
  'explicit stable identity equipment is retained without a food-category blacklist or a required scene prop binding');

const referenceHistoryCharacters: Character[] = [
  { ...contextCharacter, id: 'history-sister', name: '小师姐', assetIds: [] },
  { ...contextCharacter, id: 'history-teacher', name: '师尊', assetIds: [] },
];
const referenceHistoryAssets = referenceHistoryCharacters.flatMap((character, characterIndex) => (
  Array.from({ length: characterIndex === 0 ? 8 : 5 }, (_, index): ReferenceAsset => ({
    ...characterReference,
    id: `${character.id}-version-${index + 1}`,
    name: `${character.name}第${index + 1}版`,
    sourceEntityId: character.id,
    imageVariant: index % 2 ? 'portrait' : 'full-body',
    visualAnchor: `${character.name}历史外貌版本${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }))
));
referenceHistoryCharacters.forEach((character) => {
  character.assetIds = referenceHistoryAssets
    .filter((asset) => asset.sourceEntityId === character.id)
    .map((asset) => asset.id)
    .reverse();
});
const referenceHistoryContext = {
  characters: referenceHistoryCharacters,
  locations: [], props: [], scenes: [], assets: referenceHistoryAssets,
  visibleCharacterNamesByShotId: { 'shot-1': ['小师姐', '师尊'] },
};
const historyPool = referenceHistoryAssets.map((asset) => asset.id);
const currentHistoryIds = referenceHistoryCharacters.map((character) => character.assetIds[0]);
const historyBeforeSelection = structuredClone(referenceHistoryContext);
assert.deepEqual(
  selectStoryboardImageReferences(historyPool, [], referenceHistoryContext),
  currentHistoryIds,
  '8 sister history images + 5 teacher history images must automatically contribute only 2 current entity references',
);
const historyBoard: Storyboard = {
  ...storyboard,
  globalLock: '', sourceStoryContent: '小师姐和师尊站在石门前。',
  shots: [makeShot(1, { subject: '小师姐和师尊站在石门前', referenceAssetIds: [] })],
};
const historyRequest = buildStoryboardImageRequests(historyBoard, 'storyboard-shots', referenceHistoryContext)[0];
assert.deepEqual(historyRequest.referenceAssetIds, currentHistoryIds,
  'new storyboard task snapshots must contain the selected references, not all linked image history');
assert.deepEqual(historyRequest.primaryReferenceAssetIds, []);
assert.ok(!historyRequest.conversionSource.includes('小师姐历史外貌版本1'),
  'discarded automatic history must not remain in text converter reference anchors');
assert.ok(!historyRequest.conversionSource.includes('小师姐历史外貌版本8'),
  'even the selected image supplies pixels and role metadata, not historical authored framing anchors');

const selectedSameEntityIds = [historyPool[1], historyPool[0], historyPool[2]];
assert.deepEqual(
  selectStoryboardImageReferences(historyPool, selectedSameEntityIds, referenceHistoryContext),
  [...selectedSameEntityIds, currentHistoryIds[1]],
  'keep every explicitly selected version in order and do not add another automatic version for that entity',
);
const explicitHistoryRequest = buildStoryboardImageRequests({
  ...historyBoard,
  globalReferenceAssetIds: selectedSameEntityIds.slice(0, 2),
  shots: [{ ...historyBoard.shots[0], referenceAssetIds: selectedSameEntityIds.slice(2) }],
}, 'storyboard-shots', referenceHistoryContext)[0];
assert.deepEqual(explicitHistoryRequest.referenceAssetIds, [...selectedSameEntityIds, currentHistoryIds[1]]);
assert.deepEqual(explicitHistoryRequest.primaryReferenceAssetIds, selectedSameEntityIds,
  'global and per-shot explicit references remain mandatory despite automatic history compaction');
assert.deepEqual(selectStoryboardImageReferences(historyPool, historyPool, referenceHistoryContext), historyPool,
  'more than eight explicit references must never be silently reduced');
assert.deepEqual(referenceHistoryContext, historyBeforeSelection, 'reference selection must not edit entity bindings or assets');

const missingCurrentHistoryContext = {
  ...referenceHistoryContext,
  assets: referenceHistoryAssets.map((asset) => asset.id === currentHistoryIds[0] ? { ...asset, missing: true } : asset),
};
assert.deepEqual(selectStoryboardImageReferences(historyPool, [], missingCurrentHistoryContext), [
  referenceHistoryCharacters[0].assetIds[1], currentHistoryIds[1],
], 'a missing preferred image must fall back to the next usable bound version');
assert.deepEqual(selectStoryboardImageReferences(historyPool, [currentHistoryIds[0]], missingCurrentHistoryContext), currentHistoryIds,
  'an explicit missing reference must remain explicit for the loader to report instead of being substituted');
const allMissingHistoryContext = {
  ...referenceHistoryContext,
  assets: referenceHistoryAssets.map((asset) => ({ ...asset, missing: true })),
};
assert.deepEqual(selectStoryboardImageReferences(historyPool, [], allMissingHistoryContext), [historyPool[0], historyPool[8]],
  'wholly missing frozen reference groups must not silently turn a retry into text-to-image');

const unboundHistoryContext = {
  ...referenceHistoryContext,
  characters: referenceHistoryCharacters.map((character) => ({ ...character, assetIds: [] })),
};
assert.deepEqual(selectStoryboardImageReferences(historyPool, [], unboundHistoryContext), currentHistoryIds,
  'when no binding preference exists, source-entity references use the newest creation timestamp');
const reorderedBindingContext = {
  ...referenceHistoryContext,
  characters: referenceHistoryCharacters.map((character, index) => index === 0
    ? { ...character, assetIds: [historyPool[0], ...character.assetIds] }
    : character),
};
assert.deepEqual(selectStoryboardImageReferences(historyPool, [], reorderedBindingContext), [historyPool[0], currentHistoryIds[1]],
  'the entity current binding wins over a newer historical asset');
const frozenHistoryPool = [historyPool[0], historyPool[1], historyPool[8]];
assert.deepEqual(selectStoryboardImageReferences(frozenHistoryPool, [], referenceHistoryContext), [historyPool[1], historyPool[8]],
  'old task retries select only inside their frozen pool and cannot acquire newly generated images');

const legacyHistoryContext = {
  ...referenceHistoryContext,
  assets: referenceHistoryAssets.map((asset) => ({ ...asset, sourceEntityId: undefined, sourceEntityKind: undefined })),
};
assert.deepEqual(selectStoryboardImageReferences(historyPool, [], legacyHistoryContext), currentHistoryIds,
  'legacy images with no source metadata can still be grouped by their real entity assetIds binding');
const unownedNamedReference = { ...explicitShotReference, name: '小师姐和师尊旧图', id: 'unowned-named-reference' };
assert.deepEqual(selectStoryboardImageReferences([unownedNamedReference.id, ...historyPool], [], {
  ...referenceHistoryContext, assets: [...referenceHistoryAssets, unownedNamedReference],
}), [unownedNamedReference.id, ...currentHistoryIds], 'never infer ownership from a matching image name');
const sameIdOtherKindsContext = {
  characters: [{ ...contextCharacter, id: 'shared-entity-id', assetIds: [characterReference.id] }],
  locations: [{ ...contextLocation, id: 'shared-entity-id', assetIds: [locationReference.id] }],
  props: [{ ...contextProp, id: 'shared-entity-id', assetIds: [propReference.id] }],
  assets: [characterReference, locationReference, propReference].map((asset) => ({ ...asset, sourceEntityId: 'shared-entity-id' })),
};
const sameIdDifferentKindIds = sameIdOtherKindsContext.assets.map((asset) => asset.id);
assert.deepEqual(selectStoryboardImageReferences(sameIdDifferentKindIds, [], sameIdOtherKindsContext), sameIdDifferentKindIds,
  'character, location and prop identities must remain separate even if imported entity IDs coincide');

const partHistoryAssets: ReferenceAsset[] = ['ordinary', 'full-body', 'breasts', 'vulva'].flatMap((part) => (
  [1, 2].map((version): ReferenceAsset => ({
    ...characterReference,
    id: `part-history-${part}-${version}`,
    createdAt: version,
    ...(part === 'ordinary' ? {} : {
      referenceScope: 'nsfw-private-profile' as const,
      imageVariant: part === 'full-body' ? 'private-full-body' as const : 'private-close-up' as const,
      nsfwPrivatePart: part as 'full-body' | 'breasts' | 'vulva',
    }),
  }))
));
const partHistoryContext = {
  characters: [{ ...contextCharacter, assetIds: partHistoryAssets.map((asset) => asset.id).reverse() }],
  locations: [], props: [], assets: partHistoryAssets,
};
assert.deepEqual(selectStoryboardImageReferences(partHistoryAssets.map((asset) => asset.id), [], partHistoryContext), [
  'part-history-ordinary-2', 'part-history-full-body-2', 'part-history-breasts-2', 'part-history-vulva-2',
], 'each already-allowed private part keeps its own current image instead of being collapsed into ordinary/full-body identity');
assert.deepEqual(selectStoryboardImageReferences(partHistoryAssets.map((asset) => asset.id), [
  'part-history-ordinary-1', 'part-history-breasts-1',
], partHistoryContext), [
  'part-history-ordinary-1', 'part-history-breasts-1', 'part-history-full-body-2', 'part-history-vulva-2',
], 'explicit ordinary/private part selections suppress only matching automatic groups, not another specialised part');

const staleSamePurposeOutput: ReferenceAsset = {
  ...explicitShotReference,
  id: 'asset-stale-same-purpose-output',
  name: '本镜上一张已被替换的分镜图',
  source: 'generated',
  sourceStoryboardId: storyboard.id,
  sourceShotId: storyboard.shots[0].id,
  imageVariant: 'storyboard-frame',
  visualAnchor: '旧批次互不一致的脸型与发型',
};
const generatedOtherPurposeReference: ReferenceAsset = {
  ...staleSamePurposeOutput,
  id: 'asset-other-purpose-first-frame',
  name: '同镜头的首帧参考',
  imageVariant: 'first-frame',
  visualAnchor: '用户仍可复用的另一用途画面',
};
const generatedOtherShotReference: ReferenceAsset = {
  ...generatedOtherPurposeReference,
  id: 'asset-other-shot-reference',
  name: '其他镜头生成图手工参考',
  sourceShotId: storyboard.shots[1].id,
  visualAnchor: '用户手工绑定的其他镜头构图',
};
const boardWithStaleSamePurposeOutput: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.map((shot, index) => index === 0
    ? {
        ...shot,
        referenceAssetIds: [
          staleSamePurposeOutput.id,
          explicitShotReference.id,
          generatedOtherPurposeReference.id,
          generatedOtherShotReference.id,
        ],
      }
    : shot),
};
const staleOutputRequest = buildStoryboardImageRequests(
  boardWithStaleSamePurposeOutput,
  'storyboard-shots',
  {
    characters: [],
    locations: [],
    props: [],
    scenes: [],
    assets: [
      staleSamePurposeOutput,
      explicitShotReference,
      generatedOtherPurposeReference,
      generatedOtherShotReference,
    ],
  },
)[0];
assert.deepEqual(
  staleOutputRequest.referenceAssetIds,
  [explicitShotReference.id, generatedOtherShotReference.id],
  '所有同镜自动生成输出均不跨用途回流；手工选择的其他镜头参考仍保留',
);
assert.deepEqual(
  staleOutputRequest.primaryReferenceAssetIds,
  [explicitShotReference.id, generatedOtherShotReference.id],
  'manual per-shot references, including an image generated for another shot, are mandatory; only this shot own automatic outputs stay supplemental',
);
assert.doesNotMatch(
  staleOutputRequest.conversionSource,
  /旧批次互不一致的脸型与发型/u,
  '本镜上一张同用途结果的旧脸也不得继续污染新转换输入',
);
const explicitlySelectedOldOutputRequest = buildStoryboardImageRequests(
  {
    ...boardWithStaleSamePurposeOutput,
    globalReferenceAssetIds: [staleSamePurposeOutput.id],
  },
  'storyboard-shots',
  {
    characters: [],
    locations: [],
    props: [],
    scenes: [],
    assets: [
      staleSamePurposeOutput,
      explicitShotReference,
      generatedOtherPurposeReference,
      generatedOtherShotReference,
    ],
  },
)[0];
assert.deepEqual(
  explicitlySelectedOldOutputRequest.primaryReferenceAssetIds,
  [staleSamePurposeOutput.id, explicitShotReference.id, generatedOtherShotReference.id],
  '用户主动勾选为全局参考的旧生成图仍必须保留最高参考优先级，逐镜手工参考紧随其后',
);
assert.equal(explicitlySelectedOldOutputRequest.referenceAssetIds[0], staleSamePurposeOutput.id);

const juniorSister: Character = {
  ...contextCharacter,
  id: 'character-junior-sister',
  name: '小师妹',
  gender: '女',
  race: '人类修士',
  appearance: '鹅蛋脸、细长柳眉、琥珀色杏眼、乌黑长发高束、身形纤细',
  outfit: '月白窄袖练功服、浅蓝腰封、白色软底短靴',
  signatureProps: '银色莲花发簪',
  motionHabits: '出掌前左脚先向前半步',
  anchor: '所有镜头保持鹅蛋脸、琥珀眼、高束黑发和月白练功服',
  negativeContinuity: '不得改变瞳色、发型、服装主色和发簪位置',
  assetIds: [],
};
const seniorBrother: Character = {
  ...contextCharacter,
  id: 'character-senior-brother',
  name: '玄衣师兄',
  gender: '男',
  race: '人类剑修',
  appearance: '方脸、浓直眉、灰黑瞳、短黑发、肩背宽阔',
  outfit: '玄色交领劲装、深棕皮护臂、黑色长靴',
  signatureProps: '腰悬黑鞘长剑',
  motionHabits: '迎击时右肩略沉并先护住剑柄',
  anchor: '所有镜头保持方脸、短黑发、宽肩和玄色劲装',
  negativeContinuity: '不得改变肩宽、服装颜色和长剑佩戴侧',
  assetIds: [],
};
const offscreenMaster: Character = {
  ...contextCharacter,
  id: 'character-offscreen-master',
  name: '掌门',
  gender: '男',
  race: '人类修士',
  appearance: '清瘦长脸、银白长须、深褐眼、灰白发髻',
  outfit: '深紫宽袖法袍与金线云纹披肩',
  signatureProps: '青玉掌门令',
  motionHabits: '说话时右手轻捻长须',
  anchor: '保持银白长须、灰白发髻和深紫法袍',
  negativeContinuity: '不得改变胡须长度、发色和法袍纹样',
  assetIds: [],
};
const dualCharacterShot = makeShot(1, {
  id: 'shot-visible-duo',
  subject: '小师妹位于画面右侧，玄衣师兄位于画面左侧，两人相隔三步',
  action: '小师妹双掌向前推出赤红火浪，玄衣师兄横剑格挡并后撤半步',
  result: '火浪撞上剑脊向两侧分开，两人仍保持对峙',
  prompt: '演武台上小师妹与玄衣师兄正面交手，掌门只在远处大殿闭关且没有出镜',
});
const dualCharacterBoard: Storyboard = {
  ...storyboard,
  id: 'board-visible-duo',
  sceneId: 'scene-visible-duo',
  sourceStoryTitle: '演武台交手',
  sourceStoryContent: '小师妹与玄衣师兄在演武台交手；掌门仍在远处大殿闭关，没有出现在演武台。',
  durationSec: 3,
  shotCount: 1,
  shots: [dualCharacterShot],
  finalPrompt: '【0s-3s】 主体：@小师妹与@玄衣师兄正在演武台交手；@掌门只在画外被提及，明确没有出镜。',
};
const dualCharacterScene: Scene = {
  ...contextScene,
  id: dualCharacterBoard.sceneId,
  title: '演武台双人交手',
  content: dualCharacterBoard.sourceStoryContent || '',
  summary: '小师妹与玄衣师兄交手，掌门未出镜',
  characterIds: [juniorSister.id, seniorBrother.id, offscreenMaster.id],
  storyboardIds: [dualCharacterBoard.id],
};
const dualCharacterSource = buildStoryboardImageRequests(
  dualCharacterBoard,
  'storyboard-shots',
  {
    characters: [juniorSister, seniorBrother, offscreenMaster],
    locations: [],
    props: [],
    scenes: [dualCharacterScene],
    assets: [],
  },
)[0]?.conversionSource || '';
const characterContinuityBlock = (source: string, name: string): string => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return source.match(new RegExp(`人物“${escapedName}”连续性事实：([^\\n]+)`, 'u'))?.[1] || '';
};
const juniorSisterBlock = characterContinuityBlock(dualCharacterSource, juniorSister.name);
const seniorBrotherBlock = characterContinuityBlock(dualCharacterSource, seniorBrother.name);
for (const [character, block] of [
  [juniorSister, juniorSisterBlock],
  [seniorBrother, seniorBrotherBlock],
] as const) {
  assert.ok(block, `the converter input omitted visible character ${character.name}`);
  for (const fact of [
    character.gender,
    character.race,
    character.appearance,
    character.outfit,
    character.signatureProps,
    character.motionHabits,
    character.anchor,
    character.negativeContinuity,
  ]) {
    assert.ok(
      block.includes(fact),
      `${character.name} must carry its own complete stable identity fact: ${fact}`,
    );
  }
}
assert.ok(!juniorSisterBlock.includes(seniorBrother.appearance));
assert.ok(!juniorSisterBlock.includes(seniorBrother.outfit));
assert.ok(!seniorBrotherBlock.includes(juniorSister.appearance));
assert.ok(!seniorBrotherBlock.includes(juniorSister.outfit));
assert.doesNotMatch(
  dualCharacterSource,
  /人物“掌门”连续性事实/u,
  'a character mentioned as explicitly offscreen must not be mixed into the current frame identity context',
);

const directionOnlyShot = makeShot(1, {
  id: 'shot-direction-only-target',
  subject: '小师妹',
  action: '小师妹推出三支水箭贴地射向@玄衣师兄',
  result: '三道湿痕沿攻击方向延伸到画外',
  prompt: '【0s-3s】 主体：@小师妹[朝向：面朝@玄衣师兄]正在[推出水箭射向@玄衣师兄]；空间：前景-青石台面湿痕 中景-@小师妹站在演武台 背景-晨光与围栏；镜头：沿水箭射向前推。',
});
const directionOnlyBoard: Storyboard = {
  ...dualCharacterBoard,
  id: 'board-direction-only-target',
  shots: [directionOnlyShot],
  finalPrompt: directionOnlyShot.prompt,
};
const directionOnlySource = buildStoryboardImageRequests(
  directionOnlyBoard,
  'storyboard-shots',
  {
    characters: [juniorSister, seniorBrother],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
  },
)[0]?.conversionSource || '';
assert.match(directionOnlySource, /人物“小师妹”连续性事实/u);
assert.doesNotMatch(
  directionOnlySource,
  /人物“玄衣师兄”连续性事实/u,
  '朝向、射向或攻击轴线里的 @人物不等于该人物实际出镜',
);

const visibleSecondaryShot = {
  ...directionOnlyShot,
  id: 'shot-visible-secondary',
  prompt: directionOnlyShot.prompt.replace(
    '背景-晨光与围栏',
    '背景-@玄衣师兄横剑格挡与晨光围栏',
  ),
};
const visibleSecondarySource = buildStoryboardImageRequests(
  {
    ...directionOnlyBoard,
    id: 'board-visible-secondary',
    shots: [visibleSecondaryShot],
    finalPrompt: visibleSecondaryShot.prompt,
  },
  'storyboard-shots',
  {
    characters: [juniorSister, seniorBrother],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
  },
)[0]?.conversionSource || '';
assert.match(
  visibleSecondarySource,
  /人物“玄衣师兄”连续性事实/u,
  '前景、中景或背景中明确出现的次要人物仍必须带入完整外貌',
);

const collectiveReferenceShot = makeShot(1, {
  id: 'shot-ai-resolved-collective',
  subject: '两人被蒸汽同时吞没',
  action: '两人隔着翻涌白雾向相反方向后撤',
  result: '蒸汽遮住两人的上半身，只留下相互错开的轮廓',
  prompt: '【0s-3s】 主体：翻涌蒸汽正在吞没两人；空间：中景-两道人形轮廓逐渐被白雾遮住。',
});
const collectiveReferenceBoard: Storyboard = {
  ...dualCharacterBoard,
  id: 'board-ai-resolved-collective',
  shots: [collectiveReferenceShot],
  finalPrompt: collectiveReferenceShot.prompt,
};
const collectiveReferenceContext: StoryboardImageBuildContextFixture = {
  characters: [juniorSister, seniorBrother],
  locations: [],
  props: [],
  scenes: [],
  assets: [],
  visibleCharacterNamesByShotId: {
    [collectiveReferenceShot.id]: ['小师妹', '玄衣师兄'],
  },
};
const collectiveReferenceRequest = buildStoryboardImageRequests(
  collectiveReferenceBoard,
  'storyboard-shots',
  collectiveReferenceContext,
)[0];
for (const character of [juniorSister, seniorBrother]) {
  const block = characterContinuityBlock(collectiveReferenceRequest.conversionSource, character.name);
  assert.ok(block, `AI 解析“两人”后，${character.name} 的身份锁必须进入最终生图转换输入`);
  assert.ok(block.includes(character.appearance));
  assert.ok(block.includes(character.outfit));
}

type BuildStoryboardImageAssetVisualAnchorFixture = (
  board: Storyboard,
  request: StoryboardImageRequest,
  context: StoryboardImageBuildContextFixture,
) => string;
const assetAnchorHelper = storyboardImageHelpers as typeof storyboardImageHelpers & {
  buildStoryboardImageAssetVisualAnchor?: BuildStoryboardImageAssetVisualAnchorFixture;
};
assert.equal(
  typeof assetAnchorHelper.buildStoryboardImageAssetVisualAnchor,
  'function',
  '保存分镜生成图时需要一个统一的人物外貌资产锚点构建边界',
);
assert.ok(assetAnchorHelper.buildStoryboardImageAssetVisualAnchor);
const dualCharacterRequest = buildStoryboardImageRequests(
  dualCharacterBoard,
  'storyboard-shots',
  {
    characters: [juniorSister, seniorBrother, offscreenMaster],
    locations: [],
    props: [],
    scenes: [dualCharacterScene],
    assets: [],
  },
)[0];
const generatedAssetVisualAnchor = assetAnchorHelper.buildStoryboardImageAssetVisualAnchor(
  dualCharacterBoard,
  dualCharacterRequest,
  {
    characters: [juniorSister, seniorBrother, offscreenMaster],
    locations: [],
    props: [],
    scenes: [dualCharacterScene],
    assets: [],
  },
);
for (const fact of [
  juniorSister.gender,
  juniorSister.appearance,
  juniorSister.outfit,
  juniorSister.anchor,
  seniorBrother.gender,
  seniorBrother.appearance,
  seniorBrother.outfit,
  seniorBrother.anchor,
  dualCharacterShot.action,
  dualCharacterShot.result,
]) {
  assert.ok(
    generatedAssetVisualAnchor.includes(fact),
    `生成资产的可见锚点遗漏人物身份或本镜状态：${fact}`,
  );
}
assert.doesNotMatch(
  generatedAssetVisualAnchor,
  /掌门/u,
  '生成资产锚点不得混入明确没有出镜的人物外貌',
);
const collectiveReferenceVisualAnchor = assetAnchorHelper.buildStoryboardImageAssetVisualAnchor(
  collectiveReferenceBoard,
  collectiveReferenceRequest,
  collectiveReferenceContext,
);
for (const character of [juniorSister, seniorBrother]) {
  assert.ok(
    collectiveReferenceVisualAnchor.includes(character.appearance),
    `AI 解析集体代词后，生成资产必须保存 ${character.name} 的完整外貌锚点`,
  );
}

type StoryboardImageIdentityEnrichmentTargetFixture = {
  name: string;
  characterId?: string;
  shotIds: string[];
  reason: 'incomplete-character' | 'missing-character';
  missingFields: string[];
};
type StoryboardImageIdentityEnrichmentPlanFixture = {
  needsAiEnrichment: boolean;
  targets: StoryboardImageIdentityEnrichmentTargetFixture[];
};
type PlanStoryboardImageIdentityEnrichmentFixture = (
  board: Storyboard,
  context: StoryboardImageBuildContextFixture,
) => StoryboardImageIdentityEnrichmentPlanFixture;
type MergeStoryboardImageIdentityEnrichmentFixture = (
  current: readonly Character[],
  details: readonly Record<string, string>[],
  targets: readonly StoryboardImageIdentityEnrichmentTargetFixture[],
  createCharacterId: (name: string) => string,
) => Character[];
type PrepareStoryboardImageIdentityContextFixture = (input: {
  storyboard: Storyboard;
  context: StoryboardImageBuildContextFixture;
  requestVisibleCharacters?: () => Promise<{
    visibleCharacterNamesByShotId: Readonly<Record<string, readonly string[]>>;
  }>;
  requestIdentityDetails: (names: readonly string[]) => Promise<readonly Record<string, string>[]>;
  createCharacterId: (name: string) => string;
}) => Promise<{
  context: StoryboardImageBuildContextFixture;
  plan: StoryboardImageIdentityEnrichmentPlanFixture;
  enriched: boolean;
}>;
const identityEnrichmentHelpers = storyboardImageHelpers as typeof storyboardImageHelpers & {
  planStoryboardImageIdentityEnrichment?: PlanStoryboardImageIdentityEnrichmentFixture;
  mergeStoryboardImageIdentityEnrichment?: MergeStoryboardImageIdentityEnrichmentFixture;
  prepareStoryboardImageIdentityContext?: PrepareStoryboardImageIdentityContextFixture;
  buildStoryboardVisibleCharacterAnalysisShots?: (board: Storyboard) => Array<{
    id: string;
    index: number;
    subject: string;
    action: string;
    result: string;
    description: string;
  }>;
};
assert.equal(
  typeof identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment,
  'function',
  'storyboard image generation needs a planning boundary that requests AI identity enrichment before prompt conversion',
);
assert.ok(identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment);
const missingTaggedIdentityBoard: Storyboard = {
  ...storyboard,
  id: 'board-missing-tagged-identity',
  durationSec: 9,
  shotCount: 3,
  shots: [
    makeShot(1, {
      id: 'shot-missing-tagged-subject',
      subject: '@玄衣师兄',
      action: '玄衣师兄位于画面中央，正面横剑防守',
      prompt: '【0s-3s】 主体：@玄衣师兄；空间：中景-演武台。',
    }),
    makeShot(2, {
      id: 'shot-missing-tagged-space',
      subject: '演武台上的对峙画面',
      action: '玄衣师兄在背景横剑格挡',
      prompt: '【3s-6s】 主体：飞散的火星；空间：前景-火星 中景-空地 背景-@玄衣师兄。',
    }),
    makeShot(3, {
      id: 'shot-missing-tagged-direction-only',
      subject: '三支水箭从画面左侧贴地飞过',
      action: '水箭沿攻击轴线射向@玄衣师兄所在的画外位置',
      prompt: '【6s-9s】 主体：水箭[朝向：@玄衣师兄]贴地飞行；空间：前景-水箭 中景-湿痕 背景-空景。',
    }),
  ],
  finalPrompt: [
    '【0s-3s】 主体：@玄衣师兄；空间：中景-演武台。',
    '【3s-6s】 主体：飞散的火星；空间：前景-火星 中景-空地 背景-@玄衣师兄。',
    '【6s-9s】 主体：水箭[朝向：@玄衣师兄]贴地飞行；空间：前景-水箭 中景-湿痕 背景-空景。',
  ].join('\n'),
};
const missingTaggedIdentityPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  missingTaggedIdentityBoard,
  {
    characters: [],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
  },
);
assert.deepEqual(
  missingTaggedIdentityPlan.targets.map(({ name, reason, shotIds }) => ({ name, reason, shotIds })),
  [{
    name: '玄衣师兄',
    reason: 'missing-character',
    shotIds: ['shot-missing-tagged-subject'],
  }],
  '空人物库要发现结构化主体中的明确 @角色；自由空间文本和朝向目标都不得被猜成新人物',
);

const normalGeneratedSubjectBoard: Storyboard = {
  ...storyboard,
  id: 'board-normal-generated-subject',
  durationSec: 3,
  shotCount: 1,
  shots: [makeShot(1, {
    id: 'shot-normal-generated-subject',
    subject: '玄衣师兄',
    action: '横剑挡在身前',
    prompt: '【0s-3s】 主体：@玄衣师兄（警觉）正在[横剑挡在身前]；空间：中景-演武台。',
  })],
  finalPrompt: '【0s-3s】 主体：@玄衣师兄（警觉）正在[横剑挡在身前]；空间：中景-演武台。',
};
const normalGeneratedSubjectPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  normalGeneratedSubjectBoard,
  { characters: [], locations: [], props: [], scenes: [], assets: [] },
);
assert.deepEqual(
  normalGeneratedSubjectPlan.targets.map(({ name, shotIds }) => ({ name, shotIds })),
  [{ name: '玄衣师兄', shotIds: ['shot-normal-generated-subject'] }],
  '标准时间头后的结构化 @主体必须在空人物库中触发外貌补齐，不能要求 shot.subject 自带 @',
);
assert.equal(
  typeof identityEnrichmentHelpers.buildStoryboardVisibleCharacterAnalysisShots,
  'function',
  '逐镜实际出镜 AI 与最终生图请求必须共用同一份权威镜头描述',
);
assert.ok(identityEnrichmentHelpers.buildStoryboardVisibleCharacterAnalysisShots);
const handEditedFinalPrompt = '【0s-3s】 主体：@玄衣师兄（警觉）正在[从背景横剑上前]；空间：中景-玄衣师兄完整入镜。';
const authoritativeVisibilityRows = identityEnrichmentHelpers.buildStoryboardVisibleCharacterAnalysisShots({
  ...normalGeneratedSubjectBoard,
  finalPrompt: handEditedFinalPrompt,
  shots: normalGeneratedSubjectBoard.shots.map((shot) => ({
    ...shot,
    prompt: '这是手工编辑最终提示词之前的旧镜头描述',
  })),
});
assert.equal(
  authoritativeVisibilityRows[0]?.description,
  handEditedFinalPrompt,
  '手工编辑全片最终提示词后，AI 出镜解析不能继续读取旧 shot.prompt',
);

const aiResolvedVisibleSecondaryPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  missingTaggedIdentityBoard,
  {
    characters: [],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
    visibleCharacterNamesByShotId: {
      'shot-missing-tagged-subject': ['玄衣师兄'],
      'shot-missing-tagged-space': ['玄衣师兄'],
      'shot-missing-tagged-direction-only': [],
    },
  },
);
assert.deepEqual(
  aiResolvedVisibleSecondaryPlan.targets.map(({ name, reason, shotIds }) => ({ name, reason, shotIds })),
  [{
    name: '玄衣师兄',
    reason: 'missing-character',
    shotIds: ['shot-missing-tagged-subject', 'shot-missing-tagged-space'],
  }],
  'AI 给出的逐镜实际出镜名单必须发现空间背景里的缺失次要人物，同时排除只作为朝向目标的人物',
);

const attachedActionTagBoard: Storyboard = {
  ...storyboard,
  id: 'board-attached-action-tag',
  durationSec: 3,
  shotCount: 1,
  shots: [makeShot(1, {
    id: 'shot-attached-action-tag',
    subject: '小师妹',
    action: '小师妹站在演武台对面抬手结印',
    prompt: '【0s-3s】 主体：@小师妹（警惕）正在[抬手结印]；空间：前景-湿润青石 中景-@小师妹站在演武台对面 背景-山门与晨雾。',
  })],
  finalPrompt: '【0s-3s】 主体：@小师妹（警惕）正在[抬手结印]；空间：前景-湿润青石 中景-@小师妹站在演武台对面 背景-山门与晨雾。',
};
const attachedActionTagPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  attachedActionTagBoard,
  {
    characters: [{
      ...juniorSister,
      id: 'attached-action-junior-sister',
      gender: '',
      race: '',
      appearance: '',
      outfit: '',
      anchor: '',
    }],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
  },
);
assert.deepEqual(
  attachedActionTagPlan.targets.map(({ name }) => name),
  ['小师妹'],
  '自由文本中 @角色名后紧连动作时，不得把“角色名+动作/站位”整段误存成新人物',
);
const legacyEmptyCharacter: Character = {
  ...juniorSister,
  id: 'legacy-empty-junior-sister',
  gender: '',
  race: '',
  appearance: '',
  outfit: '',
  signatureProps: '',
  motionHabits: '',
  anchor: '',
  negativeContinuity: '',
};
const identityGapBoard: Storyboard = {
  ...storyboard,
  id: 'board-identity-gaps',
  sceneId: 'scene-identity-gaps',
  sourceStoryTitle: '身份资料缺口',
  sourceStoryContent: '小师妹守在山门前，无名主角从林中赶来与她会合。',
  durationSec: 6,
  shotCount: 2,
  shots: [
    makeShot(1, {
      id: 'shot-legacy-empty-character',
      subject: '小师妹独自守在山门右侧',
      action: '小师妹握紧剑柄并回头望向树林',
      prompt: '山门前的小师妹听见林中脚步声',
    }),
    makeShot(2, {
      id: 'shot-missing-unnamed-protagonist',
      subject: '无名主角从画面左侧林中赶到山门前',
      action: '无名主角停在小师妹身前三步并抬手示意',
      prompt: '无名主角与小师妹在山门前会合',
    }),
  ],
  finalPrompt: [
    '【0s-3s】 主体：@小师妹守在山门前。',
    '【3s-6s】 主体：@无名主角从林中赶来与@小师妹会合。',
  ].join('\n'),
};
const identityGapScene: Scene = {
  ...contextScene,
  id: identityGapBoard.sceneId,
  title: '山门会合',
  content: identityGapBoard.sourceStoryContent || '',
  summary: '小师妹与无名主角会合',
  characterIds: [legacyEmptyCharacter.id],
  storyboardIds: [identityGapBoard.id],
};
const identityPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  identityGapBoard,
  {
    characters: [legacyEmptyCharacter],
    locations: [],
    props: [],
    scenes: [identityGapScene],
    assets: [],
  },
);
assert.equal(identityPlan.needsAiEnrichment, true);
const incompleteLegacyTarget = identityPlan.targets.find((item) => item.name === '小师妹');
assert.equal(incompleteLegacyTarget?.reason, 'incomplete-character');
assert.equal(incompleteLegacyTarget?.characterId, legacyEmptyCharacter.id);
assert.deepEqual(incompleteLegacyTarget?.shotIds, [
  'shot-legacy-empty-character',
  'shot-missing-unnamed-protagonist',
]);
for (const field of ['gender', 'race', 'appearance', 'outfit', 'anchor']) {
  assert.ok(
    incompleteLegacyTarget?.missingFields.includes(field),
    `legacy empty character must request AI completion for ${field}`,
  );
}
assert.ok(
  !incompleteLegacyTarget?.missingFields.includes('apparentAge'),
  'an unstated age must remain optional and must not trigger identity enrichment',
);
const missingProtagonistTarget = identityPlan.targets.find((item) => item.name === '无名主角');
assert.equal(missingProtagonistTarget?.reason, 'missing-character');
assert.equal(missingProtagonistTarget?.characterId, undefined);
assert.deepEqual(missingProtagonistTarget?.shotIds, ['shot-missing-unnamed-protagonist']);
for (const field of ['gender', 'race', 'appearance', 'outfit', 'anchor']) {
  assert.ok(
    missingProtagonistTarget?.missingFields.includes(field),
    `missing unnamed protagonist must request AI completion for ${field}`,
  );
}
assert.equal(
  typeof identityEnrichmentHelpers.mergeStoryboardImageIdentityEnrichment,
  'function',
  'AI-completed identity facts need one immutable merge boundary before per-shot prompt conversion',
);
assert.ok(identityEnrichmentHelpers.mergeStoryboardImageIdentityEnrichment);
const legacyWithUserOutfit: Character = {
  ...legacyEmptyCharacter,
  outfit: '用户已经确认的月白窄袖练功服',
};
const mergedIdentityCharacters = identityEnrichmentHelpers.mergeStoryboardImageIdentityEnrichment(
  [legacyWithUserOutfit, offscreenMaster],
  [
    {
      name: '小师妹',
      gender: '女',
      race: '人类修士',
      appearance: '鹅蛋脸、琥珀色杏眼、乌黑长发高束、身形纤细',
      outfit: 'AI 不得覆盖的蓝色练功服',
      signatureProps: '银色莲花发簪',
      personality: '倔强好胜',
      motionHabits: '出掌前左脚先向前半步',
      anchor: '固定鹅蛋脸、琥珀眼、高束黑发和月白练功服',
      negativeContinuity: '不得改变瞳色、发型与服装主色',
    },
    {
      name: '无名主角',
      gender: '男',
      race: '人类修士',
      appearance: '棱角分明的脸、深褐眼、黑发高束、肩背挺拔',
      outfit: '深青交领劲装、黑色护腕与长靴',
      signatureProps: '腰间旧铜令牌',
      personality: '沉稳果断',
      motionHabits: '结印前右脚后撤半步',
      anchor: '固定棱角脸、深褐眼、高束黑发与深青劲装',
      negativeContinuity: '不得改变脸型、发色、体态和服装主色',
    },
    {
      name: '未请求的旁观者',
      gender: '女',
      race: '人类',
      appearance: '不应写入项目',
      outfit: '不应写入项目',
      anchor: '不应写入项目',
    },
  ],
  identityPlan.targets,
  (name) => `ai-character-${name}`,
);
const mergedJuniorSister = mergedIdentityCharacters.find((item) => item.name === '小师妹');
assert.equal(mergedJuniorSister?.id, legacyWithUserOutfit.id, 'an existing character keeps its stable id');
assert.equal(
  mergedJuniorSister?.outfit,
  legacyWithUserOutfit.outfit,
  'AI identity enrichment must not overwrite a non-empty user-authored fact',
);
assert.equal(mergedJuniorSister?.appearance, '鹅蛋脸、琥珀色杏眼、乌黑长发高束、身形纤细');
const mergedUnnamedProtagonist = mergedIdentityCharacters.find((item) => item.name === '无名主角');
assert.equal(mergedUnnamedProtagonist?.id, 'ai-character-无名主角');
assert.equal(mergedUnnamedProtagonist?.appearance, '棱角分明的脸、深褐眼、黑发高束、肩背挺拔');
assert.deepEqual(mergedUnnamedProtagonist?.assetIds, []);
assert.ok(
  !mergedIdentityCharacters.some((item) => item.name === '未请求的旁观者'),
  'the enrichment response must not inject an unrequested character',
);
assert.equal(
  mergedIdentityCharacters.find((item) => item.id === offscreenMaster.id)?.appearance,
  offscreenMaster.appearance,
  'unrelated existing characters remain unchanged',
);

// Only explicitly classified non-human identities request structure fields;
// local race/appearance keywords must not reclassify an automatic identity.
const incompleteNonHuman: Character = {
  ...legacyEmptyCharacter,
  id: 'legacy-incomplete-nonhuman',
  name: '壳兽',
  gender: '无性',
  race: '六足甲壳巨兽',
  appearance: '黑色甲壳、昆虫口器、蓝色发光纹理',
  outfit: '无',
  anchor: '六足甲壳与蓝色发光纹理保持一致',
  morphology: undefined,
  bodyPlan: '',
};
const nonHumanIdentityBoard: Storyboard = {
  ...storyboard,
  id: 'board-nonhuman-identity',
  shots: [makeShot(1, {
    id: 'shot-nonhuman-identity',
    subject: '@壳兽',
    action: '壳兽以六足支撑身体爬过石台',
    prompt: '【0s-3s】主体：@壳兽；空间：中景-石台。',
  })],
  finalPrompt: '【0s-3s】主体：@壳兽；空间：中景-石台。',
};
const nonHumanIdentityPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  nonHumanIdentityBoard,
  { characters: [incompleteNonHuman], locations: [], props: [], scenes: [], assets: [] },
);
assert.deepEqual(nonHumanIdentityPlan.targets, [], 'free-form species wording must not introduce local morphology requirements');
const explicitNonHumanIdentity = { ...incompleteNonHuman, morphology: 'monster' as const };
const explicitNonHumanIdentityPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  nonHumanIdentityBoard,
  { characters: [explicitNonHumanIdentity], locations: [], props: [], scenes: [], assets: [] },
);
assert.ok(explicitNonHumanIdentityPlan.targets[0]?.missingFields.includes('bodyPlan'));
const mergedNonHuman = identityEnrichmentHelpers.mergeStoryboardImageIdentityEnrichment(
  [explicitNonHumanIdentity],
  [{
    name: '壳兽',
    morphology: '六足甲壳怪物',
    bodyPlan: '六足、分节躯干、昆虫口器，无人类头部和双足人体结构',
  }],
  explicitNonHumanIdentityPlan.targets,
  (name) => `resolved-${name}`,
);
assert.equal(mergedNonHuman[0]?.morphology, 'monster');
assert.match(mergedNonHuman[0]?.bodyPlan || '', /六足/u);
assert.match(mergedNonHuman[0]?.bodyPlan || '', /分节躯干/u);
for (const authoredText of ['未知', '待补充', '根据剧情', '无资料', '默认']) {
  let identityCalls = 0;
  const completedContext = await storyboardImageHelpers.prepareStoryboardImageIdentityContext({
    storyboard: nonHumanIdentityBoard,
    context: {
      characters: [{ ...explicitNonHumanIdentity, gender: '', race: '', appearance: '', outfit: '', anchor: '', bodyPlan: '' }],
      locations: [], props: [], scenes: [], assets: [],
    },
    requestIdentityDetails: async () => {
      identityCalls += 1;
      return [{ name: '壳兽', gender: authoredText, race: authoredText, appearance: authoredText, outfit: authoredText, anchor: authoredText, bodyPlan: authoredText }];
    },
    createCharacterId: (name) => `completed-${name}`,
  });
  assert.equal(identityCalls, 1, 'nonempty AI fields must not cause local missing-detail repairs');
  const savedIdentity = completedContext.context.characters.find((character) => character.name === '壳兽');
  for (const field of ['gender', 'race', 'appearance', 'outfit', 'anchor', 'bodyPlan'] as const) {
    assert.equal(savedIdentity?.[field], authoredText, `${field}: nonempty AI facts survive storyboard image preparation`);
  }
  const followupPlan = storyboardImageHelpers.planStoryboardImageIdentityEnrichment(nonHumanIdentityBoard, completedContext.context);
  assert.deepEqual(followupPlan.targets, [], 'nonempty authored words are not missing fields for the next batch');
}
const humanWithoutMorphology = {
  ...juniorSister,
  id: 'human-without-morphology',
  morphology: undefined,
  bodyPlan: '',
};
const humanIdentityPlan = identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
  {
    ...nonHumanIdentityBoard,
    id: 'board-human-identity',
    shots: [makeShot(1, {
      id: 'shot-human-identity',
      subject: '@小师妹',
      action: '小师妹站在石台边',
      prompt: '【0s-3s】主体：@小师妹；空间：中景-石台。',
    })],
    finalPrompt: '【0s-3s】主体：@小师妹；空间：中景-石台。',
  },
  { characters: [humanWithoutMorphology], locations: [], props: [], scenes: [], assets: [] },
);
assert.deepEqual(
  humanIdentityPlan.targets,
  [],
  'ordinary human identity enrichment must not require new morphology fields',
);

// Whole-image human-anatomy negatives are safe only for homogeneous
// non-human shots.  A mixed shot must keep the human cast drawable; its
// non-human identity is protected by the per-character morphology lines.
const mixedHuman = {
  ...humanWithoutMorphology,
  id: 'mixed-human',
  name: '小师妹',
  race: '人类',
  appearance: '黑发、清晰人类脸型',
};
const mixedNonHuman: Character = {
  ...legacyEmptyCharacter,
  id: 'mixed-nonhuman',
  name: '壳兽',
  race: '六足甲壳巨兽',
  appearance: '黑色甲壳、昆虫口器、六足',
  morphology: 'monster',
  bodyPlan: '六足、分节躯干、昆虫口器',
};
const mixedShotBoard: Storyboard = {
  ...storyboard,
  id: 'board-mixed-morphology',
  shots: [makeShot(1, {
    id: 'shot-mixed-morphology',
    subject: '@小师妹与@壳兽并肩站在石台前',
    action: '小师妹举剑，壳兽以六足支撑身体',
    prompt: '【0s-3s】主体：@小师妹与@壳兽；空间：中景-石台。',
  })],
};
const mixedMorphologyRequest = buildStoryboardImageRequests(
  mixedShotBoard,
  'storyboard-shots',
  { characters: [mixedHuman, mixedNonHuman], locations: [], props: [], scenes: [], assets: [] },
)[0];
assert.equal(
  storyboardImageHelpers.getStoryboardMorphologyNegativePrompt(
    mixedShotBoard,
    mixedMorphologyRequest,
    { characters: [mixedHuman, mixedNonHuman], locations: [], props: [], scenes: [], assets: [] },
  ),
  '',
  'mixed human/non-human shots must not apply a global human-face negative prompt',
);
const nonHumanOnlyBoard = {
  ...mixedShotBoard,
  id: 'board-nonhuman-only-morphology',
  shots: [makeShot(1, {
    id: 'shot-nonhuman-only-morphology',
    subject: '@壳兽爬过石台',
    action: '壳兽以六足支撑身体爬行',
    prompt: '【0s-3s】主体：@壳兽；空间：中景-石台。',
  })],
};
const nonHumanOnlyRequest = buildStoryboardImageRequests(
  nonHumanOnlyBoard,
  'storyboard-shots',
  { characters: [mixedNonHuman], locations: [], props: [], scenes: [], assets: [] },
)[0];
assert.match(
  storyboardImageHelpers.getStoryboardMorphologyNegativePrompt(
    nonHumanOnlyBoard,
    nonHumanOnlyRequest,
    { characters: [mixedNonHuman], locations: [], props: [], scenes: [], assets: [] },
  ),
  /人类头部/u,
  'homogeneous non-human shots retain the global structure guard',
);
assert.equal(
  typeof identityEnrichmentHelpers.prepareStoryboardImageIdentityContext,
  'function',
  'storyboard image generation needs one converter-independent AI identity preparation stage',
);
assert.ok(identityEnrichmentHelpers.prepareStoryboardImageIdentityContext);
let visibleCastRequests = 0;
const aiResolvedSecondaryContext = await identityEnrichmentHelpers.prepareStoryboardImageIdentityContext({
  storyboard: missingTaggedIdentityBoard,
  context: {
    characters: [],
    locations: [],
    props: [],
    scenes: [],
    assets: [],
  },
  requestVisibleCharacters: async () => {
    visibleCastRequests += 1;
    return {
      visibleCharacterNamesByShotId: {
        'shot-missing-tagged-subject': ['玄衣师兄'],
        'shot-missing-tagged-space': ['玄衣师兄'],
        'shot-missing-tagged-direction-only': [],
      },
    };
  },
  requestIdentityDetails: async () => [{
    name: '玄衣师兄',
    gender: '男',
    race: '人类剑修',
    appearance: '方脸、浓直眉、灰黑瞳、短黑发、肩背宽阔',
    outfit: '玄色交领劲装、深棕皮护臂、黑色长靴',
    anchor: '所有镜头保持方脸、短黑发、宽肩和玄色劲装',
  }],
  createCharacterId: (name) => `resolved-${name}`,
});
assert.equal(visibleCastRequests, 1, '每批生图开始前必须让文本 AI 统一解析逐镜实际出镜人物');
assert.deepEqual(
  aiResolvedSecondaryContext.plan.targets[0]?.shotIds,
  ['shot-missing-tagged-subject', 'shot-missing-tagged-space'],
);
assert.deepEqual(
  aiResolvedSecondaryContext.context.visibleCharacterNamesByShotId?.['shot-missing-tagged-direction-only'],
  [],
  'AI 判定纯朝向目标未出镜时，空名单也必须作为权威结果保留',
);
const aiResolvedSecondaryRequest = buildStoryboardImageRequests(
  missingTaggedIdentityBoard,
  'storyboard-shots',
  aiResolvedSecondaryContext.context,
)[1];
assert.match(aiResolvedSecondaryRequest.conversionSource, /人物“玄衣师兄”连续性事实/u);
assert.match(aiResolvedSecondaryRequest.conversionSource, /方脸、浓直眉、灰黑瞳、短黑发、肩背宽阔/u);
let requestedIdentityNames: readonly string[] = [];
const preparedIdentityContext = await identityEnrichmentHelpers.prepareStoryboardImageIdentityContext({
  storyboard: identityGapBoard,
  context: {
    characters: [legacyWithUserOutfit, offscreenMaster],
    locations: [],
    props: [],
    scenes: [identityGapScene],
    assets: [],
  },
  requestIdentityDetails: async (names) => {
    requestedIdentityNames = [...names];
    return [
      {
        name: '小师妹',
        gender: '女',
        race: '人类修士',
        appearance: '鹅蛋脸、琥珀色杏眼、乌黑长发高束、身形纤细',
        outfit: 'AI 不得覆盖的蓝色练功服',
        anchor: '固定鹅蛋脸、琥珀眼、高束黑发和月白练功服',
      },
      {
        name: '无名主角',
        gender: '男',
        race: '人类修士',
        appearance: '棱角分明的脸、深褐眼、黑发高束、肩背挺拔',
        outfit: '深青交领劲装、黑色护腕与长靴',
        anchor: '固定棱角脸、深褐眼、高束黑发与深青劲装',
      },
    ];
  },
  createCharacterId: (name) => `prepared-${name}`,
});
assert.deepEqual(requestedIdentityNames, ['小师妹', '无名主角']);
assert.equal(preparedIdentityContext.enriched, true);
assert.equal(
  preparedIdentityContext.context.characters.find((item) => item.name === '小师妹')?.outfit,
  legacyWithUserOutfit.outfit,
);
assert.equal(
  preparedIdentityContext.context.characters.find((item) => item.name === '无名主角')?.appearance,
  '棱角分明的脸、深褐眼、黑发高束、肩背挺拔',
);
assert.deepEqual(
  identityEnrichmentHelpers.planStoryboardImageIdentityEnrichment(
    identityGapBoard,
    preparedIdentityContext.context,
  ).targets,
  [],
  'the per-shot converter may run only after every visible character has a reusable identity lock',
);
await assert.rejects(
  () => identityEnrichmentHelpers.prepareStoryboardImageIdentityContext!({
    storyboard: identityGapBoard,
    context: {
      characters: [legacyEmptyCharacter],
      locations: [],
      props: [],
      scenes: [identityGapScene],
      assets: [],
    },
    requestIdentityDetails: async () => [{ name: '小师妹', appearance: '只有零散外貌' }],
    createCharacterId: (name) => `incomplete-${name}`,
  }),
  /人物.*身份|外貌.*补齐|小师妹|无名主角/u,
  'an incomplete AI identity response must be repaired by the AI layer or stop before independent per-shot guesses',
);

const boardWithGlobalReference = {
  ...boardWithExplicitShotReference,
  globalReferenceAssetIds: [globalStoryboardReference.id, globalStoryboardReference.id],
  shots: boardWithExplicitShotReference.shots.map((shot, index) => index === 1
    ? { ...shot, referenceAssetIds: [globalStoryboardReference.id, explicitShotReference.id] }
    : shot),
} as Storyboard & { globalReferenceAssetIds: string[] };
const globalReferenceContext = {
  characters: [contextCharacter],
  locations: [contextLocation],
  props: [contextProp],
  scenes: [contextScene],
  assets: [globalStoryboardReference, explicitShotReference, characterReference, locationReference, propReference],
};
const globallyReferencedShotRequests = buildStoryboardImageRequests(
  boardWithGlobalReference,
  'storyboard-shots',
  globalReferenceContext,
);
globallyReferencedShotRequests.forEach((request, index) => {
  assert.equal(
    request.referenceAssetIds[0],
    globalStoryboardReference.id,
    'the checked storyboard reference must lead every shot request so the chosen identity/style image is primary',
  );
  assert.equal(
    request.referenceAssetIds.filter((id) => id === globalStoryboardReference.id).length,
    1,
    'a global reference already present on a shot must be de-duplicated',
  );
  assert.deepEqual(
    request.primaryReferenceAssetIds,
    index < 2
      ? [globalStoryboardReference.id, explicitShotReference.id]
      : [globalStoryboardReference.id],
    'global references must remain first, followed by de-duplicated user-selected per-shot references',
  );
});
assert.ok(
  globallyReferencedShotRequests[0]?.referenceAssetIds.includes(explicitShotReference.id),
  'global references must not replace a shot own reference',
);
const globallyReferencedBoundaryRequests = buildStoryboardImageRequests(
  boardWithGlobalReference,
  'boundary-frames',
  globalReferenceContext,
);
assert.deepEqual(
  globallyReferencedBoundaryRequests.map((request) => request.referenceAssetIds[0]),
  [globalStoryboardReference.id, globalStoryboardReference.id],
  'both the first-frame and last-frame requests must use the checked global reference',
);
assert.equal(
  storyboardImageHelpers.isUsableStoryboardReferenceAsset?.({
    ...globalStoryboardReference,
    id: 'prompt-only-reference',
    dataUrl: undefined,
    url: undefined,
    relativePath: undefined,
    prompt: '只有提示词，没有真实像素',
  }),
  false,
  'prompt-only assets must not be presented as usable image references',
);
assert.equal(
  storyboardImageHelpers.isUsableStoryboardReferenceAsset?.(globalStoryboardReference),
  true,
);

const privateBreastReference: ReferenceAsset = {
  ...globalStoryboardReference,
  id: 'private-breast-reference',
  name: '阿莲胸部私密资料图',
  sourceEntityId: contextCharacter.id,
  sourceEntityKind: 'character',
  referenceScope: 'nsfw-private-profile',
  nsfwPrivatePart: 'breasts',
  imageVariant: 'private-close-up',
  prompt: 'PRIVATE_REFERENCE_GENERATOR_PROMPT_SENTINEL',
};
const privateVulvaReference: ReferenceAsset = {
  ...privateBreastReference,
  id: 'private-vulva-reference',
  name: '阿莲外阴私密资料图',
  nsfwPrivatePart: 'vulva',
};
const otherCharacterPrivateReference: ReferenceAsset = {
  ...privateBreastReference,
  id: 'other-character-private-reference',
  name: '青竹胸部私密资料图',
  sourceEntityId: 'character-qing-zhu',
};
assert.equal(
  storyboardImageHelpers.isUsableStoryboardReferenceAsset?.(privateBreastReference),
  false,
  'ordinary storyboard/reference pickers must never expose private dossier pixels',
);

const adultNsfwCharacter: Character = {
  ...contextCharacter,
  apparentAge: '二十五岁',
  nsfwBodyAnchors: { stableTraits: ['UNSCOPED_BODY_ANCHOR_SENTINEL'] },
  assetIds: [contextCharacter.assetIds[0], privateBreastReference.id, privateVulvaReference.id],
  nsfwProfile: {
    fullBody: 'A_ONLY_FULL_BODY_PROFILE',
    breasts: 'A_ONLY_BREAST_PROFILE',
    vulva: 'A_ONLY_VULVA_PROFILE',
    provenance: 'manual',
  },
};
const otherAdultCharacter: Character = {
  ...contextCharacter,
  id: 'character-qing-zhu',
  name: '青竹',
  apparentAge: '二十三岁',
  assetIds: [otherCharacterPrivateReference.id],
  nsfwProfile: {
    fullBody: 'B_ONLY_FULL_BODY_PROFILE',
    breasts: 'B_ONLY_BREAST_PROFILE',
    provenance: 'manual',
  },
};
const adultNsfwShot = makeShot(1, {
  subject: '阿莲独自位于卧室中央',
  action: '二十五岁的阿莲上身裸露，镜头明确表现她的胸部与乳头。',
  result: '阿莲仍保持上身裸露',
  referenceAssetIds: [
    privateBreastReference.id,
    privateVulvaReference.id,
    otherCharacterPrivateReference.id,
  ],
  visiblePrivatePartsByCharacter: { [contextCharacter.id]: ['breasts'] },
});
const adultNsfwBoard: Storyboard = {
  ...storyboard,
  id: 'adult-nsfw-board',
  sourceStoryContent: '阿莲二十五岁，青竹二十三岁。阿莲上身裸露，镜头明确表现她的胸部与乳头。',
  shots: [adultNsfwShot],
  durationSec: 3,
};
const adultNsfwContext = {
  characters: [adultNsfwCharacter, otherAdultCharacter],
  locations: [],
  props: [],
  scenes: [],
  assets: [
    globalStoryboardReference,
    privateBreastReference,
    privateVulvaReference,
    otherCharacterPrivateReference,
  ],
};
const adultNsfwRequest = buildStoryboardImageRequests(
  adultNsfwBoard,
  'storyboard-shots',
  adultNsfwContext,
)[0];
assert.ok(adultNsfwRequest.referenceAssetIds.includes(privateBreastReference.id));
assert.ok(!adultNsfwRequest.referenceAssetIds.includes(privateVulvaReference.id), 'a different private body part must stay out');
assert.ok(!adultNsfwRequest.referenceAssetIds.includes(otherCharacterPrivateReference.id), 'another performer private image must stay out');
assert.doesNotMatch(adultNsfwRequest.conversionSource, /UNSCOPED_BODY_ANCHOR_SENTINEL|PRIVATE_REFERENCE_GENERATOR_PROMPT_SENTINEL/u,
  'a selected part must not import aggregate body anchors or the reference generation prompt');
const customScopedSource = buildCustomStoryboardImageRequests(adultNsfwBoard, [{
  sourceShotId: adultNsfwShot.id, description: '阿莲的手握住门环，画面只见袖口、手和门环。',
}], adultNsfwContext)[0];
assert.doesNotMatch(customScopedSource.conversionSource, /A_ONLY_(?:FULL_BODY|BREAST|VULVA)_PROFILE|UNSCOPED_BODY_ANCHOR_SENTINEL/u,
  'an independently chosen still must not inherit a whole-shot private visibility selection');
assert.ok(!customScopedSource.referenceAssetIds.includes(privateBreastReference.id));

const actionOnlyNsfwShot = makeShot(1, {
  subject: '阿莲独自位于卧室中央',
  action: '阿莲与成年伴侣亲吻，隔着完整衣物轻触胸部位置的衣料。',
  result: '动作仍在持续',
});
const actionOnlyNsfwRequest = buildStoryboardImageRequests(
  {
    ...adultNsfwBoard,
    id: 'action-only-nsfw-board',
    sourceStoryContent: '阿莲与成年伴侣亲吻，隔着完整衣物轻触胸部位置的衣料。',
    shots: [actionOnlyNsfwShot],
  },
  'storyboard-shots',
  adultNsfwContext,
)[0];
assert.match(
  actionOnlyNsfwRequest.conversionSource,
  /青色棉麻长衣|黑色布靴|深灰护腕|服装主色/u,
  'covered contact must retain wardrobe facts instead of inventing a wardrobe change',
);
assert.doesNotMatch(actionOnlyNsfwRequest.conversionSource, /A_ONLY_.*PROFILE|UNSCOPED_BODY_ANCHOR_SENTINEL/u);

const twoPersonNsfwShot = makeShot(1, {
  subject: '阿莲与青竹同时位于卧室',
  action: '阿莲上身裸露，镜头明确表现阿莲的胸部与乳头；青竹穿着完整外套站在一旁。',
  result: '阿莲保持上身裸露，青竹衣物完整',
  referenceAssetIds: [privateBreastReference.id, otherCharacterPrivateReference.id],
  visiblePrivatePartsByCharacter: { [contextCharacter.id]: ['breasts'] },
});
const twoPersonNsfwBoard: Storyboard = {
  ...adultNsfwBoard,
  id: 'two-person-nsfw-board',
  sourceStoryContent: '阿莲二十五岁，青竹二十三岁。阿莲上身裸露，镜头明确表现阿莲的胸部与乳头；青竹穿着完整外套站在一旁。',
  shots: [twoPersonNsfwShot],
};
const twoPersonNsfwContext = {
  ...adultNsfwContext,
  visibleCharacterNamesByShotId: {
    [twoPersonNsfwShot.id]: ['阿莲', '青竹'],
  },
};
const twoPersonNsfwRequest = buildStoryboardImageRequests(
  twoPersonNsfwBoard,
  'storyboard-shots',
  twoPersonNsfwContext,
)[0];
assert.doesNotMatch(twoPersonNsfwRequest.conversionSource, /A_ONLY_FULL_BODY_PROFILE/u);
assert.match(twoPersonNsfwRequest.conversionSource, /A_ONLY_BREAST_PROFILE/u);
assert.doesNotMatch(twoPersonNsfwRequest.conversionSource, /B_ONLY_FULL_BODY_PROFILE|B_ONLY_BREAST_PROFILE/u);
assert.ok(twoPersonNsfwRequest.referenceAssetIds.includes(privateBreastReference.id));
assert.ok(!twoPersonNsfwRequest.referenceAssetIds.includes(otherCharacterPrivateReference.id));
const twoPersonVisualAnchor = buildStoryboardImageAssetVisualAnchor(
  twoPersonNsfwBoard,
  twoPersonNsfwRequest,
  twoPersonNsfwContext,
);
assert.doesNotMatch(twoPersonVisualAnchor, /A_ONLY_FULL_BODY_PROFILE/u);
assert.match(twoPersonVisualAnchor, /A_ONLY_BREAST_PROFILE/u);
assert.doesNotMatch(twoPersonVisualAnchor, /B_ONLY_FULL_BODY_PROFILE|B_ONLY_BREAST_PROFILE/u);

const splitNudityShot = makeShot(1, {
  subject: '阿莲与青竹同时位于卧室',
  action: '阿莲穿着完整外套站在床边，青竹全裸站在窗前。',
  result: '阿莲衣物完整，青竹保持全裸',
  referenceAssetIds: [],
  visiblePrivatePartsByCharacter: { [otherAdultCharacter.id]: ['full-body'] },
});
const splitNudityBoard: Storyboard = {
  ...adultNsfwBoard,
  id: 'split-nudity-board',
  sourceStoryContent: '阿莲二十五岁，青竹二十三岁。阿莲穿着完整外套站在床边，青竹全裸站在窗前。',
  shots: [splitNudityShot],
};
const splitNudityRequest = buildStoryboardImageRequests(
  splitNudityBoard,
  'storyboard-shots',
  {
    ...adultNsfwContext,
    visibleCharacterNamesByShotId: { [splitNudityShot.id]: ['阿莲', '青竹'] },
  },
)[0];
assert.doesNotMatch(splitNudityRequest.conversionSource, /A_ONLY_FULL_BODY_PROFILE/u);
assert.match(splitNudityRequest.conversionSource, /B_ONLY_FULL_BODY_PROFILE/u);

const nonAdultNsfwRequest = buildStoryboardImageRequests(
  { ...adultNsfwBoard, sourceStoryContent: '阿莲上身裸露，镜头明确表现她的胸部与乳头。' },
  'storyboard-shots',
  {
    ...adultNsfwContext,
    characters: [{ ...adultNsfwCharacter, apparentAge: '' }, otherAdultCharacter],
  },
)[0];
assert.ok(
  nonAdultNsfwRequest.referenceAssetIds.includes(privateBreastReference.id),
  'missing age metadata must not block a same-character, body-part-matched private reference',
);

const ordinaryClothedRequest = buildStoryboardImageRequests(
  {
    ...adultNsfwBoard,
    sourceStoryContent: '阿莲二十五岁，穿着完整外套站在门口。',
    shots: [makeShot(1, {
      subject: '阿莲站在门口',
      action: '阿莲穿着完整外套抬手敲门。',
      result: '阿莲仍穿着完整外套',
      referenceAssetIds: [privateBreastReference.id],
    })],
  },
  'storyboard-shots',
  adultNsfwContext,
)[0];
assert.ok(!ordinaryClothedRequest.referenceAssetIds.includes(privateBreastReference.id), 'ordinary clothed shots must not receive private dossier pixels');

const privateFullBodyReference: ReferenceAsset = {
  ...privateBreastReference,
  id: 'private-full-body-reference',
  name: '阿莲私密全身资料图',
  nsfwPrivatePart: 'full-body',
  imageVariant: 'private-full-body',
};
const removalBoundaryShot = makeShot(1, {
  subject: '阿莲独自站在卧室床边',
  action: '阿莲先穿着黑色丝绸睡袍站定，随后脱下黑色丝绸睡袍并全裸站在床边。',
  result: '阿莲全裸站定，黑色丝绸睡袍已经离身',
  referenceAssetIds: [privateFullBodyReference.id],
  visiblePrivatePartsByCharacter: { [contextCharacter.id]: ['full-body'] },
});
const removalBoundaryBoard: Storyboard = {
  ...adultNsfwBoard,
  id: 'single-shot-removal-boundary-board',
  sourceStoryContent: '阿莲二十五岁。阿莲先穿着黑色丝绸睡袍站定，随后脱下黑色丝绸睡袍并全裸站在床边。',
  shots: [removalBoundaryShot],
};
const removalBoundaryContext = {
  ...adultNsfwContext,
  assets: [...adultNsfwContext.assets, privateFullBodyReference],
};
const [removalFirstFrame, removalLastFrame] = buildStoryboardImageRequests(
  removalBoundaryBoard,
  'boundary-frames',
  removalBoundaryContext,
);
assert.ok(!removalFirstFrame.referenceAssetIds.includes(privateFullBodyReference.id));
assert.doesNotMatch(removalFirstFrame.conversionSource, /A_ONLY_FULL_BODY_PROFILE/u);
assert.doesNotMatch(removalFirstFrame.conversionSource, /稳定身体锚点/u);
assert.doesNotMatch(removalFirstFrame.conversionSource, /首帧入镜裸露状态[：:]\s*全裸/u);
assert.match(
  removalFirstFrame.conversionSource,
  /黑色丝绸睡袍仍穿在身上，尚未执行本镜脱衣动作/u,
  'a removal shot first frame must preserve the entry garment instead of borrowing the shot-end nude state',
);
assert.ok(removalLastFrame.referenceAssetIds.includes(privateFullBodyReference.id));
assert.match(removalLastFrame.conversionSource, /A_ONLY_FULL_BODY_PROFILE/u);
assert.match(removalLastFrame.conversionSource, /目标画面裸露状态[：:]\s*全裸/u);
const removalFirstFrameAnchor = buildStoryboardImageAssetVisualAnchor(
  removalBoundaryBoard,
  removalFirstFrame,
  removalBoundaryContext,
);
const removalLastFrameAnchor = buildStoryboardImageAssetVisualAnchor(
  removalBoundaryBoard,
  removalLastFrame,
  removalBoundaryContext,
);
assert.doesNotMatch(removalFirstFrameAnchor, /A_ONLY_FULL_BODY_PROFILE|目标画面裸露状态[：:]\s*全裸/u);
assert.doesNotMatch(removalFirstFrameAnchor, /稳定身体锚点/u);
assert.match(removalFirstFrameAnchor, /黑色丝绸睡袍仍穿在身上，尚未执行本镜脱衣动作/u);
assert.match(removalLastFrameAnchor, /A_ONLY_FULL_BODY_PROFILE/u);
assert.match(removalLastFrameAnchor, /目标画面裸露状态[：:]\s*全裸/u);

type ResolveStoryboardReferenceImagesFixture = (
  referenceAssetIds: readonly string[],
  assets: readonly ReferenceAsset[],
  loader: {
    readManagedImageDataUrl?: (payload: { relativePath: string; expectedChecksum?: string }) => Promise<string>;
    downloadImage?: (remote: string | { url: string; headers?: Record<string, string> }) => Promise<string>;
  },
  cache?: Map<string, Promise<string>>,
) => Promise<string[]>;
const referenceResolver = storyboardImageHelpers as typeof storyboardImageHelpers & {
  resolveStoryboardReferenceImages?: ResolveStoryboardReferenceImagesFixture;
};
assert.equal(
  typeof referenceResolver.resolveStoryboardReferenceImages,
  'function',
  'storyboard image generation must resolve checked managed assets to real image bytes',
);
assert.ok(referenceResolver.resolveStoryboardReferenceImages);
const managedReference: ReferenceAsset = {
  ...globalStoryboardReference,
  id: 'asset-managed-reference',
  dataUrl: undefined,
  url: 'lianhua-asset://local/image/managed.png',
  relativePath: 'image/managed.png',
  checksum: 'managed-checksum',
};
const remoteReference: ReferenceAsset = {
  ...globalStoryboardReference,
  id: 'asset-remote-reference',
  dataUrl: undefined,
  url: 'https://cdn.example.test/reference.webp',
  relativePath: undefined,
};
const resolverEvents: string[] = [];
const resolverCache = new Map<string, Promise<string>>();
const resolvedReferenceImages = await referenceResolver.resolveStoryboardReferenceImages(
  [managedReference.id, explicitShotReference.id, remoteReference.id],
  [managedReference, explicitShotReference, remoteReference],
  {
    readManagedImageDataUrl: async (payload) => {
      resolverEvents.push(`managed:${payload.relativePath}:${payload.expectedChecksum}`);
      return 'data:image/png;base64,BQ==';
    },
    downloadImage: async (remote) => {
      resolverEvents.push(`remote:${typeof remote === 'string' ? remote : remote.url}`);
      return 'data:image/webp;base64,Bg==';
    },
  },
  resolverCache,
);
assert.deepEqual(resolvedReferenceImages, [
  'data:image/png;base64,BQ==',
  explicitShotReference.dataUrl,
  'data:image/webp;base64,Bg==',
]);
await referenceResolver.resolveStoryboardReferenceImages(
  [managedReference.id],
  [managedReference],
  {
    readManagedImageDataUrl: async () => {
      resolverEvents.push('managed:unexpected-second-read');
      return 'data:image/png;base64,Bw==';
    },
  },
  resolverCache,
);
assert.deepEqual(resolverEvents, [
  'managed:image/managed.png:managed-checksum',
  'remote:https://cdn.example.test/reference.webp',
], 'a storyboard batch must reuse resolved managed image bytes without persisting base64 into project state');

const polishedTimelineSegments = [
  '【0s-3s】 主体：@阿莲（警觉）[朝向：石门] 正在 [抬手→握住门环→缓慢推开]（开启入口）；空间：石门前；光影：冷月光；镜头：低机位推进；台词：无；音效：门轴声',
  '【3s-6s】 主体：@阿莲（戒备）[朝向：甬道尽头] 正在 [侧身→贴墙快步通过→停在出口]（深入险境）；空间：狭长甬道；光影：蓝色反光；镜头：侧后方跟拍；台词：无；音效：脚步声',
  '【6s-9s】 主体：@阿莲（冷静）[朝向：守卫] 正在 [收剑→停步→与守卫对视]（形成对峙）；空间：甬道尽头；光影：火把暖光；镜头：双人中景；台词：无；音效：火焰声',
];
const polishedStoryboard: Storyboard = {
  ...storyboard,
  finalPrompt: polishedTimelineSegments.join('\n'),
};
const polishedShotRequests = buildStoryboardImageRequests(polishedStoryboard, 'storyboard-shots');
const tracedPolishedShotRequests = polishedShotRequests.map((request) => withImagePromptTrace(request));
const polishedShotTokens = ['缓慢推开', '贴墙快步通过', '与守卫对视'];
polishedShotRequests.forEach((request, offset) => {
  assert.match(request.conversionSource, new RegExp(polishedShotTokens[offset] || '', 'u'));
  assert.doesNotMatch(
    request.conversionSource,
    new RegExp(polishedStoryboard.shots[offset]?.prompt || '', 'u'),
    'a converter-polished final shot segment must replace the stale shot.prompt as the authoritative image description',
  );
  polishedShotTokens.forEach((token, tokenOffset) => {
    if (tokenOffset !== offset && tokenOffset !== offset - 1) {
      assert.doesNotMatch(
        request.conversionSource,
        new RegExp(token, 'u'),
        'one image request may carry the preceding shot as continuity evidence, never a future or unrelated shot',
      );
    }
  });
});

// Final H3 and still images must share one spatial source. All fixtures are
// synthetic; these checks neither call an API nor modify saved projects.
const h3SpatialShots = [
  makeShot(1, { subject: '阿莲与守卫', action: '阿莲先抬起右手，随后把铜铃交给守卫', result: '旧镜尾结果：铜铃已经交给守卫', space: '旧空间：阿莲在画面右侧', direction: '旧朝向：阿莲面向画面左侧', camera: '旧机位：互动轴线北侧' }),
  makeShot(2, { subject: '阿莲与守卫', action: '守卫收起铜铃', result: '守卫收好铜铃', space: '结构化第二镜空间：两人仍在门前', direction: '结构化第二镜朝向：阿莲面向守卫', camera: '结构化第二镜机位：门前中景' }),
];
const h3SpatialTexts = [
  '[Shot 1] 最终空间一：阿莲在观众画面左侧，守卫在画面右侧；阿莲自身右手抬起，铜铃还在手中。摄影机在互动轴线南侧。随后阿莲把铜铃交给守卫。阿莲说<d>[Chinese] 字条上写着😀[Shot 8]和“overall_soundscape:”</d>。',
  '[Shot 2] At 00:03.000, 最终空间二：两人保持前镜相对位置，阿莲自身右侧仍朝向守卫。摄影机仍在轴线南侧近景裁切，不镜像、不换座。',
];
const spatialH3 = `integrated_multimodal_description: ${h3SpatialTexts.join('\n\n')}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`;
const spatialBoard: Storyboard = {
  ...storyboard, id: 'spatial-board', durationSec: 6, shotCount: 2, shots: h3SpatialShots,
  sourceStoryContent: '阿莲把铜铃交给守卫。',
  finalPrompt: '【0s-3s】旧 canonical 第一镜空间：阿莲在右侧。\n【3s-6s】旧 canonical 第二镜空间：阿莲在右侧。',
  officialPromptZh: spatialH3,
};
const spatialBoardBefore = JSON.stringify(spatialBoard);
const spatialContext = {
  characters: [contextCharacter], locations: [], props: [], scenes: [],
  assets: [explicitShotReference, characterReference],
  visibleCharacterNamesByShotId: { 'shot-1': ['阿莲'], 'shot-2': ['阿莲'] },
};
const spatialContextBefore = JSON.stringify(spatialContext);
const spatialBoardWithReferences = {
  ...spatialBoard,
  globalReferenceAssetIds: [explicitShotReference.id, characterReference.id],
};
const spatialRequests = buildStoryboardImageRequests(spatialBoardWithReferences, 'storyboard-shots', spatialContext);
assert.deepEqual(storyboardImageHelpers.readStoryboardImageH3Source(spatialBoard)?.shots, h3SpatialTexts,
  'quoted Shot and section markers inside dialogue must remain literal text in the original H3 shot');
for (const [offset, request] of spatialRequests.entries()) {
  assert.ok(request.conversionSource.includes(h3SpatialTexts[offset]));
  assert.doesNotMatch(request.conversionSource, /旧 canonical/u, 'final H3 replaces stale canonical spatial descriptions');
  assert.ok(request.conversionSource.indexOf(h3SpatialTexts[offset]) < request.conversionSource.indexOf('人物“阿莲”连续性事实'),
    'the authoritative current frame must precede reusable identity/reference dossiers');
  assert.match(request.conversionSource, /资料排列与图片上传顺序均不代表画面左右顺序/u);
  assert.match(request.conversionSource, /不代表本次已查看图像像素/u);
  assert.deepEqual(request.primaryReferenceAssetIds, [explicitShotReference.id, characterReference.id]);
}
assert.ok(spatialRequests[1].conversionSource.includes(h3SpatialTexts[0]), 'previous final H3 is passed as continuity evidence');
assert.match(spatialRequests[1].conversionSource, /上一镜结构化空间.*旧空间/u);
assert.match(spatialRequests[1].conversionSource, /上一镜结构化朝向.*旧朝向/u);
assert.match(spatialRequests[1].conversionSource, /上一镜结构化机位.*旧机位/u);
const [spatialFirst, spatialLast] = buildStoryboardImageRequests(spatialBoardWithReferences, 'boundary-frames', spatialContext);
assert.ok(spatialFirst.conversionSource.includes(h3SpatialTexts[0]));
assert.ok(!spatialFirst.conversionSource.includes(h3SpatialTexts[1]), 'the first frame must not see a later shot as its frame target');
assert.doesNotMatch(spatialFirst.conversionSource, /旧镜尾结果/u);
assert.match(spatialFirst.conversionSource, /首帧时间边界高于整镜动作链/u);
assert.match(spatialFirst.conversionSource, /其中随后、镜尾或动作完成后的变化尚未发生/u);
assert.ok(spatialLast.conversionSource.includes(h3SpatialTexts[1]));
const spatialFrames = h3SpatialShots.flatMap((shot, offset) => [
  { sourceShotId: shot.id, description: `第${offset + 1}镜入口：阿莲在画面左侧，守卫在画面右侧，沿用最终H3原机位。`, timeSec: shot.startSec + 0.2 },
  { sourceShotId: shot.id, description: `第${offset + 1}镜中途：只推进原动作，阿莲自身右手保持原接触归属，不另改视点。`, timeSec: shot.startSec + 1.2 },
]);
const spatialCustomRequests = buildCustomStoryboardImageRequests(spatialBoardWithReferences, spatialFrames, spatialContext);
assert.equal(spatialCustomRequests.length, 4);
spatialCustomRequests.forEach((request, offset) => {
  assert.ok(request.conversionSource.includes(h3SpatialTexts[Math.floor(offset / 2)]));
  assert.ok(request.conversionSource.includes(spatialFrames[offset].description));
  assert.deepEqual(request.primaryReferenceAssetIds, [explicitShotReference.id, characterReference.id]);
  assert.equal(buildStoryboardImageRequestFromFrame(spatialBoardWithReferences, request.shotId, request, spatialContext).conversionSource, request.conversionSource);
  assert.match(request.conversionSource, /选帧描述不能借构图覆盖或重排它们/u);
});
assert.equal(JSON.stringify(spatialBoard), spatialBoardBefore);
assert.equal(JSON.stringify(spatialContext), spatialContextBefore);
const spatialFingerprint = storyboardImageSourceFingerprint(spatialBoard, withImagePromptTrace(spatialRequests[0]));
assert.notEqual(spatialFingerprint, storyboardImageSourceFingerprint({ ...spatialBoard, officialPromptZh: spatialH3.replace('最终空间一', 'AI重新确认的空间一') }, withImagePromptTrace(spatialRequests[0])),
  'editing only final H3 staging invalidates stale image results');
for (const fallbackBoard of [
  { ...spatialBoard, officialPromptZh: undefined },
  { ...spatialBoard, officialPromptZh: '损坏的 H3 [Shot 1] 空间' },
  { ...spatialBoard, officialPromptZh: spatialH3.replace('00:03.000', '00:04.000') },
  { ...spatialBoard, officialPromptSource: 'stale:canonical:fingerprint' },
]) {
  assert.equal(storyboardImageHelpers.readStoryboardImageH3Source(fallbackBoard), undefined);
  assert.match(buildStoryboardImageRequests(fallbackBoard, 'storyboard-shots')[0].conversionSource, /旧 canonical 第一镜空间/u);
}
const fullReferenceH3 = `subject_definitions: <Subject 1> 阿莲；<Subject 2> 守卫\nsummary: 交接\nretention_analysis: 保留“[Shot 99]”的字面字条内容\ndetailed_description: Soft moonlight with a steady camera.\n${h3SpatialTexts.join('\n')}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const fullReferenceBoard = { ...spatialBoard, officialPromptZh: fullReferenceH3 };
assert.deepEqual(storyboardImageHelpers.readStoryboardImageH3Source(fullReferenceBoard)?.shots, h3SpatialTexts);
const fullReferenceSource = buildStoryboardImageRequests(fullReferenceBoard, 'storyboard-shots')[0].conversionSource;
assert.match(fullReferenceSource, /最终 H3 主体标签对应：<Subject 1> 阿莲；<Subject 2> 守卫/u);
assert.match(fullReferenceSource, /Soft moonlight with a steady camera/u);
assert.match(storyboardImageHelpers.buildStoryboardVisibleCharacterAnalysisShots(fullReferenceBoard)[0].description,
  /主体标签对应（仅供姓名解析，不表示这些人全部入画）：<Subject 1> 阿莲；<Subject 2> 守卫/u,
  'the batch cast resolver must retain full-reference subject-name mappings without adding every defined character to the frame');
const structuredSpatialBoard = { ...spatialBoard, officialPromptZh: undefined, finalPrompt: '', shots: h3SpatialShots.map((shot) => ({ ...shot, prompt: '' })) };
for (const request of [
  ...buildStoryboardImageRequests(structuredSpatialBoard, 'storyboard-shots'),
  ...buildStoryboardImageRequests(structuredSpatialBoard, 'boundary-frames'),
]) {
  const originalShot = structuredSpatialBoard.shots.find((shot) => shot.id === request.shotId)!;
  assert.ok(request.conversionSource.includes(originalShot.space!));
  assert.ok(request.conversionSource.includes(originalShot.direction!));
}
const spatialAnchor = buildStoryboardImageAssetVisualAnchor(spatialBoard, spatialCustomRequests[0], spatialContext);
assert.ok(spatialAnchor.includes(h3SpatialTexts[0]));
assert.ok(spatialAnchor.includes(spatialFrames[0].description));
assert.match(spatialAnchor, /不是对已生成像素的重新观测/u);

const boundaryRequests = buildStoryboardImageRequests(storyboard, 'boundary-frames');
assert.equal(boundaryRequests.length, 2);
assert.equal(boundaryRequests[0]?.purpose, 'first-frame');
assert.equal(boundaryRequests[0]?.assetType, 'first-frame');
assert.equal(boundaryRequests[0]?.assetRole, 'first-frame');
assert.equal(boundaryRequests[0]?.imageVariant, 'first-frame');
assert.equal(boundaryRequests[0]?.shotId, storyboard.shots[0]?.id);
assert.match(boundaryRequests[0]?.conversionSource || '', /动作起始状态/u);
assert.match(boundaryRequests[0]?.conversionSource || '', new RegExp(storyboard.shots[0]?.action || '', 'u'));
assert.doesNotMatch(boundaryRequests[0]?.conversionSource || '', new RegExp(storyboard.shots.at(-1)?.result || '', 'u'));
assert.equal(boundaryRequests[1]?.purpose, 'last-frame');
assert.equal(boundaryRequests[1]?.assetType, 'last-frame');
assert.equal(boundaryRequests[1]?.assetRole, 'last-frame');
assert.equal(boundaryRequests[1]?.imageVariant, 'last-frame');
assert.equal(boundaryRequests[1]?.shotId, storyboard.shots.at(-1)?.id);
assert.match(boundaryRequests[1]?.conversionSource || '', /动作完成后的最终状态/u);
assert.match(boundaryRequests[1]?.conversionSource || '', new RegExp(storyboard.shots.at(-1)?.result || '', 'u'));

const firstBound = bindStoryboardImageAsset(storyboard, boundaryRequests[0], 'asset-first');
assert.equal(firstBound.firstFrameAssetId, 'asset-first');
assert.deepEqual(firstBound.shots[0]?.referenceAssetIds, ['asset-first']);
assert.deepEqual(firstBound.shots[1]?.referenceAssetIds, []);

const lastBound = bindStoryboardImageAsset(firstBound, boundaryRequests[1], 'asset-last');
assert.equal(lastBound.lastFrameAssetId, 'asset-last');
assert.deepEqual(lastBound.shots.at(-1)?.referenceAssetIds, ['asset-last']);

const shotBound = bindStoryboardImageAsset(lastBound, shotRequests[1], 'asset-shot-2');
assert.deepEqual(shotBound.shots[1]?.referenceAssetIds, ['asset-shot-2']);
assert.deepEqual(shotBound.shots[0]?.referenceAssetIds, ['asset-first']);
assert.deepEqual(storyboard.shots[0]?.referenceAssetIds, [], 'binding must not mutate the original storyboard');

const storyboardWithExistingImages: Storyboard = {
  ...storyboard,
  firstFrameAssetId: 'asset-old-first',
  lastFrameAssetId: 'asset-old-last',
  shots: storyboard.shots.map((shot, offset) => ({
    ...shot,
    referenceAssetIds: offset === 0
      ? ['asset-manual-first', 'asset-old-first', 'asset-other-first']
      : offset === 1
        ? ['asset-manual-middle', 'asset-old-storyboard', 'asset-other-middle']
        : ['asset-manual-last', 'asset-old-last', 'asset-other-last'],
  })),
};
const replacedShotImage = bindStoryboardImageAsset(
  storyboardWithExistingImages,
  shotRequests[1],
  'asset-new-storyboard',
  ['asset-old-storyboard'],
);
assert.deepEqual(
  replacedShotImage.shots[1]?.referenceAssetIds,
  ['asset-manual-middle', 'asset-other-middle', 'asset-new-storyboard'],
  'same-purpose generated references must be replaced while manual and other-purpose references remain',
);
const replacedFirstFrame = bindStoryboardImageAsset(
  storyboardWithExistingImages,
  boundaryRequests[0],
  'asset-new-first',
);
assert.equal(replacedFirstFrame.firstFrameAssetId, 'asset-new-first');
assert.deepEqual(
  replacedFirstFrame.shots[0]?.referenceAssetIds,
  ['asset-manual-first', 'asset-other-first', 'asset-new-first'],
  'the previous first-frame field reference must be replaced automatically',
);
const replacedLastFrame = bindStoryboardImageAsset(
  storyboardWithExistingImages,
  boundaryRequests[1],
  'asset-new-last',
);
assert.equal(replacedLastFrame.lastFrameAssetId, 'asset-new-last');
assert.deepEqual(
  replacedLastFrame.shots.at(-1)?.referenceAssetIds,
  ['asset-manual-last', 'asset-other-last', 'asset-new-last'],
  'the previous last-frame field reference must be replaced automatically',
);

type StoryboardImageBatchLeaseFixture = {
  key: string;
  bindingEpoch: number;
};
type StoryboardImageBatchLifecycleFixture = {
  begin: (key: string) => StoryboardImageBatchLeaseFixture | null;
  finish: (lease: StoryboardImageBatchLeaseFixture) => void;
  invalidateBindings: () => void;
  isActive: (key: string) => boolean;
  canBind: (lease: StoryboardImageBatchLeaseFixture) => boolean;
};
const lifecycleHelpers = storyboardImageHelpers as typeof storyboardImageHelpers & {
  createStoryboardImageBatchLifecycle?: () => StoryboardImageBatchLifecycleFixture;
  resolveStoryboardImageBinding?: (input: {
    lifecycleCurrent: boolean;
    taskTracked: boolean;
    storyboardPresent: boolean;
    sourceUnchanged: boolean;
  }) => { shouldBind: boolean; warning?: string };
  samePurposeGeneratedStoryboardAssetIds?: (
    assets: readonly ReferenceAsset[],
    storyboardId: string,
    request: typeof shotRequests[number],
  ) => string[];
};
assert.equal(
  typeof lifecycleHelpers.createStoryboardImageBatchLifecycle,
  'function',
  'storyboard image batches need an app-owned lifecycle that survives DirectorView remounts',
);
assert.ok(lifecycleHelpers.createStoryboardImageBatchLifecycle);
const batchLifecycle = lifecycleHelpers.createStoryboardImageBatchLifecycle();
const firstViewLease = batchLifecycle.begin('project-a:board-story');
assert.ok(firstViewLease);
const remountedViewLifecycle = batchLifecycle;
assert.equal(
  remountedViewLifecycle.begin('project-a:board-story'),
  null,
  'returning to DirectorView must not permit a duplicate batch while the original worker is active',
);
batchLifecycle.invalidateBindings();
assert.equal(
  batchLifecycle.canBind(firstViewLease),
  false,
  'undo/redo must invalidate late image binding even when source text is restored byte-for-byte',
);
assert.equal(batchLifecycle.isActive('project-a:board-story'), true);
batchLifecycle.finish(firstViewLease);
assert.equal(batchLifecycle.isActive('project-a:board-story'), false);
assert.ok(batchLifecycle.begin('project-a:board-story'), 'a settled batch must release its duplicate-start guard');

assert.equal(typeof lifecycleHelpers.resolveStoryboardImageBinding, 'function');
assert.ok(lifecycleHelpers.resolveStoryboardImageBinding);
assert.deepEqual(
  lifecycleHelpers.resolveStoryboardImageBinding({
    lifecycleCurrent: true,
    taskTracked: true,
    storyboardPresent: true,
    sourceUnchanged: true,
  }),
  { shouldBind: true },
);
for (const invalidBinding of [
  {
    input: { lifecycleCurrent: false, taskTracked: true, storyboardPresent: true, sourceUnchanged: true },
    warning: /撤销|重做|恢复/u,
  },
  {
    input: { lifecycleCurrent: true, taskTracked: false, storyboardPresent: true, sourceUnchanged: true },
    warning: /任务.*不存在|移除/u,
  },
  {
    input: { lifecycleCurrent: true, taskTracked: true, storyboardPresent: true, sourceUnchanged: false },
    warning: /内容已变化/u,
  },
] as const) {
  const decision = lifecycleHelpers.resolveStoryboardImageBinding(invalidBinding.input);
  assert.equal(decision.shouldBind, false);
  assert.match(decision.warning || '', invalidBinding.warning);
}

assert.equal(typeof lifecycleHelpers.samePurposeGeneratedStoryboardAssetIds, 'function');
assert.ok(lifecycleHelpers.samePurposeGeneratedStoryboardAssetIds);
const samePurposeAssets: ReferenceAsset[] = [
  {
    id: 'generated-same-purpose',
    name: '旧第2镜',
    type: 'reference',
    role: 'composition',
    source: 'generated',
    sourceStoryboardId: storyboard.id,
    sourceShotId: shotRequests[1].shotId,
    imageVariant: 'storyboard-frame',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'manual-same-purpose',
    name: '手工第2镜',
    type: 'reference',
    role: 'composition',
    source: 'upload',
    sourceStoryboardId: storyboard.id,
    sourceShotId: shotRequests[1].shotId,
    imageVariant: 'storyboard-frame',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'generated-other-shot',
    name: '旧第1镜',
    type: 'reference',
    role: 'composition',
    source: 'generated',
    sourceStoryboardId: storyboard.id,
    sourceShotId: shotRequests[0].shotId,
    imageVariant: 'storyboard-frame',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'generated-other-purpose',
    name: '旧尾帧',
    type: 'last-frame',
    role: 'last-frame',
    source: 'generated',
    sourceStoryboardId: storyboard.id,
    sourceShotId: shotRequests[1].shotId,
    imageVariant: 'last-frame',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
];
assert.deepEqual(
  lifecycleHelpers.samePurposeGeneratedStoryboardAssetIds(
    samePurposeAssets,
    storyboard.id,
    shotRequests[1],
  ),
  ['generated-same-purpose'],
  'only old generated assets for the exact storyboard, shot and image purpose may be replaced',
);
assert.deepEqual(
  storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(samePurposeAssets, storyboard.id,
    { ...shotRequests[1], imageFrameBatchId: 'new-full-board-run' }),
  ['generated-same-purpose', 'generated-other-shot'],
  'a new full-board run also retires legacy automatic frames across shots, but never uploaded inputs or boundary frames',
);

let customBoundStoryboard = storyboard;
const generatedCustomAssets: ReferenceAsset[] = [];
customFrameRequests.forEach((request, index) => {
  const replacedIds = storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(generatedCustomAssets, storyboard.id, request);
  assert.deepEqual(replacedIds, [], 'another custom frame for the same shot must not replace earlier images');
  const asset: ReferenceAsset = {
    id: `custom-image-${index + 1}`, name: request.name, type: 'reference', role: 'composition',
    source: 'generated', sourceStoryboardId: storyboard.id, sourceShotId: request.shotId,
    imageVariant: request.imageVariant, dataUrl: 'data:image/png;base64,AA==',
    imageFrameIndex: request.imageFrameIndex, imageFrameCount: request.imageFrameCount,
    imageFrameDescription: request.imageFrameDescription, imageFrameTimeSec: request.imageFrameTimeSec,
    tags: [], createdAt: 1, updatedAt: 1,
  };
  customBoundStoryboard = bindStoryboardImageAsset(customBoundStoryboard, request, asset.id, replacedIds);
  generatedCustomAssets.push(asset);
});
assert.deepEqual(customBoundStoryboard.shots[0].referenceAssetIds, ['custom-image-1', 'custom-image-2', 'custom-image-3']);
assert.deepEqual(customBoundStoryboard.shots.slice(1).map((shot) => shot.referenceAssetIds), [['custom-image-4'], ['custom-image-5']]);
assert.deepEqual(storyboard.shots[0].referenceAssetIds, [], 'custom binding must preserve the source snapshot');
assert.deepEqual(
  storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(generatedCustomAssets, storyboard.id, customFrameRequests[1]),
  ['custom-image-2'],
  'regenerating one custom frame replaces only that exact slot',
);
assert.deepEqual(
  storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(generatedCustomAssets, storyboard.id, shotRequests[0]),
  [],
  'normal one-per-shot generation must not remove custom frame bindings',
);
const siblingFrameContext = { ...namingContext, assets: generatedCustomAssets };
const upgradedLegacySelection = bindStoryboardImageAsset(customBoundStoryboard,
  { ...customFrameRequests[4], imageFrameBatchId: 'new-after-legacy' }, 'upgraded-custom',
  storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(generatedCustomAssets, storyboard.id,
    { ...customFrameRequests[4], imageFrameBatchId: 'new-after-legacy' }));
assert.deepEqual(upgradedLegacySelection.shots.map((shot) => shot.referenceAssetIds), [[], [], ['upgraded-custom']],
  'old custom assets with no batch id are history, not siblings of the first new explicit batch');
const rebuiltCustomFrames = buildCustomStoryboardImageRequests(customBoundStoryboard, customFramePlans, siblingFrameContext);
assert.ok(rebuiltCustomFrames.every((request) => request.referenceAssetIds.length === 0),
  'generated sibling frames must not accumulate as inferred references during another image batch');
const explicitCustomFrameBoard = { ...customBoundStoryboard, globalReferenceAssetIds: ['custom-image-1'] };
const explicitCustomRequests = buildCustomStoryboardImageRequests(explicitCustomFrameBoard, customFramePlans, siblingFrameContext);
assert.ok(explicitCustomRequests.every((request) => request.primaryReferenceAssetIds.includes('custom-image-1')),
  'a user-selected global image remains primary even when it is a generated sibling');
assert.equal(
  storyboardImageSourceFingerprint(customBoundStoryboard, withImagePromptTrace(customFrameRequests[0]), siblingFrameContext),
  storyboardImageSourceFingerprint(storyboard, withImagePromptTrace(customFrameRequests[0]), namingContext),
  'earlier custom FIFO outputs must not make later custom frame requests appear stale',
);

const sourceFingerprint = storyboardImageSourceFingerprint(storyboard, tracedShotRequests[1]);

// Whole-storyboard selections are identified by one durable batch, not by the
// total count or the shot that happened to supply a frame in an older plan.
{
  let bound = structuredClone(storyboard);
  const assets: ReferenceAsset[] = [];
  const bindings = () => bound.shots.flatMap((shot) => shot.referenceAssetIds);
  const customBatch = (batchId: string, shotIds: string[]) => buildCustomStoryboardImageRequests(bound,
    shotIds.map((sourceShotId, index) => ({ sourceShotId, description: `AI选择的独立瞬间 ${index + 1}` })),
  ).map((request) => ({ ...request, imageFrameBatchId: batchId }));
  const succeed = (request: StoryboardImageRequest, id: string) => {
    const replaced = storyboardImageHelpers.samePurposeGeneratedStoryboardAssetIds(assets, bound.id, request);
    const asset: ReferenceAsset = {
      id, name: request.name, type: request.assetType, role: request.assetRole, mediaType: 'image',
      source: 'generated', sourceStoryboardId: bound.id, sourceShotId: request.shotId,
      imageVariant: request.imageVariant, imageFrameBatchId: request.imageFrameBatchId,
      imageFrameIndex: request.imageFrameIndex, imageFrameCount: request.imageFrameCount,
      imageFrameDescription: request.imageFrameDescription, imageFrameTimeSec: request.imageFrameTimeSec,
      dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: assets.length + 1, updatedAt: assets.length + 1,
    };
    bound = bindStoryboardImageAsset(bound, request, id, replaced);
    assets.push(asset);
  };
  const initial = customBatch('batch-two', ['shot-1', 'shot-1']);
  initial.forEach((request, index) => succeed(request, `two-${index + 1}`));
  assert.deepEqual(bindings(), ['two-1', 'two-2']);
  const three = customBatch('batch-three', ['shot-1', 'shot-2', 'shot-3']);
  // Completion order is arbitrary: new siblings may never erase one another.
  succeed(three[2], 'three-3');
  assert.deepEqual(bindings(), ['three-3'], 'first success activates only the new batch, never a mixture with old slots');
  succeed(three[0], 'three-1'); succeed(three[1], 'three-2');
  assert.deepEqual(bindings(), ['three-1', 'three-2', 'three-3'], '2 -> 3 must bind three, not five, images');
  assert.equal(assets.length, 5, 'all old and new image assets remain recoverable');
  assert.ok(assets.some((asset) => asset.id === 'two-1'));

  const replanned = customBatch('batch-three-replanned', ['shot-3', 'shot-3', 'shot-3']);
  replanned.forEach((request, index) => succeed(request, `replanned-${index + 1}`));
  assert.deepEqual(bound.shots.map((shot) => shot.referenceAssetIds), [[], [], ['replanned-1', 'replanned-2', 'replanned-3']],
    'the same total with different source shots must remove the older per-shot bindings');
  const movedSlot = { ...replanned[1], shotId: 'shot-2', shotIndex: 2 };
  succeed(movedSlot, 'replanned-2-retry');
  assert.deepEqual(bound.shots.map((shot) => shot.referenceAssetIds), [[], ['replanned-2-retry'], ['replanned-1', 'replanned-3']],
    'replacing one current-batch slot removes that slot across source shots but keeps its siblings');

  const beforeFailure = JSON.stringify(bound);
  const failedBatch = customBatch('batch-all-failed', ['shot-1', 'shot-2']);
  const failures = await runStoryboardImageBatch(failedBatch, async () => { throw new Error('mock image API failure'); });
  assert.ok(failures.every((result) => result.status === 'failed'));
  assert.equal(JSON.stringify(bound), beforeFailure, 'starting a batch or failing every image must not clear the existing selection');
  const partial = customBatch('batch-partial', ['shot-1', 'shot-2', 'shot-3']);
  await runStoryboardImageBatch(partial, async (request, index) => {
    if (index !== 1) throw new Error('mock failure');
    succeed(request, 'partial-2'); return 'partial-2';
  });
  assert.deepEqual(bindings(), ['partial-2'], 'partial success keeps only the successful current selection, not stale fallback images');
  assert.ok(assets.some((asset) => asset.id === 'replanned-3'), 'failed replacement does not delete the older assets');

  const defaultBatch = buildStoryboardImageRequests(bound, 'storyboard-shots')
    .map((request) => ({ ...request, imageFrameBatchId: 'batch-default' }));
  defaultBatch.forEach((request, index) => succeed(request, `default-${index + 1}`));
  assert.deepEqual(bindings(), ['default-1', 'default-2', 'default-3'], 'switching back to a full default per-shot run retires custom bindings');
  const singleDefaultRetry = buildSelectedStoryboardImageRequests(bound, ['shot-2'])[0];
  succeed(singleDefaultRetry, 'default-2-retry');
  assert.deepEqual(bindings(), ['default-1', 'default-2-retry', 'default-3'], 'legacy selected-shot generation changes only that default shot');
  const singleCustom = customBatch('batch-single-custom', ['shot-2']);
  succeed(singleCustom[0], 'single-custom');
  assert.deepEqual(bindings(), ['single-custom'], 'default -> custom switches the whole automatic selection too');

  // A user-checked old output is an explicit input, not disposable auto state.
  bound = { ...bound, globalReferenceAssetIds: ['single-custom'], shots: bound.shots.map((shot, index) => index === 0
    ? { ...shot, referenceAssetIds: [...shot.referenceAssetIds, 'manual-image'] } : shot) };
  assets.push({ id: 'manual-image', name: 'Manual reference', type: 'reference', role: 'character', source: 'upload', tags: [], createdAt: 1, updatedAt: 1 });
  const protectedSelection = customBatch('batch-protected', ['shot-3', 'shot-3']);
  protectedSelection.forEach((request, index) => succeed(request, `protected-${index + 1}`));
  assert.deepEqual(bound.globalReferenceAssetIds, ['single-custom']);
  assert.deepEqual(bound.shots.map((shot) => shot.referenceAssetIds), [['manual-image'], ['single-custom'], ['protected-1', 'protected-2']],
    'explicit global generated images and manual images must survive across-shot replacement');
  const frame = buildStoryboardImageRequestFromFrame(bound, protectedSelection[0].shotId, protectedSelection[0]);
  assert.equal(frame.imageFrameBatchId, 'batch-protected', 'rebuilding a saved custom frame must keep its original binding provenance');
  assert.equal(storyboardImageSourceFingerprint(storyboard, withImagePromptTrace({ ...customFrameRequests[0], imageFrameBatchId: 'one' })),
    storyboardImageSourceFingerprint(storyboard, withImagePromptTrace({ ...customFrameRequests[0], imageFrameBatchId: 'two' })),
    'a new binding batch id does not masquerade as an edit to the visual source');

  const lifecycle = storyboardImageHelpers.createStoryboardImageBatchLifecycle();
  const oldLease = lifecycle.begin('isolated:board')!;
  assert.equal(lifecycle.begin('isolated:board'), null, 'the app cannot run two paid batches concurrently for one board');
  lifecycle.finish(oldLease);
  const currentLease = lifecycle.begin('isolated:board')!;
  assert.equal(storyboardImageHelpers.resolveStoryboardImageBinding({
    lifecycleCurrent: lifecycle.canBind(oldLease), taskTracked: true, storyboardPresent: true, sourceUnchanged: true,
  }).shouldBind, false, 'a late old batch cannot clear the newer batch after its lease has finished');
  lifecycle.invalidateBindings();
  assert.equal(lifecycle.canBind(currentLease), false, 'undo/cancellation of binding ownership cannot restore an older selection');
  lifecycle.finish(currentLease);
}

const traceMutations: Array<{
  label: string;
  patch: StoryboardImagePromptTracePatch;
}> = [
  { label: '规则集 ID', patch: { imagePromptRuleSetId: 'image-rule-another-openai' } },
  { label: '规则集版本', patch: { imagePromptRuleSetVersion: '1.0.1' } },
  { label: '分类预设 ID', patch: { imagePromptPresetId: 'image-preset-another-storyboard' } },
  { label: '分类预设版本', patch: { imagePromptPresetVersion: '1.0.1' } },
  { label: '输出格式', patch: { imagePromptFormat: 'sd-tags' } },
];
for (const mutation of traceMutations) {
  assert.notEqual(
    storyboardImageSourceFingerprint(
      storyboard,
      withImagePromptTrace(shotRequests[1], mutation.patch),
    ),
    sourceFingerprint,
    `${mutation.label}变化必须让旧分镜图过期，不能继续自动绑定`,
  );
}
const referenceOnlyChange: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.map((shot) => shot.id === shotRequests[1].shotId
    ? { ...shot, referenceAssetIds: ['asset-generated-later'] }
    : shot),
};
assert.equal(
  storyboardImageSourceFingerprint(referenceOnlyChange, tracedShotRequests[1]),
  sourceFingerprint,
  'newly generated references must not make the source look stale',
);
const editedShot: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.map((shot) => shot.id === shotRequests[1].shotId
    ? { ...shot, action: '用户已改成停下并回头' }
    : shot),
};
assert.notEqual(
  storyboardImageSourceFingerprint(editedShot, tracedShotRequests[1]),
  sourceFingerprint,
  'editing the source shot must invalidate automatic binding',
);

const firstShotFingerprint = storyboardImageSourceFingerprint(storyboard, tracedShotRequests[0]);
const appendedShotStoryboard: Storyboard = {
  ...storyboard,
  shots: [...storyboard.shots, makeShot(4)],
};
assert.notEqual(
  storyboardImageSourceFingerprint(appendedShotStoryboard, tracedShotRequests[0]),
  firstShotFingerprint,
  'appending a shot must invalidate an image source fingerprint',
);
const deletedShotStoryboard: Storyboard = {
  ...storyboard,
  shots: storyboard.shots.slice(0, -1),
};
assert.notEqual(
  storyboardImageSourceFingerprint(deletedShotStoryboard, tracedShotRequests[0]),
  firstShotFingerprint,
  'deleting a shot must invalidate an image source fingerprint',
);
const reorderedShotStoryboard: Storyboard = {
  ...storyboard,
  shots: [storyboard.shots[0], storyboard.shots[2], storyboard.shots[1]],
};
assert.notEqual(
  storyboardImageSourceFingerprint(reorderedShotStoryboard, tracedShotRequests[0]),
  firstShotFingerprint,
  'reordering later shots must invalidate the full ordered-shot fingerprint even when the requested first shot is unchanged',
);
const polishedSourceFingerprint = storyboardImageSourceFingerprint(polishedStoryboard, tracedPolishedShotRequests[1]);
const repolishedStoryboard: Storyboard = {
  ...polishedStoryboard,
  finalPrompt: polishedStoryboard.finalPrompt.replace('贴墙快步通过', '压低身形快速通过'),
};
assert.notEqual(
  storyboardImageSourceFingerprint(repolishedStoryboard, tracedPolishedShotRequests[1]),
  polishedSourceFingerprint,
  'editing the converter-polished segment actually used for image generation must invalidate automatic binding',
);

const fingerprintContext: StoryboardImageBuildContextFixture = {
  characters: [contextCharacter],
  locations: [contextLocation],
  props: [contextProp],
  scenes: [contextScene],
  assets: [explicitShotReference, characterReference, locationReference, propReference],
};
const contextualFingerprint = storyboardImageSourceFingerprint(
  boardWithExplicitShotReference,
  tracedContextRequests[0],
  fingerprintContext,
);
assert.notEqual(
  storyboardImageSourceFingerprint(
    boardWithExplicitShotReference,
    tracedContextRequests[0],
    {
      ...fingerprintContext,
      characters: [{
        ...contextCharacter,
        appearance: '乌黑长发，眉间一颗小痣，窄长眼形，左眉尾新增一道明确疤痕',
      }],
    },
  ),
  contextualFingerprint,
  'editing character continuity facts used by the converter must invalidate automatic binding',
);
assert.notEqual(
  storyboardImageSourceFingerprint(
    boardWithExplicitShotReference,
    tracedContextRequests[0],
    {
      ...fingerprintContext,
      locations: [{
        ...contextLocation,
        description: '三人宽的狭长青石甬道，左墙改为连续莲纹凹槽',
      }],
    },
  ),
  contextualFingerprint,
  'editing location continuity facts used by the converter must invalidate automatic binding',
);
assert.notEqual(
  storyboardImageSourceFingerprint(
    boardWithExplicitShotReference,
    tracedContextRequests[0],
    {
      ...fingerprintContext,
      assets: fingerprintContext.assets.map((asset) => asset.id === characterReference.id
        ? { ...asset, visualAnchor: '阿莲左眉尾疤痕和青色长衣必须保持一致' }
        : asset),
    },
  ),
  contextualFingerprint,
  'editing a matched reference image anchor must invalidate automatic binding',
);
const generatedStoryboardReference: ReferenceAsset = {
  ...explicitShotReference,
  id: 'asset-generated-current-storyboard',
  source: 'generated',
  sourceStoryboardId: boardWithExplicitShotReference.id,
  sourceShotId: contextRequests[0].shotId,
  imageVariant: contextRequests[0].imageVariant,
  visualAnchor: '本批次刚生成的分镜图可见锚点',
};
const boardAfterGeneratedReference: Storyboard = {
  ...boardWithExplicitShotReference,
  shots: boardWithExplicitShotReference.shots.map((shot) => shot.id === contextRequests[0].shotId
    ? {
        ...shot,
        referenceAssetIds: [...shot.referenceAssetIds, generatedStoryboardReference.id],
      }
    : shot),
};
assert.equal(
  storyboardImageSourceFingerprint(
    boardAfterGeneratedReference,
    tracedContextRequests[0],
    {
      ...fingerprintContext,
      assets: [...fingerprintContext.assets, generatedStoryboardReference],
    },
  ),
  contextualFingerprint,
  'images generated by the same storyboard must not make later FIFO tasks look stale',
);

let activeWorkers = 0;
let maxActiveWorkers = 0;
const batchEvents: string[] = [];
const batchResults = await runStoryboardImageBatch(
  shotRequests,
  async (request) => {
    batchEvents.push(`start:${request.shotId}`);
    activeWorkers += 1;
    maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
    await new Promise((resolve) => setTimeout(resolve, 8));
    activeWorkers -= 1;
    batchEvents.push(`end:${request.shotId}`);
    if (request.shotId === 'shot-2') throw new Error('模拟单张失败');
    return `asset-for-${request.shotId}`;
  },
);
assert.equal(maxActiveWorkers, 1, 'storyboard images must wait for the previous image to settle before starting');
assert.deepEqual(batchEvents, [
  'start:shot-1',
  'end:shot-1',
  'start:shot-2',
  'end:shot-2',
  'start:shot-3',
  'end:shot-3',
]);
assert.deepEqual(batchResults.map((item) => item.status), ['succeeded', 'failed', 'succeeded']);
assert.equal(batchResults[0]?.value, 'asset-for-shot-1');
assert.match(batchResults[1]?.error || '', /模拟单张失败/u);
assert.equal(batchResults[2]?.value, 'asset-for-shot-3', 'one failure must not cancel later images');

type ExecuteStoryboardImageGenerationFixture = <T>(input: {
  request: StoryboardImageGenerationRequest;
  negativePrompt?: string;
  referenceImage?: string;
  referenceImages?: string[];
  primaryReferenceImageCount?: number;
  convertPrompt: (source: string) => Promise<string>;
  persistConvertedPrompt: (prompt: string) => void | Promise<void>;
  generateImage: (input: {
    prompt: string;
    negativePrompt?: string;
    referenceImage?: string;
    referenceImages?: string[];
    primaryReferenceImageCount?: number;
    width: number;
    height: number;
  }) => Promise<T>;
}) => Promise<{ finalPrompt: string; generated: T }>;

const executionHelpers = storyboardImageHelpers as typeof storyboardImageHelpers & {
  executeStoryboardImageGeneration?: ExecuteStoryboardImageGenerationFixture;
};
assert.equal(
  typeof executionHelpers.executeStoryboardImageGeneration,
  'function',
  'storyboard image generation must expose a converter-first orchestration boundary',
);
assert.ok(executionHelpers.executeStoryboardImageGeneration);

const convertedStillPrompt = '联盟生物研究所战区观测室内，两名分析员注视无文字的立体地形投影；孢子云浓度轨迹沿废墟地形汇聚并指向一片孤立区域，画面中不出现西娅本人，末日废土电影写实，中景，硬质逆光穿过尘雾，16:9。';
const executionEvents: string[] = [];
const initialTask = createImageGenerationTask({
  id: 'image-task-converter-first',
  name: shotRequests[1]?.name || '第2镜',
  assetKind: 'storyboard',
  imageVariant: 'storyboard-frame',
  prompt: '等待转换',
  width: shotRequests[1]?.width || 1536,
  height: shotRequests[1]?.height || 1024,
  backend: 'openai',
  model: 'image-model',
}, 1, 'running');
let persistedTasks: GenerationTask[] = [initialTask];
const executed = await executionHelpers.executeStoryboardImageGeneration({
  request: tracedShotRequests[1],
  negativePrompt: '文字、水印',
  referenceImages: ['data:image/png;base64,CA==', 'data:image/webp;base64,CQ=='],
  primaryReferenceImageCount: 1,
  convertPrompt: async (source) => {
    executionEvents.push(`convert:${source.includes('剧情原文：')}`);
    return convertedStillPrompt;
  },
  persistConvertedPrompt: (prompt) => {
    executionEvents.push(`persist:${prompt}`);
    persistedTasks = patchImageGenerationTask(persistedTasks, initialTask.id, { prompt }, 2);
  },
  generateImage: async (input) => {
    executionEvents.push(`generate:${input.prompt}`);
    assert.equal(input.prompt, convertedStillPrompt);
    assert.doesNotMatch(input.prompt, /剧情原文：|帧位要求：|音效：|【\d+(?:\.\d+)?s-/u);
    assert.deepEqual(
      input.referenceImages,
      ['data:image/png;base64,CA==', 'data:image/webp;base64,CQ=='],
      'converter-first orchestration must forward every resolved reference image to the image backend',
    );
    assert.equal(input.primaryReferenceImageCount, 1);
    return { dataUrl: 'data:image/png;base64,AA==' };
  },
});
assert.deepEqual(executionEvents, [
  'convert:true',
  `persist:${convertedStillPrompt}`,
  `generate:${convertedStillPrompt}`,
]);
assert.equal(executed.finalPrompt, convertedStillPrompt);
assert.deepEqual(executed.generated, { dataUrl: 'data:image/png;base64,AA==' });
assert.equal(
  persistedTasks.filter(isImageGenerationTask).find((task) => task.id === initialTask.id)?.prompt,
  convertedStillPrompt,
  'the task center must keep the converted final image prompt instead of the conversion rules',
);

let persistedAfterFailure = false;
let generatedAfterFailure = false;
await assert.rejects(
  () => executionHelpers.executeStoryboardImageGeneration!({
    request: tracedShotRequests[1],
    convertPrompt: async () => {
      throw new Error('分镜图片提示词转换失败');
    },
    persistConvertedPrompt: () => {
      persistedAfterFailure = true;
    },
    generateImage: async () => {
      generatedAfterFailure = true;
      return { dataUrl: 'must-not-exist' };
    },
  }),
  /分镜图片提示词转换失败/u,
);
assert.equal(persistedAfterFailure, false, 'a failed conversion must not persist the raw rules as a final prompt');
assert.equal(generatedAfterFailure, false, 'a failed conversion must never fall back to sending raw rules to the image model');

let generatedAfterUnchangedConversion = false;
let persistedUnchangedPrompt = '';
await assert.doesNotReject(
  () => executionHelpers.executeStoryboardImageGeneration!({
    request: tracedShotRequests[1],
    convertPrompt: async (source) => source,
    persistConvertedPrompt: (prompt) => {
      persistedUnchangedPrompt = prompt;
    },
    generateImage: async () => {
      generatedAfterUnchangedConversion = true;
      return { dataUrl: 'mock-generated-image' };
    },
  }),
  'an unchanged successful AI result must not be rejected by source similarity or video-field words',
);
assert.equal(
  generatedAfterUnchangedConversion,
  true,
  'AI-returned content proceeds after successful conversion without local lexical judgment',
);
tracedShotRequests[1].conversionSource.split(/\r?\n/u).filter(Boolean).forEach((line) => {
  assert.ok(persistedUnchangedPrompt.includes(line.trim()), 'format normalization must retain every AI-returned content line');
});

let generatedFromChineseNai = false;
let persistedChineseNaiPrompt = '';
await assert.doesNotReject(
  () => executionHelpers.executeStoryboardImageGeneration!({
    request: withImagePromptTrace(shotRequests[1], { imagePromptFormat: 'nai-tags' }),
    convertPrompt: async () => '雨夜石门前，黑发女子推开石门，电影感光影',
    persistConvertedPrompt: (prompt) => {
      persistedChineseNaiPrompt = prompt;
    },
    generateImage: async () => {
      generatedFromChineseNai = true;
      return { dataUrl: 'mock-generated-image' };
    },
  }),
  'Chinese words are model content rather than an unsupported adapter protocol',
);
assert.equal(
  generatedFromChineseNai,
  true,
  'storyboard image generation must accept successful AI text without a local language gate',
);
assert.ok(persistedChineseNaiPrompt.includes('雨夜石门前'));
assert.throws(
  () => storyboardImageHelpers.assertUsableConvertedStoryboardImagePrompt('', 'source', 'natural-language'),
  /空内容/u,
  'technical nonempty response validation is still required',
);
assert.throws(
  () => storyboardImageHelpers.assertUsableConvertedStoryboardImagePrompt({ message: 'not prompt text' }, 'source', 'natural-language'),
  /空内容/u,
  'objects cannot be silently stringified into image prompts',
);

const crossEntryEvents: string[] = [];
const queuedBatch = runStoryboardImageBatch(
  shotRequests,
  async (request) => {
    crossEntryEvents.push(`start:${request.shotId}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
    crossEntryEvents.push(`end:${request.shotId}`);
    return request.shotId;
  },
);
const laterWorkbenchTask = enqueueImageTask(async () => {
  crossEntryEvents.push('start:workbench');
  return 'workbench';
});
await Promise.all([queuedBatch, laterWorkbenchTask]);
assert.deepEqual(
  crossEntryEvents,
  [
    'start:shot-1',
    'end:shot-1',
    'start:shot-2',
    'end:shot-2',
    'start:shot-3',
    'end:shot-3',
    'start:workbench',
  ],
  'a later image-workbench task must not jump ahead of already-created storyboard image tasks',
);

const directedActionBoard: Storyboard = {
  ...storyboard,
  id: 'directed-action-board',
  sourceStoryContent: '敌群从山口冲向石台上的夏提雅，夏提雅在冲锋轴线终点。',
  shots: [makeShot(1, {
    subject: '敌群与夏提雅',
    action: '敌群从山口向石台上的夏提雅冲锋，身体和武器朝向夏提雅',
    space: '敌群在前景至中景，夏提雅在远处石台上且清晰可见',
    direction: '敌群的运动终点是夏提雅，不是摄影机；敌群面向夏提雅',
    camera: '摄影机位于敌群后侧，沿敌群指向夏提雅的运动轴拍摄',
  })],
  shotCount: 1,
};
const directedActionSource = buildStoryboardImageRequests(directedActionBoard, 'storyboard-shots')[0]?.conversionSource || '';
assert.match(directedActionSource, /施事者.*动作.*目标.*终点/u);
assert.match(directedActionSource, /不能把摄影机.*自动当成目标/u);
assert.match(directedActionSource, /目标在画外.*不得凭动作对象把画外人物补入/u);
assert.match(directedActionSource, /敌群从山口向石台上的夏提雅冲锋/u);
assert.match(directedActionSource, /运动终点是夏提雅/u);

console.log('storyboard image prompt and binding regression checks passed');
