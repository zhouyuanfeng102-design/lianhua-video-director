import assert from 'node:assert/strict';
import { BODY_PROPORTION_STABILITY_RULE } from '../src/imageGeneration';
import fs from 'node:fs';
import {
  allocateTimeline,
  analyzeTextLocally,
  buildImagePrompt,
  buildGlobalLock,
  buildPromptPlan,
  buildShots,
  estimateDialogueSpeechSec,
  estimateDialogueWindowSec,
  needsTimelinePromptMigration,
  recommendShotCount,
  renderFinalPrompt,
  renderShotPrompt,
  sanitizeContinuityState,
  validateStoryboardPrompt,
} from '../src/promptEngine';
import { compileTargetPrompt } from '../src/promptAdapters';
import {
  hasNsfwDetailSignal,
  sanitizeLegacyNsfwPromptLeak,
  sanitizeNsfwAutomaticConstraints,
  sanitizeNsfwGenerationControls,
  stripAutomaticAgeMetadata,
} from '../src/promptConstraints';
import { applyMasterPromptEdit, parseMasterTimelinePrompt } from '../src/masterTimeline';
import { reconcileSequenceSegmentsToShotProvenance } from '../src/sequencePlan';
import {
  hasNarrativeFirstPersonActor,
  hasNarrativeFirstPersonReference,
  resolveFirstPersonSubject,
  rewriteNarrativeFirstPersonReferences,
  semanticActionsEquivalent,
} from '../src/semanticEvents';
import { extractStoryBeats } from '../src/storySegmentation';
import { defaultConverterPresets, defaultRuleSets, defaultStylePresets } from '../src/storage';
import type {
  AiStoryboardShotPlan,
  Character,
  Location,
  Prop,
  ReferenceAsset,
  Scene,
  Storyboard,
  VideoSequencePlan,
} from '../src/types';
import { resolveVisualStylePrompt } from '../src/visualStyles';
import { requestShotRecommendation } from '../src/services/llm';

const scene: Scene = {
  id: 'scene_test',
  title: '雨夜客栈',
  content: '李云走进客栈，掌柜递来染血的信。李云低声说：“门外是谁？”三声敲门后，他吹灭烛火。',
  summary: '李云收到染血来信，警觉地询问门外来客并吹灭烛火。',
  characterIds: [],
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const style = defaultStylePresets[0];
const converter = defaultConverterPresets[0];
const timelineRule = defaultRuleSets[0];
assert.equal(defaultRuleSets.length, 1);

const shots = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定推进，随后切至人物手部特写',
  lighting: '烛火暖光与门外冷蓝雨光形成对比',
  style,
  extra: '',
});

const aiPlanScene: Scene = {
  ...scene,
  id: 'scene_ai_storyboard_plan',
  content: '林舟推开院门。他发现正屋木门已经敞开。',
  summary: '林舟进入院落并发现正屋门异常敞开。',
};
const aiPlanShots = [
  {
    startSec: 0,
    endSec: 4,
    sourceExcerpt: '林舟推开院门。',
    purpose: '建立进入动作',
    subject: '林舟',
    action: '林舟压下门闩并推开院门',
    camera: '中景跟随门扇向内移动',
    transition: '门扇遮挡切换',
    lighting: '暮色从门缝铺入院内',
    sound: '木门摩擦声与脚步声',
    result: '院落入口完整显露',
  },
  {
    startSec: 4,
    endSec: 10,
    sourceExcerpt: '他发现正屋木门已经敞开。',
    purpose: '揭示异常',
    subject: '林舟',
    action: '林舟停步抬眼看向敞开的正屋木门',
    camera: '越肩推近正屋门洞',
    transition: '沿视线方向切换',
    lighting: '屋内暗部与院中暮色形成反差',
    sound: '脚步骤停，风声穿过门洞',
    result: '敞开的正屋木门成为明确视觉目标',
  },
];
const materializedAiPlanShots = buildShots({
  scene: aiPlanScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 10,
  shotMode: 'auto',
  shotCount: 99,
  pace: 'standard',
  camera: '这个本地镜头参数不得覆盖 AI 计划',
  lighting: '这个本地光影参数不得覆盖 AI 计划',
  style,
  extra: '',
  aiPlan: { shots: aiPlanShots },
} as Parameters<typeof buildShots>[0] & { aiPlan: { shots: typeof aiPlanShots } });
assert.deepEqual(
  materializedAiPlanShots.map((shot) => ({
    startSec: shot.startSec,
    endSec: shot.endSec,
    purpose: shot.purpose,
    subject: shot.subject,
    action: shot.action,
    camera: shot.camera,
    transition: shot.transition,
    lighting: shot.lighting,
    sound: shot.sound,
    result: shot.result,
    sourceStart: shot.sourceStart,
    sourceEnd: shot.sourceEnd,
  })),
  [
    {
      startSec: 0,
      endSec: 4,
      purpose: '建立进入动作',
      subject: '林舟',
      action: '林舟压下门闩并推开院门',
      camera: '中景跟随门扇向内移动',
      transition: '门扇遮挡切换',
      lighting: '暮色从门缝铺入院内',
      sound: '木门摩擦声与脚步声',
      result: '院落入口完整显露',
      sourceStart: 0,
      sourceEnd: 7,
    },
    {
      startSec: 4,
      endSec: 10,
      purpose: '揭示异常',
      subject: '林舟',
      action: '林舟停步抬眼看向敞开的正屋木门',
      camera: '越肩推近正屋门洞',
      transition: '沿视线方向切换',
      lighting: '屋内暗部与院中暮色形成反差',
      sound: '脚步骤停，风声穿过门洞',
      result: '敞开的正屋木门成为明确视觉目标',
      sourceStart: 7,
      sourceEnd: 19,
    },
  ],
  'automatic shots must materialize the model decisions without local shot redistribution',
);

// Explicit AI names are not locally extracted candidates. Exercise the whole
// mocked request -> materialization -> rendering path so a relaxed request
// parser cannot silently lose the same name at the next layer.
const explicitStoryboardSubjects = [
  '神',
  '雨',
  '清泉市夜晚',
  '于吉',
  '在天神尊',
  '他山石',
  '我妻善逸',
  'Alexander Montgomery',
  'O’Connor（北方旅人）',
  '林舟与雪衣道侣以及玄衣道侣',
  '整个人群',
  '人物画像',
  '角色雕像',
  '头部雕像',
  '山间连绵起伏的云海与破晓天光',
];
const explicitSubjectOriginalWindow = globalThis.window;
try {
  for (const [caseIndex, subject] of explicitStoryboardSubjects.entries()) {
    const explicitScene: Scene = {
      ...aiPlanScene,
      id: `scene_explicit_subject_${caseIndex}`,
      content: `${subject}的轮廓在晨光中显现。`,
      summary: '晨光显露主体轮廓。',
    };
    const action = `${subject}的轮廓在晨光中显现，投影缓缓移动`;
    const returnedSubject = caseIndex % 2 ? `  ＠“${subject}”  ` : subject;
    const aiShot: AiStoryboardShotPlan = {
      startSec: 0,
      endSec: 3,
      sourceExcerpt: explicitScene.content,
      purpose: '建立可见主体',
      subject: returnedSubject,
      action,
      camera: '固定全景展示轮廓',
      transition: '自然结束',
      lighting: '清晨柔光',
      sound: '无',
      result: '轮廓清晰可见',
    };
    let requestCount = 0;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { lianhuaDesktop: { request: async () => {
        requestCount += 1;
        return {
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [aiShot] }) } }] }),
        };
      } } },
    });
    const recommendation = await requestShotRecommendation({
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'https://subject-regression.example.test/v1/chat/completions',
      apiKey: 'mock-only',
      model: 'mock-storyboard-model',
      temperature: 0,
      maxTokens: 1024,
      vision: false,
    }, { durationSec: 3, workflow: 'drama', pace: 'standard', story: explicitScene.content });
    assert.equal(requestCount, 1, `${subject}: a usable name must not spend a repair request`);
    const explicitShots = buildShots({
      scene: explicitScene,
      characters: [],
      locations: [],
      props: [],
      assets: [],
      workflow: 'drama',
      durationSec: 3,
      shotMode: 'auto',
      shotCount: 1,
      pace: 'standard',
      camera: '',
      lighting: '',
      style,
      extra: '',
      aiPlan: { shots: recommendation.shots },
    });
    assert.equal(explicitShots[0]?.subject, subject, `${subject}: materialization must preserve the complete name`);
    assert.equal(explicitShots[0]?.action, action, `${subject}: a name containing 我 is not a narrative pronoun`);
    const explicitPrompt = renderFinalPrompt({
      durationSec: 3,
      aspectRatio: '16:9',
      resolution: '2K',
      audioMode: 'stereo',
      workflow: 'drama',
      inputMode: 'text',
      scene: explicitScene,
      globalLock: '',
      shots: explicitShots,
      assets: [],
      style,
      ruleSet: timelineRule,
      converter,
      extra: '',
    });
    assert.ok(explicitPrompt.includes(`主体：@${subject}（`), `${subject}: rendering must not infer another subject or truncate the name`);
    assert.equal(needsTimelinePromptMigration(explicitPrompt), false, `${subject}: the rendered name must not trigger legacy migration`);
    const validation = validateStoryboardPrompt({
      durationSec: 3,
      workflow: 'drama',
      inputMode: 'text',
      shots: explicitShots,
      finalPrompt: explicitPrompt,
      ruleSetId: timelineRule.id,
    }, [], timelineRule);
    assert.equal(validation.valid, true, `${subject}: ${validation.errors.join('; ')}`);
    const unrelatedAsset: ReferenceAsset = {
      id: 'unrelated-subject-reference',
      name: '不相关人物',
      type: 'character',
      role: 'character',
      visualAnchor: '与本镜焦点无关的人物参考',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const referencedShot = { ...explicitShots[0], referenceAssetIds: [unrelatedAsset.id] };
    const referencedPrompt = renderShotPrompt(referencedShot, 3, [unrelatedAsset]);
    assert.ok(referencedPrompt.includes(`主体：@${subject}（`), `${subject}: a shared reference image must not replace the explicit subject`);
    if (['于吉', '在天神尊', '他山石', '我妻善逸', 'Alexander Montgomery'].includes(subject)) {
      const namedCharacter: Character = {
        id: `character_explicit_subject_${caseIndex}`,
        name: subject,
        gender: '星灵双相',
        apparentAge: '',
        race: '',
        appearance: '',
        outfit: '',
        signatureProps: '',
        personality: '',
        motionHabits: '',
        anchor: '',
        negativeContinuity: '',
        assetIds: [],
      };
      const groundedPrompt = renderShotPrompt(explicitShots[0], 3, [], explicitShots, 'stereo', timelineRule, { characters: [namedCharacter] });
      assert.ok(groundedPrompt.includes(`主体：@${subject}（`), `${subject}: authoritative character names must not be normalized as prose`);
      assert.ok(groundedPrompt.includes('性别设定〔星灵双相〕'), `${subject}: character continuity must still resolve by its complete name`);
    }
  }
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: explicitSubjectOriginalWindow,
  });
}

const materializeSourceShot = (story: string, planned: AiStoryboardShotPlan) => buildShots({
  scene: { ...aiPlanScene, content: story }, characters: [], locations: [], props: [], assets: [],
  workflow: 'drama', durationSec: 10, shotMode: 'auto', shotCount: 1, pace: 'standard', camera: '', lighting: '', style, extra: '',
  aiPlan: { shots: [{ ...planned, startSec: 0, endSec: 10 }] },
})[0];
const scopedPrivatePlan: AiStoryboardShotPlan = {
  ...aiPlanShots[0], visiblePrivatePartsByCharacter: { 'character-scoped': ['breasts'] },
};
const scopedPrivateShot = materializeSourceShot(aiPlanScene.content, scopedPrivatePlan);
assert.deepEqual(scopedPrivateShot.visiblePrivatePartsByCharacter, scopedPrivatePlan.visiblePrivatePartsByCharacter,
  'materializing an AI shot must retain its explicit private visibility selection');
assert.notStrictEqual(scopedPrivateShot.visiblePrivatePartsByCharacter, scopedPrivatePlan.visiblePrivatePartsByCharacter);
assert.notStrictEqual(scopedPrivateShot.visiblePrivatePartsByCharacter?.['character-scoped'],
  scopedPrivatePlan.visiblePrivatePartsByCharacter?.['character-scoped']);
assert.equal(materializeSourceShot(aiPlanScene.content, aiPlanShots[0]).visiblePrivatePartsByCharacter, undefined,
  'a missing AI selection must not be inferred during local materialization');
const repeatedSourceStory = '\r\n  林舟推开院门。他等了一会儿。林舟推开院门。';
const exactOccurrenceStart = repeatedSourceStory.lastIndexOf('林舟推开院门。');
const exactOccurrence = materializeSourceShot(repeatedSourceStory, {
  ...aiPlanShots[0], sourceUnitIds: ['source-3'], sourceLocationStatus: 'located', sourceStart: exactOccurrenceStart,
  sourceEnd: repeatedSourceStory.length,
});
assert.equal(exactOccurrence.sourceStart, exactOccurrenceStart, 'ID-owned offsets must not jump to an earlier occurrence or expand to unrelated source beats');
assert.equal(exactOccurrence.sourceEnd, repeatedSourceStory.length);
for (const sourceExcerpt of ['', '模型改写的动作，不是原文']) {
  const unlocated = materializeSourceShot(repeatedSourceStory, { ...aiPlanShots[0], sourceExcerpt, sourceLocationStatus: 'unlocated' });
  assert.equal(unlocated.sourceLocationStatus, 'unlocated');
  assert.equal(unlocated.sourceStart, undefined, 'empty/unlocated excerpts never turn into source offset 0');
  assert.equal(unlocated.sourceEnd, undefined);
  assert.deepEqual(unlocated.sourceBeatIds, [], 'unlocated shots cannot borrow arbitrary semantic beats');
  assert.equal(unlocated.action, aiPlanShots[0].action);
  assert.equal(unlocated.sourceExcerpt, sourceExcerpt, 'model-provided source explanations are retained in the saved shot');
}
const unlocatedLegacy = materializeSourceShot(repeatedSourceStory, { ...aiPlanShots[0], sourceExcerpt: '旧模型意译的进门动作' });
assert.equal(unlocatedLegacy.sourceLocationStatus, 'unlocated', 'an old unmatched excerpt does not reject a complete model-authored shot');

for (const subject of ['我', 'none', '主体名', '环境主体']) {
  const action = `${subject}停步说：“我会跟上。”`;
  const authoredShot = materializeSourceShot(repeatedSourceStory, { ...aiPlanShots[0], subject, action, sound: '动作层-[第15s门闩轻响]' });
  assert.equal(authoredShot.authoredBy, 'text-api');
  assert.equal(authoredShot.subject, subject);
  assert.equal(authoredShot.action, action, 'materialization must not apply a local narrative-pronoun rewrite');
  const prompt = renderShotPrompt(authoredShot, 10, [], [authoredShot]);
  assert.ok(prompt.includes(`主体：@${subject}（`), 'a local renderer must not replace the AI subject with an asset, heuristic or fallback');
  const report = validateStoryboardPrompt({ durationSec: 10, workflow: 'drama', inputMode: 'text', shots: [authoredShot], finalPrompt: prompt, ruleSetId: timelineRule.id }, [], timelineRule);
  assert.deepEqual(report.errors, [], 'AI wording and embedded sound time only produce advice, not content rejection');
  assert.ok(report.warnings.some((warning) => /音效.*超出|主体.*用词/u.test(warning)));
  assert.equal(needsTimelinePromptMigration(prompt, timelineRule, [authoredShot]), false, 'AI wording cannot lock copying behind a legacy migration gate');
  assert.doesNotThrow(() => applyMasterPromptEdit([authoredShot], prompt, 10), 'AI plan confirmation cannot reintroduce embedded sound-time rejection');
  const localShot = { ...authoredShot, authoredBy: undefined };
  assert.throws(() => applyMasterPromptEdit([localShot], prompt, 10), /超出/u, 'unmarked legacy/local editing keeps its existing validation');
  const structuralReport = validateStoryboardPrompt({ durationSec: 10, workflow: 'drama', inputMode: 'text', shots: [authoredShot], finalPrompt: prompt.replace('【0s-', '【1s-'), ruleSetId: timelineRule.id }, [], timelineRule);
  assert.ok(structuralReport.errors.some((error) => /第一镜必须从 0 秒|时间边界/u.test(error)), 'AI authorship does not bypass structural timeline checks');
}

const coarseBeatStory = '\n  暴雨中的废港，三十米高的镰刀头怪兽从海面跃出，四肢着地撞碎成排集装箱。怪兽甩动骨质长尾扫断起重机，背部甲壳被闪电照亮，喉部蓝光迅速聚集。';
const coarseBeatFirstExcerpt = '暴雨中的废港，三十米高的镰刀头怪兽从海面跃出，四肢着地撞碎成排集装箱。';
const coarseBeatSecondExcerpt = '怪兽甩动骨质长尾扫断起重机，背部甲壳被闪电照亮，喉部蓝光迅速聚集。';
const coarseBeatFirstStart = coarseBeatStory.indexOf(coarseBeatFirstExcerpt);
const coarseBeatSecondStart = coarseBeatStory.indexOf(coarseBeatSecondExcerpt);
const coarseBeatScene: Scene = {
  ...scene,
  id: 'scene_ai_partial_excerpt_coarse_beat',
  content: coarseBeatStory,
  summary: '怪兽跃出海面、破坏港口并开始蓄力。',
  sourceStart: 0,
  sourceEnd: coarseBeatStory.length,
};
const coarseBeatPlanShots = [
  {
    startSec: 0,
    endSec: 4,
    sourceExcerpt: coarseBeatFirstExcerpt,
    sourceUnitIds: ['source-1'],
    sourceStart: coarseBeatFirstStart,
    sourceEnd: coarseBeatFirstStart + coarseBeatFirstExcerpt.length,
    sourceLocationStatus: 'located' as const,
    purpose: '建立怪兽登场与第一次破坏',
    subject: '镰刀头怪兽',
    action: '镰刀头怪兽跃出海面并撞碎集装箱',
    camera: '低机位跟随跃出动作',
    transition: '沿尾部甩动方向切换',
    lighting: '闪电勾勒怪兽轮廓',
    sound: '海浪与金属碎裂声',
    result: '成排集装箱被撞碎',
  },
  {
    startSec: 4,
    endSec: 8,
    sourceExcerpt: coarseBeatSecondExcerpt,
    sourceUnitIds: ['source-2'],
    sourceStart: coarseBeatSecondStart,
    sourceEnd: coarseBeatSecondStart + coarseBeatSecondExcerpt.length,
    sourceLocationStatus: 'located' as const,
    purpose: '推进破坏并建立蓄力状态',
    subject: '镰刀头怪兽',
    action: '镰刀头怪兽扫断起重机并在喉部聚集蓝光',
    camera: '环绕跟拍长尾后推近喉部',
    transition: '由断裂起重机摇向蓝光',
    lighting: '闪电与喉部蓝光交替照明',
    sound: '钢架断裂声与能量嗡鸣',
    result: '喉部蓝光完成聚集',
  },
];
const coarseBeatShots = buildShots({
  scene: coarseBeatScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'auto',
  shotCount: 2,
  pace: 'standard',
  camera: '',
  lighting: '',
  style,
  extra: '',
  aiPlan: { shots: coarseBeatPlanShots },
} as Parameters<typeof buildShots>[0] & { aiPlan: { shots: typeof coarseBeatPlanShots } });
const coarseStoryBeats = extractStoryBeats(coarseBeatStory);
assert.deepEqual(
  coarseBeatShots.map((shot) => ({
    sourceStart: shot.sourceStart,
    sourceEnd: shot.sourceEnd,
    sourceLocationStatus: shot.sourceLocationStatus,
  })),
  [
    {
      sourceStart: coarseBeatFirstStart,
      sourceEnd: coarseBeatFirstStart + coarseBeatFirstExcerpt.length,
      sourceLocationStatus: 'located',
    },
    {
      sourceStart: coarseBeatSecondStart,
      sourceEnd: coarseBeatSecondStart + coarseBeatSecondExcerpt.length,
      sourceLocationStatus: 'located',
    },
  ],
  'source-unit-owned shot excerpts must retain their exact sub-ranges instead of expanding to the coarse beat',
);
assert.deepEqual(
  coarseStoryBeats.map((beat) => ({ id: beat.id, sourceStart: beat.sourceStart, sourceEnd: beat.sourceEnd })),
  [{ id: 'beat_1', sourceStart: 0, sourceEnd: coarseBeatStory.length }],
  'the fixture must keep both AI source excerpts inside one coarse semantic beat',
);
const partialExcerptSequencePlan: VideoSequencePlan = {
  id: 'plan_ai_partial_excerpt_coarse_beat',
  title: 'AI 部分摘录粗粒度节拍回归',
  sourceStoryTitle: coarseBeatScene.title,
  sourceStoryContent: coarseBeatStory,
  durationMode: 'fixed',
  requestedTotalDurationSec: 8,
  totalDurationSec: 8,
  segmentDurationSec: 8,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  segments: [{
    id: 'segment_ai_partial_excerpt_coarse_beat',
    index: 1,
    title: '完整段',
    globalStartSec: 0,
    globalEndSec: 8,
    durationSec: 8,
    content: coarseBeatStory,
    summary: coarseBeatScene.summary,
    sourceSceneIds: [coarseBeatScene.id],
    sourceBeatIds: ['beat_1'],
    sourceShotIds: coarseBeatShots.map((shot) => shot.id),
    narrativePurpose: '完整呈现粗粒度节拍内的两个镜头',
    entryState: '怪兽尚未登场',
    exitState: '怪兽完成蓄力',
    transitionHint: '承接蓝光爆发',
    status: 'planned',
  }],
  createdAt: 1,
  updatedAt: 1,
};
const reconciledPartialExcerptPlan = reconcileSequenceSegmentsToShotProvenance(
  partialExcerptSequencePlan,
  coarseBeatShots,
  coarseStoryBeats,
  [coarseBeatScene],
);
assert.deepEqual(
  reconciledPartialExcerptPlan.segments[0].sourceBeatIds,
  ['beat_1'],
  'AI sourceExcerpt ranges may cover only part of a coarse beat without breaking sequence provenance reconciliation',
);

const compositionInputAsset: ReferenceAsset = {
  id: 'asset-input-composition',
  name: '第10镜构图参考',
  type: 'reference',
  role: 'composition',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const lastFrameInputAsset: ReferenceAsset = {
  id: 'asset-input-last-frame',
  name: '尾帧参考',
  type: 'last-frame',
  role: 'last-frame',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const audioInputAsset: ReferenceAsset = {
  id: 'asset-input-audio',
  name: '声音资产',
  type: 'audio',
  role: 'audio',
  mediaType: 'audio',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const selectedVisualInputAssets = [compositionInputAsset, lastFrameInputAsset, audioInputAsset];
const exactShotsWithGeneratedVisualReferences = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: selectedVisualInputAssets,
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定推进',
  lighting: '冷暖对比',
  style,
  extra: '',
});
exactShotsWithGeneratedVisualReferences.forEach((shot) => assert.deepEqual(
  shot.referenceAssetIds,
  [compositionInputAsset.id, lastFrameInputAsset.id],
  'local shot building must retain generated composition/last-frame images while excluding audio',
));
const aiShotsWithGeneratedVisualReferences = buildShots({
  scene: aiPlanScene,
  characters: [],
  locations: [],
  props: [],
  assets: selectedVisualInputAssets,
  workflow: 'drama',
  durationSec: 10,
  shotMode: 'auto',
  shotCount: 2,
  pace: 'standard',
  camera: '不得覆盖 AI',
  lighting: '不得覆盖 AI',
  style,
  extra: '',
  aiPlan: { shots: aiPlanShots },
});
aiShotsWithGeneratedVisualReferences.forEach((shot) => assert.deepEqual(
  shot.referenceAssetIds,
  [compositionInputAsset.id, lastFrameInputAsset.id],
  'AI shot building must use the same visual-reference role policy as local shot building',
));

const render = (inputMode: Storyboard['inputMode'], assets: ReferenceAsset[], audioMode: Storyboard['audioMode'] = 'stereo') => {
  const boundShots = shots.map((shot) => ({
    ...shot,
    referenceAssetIds: inputMode === 'text' ? [] : assets.map((asset) => asset.id),
  }));
  const prompt = renderFinalPrompt({
    durationSec: 8,
    aspectRatio: '16:9',
    resolution: '2K',
    audioMode,
    workflow: 'drama',
    inputMode,
    scene,
    globalLock: '固定人物：李云外观与服装保持连续',
    shots: boundShots,
    assets,
    style,
    ruleSet: timelineRule,
    converter,
    extra: '不要字幕和水印',
    visualStyle: '电影写实',
  });
  const report = validateStoryboardPrompt({
    durationSec: 8,
    workflow: 'drama',
    inputMode,
    shots: boundShots,
    finalPrompt: prompt,
    ruleSetId: timelineRule.id,
  }, assets, timelineRule);
  return { prompt, report };
};

const textResult = render('text', []);
assert.match(textResult.prompt, /^【0s-\d+\.\d{2}s】 主体：@/u);
assert.match(textResult.prompt, /^【\d+\.\d{2}s-8\.00s】/mu);
assert.equal((textResult.prompt.match(/^【/gmu) || []).length, 3);
assert.match(textResult.prompt, /主体：@[^（；]+（[^）]+）\[朝向：[^\]]+\] 正在 \[[^→\]]+(?:→[^→\]]+){0,2}\]/u);
assert.match(textResult.prompt, /；空间：前景-[^；]+ 中景-[^；]+ 背景-[^；]+；光影：[^；]+\d{3,5}K/u);
assert.match(textResult.prompt, /；镜头：[^；]+；台词：(无|第\d+(\.\d+)?s @[^：]+："[^"]+")；音效：环境层-\[[^\]]*\] 动作层-\[[^\]]*\] 情绪层-\[[^\]]*\]/u);
assert.doesNotMatch(textResult.prompt, /生成一段|剪辑与动作：|视觉风格：|声音设计：|MiniMax|Seedance|H3|@图片|固定人物：/iu);
assert.equal(textResult.report.valid, true, textResult.report.errors.join('\n'));

const orphanDialogueShot = {
  ...shots[0],
  id: 'shot_orphan_dialogue',
  index: 1,
  startSec: 0,
  endSec: 8,
  subject: '边缘划水',
  action: '手中握着对讲机，边缘划水在通讯频道里大声吼道。 “……风暴兵团正在遭受浪潮的',
};
const orphanDialoguePrompt = renderShotPrompt(
  orphanDialogueShot,
  8,
  [],
  [orphanDialogueShot],
  'stereo',
  timelineRule,
);
assert.doesNotThrow(
  () => parseMasterTimelinePrompt(orphanDialoguePrompt, 8),
  'rendered action chains must neutralize orphan dialogue quotes before strict canonical parsing',
);
const orphanRenderedAction = orphanDialoguePrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '';
assert.doesNotMatch(
  orphanRenderedAction,
  /[“”"‘’「」『』]/u,
  'orphan dialogue punctuation must never leak into the canonical action-chain delimiters',
);

const orphanClosingDialogueShot = {
  ...orphanDialogueShot,
  id: 'shot_orphan_closing_dialogue',
  action: '攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！”随后放下对讲机',
};
const orphanClosingDialoguePrompt = renderShotPrompt(
  orphanClosingDialogueShot,
  8,
  [],
  [orphanClosingDialogueShot],
  'stereo',
  timelineRule,
);
assert.doesNotThrow(() => parseMasterTimelinePrompt(orphanClosingDialoguePrompt, 8));
assert.doesNotMatch(
  orphanClosingDialoguePrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '',
  /[“”"‘’「」『』]|泉水老兄/u,
  'an orphan closing quote must remove the dialogue tail while preserving later visible action',
);

const completeDialogueShot = {
  ...orphanDialogueShot,
  id: 'shot_complete_dialogue',
  action: '手中握着对讲机，边缘划水在通讯频道里大声吼道。\n“风暴兵团正在遭受浪潮攻击！”',
};
const completeDialogueActionBeforeRender = completeDialogueShot.action;
const completeDialoguePrompt = renderShotPrompt(
  completeDialogueShot,
  8,
  [],
  [completeDialogueShot],
  'stereo',
  timelineRule,
);
assert.match(
  completeDialoguePrompt,
  /台词：第\d+(?:\.\d+)?s @边缘划水："风暴兵团正在遭受浪潮攻击！"/u,
  'a complete dialogue after a sentence-ending speech cue must be preserved in the 台词 field',
);
assert.equal(
  completeDialogueShot.action,
  completeDialogueActionBeforeRender,
  'timeline rendering must not mutate the original action used for dialogue extraction',
);

const renderWithVisualStyle = (visualStyle: string): string => renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle,
});

const wastelandStylePrompt = renderWithVisualStyle('末日废土');
const wastelandStyleAnchor = resolveVisualStylePrompt('末日废土');
assert.ok(wastelandStyleAnchor.length > 100, 'the wasteland fixture must guard against the old 100-character truncation');
const wastelandConcepts = [
  '灰橙低饱和',
  '锈蚀金属',
  '破败混凝土',
  '硬质逆光',
  '风沙尘雾',
  '空旷压迫感',
  '粗粝颗粒',
  '热浪扭曲',
  '附着尘土的干燥表面',
] as const;
for (const anchor of wastelandConcepts) {
  assert.equal(
    wastelandStylePrompt.split(anchor).length - 1,
    1,
    `the aggregate timeline must retain the complete 末日废土 concept ${anchor} exactly once`,
  );
}
const wastelandValidation = validateStoryboardPrompt({
  durationSec: 8,
  workflow: 'drama',
  inputMode: 'text',
  shots,
  finalPrompt: wastelandStylePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(wastelandValidation.valid, true, wastelandValidation.errors.join('\n'));
assert.equal(
  needsTimelinePromptMigration(wastelandStylePrompt, timelineRule),
  false,
  'a concrete catalog anchor must not make the canonical timeline look legacy',
);
assert.doesNotThrow(
  () => parseMasterTimelinePrompt(wastelandStylePrompt, 8),
  'a complete concrete anchor must remain field-safe for strict six-field parsing',
);
for (const line of wastelandStylePrompt.split('\n')) {
  for (const primaryField of ['主体：', '空间：', '光影：', '镜头：', '台词：', '音效：']) {
    assert.equal(
      line.split(primaryField).length - 1,
      1,
      `each wasteland shot must expose exactly one primary ${primaryField} field`,
    );
  }
}
const editedWastelandPrompt = wastelandStylePrompt.replace('主体：@李云', '主体：@编辑后的李云');
const editedWastelandShots = applyMasterPromptEdit(shots, editedWastelandPrompt, 8);
assert.equal(editedWastelandShots[0]?.prompt.includes('主体：@编辑后的李云'), true);
assert.equal(editedWastelandShots.length, shots.length);

const animationStylePrompt = renderWithVisualStyle('动画电影');
for (const concept of [
  '高纯度天空蓝',
  '赛璐璐角色面',
  '手绘背景笔触',
  '动画化体积光',
  '情绪化色温转换',
  '稳定线稿',
  '分层2D景深',
  '电影级手绘细节',
]) {
  assert.equal(
    animationStylePrompt.split(concept).length - 1,
    1,
    `the aggregate animation timeline must retain ${concept} exactly once`,
  );
}
assert.doesNotThrow(() => parseMasterTimelinePrompt(animationStylePrompt, 8));
assert.doesNotMatch(
  animationStylePrompt,
  /追求极致的真实感和电影质感/u,
  'animation styles must not receive a forced realism suffix',
);

const tokusatsuStylePreset = defaultStylePresets.find(
  (candidate) => candidate.id === 'style_tokusatsu_drama',
);
assert.ok(tokusatsuStylePreset, 'the built-in 特摄剧 preset must be available to prompt rendering');
const tokusatsuStylePrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots,
  assets: [],
  style: tokusatsuStylePreset,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '特摄剧',
});
for (const concept of ['英雄识别色', '皮套', '微缩建筑', '现场爆破', '光学合成']) {
  assert.match(
    tokusatsuStylePrompt,
    new RegExp(concept, 'u'),
    `the aggregate 特摄剧 timeline must retain ${concept}`,
  );
}
assert.equal(tokusatsuStylePrompt.match(/风格预设视觉〔/gu)?.length, 1);
assert.equal(tokusatsuStylePrompt.match(/视觉风格锚点〔/gu)?.length, 1);
assert.match(
  tokusatsuStylePrompt,
  /风格预设视觉〔[^〕]*皮套[^〕]*微缩[^〕]*〕/u,
  'the editable 特摄剧 preset body must enter the final timeline',
);
assert.doesNotThrow(() => parseMasterTimelinePrompt(tokusatsuStylePrompt, 8));

const noStylePrompt = renderWithVisualStyle('no_style');
assert.doesNotMatch(
  noStylePrompt,
  /no_style|无附加风格|视觉风格锚点|追求极致的真实感和电影质感/u,
  'no_style must add no visual-style text to timeline shots',
);

const presetVisualProbe = '用户视觉探针·靛青玻璃，哑光陶瓷';
const presetVisualProbeStyle = {
  ...style,
  id: 'style_visual_probe',
  name: '视觉探针预设',
  visual: presetVisualProbe,
};
const presetVisualProbePrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots,
  assets: [],
  style: presetVisualProbeStyle,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: 'no_style',
});
assert.equal(
  presetVisualProbePrompt.match(/风格预设视觉〔用户视觉探针·靛青玻璃｜哑光陶瓷〕/gu)?.length,
  1,
  'the editable StylePreset.visual body must enter an aggregate timeline once independently of visualStyle',
);
assert.equal(
  validateStoryboardPrompt({
    durationSec: 8,
    workflow: 'drama',
    inputMode: 'text',
    shots,
    finalPrompt: presetVisualProbePrompt,
    ruleSetId: timelineRule.id,
  }, [], timelineRule).valid,
  true,
  'the protected preset visual atom must preserve the canonical six-field structure',
);
const presetVisualProbeH3 = compileTargetPrompt({
  canonicalPrompt: presetVisualProbePrompt,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
assert.match(
  presetVisualProbeH3,
  /风格预设视觉〔用户视觉探针·靛青玻璃｜哑光陶瓷〕/u,
  'MiniMax H3 adaptation must retain the editable StylePreset.visual body',
);
const presetVisualProbeSingleShot = renderShotPrompt(
  shots[0],
  8,
  [],
  shots,
  'stereo',
  timelineRule,
  { styleVisual: presetVisualProbe },
);
assert.match(
  presetVisualProbeSingleShot,
  /风格预设视觉〔用户视觉探针·靛青玻璃｜哑光陶瓷〕/u,
  'single-shot rendering must retain an explicitly supplied editable StylePreset.visual body',
);

const presetSoundProbe = '用户声音探针·铜铃[近响]，远处低频风声';
const presetSoundProbeStyle = {
  ...style,
  id: 'style_sound_probe',
  name: '声音探针预设',
  sound: presetSoundProbe,
};
const presetSoundProbeShots = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: presetSoundProbeStyle.camera,
  lighting: presetSoundProbeStyle.lighting,
  style: presetSoundProbeStyle,
  extra: '',
});
const presetSoundProbePrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots: presetSoundProbeShots,
  assets: [],
  style: presetSoundProbeStyle,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '末日废土',
});
assert.equal(
  presetSoundProbePrompt.split('\n').every((line) => (
    /音效：环境层-\[[^\]]+\] 动作层-\[[^\]]+\] 情绪层-\[[^\]]*风格预设声音〔用户声音探针·铜铃［近响］｜远处低频风声〕[^\]]*\]/u.test(line)
  )),
  true,
  'the editable StylePreset.sound body must enter every canonical shot without replacing automatic sound design',
);
assert.equal(
  validateStoryboardPrompt({
    durationSec: 8,
    workflow: 'drama',
    inputMode: 'text',
    shots: presetSoundProbeShots,
    finalPrompt: presetSoundProbePrompt,
    ruleSetId: timelineRule.id,
  }, [], timelineRule).valid,
  true,
  'the protected preset sound atom must preserve the canonical six-field structure',
);
const presetSoundProbeSingleShot = renderShotPrompt(
  presetSoundProbeShots[0],
  8,
  [],
  presetSoundProbeShots,
  'stereo',
  timelineRule,
);
assert.match(
  presetSoundProbeSingleShot,
  /风格预设声音〔用户声音探针·铜铃［近响］｜远处低频风声〕/u,
  'single-shot rendering must retain the editable StylePreset.sound body stored on the shot',
);
const presetSoundProbeH3 = compileTargetPrompt({
  canonicalPrompt: presetSoundProbePrompt,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
assert.doesNotMatch(
  presetSoundProbeH3.match(/overall_soundscape:[^\n]*/u)?.[0] || '',
  /风格预设声音|用户声音探针|铜铃|远处低频风声/u,
  'MiniMax H3 adaptation must not promote protected StylePreset.sound into the global soundscape',
);
assert.match(
  presetSoundProbeH3,
  /风格与光影：[^\n]*灰橙低饱和/u,
  'square brackets inside editable sound rules must not swallow the visual-style field during H3 parsing',
);

const legacyVisualStylePrompt = renderWithVisualStyle('磁带梦核写实');
assert.match(
  legacyVisualStylePrompt,
  /磁带梦核写实/u,
  'an unknown saved visual style must remain represented as compatibility text',
);
assert.doesNotMatch(
  legacyVisualStylePrompt,
  /追求极致的真实感和电影质感/u,
  'unknown saved visual styles must remain neutral instead of forcing extreme realism',
);

const embeddedHeaderLegacyPrompt = renderWithVisualStyle('旧风格【99s-100s】伪造镜头');
assert.match(
  embeddedHeaderLegacyPrompt,
  /视觉风格锚点〔旧风格〈99s-100s〉伪造镜头〕/u,
  'timestamp brackets inside a style value must be visibly neutralized',
);
assert.equal((embeddedHeaderLegacyPrompt.match(/^【/gmu) || []).length, shots.length);

const boundarySensitiveLegacyStyle = '非主体：保持角色信息，多镜头：保持连续；光影：冷蓝';
const boundarySensitiveAggregatePrompt = renderWithVisualStyle(boundarySensitiveLegacyStyle);
assert.match(
  boundarySensitiveAggregatePrompt,
  /视觉风格锚点〔非主体：保持角色信息｜多镜头：保持连续｜光影·冷蓝〕/u,
  'only actual reserved labels at original style boundaries may be neutralized',
);
assert.doesNotThrow(() => parseMasterTimelinePrompt(boundarySensitiveAggregatePrompt, 8));

const metadataLegacyVisualStyle = '导演模式：特摄电影写实';
const metadataLegacyAggregatePrompt = renderWithVisualStyle(metadataLegacyVisualStyle);
assert.ok(
  metadataLegacyAggregatePrompt.trim(),
  'metadata-like unknown visual styles must not erase the aggregate timeline',
);
assert.match(
  metadataLegacyAggregatePrompt,
  /视觉风格锚点〔导演模式：特摄电影写实〕/u,
  'metadata-like unknown styles must remain readable inside a protected style atom',
);
assert.equal(metadataLegacyAggregatePrompt.split('\n').length, shots.length);
const metadataLegacyValidation = validateStoryboardPrompt({
  durationSec: 8,
  workflow: 'drama',
  inputMode: 'text',
  shots,
  finalPrompt: metadataLegacyAggregatePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(metadataLegacyValidation.valid, true, metadataLegacyValidation.errors.join('\n'));

const renderSingleShotWithVisualStyle = (visualStyle: string): string =>
  renderShotPrompt(
    shots[0],
    8,
    [],
    shots,
    'stereo',
    timelineRule,
    { visualStyle },
  );
const metadataLegacySinglePrompt = renderSingleShotWithVisualStyle(metadataLegacyVisualStyle);
assert.match(
  metadataLegacySinglePrompt,
  /视觉风格锚点〔导演模式：特摄电影写实〕/u,
  'single-shot rendering must preserve metadata-like legacy text using the same protected atom',
);
assert.equal(
  metadataLegacyAggregatePrompt.split('\n').slice(0, -1).every((line) =>
    !line.includes('视觉风格锚点〔导演模式：特摄电影写实〕')),
  true,
  'earlier aggregate shots must inherit the final global style without repeating its atom',
);
assert.match(
  metadataLegacyAggregatePrompt.split('\n').at(-1) || '',
  /视觉风格锚点〔导演模式：特摄电影写实〕/u,
  'the final aggregate shot must carry the one global visual-style atom retained by downstream compression',
);
assert.equal(
  metadataLegacyAggregatePrompt.match(/视觉风格锚点〔导演模式：特摄电影写实〕/gu)?.length,
  1,
  'an aggregate timeline must emit an unchanged global visual-style atom only once instead of repeating it in every shot',
);
const singleWastelandPrompt = renderSingleShotWithVisualStyle('末日废土');
assert.equal(singleWastelandPrompt.split(/\r?\n/u).length, 1);
for (const concept of wastelandConcepts) {
  assert.match(singleWastelandPrompt, new RegExp(concept, 'u'));
}
for (const primaryField of ['主体：', '空间：', '光影：', '镜头：', '台词：', '音效：']) {
  assert.equal(singleWastelandPrompt.split(primaryField).length - 1, 1);
}
const singleAnimationPrompt = renderSingleShotWithVisualStyle('动画电影');
assert.match(singleAnimationPrompt, /赛璐璐角色面[\s\S]*电影级手绘细节/u);
assert.equal(singleAnimationPrompt.split(/\r?\n/u).length, 1);
assert.doesNotMatch(
  singleAnimationPrompt,
  /追求极致的真实感和电影质感/u,
  'individual animation shots must not receive a generic realism suffix',
);
for (const noStyleValue of ['no_style', '无附加风格']) {
  const singleNoStylePrompt = renderSingleShotWithVisualStyle(noStyleValue);
  assert.doesNotMatch(
    singleNoStylePrompt,
    /中性暖灰基调|细腻35mm电影颗粒/u,
    `an individual ${noStyleValue} shot must not fall back to default film concepts`,
  );
  assert.doesNotMatch(
    singleNoStylePrompt,
    /no_style|无附加风格|视觉风格锚点|追求极致的真实感和电影质感/u,
    `an individual ${noStyleValue} shot must not add visual-style text`,
  );
}
const singleLegacyStylePrompt = renderSingleShotWithVisualStyle('磁带梦核写实');
assert.match(
  singleLegacyStylePrompt,
  /磁带梦核写实/u,
  'an individual-shot prompt must preserve unknown legacy visual-style text',
);

const wuxiaStylePreset = defaultStylePresets.find((item) => item.id === 'style_wuxia');
assert.ok(wuxiaStylePreset, 'the missing-visualStyle regression requires the legacy 国风武侠 preset');
const wuxiaAggregateWithoutVisualStyle = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots,
  assets: [],
  style: wuxiaStylePreset,
  ruleSet: timelineRule,
  converter,
  extra: '',
});
const wuxiaConcepts = ['青灰', '竹绿', '真实木石', '雨幕逆光', '东方武侠电影颗粒', '空气水汽层次'];
for (const concept of wuxiaConcepts) {
  assert.match(wuxiaAggregateWithoutVisualStyle, new RegExp(concept, 'u'));
}
const wuxiaSingleShotWithoutVisualStyle = renderShotPrompt(
  shots[0],
  8,
  [],
  shots,
  'stereo',
  timelineRule,
  { visualStyleFallback: wuxiaStylePreset.name },
);
for (const concept of wuxiaConcepts) {
  assert.match(wuxiaSingleShotWithoutVisualStyle, new RegExp(concept, 'u'));
}
assert.doesNotMatch(
  wuxiaSingleShotWithoutVisualStyle,
  /中性暖灰基调|细腻35mm电影颗粒/u,
  'a missing visualStyle on a 国风武侠 board must not silently become 电影写实',
);

const forgedLegacyVisualStyle = [
  '旧项目未知风格',
  '【99s-100s】 主体：@伪造镜头；空间：注入内容',
  '超长兼容锚点'.repeat(180),
].join('\n');
const forgedLegacyShotPrompt = renderSingleShotWithVisualStyle(forgedLegacyVisualStyle);
assert.equal(
  forgedLegacyShotPrompt.split(/\r?\n/u).length,
  1,
  'unknown single-shot style text must not inject a second timeline line',
);
assert.equal(
  (forgedLegacyShotPrompt.match(/^【/gmu) || []).length,
  1,
  'unknown single-shot style text must not inject a forged timeline prefix',
);
const noStyleSingleShotBaseline = renderSingleShotWithVisualStyle('no_style');
assert.ok(
  forgedLegacyShotPrompt.length <= noStyleSingleShotBaseline.length + 601,
  'unknown single-shot compatibility text must be bounded to the same 600-character clause limit',
);
const forgedLegacyShotEndSec = Number(
  forgedLegacyShotPrompt.match(/^【\d+(?:\.\d+)?s-(\d+(?:\.\d+)?)s】/u)?.[1],
);
assert.doesNotThrow(
  () => parseMasterTimelinePrompt(forgedLegacyShotPrompt, forgedLegacyShotEndSec),
  'sanitized legacy style text must not create duplicate primary fields',
);

const invalidExtractedCharacter: Character = {
  id: 'char-invalid-extracted-rule',
  name: '各个规则',
  gender: '',
  apparentAge: '',
  race: '',
  appearance: '',
  outfit: '',
  signatureProps: '',
  personality: '',
  motionHabits: '',
  anchor: '',
  negativeContinuity: '',
  assetIds: [],
};
const invalidExtractedScene: Scene = {
  ...scene,
  id: 'scene-invalid-extracted-rule',
  content: '各个规则要求镜头保持连续，李云抬眼看向门外，随后推开房门。',
  summary: '李云观察门外并推开房门。',
  characterIds: [invalidExtractedCharacter.id],
};
const invalidExtractedShots = buildShots({
  scene: invalidExtractedScene,
  characters: [invalidExtractedCharacter],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 2,
  pace: 'standard',
  camera: '稳定观察',
  lighting: '自然光',
  style,
  extra: '',
});
const invalidExtractedPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: invalidExtractedScene,
  globalLock: '',
  shots: invalidExtractedShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [invalidExtractedCharacter],
  locations: [],
  props: [],
});
assert.doesNotMatch(
  invalidExtractedPrompt,
  /主体：@各个规则/u,
  'instruction-like extracted entity names must never become video subjects',
);
assert.equal(
  validateStoryboardPrompt({
    durationSec: 8,
    workflow: 'drama',
    inputMode: 'text',
    shots: invalidExtractedShots,
    finalPrompt: invalidExtractedPrompt,
    ruleSetId: timelineRule.id,
  }, [], timelineRule).valid,
  true,
  'the generated full timeline must remain valid when an instruction-like entity was extracted',
);

const plan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '9:16',
  resolution: '1080p',
  audioMode: 'none',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '固定人物：李云外观与服装保持连续',
  shots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '不要字幕和水印',
  directorStyleName: '克制悬疑',
  cameraTerms: ['缓慢推轨'],
  lightingTerms: ['冷暖对比'],
  visualStyle: '电影写实',
});
assert.match(plan.canonicalPrompt, /^【0s-/u);
assert.doesNotMatch(plan.canonicalPrompt, /固定人物：|固定场景：|智能导演 · 关系与叙事节奏/u);
assert.ok(plan.constraints.some((item) => item.includes('固定人物：李云外观与服装保持连续')));
assert.equal(plan.trace.converterId, converter.id);
assert.doesNotMatch(plan.constraints.join('\n'), /^(?:规则基础|连续性规则|输出规则|转换器输出|转换器\s+[^：]+)：/mu);
assert.ok(plan.constraints.some((item) => item.includes('画幅9:16')));

const continuityIn = '承接上一段：怪兽前爪压在裂石上，头部朝向洞口';
const continuityOut = '本段结束状态：怪兽抬起镰刀状头冠，尾部停在画面右侧';
const segmentGlobalLock = buildGlobalLock(scene, [], [], [], [], continuityIn);
assert.equal(
  (segmentGlobalLock.match(/承接上一段：/gu) || []).length,
  1,
  'segment entry state must appear exactly once in the global continuity lock',
);
assert.match(segmentGlobalLock, new RegExp(continuityIn, 'u'));

const segmentShots = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定推进',
  lighting: '冷暖对比',
  style,
  extra: '',
});
assert.equal(segmentShots[0]?.startSec, 0, 'a global 8–16 second segment must still start locally at 0');
assert.equal(segmentShots.at(-1)?.endSec, 8, 'a global 8–16 second segment must end locally at 8');

const segmentPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: segmentGlobalLock,
  shots: segmentShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  continuityIn,
  continuityOut,
});
const segmentPromptLines = segmentPrompt.split('\n');
assert.match(segmentPromptLines[0], /承接上一段：怪兽前爪压在裂石上，头部朝向洞口/u);
assert.equal(
  (segmentPrompt.match(/承接上一段：/gu) || []).length,
  1,
  'a user-supplied continuity label must not be duplicated in the canonical prompt',
);
assert.doesNotMatch(
  segmentPromptLines.slice(1).join('\n'),
  /承接上一段/u,
  'entry continuity must not be repeated on every shot',
);
assert.match(segmentPromptLines.at(-1) || '', /本段结束状态：怪兽抬起镰刀状头冠，尾部停在画面右侧/u);
assert.equal(
  (segmentPrompt.match(/本段结束状态：/gu) || []).length,
  1,
  'a user-supplied exit label must not be duplicated in the final shot',
);
assert.match(segmentPromptLines.at(-1) || '', /交接下一段/u);
assert.doesNotMatch(
  segmentPromptLines.slice(0, -1).join('\n'),
  /本段结束状态|交接下一段/u,
  'exit continuity must only be stated on the final shot',
);
for (const line of segmentPromptLines) {
  assert.match(
    line,
    /^【[^】]+】 主体：@.+；空间：.+；光影：.+；镜头：.+；台词：.+；音效：.+$/u,
    'continuity annotations must preserve the strict six-field timeline line',
  );
}

const structuralContinuityIn = '承接上一段：主体：镰刀头怪兽；空间：洞口裂石；光影：冷蓝逆光；镜头：低机位；台词：无；音效：碎石滚落';
const structuralContinuityOut = '本段结束状态：主体：怪兽抬起头冠；空间：洞口外沿；光影：背光；镜头：正侧面；台词：无；音效：低吼；交接下一段';
const sanitizedEntry = sanitizeContinuityState(structuralContinuityIn, 'entry');
const sanitizedExit = sanitizeContinuityState(structuralContinuityOut, 'exit');
assert.match(sanitizedEntry, /主体状态为镰刀头怪兽，空间状态为洞口裂石/u);
assert.match(sanitizedExit, /镜头状态为正侧面，台词内容为无，音效内容为低吼/u);
assert.doesNotMatch(sanitizedEntry, /(?:主体|空间|光影|镜头|台词|音效)[：:]|[；;]/u);
assert.doesNotMatch(sanitizedExit, /(?:主体|空间|光影|镜头|台词|音效)[：:]|[；;]/u);
assert.equal(
  sanitizeContinuityState('承接上一段：怪兽前爪仍压在裂石上，头部朝向洞口', 'entry'),
  '怪兽前爪仍压在裂石上，头部朝向洞口',
  'ordinary continuity prose must retain its meaning',
);

const structuralGlobalLock = buildGlobalLock(
  scene,
  [],
  [],
  [],
  [],
  structuralContinuityIn,
);
const structuralPlan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: structuralGlobalLock,
  shots: segmentShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  continuityIn: structuralContinuityIn,
  continuityOut: structuralContinuityOut,
});
const structuralValidation = validateStoryboardPrompt({
  durationSec: 8,
  workflow: 'drama',
  inputMode: 'text',
  shots: segmentShots,
  finalPrompt: structuralPlan.canonicalPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(structuralValidation.valid, true, structuralValidation.errors.join('\n'));
for (const line of structuralPlan.canonicalPrompt.split('\n')) {
  const primaryTimelineFields = line.match(
    /^【[^】]+】\s*(主体：[\s\S]*?；音效：环境层-\[[^\]]*\]\s+动作层-\[[^\]]*\]\s+情绪层-\[[^\]]*\])/u,
  )?.[1] || '';
  assert.ok(primaryTimelineFields, 'each line must retain one complete six-field timeline before its visual anchor');
  for (const field of ['主体：', '空间：', '光影：', '镜头：', '台词：', '音效：']) {
    assert.equal(
      primaryTimelineFields.split(field).length - 1,
      1,
      `continuity prose must not create an extra primary ${field} timeline field`,
    );
  }
}
assert.equal(
  structuralGlobalLock.split(sanitizedEntry).length - 1,
  1,
  'the board-level global lock must retain the sanitized entry state once',
);
assert.equal(
  structuralPlan.constraints.join('\n').includes(sanitizedEntry),
  false,
  'the PromptPlan constraints must remove an entry state already embedded in the canonical first shot',
);
const structuralTargetPrompt = compileTargetPrompt({
  canonicalPrompt: structuralPlan.canonicalPrompt,
  durationSec: structuralPlan.durationSec,
  aspectRatio: structuralPlan.aspectRatio,
  resolution: structuralPlan.resolution,
  audioMode: structuralPlan.audioMode,
  targetId: 'minimax-h3',
  constraints: structuralPlan.constraints,
});
assert.equal(
  structuralTargetPrompt.prompt.split('主体状态为镰刀头怪兽').length - 1,
  1,
  'target adaptation must carry the entry state exactly once',
);

const fractionalSegmentShots = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 6.5,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定推进',
  lighting: '冷暖对比',
  style,
  extra: '',
});
const fractionalPrompt = renderFinalPrompt({
  durationSec: 6.5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots: fractionalSegmentShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
});
assert.equal(fractionalSegmentShots[0]?.startSec, 0);
assert.equal(fractionalSegmentShots.at(-1)?.endSec, 6.5);
assert.match(fractionalPrompt.split('\n').at(-1) || '', /-6\.50s】/u);
assert.equal(validateStoryboardPrompt({
  durationSec: 6.5,
  workflow: 'drama',
  inputMode: 'text',
  shots: fractionalSegmentShots,
  finalPrompt: fractionalPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule).valid, true, 'fractional segment-local time must remain contiguous and valid');

const fractionalMiddleShot = fractionalSegmentShots[1]!;
const fractionalMiddleDuration = fractionalMiddleShot.endSec - fractionalMiddleShot.startSec;
const promptWithWholeFilmSoundCue = fractionalPrompt
  .split('\n')
  .map((line, index) => index === 1
    ? line.replace(/动作层-\[[^\]]*\]/u, `动作层-[第${fractionalMiddleDuration + 0.1}s脚步声]`)
    : line)
  .join('\n');
const wholeFilmSoundCueValidation = validateStoryboardPrompt({
  durationSec: 6.5,
  workflow: 'drama',
  inputMode: 'text',
  shots: fractionalSegmentShots,
  finalPrompt: promptWithWholeFilmSoundCue,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  wholeFilmSoundCueValidation.valid,
  false,
  'a sound timestamp below the global end but beyond this shot duration must not be accepted as local time',
);
assert.match(
  wholeFilmSoundCueValidation.errors.join('\n'),
  /第 2 镜.*音效.*(?:超出|超过).*本镜相对时间/u,
);

const longDialogue = '……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！';
assert.ok(estimateDialogueWindowSec(longDialogue) > 7);
assert.equal(
  estimateDialogueSpeechSec('一路，向前，不要，回头。'),
  estimateDialogueSpeechSec('一路向前不要回头'),
  'adding commas and sentence punctuation must not increase dialogue speech time',
);
const ranges = allocateTimeline(10, 3, 'drama', ['建立场景', `边缘划水喊道：“${longDialogue}”`, '情绪余波']);
assert.ok(ranges[1].endSec - ranges[1].startSec > 7);

const impossibleShots = buildShots({
  scene: { ...scene, content: `边缘划水抬头观察。边缘划水喊道：“${longDialogue}”边缘划水吹灭灯火。` },
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 3,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '近景',
  lighting: '冷白光',
  style,
  extra: '',
});
impossibleShots[1].action = `边缘划水喊道：“${longDialogue}”`;
const impossiblePrompt = renderFinalPrompt({
  durationSec: 3,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: { ...scene, content: `边缘划水抬头观察。边缘划水喊道：“${longDialogue}”边缘划水吹灭灯火。` },
  globalLock: '',
  shots: impossibleShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [],
});
assert.match(impossiblePrompt, new RegExp(longDialogue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'), 'even a short draft must preserve the entire authored line instead of silently clipping it');
assert.equal(validateStoryboardPrompt({ durationSec: 3, workflow: 'drama', inputMode: 'text', shots: impossibleShots, finalPrompt: impossiblePrompt, ruleSetId: timelineRule.id }, [], timelineRule).valid, true);

const silent = render('text', [], 'none');
assert.match(silent.prompt, /音效：环境层-\[无\] 动作层-\[无\] 情绪层-\[无\]/u);
assert.equal(silent.report.valid, true);

const characterAsset: ReferenceAsset = {
  id: 'asset_character',
  name: '李云',
  type: 'character',
  role: 'character',
  visualAnchor: '二十六岁东亚男性，湿润黑色长发，深青斗篷与旧长剑',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const sceneAsset: ReferenceAsset = {
  id: 'asset_scene',
  name: '雨夜客栈',
  type: 'location',
  role: 'scene',
  visualAnchor: '狭窄木质客栈，暖色烛光与门外冷蓝雨光',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};
const reference = render('text_reference', [characterAsset, sceneAsset]);
assert.match(reference.prompt, /主体：@李云/u);
assert.match(reference.prompt, /背景-狭窄木质客栈/u);
assert.doesNotMatch(reference.prompt, /@图片|asset_character|asset_scene/u);
assert.equal(reference.report.valid, true, reference.report.errors.join('\n'));

const multiReferenceCharacters: Character[] = [
  {
    id: 'char_multi_liyun',
    name: '李云',
    gender: '男',
    apparentAge: '青年',
    race: '人类',
    appearance: '黑发，身形高挑',
    outfit: '深青斗篷',
    signatureProps: '旧长剑',
    personality: '沉稳',
    motionHabits: '动作克制',
    anchor: '黑发与深青斗篷保持稳定',
    negativeContinuity: '',
    assetIds: ['asset_multi_liyun'],
  },
  {
    id: 'char_multi_aqing',
    name: '阿青',
    gender: '女',
    apparentAge: '青年',
    race: '人类',
    appearance: '短发，身形敏捷',
    outfit: '浅色劲装',
    signatureProps: '短刀',
    personality: '果断',
    motionHabits: '转身与起跑迅速',
    anchor: '短发与浅色劲装保持稳定',
    negativeContinuity: '',
    assetIds: ['asset_multi_aqing'],
  },
];
const multiCharacterAssets: ReferenceAsset[] = [
  {
    ...characterAsset,
    id: 'asset_multi_liyun',
    name: '李云',
    sourceEntityId: 'char_multi_liyun',
    sourceEntityKind: 'character',
  },
  {
    ...characterAsset,
    id: 'asset_multi_aqing',
    name: '阿青',
    sourceEntityId: 'char_multi_aqing',
    sourceEntityKind: 'character',
  },
];
const sharedMultiCharacterAssetIds = multiCharacterAssets.map((asset) => asset.id);
const multiReferenceSubjectCases = [
  { id: 'relation', subject: '剧情主体', action: '阿青推开李云，转身冲出客栈。' },
  { id: 'declared', subject: '阿青', action: '她转身冲出客栈。' },
  { id: 'dialogue', subject: '剧情主体', action: '阿青对李云说道：“快走。”随后拔出短刀。' },
  { id: 'mention', subject: '剧情主体', action: '阿青抬头望向窗外。' },
] as const;
for (const subjectCase of multiReferenceSubjectCases) {
  const localActorShot = {
    ...shots[0],
    id: `shot_multi_reference_${subjectCase.id}`,
    index: 1,
    startSec: 0,
    endSec: 8,
    subject: subjectCase.subject,
    action: subjectCase.action,
    referenceAssetIds: sharedMultiCharacterAssetIds,
  };
  const localActorPrompt = renderShotPrompt(
    localActorShot,
    8,
    multiCharacterAssets,
    [localActorShot],
    'stereo',
    timelineRule,
    { characters: multiReferenceCharacters },
  );
  assert.match(
    localActorPrompt,
    /主体：@阿青/u,
    `${subjectCase.id} evidence must beat the shared multi-character reference order`,
  );
}

const contextualActorWithBodyAnchors: Character = {
  ...multiReferenceCharacters[0],
  nsfwBodyAnchors: {
    stableTraits: ['左肩月牙形旧疤'],
    sourceEvidence: '人物资料',
  },
};
const contextualActorAsset: ReferenceAsset = {
  ...multiCharacterAssets[0],
  visualAnchor: '六足甲壳外骨骼身份锚点',
};
for (const focus of ['人物画像', '清泉市夜晚', '李云与阿青']) {
  const focusShot = {
    ...shots[0],
    id: `shot_noncharacter_focus_${focus}`,
    index: 1,
    startSec: 0,
    endSec: 5,
    subject: focus,
    action: '李云脱下上衣站在原地，暖光照亮画面中的主体。',
    referenceAssetIds: [contextualActorAsset.id],
    nsfwContinuity: { nudity: '上身裸露' },
  };
  const focusedPrompt = renderShotPrompt(
    focusShot,
    5,
    [contextualActorAsset],
    [focusShot],
    'stereo',
    timelineRule,
    { characters: [contextualActorWithBodyAnchors, multiReferenceCharacters[1]] },
  );
  const focusedSubjectClause = focusedPrompt.split('；空间：')[0];
  assert.ok(focusedSubjectClause.includes(`主体：@${focus}（`), `${focus}: the declared focus must remain selected when a known actor is present`);
  assert.doesNotMatch(
    focusedSubjectClause,
    /性别设定〔男〕|稳定身体锚点〔|左肩月牙形旧疤|六足甲壳外骨骼身份锚点|节肢交替支撑/u,
    `${focus}: a contextual actor/reference cannot donate identity, gender or body facts to another subject`,
  );
  const characterFocusShot = { ...focusShot, subject: contextualActorWithBodyAnchors.name };
  const characterFocusPrompt = renderShotPrompt(
    characterFocusShot,
    5,
    [contextualActorAsset],
    [characterFocusShot],
    'stereo',
    timelineRule,
    { characters: [contextualActorWithBodyAnchors] },
  );
  assert.match(characterFocusPrompt, /性别设定〔男〕/u, 'the actual character focus must retain its authoritative gender');
  assert.doesNotMatch(characterFocusPrompt, /稳定身体锚点〔左肩月牙形旧疤〕/u, 'private dossier details require authored current-shot use, not automatic character focus');
}

const oldPrompt = '生成一段8秒短片。\n0—8秒：剧情。\n剪辑与动作：连续。';
assert.equal(needsTimelinePromptMigration(oldPrompt, timelineRule), true);
assert.equal(validateStoryboardPrompt({ durationSec: 8, workflow: 'drama', inputMode: 'text', shots, finalPrompt: oldPrompt, ruleSetId: timelineRule.id }, [], timelineRule).valid, false);

const invalidGenericSubjectPrompt = textResult.prompt.replace(/主体：@[^（；\s]+/u, '主体：@当前场景');
assert.equal(needsTimelinePromptMigration(invalidGenericSubjectPrompt, timelineRule), false, 'subject wording must not lock copying behind a local migration gate');
assert.equal(
  validateStoryboardPrompt({ durationSec: 8, workflow: 'drama', inputMode: 'text', shots, finalPrompt: invalidGenericSubjectPrompt, ruleSetId: timelineRule.id }, [], timelineRule).valid,
  true,
);

const invalidSubjectCharacters: Character[] = [{
  id: 'char_xia',
  name: '西娅',
  gender: '',
  apparentAge: '',
  race: '',
  appearance: '',
  outfit: '',
  signatureProps: '',
  personality: '',
  motionHabits: '',
  anchor: '',
  negativeContinuity: '',
  assetIds: [],
}];
const subjectShots = shots.map((shot, index) => ({
  ...shot,
  subject: index === 0 ? '人物缩短或拉开距离' : shot.subject,
  action: index === 0 ? '西娅抬眼看向门外' : shot.action,
}));
const subjectPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: { ...scene, content: `${scene.content}西娅抬眼看向门外。`, characterIds: ['char_xia'] },
  globalLock: '',
  shots: subjectShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: invalidSubjectCharacters,
});
assert.match(subjectPrompt, /主体：@西娅/u);
assert.doesNotMatch(subjectPrompt, /主体：@人物缩短/u);

const customGenderCharacter: Character = {
  ...invalidSubjectCharacters[0],
  id: 'char_custom_gender',
  name: '澄星',
  gender: '星灵双相',
  appearance: '银白长发，额心有新月形光纹',
};
const customGenderScene: Scene = {
  ...scene,
  id: 'scene_custom_gender',
  title: '星灵苏醒',
  content: '澄星睁开双眼，额心的新月形光纹随呼吸明灭。',
  summary: '澄星苏醒并显露额心光纹。',
  characterIds: [customGenderCharacter.id],
};
const customGenderShot = {
  ...shots[0],
  id: 'shot_custom_gender',
  index: 1,
  startSec: 0,
  endSec: 5,
  subject: customGenderCharacter.name,
  action: customGenderScene.content,
  referenceAssetIds: [],
};
const customGenderPrompt = renderFinalPrompt({
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: customGenderScene,
  globalLock: buildGlobalLock(customGenderScene, [customGenderCharacter], [], [], []),
  shots: [customGenderShot],
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [customGenderCharacter],
  locations: [],
  props: [],
});
const customGenderSubjectClause = customGenderPrompt.match(/主体：([^；]+)；空间：/u)?.[1] || '';
assert.match(customGenderSubjectClause, /星灵双相/u,
  'a custom character gender must be visible inside the final per-shot subject clause instead of being lost before image/video generation');

const firstPersonCharacter: Character = {
  ...invalidSubjectCharacters[0],
  id: 'char_first_person_counterpart',
  name: '翠衣女子',
};
assert.equal(
  hasNarrativeFirstPersonReference('翠衣女子低声说：“我不会退。”'),
  false,
  'first-person wording inside quoted dialogue must not create a first-person narrator',
);
assert.equal(
  resolveFirstPersonSubject('翠衣女子低声说：“我不会退。”', [firstPersonCharacter.name]),
  '',
  'quoted dialogue alone must not invent an unnamed protagonist',
);
assert.equal(
  rewriteNarrativeFirstPersonReferences(
    '我侧身避开，低声说：“我不会退。”',
    '无名主角',
  ),
  '无名主角侧身避开，低声说：“我不会退。”',
  'narrative first person must be replaced without changing quoted dialogue',
);
const firstPersonScene: Scene = {
  ...scene,
  id: 'scene_first_person_narration',
  title: '山坳斗法',
  content: '翠衣女子吐出蛇信，朝我面门刺来。我侧身避开。趁她分神，我翻掌按诀。我这才从树后走出。我低声说：“我不会放开捆仙绳。”',
  summary: '翠衣女子袭击第一人称人物，后者避开并继续控制捆仙绳。',
  characterIds: [firstPersonCharacter.id],
};
const firstPersonShots = buildShots({
  scene: firstPersonScene,
  characters: [firstPersonCharacter],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 15,
  shotMode: 'exact',
  shotCount: 4,
  pace: 'standard',
  camera: '稳定跟随人物动作',
  lighting: '林间侧光',
  style,
  extra: '',
});
const firstPersonPrompt = renderFinalPrompt({
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: firstPersonScene,
  globalLock: '',
  shots: firstPersonShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [firstPersonCharacter],
});
assert.ok(
  firstPersonShots.some((shot) => shot.subject === '无名主角'),
  'an unnamed first-person performer must receive one stable visible subject name',
);
assert.ok(
  firstPersonShots.every((shot) => !/^(?:我|我们|咱们)/u.test(shot.subject)),
  'first-person prose must never be stored as a shot subject',
);
assert.match(firstPersonPrompt, /主体：@无名主角/u);
assert.doesNotMatch(firstPersonPrompt, /主体：@(?:我|我们|咱们)/u);
const firstPersonPromptWithoutDialogue = firstPersonPrompt.replace(
  /；台词：[\s\S]*?；音效：/gu,
  '；台词：[保留原对白]；音效：',
);
assert.doesNotMatch(
  firstPersonPromptWithoutDialogue,
  /(?:朝我|我侧身|我翻掌|我这才|我低声)/u,
  'non-dialogue video instructions must replace first-person prose with the stable visible subject',
);
assert.match(
  firstPersonPrompt,
  /台词：[^；]*[“"]我不会放开捆仙绳。[”"]/u,
  'spoken first-person wording must remain unchanged inside the original dialogue',
);

const firstPersonEnvironmentScene: Scene = {
  ...firstPersonScene,
  id: 'scene_first_person_environment_cutaway',
  content: '我推开木门，走进院中。木门在风里自动合拢，院中落叶翻卷。',
  summary: '主角走入院中，随后只剩木门和落叶的环境镜头。',
  characterIds: [],
};
const firstPersonEnvironmentShots = buildShots({
  scene: firstPersonEnvironmentScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 9,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定镜头',
  lighting: '自然天光',
  style,
  extra: '',
});
assert.equal(firstPersonEnvironmentShots[0]?.subject, '无名主角');
assert.equal(
  firstPersonEnvironmentShots[2]?.subject,
  '环境主体',
  'a pure environment beat must not inherit the unnamed first-person protagonist',
);

const buildFirstPersonEdgeShots = (
  content: string,
  shotCount: number,
  characters: Character[] = [],
) => buildShots({
  scene: {
    ...scene,
    id: `scene_first_person_edge_${shotCount}`,
    content,
    summary: content,
    characterIds: characters.map((character) => character.id),
  },
  characters,
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: Math.max(6, shotCount * 3),
  shotMode: 'exact',
  shotCount,
  pace: 'standard',
  camera: '稳定观察',
  lighting: '自然光',
  style,
  extra: '',
});

for (const firstPersonTurn of ['忽然我拔剑格挡', '不料我拔剑格挡', '下一刻我拔剑格挡']) {
  const edgeShots = buildFirstPersonEdgeShots(
    `翠衣女子逼近。${firstPersonTurn}。`,
    2,
    [firstPersonCharacter],
  );
  assert.equal(
    edgeShots[1]?.subject,
    '无名主角',
    `${firstPersonTurn} must switch the second shot to the visible first-person performer`,
  );
}

for (const orphanDialogue of [
  '翠衣女子低声说：“我不会退。',
  '翠衣女子低声说：" 我不会退。',
]) {
  assert.equal(
    hasNarrativeFirstPersonReference(orphanDialogue),
    false,
    'first-person wording inside an unclosed Chinese or ASCII dialogue quote must not invent a narrator',
  );
  assert.equal(
    resolveFirstPersonSubject(orphanDialogue, [firstPersonCharacter.name]),
    '',
    'an unclosed quoted line alone must not create a first-person performer',
  );
  assert.equal(
    rewriteNarrativeFirstPersonReferences(orphanDialogue, '无名主角'),
    orphanDialogue,
    'an unclosed quoted line must remain byte-for-byte unchanged by narrative pronoun rewriting',
  );
}
assert.equal(
  rewriteNarrativeFirstPersonReferences('我低声说：“我不会退。', '无名主角'),
  '无名主角低声说：“我不会退。',
  'the narrator outside an unclosed quote must be renamed while the spoken wording stays original',
);

const namedFirstPersonDialogue = '我说道：“我叫林遥。”随后我推门。';
assert.equal(
  resolveFirstPersonSubject(namedFirstPersonDialogue),
  '林遥',
  'a first-person speaker may establish their stable visible name inside their own dialogue',
);
const namedFirstPersonShots = buildFirstPersonEdgeShots(namedFirstPersonDialogue, 2);
assert.deepEqual(
  namedFirstPersonShots.map((shot) => shot.subject),
  ['林遥', '林遥'],
  'the self-declared name must remain the stable subject across later first-person actions',
);
assert.match(namedFirstPersonShots[0]?.action || '', /林遥说道：“我叫林遥。”/u);
assert.match(namedFirstPersonShots[1]?.action || '', /林遥推门/u);
assert.equal(
  rewriteNarrativeFirstPersonReferences('我叫林遥。随后我推门。', '林遥'),
  '林遥自报姓名。随后林遥推门。',
  'an unquoted name declaration must not become the nonsensical phrase “林遥叫林遥”',
);

const unnamedDialogueShots = buildFirstPersonEdgeShots('“我不会退。”', 1);
assert.equal(
  unnamedDialogueShots[0]?.subject,
  '无名说话者',
  'dialogue without a stated speaker must use a stable unnamed speaker instead of the environment',
);
const unnamedDialoguePrompt = renderFinalPrompt({
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: { ...scene, content: '“我不会退。”', summary: '一句未署名对白。', characterIds: [] },
  globalLock: '',
  shots: unnamedDialogueShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [],
});
assert.match(unnamedDialoguePrompt, /主体：@无名说话者/u);
assert.match(unnamedDialoguePrompt, /台词：[^\n]*@无名说话者："我不会退。"/u);
assert.doesNotMatch(unnamedDialoguePrompt, /@环境主体："我不会退/u);

for (const environmentBeat of [
  '远处传来钟声',
  '院中落叶翻卷',
  '镜头扫过空庭',
]) {
  const environmentShots = buildFirstPersonEdgeShots(
    `${environmentBeat}。`,
    1,
    [firstPersonCharacter],
  );
  assert.equal(
    environmentShots[0]?.subject,
    '环境主体',
    `${environmentBeat} must remain an environment cutaway instead of inheriting a linked protagonist`,
  );
}

for (const lexicalNonPronoun of ['我国', '我市', '我校', '忘我', '自我', '超我', '本我']) {
  const lexicalSentence = `${lexicalNonPronoun}文化源远流长。`;
  assert.equal(
    hasNarrativeFirstPersonReference(lexicalSentence),
    false,
    `${lexicalNonPronoun} is a lexical word, not a first-person video performer`,
  );
  assert.equal(
    rewriteNarrativeFirstPersonReferences(lexicalSentence, '无名主角'),
    lexicalSentence,
    `${lexicalNonPronoun} must not be rewritten as a visible subject`,
  );
}

for (const narrativeFirstPersonSentence of [
  '我校准长剑后抬头。',
  '这本我已经看过。',
  '副本我已经通关。',
]) {
  assert.equal(
    hasNarrativeFirstPersonReference(narrativeFirstPersonSentence),
    true,
    `${narrativeFirstPersonSentence} contains a real first-person performer, not a protected lexical term`,
  );
  assert.doesNotMatch(
    rewriteNarrativeFirstPersonReferences(narrativeFirstPersonSentence, '无名主角'),
    /我/u,
    `${narrativeFirstPersonSentence} must replace the real narrative pronoun`,
  );
}
for (const firstPersonObjectSentence of [
  '翠衣女子朝我看过来。',
  '翠衣女子向我走来。',
  '翠衣女子对我说。',
  '翠衣女子给我看了一眼。',
  '翠衣女子发现我已经离开。',
  '翠衣女子看见我正在离开。',
  '翠衣女子盯着我问。',
  '翠衣女子扑向我抓来。',
  '翠衣女子告诉我已经安全。',
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(firstPersonObjectSentence),
    false,
    `${firstPersonObjectSentence} uses first person as the other actor's object, not as this beat's performer`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(firstPersonObjectSentence, 1, [firstPersonCharacter])[0]?.subject,
    '翠衣女子',
    `${firstPersonObjectSentence} must keep the explicitly named actor as the shot subject`,
  );
}
for (const firstPersonActorSentence of [
  '我已经离开。',
  '我正在离开。',
  '我说。',
  '随后我拔剑。',
  '翠衣女子朝我看过来。随后我拔剑。',
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(firstPersonActorSentence),
    true,
    `${firstPersonActorSentence} contains a first-person performer and must not be blocked as object wording`,
  );
}
for (const causalFirstPersonSentence of [
  '因为我已经离开。',
  '正因为我正在离开。',
  '只因为我已经拔剑。',
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(causalFirstPersonSentence),
    true,
    `${causalFirstPersonSentence} starts a causal first-person action rather than a “为我” object phrase`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(causalFirstPersonSentence, 1)[0]?.subject,
    '无名主角',
    `${causalFirstPersonSentence} must keep the first-person performer as the shot subject`,
  );
}
for (const topicalFirstPersonSentence of [
  '今朝我拔剑迎敌。',
  '东南方向我已经确认。',
  '这次校对我已经完成。',
  '重大科学发现我已经证实。',
  '车辆转让我已经办妥。',
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(topicalFirstPersonSentence),
    true,
    `${topicalFirstPersonSentence} uses the preceding phrase as a topic rather than an object-actor cue`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(topicalFirstPersonSentence, 1)[0]?.subject,
    '无名主角',
    `${topicalFirstPersonSentence} must not promote a topic fragment to the shot subject`,
  );
}
const properNameObjectCharacter: Character = {
  ...firstPersonCharacter,
  id: 'char_first_person_object_actor',
  name: '李云',
};
assert.equal(
  hasNarrativeFirstPersonActor('李云向我走来。', [properNameObjectCharacter.name]),
  false,
  'a known proper-name actor before “向我” must keep first person in object position',
);
assert.equal(
  buildFirstPersonEdgeShots('李云向我走来。', 1, [properNameObjectCharacter])[0]?.subject,
  '李云',
  'a known proper-name actor must remain the shot subject instead of first person',
);
for (const compoundTopicCase of [
  {
    sentence: '李云去向我已经确认。',
    characters: [properNameObjectCharacter],
  },
  {
    sentence: '李云行为我已经记录。',
    characters: [properNameObjectCharacter],
  },
  {
    sentence: '敌人动向我已经掌握。',
    characters: [] as Character[],
  },
  {
    sentence: '剑客行为我已经看清。',
    characters: [] as Character[],
  },
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(
      compoundTopicCase.sentence,
      compoundTopicCase.characters.map((character) => character.name),
    ),
    true,
    `${compoundTopicCase.sentence} contains a compound topic noun rather than an object preposition`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(compoundTopicCase.sentence, 1, compoundTopicCase.characters)[0]?.subject,
    '无名主角',
    `${compoundTopicCase.sentence} must not promote the topic character or role over the first-person performer`,
  );
}
for (const groundedObjectCase of [
  {
    sentence: '翠衣女子抬头朝我看过来。',
    character: firstPersonCharacter,
  },
  {
    sentence: '翠衣女子抬眼朝我看过来。',
    character: firstPersonCharacter,
  },
  {
    sentence: '李云快步向我走来。',
    character: properNameObjectCharacter,
  },
  {
    sentence: '翠衣女子把我推开。',
    character: firstPersonCharacter,
  },
  {
    sentence: '翠衣女子将我推开。',
    character: firstPersonCharacter,
  },
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(groundedObjectCase.sentence, [groundedObjectCase.character.name]),
    false,
    `${groundedObjectCase.sentence} keeps first person as the grounded actor's object despite natural modifiers`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(groundedObjectCase.sentence, 1, [groundedObjectCase.character])[0]?.subject,
    groundedObjectCase.character.name,
    `${groundedObjectCase.sentence} must keep the grounded actor as the shot subject`,
  );
}
for (const directionalObjectCase of [
  {
    sentence: '剑客走向我拔剑。',
    actor: '剑客',
    characters: [] as Character[],
  },
  {
    sentence: '翠衣女子转向我抬手。',
    actor: '翠衣女子',
    characters: [firstPersonCharacter],
  },
  {
    sentence: '李云走向我拔剑。',
    actor: '李云',
    characters: [properNameObjectCharacter],
  },
  {
    sentence: '翠衣女子挥剑向我冲来。',
    actor: '翠衣女子',
    characters: [firstPersonCharacter],
  },
  {
    sentence: '剑客持剑向我走来。',
    actor: '剑客',
    characters: [] as Character[],
  },
  {
    sentence: '对手挥拳向我冲来。',
    actor: '对手',
    characters: [] as Character[],
  },
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(
      directionalObjectCase.sentence,
      directionalObjectCase.characters.map((character) => character.name),
    ),
    false,
    `${directionalObjectCase.sentence} uses a complete directional verb before the first-person object`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(directionalObjectCase.sentence, 1, directionalObjectCase.characters)[0]?.subject,
    directionalObjectCase.actor,
    `${directionalObjectCase.sentence} must retain the actor that performs the directional motion`,
  );
}
for (const genericRoleObjectCase of [
  { sentence: '翠衣女子向我走来。', actor: '翠衣女子' },
  { sentence: '陌生男子对我说。', actor: '陌生男子' },
  { sentence: '剑客朝我拔剑。', actor: '剑客' },
]) {
  assert.equal(
    hasNarrativeFirstPersonActor(genericRoleObjectCase.sentence),
    false,
    `${genericRoleObjectCase.sentence} has an explicit role actor before the first-person object`,
  );
  assert.equal(
    buildFirstPersonEdgeShots(genericRoleObjectCase.sentence, 1)[0]?.subject,
    genericRoleObjectCase.actor,
    `${genericRoleObjectCase.sentence} must not grow the role actor into a subject containing “我”`,
  );
}
const unlinkedProperNameObjectShots = buildShots({
  scene: {
    ...scene,
    id: 'scene_unlinked_first_person_object_actor',
    content: '李云向我走来。',
    summary: '李云走向第一人称人物。',
    characterIds: [],
  },
  characters: [properNameObjectCharacter],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 6,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '稳定观察',
  lighting: '自然光',
  style,
  extra: '',
});
assert.equal(
  unlinkedProperNameObjectShots[0]?.subject,
  '李云',
  'a character card explicitly named in the beat must ground the object actor even when its scene link is missing',
);
for (const institutionalPhrase of [
  '我司今日发布公告。',
  '我院师生参加活动。',
  '我省降雨持续。',
]) {
  assert.equal(
    hasNarrativeFirstPersonReference(institutionalPhrase),
    false,
    `${institutionalPhrase} is an institutional phrase rather than a visible first-person performer`,
  );
  assert.equal(
    rewriteNarrativeFirstPersonReferences(institutionalPhrase, '无名主角'),
    institutionalPhrase,
    `${institutionalPhrase} must remain unchanged`,
  );
}

const localEvidenceCharacters: Character[] = [
  {
    ...invalidSubjectCharacters[0],
    id: 'char_false_global',
    name: '生物研究所通过分散',
  },
  {
    ...invalidSubjectCharacters[0],
    id: 'char_death_corps',
    name: '死亡兵团',
  },
];
const locallyGroundedScene: Scene = {
  ...scene,
  id: 'scene_local_evidence',
  title: '北侧防线',
  content: '死亡兵团调转车队，冲向北侧防线。',
  summary: '此前联盟的生物研究所通过分散在其他战区的观测站发现孢子。',
  characterIds: localEvidenceCharacters.map((character) => character.id),
};
const locallyGroundedShot = {
  ...shots[0],
  startSec: 0,
  endSec: 4,
  subject: '环境主体',
  action: '死亡兵团调转车队，冲向北侧防线',
};
const locallyGroundedPrompt = renderFinalPrompt({
  durationSec: 4,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: locallyGroundedScene,
  globalLock: '',
  shots: [locallyGroundedShot],
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: localEvidenceCharacters,
});
assert.match(
  locallyGroundedPrompt,
  /主体：@死亡兵团/u,
  'a shot subject must follow the actor named in its local action instead of a longer unrelated character mentioned only in the global summary',
);
assert.doesNotMatch(locallyGroundedPrompt, /主体：@生物研究所通过分散/u);
const oneStageCanonicalPrompt = locallyGroundedPrompt.replace(
  /正在 \[[^\]]+\]/u,
  '正在 [调转车队]',
);
const oneStageValidation = validateStoryboardPrompt({
  durationSec: 4,
  workflow: 'drama',
  inputMode: 'text',
  shots: [locallyGroundedShot],
  finalPrompt: oneStageCanonicalPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  oneStageValidation.valid,
  true,
  `a non-empty one-stage source action is canonical: ${oneStageValidation.errors.join('\n')}`,
);
const locallyGroundedActionChain = locallyGroundedPrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '';
assert.equal(
  locallyGroundedActionChain,
  '调转车队→冲向北侧防线',
  'a two-clause source action must remain two clauses without a fabricated hold stage',
);
assert.doesNotMatch(
  locallyGroundedPrompt,
  /完整保持|镜头结束仍保持|保持[^→\]]*后的可见状态/u,
  'a source action must not be stretched into repeated hold instructions',
);

const noLocalSubjectShot = {
  ...locallyGroundedShot,
  id: 'shot_no_local_subject',
  subject: '',
  action: '画面只保留空房间的雨声',
};
const noLocalSubjectPrompt = renderFinalPrompt({
  durationSec: 4,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: {
    ...locallyGroundedScene,
    content: '西娅转身离开。画面只保留空房间的雨声。',
    summary: '西娅已经离开空房间。',
    characterIds: [invalidSubjectCharacters[0].id],
  },
  globalLock: '',
  shots: [noLocalSubjectShot],
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: invalidSubjectCharacters,
});
assert.match(
  noLocalSubjectPrompt,
  /主体：@环境主体/u,
  'a shot with no local actor evidence must use 环境主体 instead of guessing the first global character',
);
assert.doesNotMatch(noLocalSubjectPrompt, /主体：@西娅/u);

const sourceBeatMappedScene: Scene = {
  ...scene,
  id: 'scene_source_beat_mapping',
  content: '林遥脱下雨衣分开窗帘露出窗外灯塔',
  summary: '林遥依次脱下雨衣、分开窗帘并露出灯塔。',
};
const sourceBeatMappedShots = buildShots({
  scene: sourceBeatMappedScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 2,
  pace: 'standard',
  camera: '稳定观察',
  lighting: '自然光',
  style,
  extra: '',
});
assert.deepEqual(
  sourceBeatMappedShots.map((shot) => (
    shot as typeof shot & { sourceBeatIds?: string[] }
  ).sourceBeatIds),
  [['beat_1'], ['beat_2', 'beat_3']],
  'each generated shot must reference only the semantic source beats actually allocated to its action',
);
assert.deepEqual(
  sourceBeatMappedShots.map((shot) => [shot.sourceStart, shot.sourceEnd]),
  [[0, 6], [6, 16]],
  'each generated shot must persist the complete UTF-16 source range covered by its assigned beats',
);

const sharedSingleBeatScene: Scene = {
  ...scene,
  id: 'scene_shared_single_beat_range',
  content: '林遥冲向铁门',
  summary: '林遥冲向铁门。',
};
const sharedSingleBeatShots = buildShots({
  scene: sharedSingleBeatScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 6,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'fast',
  camera: '稳定观察',
  lighting: '自然光',
  style,
  extra: '',
});
assert.deepEqual(
  sharedSingleBeatShots.map((shot) => ({
    sourceBeatIds: shot.sourceBeatIds,
    sourceStart: shot.sourceStart,
    sourceEnd: shot.sourceEnd,
  })),
  [
    { sourceBeatIds: ['beat_1'], sourceStart: 0, sourceEnd: 6 },
    { sourceBeatIds: ['beat_1'], sourceStart: 0, sourceEnd: 6 },
    { sourceBeatIds: ['beat_1'], sourceStart: 0, sourceEnd: 6 },
  ],
  'kinetic multi-shot planning may share one semantic beat, but must never invent character-level subranges',
);

const stagedPoseStory = '艾米莉亚在床上，脱下外套，屈膝分开双腿，露出膝间的急救包。';
const stagedPoseAnalysis = analyzeTextLocally(stagedPoseStory);
assert.equal(
  stagedPoseAnalysis.characterNames.includes('艾米莉亚'),
  true,
  'a named character followed by 在+地点 must still be recognized as the character',
);
const compactStagedPoseAnalysis = analyzeTextLocally(
  '艾米莉亚在床上脱下外套屈膝分开双腿露出膝间的急救包',
);
assert.deepEqual(
  compactStagedPoseAnalysis.characterNames,
  ['艾米莉亚'],
  'a punctuation-free action chain must not misclassify the location or an action phrase as a second character',
);
assert.equal(compactStagedPoseAnalysis.locationName, '床上');
for (const [source, expectedNames] of [
  ['她在床上脱下外套', []],
  ['艾米莉亚正在床上脱下外套', ['艾米莉亚']],
  ['艾米莉亚缓缓脱下外套', ['艾米莉亚']],
  ['艾米莉亚缓慢脱下外套', ['艾米莉亚']],
  ['清晨艾米莉亚在床上脱下外套', ['艾米莉亚']],
  ['艾米莉亚与蕾姆在窗边站立', ['艾米莉亚', '蕾姆']],
  ['艾米莉亚、蕾姆在窗边站立', ['艾米莉亚', '蕾姆']],
] as const) {
  assert.deepEqual(
    analyzeTextLocally(source).characterNames,
    expectedNames,
    `local character extraction must respect subject grammar: ${source}`,
  );
}
assert.equal(
  analyzeTextLocally('艾米莉亚在浴室里全裸站立').locationName,
  '浴室里',
  'a visible body state after a location must not become part of the location name',
);
const noisyLongStoryAnalysis = analyzeTextLocally([
  '不过就在刚才，联盟的生物研究所通过分散在战区的各个观测站发现了孢子。',
  '边缘划水在通讯频道里大声吼道。',
  '西娅转身望向市中心。',
  '她的情绪陡然流露出一丝惊慌。',
  '他们将继续执行原定计划。',
].join(''));
assert.deepEqual(
  noisyLongStoryAnalysis.characterNames,
  ['边缘划水', '西娅'],
  'local analysis must reject clause fragments before 在/将/流露 as people while retaining explicit named actors',
);

const cultivationMarketParagraphs = [
  '我带着两位道侣穿过坊市外的青石长街，进了修仙界集市。长街两侧悬着鲛油灯，摊位上浮着避风符，符纸在珠光下轻轻发亮。雪衣道侣走在内侧，面容冷白，目光只落在符纸、朱砂一类货品上；玄衣道侣落后半步，细剑抱在怀里，手指搭着剑鞘，眼神始终在往来人群中扫动。',
  '雪衣道侣停在一处符材摊前。她俯身从镇灵石压住的黄符纸下抽出三张，指尖沿着纸纹慢慢滑过，又迎着珠光翻转两次，留下最居中那一张，其余放回原处。接着她指向一罐封灵砂。我伸手去拿，玄衣道侣先一步用剑鞘挑开罐口残存的禁制，侧头轻闻，眉头微动。雪衣道侣取出一枚银针刺入砂中，再拔出时针身没有黑气，才将罐子放回我手里。我数出灵石，摊主清点后把符纸与灵砂包好推过来。我接过后掌心轻轻一沉。',
  '身后有几名修士牵着灵鹤经过，街面登时扬起薄尘。玄衣道侣横跨半步，用半边身子将我和雪衣道侣挡在尘外，手按剑柄，直到灵鹤走远才松开。雪衣道侣已经折身往西，凉袖擦过我的小臂，朝窄巷方向走去。我带着玄衣道侣跟上，身后的珠灯被转角遮断，袖中符纸带着一点余温，灵砂瓶在衣袋里轻轻碰响。东西已经买全，没有再多停留。',
] as const;
const cultivationMarketAnalysis = analyzeTextLocally(cultivationMarketParagraphs.join('\n\n'));
assert.deepEqual(
  cultivationMarketAnalysis.characterNames,
  ['无名主角', '雪衣道侣', '玄衣道侣', '摊主'],
  'local story-bible seeding must keep stable actors while rejecting props, body parts, predicates, and actor-action fragments',
);
assert.deepEqual(
  cultivationMarketParagraphs.map((paragraph) => analyzeTextLocally(paragraph).locationName),
  ['修仙界集市', '符材摊', '西侧窄巷口'],
  'local scene locations must prefer concrete place nouns over lighting predicates and relative action fragments',
);

const explicitLocationCases = [
  ['枪声与火炮的喧嚣揉碎了清泉市的夜晚，对抗浪潮的战役正式打响了。', '清泉市'],
  ['奔赴巨石城支援的死亡兵团接到了掉头的命令。', '巨石城'],
  ['就在06号防区的10个阵地彻底化作绞肉机。', '06号防区'],
  ['死亡兵团立刻调转方向朝着北二环线杀了过去。', '北二环线'],
] as const;
for (const [source, expectedLocation] of explicitLocationCases) {
  assert.equal(
    analyzeTextLocally(source).locationName,
    expectedLocation,
    `local analysis must retain an explicit named location: ${expectedLocation}`,
  );
}
assert.equal(
  analyzeTextLocally(explicitLocationCases.map(([source]) => source).join('')).locationName,
  '清泉市',
  'the first explicit location in the real story excerpt must become the scene location',
);
assert.equal(
  analyzeTextLocally('不过就在刚才，他们接到了掉头的命令。').locationName,
  '',
  'a time expression such as 刚才 must never be persisted as a location',
);
assert.equal(
  analyzeTextLocally('枪声与火炮的喧嚣揉碎了夜晚，对抗浪潮的战役正式打响。').locationName,
  '',
  'missing location evidence must stay empty instead of persisting the placeholder 当前剧情场景 as project data',
);

const stagedPoseCharacter: Character = {
  id: 'char_emilia',
  name: '艾米莉亚',
  gender: '女',
  apparentAge: '成年女性',
  race: '人类',
  appearance: '',
  outfit: '',
  signatureProps: '',
  personality: '',
  motionHabits: '',
  anchor: '',
  negativeContinuity: '',
  assetIds: [],
};
const stagedPoseLocation: Location = {
  id: 'location_bed',
  name: '床上',
  description: '室内床铺区域',
  timeWeather: '室内',
  lighting: '柔和侧光',
  palette: '中性暖色',
  fixedProps: '床铺',
  anchor: '床铺位置保持固定',
  assetIds: [],
};
const stagedPoseScene: Scene = {
  ...scene,
  id: 'scene_named_character_at_location',
  title: '室内床铺',
  content: stagedPoseStory,
  summary: stagedPoseStory,
  characterIds: [stagedPoseCharacter.id],
  locationIds: [stagedPoseLocation.id],
  propIds: [],
};
const stagedPoseShots = buildShots({
  scene: stagedPoseScene,
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定中景',
  lighting: '柔和侧光',
  style,
  extra: '',
});
assert.equal(
  stagedPoseShots.length,
  3,
  'three explicit visible actions must preserve an exact three-shot request',
);
const stagedPosePrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: stagedPoseScene,
  globalLock: '',
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
const stagedPoseSubjects = [...stagedPosePrompt.matchAll(/主体：@([^（；\s]+)/gu)]
  .map((match) => match[1]);
assert.deepEqual(
  stagedPoseSubjects,
  ['艾米莉亚', '艾米莉亚', '艾米莉亚'],
  'every generated shot must keep the named character rather than the location as subject',
);
assert.doesNotMatch(stagedPosePrompt, /主体：@床上/u);
for (const sourceAction of ['脱下外套', '屈膝分开双腿', '露出膝间的急救包']) {
  assert.match(
    stagedPosePrompt,
    new RegExp(sourceAction, 'u'),
    `the final prompt must retain the explicit source action: ${sourceAction}`,
  );
}

const nsfwDetailPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: stagedPoseScene,
  globalLock: '',
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: 'NSFW，生成详细动作描述',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
assert.doesNotMatch(
  nsfwDetailPrompt,
  /NSFW细节模式|逐镜明确写出|不含蓄替换|不概括省略/u,
  'internal NSFW control instructions must not leak into the final model-facing prompt',
);
assert.doesNotMatch(
  nsfwDetailPrompt,
  /\bNSFW\b|生成详细动作描述/iu,
  'a control-only extra requirement must activate detail mode without being echoed as visual prose',
);
assert.doesNotMatch(
  nsfwDetailPrompt,
  /成年|未成年|年龄限定|年龄排除/u,
  'NSFW detail mode must not add age-limiting words that downstream models may misread',
);
for (const sourceAction of ['脱下外套', '屈膝分开双腿', '露出膝间的急救包']) {
  assert.match(
    nsfwDetailPrompt,
    new RegExp(sourceAction, 'u'),
    `NSFW detail mode must preserve the explicit source action: ${sourceAction}`,
  );
}
const nsfwDetailPlan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: stagedPoseScene,
  globalLock: '',
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: 'NSFW，生成详细动作描述',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
assert.doesNotMatch(
  nsfwDetailPlan.constraints.join('\n'),
  /NSFW细节模式|逐镜明确写出|不含蓄替换|不概括省略/u,
  'internal NSFW control instructions must not leak through public prompt-plan constraints',
);
const sourceDetectedNsfwDetailPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: { ...stagedPoseScene, content: '艾米莉亚在浴室里全裸站立。' },
  globalLock: '',
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
assert.doesNotMatch(
  sourceDetectedNsfwDetailPrompt,
  /NSFW细节模式|逐镜明确写出|不含蓄替换|不概括省略/u,
  'source-detected NSFW detail mode must remain internal rather than becoming timeline prose',
);
assert.doesNotMatch(sourceDetectedNsfwDetailPrompt, /成年|未成年|年龄限定|年龄排除/u);
for (const ordinaryContext of [
  '工人修复裸露电线。',
  '把钥匙插入锁孔。',
  '将 U 盘插入电脑。',
  '护士把针头插入皮肤。',
  '她脱下外套挂在衣架上。',
  '她脱去红色长裙，换上蓝色礼服。',
  '礼服只裸露肩膀。',
  '峡谷两侧是裸露岩壁。',
  '医生查看乳房X光片。',
  '实验室安排精液常规医学检查。',
  '医生用手覆上并抚摸患者胸前进行临床检查。',
  '她拒绝让对方的手覆上并抚摸胸前。',
  '晨光像温柔的手覆上并抚摸山峦胸前。',
  '美术馆陈列裸体雕塑。',
  '画廊展出裸体艺术摄影。',
  '病理报告讨论阴道超声。',
  'X光检查乳房。',
  '超声检查阴道。',
  '医生检查阴蒂炎症。',
  '医学报告记录睾丸超声。',
  '患者接受肛门手术。',
  '雕塑呈裸体姿态。',
  '裸露电极需要绝缘。',
  '电极裸露需要维修。',
  '裸露金属表面开始氧化。',
  '金属裸露在潮湿空气中。',
  '不要出现 NSFW 内容。',
  '禁止裸体。',
  '她拒绝脱下内裤。',
  '她尚未脱下内裤。',
  '她不肯全裸出镜。',
  '不要描写性行为。',
  '这是 SFW 非成人内容。',
  '没有发生性交。',
  '墙上的 NSFW 警示牌。',
  '墙上写着“警告，NSFW，禁止进入”。',
  'R18 杂志封面作为道具。',
  'This is SFW, non-adult content with no nudity.',
  'The prop is an R18 magazine cover.',
  'The laboratory performs a routine semen test.',
  'The museum presents nude art photography.',
]) {
  assert.equal(
    hasNsfwDetailSignal(ordinaryContext),
    false,
    `ordinary engineering, medical, or art context must not activate NSFW detail mode: ${ordinaryContext}`,
  );
}
assert.equal(hasNsfwDetailSignal('艾米莉亚在床上全裸站立。'), true);
assert.equal(hasNsfwDetailSignal('NSFW，生成详细动作描述'), true);
assert.equal(
  hasNsfwDetailSignal('她的手覆上并抚摸成年伴侣胸前。'),
  true,
  'direct intimate touching of the chest must activate NSFW detail mode',
);
for (const explicitPart of [
  '肉棒',
  '龟头',
  '小穴',
  '阴蒂',
  '穴口',
  '蜜液',
  '精液',
  '阴囊',
  '屁穴',
  '臀缝',
  '赤身',
  '赤裸',
  '乳尖',
  '乳晕',
  '阳具',
  '阴部',
  '性器官',
  '阴唇',
  '会阴',
  '马眼',
  '处女膜',
  '尿道口',
  '蜜穴',
  '肉穴',
  '后穴',
  '后庭',
  '勃起',
  '抽插',
  '抽送',
  '内射',
  '乳交',
  '足交',
  '骑乘位',
  '高潮痉挛',
  '潮吹',
  '交合',
  '交媾',
  '行房',
  '云雨',
  '床笫',
  '媾合',
  '发生关系',
  '后入',
  '强奸',
  '轮奸',
]) {
  assert.equal(
    hasNsfwDetailSignal(`原文明确描写${explicitPart}。`),
    true,
    `direct NSFW anatomy must activate detail mode: ${explicitPart}`,
  );
}
for (const explicitEnglish of [
  'nude',
  'naked',
  'explicit sex',
  'penis',
  'vagina',
  'penetration',
  'orgasm',
  'ejaculation',
]) {
  assert.equal(
    hasNsfwDetailSignal(`The source explicitly depicts ${explicitEnglish}.`),
    true,
    `direct English NSFW content must activate detail mode: ${explicitEnglish}`,
  );
}
for (const nonEuphemisticRequirement of [
  '不要含蓄描写性交。',
  '镜头不要回避全裸状态。',
  '禁止删减性行为细节。',
  'Do not censor explicit sex from the source.',
]) {
  assert.equal(
    hasNsfwDetailSignal(nonEuphemisticRequirement),
    true,
    `anti-censorship wording must retain the positive NSFW signal: ${nonEuphemisticRequirement}`,
  );
}

for (const [input, expected] of [
  ['NSFW，生成详细动作描述', ''],
  ['R-18；开启NSFW细节模式；保持服装连续', '保持服装连续'],
  ['保持服装连续，NSFW，生成详细动作描述', '保持服装连续'],
  ['NSFW，生成详细动作描述；人物先脱外套，再屈膝；不要字幕', '人物先脱外套，再屈膝；不要字幕'],
  ['生成详细动作描述：人物先脱外套再屈膝', '人物先脱外套再屈膝'],
  ['最终视频提示词要生成详细描述的NSFW提示词', ''],
  ['墙上出现“NSFW”警示牌', '墙上出现“NSFW”警示牌'],
  ['墙上写着“警告，NSFW，禁止进入”', '墙上写着“警告，NSFW，禁止进入”'],
  ['字幕依次显示“警告；NSFW；禁止进入”', '字幕依次显示“警告；NSFW；禁止进入”'],
  ['道具标签为“安全、R18、收藏版”', '道具标签为“安全、R18、收藏版”'],
  ['场记板标注（备用文案：安全，NSFW，收藏版）', '场记板标注（备用文案：安全，NSFW，收藏版）'],
  ['R18杂志封面作为道具', 'R18杂志封面作为道具'],
  ['不要出现NSFW字样', '不要出现NSFW字样'],
  ['二十八岁，保持人物身份和服装连续', '二十八岁，保持人物身份和服装连续'],
  ['keep camera, preserve lighting', 'keep camera, preserve lighting'],
] as const) {
  assert.equal(
    sanitizeNsfwGenerationControls(input),
    expected,
    `only generator controls may be removed from the extra requirement: ${input}`,
  );
}
const sanitizedMixedExtra = sanitizeNsfwGenerationControls(
  'R18；生成详细动作描述；保持人物身份；不要字幕',
);
assert.equal(
  sanitizeNsfwGenerationControls(sanitizedMixedExtra),
  sanitizedMixedExtra,
  'NSFW generation-control sanitization must be idempotent',
);
for (const visibleNsfwText of [
  '墙上写着“警告，NSFW，禁止进入”',
  '字幕依次显示“警告；NSFW；禁止进入”',
  '道具标签为“安全、R18、收藏版”',
  '场记板标注（备用文案：安全，NSFW，收藏版）',
]) {
  assert.equal(
    sanitizeLegacyNsfwPromptLeak(visibleNsfwText),
    visibleNsfwText,
    `legacy leak cleanup must preserve quoted or parenthesized visible text: ${visibleNsfwText}`,
  );
}

const ageMetadataCharacter: Character = {
  ...stagedPoseCharacter,
  apparentAge: '成年女性',
  appearance: '银色长发、紫色眼睛与清晰面部特征',
  outfit: '白色外套与深色长裙',
  anchor: '银色长发与成年女性外观年龄保持一致',
  negativeContinuity: '仅限成年人，排除未成年，不要改变年龄感与服装主色',
};
const legacyAgeMetadataLock = buildGlobalLock(
  stagedPoseScene,
  [ageMetadataCharacter],
  [stagedPoseLocation],
  [],
  [],
);
assert.match(
  legacyAgeMetadataLock,
  /成年女性|仅限成年人|年龄感/u,
  'the fixture must represent an existing project whose automatic character lock contains age metadata',
);
const ageSafeGlobalLock = buildGlobalLock(
  stagedPoseScene,
  [ageMetadataCharacter],
  [stagedPoseLocation],
  [],
  [],
  '',
  { omitApparentAge: true },
);
assert.doesNotMatch(
  ageSafeGlobalLock,
  /成年|未成年|仅限成人|排除未成年|年龄感|年龄限定/u,
  'new NSFW boards must not store inferred age metadata in their global lock',
);

const ageSafeNsfwPlan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: stagedPoseScene,
  globalLock: legacyAgeMetadataLock,
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: 'NSFW，生成详细动作描述；原文明示人物二十八岁',
  visualStyle: '电影写实',
  characters: [ageMetadataCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
assert.doesNotMatch(
  ageSafeNsfwPlan.constraints.join('\n'),
  /成年|未成年|仅限成人|排除未成年|年龄感|年龄限定/u,
  'NSFW prompt plans must remove age-gating phrases from automatic continuity metadata',
);
assert.match(
  ageSafeNsfwPlan.constraints.join('\n'),
  /二十八岁/u,
  'an age explicitly written in the user requirement must remain untouched',
);
const ageSafeCompiledPrompt = compileTargetPrompt({
  canonicalPrompt: ageSafeNsfwPlan.canonicalPrompt,
  durationSec: ageSafeNsfwPlan.durationSec,
  aspectRatio: ageSafeNsfwPlan.aspectRatio,
  resolution: ageSafeNsfwPlan.resolution,
  audioMode: ageSafeNsfwPlan.audioMode,
  targetId: 'veo-3.1',
  detailMode: 'director',
  references: [],
  constraints: [legacyAgeMetadataLock, ...ageSafeNsfwPlan.constraints],
  nsfwDetail: true,
}).prompt;
assert.doesNotMatch(
  ageSafeCompiledPrompt,
  /成年|未成年|仅限成人|排除未成年|年龄感|年龄限定/u,
  'the target adapter must also sanitize legacy raw global locks before model delivery',
);
assert.match(ageSafeCompiledPrompt, /二十八岁/u);
const legacySourceFlagCompiledPrompt = compileTargetPrompt({
  canonicalPrompt: stagedPosePrompt,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'veo-3.1',
  detailMode: 'director',
  references: [],
  constraints: [legacyAgeMetadataLock],
  nsfwDetail: true,
}).prompt;
assert.doesNotMatch(
  legacySourceFlagCompiledPrompt,
  /成年|未成年|仅限成人|排除未成年|年龄感|年龄限定/u,
  'a source-derived NSFW flag must sanitize a legacy canonical prompt whose old action text lost every NSFW signal',
);
const protectedAgeMetadataNames = stripAutomaticAgeMetadata(
  '固定人物：少女阿莲：成年女性，银发紫眸；青年剑客：二十余岁，黑衣长剑\n固定场景：裸体雕塑馆，少女前线主题展厅',
);
assert.match(protectedAgeMetadataNames, /固定人物：少女阿莲：银发紫眸/u);
assert.match(protectedAgeMetadataNames, /青年剑客：黑衣长剑/u);
assert.match(protectedAgeMetadataNames, /固定场景：裸体雕塑馆，少女前线主题展厅/u);
assert.doesNotMatch(protectedAgeMetadataNames, /成年女性|二十余岁/u);
const ageMetadataVariants = stripAutomaticAgeMetadata(
  '固定人物：甲：十八周岁，红衣；乙：已满18周岁，蓝衣；丙：18 years old，白衣；丁：25-year-old，黑衣；戊：aged 25，灰衣',
);
assert.doesNotMatch(ageMetadataVariants, /十八周岁|18周岁|18 years old|25-year-old|aged 25/iu);
assert.match(ageMetadataVariants, /甲：红衣；乙：蓝衣；丙：白衣；丁：黑衣；戊：灰衣/u);
assert.equal(
  stripAutomaticAgeMetadata('固定人物：阿莲：银发，保持成年女性 与银发，不要改变年龄感 与服装主色'),
  '固定人物：阿莲：银发，保持银发，不要改变服装主色',
  'spaces around an age-metadata connector must not leave broken grammar',
);
assert.deepEqual(
  sanitizeNsfwAutomaticConstraints(
    ['制作要求：NSFW，固定人物：二十八岁的艾米莉亚按原文表演'],
    true,
  ),
  ['制作要求：NSFW，固定人物：二十八岁的艾米莉亚按原文表演'],
  'metadata sanitation must never rewrite a user-authored production requirement',
);
assert.deepEqual(
  sanitizeNsfwAutomaticConstraints(
    ['制作要求：NSFW\n固定人物：艾米莉亚：二十八岁，按原文表演'],
    true,
  ),
  ['制作要求：NSFW\n固定人物：艾米莉亚：二十八岁，按原文表演'],
  'a multiline user production requirement must never be mistaken for generated metadata',
);
assert.equal(
  stripAutomaticAgeMetadata('固定人物：代号:二十八岁后的我：成年女性，红衣'),
  '固定人物：代号:二十八岁后的我：红衣',
  'colons and age-shaped text inside a character name must remain untouched',
);
assert.equal(
  stripAutomaticAgeMetadata('固定人物：艾米莉亚（参考资产角色:18岁正面）：成年女性，银发'),
  '固定人物：艾米莉亚（参考资产角色:18岁正面）：银发',
  'age-shaped text inside a bound asset name must remain untouched',
);

const nonNsfwAgePlan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: stagedPoseScene,
  globalLock: legacyAgeMetadataLock,
  shots: stagedPoseShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [ageMetadataCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
assert.match(
  nonNsfwAgePlan.constraints.join('\n'),
  /成年女性/u,
  'ordinary non-NSFW continuity prompts must retain the existing character metadata behavior',
);

const shorthandNsfwScene: Scene = {
  ...stagedPoseScene,
  id: 'scene_nsfw_shorthand_actions',
  content: '艾米莉亚在床上，脱泳装，掰开双腿，漏出膝间的急救包。',
  summary: '艾米莉亚依次完成三个明确动作。',
};
const shorthandNsfwShots = buildShots({
  scene: shorthandNsfwScene,
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '稳定中景',
  lighting: '柔和侧光',
  style,
  extra: '',
});
assert.equal(shorthandNsfwShots.length, 3);
const shorthandNsfwPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: shorthandNsfwScene,
  globalLock: '',
  shots: shorthandNsfwShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
for (const sourceAction of ['脱泳装', '掰开双腿', '漏出膝间的急救包']) {
  assert.match(
    shorthandNsfwPrompt,
    new RegExp(sourceAction, 'u'),
    `shorthand NSFW phrasing must retain the source action: ${sourceAction}`,
  );
}
assert.doesNotMatch(
  shorthandNsfwPrompt,
  /NSFW细节模式|逐镜明确写出|不含蓄替换|不概括省略/u,
  'shorthand NSFW detection must not expose the internal detail-mode directive',
);
assert.doesNotMatch(shorthandNsfwPrompt, /主体：@床上/u);
const shorthandNsfwActionChains = [...shorthandNsfwPrompt.matchAll(/正在 \[([^\]]+)\]/gu)]
  .map((match) => match[1]);
assert.equal(shorthandNsfwActionChains[1], '掰开双腿');
assert.equal(shorthandNsfwActionChains[2], '漏出膝间的急救包');

const simplifiedLegacyNsfwPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: shorthandNsfwScene,
  globalLock: '',
  shots: shorthandNsfwShots.map((shot) => ({ ...shot, action: '人物完成当前动作' })),
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
for (const sourceAction of ['脱泳装', '掰开双腿', '漏出膝间的急救包']) {
  assert.match(
    simplifiedLegacyNsfwPrompt,
    new RegExp(sourceAction, 'u'),
    `NSFW rendering must restore source detail when a legacy shot action is too generic: ${sourceAction}`,
  );
}
const shorthandNsfwSingleShot = buildShots({
  scene: shorthandNsfwScene,
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '稳定中景',
  lighting: '柔和侧光',
  style,
  extra: '',
});
const shorthandNsfwSinglePrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: shorthandNsfwScene,
  globalLock: '',
  shots: shorthandNsfwSingleShot,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
for (const sourceAction of ['脱泳装', '掰开双腿', '漏出膝间的急救包']) {
  assert.match(
    shorthandNsfwSinglePrompt,
    new RegExp(sourceAction, 'u'),
    `a requested single shot must still retain the complete ordered action sequence: ${sourceAction}`,
  );
}

const staticPoseShot = {
  ...shots[0],
  id: 'shot_static_pose_no_invention',
  index: 1,
  startSec: 0,
  endSec: 8,
  purpose: '建立静态姿态',
  subject: '艾米莉亚',
  action: '艾米莉亚仰卧在床上',
  camera: '稳定中景',
  result: '艾米莉亚保持仰卧姿态',
};
const staticPosePrompt = renderShotPrompt(
  staticPoseShot,
  8,
  [],
  [staticPoseShot],
  'stereo',
  timelineRule,
  { characters: [stagedPoseCharacter] },
);
const staticPoseActionChain = staticPosePrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '';
assert.match(staticPoseActionChain, /仰卧在床上/u);
assert.doesNotMatch(
  staticPoseActionChain,
  /目光锁定目标|身体重心微移|动作结果自然停住|抬眼|拉开距离|攻击|格挡|终结动作/u,
  'a static pose must not receive generic visible actions absent from the source',
);
const regexMetaSubjectShot = {
  ...staticPoseShot,
  id: 'shot_regex_meta_subject',
  subject: 'A(B',
  action: 'A(B仰卧在床上',
};
assert.doesNotThrow(
  () => renderShotPrompt(
    regexMetaSubjectShot,
    8,
    [],
    [regexMetaSubjectShot],
    'stereo',
    timelineRule,
  ),
  'a subject containing regular-expression metacharacters must not crash prompt rendering',
);

const projectLocation: Location = {
  id: 'location_lab',
  name: '清泉市实验室',
  description: '无菌白色实验室与弧形观察窗',
  timeWeather: '深夜',
  lighting: '顶部冷白柔光',
  palette: '白色与浅蓝色',
  fixedProps: '银色操作台',
  anchor: '弧形观察窗保持在画面右侧',
  assetIds: [],
};
const projectProp: Prop = {
  id: 'prop_core',
  name: '母巢',
  category: '机械控制核心',
  material: '白色陶瓷与拉丝金属',
  appearance: '白色陶瓷外壳和蓝色状态灯',
  effect: '内部风扇发出低沉运转声',
  stateRules: '外壳保持完整',
  assetIds: [],
};
const projectDrivenPrompt = renderFinalPrompt({
  durationSec: 3,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: {
    ...scene,
    title: projectLocation.name,
    content: '西娅走近母巢，检查蓝色状态灯。',
    summary: '西娅检查机械控制核心。',
    characterIds: ['char_xia'],
    locationIds: [projectLocation.id],
    propIds: [projectProp.id],
  },
  globalLock: '',
  shots: [{
    ...shots[0],
    id: 'project-driven-shot',
    startSec: 0,
    endSec: 3,
    subject: '西娅与母巢',
    action: '西娅走近母巢，检查蓝色状态灯。',
    lighting: '',
    sound: '',
  }],
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: invalidSubjectCharacters,
  locations: [projectLocation],
  props: [projectProp],
});
assert.match(projectDrivenPrompt, /白色陶瓷外壳|机械控制核心/u);
assert.match(projectDrivenPrompt, /顶部冷白柔光/u);
assert.doesNotMatch(
  projectDrivenPrompt,
  /崩飞的混凝土块|被红光照亮的城市天际线|飘落的发光孢子|核心向外3000K|地层撕裂与触手破土声|压迫性低音管风琴|升降镜头逐步展露动作规模|鸟瞰视角|（威严）/u,
);

const monsterScene: Scene = {
  ...scene,
  id: 'scene_monster_action',
  title: '暴雨城市',
  content: '一头六足甲壳巨兽从地铁口爬出，背部骨刺张开，低伏冲向装甲车，甩尾击碎路障，踏裂积水路面，最后昂首咆哮。',
  summary: '六足甲壳巨兽突袭装甲车并昂首咆哮。',
};
const monsterShots = buildShots({
  scene: monsterScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 15,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'fast',
  camera: '低机位快速跟拍，随后环绕巨兽',
  lighting: '冷蓝闪电与橙色车灯',
  style,
  extra: '主体始终是非人类六足甲壳巨兽',
});
const monsterPrimaryBeats = monsterShots.map((shot) => shot.action.split('；')[0]);
assert.ok(
  new Set(monsterPrimaryBeats).size >= 4,
  `comma-separated creature actions must be distributed across shots: ${monsterPrimaryBeats.join(' | ')}`,
);
assert.match(monsterPrimaryBeats.at(-1) || '', /昂首咆哮/u, 'the final story action must reach the final shot');
const monsterPrompt = renderFinalPrompt({
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene: monsterScene,
  globalLock: '六足甲壳巨兽保持六足、甲壳、骨刺与尾部结构，禁止人形化。',
  shots: monsterShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '主体始终是非人类六足甲壳巨兽',
  visualStyle: '电影写实',
  characters: [],
  locations: [],
  props: [],
});
assert.match(monsterPrompt, /主体：@六足甲壳巨兽/u, 'an unnamed creature must keep its species name as the subject');
assert.match(monsterPrompt, /甩尾击碎路障/u, 'middle creature actions must survive timeline rendering');
assert.match(monsterPrompt, /昂首咆哮/u, 'the final creature action must survive timeline rendering');
assert.doesNotMatch(monsterPrompt, /衣物破风|人物缩短|主角卸力/u, 'creature shots must not inherit human-only action or sound templates');

const tentacledCharacter: Character = {
  id: 'char_heka',
  name: '赫卡',
  gender: '无性',
  apparentAge: '远古',
  race: '无定形触手怪兽',
  appearance: '无面孔，十二条半透明触手围绕胶质核心放射展开',
  outfit: '无衣物',
  signatureProps: '无',
  personality: '警戒',
  motionHabits: '依靠触肢卷束和质量转移贴地爬行',
  anchor: '胶质核心、十二条半透明触手和无面孔结构始终不变',
  negativeContinuity: '禁止人形、禁止人类手臂手掌、禁止双足直立和人物面部表演',
  assetIds: [],
};
const tentacledScene: Scene = {
  ...scene,
  id: 'scene_tentacled',
  title: '地下孵化室',
  content: '赫卡从培养池中苏醒，触肢卷住池沿，将胶质核心拖出水面。',
  summary: '赫卡苏醒并离开培养池。',
  characterIds: [tentacledCharacter.id],
};
const tentacledShots = buildShots({
  scene: tentacledScene,
  characters: [tentacledCharacter],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  camera: '低机位跟拍',
  lighting: '冷白顶光',
  style,
  extra: '',
});
const tentacledLock = buildGlobalLock(tentacledScene, [tentacledCharacter], [], [], []);
assert.match(tentacledLock, /无定形触手怪兽/u, 'global continuity must retain the declared species');
assert.match(tentacledLock, /触肢卷束和质量转移/u, 'global continuity must retain species motion habits');
assert.match(tentacledLock, /禁止人形/u, 'global continuity must retain negative anatomy constraints');
const tentacledPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene: tentacledScene,
  globalLock: tentacledLock,
  shots: tentacledShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  visualStyle: '生物科幻',
  characters: [tentacledCharacter],
  locations: [],
  props: [],
});
assert.match(tentacledPrompt, /无定形触手怪兽/u, 'the video prompt must include the nonhuman species anchor');
assert.match(tentacledPrompt, /十二条半透明触手|触肢卷束|质量转移/u, 'the video prompt must include anatomy-compatible motion');
assert.doesNotMatch(
  tentacledPrompt,
  /目光锁定|身体重心|重心骤然|衣物(?:、|与|破风)|人物脚步|聚焦面部|面朝动作目标/u,
  'a faceless tentacled creature must not receive human acting fallbacks',
);

const renderCreatureMotionCase = (
  id: string,
  name: string,
  race: string,
  appearance: string,
  motionHabits: string,
  content: string,
): string => {
  const character: Character = {
    id: `char_${id}`,
    name,
    gender: '无性',
    apparentAge: '成年',
    race,
    appearance,
    outfit: '无服装',
    signatureProps: '无',
    personality: '警戒',
    motionHabits,
    anchor: `${race}的解剖结构保持不变`,
    negativeContinuity: '禁止变成人类或出现人类手掌',
    assetIds: [],
  };
  const creatureScene: Scene = {
    ...scene,
    id: `scene_${id}`,
    title: '荒原',
    content,
    summary: content,
    characterIds: [character.id],
  };
  const creatureShots = buildShots({
    scene: creatureScene,
    characters: [character],
    locations: [],
    props: [],
    assets: [],
    workflow: 'action',
    durationSec: 8,
    shotMode: 'exact',
    shotCount: 3,
    pace: 'standard',
    camera: '稳定跟拍',
    lighting: '冷白侧光',
    style,
    extra: '',
  });
  return renderFinalPrompt({
    durationSec: 8,
    aspectRatio: '16:9',
    resolution: '2K',
    audioMode: 'stereo',
    workflow: 'action',
    inputMode: 'text',
    scene: creatureScene,
    globalLock: buildGlobalLock(creatureScene, [character], [], [], []),
    shots: creatureShots,
    assets: [],
    style,
    ruleSet: timelineRule,
    converter,
    extra: '',
    visualStyle: '电影写实',
    characters: [character],
    locations: [],
    props: [],
  });
};

const quadrupedPrompt = renderCreatureMotionCase(
  'quadruped', '霜牙', '四足狼兽', '低伏脊背、粗壮四肢与长尾', '以后足蹬地、足爪落地和尾部平衡完成跃扑',
  '霜牙伏低脊背，后足蹬地跃过岩缝，足爪落地后甩尾停稳。',
);
assert.match(quadrupedPrompt, /四足狼兽|足爪|脊背/u);
assert.doesNotMatch(quadrupedPrompt, /衣物破风|聚焦面部|身体重心/u);

const wingedPrompt = renderCreatureMotionCase(
  'winged', '烬翼', '双翼飞行巨兽', '宽大翼膜、翼爪与长尾', '依靠振翼、滑翔和收翼俯冲改变轨迹',
  '烬翼展开翼膜，振翼掠过峡谷，随后收翼俯冲落向石台。',
);
assert.match(wingedPrompt, /双翼飞行巨兽|翼膜|振翼/u);
assert.doesNotMatch(wingedPrompt, /衣物破风|人物脚步|身体重心/u);

const serpentinePrompt = renderCreatureMotionCase(
  'serpentine', '玄蟒', '无足蛇形巨兽', '覆盖黑鳞的连续长躯与粗壮尾部', '通过躯干波动和盘绕推进',
  '玄蟒从石缝蜿蜒爬出，长躯盘绕石柱，尾部抽击地面。',
);
assert.match(serpentinePrompt, /无足蛇形巨兽|长躯|盘绕|躯干/u);
assert.doesNotMatch(serpentinePrompt, /衣物破风|人物脚步|身体重心/u);

const humanoidPrompt = renderCreatureMotionCase(
  'humanoid', '魁', '拟人化双足兽人', '双足直立、两条手臂与人形面部', '直立行走并用双手操作道具',
  '魁站在门前，握拳锁定目标，随后向前冲锋。',
);
assert.match(humanoidPrompt, /面朝/u, 'an explicitly humanoid creature may retain human-facing direction language');

const actorTargetScene: Scene = {
  ...scene,
  id: 'scene_actor_target_relation',
  title: '巨人迎战怪兽',
  content: '迪迦奥特曼打哥尔赞怪兽。',
  summary: '迪迦奥特曼攻击哥尔赞怪兽。',
};
const actorTargetShots = buildShots({
  scene: actorTargetScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'standard',
  camera: '稳定侧向跟拍',
  lighting: '日间自然光',
  style,
  extra: '',
});
const actorTargetPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene: actorTargetScene,
  globalLock: '',
  shots: actorTargetShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter: defaultConverterPresets.find((item) => item.workflow === 'action') || converter,
  extra: '',
  visualStyle: '特摄电影写实',
  characters: [],
  locations: [],
  props: [],
});
assert.equal(actorTargetShots[0].subject, '迪迦奥特曼', 'the storyboard shot must store only the grammatical actor as subject');
assert.match(actorTargetPrompt, /主体：@迪迦奥特曼/u, 'the grammatical actor must remain the shot subject');
assert.doesNotMatch(actorTargetPrompt, /主体：@(?:迪迦奥特曼打哥尔赞怪兽|哥尔赞怪兽)/u, 'actor and target must not be merged or swapped');
assert.match(actorTargetPrompt, /哥尔赞怪兽/u, 'the action target must remain explicit in the motion chain');

const beamAttackScene: Scene = {
  ...actorTargetScene,
  id: 'scene_beam_actor_target_relation',
  content: '奥特曼发射大招消灭怪兽，特摄剧。',
  summary: '奥特曼发射大招消灭怪兽。',
};
const beamAttackShots = buildShots({
  scene: beamAttackScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 6,
  pace: 'standard',
  camera: '稳定侧向跟拍',
  lighting: '日间自然光',
  style,
  extra: '',
});
assert.ok(beamAttackShots.every((shot) => shot.subject === '奥特曼'), 'an energy attack must keep the actor separate from its target');
assert.equal(beamAttackShots.length, 6, 'exact action mode must preserve the six requested kinetic shots');
assert.equal(new Set(beamAttackShots.map((shot) => shot.action)).size, 6, 'expanded kinetic phases must retain six distinct executable actions');
assert.match(beamAttackShots.map((shot) => shot.action).join('\n'), /怪兽/u, 'the energy attack target must remain explicit');
assert.doesNotMatch(beamAttackShots.map((shot) => shot.action).join('\n'), /特摄剧/u, 'a style phrase must not be mistaken for part of the physical action');
const beamCanonicalPrompt = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene: beamAttackScene,
  globalLock: '',
  shots: beamAttackShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter: defaultConverterPresets.find((item) => item.workflow === 'action') || converter,
  extra: '',
  visualStyle: '特摄电影写实',
  characters: [],
  locations: [],
  props: [],
});
const beamH3Prompt = compileTargetPrompt({
  canonicalPrompt: beamCanonicalPrompt,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
assert.equal((beamH3Prompt.match(/\[Shot \d+\]/gu) || []).length, 6, 'H3 must preserve all six exact kinetic shots');
assert.match(beamH3Prompt, /蓄力[\s\S]*传力[\s\S]*释放[\s\S]*反作用[\s\S]*收势/u);
assert.match(beamH3Prompt, /怪兽沿受力方向产生可见位移或形变/u, 'the attack target must receive a visible physical reaction');
assert.match(beamH3Prompt, /\[Shot 6\][\s\S]*镜头：/u, 'even long six-shot H3 output must retain the final shot and camera');

const kineticHuman: Character = {
  id: 'char_kinetic_human',
  name: '李云',
  gender: '男',
  apparentAge: '青年',
  race: '人类',
  appearance: '黑发，身形敏捷',
  outfit: '深色练功服',
  signatureProps: '无',
  personality: '果断',
  motionHabits: '发力时由下肢带动躯干，动作结束后自然回稳',
  anchor: '外观与服装稳定',
  negativeContinuity: '',
  assetIds: [],
};
const kineticHumanScene: Scene = {
  ...scene,
  id: 'scene_kinetic_human',
  title: '练功场',
  content: '李云挥拳击打木桩。',
  summary: '李云挥拳击中木桩。',
  characterIds: [kineticHuman.id],
};
const kineticRecommendation = recommendShotCount({
  durationSec: 8,
  workflow: 'action',
  pace: 'standard',
  story: kineticHumanScene.content,
});
assert.ok(kineticRecommendation.count > 2, 'an 8-second action must keep the automatic recommendation instead of being forced to two shots');

const buildKineticHumanShots = (shotCount: number) => buildShots({
  scene: kineticHumanScene,
  characters: [kineticHuman],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount,
  pace: 'standard',
  camera: '稳定侧向跟拍',
  lighting: '日间自然光',
  style,
  extra: '',
});
const fivePhaseHumanShots = buildKineticHumanShots(5);
assert.equal(fivePhaseHumanShots.length, 5, 'exact mode must preserve the requested five-shot count');
assert.equal(new Set(fivePhaseHumanShots.map((shot) => shot.action)).size, 5, 'each kinetic phase must use a distinct action sentence');
assert.match(fivePhaseHumanShots[0].action, /蓄力/u);
assert.match(fivePhaseHumanShots[1].action, /重心|躯干.*传力/u);
assert.match(fivePhaseHumanShots[2].action, /释放|接触/u);
assert.match(fivePhaseHumanShots[3].action, /反作用|回弹/u);
assert.match(fivePhaseHumanShots[4].action, /收势|回稳/u);

const threePhaseHumanShots = buildKineticHumanShots(3);
assert.equal(threePhaseHumanShots.length, 3, 'exact mode must preserve the requested three-shot count');
assert.equal(new Set(threePhaseHumanShots.map((shot) => shot.action)).size, 3, 'compressed kinetic phases must remain distinct');
assert.match(threePhaseHumanShots.map((shot) => shot.action).join('\n'), /蓄力[\s\S]*传力[\s\S]*(?:释放|接触)[\s\S]*(?:反作用|回弹)[\s\S]*(?:收势|回稳)/u);

const kineticQuadruped: Character = {
  ...kineticHuman,
  id: 'char_kinetic_quadruped',
  name: '霜牙',
  gender: '无性',
  race: '四足狼兽',
  appearance: '低伏脊背、粗壮四肢与长尾',
  outfit: '无服装',
  personality: '凶猛',
  motionHabits: '以后肢蹬地、脊柱传力和尾部平衡完成跃扑',
  anchor: '四足、脊背与长尾结构稳定',
  negativeContinuity: '禁止人形和双足直立',
};
const kineticQuadrupedScene: Scene = {
  ...kineticHumanScene,
  id: 'scene_kinetic_quadruped',
  content: '霜牙扑向猎物。',
  summary: '霜牙跃扑猎物。',
  characterIds: [kineticQuadruped.id],
};
const kineticQuadrupedShots = buildShots({
  scene: kineticQuadrupedScene,
  characters: [kineticQuadruped],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'standard',
  camera: '低机位侧向跟拍',
  lighting: '冷白侧光',
  style,
  extra: '',
});
assert.match(kineticQuadrupedShots[0].action, /后肢|四足/u);
assert.match(kineticQuadrupedShots[1].action, /脊柱.*传力/u);
assert.match(kineticQuadrupedShots[2].action, /扑向猎物|接触/u);
assert.match(kineticQuadrupedShots[3].action, /反作用|缓冲/u);
assert.match(kineticQuadrupedShots[4].action, /尾部.*(?:收势|停稳)/u);
assert.doesNotMatch(kineticQuadrupedShots.map((shot) => shot.action).join('\n'), /骨盆|肩带|支撑脚/u, 'quadruped kinetic chains must not inherit human anatomy');

// Quality regression: duration and pace may not manufacture more narrative
// shots than the story contains distinct visible events.
const fourEventNarrative = '林岚走到门前。林岚推开木门。林岚进入房间。林岚点亮台灯。';
for (const pace of ['standard', 'tight', 'fast'] as const) {
  const recommendation = recommendShotCount({
    durationSec: 225.5,
    workflow: 'drama',
    pace,
    story: fourEventNarrative,
  });
  assert.ok(
    recommendation.count <= 4 && recommendation.max <= 4,
    `${pace} pace must not inflate four real visual events into ${recommendation.count}/${recommendation.max} narrative shots`,
  );
}

const synonymousDoorNarrative: Scene = {
  ...scene,
  id: 'scene_semantic_dedup',
  title: '门口',
  content: '林岚推开木门。随后林岚伸手把门推开。林岚走进房间。',
  summary: '林岚推门后进入房间。',
};
const synonymousDoorRecommendation = recommendShotCount({
  durationSec: 30,
  workflow: 'drama',
  pace: 'fast',
  story: synonymousDoorNarrative.content,
});
assert.ok(
  synonymousDoorRecommendation.max <= 2,
  'synonymous repetitions such as 推开木门/伸手把门推开 must count as one visual event',
);
const autoDeduplicatedNarrativeShots = buildShots({
  scene: synonymousDoorNarrative,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 30,
  shotMode: 'auto',
  shotCount: 20,
  pace: 'fast',
  camera: '稳定跟拍',
  lighting: '室内自然光',
  style,
  extra: '',
});
assert.ok(
  autoDeduplicatedNarrativeShots.length <= 2,
  'auto mode must clamp a narrative timeline to its distinct semantic events even when a stale caller requests 20 shots',
);

const exactNarrativeScene: Scene = {
  ...scene,
  id: 'scene_exact_semantic_density',
  content: '林岚走到门前。林岚推开木门。林岚进入房间。',
  summary: '林岚走到门前，推门进入房间。',
};
const exactNarrativeShots = buildShots({
  scene: exactNarrativeScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 30,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'standard',
  camera: 'stable tracking shot',
  lighting: 'natural interior light',
  style,
  extra: '',
});
assert.equal(
  exactNarrativeShots.length,
  5,
  'exact narrative mode must preserve five requested shots even when the story contains only three semantic events',
);
assert.equal(
  exactNarrativeShots.every((shot) => Boolean(shot.action.trim()) && Boolean(shot.purpose.trim())),
  true,
  'each expanded exact narrative shot must retain an executable action and purpose',
);
assert.equal(
  exactNarrativeShots.slice(1).some((shot, index) => (
    exactNarrativeShots[index].action === shot.action
    || exactNarrativeShots[index].purpose === shot.purpose
  )),
  false,
  'expanded exact narrative shots must not repeat the adjacent action or purpose verbatim',
);
const exactNarrativePrompt = renderFinalPrompt({
  durationSec: 30,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: exactNarrativeScene,
  globalLock: '',
  shots: exactNarrativeShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
});
const exactNarrativeValidation = validateStoryboardPrompt({
  durationSec: 30,
  workflow: 'drama',
  inputMode: 'text',
  shotMode: 'exact',
  shots: exactNarrativeShots,
  finalPrompt: exactNarrativePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  exactNarrativeValidation.valid,
  true,
  `an exact five-shot build must survive final prompt validation: ${exactNarrativeValidation.errors.join('；')}`,
);
const automaticNarrativeValidation = validateStoryboardPrompt({
  durationSec: 30,
  workflow: 'drama',
  inputMode: 'text',
  shotMode: 'auto',
  shots: exactNarrativeShots,
  finalPrompt: exactNarrativePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  automaticNarrativeValidation.valid,
  true,
  'adjacent similar actions may be a continuous performance or a different framing, not a local rejection reason',
);

const overRequestedKineticShots = buildKineticHumanShots(20);
assert.equal(
  overRequestedKineticShots.length,
  20,
  'exact action mode must preserve all requested shots even when one semantic action needs more than five phases',
);
assert.equal(
  new Set(overRequestedKineticShots.map((shot) => shot.action)).size,
  20,
  'an over-requested exact kinetic action must subdivide its phases into distinct executable shots',
);

const autoMultiEventActionShots = buildShots({
  scene: exactNarrativeScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 30,
  shotMode: 'auto',
  shotCount: 20,
  pace: 'fast',
  camera: 'dynamic tracking shot',
  lighting: 'hard directional light',
  style,
  extra: '',
});
assert.ok(
  autoMultiEventActionShots.length <= 3,
  'automatic action mode must remain constrained by the three distinct semantic events',
);

const exactMultiEventActionShots = buildShots({
  scene: exactNarrativeScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 30,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'fast',
  camera: 'dynamic tracking shot',
  lighting: 'hard directional light',
  style,
  extra: '',
});
assert.equal(
  exactMultiEventActionShots.length,
  5,
  'exact multi-event action mode must preserve five requested shots for three semantic events',
);
assert.equal(
  exactMultiEventActionShots.every((shot) => Boolean(shot.action.trim()) && Boolean(shot.purpose.trim())),
  true,
  'each expanded exact action shot must retain an executable action and purpose',
);
assert.equal(
  exactMultiEventActionShots.slice(1).some((shot, index) => (
    exactMultiEventActionShots[index].action === shot.action
    || exactMultiEventActionShots[index].purpose === shot.purpose
  )),
  false,
  'expanded exact action shots must not repeat the adjacent action or purpose verbatim',
);

for (const exactKineticShotCount of [1, 2, 3, 4, 5]) {
  const exactKineticShots = buildKineticHumanShots(exactKineticShotCount);
  assert.equal(
    exactKineticShots.length,
    exactKineticShotCount,
    `one kinetic action must preserve ${exactKineticShotCount} requested physical phase shots`,
  );
  assert.equal(
    new Set(exactKineticShots.map((shot) => shot.action)).size,
    exactKineticShotCount,
    `one kinetic action must render ${exactKineticShotCount} distinct physical phase shots`,
  );
}

const gridRecommendation = recommendShotCount({
  durationSec: 30,
  workflow: 'grid',
  pace: 'fast',
  story: fourEventNarrative,
});
assert.deepEqual(
  [gridRecommendation.count, gridRecommendation.min, gridRecommendation.max],
  [9, 9, 9],
  'grid recommendation must remain fixed at nine visual states',
);
const automaticGridShots = buildShots({
  scene: exactNarrativeScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'grid',
  durationSec: 30,
  shotMode: 'auto',
  shotCount: 20,
  pace: 'fast',
  camera: 'stable grid framing',
  lighting: 'natural interior light',
  style,
  extra: '',
});
assert.equal(automaticGridShots.length, 9, 'automatic grid generation must remain fixed at nine shots');

assert.deepEqual(
  analyzeTextLocally('将军李云在城门前拔剑。').characterNames,
  ['李云'],
  'the title 将军 must not trigger the auxiliary 将 prefix rejection or survive as a duplicate character',
);
assert.equal(
  analyzeTextLocally('将军李云来到城门前拔剑。').locationName,
  '城门前',
  'a visible action after a relative location must not become part of the persisted location name',
);

// Keep the original regression text independent of mutable user delivery data.
const deliveredPromptRegressionFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/qingquan-long-story.json', import.meta.url), 'utf8'),
) as { content: string };
const deliveredPromptRegressionStory = deliveredPromptRegressionFixture.content;
assert.equal(deliveredPromptRegressionStory.length, 1257, 'the real prompt regression fixture must remain available');
assert.ok(deliveredPromptRegressionStory.includes('枪声与火炮的喧嚣揉碎了清泉市的夜晚'));
const deliveredPromptRegressionBeats = extractStoryBeats(deliveredPromptRegressionStory);
const deliveredPromptRegressionShots = buildShots({
  scene: {
    ...scene,
    id: 'scene_real_1257_prompt_trace',
    content: deliveredPromptRegressionStory,
    summary: '真实 1257 字长剧情提示词来源追踪。',
  },
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 60,
  shotMode: 'exact',
  shotCount: 4,
  pace: 'standard',
  camera: '稳定叙事镜头',
  lighting: '自然环境光',
  style,
  extra: '',
});
const deliveredBeatTextById = new Map(
  deliveredPromptRegressionBeats.map((beat) => [
    beat.id,
    beat.text.replace(/\s+/gu, ' ').trim().replace(/[。！？!?，；;,.]+$/u, ''),
  ]),
);
for (const deliveredShot of deliveredPromptRegressionShots) {
  for (const sourceBeatId of deliveredShot.sourceBeatIds || []) {
    const evidence = deliveredBeatTextById.get(sourceBeatId) || '';
    assert.ok(evidence, `source beat ${sourceBeatId} must exist in the real 1257-character fixture`);
    assert.match(
      deliveredShot.action.replace(/\s+/gu, ' '),
      new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `shot action must retain the complete evidence named by ${sourceBeatId}`,
    );
  }
}
assert.deepEqual(
  deliveredPromptRegressionShots.flatMap((shot) => shot.sourceBeatIds || []),
  deliveredPromptRegressionBeats.map((beat) => beat.id),
  'the real story sourceBeatIds must cover each source beat exactly once and in order',
);

const longNsfwTailAction = '最后她脱泳装，掰开双腿，漏出膝间的急救包';
const longNsfwStory = `艾米莉亚在床上${'房间保持安静而摄影机持续记录她的连续姿态'.repeat(24)}${longNsfwTailAction}`;
assert.ok(longNsfwStory.length > 360, 'the NSFW regression must cross every former fixed action cutoff');
const longNsfwScene: Scene = {
  ...scene,
  id: 'scene_long_nsfw_tail_evidence',
  title: '室内连续动作',
  content: longNsfwStory,
  summary: '一段超过旧字符上限且尾部包含关键动作的连续剧情。',
};
const longNsfwShots = buildShots({
  scene: longNsfwScene,
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 15,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '稳定中景',
  lighting: '柔和侧光',
  style,
  extra: 'NSFW，生成详细动作描述',
});
for (const sourceAction of ['脱泳装', '掰开双腿', '漏出膝间的急救包']) {
  assert.match(
    longNsfwShots[0].action,
    new RegExp(sourceAction, 'u'),
    `the built shot must retain the long NSFW source tail: ${sourceAction}`,
  );
}
assert.deepEqual(
  longNsfwShots[0].sourceBeatIds,
  extractStoryBeats(longNsfwStory).map((beat) => beat.id),
  'a one-shot NSFW plan must trace every action-bearing source beat used by its prompt',
);
const longNsfwPrompt = renderFinalPrompt({
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: longNsfwScene,
  globalLock: '',
  shots: longNsfwShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: 'NSFW，生成详细动作描述',
  visualStyle: '电影写实',
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
});
for (const sourceAction of ['脱泳装', '掰开双腿', '漏出膝间的急救包']) {
  assert.match(
    longNsfwPrompt,
    new RegExp(sourceAction, 'u'),
    `the final prompt must retain the long NSFW source tail: ${sourceAction}`,
  );
}

const longSingleBeatNsfwStory = `艾米莉亚${'保持呼吸稳定并让摄影机持续记录连续姿态'.repeat(16)}最终脱泳装`;
assert.equal(extractStoryBeats(longSingleBeatNsfwStory).length, 1);
const longSingleBeatNsfwShots = buildShots({
  scene: {
    ...longNsfwScene,
    id: 'scene_long_single_beat_nsfw_tail',
    content: longSingleBeatNsfwStory,
  },
  characters: [stagedPoseCharacter],
  locations: [stagedPoseLocation],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 15,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '稳定中景',
  lighting: '柔和侧光',
  style,
  extra: 'NSFW，生成详细动作描述',
});
assert.deepEqual(longSingleBeatNsfwShots[0].sourceBeatIds, ['beat_1']);
assert.match(
  longSingleBeatNsfwShots[0].action,
  /最终脱泳装/u,
  'kinetic expansion must retain the tail of a long source beat instead of cutting it at 72 characters',
);

const multiDialogueShot = {
  ...shots[0],
  id: 'shot_multi_dialogue',
  index: 1,
  startSec: 0,
  endSec: 15,
  subject: '阿青',
  action: '李云对阿青说道：“先走。”“我来断后。”墙上的木牌写着“禁止进入”。然后李云拔剑。',
};
const multiDialoguePrompt = renderShotPrompt(
  multiDialogueShot,
  15,
  [],
  [multiDialogueShot],
  'stereo',
  timelineRule,
);
assert.match(
  multiDialoguePrompt,
  /台词：第\d+(?:\.\d+)?s @李云："先走。"｜第\d+(?:\.\d+)?s @李云："我来断后。"/u,
  'all cue-backed dialogue spans must be retained and “X 对 Y 说道” must attribute speech to X',
);
assert.doesNotMatch(
  multiDialoguePrompt.match(/；台词：([^；]+)；音效：/u)?.[1] || '',
  /禁止进入/u,
  'quoted signs and labels without a speech cue must not be misclassified as dialogue',
);
assert.doesNotMatch(
  multiDialoguePrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '',
  /(?:^|→)对阿青(?:→|$)/u,
  'removing a speech cue must not leave the listener relation “对Y” as a visible action stage',
);
const multiDialogueValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: multiDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(multiDialogueValidation.valid, true, multiDialogueValidation.errors.join('\n'));
const firstPersonVisualInstructionPrompt = multiDialoguePrompt
  .replace(/正在 \[[^\]]+\]/u, '正在 [我向前迈步→我拔剑挡住出口]')
  .replace(/镜头：/u, '镜头：中景跟拍我，');
const firstPersonVisualInstructionValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: firstPersonVisualInstructionPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  firstPersonVisualInstructionValidation.valid,
  true,
  'narrative viewpoint is for the AI to interpret rather than a local rejection reason',
);
assert.deepEqual(
  firstPersonVisualInstructionValidation.errors,
  [],
  'local validation must not report semantic errors for visual instructions',
);
assert.equal(
  multiDialogueValidation.warnings.some((warning) => /原对白.*省略|原对白.*截取/u.test(warning)),
  false,
  'validation must recognize that every source dialogue span is present',
);
const missingSecondDialoguePrompt = multiDialoguePrompt.replace(
  /｜第\d+(?:\.\d+)?s @李云："我来断后。"/u,
  '',
);
const missingSecondDialogueValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: missingSecondDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.deepEqual(
  missingSecondDialogueValidation.warnings,
  [],
  'source dialogue coverage is reviewed by the AI, not local string matching',
);
const missingFirstDialoguePrompt = multiDialoguePrompt.replace(
  /第\d+(?:\.\d+)?s @李云："先走。"｜/u,
  '',
);
const missingFirstDialogueValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: missingFirstDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
const missingFirstDialogueWarnings = missingFirstDialogueValidation.warnings.filter(
  (warning) => warning.includes('原对白'),
);
assert.equal(
  missingFirstDialogueWarnings.length,
  0,
  'local validation must not infer omitted dialogue from source alignment',
);

const containedDialogueShot = {
  ...multiDialogueShot,
  id: 'shot_contained_dialogue',
  endSec: 1.2,
  action: '李云说道：“千万不要回头”“回头”',
};
const containedDialoguePrompt = renderShotPrompt(
  containedDialogueShot,
  1.2,
  [],
  [containedDialogueShot],
  'stereo',
  timelineRule,
);
assert.match(containedDialoguePrompt, /"千万不要回头"/u, 'short duration must not delete the longer first line');
assert.match(containedDialoguePrompt, /@李云："回头"/u);
const containedDialogueValidation = validateStoryboardPrompt({
  durationSec: 1.2,
  workflow: 'drama',
  inputMode: 'text',
  shots: [containedDialogueShot],
  finalPrompt: containedDialoguePrompt.replace(/第\d+(?:\.\d+)?s @李云："千万不要回头"｜/u, ''),
  ruleSetId: timelineRule.id,
}, [], timelineRule);
const containedDialogueWarnings = containedDialogueValidation.warnings.filter(
  (warning) => warning.includes('原对白'),
);
assert.deepEqual(
  containedDialogueWarnings,
  [],
  'contained dialogue text must not produce local coverage warnings',
);

const repeatedDialogueSpeakersShot = {
  ...multiDialogueShot,
  id: 'shot_repeated_dialogue_speakers',
  action: '李云说道：“回头。”阿青说道：“回头。”',
};
const repeatedDialogueSpeakersPrompt = renderShotPrompt(
  repeatedDialogueSpeakersShot,
  15,
  [],
  [repeatedDialogueSpeakersShot],
  'stereo',
  timelineRule,
);
const missingFirstSpeakerPrompt = repeatedDialogueSpeakersPrompt.replace(
  /第\d+(?:\.\d+)?s @李云："回头。"｜/u,
  '',
);
const missingFirstSpeakerValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [repeatedDialogueSpeakersShot],
  finalPrompt: missingFirstSpeakerPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.deepEqual(
  missingFirstSpeakerValidation.warnings.filter((warning) => warning.includes('原对白')),
  [],
  'speaker ownership is reviewed by the AI, not guessed by local alignment',
);

const extraRenderedDialoguePrompt = multiDialoguePrompt.replace(
  '；音效：',
  '｜第10s @李云："擅自新增。"；音效：',
);
const extraRenderedDialogueValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: extraRenderedDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.deepEqual(
  extraRenderedDialogueValidation.warnings,
  [],
  'local validation must not judge AI-authored dialogue additions',
);

const quotedSignShot = {
  ...multiDialogueShot,
  id: 'shot_quoted_sign',
  action: '李云停在城门前，墙上的木牌写着“禁止进入”，随后拔剑。',
};
const quotedSignPrompt = renderShotPrompt(quotedSignShot, 15, [], [quotedSignShot], 'stereo', timelineRule);
assert.match(quotedSignPrompt, /；台词：无；音效：/u);
const quotedSignValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [quotedSignShot],
  finalPrompt: quotedSignPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  quotedSignValidation.warnings.some((warning) => warning.includes('原对白')),
  false,
  'validation must not warn that a quoted non-dialogue label was dropped',
);

const scoldingDialogueShot = {
  ...multiDialogueShot,
  id: 'shot_scolding_dialogue',
  endSec: 5,
  subject: '素纱女子',
  action: '素纱女子咬唇望来，眼中竖瞳一闪，随即柔声骂了句“卑鄙”。',
};
const scoldingDialoguePrompt = renderShotPrompt(
  scoldingDialogueShot,
  5,
  [],
  [scoldingDialogueShot],
  'stereo',
  timelineRule,
);
assert.match(
  scoldingDialoguePrompt,
  /；台词：第\d+(?:\.\d+)?s @素纱女子："卑鄙"；音效：/u,
  'speech verbs such as “骂了句” must move quoted speech into the dialogue field',
);
assert.doesNotMatch(
  scoldingDialoguePrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '',
  /骂了句卑鄙/u,
  'recognized dialogue must not be flattened back into the visible action chain',
);

const connectorStuffedShot = {
  ...multiDialogueShot,
  id: 'shot_connector_stuffed_prose',
  startSec: 0,
  endSec: 3,
  subject: '蛇妖',
  action: '蛇妖跌坐在地，捆仙绳缠住腰间，绳结越收越紧，翠衣女子挣动，小腿青鳞乍现，素纱女子咬唇望来，眼中竖瞳一闪。',
};
const connectorStuffedPrompt = renderShotPrompt(
  connectorStuffedShot,
  3,
  [],
  [connectorStuffedShot],
  'stereo',
  timelineRule,
);
const connectorStuffedValidation = validateStoryboardPrompt({
  durationSec: 3,
  workflow: 'drama',
  inputMode: 'text',
  shots: [connectorStuffedShot],
  finalPrompt: connectorStuffedPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule);
assert.equal(
  connectorStuffedValidation.valid,
  true,
  'word counts, clause counts, and connector words are generation guidance, not deterministic rejection rules',
);
assert.doesNotMatch(
  connectorStuffedValidation.errors.join('\n'),
  /生硬拼接|动作阶段.*子句|信息量.*时长/u,
  'do not turn subjective action density into a hard validation error',
);

const strictNoopValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: multiDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule, {
  strictConversion: true,
  previousFinalPrompt: multiDialoguePrompt,
});
assert.equal(strictNoopValidation.valid, true);
assert.doesNotMatch(
  strictNoopValidation.errors.join('\n'),
  /no-op|完全相同|没有实质改写/u,
  'already valid video descriptions may be preserved without forced lexical rewriting',
);
const chineseQuoteDialoguePrompt = multiDialoguePrompt.replace(/"([^"\n]+)"/gu, '“$1”');
const chineseQuoteDialogueValidation = validateStoryboardPrompt({
  durationSec: 15, workflow: 'drama', inputMode: 'text', shots: [multiDialogueShot], finalPrompt: chineseQuoteDialoguePrompt, ruleSetId: timelineRule.id,
}, [], timelineRule, { strictConversion: true });
assert.equal(chineseQuoteDialogueValidation.valid, true, `the shared converter example's Chinese dialogue quotes are valid, not missing or rewritten speech: ${chineseQuoteDialogueValidation.errors.join('；')}`);

const strictMissingDialogueValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: missingSecondDialoguePrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule, {
  strictConversion: true,
  previousFinalPrompt: multiDialoguePrompt,
});
assert.equal(strictMissingDialogueValidation.valid, true);
assert.deepEqual(
  strictMissingDialogueValidation.errors,
  [],
  'the legacy strictConversion option must not reintroduce a local semantic gate',
);

for (const authoredBy of [undefined, 'text-api'] as const) {
  const semanticShot = { ...multiDialogueShot, authoredBy };
  const semanticPrompt = missingSecondDialoguePrompt
    .replace(/主体：@[^（；\s]+/u, '主体：@我')
    .replace(/正在 \[[^\]]+\]/u, '正在 [我查看项目资料与H3指示灯→我看见屏幕显示CONVERSION_REJECTED：未检测到故障]');
  const semanticBoard = {
    durationSec: 15, workflow: 'drama' as const, inputMode: 'text' as const,
    shots: [semanticShot], finalPrompt: semanticPrompt, ruleSetId: timelineRule.id,
  };
  const snapshot = JSON.stringify(semanticBoard);
  const report = validateStoryboardPrompt(semanticBoard, [], timelineRule, { strictConversion: true });
  assert.deepEqual(report, { valid: true, errors: [], warnings: [] }, `${authoredBy || 'legacy/manual'} content must have no local semantic error or advisory`);
  assert.equal(JSON.stringify(semanticBoard), snapshot, 'technical validation must not rewrite authored content');
  assert.equal(needsTimelinePromptMigration(semanticPrompt, timelineRule, [semanticShot]), false);
  const missingFieldReport = validateStoryboardPrompt({
    ...semanticBoard,
    finalPrompt: semanticPrompt.replace('；光影：', '；未绑定字段：'),
  }, [], timelineRule);
  assert.equal(missingFieldReport.valid, false, 'required editable field structure is still checked');
  const invalidTimeReport = validateStoryboardPrompt({
    ...semanticBoard,
    durationSec: Number.NaN,
  }, [], timelineRule);
  assert.ok(invalidTimeReport.errors.includes('目标时长无效。'));
}

const strictCopiedActionValidation = validateStoryboardPrompt({
  durationSec: 3,
  workflow: 'drama',
  inputMode: 'text',
  shots: [connectorStuffedShot],
  finalPrompt: connectorStuffedPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule, {
  strictConversion: true,
  previousFinalPrompt: connectorStuffedPrompt.replace('蛇妖跌坐在地', '蛇妖保持原位'),
});
assert.equal(strictCopiedActionValidation.valid, true);
assert.doesNotMatch(
  strictCopiedActionValidation.errors.join('\n'),
  /照搬 sourceExcerpt|未转换/u,
  'valid actions are not rejected by a local source-copy similarity heuristic',
);

const shortCopiedShot = {
  ...multiDialogueShot,
  id: 'shot_short_source_copy',
  startSec: 0,
  endSec: 5,
  subject: '少女',
  action: '少女推开木门，抬头看见来客。',
};
const shortCopiedBasePrompt = renderShotPrompt(
  shortCopiedShot,
  5,
  [],
  [shortCopiedShot],
  'stereo',
  timelineRule,
);
const shortCopiedPrompt = shortCopiedBasePrompt.replace(
  /正在 \[[^\]]+\]/u,
  '正在 [少女推开木门，抬头看见来客]',
);
const strictShortCopiedActionValidation = validateStoryboardPrompt({
  durationSec: 5,
  workflow: 'drama',
  inputMode: 'text',
  shots: [shortCopiedShot],
  finalPrompt: shortCopiedPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule, {
  strictConversion: true,
  previousFinalPrompt: shortCopiedPrompt.replace(
    '少女推开木门，抬头看见来客',
    '少女握住门环→目光停在来客脸上',
  ),
});
assert.equal(strictShortCopiedActionValidation.valid, true);
assert.doesNotMatch(
  strictShortCopiedActionValidation.errors.join('\n'),
  /照搬 sourceExcerpt|未转换/u,
  'an accurate short visible action may remain unchanged',
);

const naturalDescriptionPrompt = shortCopiedBasePrompt
  .replace(/正在 \[[^\]]+\]/u, '正在 [少女压下门把手，手腕顺着门把的弧度缓缓转动→推开木门，另一只手扶着门边，给来客留出通过的位置→侧身站到门内，衣摆随着身体移动，目光自然跟随来客→抬手示意来客进入，随后视线落在来客脸上，表情由警觉变得平和]')
  .replace(/空间：[^；]*/u, '空间：少女站在门内，来客停在门槛外，两人之间留有自然交谈距离')
  .replace(/光影：[^；]*/u, '光影：窗外柔和日光照亮侧脸，屋内阴影自然过渡');
const naturalDescriptionValidation = validateStoryboardPrompt({
  durationSec: 5, workflow: 'drama', inputMode: 'text', shots: [shortCopiedShot], finalPrompt: naturalDescriptionPrompt, ruleSetId: timelineRule.id,
}, [], timelineRule, { strictConversion: true, previousFinalPrompt: naturalDescriptionPrompt });
assert.equal(naturalDescriptionValidation.valid, true, `natural staging and light without forced K values, spatial layers, stage/character budgets, or lexical rewrites must remain valid: ${naturalDescriptionValidation.errors.join('；')}`);
assert.equal(naturalDescriptionValidation.warnings.length, 0);

const strictShiftedTimestampPrompt = multiDialoguePrompt.replace(
  /^【0s-15\.00s】/u,
  '【0s-14.99s】',
);
const strictShiftedTimestampValidation = validateStoryboardPrompt({
  durationSec: 15,
  workflow: 'drama',
  inputMode: 'text',
  shots: [multiDialogueShot],
  finalPrompt: strictShiftedTimestampPrompt,
  ruleSetId: timelineRule.id,
}, [], timelineRule, {
  strictConversion: true,
  previousFinalPrompt: multiDialoguePrompt,
});
assert.equal(strictShiftedTimestampValidation.valid, false);
assert.match(
  strictShiftedTimestampValidation.errors.join('\n'),
  /时间边界必须与分镜卡片精确一致|最后一镜没有准确结束/u,
  'strict conversion must preserve every exact local shot boundary',
);

const runPromptEdgeCase = (_id: string, verify: () => void): void => verify();

const astronomyAnalysisScene: Scene = {
  ...scene,
  id: 'scene_astronomy_analysis',
  title: '山顶天文台',
  content: '天文台通过卫星分析出了彗星可能出现的位置。',
  summary: '天文台完成彗星位置分析。',
  characterIds: [],
};
const astronomyAnalysisShots = buildShots({
  scene: astronomyAnalysisScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 6,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '稳定推轨展示观测证据',
  lighting: '夜间蓝色仪器光',
  style,
  extra: '',
});
const astronomyAnalysisPrompt = renderFinalPrompt({
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: astronomyAnalysisScene,
  globalLock: '',
  shots: astronomyAnalysisShots,
  assets: [],
  style,
  ruleSet: timelineRule,
  converter,
  extra: '',
  characters: [],
  locations: [],
  props: [],
});
runPromptEdgeCase('analysis', () => {
  assert.match(
    astronomyAnalysisPrompt,
    /主体：@天文台(?:观测系统)?/u,
    'a remote-analysis shot must retain its explicit performing institution',
  );
  for (const evidence of ['卫星', '彗星', '位置']) {
    assert.match(
      astronomyAnalysisPrompt,
      new RegExp(evidence, 'u'),
      `a remote-analysis shot must retain the explicit ${evidence} evidence`,
    );
  }
  assert.doesNotMatch(
    astronomyAnalysisPrompt,
    /战区|孢子云|生物研究所/u,
    'generic analysis visualisation must not inject details from another story',
  );
});

const staleDeclaredActorShot = {
  ...shots[0],
  id: 'shot_stale_declared_actor',
  index: 1,
  startSec: 0,
  endSec: 6,
  subject: '阿青',
  action: '李云抬头望向窗外。',
  referenceAssetIds: sharedMultiCharacterAssetIds,
};
const staleDeclaredActorPrompt = renderShotPrompt(
  staleDeclaredActorShot,
  6,
  multiCharacterAssets,
  [staleDeclaredActorShot],
  'stereo',
  timelineRule,
  { characters: multiReferenceCharacters },
);
const objectMentionActorShot = {
  ...staleDeclaredActorShot,
  id: 'shot_object_mention_actor',
  action: '阿青抬头望向李云。',
};
const objectMentionActorPrompt = renderShotPrompt(
  objectMentionActorShot,
  6,
  multiCharacterAssets,
  [objectMentionActorShot],
  'stereo',
  timelineRule,
  { characters: multiReferenceCharacters },
);
runPromptEdgeCase('actor', () => {
  assert.match(
    staleDeclaredActorPrompt,
    /主体：@李云/u,
    'an explicit local actor must replace a stale declared shot subject',
  );
  assert.match(
    objectMentionActorPrompt,
    /主体：@阿青/u,
    'a named object of a visible action must not replace the action performer',
  );
});

const directedQuantityCharacters: Character[] = [
  { ...multiReferenceCharacters[0], id: 'character-directed-enemy', name: '敌人', race: '人类', appearance: '一群敌对战士' },
  { ...multiReferenceCharacters[1], id: 'character-directed-target', name: '夏提雅', race: '吸血鬼', appearance: '白发红瞳的女武神形态战士' },
];
const directedQuantityShot = {
  ...shots[0],
  id: 'shot_directed_quantity_actor',
  index: 1,
  startSec: 0,
  endSec: 6,
  subject: '夏提雅',
  action: '一群敌人从远处冲向夏提雅，夏提雅站在前方石台上',
  space: '敌人在后景向前景收敛，夏提雅在前方石台上清晰可见',
  direction: '敌人面向夏提雅，摄影机不在冲锋终点',
  camera: '低机位侧后方沿敌人指向夏提雅的运动轴拍摄',
  result: '敌人抵达夏提雅前方',
  referenceAssetIds: [],
};
const directedQuantityPrompt = renderShotPrompt(
  directedQuantityShot,
  6,
  [],
  [directedQuantityShot],
  'stereo',
  timelineRule,
  { characters: directedQuantityCharacters },
);
runPromptEdgeCase('directed actor-target quantity relation', () => {
  assert.match(directedQuantityPrompt, /主体：@敌人/u, 'quantity-bearing actor should replace a stale target subject');
  assert.match(directedQuantityPrompt, /面朝夏提雅/u, 'direction must name the action target');
  assert.match(directedQuantityPrompt, /定向动作关系：敌人从动作起点向夏提雅收敛/u, 'space must retain the actor-target endpoint');
  assert.doesNotMatch(directedQuantityPrompt, /面朝画面纵深/u, 'directed actions must not fall back to generic depth direction');
});

const orphanClosingVisibleLabelShot = {
  ...shots[0],
  id: 'shot_orphan_closing_visible_label',
  index: 1,
  startSec: 0,
  endSec: 6,
  subject: '守卫',
  action: '门牌上写着安全出口”，守卫推开木门。',
  referenceAssetIds: [],
};
const orphanClosingVisibleLabelPrompt = renderShotPrompt(
  orphanClosingVisibleLabelShot,
  6,
  [],
  [orphanClosingVisibleLabelShot],
  'stereo',
  timelineRule,
);
runPromptEdgeCase('orphan-quote', () => {
  const renderedAction = orphanClosingVisibleLabelPrompt.match(/正在 \[([^\]]+)\]/u)?.[1] || '';
  assert.match(
    renderedAction,
    /门牌.*安全出口/u,
    'an orphan closer must not delete visible sign information before it',
  );
  assert.match(renderedAction, /守卫推开木门/u);
  assert.doesNotMatch(renderedAction, /[“”"'‘’「」『』]/u);
});

const targetlessKineticCharacter: Character = {
  ...kineticHuman,
  id: 'char_targetless_runner',
  name: '林岚',
};
const targetlessKineticScene: Scene = {
  ...kineticHumanScene,
  id: 'scene_targetless_runner',
  title: '操场',
  content: '林岚独自在操场上奔跑。',
  summary: '林岚沿操场跑道奔跑。',
  characterIds: [targetlessKineticCharacter.id],
};
const targetlessKineticShots = buildShots({
  scene: targetlessKineticScene,
  characters: [targetlessKineticCharacter],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 5,
  pace: 'standard',
  camera: '侧向稳定跟拍',
  lighting: '日间自然光',
  style,
  extra: '',
});
runPromptEdgeCase('kinetic-target', () => {
  const actions = targetlessKineticShots.map((shot) => shot.action).join('\n');
  assert.doesNotMatch(
    actions,
    /动作目标/u,
    'targetless kinetic expansion must never expose an internal placeholder',
  );
  assert.match(
    actions,
    /画面纵深|跑道|地面接触点|前方/u,
    'targetless running must use a concrete visible direction or contact point',
  );
});

const ordinaryHeadRaiseShot = {
  ...shots[0],
  id: 'sound-ordinary-head-raise',
  index: 1,
  startSec: 0,
  endSec: 2,
  subject: '旅人',
  action: '旅人缓慢抬头看向瀑布',
  sound: '',
  lighting: '瀑布下游的阴天散射光',
};
const ordinaryHeadRaisePrompt = renderShotPrompt(
  ordinaryHeadRaiseShot,
  2,
  [],
  [ordinaryHeadRaiseShot],
  'stereo',
  timelineRule,
);
assert.match(ordinaryHeadRaisePrompt, /环境层-\[无\]/u, 'a waterfall mentioned visually must not automatically create an ambient sound bed');
assert.match(ordinaryHeadRaisePrompt, /动作层-\[无\]/u, 'ordinary head raises and looks must not invent foley');
assert.doesNotMatch(ordinaryHeadRaisePrompt, /衣物|呼吸/u, 'ordinary posture changes must not automatically add cloth or breathing sounds');

const walkingAndContactShot = {
  ...ordinaryHeadRaiseShot,
  id: 'sound-walking-contact',
  endSec: 4,
  action: '旅人沿湿石径快步走向木桥，伸手扶住摇晃的桥栏',
};
const walkingAndContactPrompt = renderShotPrompt(
  walkingAndContactShot,
  4,
  [],
  [walkingAndContactShot],
  'stereo',
  timelineRule,
);
assert.match(walkingAndContactPrompt, /动作层-\[脚步声\]/u, 'walking retains necessary footsteps without inventing a collision for holding a railing');

const positiveOnlyPrivateImagePrompt = buildImagePrompt('character', {
  name: '阿莲',
  gender: '成年女性；女',
  race: '人类',
  appearance: '年龄设定：二十五岁，乌黑长发；肤色白皙；禁止改变发色',
  nsfwFullBody: '年龄为二十五岁，身形比例稳定；全身肤色均匀；负面提示词：衣物，水印；不要生成服装',
}, 'private-full-body', 'full-body');
assert.match(positiveOnlyPrivateImagePrompt, /乌黑长发|肤色白皙|身形比例稳定|全身肤色均匀/u);
assert.ok(positiveOnlyPrivateImagePrompt.includes(BODY_PROPORTION_STABILITY_RULE),
  'the existing optical proportion rule is preserved without changing NSFW profile facts');
assert.doesNotMatch(
  // Optical framing guidance was added by the existing body-proportion fix;
  // profile sanitization must not confuse its lens exclusions with user facts.
  positiveOnlyPrivateImagePrompt.replace(BODY_PROPORTION_STABILITY_RULE, ''),
  /年龄|岁|成年|未成年|\badult\b|\bminor\b|\bchild\b|\bteen\b|禁止|不得|不要|不能|不可|严禁|避免|排除|负面|negative/iu,
  'private image source must contain only positive visual facts for local models',
);

console.log('structured timeline prompt regression checks passed');
