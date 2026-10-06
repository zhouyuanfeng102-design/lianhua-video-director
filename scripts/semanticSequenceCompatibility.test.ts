import assert from 'node:assert/strict';
import {
  buildSequencePromptManifest, buildSequencePromptText, invalidateSequenceSegmentsForMasterPrompt,
  isSequenceSegmentComplete, pendingSequenceSegmentIds, repairSequencePlanResults,
  resolveSequenceSegmentGenerationSource,
} from '../src/appEffects';
import {
  alignSequenceSegmentsToMasterShotBoundaries, assertAiSequenceSegmentShotCoverage,
  linkSegmentStoryboard, lockSequenceSegment, mergeSequenceSegments,
  reconcileSequenceSegmentsToShotProvenance, reorderSequenceSegment, restoreSequenceSegmentSourceContent,
  sequencePlanReviewFingerprint, splitSequenceSegment, updateSequenceSegment, validateAndNormalizeSequencePlan,
} from '../src/sequencePlan';
import {
  materializeSemanticSequencePlan, semanticSequenceCharacters, semanticSequenceSourceFingerprint, semanticSegmentStoryContent,
  type SemanticSequencePlanningInput, type SemanticSequenceResponse,
} from '../src/semanticSequencePlan';
import {
  sequencePlanMasterConfirmationIssue, sequencePlanMasterDirectorSettingsIssue,
  sequencePlanMasterStoryboardIssue, validateSequencePlan,
} from '../src/storySegmentation';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { diagnoseState } from '../src/stateIntegrity';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AppState, Character, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';

// Pure in-memory fixtures only: no user files, credentials, network or paid tasks.
const story = '师傅把药草递给徒弟，说：“拿稳。”徒弟接过药草后转身，朝集市方向前行。';
const input: SemanticSequencePlanningInput = {
  title: '交接与出发', story, segmentDurationSec: 15,
  directorSettingsFingerprint: 'frozen-director-settings',
  creativeDirection: {
    cameraTerms: ['先交代朝向，再顺动作切镜'], lightingTerms: ['自然晨光'],
    extraRequirement: ' 不要更换左右关系；仅保留剧情声音。 ',
  },
  pacing: { pace: 'standard', extraRequirement: '对白自然说完' },
  characterContinuity: [{ name: '师傅', gender: '女性', outfit: '蓝袍' }, { name: '徒弟', gender: '男性' }],
  sourceSceneIds: ['scene-1'], shotMode: 'auto',
};
const response: SemanticSequenceResponse = {
  segmentCount: 2, reason: ' 保留原文因果，AI 选择两个完整交付窗口。 ', fitStatus: 'balanced',
  segments: [
    {
      title: '交付药草', content: 'AI 组织的动作与台词，不是本地原文节拍拼接。', summary: '递药草',
      narrativePurpose: '交付物件', entryState: '师傅握着药草。', exitState: '徒弟已经接住药草。',
      transitionHint: '从交接动作尾部短暂接续', boundaryReason: ' 交接已完成。 ', continuityPack: '保持蓝袍、药草和道路朝向。',
      semanticSource: {
        sourceEvidence: [{ text: '师傅把药草递给徒弟，说：“拿稳。”', sourceStart: 0, sourceEnd: 18 }],
        events: [{ id: 'herb-handoff', description: '把药草交给徒弟', phase: '完成交接' }],
        dialogues: [{ id: 'line-1', speaker: '师傅', text: '拿稳。', language: '中文', continuation: '本段说完' }],
      },
    },
    {
      title: '转身去集市', content: '先承接药草已在徒弟手里的状态，再转身走向集市。', summary: '转身前行',
      narrativePurpose: '朝集市移动', entryState: '药草已经转移到徒弟掌中。', exitState: '徒弟沿道路前行。',
      transitionHint: '保持空间方向', boundaryReason: '', continuityPack: '',
      semanticSource: {
        sourceEvidence: [{ text: '徒弟接过药草后转身，朝集市方向前行。' }],
        events: [{ id: 'herb-handoff', description: '交接动作的结果', phase: '接续结果' }, { id: 'walk', description: '朝集市前行' }],
        dialogues: [],
      },
    },
  ],
};
const makePlan = (): VideoSequencePlan => materializeSemanticSequencePlan(input, response, { planId: 'semantic-plan', now: 100 });
const clone = <T>(value: T): T => structuredClone(value);
let checks = 0;
const test = (name: string, run: () => void) => { run(); checks += 1; console.log(`PASS ${name}`); };

const makeBoard = (plan: VideoSequencePlan, index = 0): Storyboard => {
  const segment = plan.segments[index];
  const prompt = '【0s-15s】主体：师傅与徒弟；镜头：固定中景；动作：交接药草；台词：无；音效：轻微衣料声';
  return {
    id: `board-${segment.id}`, sceneId: '', sourceSceneIds: [], sourceStoryContent: segment.content,
    sourceContentHash: sourceContentHash(segment.content), sequencePlanId: plan.id, segmentId: segment.id,
    workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'auto',
    pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: 'test',
    ruleSetId: 'test', converterPresetId: 'test', globalLock: '', extraRequirement: '',
    shots: [{ id: 'shot-1', index: 1, authoredBy: 'text-api', startSec: 0, endSec: 15, purpose: '交接',
      subject: '师傅与徒弟', action: '交接药草', camera: '固定中景', lighting: '晨光', sound: '衣料声',
      result: '药草已交付', transition: '动作接续', prompt, referenceAssetIds: [], locked: false }],
    finalPrompt: prompt, createdAt: 101, updatedAt: 101,
    promptTrace: { modelRuleSetId: 'test', converterPresetId: 'test', sourceDocumentIds: [], referenceAssetIds: [],
      generatedAt: 101, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(prompt),
      shotRecommendationMode: 'text-api', shotPlanMode: 'ai-complete' },
  };
};

const stateFor = (plan: VideoSequencePlan, storyboards: Storyboard[] = []): AppState => {
  const initial = createInitialState();
  const project = { ...initial.project, id: 'semantic-project', scenes: [], storyboards, sequencePlans: [plan],
    directorSettingsConfirmedFingerprint: 'another-plan-director-settings' };
  return { ...initial, project, projects: [project], activeProjectId: project.id };
};

test('new plans need no master, master confirmation, local beats or literal handoff equality', () => {
  const plan = makePlan();
  assert.deepEqual(validateSequencePlan(plan, { requireMasterStoryboard: true, storyboards: [], directorSettingsFingerprint: 'different-live-ui' }), []);
  assert.equal(sequencePlanMasterStoryboardIssue(plan, []), undefined);
  assert.equal(sequencePlanMasterConfirmationIssue(plan, []), undefined);
  assert.equal(sequencePlanMasterDirectorSettingsIssue(plan, ''), undefined);
  assert.notEqual(plan.segments[1].entryState, plan.segments[0].exitState);
  assert.deepEqual(plan.segments.map((segment) => segment.sourceBeatIds), [[], []]);
  assertAiSequenceSegmentShotCoverage(plan, []);
});

test('semantic character context freezes public facts and only joins same-ID media/private fields', () => {
  const plan = makePlan();
  plan.semanticPlanningSnapshot!.characterContinuity = [{
    id: 'teacher', name: '师傅', baseName: '师傅', formLabel: '原始形态', gender: '女性',
    appearance: '原计划里的黑发', outfit: '原计划里的蓝袍', race: '人类',
  }];
  const live: Character = {
    id: 'teacher', name: '现在被改名的师傅', baseName: '当前身份', formLabel: '当前形态', variantOf: '当前来源',
    transformationType: '当前变换', gender: '当前性别', apparentAge: '当前外观年龄', actualAge: '当前真实年龄',
    height: '当前身高', race: '当前物种', morphology: '当前体型', bodyPlan: '当前身体结构',
    appearance: '现在的白发', outfit: '现在的红袍', signatureProps: '当前道具', personality: '当前性格',
    motionHabits: '当前动作', anchor: '当前锚点', negativeContinuity: '当前连续性', assetIds: ['teacher-reference'],
    nsfwProfile: { fullBody: 'existing-private-fixture', provenance: 'manual', sourceHash: 'private-source' },
    nsfwBodyAnchors: { stableTraits: ['existing-anchor-fixture'], sourceEvidence: 'private-evidence' },
  };
  const before = JSON.stringify({ plan, live });
  const projected = semanticSequenceCharacters(plan, [live]);
  assert.deepEqual(projected[0], {
    id: 'teacher', name: '师傅', baseName: '师傅', formLabel: '原始形态', gender: '女性', apparentAge: '',
    race: '人类', appearance: '原计划里的黑发', outfit: '原计划里的蓝袍', signatureProps: '', personality: '',
    motionHabits: '', anchor: '', negativeContinuity: '', assetIds: ['teacher-reference'],
    nsfwProfile: live.nsfwProfile, nsfwBodyAnchors: live.nsfwBodyAnchors,
  });
  projected[0].assetIds.push('clone-only');
  projected[0].nsfwProfile!.fullBody = 'clone-only';
  projected[0].nsfwBodyAnchors!.stableTraits.push('clone-only');
  assert.equal(JSON.stringify({ plan, live }), before);
  const deletedLive = semanticSequenceCharacters(plan, []);
  assert.equal(deletedLive[0].name, '师傅');
  assert.equal(deletedLive[0].appearance, '原计划里的黑发');
  assert.equal(deletedLive[0].outfit, '原计划里的蓝袍');
  assert.deepEqual(deletedLive[0].assetIds, []);
  assert.equal(deletedLive[0].nsfwProfile, undefined);
  assert.equal(deletedLive[0].nsfwBodyAnchors, undefined);
  assert.deepEqual(validateSequencePlan(plan), []);
});

test('missing snapshot IDs get stable distinct IDs without joining similarly named live records', () => {
  const plan = makePlan();
  plan.semanticPlanningSnapshot!.characterContinuity = [{ name: '同名人物' }, { name: '同名人物', formLabel: '另一形态' }];
  const stranger: Character = {
    id: 'live-other', name: '同名人物', gender: 'live', apparentAge: 'live', race: 'live', appearance: 'live', outfit: 'live',
    signatureProps: 'live', personality: 'live', motionHabits: 'live', anchor: 'live', negativeContinuity: 'live',
    assetIds: ['wrong-person-reference'], nsfwProfile: { fullBody: 'wrong-person-private' },
  };
  const withLive = semanticSequenceCharacters(plan, [stranger]);
  const withoutLive = semanticSequenceCharacters(clone(plan), []);
  assert.deepEqual(withLive, withoutLive);
  assert.notEqual(withLive[0].id, withLive[1].id);
  assert.ok(withLive.every((character) => character.id && character.appearance === '' && character.assetIds.length === 0));
  assert.ok(withLive.every((character) => character.nsfwProfile === undefined));
  assert.deepEqual(semanticSequenceCharacters({ ...plan, semanticPlanningSnapshot: undefined }, [stranger]), []);
});

test('legacy character projection returns an independent live copy without changing its behavior', () => {
  const legacyCharacter: Character = {
    id: 'legacy-person', name: '人物', gender: '', apparentAge: '', race: '', appearance: '当前外貌', outfit: '',
    signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: ['legacy-reference'],
    nsfwBodyAnchors: { stableTraits: ['existing-anchor-fixture'] },
  };
  const live = [legacyCharacter];
  const legacy = makePlan(); delete legacy.planningMode;
  for (const plan of [undefined, legacy]) {
    const copied = semanticSequenceCharacters(plan, live);
    assert.deepEqual(copied, live);
    assert.notEqual(copied, live);
    copied[0].appearance = 'copy-only'; copied[0].assetIds.push('copy-only');
    copied[0].nsfwBodyAnchors!.stableTraits.push('copy-only');
    assert.equal(legacyCharacter.appearance, '当前外貌');
    assert.deepEqual(legacyCharacter.assetIds, ['legacy-reference']);
    assert.deepEqual(legacyCharacter.nsfwBodyAnchors!.stableTraits, ['existing-anchor-fixture']);
  }
});

test('live legacy context excludes archived dossiers while frozen semantic identities remain intact', () => {
  const archived: Character = {
    id: 'old-role', name: '原剧情人物', gender: '', apparentAge: '', race: '', appearance: '旧外貌', outfit: '',
    signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: ['old-image'],
    dossier: { archivedIntoCharacterId: 'new-role' },
  };
  const replacement: Character = { ...archived, id: 'new-role', appearance: '新外貌', dossier: { useStory: false }, assetIds: ['new-image'] };
  const live = [archived, replacement];
  const before = JSON.stringify(live);
  assert.deepEqual(semanticSequenceCharacters(undefined, live).map((character) => character.id), ['new-role']);
  const plan = makePlan();
  plan.semanticPlanningSnapshot!.characterContinuity = [{ id: 'old-role', name: '冻结姓名', appearance: '冻结外貌' }];
  const frozen = semanticSequenceCharacters(plan, live);
  assert.equal(frozen[0].id, 'old-role');
  assert.equal(frozen[0].name, '冻结姓名');
  assert.equal(frozen[0].appearance, '冻结外貌');
  assert.deepEqual(frozen[0].assetIds, ['old-image']);
  assert.equal(JSON.stringify(live), before);
});

test('semantic structural checks retain fixed D, source hash and unique segment identity', () => {
  const plan = makePlan();
  for (const changed of [
    { ...plan, totalDurationSec: 20 },
    { ...plan, sourceContentHash: 'wrong-source' },
    { ...plan, semanticPlanningSnapshot: undefined },
    { ...plan, segments: plan.segments.map((segment) => ({ ...segment, id: 'duplicate' })) },
    { ...plan, segments: plan.segments.map((segment, index) => index ? { ...segment, durationSec: 5 } : segment) },
  ]) assert.ok(validateSequencePlan(changed).length > 0);
});

test('legacy master dependencies remain errors without an explicit new discriminator', () => {
  const plan = makePlan(); delete plan.planningMode;
  assert.match(sequencePlanMasterStoryboardIssue(plan, []) || '', /总视频提示词缺失/);
  assert.match(sequencePlanMasterConfirmationIssue(plan, []) || '', /确认/);
  const restored = normalizeState(stateFor(plan)).project.sequencePlans[0];
  assert.equal(restored.planningMode, undefined);
  assert.match(sequencePlanMasterStoryboardIssue(restored, []) || '', /缺失/);
});

test('legacy master alignment and beat provenance routines leave semantic plans unchanged', () => {
  const plan = makePlan(); const before = JSON.stringify(plan);
  assert.equal(alignSequenceSegmentsToMasterShotBoundaries(plan, []).plan, plan);
  assert.equal(reconcileSequenceSegmentsToShotProvenance(plan, [], [], []), plan);
  const normalized = validateAndNormalizeSequencePlan(plan);
  assert.deepEqual(normalized.segments.map((segment) => segment.content), plan.segments.map((segment) => segment.content));
  normalized.segments[0].semanticSource!.events[0].description = 'only cloned output changes';
  normalized.semanticPlanningSnapshot!.creativeDirection.cameraTerms.push('only cloned output changes');
  assert.equal(JSON.stringify(plan), before);
});

test('review fingerprints include source evidence, ownership and director snapshot, not runtime status', () => {
  const plan = makePlan(); const baseline = sequencePlanReviewFingerprint(plan);
  for (const change of [
    (next: VideoSequencePlan) => { next.segments[0].semanticSource!.sourceEvidence[0].text += '改变'; },
    (next: VideoSequencePlan) => { next.segments[0].semanticSource!.dialogues[0].speaker = '徒弟'; },
    (next: VideoSequencePlan) => { next.semanticPlanningSnapshot!.creativeDirection.extraRequirement += '改变'; },
  ]) { const next = clone(plan); change(next); assert.notEqual(sequencePlanReviewFingerprint(next), baseline); }
  const runtime = clone(plan); runtime.segments[0].status = 'failed'; runtime.segments[0].storyboardId = 'result-id';
  assert.equal(sequencePlanReviewFingerprint(runtime), baseline);
  assert.equal(semanticSequenceSourceFingerprint(runtime), semanticSequenceSourceFingerprint(plan));
});

test('editing a semantic segment preserves evidence and independent AI handoff wording', () => {
  const plan = makePlan(); const original = JSON.stringify(plan);
  const next = updateSequenceSegment(plan, plan.segments[1].id, { content: '用户修订的当前段动作。', entryState: '承接交接结果，未重复台词。' });
  assert.equal(next.segments[0].exitState, plan.segments[0].exitState);
  assert.equal(next.segments[0].status, 'planned');
  assert.equal(next.segments[1].status, 'stale');
  assert.deepEqual(next.segments[1].semanticSource, plan.segments[1].semanticSource);
  assert.deepEqual(validateSequencePlan(next), []);
  assert.equal(JSON.stringify(plan), original);
  assert.throws(() => updateSequenceSegment(plan, plan.segments[0].id, { durationSec: 5 }), /15 秒/);
});

test('legacy restore preserves semantic edits; locks, linking and reorder retain semantic facts', () => {
  const plan = makePlan();
  const edited = updateSequenceSegment(plan, plan.segments[1].id, { content: '修订文本' });
  const restored = restoreSequenceSegmentSourceContent(edited, plan.segments[1].id);
  assert.equal(restored, edited);
  assert.equal(restored.segments[1].content, '修订文本');
  assert.equal(restored.segments[1].contentOverridden, true);
  const locked = lockSequenceSegment(plan, plan.segments[0].id);
  assert.equal(locked.segments[0].locked, true);
  const linked = linkSegmentStoryboard(locked, plan.segments[0].id, 'new-board');
  assert.equal(linked.segments[0].status, 'ready');
  const moved = reorderSequenceSegment(plan, plan.segments[1].id, 1);
  assert.equal(moved.segments[0].entryState, plan.segments[1].entryState);
  assert.equal(moved.segments[0].durationSec, 15);
  assert.deepEqual(moved.segments[0].semanticSource, plan.segments[1].semanticSource);
  assert.throws(() => splitSequenceSegment(plan, plan.segments[0].id), /AI 重新规划/);
  assert.throws(() => mergeSequenceSegments(plan, plan.segments[0].id), /AI 重新规划/);
});

test('shared original evidence never replaces distinct AI event-stage bodies through legacy restore', () => {
  const plan = makePlan();
  plan.segments[0].content = '交接阶段：师傅递药草，徒弟接住。';
  plan.segments[1].content = '行进阶段：徒弟已经持有药草，只承接状态然后朝集市走。';
  for (const segment of plan.segments) {
    segment.semanticSource!.sourceEvidence = [{ text: story, sourceStart: 0, sourceEnd: story.length }];
  }
  assert.deepEqual(validateSequencePlan(plan), []);
  const before = JSON.stringify(plan);
  for (const segment of plan.segments) {
    const restored = restoreSequenceSegmentSourceContent(plan, segment.id);
    assert.equal(restored, plan);
    assert.equal(JSON.stringify(restored), before);
    assert.notEqual(restored.segments.find((item) => item.id === segment.id)!.content, story);
  }
});

test('segment generation source cannot reuse master shots or whole-story hash in semantic mode', () => {
  const plan = makePlan();
  const result = resolveSequenceSegmentGenerationSource({ segment: plan.segments[1], planningMode: plan.planningMode,
    fallbackContent: story, masterSourceContentHash: 'whole-story-hash' });
  assert.equal(result.sourceStoryContent, plan.segments[1].content);
  assert.equal(result.sourceContentHash, sourceContentHash(plan.segments[1].content));
  assert.equal(result.reuseMasterShots, false);
  assert.equal(resolveSequenceSegmentGenerationSource({ segment: plan.segments[1], fallbackContent: story, masterSourceContentHash: 'legacy-hash' }).reuseMasterShots, true);
});

test('semantic generation includes assigned dialogue in its main source without changing stored prose or user edits', () => {
  const plan = makePlan(); const segment = plan.segments[0]; const before = JSON.stringify(plan);
  const result = resolveSequenceSegmentGenerationSource({ segment, planningMode: plan.planningMode,
    fallbackContent: story, masterSourceContentHash: 'whole-story-hash' });
  assert.equal(segment.content.includes('拿稳。'), false, 'legacy action-only segment fixture');
  assert.ok(result.sourceStoryContent.includes('拿稳。'));
  assert.equal(result.sourceStoryContent, semanticSegmentStoryContent(segment));
  assert.equal(result.sourceContentHash, sourceContentHash(result.sourceStoryContent));
  assert.equal(result.reuseMasterShots, false);
  const edited = resolveSequenceSegmentGenerationSource({
    segment: { ...segment, content: '用户改为挥手道别。', contentOverridden: true }, planningMode: plan.planningMode,
    fallbackContent: story,
  });
  assert.equal(edited.sourceStoryContent, '用户改为挥手道别。');
  assert.equal(edited.sourceContentHash, sourceContentHash(edited.sourceStoryContent));
  assert.equal(JSON.stringify(plan), before);
});

test('save/restart/import preserve exact metadata and review confirmation without fabricated master', () => {
  const plan = makePlan(); plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan); plan.reviewConfirmedAt = 102;
  const state = stateFor(plan);
  const archived = { ...clone(state.project), id: 'archive-project' };
  state.projects.push(archived);
  const normalized = normalizeState(state);
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(normalized).serialized));
  for (const project of reloaded.projects) {
    const actual = project.sequencePlans[0];
    assert.equal(actual.planningMode, 'semantic-segments');
    assert.equal(actual.planningStage, 'segmented');
    assert.deepEqual(actual.semanticPlanningSnapshot, plan.semanticPlanningSnapshot);
    assert.deepEqual(actual.segments, plan.segments);
    assert.equal(actual.segmentationReason, plan.segmentationReason);
    assert.equal(actual.reviewConfirmedFingerprint, sequencePlanReviewFingerprint(actual));
    assert.equal(actual.masterStoryboardId, undefined);
    assert.equal(actual.masterPromptConfirmedFingerprint, undefined);
    assert.deepEqual(validateSequencePlan(actual, { requireMasterStoryboard: true }), []);
  }
  reloaded.project.sequencePlans[0].semanticPlanningSnapshot!.creativeDirection.cameraTerms.push('changed');
  assert.equal(plan.semanticPlanningSnapshot!.creativeDirection.cameraTerms.length, 1);
});

test('causality, source novel and frozen aliases survive save/import without reinterpreting legacy events', () => {
  const request: SemanticSequencePlanningInput = { ...input,
    characterContinuity: [{ id: 'teacher', name: '师傅', aliases: ['蓝袍人'] }],
    originalSourceContext: { id: 'visual-source', chapterId: 'chapter-source', sourceName: '师徒小说',
      sourceText: '蓝袍人把药草递出去。“拿稳。”她说。徒弟朝集市前行。', resultText: story, createdAt: 1 },
  };
  const authored = clone(response);
  authored.segments[0].semanticSource.events[0].causality = {
    actor: '师傅', actorCharacterId: 'teacher', target: '徒弟', action: '递出药草', result: '徒弟接稳药草',
    evidence: '师傅把药草递给徒弟', certainty: 'explicit',
  };
  const plan = materializeSemanticSequencePlan(request, authored, { planId: 'causal-plan', now: 100 });
  const saved = normalizeState(JSON.parse(serializeStateForStorage(normalizeState(stateFor(plan))).serialized));
  const restored = saved.project.sequencePlans[0];
  assert.deepEqual(restored.semanticPlanningSnapshot, plan.semanticPlanningSnapshot);
  assert.deepEqual(restored.segments.map((segment) => segment.semanticSource), plan.segments.map((segment) => segment.semanticSource));
  assert.deepEqual(validateSequencePlan(restored), []);
  const characters = semanticSequenceCharacters(restored, []);
  assert.deepEqual(characters[0].aliases, ['蓝袍人']);
  characters[0].aliases!.push('mutated clone');
  assert.deepEqual(restored.semanticPlanningSnapshot!.characterContinuity[0].aliases, ['蓝袍人']);
  assert.equal(Object.hasOwn(restored.segments[1].semanticSource!.events[0], 'causality'), false,
    'older event records must not gain fabricated relations');
});

test('fixed and explicit AI duration requests survive save/restart with their own review identity', () => {
  for (const request of [
    { ...input, durationMode: 'fixed' as const, requestedTotalDurationSec: 30 },
    { ...input, durationMode: 'ai-estimated' as const, requestedTotalDurationSec: 600 },
  ]) {
    const plan = materializeSemanticSequencePlan(request, response, { planId: 'duration-mode-plan', now: 100 });
    plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    plan.reviewConfirmedAt = 102;
    const before = JSON.stringify(plan);
    const state = stateFor(plan);
    state.projects.push({ ...clone(state.project), id: 'duration-mode-archive' });
    const restored = normalizeState(JSON.parse(serializeStateForStorage(normalizeState(state)).serialized));
    for (const project of restored.projects) {
      const actual = project.sequencePlans[0];
      assert.equal(actual.durationMode, request.durationMode);
      assert.equal(actual.semanticPlanningSnapshot!.durationMode, request.durationMode);
      assert.equal(actual.requestedTotalDurationSec, request.durationMode === 'fixed' ? 30 : undefined);
      assert.equal(actual.semanticPlanningSnapshot!.requestedTotalDurationSec, request.durationMode === 'fixed' ? 30 : undefined);
      assert.deepEqual(actual.semanticPlanningSnapshot, plan.semanticPlanningSnapshot);
      assert.deepEqual(actual.segments, plan.segments);
      assert.equal(actual.reviewConfirmedFingerprint, sequencePlanReviewFingerprint(actual));
      assert.deepEqual(validateSequencePlan(actual), []);
    }
    assert.equal(JSON.stringify(plan), before);
  }
});

test('old AI snapshots remain absent-mode snapshots and keep the saved source and review fingerprints', () => {
  const plan = makePlan();
  const snapshotBefore = JSON.stringify(plan.semanticPlanningSnapshot);
  const sourceBefore = semanticSequenceSourceFingerprint(plan);
  plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
  plan.reviewConfirmedAt = 102;
  const restored = normalizeState(JSON.parse(serializeStateForStorage(stateFor(plan)).serialized)).project.sequencePlans[0];
  assert.equal(restored.durationMode, 'ai-estimated');
  assert.equal(Object.hasOwn(restored.semanticPlanningSnapshot!, 'durationMode'), false);
  assert.equal(Object.hasOwn(restored.semanticPlanningSnapshot!, 'requestedTotalDurationSec'), false);
  assert.equal(JSON.stringify(restored.semanticPlanningSnapshot), snapshotBefore);
  assert.equal(semanticSequenceSourceFingerprint(restored), sourceBefore);
  assert.equal(restored.reviewConfirmedFingerprint, sequencePlanReviewFingerprint(restored));
  assert.deepEqual(validateSequencePlan(restored), []);
});

test('mode switches invalidate fixed confirmations and recovery never fabricates a different total or N', () => {
  const fixed = materializeSemanticSequencePlan({ ...input, durationMode: 'fixed', requestedTotalDurationSec: 30 }, response, { planId: 'fixed-confirmed', now: 100 });
  fixed.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(fixed);
  fixed.reviewConfirmedAt = 102;
  const switched = clone(fixed);
  switched.durationMode = 'ai-estimated';
  delete switched.requestedTotalDurationSec;
  switched.semanticPlanningSnapshot!.durationMode = 'ai-estimated';
  delete switched.semanticPlanningSnapshot!.requestedTotalDurationSec;
  const switchedReloaded = normalizeState(JSON.parse(serializeStateForStorage(stateFor(switched)).serialized)).project.sequencePlans[0];
  assert.deepEqual(validateSequencePlan(switchedReloaded), []);
  assert.equal(switchedReloaded.reviewConfirmedFingerprint, fixed.reviewConfirmedFingerprint);
  assert.notEqual(switchedReloaded.reviewConfirmedFingerprint, sequencePlanReviewFingerprint(switchedReloaded));
  assert.notEqual(semanticSequenceSourceFingerprint(switchedReloaded), semanticSequenceSourceFingerprint(fixed));
  const inconsistent = clone(fixed);
  inconsistent.requestedTotalDurationSec = 45;
  inconsistent.semanticPlanningSnapshot!.requestedTotalDurationSec = 45;
  const restored = normalizeState(stateFor(inconsistent)).project.sequencePlans[0];
  assert.equal(restored.requestedTotalDurationSec, 45);
  assert.equal(restored.semanticPlanningSnapshot!.requestedTotalDurationSec, 45);
  assert.equal(restored.totalDurationSec, 30);
  assert.equal(restored.segments.length, 2);
  assert.deepEqual(restored.segments.map((segment) => segment.content), fixed.segments.map((segment) => segment.content));
  assert.ok(validateSequencePlan(restored).some((issue) => /T ÷ D/u.test(issue)));
  assert.notEqual(restored.reviewConfirmedFingerprint, sequencePlanReviewFingerprint(restored));
});

test('recovery keeps interrupted and missing results retryable without changing semantic source', () => {
  const plan = makePlan(); plan.segments[0].status = 'generating'; plan.segments[1].status = 'ready'; plan.segments[1].storyboardId = 'missing';
  const restored = normalizeState(stateFor(plan)).project.sequencePlans[0];
  assert.equal(restored.segments[0].status, 'failed');
  assert.match(restored.segments[0].failureReason || '', /重试/);
  assert.equal(restored.segments[1].status, 'planned');
  assert.equal(restored.segments[1].storyboardId, undefined);
  assert.deepEqual(restored.segments.map((segment) => segment.semanticSource), plan.segments.map((segment) => segment.semanticSource));
  assert.deepEqual(pendingSequenceSegmentIds(restored, []), plan.segments.map((segment) => segment.id));
});

test('completed segment results survive recovery but explicit edits remain stale', () => {
  const plan = makePlan(); const board = makeBoard(plan);
  plan.segments[0].storyboardId = board.id; plan.segments[0].status = 'generating';
  const repaired = repairSequencePlanResults(plan, [board]);
  assert.ok(isSequenceSegmentComplete(repaired.segments[0], [board], plan.id));
  const edited = updateSequenceSegment(repaired, plan.segments[0].id, { content: '修改本段动作' });
  assert.equal(repairSequencePlanResults(edited, [board]).segments[0].status, 'stale');
  const result = invalidateSequenceSegmentsForMasterPrompt(repaired, [board], 200);
  assert.equal(result.plan, repaired); assert.deepEqual(result.storyboards, [board]);
  assert.deepEqual(result.invalidatedStoryboardIds, []);
});

test('saving and reopening semantic plans does not rewrite submitted paid tasks', () => {
  const plan = makePlan(); const state = stateFor(plan);
  const task: VideoGenerationTask = { id: 'paid-history', kind: 'video', storyboardId: 'old-board', targetId: 'test-video',
    status: 'succeeded', remoteTaskId: 'remote-existing', requestBody: { prompt: 'Frozen submitted video prompt', references: ['first-frame', 'person-2'] },
    sequencePlanId: 'old-plan', segmentId: 'old-segment', segmentIndex: 1, resultAssetId: 'old-result', createdAt: 1, updatedAt: 2 };
  state.project.generationTasks = [task];
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.deepEqual(restored.project.generationTasks.find((item) => item.id === task.id), task);
});

test('semantic export identifies original-story evidence and never claims a pending full master', () => {
  const plan = makePlan(); const board = makeBoard(plan); plan.segments[0].storyboardId = board.id; plan.segments[0].status = 'ready';
  const manifest = buildSequencePromptManifest(plan, [board]);
  assert.equal(manifest.plan.planningMode, 'semantic-segments');
  assert.equal(manifest.plan.sourceStoryContent, story);
  assert.deepEqual(manifest.plan.semanticPlanningSnapshot, plan.semanticPlanningSnapshot);
  assert.equal('masterPromptStatus' in manifest.plan, false);
  assert.equal('masterStoryboardId' in manifest.plan, false);
  assert.deepEqual(manifest.segments[0].semanticSource, plan.segments[0].semanticSource);
  assert.equal(manifest.segments[0].finalPrompt, board.finalPrompt);
  const text = buildSequencePromptText(plan, [board]);
  assert.match(text, /AI 原文语义分段/);
  assert.ok(!text.includes('总提示词状态：待生成'));
  assert.ok(!text.includes('总时间轴镜头 ID：待切片'));
});

test('diagnostics use semantic technical contract and do not warn about missing masters', () => {
  const plan = makePlan(); const report = diagnoseState(stateFor(plan));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  plan.sourceContentHash = 'changed';
  assert.ok(diagnoseState(stateFor(plan)).warnings.some((warning) => /原文指纹/.test(warning)));
});

console.log(`semantic sequence compatibility: ${checks} test groups passed`);
