import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { requestStoryboardImageFramePlan } from '../src/storyboardImagePlan';
import { adoptedVideoExpressionForBoard, ADOPTED_VIDEO_EXPRESSION_RULE } from '../src/videoCreativeDirection';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE, VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE, VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE } from '../src/videoActionChoreographyRules';
import { hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import type { Character, ConverterPreset, ReferenceAsset, Storyboard, VideoShot } from '../src/types';
import type { SceneStaging } from '../src/sceneStaging';

// In-memory model replies only: no provider calls or user project changes.
const scene: SceneStaging = { version: 1, sceneId: 'courtyard',
  participants: [{ id: 'lin', name: '林舟', bodyFacing: '陈月', gazeTarget: '陈月', actionTarget: '门边' }],
  phases: [{ id: 'retreat', startState: '两人相对站立', action: '林舟仍面对陈月后退',
    motionPath: '从陈月面前沿来路后退', motionEndpoint: '门边', endState: '林舟停在门边仍面对陈月' }] };
const source = '林舟仍面对陈月后退到门边，陈月留在庭院。';
const camera = '庭院东侧固定中远景，只见林舟侧面与门边退路';
const canonical = `【0s-15s】 主体：@林舟[朝向：陈月] 正在 [${source}]（保持交谈朝向）` +
  `；空间：陈月留在庭院，林舟沿来路退至门边；光影：庭院日光；镜头：${camera}；台词：无；音效：环境层-[无] 动作层-[脚步] 情绪层-[无配乐]`;
const hero: Character = { id: 'lin', name: '林舟', gender: '男', apparentAge: '成年', race: '人类', appearance: '黑发',
  outfit: '灰外套', signatureProps: '', anchor: '左眉浅疤', personality: 'RAW_PERSONALITY',
  motionHabits: 'RAW_MOTION_HABITS', negativeContinuity: '', assetIds: [] };
const shot: VideoShot = { id: 'retreat-shot', index: 1, startSec: 0, endSec: 15, purpose: '退到门边', subject: '林舟与陈月',
  action: source, camera, transition: '保持同一侧', lighting: '庭院日光', sound: '脚步', result: '停在门边仍面对陈月',
  space: '陈月留在庭院，门边位于林舟来路', direction: '身体面对陈月，位移终点为门边',
  sceneStaging: [scene],
  referenceAssetIds: [], prompt: canonical, locked: false };
const converter: ConverterPreset = { id: 'expression', name: '表达', workflow: 'all', inputMode: 'all', scope: 'video',
  enabled: true, version: 'test', systemPrompt: '保留当前镜头。', outputRules: '逐镜六字段。', updatedAt: 1 };
const refs: ReferenceAsset[] = ['first-frame', 'last-frame', 'composition'].map((role, index) => ({
  id: `ref-${index}`, name: `合成参考${index}`, type: 'reference', mediaType: 'image',
  role: role as ReferenceAsset['role'], referenceRole: role as ReferenceAsset['referenceRole'],
  source: 'upload', tags: [], createdAt: 1, updatedAt: 1,
}));
const board = (ids: string[]): Storyboard => ({
  id: 'adopted-board', sceneId: 'courtyard', sourceStoryTitle: '后退', sourceStoryContent: source,
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'unused-style',
  ruleSetId: 'rule', converterPresetId: converter.id, directorStyleSummary: 'RAW_DIRECTOR_SLOGAN',
  visualStyle: 'RAW_VISUAL_SLOGAN', extraRequirement: 'RAW_UNAPPLIED_REQUIREMENT',
  globalLock: '庭院地标不变', globalReferenceAssetIds: ids, sceneStaging: [scene], shots: [structuredClone(shot)],
  finalPrompt: canonical, createdAt: 1, updatedAt: 1,
});
const envelope = (text: string, tag: string) => JSON.parse(text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))![1]);
const h3 = (full: boolean, english = false) => [
  ...(full ? ['subject_definitions:', '<Subject 1> is 林舟; <Picture 1> is a composition reference.',
    'summary:', 'The same courtyard retreat.', 'retention_analysis:', 'Retain identity only.'] : []),
  full ? 'detailed_description:' : 'integrated_multimodal_description:',
  `[Shot 1] ${english ? 'From the fixed east-side camera, 林舟 walks backward to the doorway while his chest and gaze remain toward 陈月. Only his side is visible.' : '从庭院东侧固定机位观察，林舟仍面向陈月后退至门边，身体不向摄影机转动，只见侧面。'}`,
  'overall_soundscape:', 'N/A', 'non_diegetic_music:', 'N/A',
].join('\n');

const deliveries: Storyboard[] = [];
for (const [ids, mode] of [[[], 'base'], [['ref-0', 'ref-1'], 'keyframe'], [['ref-0', 'ref-1', 'ref-2'], 'full-reference']] as const) {
  const initial = board([...ids]);
  const before = structuredClone(initial);
  const context = { assets: refs, characters: [hero] };
  const stages: string[] = [];
  const full = mode === 'full-reference';
  const result = await generateSingleSegmentPrompt({ board: initial, context, converter, reviewWithAi: true,
    clean: (value) => value.trim(), now: () => 10,
    request: async (system, user, stage) => {
      stages.push(stage);
      assert.ok(system.includes(stage === 'translate' ? VIDEO_ACTION_CHOREOGRAPHY_TRANSLATION_RULE : ADOPTED_VIDEO_EXPRESSION_RULE));
      assert.doesNotMatch(user, /RAW_DIRECTOR_SLOGAN|RAW_VISUAL_SLOGAN|RAW_UNAPPLIED_REQUIREMENT|RAW_PERSONALITY|RAW_MOTION_HABITS/u);
      if (stage === 'convert') {
        const data = envelope(user, 'video_conversion_data');
        assert.deepEqual(data.sceneStaging, [scene]);
        assert.equal(data.shotEvidence[0].plannedCamera, camera);
        assert.equal(data.adoptedVisualExpression[0].camera, camera);
        assert.equal(Object.hasOwn(data, 'creativeDirection'), false);
        assert.ok(system.includes(VIDEO_ACTION_CHOREOGRAPHY_PRESERVATION_RULE));
        assert.equal(system.includes(VIDEO_ACTION_CHOREOGRAPHY_RULE), false);
        return canonical;
      }
      if (stage === 'review') {
        const data = envelope(user, 'video_staging_review_data');
        assert.equal(data.deliveryMediaMode, mode);
        assert.equal(data.candidatePrompt, '', 'new H3 body is authored by this existing model call');
        assert.deepEqual(data.sceneStaging, [scene]);
        assert.deepEqual(data.shots[0].sceneStaging, [scene], 'shot-scoped scene choices survive the downstream projection');
        assert.equal(data.characterIdentityFacts[0].anchor, hero.anchor, 'identity traits remain intact data');
        assert.equal(Object.hasOwn(data.characterIdentityFacts[0], 'motionHabits'), false);
        assert.match(system, full ? /本次必须由你交付六个官方章节/u : /本次使用三个官方章节/u);
      }
      return JSON.stringify({ h3Prompt: h3(full, stage === 'translate'), identityBindings: { version: 1, characters: [] },
        characterParticipation: { version: 1, characters: [] } });
    },
  });
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate'], 'keep the existing conversion/delivery/translation calls');
  assert.equal(result.officialPromptZh, h3(full), 'do not locally rewrite model-authored H3');
  assert.equal(result.officialPromptEn, h3(full, true));
  assert.equal(result.officialPromptEnError, '');
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  assert.deepEqual(initial, before);
  assert.deepEqual(result.sceneStaging, [scene]);
  deliveries.push(result);
}

// Changing actual pictures invalidates the complete reference fingerprint,
// but the same canonical source still permits a narrow reference update.
const refreshedSource = { ...structuredClone(deliveries[0]), globalReferenceAssetIds: refs.map((asset) => asset.id) };
const referenceContext = { assets: refs, characters: [hero] };
assert.equal(hasCurrentOfficialH3Prompt(refreshedSource, referenceContext), false);
const refreshedBefore = structuredClone(refreshedSource);
const refreshStages: string[] = [];
const refreshed = await generateSingleSegmentPrompt({ board: refreshedSource, context: referenceContext,
  purpose: 'reference-refresh', skipConversion: true, reviewWithAi: true, clean: (value) => value.trim(),
  request: async (_system, user, stage) => {
    refreshStages.push(stage);
    if (stage === 'review') {
      const data = envelope(user, 'video_staging_review_data');
      assert.equal(data.candidatePrompt, deliveries[0].officialPromptZh, 'keep the existing AI text when only reference identity changed');
      assert.equal(data.deliveryMediaMode, 'full-reference');
      assert.deepEqual(data.shots[0].sceneStaging, [scene]);
    }
    return JSON.stringify({ h3Prompt: h3(true, stage === 'translate'), identityBindings: { version: 1, characters: [] },
      characterParticipation: { version: 1, characters: [] } });
  } });
assert.deepEqual(refreshStages, ['review', 'translate', 'translate']);
assert.equal(refreshed.officialPromptZh, h3(true));
assert.deepEqual(refreshedSource, refreshedBefore);

const editedCanonical = { ...structuredClone(refreshedSource), finalPrompt: canonical.replace('后退到门边', '停留在庭院') };
const editStages: string[] = [];
await generateSingleSegmentPrompt({ board: editedCanonical, context: referenceContext, converter,
  purpose: 'reference-refresh', reviewWithAi: true, clean: (value) => value.trim(),
  request: async (_system, user, stage) => {
    editStages.push(stage);
    if (stage === 'convert') return editedCanonical.finalPrompt;
    if (stage === 'review') {
      const data = envelope(user, 'video_staging_review_data');
      assert.equal(data.candidatePrompt, '', 'a changed canonical source cannot reuse the prior AI text as current');
      assert.equal(data.canonicalPrompt, editedCanonical.finalPrompt);
    }
    return JSON.stringify({ h3Prompt: h3(true, stage === 'translate'), identityBindings: { version: 1, characters: [] },
      characterParticipation: { version: 1, characters: [] } });
  } });
assert.deepEqual(editStages, ['convert', 'review', 'translate', 'translate']);

const imageBoard = board([]);
const projection = adoptedVideoExpressionForBoard(imageBoard);
projection.sceneStaging![0].participants![0].bodyFacing = '副本';
assert.deepEqual(imageBoard.sceneStaging, [scene]);
let imagePlanCalls = 0;
const frames = await requestStoryboardImageFramePlan({ storyboard: imageBoard, count: 1,
  request: async (_system, user) => {
    imagePlanCalls += 1;
    const { source: data } = JSON.parse(user);
    assert.equal(data.contentSource, 'canonical-shot-plan');
    assert.deepEqual(data.sceneStaging, [scene]);
    assert.equal(data.adoptedVisualExpression[0].camera, camera);
    assert.equal(Object.hasOwn(data, 'visualStyle'), false);
    assert.equal(Object.hasOwn(data, 'extraRequirement'), false);
    return JSON.stringify({ frames: [{ sourceShotId: shot.id, description: '林舟侧身仍面对陈月，已退到门边。', timeSec: 14 }] });
  } });
assert.equal(imagePlanCalls, 1);
assert.equal(frames[0].sourceShotId, shot.id);
const confirmedImageBoard = { ...imageBoard, officialPromptZh: h3(false) };
await requestStoryboardImageFramePlan({ storyboard: confirmedImageBoard, count: 1,
  request: async (_system, user) => {
    const { source: data } = JSON.parse(user);
    assert.equal(data.contentSource, 'confirmed-h3');
    assert.deepEqual(data.shots, [{ id: shot.id, index: 1, startSec: 0, endSec: 15 }]);
    assert.ok(data.confirmedH3.shots[0].includes('身体不向摄影机转动'));
    for (const key of ['canonicalPrompt', 'promptPlan', 'officialPromptZh', 'sourceStoryContent', 'sceneStaging', 'adoptedVisualExpression']) {
      assert.equal(Object.hasOwn(data, key), false, `${key} cannot compete with current H3 staging`);
    }
    return JSON.stringify({ frames: [{ sourceShotId: shot.id, description: '采用当前H3中的侧面观察。', timeSec: 14 }] });
  } });
console.log('PASS adopted expression: facing/path/camera survive conversion, actual H3 media formats and still planning without re-directing or extra calls.');
