import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { chapterWorkspace, withChapterWorkspace } from '../src/chapters';
import { commitStateTransition, takeHistoryStep } from '../src/appEffects';
import { createVideoDirectorProjectSelector, createVideoReconcileSelector, updateVideoDirectorChapterDraft, withCurrentVideoDirectorDrafts } from '../src/videoDirectorState';
import { buildVideoBatchRows, createVideoBatchRowCache, findVideoBatchDuplicate } from '../src/videoBatch';
import type { VideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import type { AppState, Project, Storyboard, VideoSequencePlan } from '../src/types';

const initial = createInitialState();
const chapterId = 'performance-chapter';
const project: Project = { ...initial.project, sourceDocuments: [{ id: chapterId, name: '合成章节', content: '庭院同行', createdAt: 1, updatedAt: 1 }],
  activeChapterId: chapterId, chapterWorkspaces: {}, characters: [], locations: [], props: [], assets: [], generationTasks: [], storyboards: [], sequencePlans: [] };
const state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id };
const draft = (name: string): VideoDirectorChapterDraft => ({ draft: { name, prompt: '原始中文对白保留', backend: 'api', references: [], parameters: {} }, parameterText: '{}', parameterDrafts: [], generationMode: 'batch' });
const firstDraft = draft('初始选择'), latestDraft = draft('本次选择');
const first = updateVideoDirectorChapterDraft(state, project.id, chapterId, firstDraft);
const latest = updateVideoDirectorChapterDraft(first, project.id, chapterId, latestDraft);
assert.equal(updateVideoDirectorChapterDraft(latest, project.id, chapterId, latestDraft), latest);
assert.equal(updateVideoDirectorChapterDraft(latest, project.id, 'removed-chapter', latestDraft), latest);
assert.equal(latest.project.storyboards, project.storyboards);
assert.equal(latest.project.generationTasks, project.generationTasks);
const select = createVideoDirectorProjectSelector();
assert.equal(select(project), project);
assert.equal(select(first.project), project, 'Form persistence does not invalidate candidate source');
assert.equal(select(latest.project), project);
const changedInput = withChapterWorkspace(latest.project, { directorLookRequirement: '新的画面要求' }, chapterId);
assert.equal(select(changedInput), changedInput, 'Other chapter material must invalidate the source');

const snapshots = Array.from({ length: 50 }, (_, index) => ({ ...first, project: { ...first.project, name: '历史名称'+index } }));
const transition = commitStateTransition(first, latest, snapshots, [], false, 50);
assert.deepEqual(transition.undo, snapshots, 'Draft-only commit does not rewrite any history');
assert.equal(transition.undo[0], snapshots[0]);
const step = takeHistoryStep(transition.current, transition.undo, transition.redo);
const restored = withCurrentVideoDirectorDrafts(step.current, latest);
assert.equal(restored.project.name, '历史名称49', 'Content undo still takes effect');
assert.equal(chapterWorkspace(restored.project, chapterId).videoDirector, latestDraft, 'Undo retains the current video form');
assert.equal(restored.project.storyboards, step.current.project.storyboards);
const redo = takeHistoryStep(restored, step.destination, step.source);
assert.equal(chapterWorkspace(withCurrentVideoDirectorDrafts(redo.current, restored).project, chapterId).videoDirector, latestDraft);
const withoutChapter = { ...first, project: { ...first.project, sourceDocuments: [], chapterWorkspaces: {} }, projects: [] };
assert.deepEqual(withCurrentVideoDirectorDrafts(withoutChapter, latest).project.chapterWorkspaces, {}, 'History does not revive removed chapters');

const taskInputs = createVideoReconcileSelector();
const token = taskInputs(state);
assert.equal(taskInputs(first), token, 'Saving a video form does not wake reconciliation');
assert.equal(taskInputs(latest), token);
const assetsChanged = { ...latest, project: { ...latest.project, assets: [...latest.project.assets] } };
assert.notEqual(taskInputs(assetsChanged), token, 'Asset changes still wake reconciliation');
const activeChanged = { ...latest, project: { ...latest.project, id: 'other-active-project' } };
assert.notEqual(taskInputs(activeChanged), taskInputs(latest), 'Active ownership changes still wake reconciliation');

const plan = { id: 'plan', title: '两段合成剧情', segments: [1,2].map(index => ({ id: 'segment-'+index, index, title: '第'+index+'段', storyboardId: 'board-'+index, durationSec: 15 })), createdAt: 1, updatedAt: 1 } as VideoSequencePlan;
const boards = plan.segments.map(segment => ({ id: segment.storyboardId!, sceneId: project.scenes[0]?.id || 'scene', sourceStoryTitle: segment.title,
  sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, durationSec: 15, finalPrompt: '中文原稿'+segment.index, englishPrompt: 'English '+segment.index,
  englishPromptSource: '中文原稿'+segment.index, shots: [], globalReferenceAssetIds: [], globalLock: '', createdAt: 1, updatedAt: 1 } as Storyboard));
const picture = { id: 'picture', name: '隔离参考图', type: 'reference', role: 'general', mediaType: 'image', dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1 } as Project['assets'][number];
const source: Project = { ...project, assets: [picture], storyboards: boards, sequencePlans: [plan] };
const settings = { ...state.settings, videoBackend: 'api' as const, activeVideoApiProfileId: null, videoApiProfiles: [] };
const options = { backend: 'api' as const, promptFormat: 'ordinary' as const, parameters: {} };
const cache = createVideoBatchRowCache();
const rows = buildVideoBatchRows(source, plan, settings, options, cache);
const body = (values: typeof rows) => values.map(row => ({ id: row.id, zh: row.zh?.draft, en: row.en?.draft }));
assert.equal(rows.length, 2);
assert.ok(rows.every(row => row.zh && row.en));
assert.deepEqual(body(rows), body(buildVideoBatchRows(source, plan, settings, options)), 'Cached view retains exact execution drafts');
const formOnly = withChapterWorkspace(source, { videoDirector: latestDraft }, chapterId);
const retained = buildVideoBatchRows(formOnly, plan, settings, options, cache);
assert.equal(retained[0], rows[0]); assert.equal(retained[1], rows[1]);
const selected = { ...options, referenceOverrides: { 'board-1:ordinary:zh': [{ assetId: picture.id, role: 'general' as const }], 'board-1:ordinary:en': [{ assetId: picture.id, role: 'general' as const }] } };
const changed = buildVideoBatchRows(source, plan, settings, selected, cache);
assert.notEqual(changed[0], rows[0]);
assert.equal(changed[1], rows[1], 'Selecting pictures in segment 1 does not rebuild segment 2');
assert.equal(changed[0].zh?.draft.references[0].assetId, picture.id);
assert.deepEqual(body(changed), body(buildVideoBatchRows(source, plan, settings, selected)), 'Image overrides retain uncached request semantics');
const videoUpdate = { ...source, generationTasks: [{ id: 'unrelated-video', kind: 'video', status: 'failed', requestBody: {}, createdAt: 1, updatedAt: 2 } as Project['generationTasks'][number]] };
const taskOnly = buildVideoBatchRows(videoUpdate, plan, settings, selected, cache);
assert.equal(taskOnly[1], changed[1], 'Unrelated video status does not prepare unchanged sources again');
const edited = { ...source, storyboards: source.storyboards.map((board,index) => index ? { ...board, finalPrompt: '新中文原稿', englishPrompt: '', updatedAt: 2 } : board) };
assert.equal(buildVideoBatchRows(edited, plan, settings, selected, cache)[1].zh?.draft.prompt, '新中文原稿');
const identity = changed[0].zh!.requestFingerprint;
const completed = { id: 'completed', kind: 'video', status: 'succeeded', requestFingerprint: identity, requestBody: {}, createdAt: 1, updatedAt: 1 } as Project['generationTasks'][number];
const running = { ...completed, id: 'running', status: 'running' } as Project['generationTasks'][number];
for (const tasks of [[completed], [completed, running, { ...running, id: 'later-running' }], [{ ...running, status: 'failed' }]]) {
  const owner = { ...source, generationTasks: tasks } as Project;
  const indexCache = createVideoBatchRowCache();
  const associated = buildVideoBatchRows(owner, plan, settings, selected, indexCache);
  assert.deepEqual(associated[0].zh?.duplicate, findVideoBatchDuplicate(owner, identity), 'Indexed task priority matches execution');
}
const legacy = { ...completed, id: 'legacy-boundary', requestFingerprint: 'historical-request', videoJob: { stage: 'succeeded', snapshot: {
  projectId: source.id, clientId: 'legacy-client', draft: { ...changed[0].zh!.draft, referenceSlotRoles: undefined },
  connection: { backend: 'api', api: { ...settings.videoTaskApi, provider: 'runninghub', runningHubImageRoles: ['first-frame'] } },
  images: [{ assetId: picture.id, name: picture.name, role: 'general', dataUrl: picture.dataUrl, freezeState: 'frozen', frozenAt: 1 }],
} } } as Project['generationTasks'][number];
const legacyProject = { ...source, generationTasks: [legacy] };
const legacyCache = createVideoBatchRowCache();
buildVideoBatchRows(legacyProject, plan, settings, selected, legacyCache);
assert.equal(legacyCache.duplicates.size, 2, 'Legacy task keeps its stored identity and existing normalized boundary alias');
for (const [key,value] of legacyCache.duplicates) assert.deepEqual(value, findVideoBatchDuplicate(legacyProject,key));
const chained = structuredClone(legacy) as typeof legacy & { videoJob: { snapshot: { batchPredecessorTaskId?: string } } };
chained.videoJob.snapshot.batchPredecessorTaskId = 'predecessor';
const chainCache = createVideoBatchRowCache();
buildVideoBatchRows({ ...source, generationTasks: [chained] }, plan, settings, selected, chainCache);
assert.equal(chainCache.duplicates.size, 1, 'Dependency tasks retain exact chain identity');
console.log('Video director targeted state, history, task-input and candidate-cache checks passed.');
