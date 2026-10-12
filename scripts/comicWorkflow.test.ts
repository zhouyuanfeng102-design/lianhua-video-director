import assert from 'node:assert/strict';
import type { Project, StoryReferenceAnalysis } from '../src/types';
import { createInitialState } from '../src/storage';
import { chapterWorkspace, migrateProjectChapters } from '../src/chapters';
import { addStoryReference, updateStoryReference, withStoryInputMode, recoverInterruptedStoryReferenceRecognition } from '../src/storyReferences';
import { comicSourceFingerprint, moveComicPage, setStoryComicSettings, setStoryImageSourceMode } from '../src/comicSources';
import { beginComicRecognition, completeComicRecognition, failComicRecognition, loadComicReferenceImages } from '../src/comicWorkflow';
import { comicPanelPixelBounds } from '../src/comicPanelCrop';

const chapterId = 'comic-chapter';
let project: Project = migrateProjectChapters({ ...createInitialState().project,
  sourceDocuments: [{ id: chapterId, name: '漫画章', content: '原有剧情', createdAt: 1, updatedAt: 1 }], activeChapterId: chapterId,
  chapterWorkspaces: {}, scenes: [], storyboards: [], sequencePlans: [], generationTasks: [],
  assets: ['one', 'two'].map((id) => ({ id, name: id, type: 'reference', role: 'composition', mediaType: 'image',
    dataUrl: 'data:image/png;base64,cGl4ZWxz', checksum: id, tags: [], createdAt: 1, updatedAt: 1 })),
});
project = setStoryImageSourceMode(withStoryInputMode(project, 'image', chapterId), 'comic', chapterId);
for (const id of ['one', 'two']) project = addStoryReference(project, id, { id, chapterId, sourceRole: 'comic' });
const analysis = (panelId: string): StoryReferenceAnalysis => ({
  description: '同一次抛灯事件的一个阶段', characters: [], locations: [], props: [], events: [], relationships: [], readableText: [], uncertainties: [],
  style: '', composition: '', lighting: '', colors: '', model: 'offline', analyzedAt: 10, revision: 1,
  comic: { panels: [{ id: panelId, order: 1, bounds: { x: 0.25, y: 0, width: 0.5, height: 0.5 }, description: '铜灯落下',
    characterIds: [], texts: [{ id: 'sfx', type: 'sfx', text: '咚', language: 'zh' }],
    actions: [{ id: panelId, eventId: 'drop-once', action: '落下', result: '着地' }], entryState: '', exitState: '', uncertainties: [] }], uncertainties: [] },
});
const result = { pages: ['one', 'two'].map((id) => ({ referenceId: id, analysis: analysis(id) })), storyText: '铜灯落到地上，发出一声轻响。', model: 'offline' };
const started = beginComicRecognition(project, chapterId, 'first');
assert.equal(comicSourceFingerprint(started.project, chapterId), started.request.sourceFingerprint, 'pending statuses do not invalidate their own request');
assert.equal(chapterWorkspace(started.project, chapterId).storyReferences?.filter((ref) => ref.status === 'recognizing').length, 2);
const completed = completeComicRecognition(started.project, started.request, result, 12);
const draft = chapterWorkspace(completed, chapterId).comicStoryDraft!;
assert.equal(draft.storyText, result.storyText);
assert.equal(draft.sourceFingerprint, comicSourceFingerprint(completed, chapterId), 'draft owns the newly saved evidence');
assert.equal(completed.sourceDocuments[0].content, '原有剧情', 'generating a preview does not adopt or replace source prose');
assert.equal(chapterWorkspace(completed, chapterId).storyReferences?.[0].analysis?.comic?.panels[0].actions[0].eventId,
  chapterWorkspace(completed, chapterId).storyReferences?.[1].analysis?.comic?.panels[0].actions[0].eventId, 'one event remains shared across pages');
assert.equal(completeComicRecognition(completed, started.request, result), completed, 'an already consumed response is harmless');
for (const changed of [
  moveComicPage(started.project, 'two', -1, chapterId),
  setStoryComicSettings(started.project, { dialogueMode: 'chinese' }, chapterId),
  updateStoryReference(started.project, 'one', { notes: '用户修正' }, chapterId),
  updateStoryReference(started.project, 'two', { enabled: false }, chapterId),
  { ...started.project, assets: started.project.assets.filter((asset) => asset.id !== 'one') },
  { ...started.project, id: 'different-project' },
]) assert.equal(completeComicRecognition(changed, started.request, result), changed, 'changed request basis cannot receive late output');
assert.throws(() => completeComicRecognition(started.project, started.request, { ...result, pages: result.pages.slice(0, 1) }), /完整页/);
assert.equal(chapterWorkspace(started.project, chapterId).comicStoryDraft, undefined, 'partial completion is atomic');
const retry = beginComicRecognition(completed, chapterId, 'retry');
const cancelled = failComicRecognition(retry.project, retry.request, '用户取消');
assert.deepEqual(chapterWorkspace(cancelled, chapterId).comicStoryDraft, draft, 'cancel keeps previous preview');
assert.ok(chapterWorkspace(cancelled, chapterId).storyReferences?.every((ref) => ref.analysis?.comic && ref.status !== 'recognizing'), 'cancel retains evidence and clears pending page states');
assert.equal(completeComicRecognition(cancelled, retry.request, result), cancelled, 'cancelled operation cannot later commit');
const newer = beginComicRecognition(retry.project, chapterId, 'newer');
assert.equal(failComicRecognition(newer.project, retry.request, '旧取消'), newer.project, 'an old cancellation cannot cancel a new request');
const recovered = recoverInterruptedStoryReferenceRecognition(retry.project);
assert.ok(chapterWorkspace(recovered, chapterId).storyReferences?.every((ref) => ref.status !== 'recognizing'));
assert.deepEqual(chapterWorkspace(recovered, chapterId).comicStoryDraft, draft, 'restart recovery retains the saved preview');
assert.deepEqual(comicPanelPixelBounds({ x: 0.25, y: 0, width: 0.5, height: 0.5 }, 200, 100), { x: 50, y: 0, width: 100, height: 50 });
assert.deepEqual(comicPanelPixelBounds({ x: 0.99, y: 0.99, width: 0.01, height: 0.01 }, 101, 101), { x: 99, y: 99, width: 2, height: 2 });
assert.throws(() => comicPanelPixelBounds({ x: 0.8, y: 0, width: 0.4, height: 1 }, 200, 100), /区域无效/);
assert.throws(() => comicPanelPixelBounds({ x: 0, y: 0, width: 0, height: 1 }, 200, 100), /区域无效/);
assert.deepEqual(await loadComicReferenceImages([{ assetId: 'one' }, { assetId: 'two' }, { assetId: 'one' }], async (ids) => {
  assert.deepEqual(ids, ['one', 'two'], 'same original is loaded only once');
  return ['one-image', 'two-image'];
}), ['one-image', 'two-image', 'one-image'], 'every page keeps its image even when originals are shared');
await assert.rejects(loadComicReferenceImages([{ assetId: 'one' }, { assetId: 'two' }], async () => ['one-image']), /缺少/);
console.log('Comic workflow: atomic page commit, stale/cancel/restart ownership, preview preservation and crop coordinates passed.');
