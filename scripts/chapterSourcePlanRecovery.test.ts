import assert from 'node:assert/strict';
import { chapterPlans, migrateProjectChapters, replaceChapterSourceDocument } from '../src/chapters';
import { materializeSemanticSequencePlan, semanticSegmentStoryContent, validateSemanticSequencePlan } from '../src/semanticSequencePlan';
import { sequencePlanReviewFingerprint } from '../src/sequencePlan';
import { sourceContentHash } from '../src/sourceContentHash';
import { createInitialState } from '../src/storage';
import type { Project, Storyboard, VideoSequencePlan } from '../src/types';

// In-memory source/19-segment fixtures only; no user files, network or tasks.
const source = '旅人走过石桥，说：“到这里等我。”\r\n向导点头，沿河岸前行。';
const chapterId = 'recovery-chapter';
const makePlan = (content = source, id = 'recovery-plan'): VideoSequencePlan => ({
  ...materializeSemanticSequencePlan({
    title: '第1章', story: content, segmentDurationSec: 15, directorSettingsFingerprint: 'saved-director',
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' }, sourceSceneIds: [],
  }, { segmentCount: 19, reason: '保留连续事件', fitStatus: 'balanced', segments: Array.from({ length: 19 }, (_, index) => ({
    title: `第${index + 1}段`, content: `旅人沿河岸推进第${index + 1}段。`, summary: '沿河岸前行', narrativePurpose: '推进事件',
    entryState: '进入河岸', exitState: '继续前行', transitionHint: '沿用末态', boundaryReason: '连续事件', continuityPack: '沿用身份',
    semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: `event-${index}`, description: '前行' }],
      dialogues: index < 2 ? [{ id: `line-${index}`, speaker: '旅人', text: '到这里等我。', language: '中文' }] : [] },
  })) }, { planId: id, now: 2 }), chapterId,
});
const makeBoard = (plan: VideoSequencePlan, index: number): Storyboard => {
  const segment = plan.segments[index];
  const content = semanticSegmentStoryContent(segment);
  const finalPrompt = `【0s-15s】主体：旅人；动作：沿河岸前行${index + 1}；镜头：固定中景；台词：无`;
  const officialPromptZh = `[Shot 1] 旅人沿河岸前行${index + 1}。`;
  return {
    id: `recovery-board-${index}`, chapterId, sequencePlanId: plan.id, segmentId: segment.id, sceneId: '', sourceSceneIds: [],
    sourceStoryContent: content, sourceContentHash: sourceContentHash(content), sourceStale: false,
    durationSec: 15, workflow: 'drama', inputMode: 'text', durationPreset: '15s', shotMode: 'auto', pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'fixture', ruleSetId: 'fixture',
    converterPresetId: 'fixture', globalLock: '', shots: [], finalPrompt, targetModelId: 'minimax-h3', officialPromptZh,
    officialPromptEn: `[Shot 1] A traveler walks along the riverbank ${index + 1}.`, officialPromptEnSource: officialPromptZh,
    officialPromptSource: `official-h3-v7:${sourceContentHash(finalPrompt)}:fixture`,
    targetOutput: { targetId: 'minimax-h3', prompt: officialPromptZh, parameters: {}, referenceManifest: [], warnings: [], generatedAt: 3 },
    promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(finalPrompt),
      modelRuleSetId: 'fixture', converterPresetId: 'fixture', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 3 },
    createdAt: 3, updatedAt: 3,
  };
};
const makeProject = (savedContent = source): Project => {
  const plan = makePlan();
  const storyboards = [0, 1, 2].map((index) => makeBoard(plan, index));
  plan.sourceStale = true;
  plan.segments = plan.segments.map((segment, index) => ({ ...segment,
    status: index < 3 ? 'ready' : 'stale', ...(index < 3 ? { storyboardId: storyboards[index].id } : {}),
  }));
  plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
  return { ...createInitialState().project, id: 'recovery-project', activeChapterId: chapterId,
    sourceDocuments: [{ id: chapterId, name: '第1章', content: savedContent, contentHash: sourceContentHash(savedContent), createdAt: 1, updatedAt: 1 }],
    chapterWorkspaces: { [chapterId]: { storyInputMode: 'text' } }, sequencePlans: [plan], storyboards,
    scenes: Array.from({ length: 7 }, (_, index) => ({ id: `old-scene-${index}`, chapterId, title: '旧场景', content: '旧场景正文',
      summary: '', characterIds: [], propIds: [], storyboardIds: [], sourceStale: true, createdAt: 1, updatedAt: 1 })),
    assets: [], generationTasks: [],
  };
};
let checks = 0;
const test = (label: string, check: () => void) => { check(); checks += 1; console.log(`PASS ${label}`); };

test('same-source saved 19-segment plan restores 3 results and 16 pending segments without touching artifacts', () => {
  const project = makeProject();
  assert.deepEqual(validateSemanticSequencePlan(project.sequencePlans[0]), []);
  const frozen = structuredClone(project);
  const restored = migrateProjectChapters(project);
  const plan = restored.sequencePlans[0];
  assert.equal(plan.sourceStale, undefined);
  assert.equal(plan.segments.filter((segment) => segment.status === 'ready').length, 3);
  assert.equal(plan.segments.filter((segment) => segment.status === 'planned').length, 16);
  assert.equal(plan.totalDurationSec, 285);
  assert.equal(chapterPlans(restored).filter((item) => item.segments.length && !item.sourceStale).length, 1);
  assert.equal(sequencePlanReviewFingerprint(plan), frozen.sequencePlans[0].reviewConfirmedFingerprint);
  assert.deepEqual(restored.storyboards, frozen.storyboards, 'Chinese/English prompts and board provenance are unchanged');
  assert.deepEqual(restored.scenes, frozen.scenes, 'all seven stale scenes stay stale');
  assert.equal(restored.assets, project.assets);
  assert.equal(restored.generationTasks, project.generationTasks);
  assert.deepEqual(project, frozen, 'normalization does not mutate its input');
  assert.deepEqual(migrateProjectChapters(restored), restored, 'the recovered result is idempotent');
});

test('saving a draft already used by a healthy plan preserves that plan and its exact associated results', () => {
  const project = makeProject('已保存旧正文');
  const plan = project.sequencePlans[0];
  delete plan.sourceStale;
  plan.segments = plan.segments.map((segment) => segment.status === 'stale' ? { ...segment, status: 'planned' } : segment);
  const other = { ...makePlan('已保存旧正文', 'older-plan'), sourceStale: false };
  project.sequencePlans.push(other);
  const saved = replaceChapterSourceDocument(project, { ...project.sourceDocuments[0], content: source });
  assert.equal(saved.sourceChanged, true);
  assert.deepEqual(saved.invalidatedPlanIds, ['older-plan']);
  assert.deepEqual(saved.invalidatedStoryboardIds, []);
  assert.deepEqual(saved.project.sequencePlans[0], plan);
  assert.deepEqual(saved.project.storyboards, project.storyboards);
  assert.equal(saved.project.sequencePlans[1].sourceStale, true);
  assert.ok(saved.project.scenes.every((scene) => scene.sourceStale));
  assert.equal(saved.project.assets, project.assets);
  assert.equal(saved.project.generationTasks, project.generationTasks);
});

test('saving the matching draft can recover an earlier false stale flag without rewriting generated results', () => {
  const project = makeProject('已保存旧正文');
  const saved = replaceChapterSourceDocument(project, { ...project.sourceDocuments[0], content: source });
  assert.equal(saved.project.sequencePlans[0].sourceStale, undefined);
  assert.equal(saved.project.sequencePlans[0].segments.filter((segment) => segment.status === 'ready').length, 3);
  assert.equal(saved.project.sequencePlans[0].segments.filter((segment) => segment.status === 'planned').length, 16);
  assert.deepEqual(saved.invalidatedPlanIds, []);
});

test('different text, titles, hashes, chapters and incomplete plan evidence stay stale', () => {
  const changes: Array<(project: Project) => void> = [
    (project) => { project.sourceDocuments[0].content += '新增正文'; project.sourceDocuments[0].contentHash = sourceContentHash(project.sourceDocuments[0].content); },
    (project) => { project.sourceDocuments[0].content = source.replace('\r\n', '\n'); project.sourceDocuments[0].contentHash = sourceContentHash(project.sourceDocuments[0].content); },
    (project) => { project.sourceDocuments[0].name = '其他章名'; },
    (project) => { project.sourceDocuments[0].contentHash = 'wrong-hash'; },
    (project) => { delete project.sequencePlans[0].sourceContentHash; },
    (project) => { project.sequencePlans[0].sourceContentHash = 'wrong-hash'; },
    (project) => { project.sourceDocuments.push({ ...project.sourceDocuments[0], id: 'different-chapter', name: '第2章', content: '另章正文', contentHash: sourceContentHash('另章正文') }); project.sequencePlans[0].chapterId = 'different-chapter'; },
    (project) => { project.sourceDocuments[0].archived = true; },
    (project) => { delete project.sequencePlans[0].semanticPlanningSnapshot; },
    (project) => { project.sequencePlans[0].segments[0].content = ''; },
    (project) => { project.sequencePlans[0].segments[0].sourceSceneIds = ['old-scene-0']; },
    (project) => { project.sequencePlans[0].planningMode = 'master-timeline'; },
  ];
  for (const change of changes) {
    const project = makeProject(); change(project);
    const expectedChapter = project.sequencePlans[0].chapterId;
    const result = migrateProjectChapters(project);
    if (expectedChapter === 'different-chapter') assert.ok(!chapterPlans(result, chapterId).some((plan) => plan.id === project.sequencePlans[0].id));
    assert.equal(result.sequencePlans[0].sourceStale, true);
    assert.ok(result.scenes.every((scene) => scene.sourceStale));
  }
});

test('missing or changed image evidence cannot be unlocked by identical source text', () => {
  for (const change of [
    (project: Project) => { project.chapterWorkspaces![chapterId].storyInputMode = 'image'; },
    (project: Project) => { project.sequencePlans[0].storyReferenceFingerprint = 'historical-image-evidence'; },
    (project: Project) => { project.sequencePlans[0].semanticPlanningSnapshot!.originalSourceContext = {
      id: 'visual-source', chapterId: 'different-chapter', sourceName: '原文', sourceText: source, resultText: source, createdAt: 2,
    }; },
  ]) {
    const project = makeProject(); change(project);
    assert.equal(migrateProjectChapters(project).sequencePlans[0].sourceStale, true);
  }
});

test('only an exact, current associated board restores a ready marker', () => {
  const changes: Array<(board: Storyboard) => void> = [
    (board) => { board.sourceStale = true; }, (board) => { board.chapterId = 'different-chapter'; },
    (board) => { board.sequencePlanId = 'different-plan'; }, (board) => { board.segmentId = 'different-segment'; },
    (board) => { board.sourceStoryContent += '不同剧情'; }, (board) => { board.sourceContentHash = 'wrong-hash'; },
    (board) => { board.durationSec = 30; }, (board) => { board.finalPrompt += '手动改稿'; },
    (board) => { board.promptTrace!.shotPlanMode = 'locally-edited'; },
    (board) => { board.officialPromptSource = 'wrong-h3-source'; },
    (board) => { board.targetOutput!.prompt = '其他H3稿'; },
    (board) => { board.storyReferenceFingerprint = 'different-image-evidence'; },
  ];
  for (const change of changes) {
    const project = makeProject();
    project.sourceDocuments.push({ id: 'different-chapter', name: '第2章', content: '另章正文', contentHash: sourceContentHash('另章正文'), createdAt: 1, updatedAt: 1 });
    change(project.storyboards[0]);
    const frozenBoard = structuredClone(project.storyboards[0]);
    const result = migrateProjectChapters(project);
    assert.equal(result.sequencePlans[0].sourceStale, undefined, 'a valid source plan can be regenerated even when one result is unusable');
    assert.equal(result.sequencePlans[0].segments[0].status, 'planned');
    assert.equal(result.sequencePlans[0].segments[1].status, 'ready');
    assert.deepEqual(result.storyboards[0], frozenBoard, 'an unusable historical result is retained unchanged');
  }
});

test('a stale segment with a valid dialogue-composed result becomes ready; other runtime statuses are preserved', () => {
  const project = makeProject();
  project.sequencePlans[0].segments[0].status = 'stale';
  project.sequencePlans[0].segments[0].failureReason = '旧正文更新标记';
  project.sequencePlans[0].segments[3].status = 'failed';
  project.sequencePlans[0].segments[3].failureReason = '此前真实请求失败';
  project.sequencePlans[0].segments[4].status = 'generating';
  assert.notEqual(project.storyboards[0].sourceStoryContent, project.sequencePlans[0].segments[0].content);
  const result = migrateProjectChapters(project);
  assert.equal(result.sequencePlans[0].segments[0].status, 'ready');
  assert.equal(result.sequencePlans[0].segments[0].failureReason, undefined);
  assert.equal(result.sequencePlans[0].segments[3].status, 'failed');
  assert.equal(result.sequencePlans[0].segments[3].failureReason, '此前真实请求失败');
  assert.equal(result.sequencePlans[0].segments[4].status, 'generating');
});

console.log(`Chapter source-plan recovery: ${checks} targeted in-memory checks passed.`);
