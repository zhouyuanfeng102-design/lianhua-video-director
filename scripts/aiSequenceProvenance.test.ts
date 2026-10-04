import assert from 'node:assert/strict';
import { requestAiStorySegmentation } from '../src/services/llm';
import { assertAiSequenceSegmentShotCoverage, materializeAiSequenceSegments, reconcileSequenceSegmentsToShotProvenance, validateAndNormalizeSequencePlan } from '../src/sequencePlan';
import { extractStoryBeats, resolveAiSequenceTotalDuration, sequencePlanMasterConfirmationIssue, sequencePlanMasterStoryboardIssue, validateSequencePlan } from '../src/storySegmentation';
import { applyMasterPromptEdit, masterPromptConfirmationFingerprint, parseMasterTimelinePrompt } from '../src/masterTimeline';
import { sourceContentHash } from '../src/sourceIntegrity';
import { createInitialState, normalizeState } from '../src/storage';
import type { AiSequenceSegmentPlan, Storyboard, TextApiConfig, VideoSequencePlan, VideoShot } from '../src/types';

// The only network boundary is replaced with a deterministic in-memory fake.
// No live API, existing project or filesystem-backed save is used.
const originalWindow = globalThis.window;
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://ai.example.test/v1', apiKey: 'test', model: 'test', temperature: 0.2, maxTokens: 4096, vision: false };
const story = '雨幕下，守门人把旧钥匙收进口袋。门内传来轻轻的两声敲击。她停下脚步，回头确认门缝里没有灯光。';
const beats = extractStoryBeats(story);
const shots: VideoShot[] = [0, 1].map((index) => ({
  id: `ai-shot-${index + 1}`, index: index + 1, authoredBy: 'text-api', startSec: index * 5, endSec: (index + 1) * 5,
  purpose: '保持动作信息完整', subject: '守门人', action: index === 0 ? '收钥匙后闻声驻足。' : '她回望那扇无光的门。',
  camera: '固定中景', lighting: '雨夜侧光', sound: '低声雨响', result: '保持警戒', transition: '视线承接',
  prompt: `【${index * 5}s-${(index + 1) * 5}s】 主体：守门人；镜头：固定中景；动作：${index === 0 ? '收钥匙后闻声驻足。' : '她回望那扇无光的门。'}`,
  sourceExcerpt: index === 0 ? '收钥匙、闻声驻足' : '回望无光的门', sourceLocationStatus: 'unlocated', sourceBeatIds: [], referenceAssetIds: [], locked: false,
}));
const base: VideoSequencePlan = {
  id: 'ai-plan', title: '雨夜', sourceStoryTitle: '雨夜', sourceStoryContent: story, sourceContentHash: sourceContentHash(story),
  durationMode: 'fixed', requestedTotalDurationSec: 10, totalDurationSec: 10, segmentDurationSec: 5,
  segmentationMode: 'fixed', segmentationSource: 'ai', fitStatus: 'balanced', masterStoryboardId: 'ai-master',
  planningStage: 'segmented', segments: [], createdAt: 1, updatedAt: 1,
};
const master: Storyboard = {
  id: 'ai-master', sceneId: '', sourceSceneIds: [], sourceStoryContent: story, sequencePlanId: base.id,
  workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'auto',
  pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: 'test', ruleSetId: 'test',
  converterPresetId: 'test', globalLock: '', extraRequirement: '', shots,
  finalPrompt: shots.map((shot) => shot.prompt).join('\n'), createdAt: 1, updatedAt: 1,
  shotCountReason: 'AI 全文自检有待确认项：敲门者身份尚不明确。',
  promptTrace: { modelRuleSetId: 'test', converterPresetId: 'test', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1, mode: 'text-api', shotRecommendationMode: 'text-api', shotPlanMode: 'ai-complete' },
};
const drafts = (): AiSequenceSegmentPlan[] => shots.map((shot, index) => ({
  sourceShotIds: [shot.id], sourceBeatIds: [], boundaryAfterShotId: shot.id,
  durationSec: 5, globalStartSec: index * 5, globalEndSec: (index + 1) * 5,
  title: `第${index + 1}段`, content: `AI 整理的第${index + 1}段正文，不要求与本地节拍逐字相同。`, summary: shot.action,
  narrativePurpose: shot.purpose, entryState: index === 0 ? '守门人握着钥匙。' : '停步后，守门人慢慢回头。',
  exitState: index === 0 ? '守门人已经驻足。' : '守门人保持回头姿势。', transitionHint: '保持视线和雨夜空间',
  boundaryReason: '完整动作已经落定', continuityPack: '人物、钥匙、门、雨夜光线不变',
}));
let calls = 0;
let response: unknown = { reason: '已对照全文自检并由完整镜头分组。', segments: drafts() };
const payloads: Array<{ body?: string }> = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
  request: async (payload: { body?: string }) => {
    calls += 1; payloads.push(payload);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  },
} } });

const input = { title: '雨夜', story, sourceStoryContent: story, totalDurationSec: 10, maxSegmentDurationSec: 15, preferredSegmentDurationSec: 5, allowedSegmentDurationsSec: [5], beats, masterShots: shots };
const materialize = (segments: readonly AiSequenceSegmentPlan[], masterShots = shots) => materializeAiSequenceSegments(base, masterShots, segments, beats);
let checks = 0;
try {
  const result = await requestAiStorySegmentation(config, input, undefined, { onRepair: () => assert.fail('Missing literal provenance must not trigger another paid model call') });
  assert.equal(calls, 1);
  const body = JSON.parse(payloads[0].body || '{}') as { messages: Array<{ role: string; content: string }> };
  assert.ok(body.messages.some((message) => message.content.includes(story)), 'the complete original story must reach the model');
  assert.ok(body.messages.some((message) => message.content.includes('在本次输出内自行修正')), 'the model owns its narrative self-review');
  const plan = materialize(result.segments);
  assert.deepEqual(plan.segments.map((segment) => segment.content), drafts().map((segment) => segment.content));
  assert.deepEqual(plan.segments.map((segment) => segment.sourceBeatIds), [[], []]);
  assert.equal(plan.segments[1].entryState, drafts()[1].entryState, 'different continuity wording is model-owned');
  assert.equal(plan.sourceStoryContent, story);
  assertAiSequenceSegmentShotCoverage(plan, shots);
  const reconciled = reconcileSequenceSegmentsToShotProvenance(plan, shots, beats, [], { preserveAiMetadata: true });
  assert.deepEqual(reconciled.segments, plan.segments);
  assert.deepEqual(validateAndNormalizeSequencePlan(reconciled).segments, plan.segments);
  assert.deepEqual(validateSequencePlan(reconciled, { requireMasterStoryboard: true, storyboards: [master] }), []);
  assert.deepEqual(validateSequencePlan(reconciled), [], 'metadata-only consumers cannot restore a beat-content gate');
  checks += 5;

  const initial = createInitialState();
  const restored = normalizeState(JSON.parse(JSON.stringify({ ...initial, project: { ...initial.project, storyboards: [master], sequencePlans: [plan] } })));
  const restoredMaster = restored.project.storyboards.find((board) => board.id === master.id)!;
  const restoredPlan = restored.project.sequencePlans.find((candidate) => candidate.id === plan.id)!;
  assert.ok(restoredMaster.shots.every((shot) => shot.authoredBy === 'text-api'));
  assert.equal(restoredMaster.shotCountReason, master.shotCountReason, 'the AI self-review note must survive storage');
  assert.deepEqual(restoredPlan.segments.map((segment) => segment.content), plan.segments.map((segment) => segment.content));
  assert.deepEqual(validateSequencePlan(restoredPlan, { requireMasterStoryboard: true, storyboards: [restoredMaster] }), []);
  checks += 1;

  // Reproduce a 150-second master whose complete shot crosses 120 seconds.
  // The history stays readable and persists unchanged, but it must no longer
  // be marked ready for a selected15-second generation contract.
  const aiBoundaries = [0, 15, 30, 45, 60, 75, 90, 105, 117, 125, 135, 150];
  const crossingShots = aiBoundaries.slice(0, -1).map((startSec, index): VideoShot => {
    const endSec = aiBoundaries[index + 1];
    const action = `守门人完成第${index + 1}个完整动作，停下后保持警戒`;
    return {
      ...shots[0], id: `crossing-shot-${index + 1}`, index: index + 1, startSec, endSec, action,
      prompt: `【${startSec}s-${endSec}s】主体：@守门人 正在 [${action}]；空间：门前；光影：雨夜侧光；镜头：固定中景；台词：无；音效：无`,
    };
  });
  const crossingMaster: Storyboard = {
    ...master, durationSec: 150, shots: crossingShots, finalPrompt: crossingShots.map((shot) => shot.prompt).join('\n'),
  };
  const crossingDraft: VideoSequencePlan = {
    ...base, totalDurationSec: 150, requestedTotalDurationSec: 150, segmentDurationSec: 15,
    planningStage: 'master-draft', segmentationSource: undefined, segments: [],
  };
  assert.match(sequencePlanMasterStoryboardIssue(crossingDraft, [crossingMaster]) || '', /120秒.*重新生成全片总提示词/u);
  assert.ok(validateSequencePlan(crossingDraft, { requireMasterStoryboard: true, storyboards: [crossingMaster] }).some((error) => /120秒/u.test(error)));
  assert.equal(resolveAiSequenceTotalDuration(28), 28, 'AI total duration must not be rounded onto a preferred 15-second grid');
  assert.ok(validateSequencePlan({ ...crossingDraft, segmentDurationSec: 13 }, {
    requireMasterStoryboard: true, storyboards: [crossingMaster],
  }).some((error) => /整数倍/u.test(error)), 'non-multiple old plans remain data, not qualified current generation contracts');
  for (const invalidTotal of [0, -1, NaN, Infinity, 3601]) {
    assert.throws(() => resolveAiSequenceTotalDuration(invalidTotal), /全片总时长/u);
  }
  assert.equal(parseMasterTimelinePrompt(crossingMaster.finalPrompt, 150).length, crossingShots.length);
  const confirmedCrossingMaster = { ...crossingMaster, shots: applyMasterPromptEdit(crossingShots, crossingMaster.finalPrompt, 150) };
  const crossingConfirmed: VideoSequencePlan = {
    ...crossingDraft, planningStage: 'master-confirmed', masterPromptConfirmedAt: 2,
    masterPromptConfirmedFingerprint: masterPromptConfirmationFingerprint(crossingDraft, confirmedCrossingMaster),
  };
  assert.match(sequencePlanMasterConfirmationIssue(crossingConfirmed, [confirmedCrossingMaster]) || '', /120秒/u);
  assert.ok(validateSequencePlan(crossingConfirmed, { requireMasterStoryboard: true, storyboards: [confirmedCrossingMaster] }).some((error) => /120秒/u.test(error)));
  const crossingSegments = crossingShots.map((shot, index): AiSequenceSegmentPlan => ({
    ...drafts()[0], sourceShotIds: [shot.id], boundaryAfterShotId: shot.id,
    title: `AI完整镜头段${index + 1}`, content: shot.action,
    durationSec: shot.endSec - shot.startSec, globalStartSec: shot.startSec, globalEndSec: shot.endSec,
  }));
  calls = 0; response = { segments: crossingSegments };
  await assert.rejects(requestAiStorySegmentation(config, {
    ...input, totalDurationSec: 150, preferredSegmentDurationSec: 15,
    allowedSegmentDurationsSec: undefined, masterShots: crossingShots,
  }, undefined, { reviewWithAi: true, onRepair: () => assert.fail('an incompatible saved master needs explicit full-master regeneration') }), /重新生成全片总提示词/u);
  assert.equal(calls, 0, 'old saved masters are not rewritten or sent to paid regeneration implicitly');
  const flexiblePlan = materializeAiSequenceSegments({ ...crossingConfirmed, planningStage: 'segmented' }, crossingShots, crossingSegments, beats);
  assertAiSequenceSegmentShotCoverage(flexiblePlan, crossingShots);
  assert.ok(validateSequencePlan(flexiblePlan, { requireMasterStoryboard: true, storyboards: [confirmedCrossingMaster] }).length > 0);
  assert.ok(validateSequencePlan(flexiblePlan).some((error) => /每段足额/u.test(error)));
  assert.deepEqual(validateAndNormalizeSequencePlan(flexiblePlan).segments, flexiblePlan.segments);
  assert.deepEqual(flexiblePlan.segments.map((segment) => segment.durationSec), crossingShots.map((shot) => shot.endSec - shot.startSec));
  assert.equal(crossingMaster.shots[8].startSec, 117);
  assert.equal(crossingMaster.shots[8].endSec, 125, 'the crossing shot must not be locally cut at 120 seconds');
  const crossingRestored = normalizeState(JSON.parse(JSON.stringify({ ...initial, project: { ...initial.project, storyboards: [confirmedCrossingMaster], sequencePlans: [flexiblePlan] } })));
  assert.ok(validateSequencePlan(crossingRestored.project.sequencePlans[0], {
    requireMasterStoryboard: true, storyboards: crossingRestored.project.storyboards,
  }).length > 0);
  assert.equal(crossingRestored.project.storyboards[0].finalPrompt, confirmedCrossingMaster.finalPrompt, 'history is preserved, never locally retimed during restore');
  assert.deepEqual(crossingRestored.project.sequencePlans[0].segments.map((segment) => segment.durationSec), flexiblePlan.segments.map((segment) => segment.durationSec));
  checks += 7;

  const longShots: VideoShot[] = crossingShots.slice(0, 2).map((shot, index) => {
    const startSec = index === 0 ? 0 : 18;
    const endSec = index === 0 ? 18 : 30;
    return {
      ...shot, startSec, endSec,
      prompt: shot.prompt.replace(/^【[^】]+】/u, `【${startSec}s-${endSec}s】`),
    };
  });
  const longMaster = { ...master, durationSec: 30, shots: longShots, finalPrompt: longShots.map((shot) => shot.prompt).join('\n') };
  const longBase = { ...base, totalDurationSec: 30, requestedTotalDurationSec: 30, segmentDurationSec: 15 };
  assert.ok(validateSequencePlan({ ...longBase, planningStage: 'master-draft', segmentationSource: undefined }, {
    requireMasterStoryboard: true, storyboards: [longMaster],
  }).some((error) => /15秒/u.test(error)), 'a readable old18-second master is retained but requires explicit AI regeneration for15-second delivery');
  assert.deepEqual(applyMasterPromptEdit(longShots, longMaster.finalPrompt, 30).map((shot) => [shot.startSec, shot.endSec]), [[0, 18], [18, 30]],
    'confirming the AI draft retains its complete 18-second shot');
  const longSegments = longShots.map((shot, index) => ({
    ...drafts()[index], sourceShotIds: [shot.id], boundaryAfterShotId: shot.id,
    durationSec: shot.endSec - shot.startSec, globalStartSec: shot.startSec, globalEndSec: shot.endSec,
  }));
  const longPlan = materializeAiSequenceSegments(longBase, longShots, longSegments, beats);
  assertAiSequenceSegmentShotCoverage(longPlan, longShots);
  assert.ok(validateSequencePlan(longPlan, { requireMasterStoryboard: true, storyboards: [longMaster] }).length > 0);
  assert.ok(validateSequencePlan(longPlan).some((error) => /不是软目标/u.test(error)));
  assert.deepEqual(validateAndNormalizeSequencePlan(longPlan).segments, longPlan.segments,
    'an API-authored 18-second shot stays intact instead of being locally capped or rejected');
  assert.deepEqual(reconcileSequenceSegmentsToShotProvenance(longPlan, longShots, beats, [], { preserveAiMetadata: true }).segments, longPlan.segments);
  assert.equal(longMaster.shots[0].endSec, 18);
  assert.throws(() => validateAndNormalizeSequencePlan({ ...longPlan, segmentationSource: 'local' }), /15/u,
    'legacy local plan restrictions stay separate from model-authored planning');
  checks += 3;

  const malformedProvenance = drafts().map((draft, index) => ({ ...draft, sourceBeatIds: index === 0 ? ['unknown', beats[2].id, beats[0].id, beats[0].id] : undefined }));
  response = { segments: malformedProvenance };
  calls = 0;
  const optional = await requestAiStorySegmentation(config, { ...input, masterShots: shots.map((shot) => ({ ...shot, sourceBeatIds: ['unknown', beats[0].id], sourceStart: 1, sourceEnd: 2 })) });
  assert.equal(calls, 1);
  const partialPlan = materialize(optional.segments, shots.map((shot) => ({ ...shot, sourceBeatIds: ['unknown', beats[0].id], sourceStart: 1, sourceEnd: 2 })));
  const partialReconciled = reconcileSequenceSegmentsToShotProvenance(partialPlan, shots, beats, [], { preserveAiMetadata: true });
  assert.deepEqual(validateSequencePlan(partialReconciled, { requireMasterStoryboard: true, storyboards: [master] }), []);
  checks += 1;

  const missingContent = drafts().map(({ content: _content, ...draft }) => draft);
  const fallbackPlan = materialize(missingContent);
  assert.deepEqual(fallbackPlan.segments.map((segment) => segment.content), shots.map((shot) => shot.sourceExcerpt));
  assert.deepEqual(validateSequencePlan(fallbackPlan, { requireMasterStoryboard: true, storyboards: [master] }), []);
  checks += 1;

  for (const invalid of [
    [drafts()[0], { ...drafts()[1], sourceShotIds: [shots[0].id] }],
    [{ ...drafts()[0], sourceShotIds: ['unknown'] }, drafts()[1]],
    [drafts()[0]],
    [{ ...drafts()[0], sourceShotIds: [shots[1].id] }, { ...drafts()[1], sourceShotIds: [shots[0].id] }],
  ]) {
    response = { segments: invalid }; calls = 0;
    await assert.rejects(() => requestAiStorySegmentation(config, input));
    assert.equal(calls, 2, 'structural errors still get one AI repair, then stop without accepting corrupt data');
    assert.throws(() => materialize(invalid), /镜头|分段/u);
    checks += 1;
  }
  for (const invalidShots of [
    [{ ...shots[0], endSec: 0 }, shots[1]],
    [shots[0], { ...shots[1], id: shots[0].id }],
    [shots[0], { ...shots[1], startSec: 6 }],
  ]) {
    assert.throws(() => materialize(drafts(), invalidShots), /镜头|时间/u);
    assert.throws(() => assertAiSequenceSegmentShotCoverage(plan, invalidShots), /镜头|时间/u);
    checks += 1;
  }
  const duplicatePlan = { ...plan, segments: plan.segments.map((segment) => ({ ...segment, sourceShotIds: [shots[0].id] })) };
  assert.ok(validateSequencePlan(duplicatePlan, { requireMasterStoryboard: true, storyboards: [master] }).some((error) => /重复|归属/u.test(error)));
  const oldLocalShots = shots.map(({ authoredBy: _authoredBy, ...shot }) => shot);
  assert.throws(() => materialize(drafts(), oldLocalShots), /剧情节拍/u, 'legacy locally-authored shot drafts retain their provenance rules');
  const controller = new AbortController(); controller.abort(); calls = 0;
  await assert.rejects(() => requestAiStorySegmentation(config, input, controller.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls, 0);
  checks += 3;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`${checks} AI sequence provenance and full-story handoff regression checks passed`);
