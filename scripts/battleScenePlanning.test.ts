import assert from 'node:assert/strict';
import { normalizeBattleSceneStaging, normalizeBattleSceneStagingList, type BattleSceneStaging } from '../src/battleScenePlanning';
import { normalizeStoryVisualParagraphs, type StoryVisualParagraph } from '../src/storyVisualAction';
import {
  copySemanticSequencePlanningInput, materializeSemanticSequencePlan, normalizeSemanticSegmentSource,
  normalizeStoryVisualConversionSnapshot, parseSemanticSequenceResponse, semanticSegmentSourceContext,
  semanticSequenceSourceFingerprint, type SemanticSequencePlanningInput,
} from '../src/semanticSequencePlan';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { rememberStoryVisualConversion, matchingStoryVisualConversion } from '../src/storyVisualConversion';
import type { StoryVisualConversionSnapshot } from '../src/types';

// Synthetic in-memory sources only. No saved projects, providers or credentials.
const source = '守卫挥枪迎击冲锋者，首排被击退。队长喊：“继续前进！”';
const body = '守卫转身迎住首排冲锋者，枪杆接触后首排向后踉跄，后排从空隙补进。队长喊：“继续前进！”';
const staging: BattleSceneStaging = {
  version: 1, sceneType: '拒止冲锋的持续接触', sourceEventIds: ['e-contact'],
  factLocks: ['守卫使用长枪', '首排被击退，冲锋仍继续'], stagingChoices: ['后排从首排让出的空隙补进'],
  actionGroups: [
    { id: 'guard', participants: ['守卫'], role: '迎击', spatialLayer: '近景接触线', route: '沿接触线转身', objective: '阻止推进' },
    { id: 'charge', participants: ['冲锋者'], role: '推进', spatialLayer: '中景队列延续至纵深', route: '向接触线持续推进', objective: '突破' },
  ],
  actionPhases: [{ id: 'contact-1', sourceEventId: 'e-contact', groupIds: ['guard', 'charge'], actor: '守卫', target: '首排冲锋者',
    setup: '重心转向来敌', trigger: '首排进入长枪接触范围', contact: '枪杆接触首排', result: '首排向后踉跄', recovery: '后排补入，守卫继续迎击' }],
  dialogueBudget: { strategy: '队长在队列推进时喊话', parallelToAction: true, speechDurationSec: 2.6, actionDurationSec: 8.4,
    preserveDialogueIds: ['d-order'] }, entryState: '首排即将接触', exitState: '首排退开，后排尚在推进',
};
const paragraph: StoryVisualParagraph = { id: 'v-contact', sourceParagraphIds: ['p1'], eventIds: ['e-contact'], text: body,
  stagingAdditions: ['后排补进的可见路径'], battleStaging: staging };
const state = createInitialState();
const chapterId = state.project.sourceDocuments[0].id;
const original: StoryVisualConversionSnapshot = { id: 'synthetic-battle-conversion', chapterId, sourceName: '合成动作', sourceText: source,
  resultText: body, createdAt: 20, paragraphs: [paragraph], detailMode: 'detailed' };

assert.deepEqual(normalizeBattleSceneStaging(staging), staging);
const copy = normalizeBattleSceneStaging(staging)!;
copy.actionGroups![0].participants!.push('副本人物');
copy.actionPhases![0].groupIds!.push('副本分组');
copy.dialogueBudget!.preserveDialogueIds!.push('副本对白');
assert.deepEqual(staging.actionGroups![0].participants, ['守卫']);
assert.deepEqual(staging.actionPhases![0].groupIds, ['guard', 'charge']);
assert.deepEqual(staging.dialogueBudget!.preserveDialogueIds, ['d-order']);

const filtered = normalizeBattleSceneStaging({ version: 1, sceneType: '任意模型分类，不按关键词判定', factLocks: ['有效', 12],
  actionGroups: [{ id: 'free', spatialLayer: '模型选择层次', participants: ['甲', false] }, null, { participants: ['不补造ID'] }],
  actionPhases: [{ id: 'phase', setup: '无需完整六阶段', contact: 23 }, false],
  dialogueBudget: { speechDurationSec: Number.POSITIVE_INFINITY, actionDurationSec: -1, parallelToAction: false }, hidden: '不保留未知字段' });
assert.deepEqual(filtered, { version: 1, sceneType: '任意模型分类，不按关键词判定', factLocks: ['有效'],
  actionGroups: [{ id: 'free', spatialLayer: '模型选择层次', participants: ['甲'] }],
  actionPhases: [{ id: 'phase', setup: '无需完整六阶段' }], dialogueBudget: { parallelToAction: false } });
assert.equal(normalizeBattleSceneStaging({ version: 2, sceneType: '未来结构' }), undefined);
assert.deepEqual(normalizeBattleSceneStagingList([null, staging, false]), [staging]);
assert.equal(Object.hasOwn(normalizeBattleSceneStaging({ version: 1, dialogueBudget: { strategy: '无对白' } })!.dialogueBudget!, 'preserveDialogueIds'), false);
assert.deepEqual(normalizeStoryVisualParagraphs([paragraph]), [paragraph]);

state.project = rememberStoryVisualConversion(state.project, original);
state.projects = [state.project];
assert.notEqual(state.project.storyVisualConversions![0].paragraphs![0].battleStaging, staging,
  'adoption owns a deep snapshot instead of borrowing mutable preview staging');
const request: SemanticSequencePlanningInput = { title: '合成编排分段', story: body, segmentDurationSec: 15,
  directorSettingsFingerprint: 'synthetic-staging-v1', creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
  originalSourceContext: matchingStoryVisualConversion(state.project, chapterId, body) };
const frozen = copySemanticSequencePlanningInput(request);
assert.deepEqual(frozen.originalSourceContext?.paragraphs?.[0].battleStaging, staging);
assert.notEqual(frozen.originalSourceContext?.paragraphs?.[0].battleStaging, staging);
const semanticSource = { sourceEvidence: [{ text: body }], events: [{ id: 'e-contact', description: '首排被击退，后排继续推进', phase: '接触后的补进' }],
  dialogues: [{ id: 'd-order', speaker: '队长', text: '继续前进！' }], battleStaging: [staging] };
const response = parseSemanticSequenceResponse(JSON.stringify({ reason: '完整动作及并行对白安排', fitStatus: 'balanced', segments: [{
  title: '接触线', content: body, summary: '首排被击退', narrativePurpose: '表现持续推进', entryState: staging.entryState,
  exitState: staging.exitState, transitionHint: '继续补进', boundaryReason: '首排退开后的连续阶段', continuityPack: '后排仍向前，不能重播首排接触', semanticSource,
}] }), frozen);
assert.deepEqual(response.segments[0].semanticSource, semanticSource, 'staging is separate from evidence, event facts and dialogue');
assert.deepEqual(normalizeSemanticSegmentSource({ ...semanticSource, battleStaging: [false, { version: '1' }] }),
  { sourceEvidence: semanticSource.sourceEvidence, events: semanticSource.events, dialogues: semanticSource.dialogues },
  'malformed optional staging cannot discard valid old semantic source');
const plan = materializeSemanticSequencePlan(frozen, response, { planId: 'synthetic-battle-plan', now: 30 });
state.project.sequencePlans = [plan];
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
const restoredOriginal = matchingStoryVisualConversion(restored.project, chapterId, body)!;
assert.deepEqual(restoredOriginal, original, 'adopted source and nested staging survive the real storage round-trip');
const restoredPlan = restored.project.sequencePlans[0];
assert.deepEqual(restoredPlan.segments[0].semanticSource, semanticSource);
const context = semanticSegmentSourceContext(restoredPlan, restoredPlan.segments[0]);
assert.deepEqual(context.segment.semanticSource.battleStaging, [staging], 'selected staging reaches the single-segment source context');
assert.deepEqual(context.storyUnderstandingContext?.originalSourceContext?.paragraphs?.[0].battleStaging, staging,
  'full source context retains adopted choreography without turning it into source evidence');
assert.equal(context.storyUnderstandingContext?.usage, 'understanding-only');
context.segment.semanticSource.battleStaging![0].stagingChoices!.push('request-only');
context.storyUnderstandingContext!.originalSourceContext!.paragraphs![0].battleStaging!.factLocks!.push('request-only');
assert.deepEqual(restoredPlan.segments[0].semanticSource?.battleStaging, [staging]);
assert.deepEqual(restoredOriginal.paragraphs?.[0].battleStaging, staging);
const changed = structuredClone(restoredPlan);
changed.segments[0].semanticSource!.battleStaging![0].actionPhases![0].recovery = '修改本次编排';
assert.notEqual(semanticSequenceSourceFingerprint(changed), semanticSequenceSourceFingerprint(restoredPlan));

const oldParagraph = { id: 'v-old', sourceParagraphIds: ['p1'], eventIds: [], text: '普通旧稿。', stagingAdditions: [] };
assert.deepEqual(normalizeStoryVisualParagraphs([oldParagraph]), [oldParagraph], 'old paragraphs gain no invented staging');
const legacyOriginal = { ...original, paragraphs: [oldParagraph] };
assert.deepEqual(normalizeStoryVisualConversionSnapshot(legacyOriginal), legacyOriginal);
const legacySource = { sourceEvidence: [], events: [], dialogues: [] };
assert.deepEqual(normalizeSemanticSegmentSource(legacySource), legacySource, 'old semantic sources remain unchanged');
restoredPlan.segments[0].contentOverridden = true;
restoredPlan.segments[0].content = '用户改成守卫停战。';
const editedContext = semanticSegmentSourceContext(restoredPlan, restoredPlan.segments[0]);
assert.equal(editedContext.contentOverridden, true);
assert.equal(editedContext.generationStoryContent, '用户改成守卫停战。', 'old action metadata cannot reconstruct edited-out prose locally');
console.log('PASS battle scene staging: shape-only copy, adopted-source persistence, semantic segment handoff and legacy compatibility');
