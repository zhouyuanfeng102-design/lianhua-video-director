import assert from 'node:assert/strict';
import { deleteSequencePlanFromProject } from '../src/sequencePlanDeletion';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { Project, Storyboard, VideoSequencePlan } from '../src/types';

const makeBoard = (id: string, patch: Partial<Storyboard> = {}): Storyboard => ({
  id, chapterId: 'chapter-a', sceneId: 'scene-a', workflow: 'drama', inputMode: 'text',
  durationSec: 30, durationPreset: 'custom', shotMode: 'auto', pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style_cinema',
  ruleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video', globalLock: '身份不变',
  shots: [], finalPrompt: `${id}原稿\n\n保留空行`, englishPrompt: `${id} English\n\nunchanged`,
  officialPromptZh: `${id}中文官方稿`, officialPromptEn: `${id} English official prompt`,
  createdAt: 1, updatedAt: 1, ...patch,
});
const makePlan = (id: string, boardIds: Array<string | undefined>, patch: Partial<VideoSequencePlan> = {}): VideoSequencePlan => ({
  id, chapterId: 'chapter-a', title: '同名方案', sourceStoryTitle: '第 1 章', sourceStoryContent: '原始剧情甲',
  durationMode: 'fixed', totalDurationSec: boardIds.length * 30, segmentDurationSec: 30,
  segmentationMode: 'fixed', fitStatus: 'balanced', planningMode: 'semantic-segments',
  segments: boardIds.map((storyboardId, index) => ({
    id: `${id}-segment-${index + 1}`, index: index + 1, title: `第 ${index + 1} 段`,
    globalStartSec: index * 30, globalEndSec: (index + 1) * 30, durationSec: 30,
    content: '原始剧情甲', summary: '剧情', sourceSceneIds: ['scene-a'], sourceBeatIds: [],
    narrativePurpose: '叙事', entryState: '', exitState: '', transitionHint: '',
    storyboardId, status: storyboardId ? 'ready' : 'planned',
  })), createdAt: 1, updatedAt: 1, ...patch,
});
const makeProject = (): Project => {
  const template = createInitialState().project;
  const plan = makePlan('plan-a', ['board-a', undefined], { masterStoryboardId: 'master-a' });
  const other = makePlan('plan-b', ['board-b']);
  const chapterOther = makePlan('plan-c', ['board-c'], { chapterId: 'chapter-b', sourceStoryContent: '原始剧情乙' });
  const draft = {
    name: '已编辑的单段视频', prompt: '用户修改过的完整英文稿\n\n不要覆盖', backend: 'api',
    parameters: { duration: 30 }, references: [{ assetId: 'asset-a', role: 'composition' }],
    source: { storyboardId: 'board-a', sequencePlanId: 'plan-a', segmentId: 'plan-a-segment-1', language: 'en' },
  };
  return {
    ...template, id: 'project-a', activeChapterId: 'chapter-a',
    sourceDocuments: [
      { id: 'chapter-a', name: '第 1 章', content: '原始剧情甲', createdAt: 1, updatedAt: 1 },
      { id: 'chapter-b', name: '第 2 章', content: '原始剧情乙', createdAt: 1, updatedAt: 1 },
    ],
    sequencePlans: [plan, other, chapterOther],
    storyboards: [makeBoard('master-a'), makeBoard('board-a', { sequencePlanId: plan.id, segmentId: plan.segments[0].id }),
      makeBoard('orphan-a', { sequencePlanId: plan.id }), makeBoard('board-b', { sequencePlanId: other.id }),
      makeBoard('board-c', { sequencePlanId: chapterOther.id, chapterId: 'chapter-b', sourceStoryContent: '原始剧情乙' }), makeBoard('standalone')],
    scenes: [
      { ...template.scenes[0], id: 'scene-a', chapterId: 'chapter-a', content: '原始剧情甲', storyboardIds: ['master-a', 'board-a', 'orphan-a', 'board-b', 'standalone'] },
      { ...template.scenes[0], id: 'scene-b', chapterId: 'chapter-b', content: '原始剧情乙', storyboardIds: ['board-c'] },
    ],
    assets: [{ id: 'asset-a', name: '原图', type: 'reference', role: 'composition', source: 'generated', sourceStoryboardId: 'board-a', tags: [], createdAt: 1, updatedAt: 1 }],
    generationTasks: [{ id: 'task-a', kind: 'video', storyboardId: 'board-a', sequencePlanId: plan.id,
      segmentId: plan.segments[0].id, targetId: 'h3', status: 'running', requestBody: { prompt: '已提交的任务快照' }, createdAt: 1, updatedAt: 1 }],
    chapterWorkspaces: {
      'chapter-a': {
        storyDraft: { name: '未保存原文', content: '不能删除', updatedAt: 1 },
        directorControls: { activePlanId: plan.id, activeSegmentId: plan.segments[0].id, activeStoryboardId: 'board-a',
          confirmedSequencePlanFingerprint: 'confirmed', acknowledgedCompressedPlanFingerprint: 'risk',
          acceptedSequencePlanMismatchFingerprint: 'mismatch', extraRequirement: '保留导演要求' },
        videoDirector: { draft, parameterText: '{}', parameterDrafts: [], generationMode: 'batch',
          batch: { planId: plan.id, selectedKeys: ['board-a:en'], previewSegmentId: plan.segments[0].id } },
      },
      'chapter-b': {
        directorControls: { activePlanId: chapterOther.id, activeSegmentId: chapterOther.segments[0].id, activeStoryboardId: 'board-c' },
        videoDirector: { draft: { ...draft, source: { storyboardId: 'board-c', sequencePlanId: chapterOther.id } },
          generationMode: 'batch', batch: { planId: chapterOther.id, selectedKeys: ['board-c:en'] } },
      },
    },
  };
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const original = freeze(makeProject());
const originalJson = JSON.stringify(original);
const result = deleteSequencePlanFromProject(original, 'plan-a', 200);
const changed = result.project;
assert.deepEqual(result.removedStoryboardIds, ['master-a', 'board-a', 'orphan-a']);
assert.deepEqual(result.removedSegmentIds, ['plan-a-segment-1', 'plan-a-segment-2']);
assert.deepEqual(changed.sequencePlans.map((plan) => plan.id), ['plan-b', 'plan-c']);
assert.deepEqual(changed.storyboards.map((board) => board.id), ['board-b', 'board-c', 'standalone']);
assert.deepEqual(changed.scenes[0].storyboardIds, ['board-b', 'standalone']);
assert.equal(changed.scenes[1], original.scenes[1]);
assert.equal(changed.sequencePlans[0], original.sequencePlans[1], 'same-chapter same-title plan survives untouched');
assert.equal(changed.sequencePlans[1], original.sequencePlans[2], 'other chapter plan survives untouched');
for (const board of changed.storyboards) assert.equal(board, original.storyboards.find((entry) => entry.id === board.id));
for (const field of ['assets', 'generationTasks', 'characters', 'locations', 'props', 'sourceDocuments'] as const) {
  assert.equal(changed[field], original[field], `${field} includes historical data and must not change`);
}
const beforeWorkspace = original.chapterWorkspaces!['chapter-a'];
const afterWorkspace = changed.chapterWorkspaces!['chapter-a'];
assert.equal(afterWorkspace.storyDraft, beforeWorkspace.storyDraft);
assert.deepEqual(afterWorkspace.directorControls, { extraRequirement: '保留导演要求' });
const beforeVideo = beforeWorkspace.videoDirector as { draft: unknown };
const afterVideo = afterWorkspace.videoDirector as { draft: unknown; batch?: unknown; generationMode: string };
assert.equal(afterVideo.draft, beforeVideo.draft, 'single-video text and source evidence both remain exact');
assert.equal(afterVideo.batch, undefined);
assert.equal(afterVideo.generationMode, 'single');
assert.equal(changed.chapterWorkspaces!['chapter-b'], original.chapterWorkspaces!['chapter-b']);
assert.equal(changed.updatedAt, 200);
assert.equal(JSON.stringify(original), originalJson, 'prior project is intact for Undo');

const missing = deleteSequencePlanFromProject(original, 'missing', 200);
assert.equal(missing.project, original);
assert.deepEqual(missing.removedStoryboardIds, []);
assert.deepEqual(missing.removedSegmentIds, []);

// Inconsistent historical links never make another plan's work deletable.
const conflicting = makeProject();
conflicting.sequencePlans[0] = makePlan('plan-a', ['board-a', 'board-b', 'board-c', 'unknown-owner'], { masterStoryboardId: 'master-a' });
conflicting.sequencePlans[1] = makePlan('plan-b', ['board-b', 'master-a', 'board-a']);
conflicting.storyboards.push(makeBoard('unknown-owner', { sequencePlanId: 'missing-foreign-plan' }));
conflicting.storyboards.push(makeBoard('cross-chapter', { chapterId: 'chapter-b' }));
conflicting.sequencePlans[0].segments.push({ ...conflicting.sequencePlans[0].segments[0], id: 'cross-segment', storyboardId: 'cross-chapter' });
freeze(conflicting);
const conflictResult = deleteSequencePlanFromProject(conflicting, 'plan-a', 200);
assert.deepEqual(conflictResult.removedStoryboardIds, ['orphan-a']);
for (const board of conflictResult.project.storyboards) assert.equal(board, conflicting.storyboards.find((entry) => entry.id === board.id));

const collision = makeProject();
collision.sequencePlans[1].segments[0].id = 'plan-a-segment-1';
collision.chapterWorkspaces!['chapter-b'].directorControls = { activePlanId: 'plan-b', activeSegmentId: 'plan-a-segment-1' };
const collisionResult = deleteSequencePlanFromProject(freeze(collision), 'plan-a', 200);
assert.deepEqual(collisionResult.removedSegmentIds, ['plan-a-segment-2']);
assert.equal(collisionResult.project.chapterWorkspaces!['chapter-a'].directorControls!.activeSegmentId, undefined);
assert.equal(collisionResult.project.chapterWorkspaces!['chapter-b'], collision.chapterWorkspaces!['chapter-b']);

const planned = makeProject();
planned.sequencePlans = [makePlan('waiting', [undefined, undefined])];
const plannedResult = deleteSequencePlanFromProject(freeze(planned), 'waiting', 200);
assert.equal(plannedResult.project.sequencePlans.length, 0, 'last ungenerated plan can be deleted');
assert.deepEqual(plannedResult.removedStoryboardIds, []);
assert.equal(plannedResult.project.storyboards, planned.storyboards);
assert.equal(plannedResult.project.scenes, planned.scenes);
assert.equal(plannedResult.project.chapterWorkspaces, planned.chapterWorkspaces);

const state = createInitialState();
const restored = normalizeState(JSON.parse(serializeStateForStorage({ ...state, project: changed,
  projects: [changed], activeProjectId: changed.id }).serialized)).project;
assert.equal(restored.sequencePlans.some((plan) => plan.id === 'plan-a'), false);
assert.equal(restored.storyboards.some((board) => result.removedStoryboardIds.includes(board.id)), false);
assert.equal(restored.scenes.some((scene) => scene.storyboardIds.some((id) => result.removedStoryboardIds.includes(id))), false);
assert.equal(restored.chapterWorkspaces!['chapter-a'].directorControls!.activePlanId, undefined);
assert.equal((restored.chapterWorkspaces!['chapter-a'].videoDirector as { batch?: unknown }).batch, undefined);
assert.equal(restored.assets.some((asset) => asset.id === 'asset-a' && asset.sourceStoryboardId === 'board-a'), true);
assert.equal(restored.generationTasks.some((task) => task.id === 'task-a' && task.storyboardId === 'board-a'), true);
for (const board of changed.storyboards) {
  const reloaded = restored.storyboards.find((entry) => entry.id === board.id)!;
  for (const field of ['finalPrompt', 'englishPrompt', 'officialPromptZh', 'officialPromptEn'] as const) {
    assert.equal(reloaded[field], board[field], `surviving ${board.id} ${field} must remain exact on reload`);
  }
}

console.log('Sequence plan deletion tests passed (exclusive ownership, other plans/chapters, immutable undo, saved drafts, historical outputs and storage reload).');
