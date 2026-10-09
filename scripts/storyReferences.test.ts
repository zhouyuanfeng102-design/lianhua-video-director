import assert from 'node:assert/strict';
import type { Character, Project, ReferenceAsset, StoryReferenceAnalysis, Storyboard } from '../src/types';
import { migrateProjectChapters, withChapterSelection, chapterWorkspace } from '../src/chapters';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { deleteAssetFromProject } from '../src/assetDeletion';
import { assetReferenceCharacterOwners, bindAssetCharacter } from '../src/assetCharacterBinding';
import { normalizeStoryVisualConversionSnapshot } from '../src/semanticSequencePlan';
import {
  addStoryReference, applyStoryReferenceBindings, beginStoryReferenceRecognition, buildStoryReferenceContext,
  completeStoryReferenceRecognition, failStoryReferenceRecognition, normalizeStoryReferenceWorkspace,
  removeStoryReference, storyReferenceAssetSubjectMap, storyReferenceFingerprint, updateStoryReference,
  withStoryInputMode, withStoryNarrator,
} from '../src/storyReferences';

const asset = (id: string): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition', mediaType: 'image',
  checksum: `checksum-${id}`, dataUrl: 'data:image/png;base64,cGl4ZWxz', tags: [], createdAt: 1, updatedAt: 1 });
const character = (id: string, name: string): Character => ({ id, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] });
const board = { id: 'board-a', chapterId: 'a', sceneId: 'scene-a', shots: [], finalPrompt: '保留已生成的视频提示词', createdAt: 1, updatedAt: 1 } as Storyboard;
const base = (): Project => migrateProjectChapters({
  id: 'reference-project', name: '参考图剧情', description: '', activeChapterId: 'a',
  sourceDocuments: ['a', 'b'].map((id) => ({ id, name: id, content: `${id}章原文。`, createdAt: 1, updatedAt: 1 })),
  characters: [character('alice', '阿莉'), character('bob', '小博')], locations: [], props: [], assets: [asset('one'), asset('two')],
  scenes: [{ id: 'scene-a', chapterId: 'a', title: '两人互动', content: '阿莉和小博交谈。', summary: '', characterIds: ['alice', 'bob'],
    propIds: [], storyboardIds: ['board-a'], createdAt: 1, updatedAt: 1 }], storyboards: [board], sequencePlans: [], generationTasks: [], createdAt: 1, updatedAt: 1,
});
const evidence = (description = '左侧红衣人物，右侧蓝衣人物站在港口。'): StoryReferenceAnalysis => ({
  description, characters: [{ id: 'left', label: '左侧红衣人物', description: '红色外套，站在左侧。', fields: { appearance: '黑发、红色外套', detail: '完整细节'.repeat(1800) } },
    { id: 'right', label: '右侧蓝衣人物', description: '蓝色衣服，站在右侧。', fields: { outfit: '蓝色衣服' } }],
  locations: [{ id: 'harbor', label: '港口', description: '木栈桥与船只。', fields: {} }], props: [], events: ['两人交谈'], relationships: ['两人相对而立，关系未知'],
  readableText: ['招牌：欢迎'], uncertainties: ['无法确定姓名'], style: '水彩', composition: '双人中景', lighting: '夕照', colors: '暖色',
  model: 'vision-test', analyzedAt: 2, revision: 1, rawResponse: '未删减模型回复', structuredData: { nested: { flag: true, tokens: ['完整未知字段'] } },
});
const recognize = (project: Project, referenceId: string, analysis = evidence(), chapterId = 'a'): Project => {
  const begun = beginStoryReferenceRecognition(project, referenceId, `request-${referenceId}`, chapterId, 2);
  return completeStoryReferenceRecognition(begun.project, begun.request, analysis, 3);
};

// Chapter labels are persisted identities, not array positions; switching modes preserves text.
let project = withStoryInputMode(base(), 'image', 'a');
project = addStoryReference(project, 'one', { id: 'ref-one', chapterId: 'a', now: 1 });
project = addStoryReference(project, 'two', { id: 'ref-two', chapterId: 'a', now: 1 });
assert.deepEqual(chapterWorkspace(project, 'a').storyReferences?.map((item) => item.number), [1, 2]);
project = removeStoryReference(project, 'ref-one', 'a');
project = addStoryReference(project, 'one', { id: 'ref-three', chapterId: 'a', now: 1 });
assert.deepEqual(chapterWorkspace(project, 'a').storyReferences?.map((item) => item.number), [2, 3]);
assert.equal(chapterWorkspace(project, 'a').nextStoryReferenceNumber, 4);
assert.equal(project.assets.length, 2, 'removing a chapter association retains the shared asset');
assert.throws(() => buildStoryReferenceContext(project, 'a'), /尚未完成 AI 识图/u);
const pureText = withStoryInputMode(project, 'text', 'a');
assert.equal(buildStoryReferenceContext(pureText, 'a'), undefined);
assert.deepEqual(pureText.sourceDocuments, project.sourceDocuments);
assert.deepEqual(chapterWorkspace(withChapterSelection(project, 'b'), 'a').storyReferences, chapterWorkspace(project, 'a').storyReferences);
assert.equal(chapterWorkspace(withChapterSelection(project, 'b')).storyReferences, undefined);

// Async results go to their original chapter and reject deleted/replaced/newer requests.
let started = beginStoryReferenceRecognition(project, 'ref-two', 'request-old', 'a', 4);
let switched = withChapterSelection(started.project, 'b');
switched = completeStoryReferenceRecognition(switched, started.request, evidence(), 5);
assert.equal(switched.activeChapterId, 'b');
assert.equal(chapterWorkspace(switched, 'a').storyReferences?.[0].status, 'ready');
assert.equal(chapterWorkspace(switched, 'b').storyReferences, undefined);
const newer = beginStoryReferenceRecognition(started.project, 'ref-two', 'request-new', 'a', 5);
assert.equal(completeStoryReferenceRecognition(newer.project, started.request, evidence(), 6), newer.project);
const removed = removeStoryReference(started.project, 'ref-two', 'a');
assert.equal(completeStoryReferenceRecognition(removed, started.request, evidence(), 6), removed);
const replaced = { ...started.project, assets: started.project.assets.map((item) => item.id === 'two' ? { ...item, checksum: 'changed-pixels' } : item) };
assert.equal(completeStoryReferenceRecognition(replaced, started.request, evidence(), 6), replaced);

project = recognize(recognize(project, 'ref-two'), 'ref-three');
project = updateStoryReference(project, 'ref-two', { fullDescription: '人工纠正：背景是车站。', notes: '让他们改谈旅行计划。', subjectBindings: [
  { subjectId: 'left', kind: 'character', entityId: 'alice', name: '阿莉' },
  { subjectId: 'right', kind: 'character', entityId: 'bob', name: '小博' },
] }, 'a');
let context = buildStoryReferenceContext(project, 'a')!;
assert.ok(context.text.includes('完整细节'.repeat(1800)), 'never truncate any recognized image fields');
assert.ok(context.text.includes('完整未知字段'));
assert.ok(context.text.includes('人工纠正：背景是车站。'));
assert.ok(context.text.includes('未删减模型回复'));
assert.equal(context.references.length, 2);
assert.equal(storyReferenceAssetSubjectMap(context).two.filter((item) => item.kind === 'character').length, 2);
const frozen = JSON.stringify(context);
project = updateStoryReference(project, 'ref-two', { notes: '新的剧情备注' }, 'a');
assert.notEqual(storyReferenceFingerprint(project, 'a'), context.fingerprint);
assert.equal(JSON.stringify(context), frozen, 'request provenance must not change with editor state');
assert.ok(project.scenes[0].sourceStale);
assert.equal(project.storyboards[0].finalPrompt, '保留已生成的视频提示词');

// Rerecognition keeps accepted history and corrections, without reusing an ID for a different person.
started = beginStoryReferenceRecognition(project, 'ref-two', 'retry', 'a', 7);
project = failStoryReferenceRecognition(started.project, started.request, '网络失败', 8);
assert.equal(chapterWorkspace(project, 'a').storyReferences?.[0].analysis?.description, evidence().description);
started = beginStoryReferenceRecognition(project, 'ref-two', 'retry-two', 'a', 9);
const swapped = evidence('重新描述');
swapped.characters[0].description = '不同的人被分配到同一主体 ID。';
swapped.characters[0].label = '全新主体';
project = completeStoryReferenceRecognition(started.project, started.request, swapped, 10);
const revised = chapterWorkspace(project, 'a').storyReferences![0];
assert.equal(revised.analysis?.revision, 2);
assert.equal(revised.analysisHistory?.length, 1);
assert.equal(revised.fullDescription, '人工纠正：背景是车站。');
assert.equal(revised.subjectBindings.some((item) => item.subjectId === 'left'), false);
assert.equal(revised.subjectBindings.some((item) => item.subjectId === 'right'), true);
project = updateStoryReference(project, 'ref-two', { subjectBindings: [
  { subjectId: 'left', kind: 'character', entityId: 'alice' }, { subjectId: 'right', kind: 'character', entityId: 'bob' },
] }, 'a');

// Copy the adopted analysis into a second chapter, rather than editing a global record.
project = addStoryReference(project, 'two', { id: 'chapter-b-ref', chapterId: 'b', now: 11 });
assert.equal(chapterWorkspace(project, 'b').storyReferences![0].analysis?.revision, 2);
assert.notEqual(chapterWorkspace(project, 'b').storyReferences![0].analysis, revised.analysis);
assert.deepEqual(chapterWorkspace(project, 'b').storyReferences![0].subjectBindings, []);
project = withStoryNarrator(project, { name: '我', description: '不在参考图中的旅行者。' }, 'a');
assert.equal(buildStoryReferenceContext(project, 'a')?.narrator?.name, '我');

// Bind two people in one image. Invalid subjects and another chapter never receive the asset.
project = { ...project, scenes: project.scenes.map((scene) => ({ ...scene, sourceStale: false })) };
project = applyStoryReferenceBindings(project, 'a', { characters: [
  { name: '阿莉', storyReferenceBindings: [{ referenceId: 'ref-two', subjectId: 'left' }] },
  { name: '小博', storyReferenceBindings: [{ referenceId: 'ref-two', subjectId: 'not-real' }] },
], scenes: [{ title: '两人互动', referenceAssetIds: ['two', 'nonexistent'] }] });
assert.ok(project.characters.every((item) => item.assetIds.includes('two')), 'explicit user bindings attach every character in the image');
assert.deepEqual(project.assets.find((item) => item.id === 'two')?.storyReferenceSubjects?.map((item) => item.entityId), ['alice', 'bob']);
assert.deepEqual(assetReferenceCharacterOwners(project, project.assets.find((item) => item.id === 'two')!).map((item) => item.id), ['alice', 'bob']);
const manualSingle = bindAssetCharacter(project, 'two', 'alice');
assert.deepEqual(assetReferenceCharacterOwners(manualSingle, manualSingle.assets.find((item) => item.id === 'two')!).map((item) => item.id), ['alice']);
assert.deepEqual(project.scenes[0].storyReferenceAssetIds, ['two']);
assert.ok(project.scenes[0].storyReferenceContext);

// Source snapshots and complete reference state survive JSON export, load and chapter migration.
context = buildStoryReferenceContext(project, 'a')!;
project.storyVisualConversions = [{ id: 'conversion', chapterId: 'a', sourceName: 'a', sourceText: '转换前', resultText: '转换后', createdAt: 12,
  storyReferenceContext: context, referenceFingerprint: context.fingerprint }];
const initial = createInitialState();
const state = { ...initial, project, projects: [project], activeProjectId: project.id };
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized)).project;
assert.deepEqual(chapterWorkspace(reloaded, 'a').storyReferences, normalizeStoryReferenceWorkspace(chapterWorkspace(project, 'a')).storyReferences);
assert.equal(chapterWorkspace(reloaded, 'a').nextStoryReferenceNumber, 4);
assert.deepEqual(chapterWorkspace(reloaded, 'a').storyNarrator, chapterWorkspace(project, 'a').storyNarrator);
assert.deepEqual(reloaded.storyVisualConversions?.[0].storyReferenceContext, context);
assert.equal(reloaded.scenes[0].storyReferenceContext?.references[0].analysis.rawResponse, '未删减模型回复');
assert.deepEqual(migrateProjectChapters(reloaded), reloaded, 'repeated migrations remain idempotent');
assert.deepEqual(normalizeStoryVisualConversionSnapshot(project.storyVisualConversions[0])?.storyReferenceContext, context);
assert.equal(buildStoryReferenceContext(base(), 'a'), undefined, 'legacy chapters keep text behavior');
assert.deepEqual(normalizeStoryReferenceWorkspace({ storyReferences: [{ id: 'x', assetId: 'one', number: 5 }, { id: 'y', assetId: 'two', number: 5 }], nextStoryReferenceNumber: 2 }).storyReferences?.map((item) => item.number), [5, 6]);
started = beginStoryReferenceRecognition(project, 'ref-two', 'interrupted', 'a');
const recovered = normalizeState({ ...state, project: started.project, projects: [started.project] }).project;
assert.equal(chapterWorkspace(recovered, 'a').storyReferences?.[0].status, 'failed');
assert.ok(chapterWorkspace(recovered, 'a').storyReferences?.[0].analysis);

// Global deletion cancels live recognition and keeps the missing reference explanation/history.
const deleted = deleteAssetFromProject(started.project, 'two', 20);
assert.equal(deleted.assets.some((item) => item.id === 'two'), false);
assert.ok(deleted.characters.every((item) => !item.assetIds.includes('two')));
assert.deepEqual(deleted.scenes[0].storyReferenceAssetIds, []);
assert.equal(deleted.storyboards[0].finalPrompt, '保留已生成的视频提示词');
assert.equal(chapterWorkspace(deleted, 'a').storyReferences![0].number, 2);
assert.ok(chapterWorkspace(deleted, 'a').storyReferences![0].analysisHistory?.length);
assert.throws(() => buildStoryReferenceContext(deleted, 'a'), /原图已缺失/u);
assert.equal(completeStoryReferenceRecognition(deleted, started.request, evidence(), 21), deleted);
assert.equal(deleted.storyVisualConversions?.[0].storyReferenceContext?.references[0].assetId, 'two', 'historical provenance survives deletion');

console.log('story reference domain, chapter isolation, async ownership, full evidence, asset bindings and persistence checks passed');
