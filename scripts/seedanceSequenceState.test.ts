import assert from 'node:assert/strict';
import {
  buildSequencePromptManifest,
  buildSequencePromptText,
  isSequenceSegmentComplete,
  pendingSequencePromptSegmentIds,
  resolveSequenceSegmentPromptAction,
} from '../src/appEffects';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import {
  buildSequencePromptHandoff,
  getSequencePromptHandoffStatus,
  stampSequencePromptHandoff,
} from '../src/sequencePromptHandoff';
import { normalizeSequencePromptHandoffStamp } from '../src/sequencePromptHandoffStamp';
import { sourceContentHash } from '../src/sourceIntegrity';
import { createInitialState, normalizeState } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import type { Project, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const initial = createInitialState();
const canonical = '【0s-15s】 主体：@师傅（平静）[朝向：徒弟] 正在 [递交药草]（完成交接）；空间：前景-药草 中景-师徒 背景-山道；光影：柔和晨光；镜头：中景稳定拍摄；台词：无；音效：环境层-[风声] 动作层-[无] 情绪层-[无配乐]';
const segments: VideoSegment[] = [1, 2, 3].map((index) => ({
  id: `segment-${index}`, index, title: `第 ${index} 段`, globalStartSec: (index - 1) * 15,
  globalEndSec: index * 15, durationSec: 15, content: '师傅递药草，徒弟接住。', summary: '交接',
  sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '交接', entryState: '伸手', exitState: '药草交接',
  transitionHint: '连续', continuityPack: '保持站位', status: 'ready', storyboardId: `board-${index}`,
}));
const plan: VideoSequencePlan = {
  id: 'seedance-plan', title: '药草交接', sourceStoryTitle: '药草交接', sourceStoryContent: '师傅递药草，徒弟接住。',
  durationMode: 'fixed', requestedTotalDurationSec: 45, totalDurationSec: 45, segmentDurationSec: 15,
  segmentationMode: 'fixed', fitStatus: 'balanced', segments, createdAt: 1, updatedAt: 1,
};
const project: Project = {
  ...initial.project, id: 'seedance-state-project', assets: [], characters: [], locations: [], props: [], scenes: [],
  storyboards: [], sequencePlans: [plan],
};
project.storyboards = segments.map((segment): Storyboard => ({
  id: segment.storyboardId!, sceneId: '', sourceSceneIds: [], sourceStoryContent: segment.content,
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
  pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
  converterPresetId: '', globalLock: '', finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index,
  shots: [{ id: `shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, purpose: '交接', subject: '师徒',
    action: '交接药草', camera: '中景', lighting: '晨光', sound: '风声', transition: '连续', referenceAssetIds: [],
    prompt: canonical, locked: false }],
  promptTrace: { modelRuleSetId: '', converterPresetId: '', sourceDocumentIds: [], referenceAssetIds: [],
    generatedAt: 1, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonical) },
}));

const saveSeedance = (board: Storyboard, translated = true): Storyboard => {
  const fingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
  const promptZh = `视频规格：时长 15 秒。\n一句话概述：师傅递药草，徒弟接住。\n连续时间轴（覆盖 0–15 秒）：\n【0s-15s】第 ${board.segmentIndex} 段，师傅递药草，徒弟接住后查看。`;
  return { ...board, seedance25Output: {
    targetId: 'seedance-2.5', promptZh, durationSec: 15, sourceFingerprint: fingerprint,
    referenceManifest: [], warnings: [], generatedAt: 2,
    ...(translated ? { promptEn: `At 0–15 seconds, segment ${board.segmentIndex}: the pupil receives the herbs.`, englishSourceFingerprint: fingerprint } : {}),
  } };
};

const board = project.storyboards[0];
const context = officialH3ContextForStoryboard(project, board);
const official = applyOfficialH3Prompt(board, context);
official.officialPromptEn = 'integrated_multimodal_description: [Shot 1] The pupil receives the herbs.\noverall_soundscape: Wind.\nnon_diegetic_music: N/A';
official.officialPromptEnSource = official.officialPromptZh;
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [official], plan.id, context).action, 'complete', 'legacy omitted target still uses H3');
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [official], plan.id, context, 'seedance', project).action, 'refresh-official', 'valid H3 does not mark Seedance complete');
const chineseOnly = saveSeedance(board, false);
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [chineseOnly], plan.id, context, 'seedance', project).action, 'translate-english');
const complete = saveSeedance(board);
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [complete], plan.id, context, 'seedance', project).action, 'complete');
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [complete], plan.id, context).action, 'refresh-official', 'Seedance does not mark H3 complete');
assert.equal(resolveSequenceSegmentPromptAction({ ...segments[0], status: 'failed' }, [chineseOnly], plan.id, context, 'seedance', project).action, 'translate-english', 'a failed translation reuses the public storyboard and Chinese checkpoint');
assert.equal(resolveSequenceSegmentPromptAction({ ...segments[0], status: 'failed' }, [board], plan.id, context, 'seedance', project).action, 'refresh-official', 'a failed target writer does not repeat public planning');
assert.equal(resolveSequenceSegmentPromptAction({ ...segments[0], status: 'stale' }, [complete], plan.id, context, 'seedance', project).action, 'generate-storyboard');
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [{ ...complete, finalPrompt: '手工改稿' }], plan.id, context, 'seedance', project).action, 'generate-storyboard');
assert.equal(resolveSequenceSegmentPromptAction(segments[0], [{ ...complete, resolution: '1080p' }], plan.id, context, 'seedance', project).action, 'refresh-official', 'source changes invalidate the selected target');
assert.equal(isSequenceSegmentComplete(segments[0], [board], plan.id), true, 'public checkpoint completeness remains independent from target artifacts');
assert.deepEqual(pendingSequencePromptSegmentIds(plan, [complete, project.storyboards[1], project.storyboards[2]], () => context, 'seedance', project), ['segment-2', 'segment-3']);
assert.deepEqual(pendingSequencePromptSegmentIds({ ...plan, segments: segments.map((segment, index) => index === 1 ? { ...segment, locked: true } : segment) }, project.storyboards, () => context, 'seedance', project), ['segment-1', 'segment-3']);

project.storyboards = project.storyboards.map((saved) => saveSeedance(saved));
// Keep H3 around as an independently selected delivered format.
project.storyboards[0] = { ...official, seedance25Output: project.storyboards[0].seedance25Output };
const first = project.storyboards[0];
const second = project.storyboards[1];
const built = buildSequencePromptHandoff(project, plan.id, segments[1].id, 'seedance');
assert.equal(built.issue, undefined);
assert.equal(built.context?.previousPromptKind, 'seedance');
assert.equal(built.context?.previousFinalPrompt, first.seedance25Output?.promptZh, 'selected target is literal predecessor evidence');
assert.equal(built.context?.previousTargetSourceFingerprint, first.seedance25Output?.sourceFingerprint);
assert.equal(built.context?.previousLastShot, undefined, 'do not invent a canonical shot excerpt for unconstrained Seedance prose');
assert.equal(built.stamp?.promptFormat, 'seedance');
const legacyBuilt = buildSequencePromptHandoff(project, plan.id, segments[1].id);
assert.equal(legacyBuilt.issue, undefined);
const h3Aligned = stampSequencePromptHandoff(second, legacyBuilt.context!);
const aligned = stampSequencePromptHandoff(h3Aligned, built.context!);
assert.deepEqual(aligned.sequencePromptHandoff, h3Aligned.sequencePromptHandoff, 'Seedance alignment keeps existing H3 stamp');
assert.equal(aligned.finalPrompt, canonical, 'Seedance body never masquerades as public canonical');
assert.equal(aligned.seedance25Output?.sequencePromptHandoff?.promptFormat, 'seedance');
project.storyboards[1] = aligned;
assert.equal(getSequencePromptHandoffStatus(aligned, project, 'seedance').kind, 'current');
assert.equal(getSequencePromptHandoffStatus(aligned, project).kind, 'current', 'both saved formats remain aligned');
const englishOnly = clone(project);
englishOnly.storyboards[0].seedance25Output!.promptEn = 'A new English translation only.';
englishOnly.storyboards[1].seedance25Output!.promptEn = 'A new current translation only.';
assert.equal(getSequencePromptHandoffStatus(englishOnly.storyboards[1], englishOnly, 'seedance').kind, 'current');
const h3Changed = clone(project);
h3Changed.storyboards[0].officialPromptZh += '\nH3独立修改';
assert.equal(getSequencePromptHandoffStatus(h3Changed.storyboards[1], h3Changed, 'seedance').kind, 'current', 'H3 prose does not invalidate Seedance continuity');
const parentChanged = clone(project);
parentChanged.storyboards[0].seedance25Output!.promptZh += '\nSeedance末态已改';
assert.equal(getSequencePromptHandoffStatus(parentChanged.storyboards[1], parentChanged, 'seedance').kind, 'stale');
const selfChanged = clone(project);
selfChanged.storyboards[1].seedance25Output!.promptZh += '\nSeedance首镜已改';
assert.equal(getSequencePromptHandoffStatus(selfChanged.storyboards[1], selfChanged, 'seedance').kind, 'stale');
const noTarget = clone(project);
delete noTarget.storyboards[0].seedance25Output;
assert.match(buildSequencePromptHandoff(noTarget, plan.id, segments[1].id, 'seedance').issue!, /Seedance/u, 'missing Seedance cannot silently borrow H3');
const staleOwnSource = clone(project);
staleOwnSource.storyboards[1].resolution = '1080p';
assert.equal(getSequencePromptHandoffStatus(staleOwnSource.storyboards[1], staleOwnSource, 'seedance').kind, 'stale');
assert.equal(normalizeSequencePromptHandoffStamp({ ...aligned.seedance25Output?.sequencePromptHandoff, promptFormat: 'other' }), undefined);
const seedanceManifest = buildSequencePromptManifest(plan, project.storyboards, 'seedance', project);
assert.equal(seedanceManifest.segments[0].promptFormat, 'seedance');
assert.equal(seedanceManifest.segments[0].finalPrompt, first.seedance25Output?.promptZh);
assert.equal(seedanceManifest.segments[0].canonicalPrompt, canonical);
assert.equal(buildSequencePromptManifest(plan, project.storyboards).segments[0].promptFormat, 'h3', 'legacy exporter default stays H3');
assert.equal(buildSequencePromptManifest(plan, staleOwnSource.storyboards, 'seedance', staleOwnSource).segments[1].promptFormat, 'pending', 'a stale selected target must not export H3/canonical under its name');
assert.match(buildSequencePromptText(plan, project.storyboards, 'seedance', project), /提示词格式：Seedance 交付稿/u);

const revision = createStoryboardRevision(aligned, { createdAt: 4 });
const restored = restoreStoryboardRevisionSnapshot(selfChanged.storyboards[1], revision) as Storyboard;
assert.deepEqual(restored.seedance25Output?.sequencePromptHandoff, aligned.seedance25Output?.sequencePromptHandoff);
const saved = normalizeState({ ...initial, project, projects: [project], activeProjectId: project.id });
const savedBoard = saved.project.storyboards.find((candidate) => candidate.id === aligned.id)!;
assert.equal(hasCurrentSeedancePrompt(saved.project, savedBoard), true);
assert.deepEqual(savedBoard.seedance25Output?.sequencePromptHandoff, aligned.seedance25Output?.sequencePromptHandoff, 'restart retains target-specific alignment');
assert.equal(getSequencePromptHandoffStatus(savedBoard, saved.project, 'seedance').kind, 'current');
assert.deepEqual(savedBoard.sequencePromptHandoff, aligned.sequencePromptHandoff, 'restart does not replace legacy H3 provenance');

console.log('PASS Seedance sequence state: target-specific completion, public checkpoint retries, selected predecessor, independent H3/Seedance alignment, source edits, revision restore and persistence.');
