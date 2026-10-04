import assert from 'node:assert/strict';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import {
  buildSequencePromptHandoff,
  getSequencePromptHandoffStatus,
  isSequencePromptHandoffCurrent,
  normalizeSequencePromptHandoffStamp,
  SEQUENCE_PROMPT_HANDOFF_VERSION,
  SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION,
  stampSequencePromptHandoff,
} from '../src/sequencePromptHandoff';
import { sourceContentHash } from '../src/sourceIntegrity';
import { createInitialState, normalizeState } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import type { Project, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const canonical = (tail: string) => [
  '【0s-10s】 主体：@师傅（平静）[朝向：徒弟] 正在 [取出药草]（准备交接）；空间：前景-药草 中景-师徒 背景-山道；光影：柔和晨光；镜头：中景稳定拍摄；台词：无；音效：环境层-[风声] 动作层-[无] 情绪层-[无配乐]',
  `【10s-15s】 主体：@师傅（平静）[朝向：徒弟] 正在 [${tail}]（递交药草）；空间：前景-药草 中景-师徒 背景-山道；光影：柔和晨光；镜头：中景稳定拍摄；台词：无；音效：环境层-[风声] 动作层-[无] 情绪层-[无配乐]`,
].join('\n');

function boardFor(index: number): Storyboard {
  const finalPrompt = canonical(index === 1 ? 'CANONICAL_OLD_TAIL' : '接稳药草再查看');
  const board: Storyboard = {
    id: `board-${index}`, sceneId: 'scene', sourceSceneIds: ['scene'],
    sourceStoryContent: '师傅递药草，徒弟接住后查看。', sourceStoryTitle: '药草交接',
    workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s',
    shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: 'style', ruleSetId: 'rule', converterPresetId: 'converter', globalLock: '',
    shots: finalPrompt.split('\n').map((prompt, i) => ({
      id: `shot-${index}-${i}`, index: i + 1, startSec: i === 0 ? 0 : 10, endSec: i === 0 ? 10 : 15,
      purpose: '药草交接', subject: '师傅', action: 'OLD_STRUCTURED_ACTION', camera: '中景稳定拍摄',
      transition: '连续', lighting: '晨光', sound: '风声', referenceAssetIds: [], prompt,
      result: '交接中', locked: false,
    })),
    finalPrompt, createdAt: 1, updatedAt: 1, sequencePlanId: 'plan', segmentId: `segment-${index}`,
    segmentIndex: index, segmentCount: 3, globalStartSec: (index - 1) * 15, globalEndSec: index * 15,
    promptTrace: {
      modelRuleSetId: 'rule', converterPresetId: 'converter', sourceDocumentIds: [], referenceAssetIds: [],
      generatedAt: 1, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(finalPrompt),
    },
  };
  return applyOfficialH3Prompt(board, { assets: [] });
}

const segments: VideoSegment[] = [1, 2, 3].map((index) => ({
  id: `segment-${index}`, index, title: `第${index}段`, globalStartSec: (index - 1) * 15, globalEndSec: index * 15,
  durationSec: 15, content: `第${index}段原文。`, summary: '药草交接', sourceSceneIds: ['scene'], sourceBeatIds: [`beat-${index}`],
  narrativePurpose: '推进', entryState: '手伸向药草', exitState: '药草交接中', transitionHint: '连续动作',
  continuityPack: '保持左右站位和手势', storyboardId: `board-${index}`, status: 'ready',
}));
const plan: VideoSequencePlan = {
  id: 'plan', title: '药草交接', sourceStoryTitle: '药草交接', sourceStoryContent: '师傅递药草，徒弟接住后查看。',
  durationMode: 'fixed', requestedTotalDurationSec: 45, totalDurationSec: 45, segmentDurationSec: 15,
  segmentationMode: 'fixed', fitStatus: 'balanced', segments, createdAt: 1, updatedAt: 1,
};
const initialState = createInitialState();
const project: Project = {
  ...initialState.project, id: 'project-handoff', assets: [], generationTasks: [],
  storyboards: [1, 2, 3].map(boardFor), sequencePlans: [plan],
};
// A final staging review can legitimately differ from canonical shots. The
// handoff must use this delivered body, not old planning or six-field prose.
const previous = project.storyboards[0];
previous.officialPromptZh = previous.officialPromptZh!.replaceAll('CANONICAL_OLD_TAIL', 'REVIEWED_DELIVERY_TAIL');
previous.targetOutput!.prompt = previous.officialPromptZh;
const original = JSON.stringify(project);

assert.deepEqual(buildSequencePromptHandoff(project, 'plan', 'segment-1'), {});
assert.equal(getSequencePromptHandoffStatus(project.storyboards[0], project).kind, 'first');
assert.equal(getSequencePromptHandoffStatus(project.storyboards[1], project).kind, 'legacy');
const built = buildSequencePromptHandoff(project, 'plan', 'segment-2');
assert.equal(built.issue, undefined);
assert.ok(built.context && built.stamp);
assert.equal(built.context.previousFinalPrompt, previous.officialPromptZh);
assert.equal(built.context.previousPromptKind, 'official-h3');
assert.equal(built.context.previousLastShot?.marker, '[Shot 2]');
assert.equal(built.context.previousLastShot?.startSec, 10);
assert.equal(built.context.previousLastShot?.endSec, 15);
assert.match(built.context.previousLastShot!.prompt, /REVIEWED_DELIVERY_TAIL/u);
assert.doesNotMatch(built.context.previousLastShot!.prompt, /OLD_STRUCTURED_ACTION|CANONICAL_OLD_TAIL|overall_soundscape/u);
assert.equal(built.context.openingOverlapSec, 0.5);
assert.deepEqual(built.context.previousTailWindow, { startSec: 13, endSec: 15 });
const timing = built.context.openingTiming;
assert.equal(timing.contractVersion, SEQUENCE_PROMPT_HANDOFF_TIMING_VERSION);
assert.deepEqual(timing.previousPromptEvidence, {
  source: 'previousFinalPrompt', literalLastShot: 'previousLastShot', access: 'read-only-text-provenance',
  coordinate: 'previous-segment-seconds', startSec: 13, endSec: 15,
  usage: 'infer-terminal-action-state-only-not-replay-duration',
});
assert.deepEqual(timing.currentOpeningWindow, {
  coordinate: 'current-segment-seconds', startSec: 0, endSec: 0.5, maxEndSec: 0.8,
  placement: 'inside-existing-first-shot',
});
assert.equal(timing.currentStoryStartsAtSec, 0.5);
assert.equal(timing.currentStoryStartsNoLaterThanSec, 0.8);
assert.equal(timing.currentStorySource, 'segmentContent');
assert.equal(timing.remainderOfFirstShot, 'advance-current-story-without-extending-replay');
assert.equal(timing.previousWholeShotReplay, 'not-allowed');
assert.equal(timing.previousDialogueReplay, 'not-allowed');
assert.equal(timing.additionalShotOrCut, 'not-allowed');
assert.equal(timing.overlapIncludedInSegmentDuration, true);
assert.match(timing.firstShotTimingInstruction, /上段末1–2秒只供读取/u);
assert.match(timing.firstShotTimingInstruction, /本段0\.00–0\.50秒.+从0\.50秒起/u);
assert.match(timing.firstShotTimingInstruction, /首镜剩余时间不得继续重演上段/u);
assert.match(timing.firstShotTimingInstruction, /0\.80秒是上限，不是默认复播时长，更不是整个首镜/u);
assert.match(timing.firstShotTimingInstruction, /不能复制上段完整末镜、已说完对白/u);
assert.match(timing.firstShotTimingInstruction, /不新增镜头或At切点/u);
assert.equal(built.context.previousLastShot!.endSec - built.context.previousLastShot!.startSec, 5);
assert.equal(timing.previousPromptEvidence.endSec - timing.previousPromptEvidence.startSec, 2);
assert.equal(timing.currentOpeningWindow.endSec - timing.currentOpeningWindow.startSec, 0.5,
  'the 5-second literal shot and 2-second evidence focus are not the child replay duration');
assert.equal(built.context.previousContinuityPack, segments[0].continuityPack);
assert.equal(built.context.entryState, segments[1].entryState);
assert.equal(normalizeSequencePromptHandoffStamp(built.stamp), undefined, 'a pending source stamp cannot masquerade as a reviewed result');
assert.doesNotMatch(JSON.stringify(built.stamp), /REVIEWED_DELIVERY_TAIL|OLD_STRUCTURED_ACTION/u);
assert.equal(JSON.stringify(project), original, 'building evidence is read-only and never requests media');

const aligned = stampSequencePromptHandoff(project.storyboards[1], built.context);
const alignedProject = { ...project, storyboards: [previous, aligned, project.storyboards[2]] };
assert.equal(getSequencePromptHandoffStatus(aligned, alignedProject).kind, 'current');
assert.equal(isSequencePromptHandoffCurrent(aligned, alignedProject), true);
assert.equal(isSequencePromptHandoffCurrent(project.storyboards[1], project), false);
assert.notEqual(aligned.sequencePromptHandoff, built.stamp);

// Preserve the old v1 stamp as old provenance. Adding a timing contract to
// today's evidence must not silently certify yesterday's AI-authored prose.
const legacyEvidence: Record<string, unknown> = { ...built.context };
delete legacyEvidence.sourceFingerprint;
delete legacyEvidence.openingTiming;
const legacyStamp = {
  ...aligned.sequencePromptHandoff!, version: SEQUENCE_PROMPT_HANDOFF_VERSION,
  sourceFingerprint: sourceContentHash(JSON.stringify(legacyEvidence)),
};
const legacyAligned = { ...aligned, sequencePromptHandoff: legacyStamp };
assert.deepEqual(normalizeSequencePromptHandoffStamp(legacyStamp), legacyStamp);
assert.equal(getSequencePromptHandoffStatus(legacyAligned, alignedProject).kind, 'stale');
assert.match(getSequencePromptHandoffStatus(legacyAligned, alignedProject).issue!, /旧稿不会自动视为已按新规则修复/u);
assert.equal(legacyAligned.officialPromptZh, aligned.officialPromptZh);
assert.notEqual(legacyStamp.sourceFingerprint, aligned.sequencePromptHandoff!.sourceFingerprint);

const changedParent = clone(alignedProject);
changedParent.storyboards[0].officialPromptZh += '\n新的末镜修订';
changedParent.storyboards[0].targetOutput!.prompt = changedParent.storyboards[0].officialPromptZh!;
assert.equal(getSequencePromptHandoffStatus(aligned, changedParent).kind, 'stale');
assert.notEqual(buildSequencePromptHandoff(changedParent, 'plan', 'segment-2').context?.sourceFingerprint, built.context.sourceFingerprint);
const changedSelf = { ...aligned, officialPromptZh: `${aligned.officialPromptZh}\n手工改写当前首镜` };
assert.equal(getSequencePromptHandoffStatus(changedSelf, alignedProject).kind, 'stale');
const changedSource = clone(alignedProject);
changedSource.sequencePlans[0].segments[1].content = '修改了本段剧情';
assert.equal(getSequencePromptHandoffStatus(aligned, changedSource).kind, 'stale');
const changedEntry = clone(alignedProject);
changedEntry.sequencePlans[0].segments[0].exitState = '新的离场状态';
assert.equal(getSequencePromptHandoffStatus(aligned, changedEntry).kind, 'stale');
assert.equal(getSequencePromptHandoffStatus(aligned, { ...alignedProject, id: 'another-project' }).kind, 'stale');
assert.notEqual(buildSequencePromptHandoff({ ...project, id: 'another-project' }, 'plan', 'segment-2').context?.sourceFingerprint, built.context.sourceFingerprint);

const harmless = clone(alignedProject);
harmless.updatedAt = 999;
harmless.storyboards[0].updatedAt = 999;
harmless.storyboards[0].officialPromptEn = 'English-only update';
harmless.storyboards[1].officialPromptEn = 'Current English translation';
harmless.storyboards[1].targetOutput!.generatedAt = 999;
assert.equal(getSequencePromptHandoffStatus(harmless.storyboards[1], harmless).kind, 'current');

for (const stamp of [
  { ...aligned.sequencePromptHandoff, version: 'unknown-version' },
  { ...aligned.sequencePromptHandoff, previousSegmentIndex: 7 },
  { ...aligned.sequencePromptHandoff, resultFingerprint: 'false-hash' },
  { ...aligned.sequencePromptHandoff, openingOverlapSec: 1 },
  { ...aligned.sequencePromptHandoff, storyboardId: aligned.sequencePromptHandoff!.previousStoryboardId },
]) {
  assert.equal(normalizeSequencePromptHandoffStamp(stamp), undefined);
  assert.equal(getSequencePromptHandoffStatus({ ...aligned, sequencePromptHandoff: stamp as any }, alignedProject).kind, 'stale');
}
assert.throws(() => stampSequencePromptHandoff(aligned, { ...built.context!, previousFinalPrompt: '篡改父稿' }), /资料已变化/u);
assert.throws(() => stampSequencePromptHandoff(aligned, {
  ...built.context!, openingTiming: { ...timing, firstShotTimingInstruction: '篡改衔接时间语义' },
}), /资料已变化/u, 'the opening timing contract participates in async/result provenance');
assert.throws(() => stampSequencePromptHandoff({ ...aligned, segmentId: 'wrong-segment' }, built.context!), /分段不一致/u);

const noPrevious = clone(project);
noPrevious.storyboards = noPrevious.storyboards.filter((board) => board.id !== previous.id);
assert.match(buildSequencePromptHandoff(noPrevious, 'plan', 'segment-2').issue!, /第 1 段/u);
const noMiddle = clone(project);
noMiddle.sequencePlans[0].segments[1].storyboardId = undefined;
assert.match(buildSequencePromptHandoff(noMiddle, 'plan', 'segment-3').issue!, /第 2 段/u);
const masterInstead = clone(project);
masterInstead.sequencePlans[0].masterStoryboardId = previous.id;
assert.ok(buildSequencePromptHandoff(masterInstead, 'plan', 'segment-2').issue);
const foreign = clone(project);
foreign.storyboards[0].sequencePlanId = 'other-plan';
assert.ok(buildSequencePromptHandoff(foreign, 'plan', 'segment-2').issue);
const wrongIndex = clone(project);
wrongIndex.sequencePlans[0].segments[1].index = 3;
assert.match(buildSequencePromptHandoff(wrongIndex, 'plan', 'segment-2').issue!, /编号/u);
const duplicate = clone(project);
duplicate.storyboards.push(clone(previous));
assert.ok(buildSequencePromptHandoff(duplicate, 'plan', 'segment-2').issue);
const staleSource = clone(project);
staleSource.sequencePlans[0].segments[0].status = 'stale';
assert.match(buildSequencePromptHandoff(staleSource, 'plan', 'segment-2').issue!, /剧情已修改/u);

const canonicalOnly = clone(project);
canonicalOnly.storyboards[0].officialPromptZh = '';
const canonicalResult = buildSequencePromptHandoff(canonicalOnly, 'plan', 'segment-2');
assert.equal(canonicalResult.context?.previousPromptKind, 'canonical');
assert.equal(canonicalResult.context?.previousFinalPrompt, previous.finalPrompt);
assert.match(canonicalResult.context!.previousLastShot!.prompt, /CANONICAL_OLD_TAIL/u);
canonicalOnly.storyboards[0].promptTrace!.mode = 'local-fallback';
assert.match(buildSequencePromptHandoff(canonicalOnly, 'plan', 'segment-2').issue!, /草稿/u);
const staleOfficial = clone(project);
staleOfficial.storyboards[0].officialPromptSource = 'old-invalid-source';
assert.match(buildSequencePromptHandoff(staleOfficial, 'plan', 'segment-2').issue!, /H3稿/u, 'stale H3 cannot silently fall back to canonical shots');
const staleCanonical = clone(project);
staleCanonical.storyboards[0].promptPlan = {
  canonicalPrompt: previous.finalPrompt, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  workflow: 'drama', inputMode: 'text', shotIds: [], referenceAssetIds: [], constraints: [], trace: { ruleSetId: 'rule', converterId: 'converter' },
};
staleCanonical.storyboards[0].finalPrompt += '\n手工改动';
assert.match(buildSequencePromptHandoff(staleCanonical, 'plan', 'segment-2').issue!, /快照不一致/u);

const revision = createStoryboardRevision(aligned as any, { createdAt: 2 });
assert.deepEqual(revision.sequencePromptHandoff, aligned.sequencePromptHandoff);
assert.notEqual(revision.sequencePromptHandoff, aligned.sequencePromptHandoff);
const restored = restoreStoryboardRevisionSnapshot(changedSelf as any, revision) as Storyboard;
assert.equal(getSequencePromptHandoffStatus(restored, alignedProject).kind, 'current');
const legacyRevision = createStoryboardRevision(project.storyboards[1] as any, { createdAt: 1 });
const restoredLegacy = restoreStoryboardRevisionSnapshot(aligned as any, legacyRevision) as Storyboard;
assert.equal(restoredLegacy.sequencePromptHandoff, undefined, 'restoring legacy text must not carry a newer alignment claim');

const persistedProject = clone(alignedProject);
persistedProject.storyboards[1].revisions = [revision as any];
const normalized = normalizeState({
  ...initialState, project: persistedProject, projects: [persistedProject], activeProjectId: persistedProject.id,
});
const saved = normalized.project.storyboards.find((board) => board.id === aligned.id)!;
assert.deepEqual(saved.sequencePromptHandoff, aligned.sequencePromptHandoff);
assert.deepEqual(saved.revisions?.[0].sequencePromptHandoff, revision.sequencePromptHandoff);
assert.equal(saved.officialPromptZh, aligned.officialPromptZh, 'normalization does not rewrite original prompts');
assert.equal(getSequencePromptHandoffStatus(saved, normalized.project).kind, 'current');
const legacyPersisted = clone(alignedProject);
legacyPersisted.storyboards[1] = clone(legacyAligned);
const legacyStoredRevision = createStoryboardRevision(legacyAligned as any, { createdAt: 3 });
legacyPersisted.storyboards[1].revisions = [legacyStoredRevision as any];
const legacyNormalized = normalizeState({
  ...initialState, project: legacyPersisted, projects: [legacyPersisted], activeProjectId: legacyPersisted.id,
});
const legacySaved = legacyNormalized.project.storyboards[1];
assert.deepEqual(legacySaved.sequencePromptHandoff, legacyStamp, 'storage keeps the old stamp without upgrading its fingerprint');
assert.deepEqual(legacySaved.revisions?.[0].sequencePromptHandoff, legacyStamp);
assert.equal(legacySaved.officialPromptZh, legacyAligned.officialPromptZh, 'storage never locally shortens an old opening replay');
assert.equal(getSequencePromptHandoffStatus(legacySaved, legacyNormalized.project).kind, 'stale');
const restoredOldContract = restoreStoryboardRevisionSnapshot(aligned as any, legacyStoredRevision) as Storyboard;
assert.deepEqual(restoredOldContract.sequencePromptHandoff, legacyStamp);
assert.equal(getSequencePromptHandoffStatus(restoredOldContract, alignedProject).kind, 'stale');
const malformedPersisted = clone(persistedProject);
(malformedPersisted.storyboards[1].sequencePromptHandoff as any).version = 'future-unknown';
const malformedNormalized = normalizeState({
  ...initialState, project: malformedPersisted, projects: [malformedPersisted], activeProjectId: malformedPersisted.id,
});
assert.equal(malformedNormalized.project.storyboards[1].sequencePromptHandoff, undefined);
assert.notEqual(getSequencePromptHandoffStatus(malformedNormalized.project.storyboards[1], malformedNormalized.project).kind, 'current');
assert.equal(project.assets.length, 0);
assert.equal(project.generationTasks.length, 0);

console.log('PASS sequence prompt handoff: read-only evidence vs subsecond opening timing, old-stamp compatibility without auto-upgrade, final reviewed text, exact predecessor, bound provenance, revision restore and storage round-trip.');
