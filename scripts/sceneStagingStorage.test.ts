import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import { buildShots } from '../src/promptEngine';
import type { SceneStaging } from '../src/sceneStaging';
import type { Storyboard } from '../src/types';

// Synthetic conversation and retreat choices; no user projects, model calls,
// geometry verdicts or prompt repair are involved in this persistence test.
const staging: SceneStaging = {
  version: 1, sceneId: 'hall', sourceEventIds: ['conversation'],
  worldRelations: ['来访者在门外，主人位于室内，门槛未被跨越'],
  participants: [
    { id: 'visitor', name: '来访者', position: '门外', bodyFacing: '室内主人', gazeTarget: '主人的脸', actionTarget: '主人' },
    { id: 'host', name: '主人', position: '室内', bodyFacing: '门外来访者', gazeTarget: '来访者' },
  ],
  phases: [{ id: 'step-back', eventId: 'conversation', participantIds: ['visitor'],
    startState: '来访者面向室内', action: '听完后退开', motionPath: '沿门外原路后退',
    motionEndpoint: '仍在门外，离门槛更远', endState: '继续面向室内主人' }],
};
const initial = createInitialState();
const shots = buildShots({
  scene: { id: 'hall', title: '门内外谈话', content: '来访者听完后面向主人退开。',
    characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 },
  characters: [], locations: [], props: [], assets: [], workflow: 'drama', durationSec: 10,
  shotMode: 'exact', shotCount: 1, pace: 'standard', camera: '', lighting: '',
  style: initial.stylePresets[0], extra: '',
  aiPlan: { reason: '同一谈话阶段', sceneStaging: [staging], shots: [{ startSec: 0, endSec: 10,
    purpose: '表现退让', subject: '来访者', action: '面向主人后退', camera: '门外侧面中景',
    transition: '承接同一谈话', lighting: '门外自然光', sound: '脚步声', result: '仍面向主人',
    sourceExcerpt: '来访者听完后面向主人退开。', sceneStaging: [staging] }] },
});
assert.deepEqual(shots[0].sceneStaging, [staging]);
assert.notStrictEqual(shots[0].sceneStaging![0], staging);

const board: Storyboard = {
  id: 'staging-board', sceneId: 'hall', sourceSceneIds: ['hall'], workflow: 'drama', inputMode: 'text',
  durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: initial.stylePresets[0].id,
  ruleSetId: initial.ruleSets[0].id, converterPresetId: initial.converterPresets[0].id,
  globalLock: '', shots, finalPrompt: '保留原稿，不从人物档案重建摄影。',
  sceneStaging: [structuredClone(staging)], createdAt: 1, updatedAt: 2,
};
const revision = createStoryboardRevision(board, { createdAt: 3 });
assert.deepEqual(revision.sceneStaging, board.sceneStaging);
board.sceneStaging![0].participants![0].position = '用户新改的位置';
assert.equal(revision.sceneStaging![0].participants![0].position, '门外');
const restoredRevision = restoreStoryboardRevisionSnapshot(board, revision);
assert.deepEqual(restoredRevision.sceneStaging, [staging]);
restoredRevision.sceneStaging![0].worldRelations!.push('仅改恢复副本');
assert.deepEqual(revision.sceneStaging, [staging]);
const legacyRevision = createStoryboardRevision({ id: board.id, finalPrompt: '历史稿', shots: [] });
assert.equal(Object.hasOwn(legacyRevision, 'sceneStaging'), false);
assert.equal(restoreStoryboardRevisionSnapshot(board, legacyRevision).sceneStaging, undefined,
  'restoring a legacy draft cannot borrow the newer scene');

board.revisions = [revision];
initial.project.storyboards = [board, { ...board, id: 'legacy-board', sceneStaging: undefined, revisions: undefined }];
initial.projects = [initial.project];
const stored = normalizeState(JSON.parse(serializeStateForStorage(initial).serialized));
const storedBoard = stored.project.storyboards.find((item) => item.id === board.id)!;
assert.deepEqual(storedBoard.sceneStaging, board.sceneStaging);
assert.deepEqual(storedBoard.shots[0].sceneStaging, [staging]);
assert.deepEqual(storedBoard.revisions![0].sceneStaging, [staging]);
assert.equal(storedBoard.finalPrompt, board.finalPrompt);
assert.equal(stored.project.storyboards.find((item) => item.id === 'legacy-board')!.sceneStaging, undefined);
assert.deepEqual(normalizeState(stored).project.storyboards, stored.project.storyboards);
console.log('Scene staging: shot materialization, storage and immutable revision restoration passed');
