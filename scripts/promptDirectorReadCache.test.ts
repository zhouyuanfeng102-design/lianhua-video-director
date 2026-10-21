import assert from 'node:assert/strict';
import { pendingSequencePromptSegmentIds, resolveSequenceSegmentPromptAction } from '../src/appEffects';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { createPromptDirectorReadCache } from '../src/promptDirectorReadCache';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import { buildSequencePromptHandoff, getSequencePromptHandoffStatus } from '../src/sequencePromptHandoff';
import { sourceContentHash } from '../src/sourceContentHash';
import { createInitialState } from '../src/storage';
import type { Project, Storyboard, VideoSequencePlan } from '../src/types';

const source = '林澜推开木门，走到庭院中。';
const finalPrompt = '【0s-15s】 主体：@林澜（平静）[朝向：庭院] 正在 [推开木门，走到庭院中]（准备出发）；空间：前景-木门 中景-林澜 背景-庭院；光影：柔和晨光；镜头：中景固定；台词：无；音效：环境层-[风声] 动作层-[脚步] 情绪层-[无配乐]';
const board: Storyboard = {
  id: 'cache-board', sceneId: 'cache-scene', sourceStoryContent: source, sourceStoryTitle: '庭院',
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style',
  ruleSetId: 'rule', converterPresetId: 'converter', globalLock: '', globalReferenceAssetIds: ['cache-image'],
  shots: [{ id: 'cache-shot', index: 1, startSec: 0, endSec: 15, purpose: '准备出发', subject: '林澜',
    action: '推开木门，走到庭院中', camera: '中景固定', transition: '连续', lighting: '晨光', sound: '风声',
    result: '站在庭院', referenceAssetIds: [], prompt: finalPrompt, locked: false }],
  finalPrompt, sequencePlanId: 'cache-plan', segmentId: 'cache-segment', segmentIndex: 1, segmentCount: 1,
  promptTrace: { modelRuleSetId: 'rule', converterPresetId: 'converter', sourceDocumentIds: [], referenceAssetIds: [],
    generatedAt: 1, mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(finalPrompt) },
  createdAt: 1, updatedAt: 1,
};
const plan: VideoSequencePlan = {
  id: 'cache-plan', title: '庭院', sourceStoryTitle: '庭院', sourceStoryContent: source,
  durationMode: 'fixed', totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced',
  segments: [{ id: 'cache-segment', index: 1, title: '庭院', durationSec: 15, globalStartSec: 0, globalEndSec: 15,
    content: source, summary: source, sourceSceneIds: ['cache-scene'], sourceBeatIds: [], narrativePurpose: '准备出发',
    entryState: '木门旁', exitState: '庭院中', transitionHint: '连续', storyboardId: board.id, status: 'ready' }],
  createdAt: 1, updatedAt: 1,
};
const project: Project = {
  ...createInitialState().project, id: 'cache-project', storyboards: [board], sequencePlans: [plan], locations: [], props: [],
  characters: [{ id: 'cache-character', name: '林澜', gender: '女', apparentAge: '30', race: '人类', appearance: '黑色短发',
    outfit: '灰色外套', signatureProps: '', personality: '平静', motionHabits: '', anchor: '黑色短发', negativeContinuity: '', assetIds: ['cache-image'] }],
  assets: [{ id: 'cache-image', name: '林澜人物图', type: 'reference', role: 'character', mediaType: 'image',
    referenceRole: 'character', sourceEntityId: 'cache-character', sourceEntityKind: 'character', checksum: 'first', tags: [], createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'cache-scene', title: '庭院', content: source, summary: source, characterIds: ['cache-character'],
    propIds: [], locationIds: [], storyboardIds: [board.id], createdAt: 1, updatedAt: 1 }],
};
const fingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
board.seedance25Output = { targetId: 'seedance-2.5', promptZh: '林澜推开木门后走到庭院中，镜头稳定跟随，保持灰色外套与黑色短发。',
  promptEn: 'Lin Lan opens the wooden door and walks into the courtyard.', durationSec: 15, sourceFingerprint: fingerprint,
  englishSourceFingerprint: fingerprint, referenceManifest: [], warnings: [], generatedAt: 1 };
const unchanged = JSON.stringify(project);
const cache = createPromptDirectorReadCache(project);
const segment = plan.segments[0];
assert.strictEqual(cache.officialContext(board), cache.officialContext(board));
assert.strictEqual(cache.officialContext(), cache.officialContext());
assert.strictEqual(cache.seedanceInput(board), cache.seedanceInput(board));
assert.equal(cache.seedanceReady(board), true);
assert.equal(cache.seedanceReady(board, 'en'), true);
assert.strictEqual(cache.promptAction(plan, segment, 'seedance'), cache.promptAction(plan, segment, 'seedance'));
assert.equal(cache.promptAction(plan, segment, 'seedance').action, 'complete');
assert.strictEqual(cache.promptAction(plan, undefined), cache.promptAction(plan, undefined));
for (const format of ['h3', 'seedance'] as const) {
  assert.strictEqual(cache.pendingSegmentIds(plan, format), cache.pendingSegmentIds(plan, format));
  assert.strictEqual(cache.handoff(board, format), cache.handoff(board, format));
  assert.strictEqual(cache.handoffEvidence(plan, segment, format), cache.handoffEvidence(plan, segment, format));
}

// UI snapshots are immutable. Updating any source creates a fresh cache, even
// when the current board/segment still has the same object identity.
const snapshots: Project[] = [
  { ...project, storyboards: [{ ...board, sourceStoryContent: `${source}她停下脚步。` }] },
  { ...project, characters: project.characters.map((character) => ({ ...character, outfit: '蓝色外套' })) },
  { ...project, assets: project.assets.map((asset) => ({ ...asset, checksum: 'changed-reference' })) },
  { ...project, sequencePlans: [{ ...plan, segments: [{ ...segment, status: 'stale' }] }] },
];
for (const snapshot of snapshots) {
  const next = createPromptDirectorReadCache(snapshot);
  const nextBoard = snapshot.storyboards[0]; const nextPlan = snapshot.sequencePlans[0]; const nextSegment = nextPlan.segments[0];
  assert.notStrictEqual(next.officialContext(nextBoard), cache.officialContext(board));
  assert.notStrictEqual(next.seedanceInput(nextBoard), cache.seedanceInput(board));
  assert.deepEqual(next.seedanceInput(nextBoard), buildOfficialSeedanceInput(snapshot, nextBoard));
  for (const language of ['zh', 'en'] as const) assert.equal(next.seedanceReady(nextBoard, language), hasCurrentSeedancePrompt(snapshot, nextBoard, language));
  for (const format of ['h3', 'seedance'] as const) {
    assert.deepEqual(next.pendingSegmentIds(nextPlan, format), pendingSequencePromptSegmentIds(nextPlan, snapshot.storyboards,
      (candidate) => officialH3ContextForStoryboard(snapshot, candidate), format, snapshot));
    assert.deepEqual(next.promptAction(nextPlan, nextSegment, format), resolveSequenceSegmentPromptAction(nextSegment,
      snapshot.storyboards, nextPlan.id, officialH3ContextForStoryboard(snapshot, nextBoard), format, snapshot));
    assert.deepEqual(next.handoff(nextBoard, format), getSequencePromptHandoffStatus(nextBoard, snapshot, format));
    assert.deepEqual(next.handoffEvidence(nextPlan, nextSegment, format), buildSequencePromptHandoff(snapshot, nextPlan.id, nextSegment.id, format));
  }
}
assert.equal(createPromptDirectorReadCache(snapshots[0]).seedanceReady(snapshots[0].storyboards[0]), false, 'changed source cannot retain cached readiness');
assert.equal(createPromptDirectorReadCache(snapshots[3]).promptAction(snapshots[3].sequencePlans[0], snapshots[3].sequencePlans[0].segments[0], 'seedance').action,
  'generate-storyboard', 'changed segment status cannot retain a completed action');
assert.equal(JSON.stringify(project), unchanged, 'display reads preserve saved prompts and source data');
console.log('prompt director snapshot read cache: focused checks passed');
