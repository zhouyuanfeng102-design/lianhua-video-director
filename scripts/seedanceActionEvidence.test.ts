import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { SEEDANCE_CHINESE_WRITER_RULE } from '../src/seedancePromptRules';
import { semanticSegmentStoryContent, type SemanticSegmentSourceContext } from '../src/semanticSequencePlan';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { Storyboard, StoryVisualConversionSnapshot, VideoSequencePlan } from '../src/types';

const makeFixture = () => {
  const state = createInitialState();
  const chapterId = state.project.sourceDocuments[0].id;
  state.project.activeChapterId = chapterId;
  const first = '甲抬脚踢出木箱，木箱沿走廊朝乙飞去。乙侧身避开，木箱撞上后墙。';
  const second = '乙转动门把手，推开门。';
  const story = `${first}\n\n${second}`;
  const snapshot: StoryVisualConversionSnapshot = {
    id: 'action-conversion', chapterId, sourceName: '走廊剧情', createdAt: 1,
    sourceText: '甲把木箱踢向乙。乙躲开，木箱撞墙。\n\n乙开门。', resultText: story,
    actionPlan: { version: 1, summary: '木箱飞过走廊，乙随后开门',
      sourceParagraphs: [{ id: 'p1', text: '甲把木箱踢向乙。乙躲开，木箱撞墙。' }, { id: 'p2', text: '乙开门。' }],
      events: [
        { id: 'kick', sourceParagraphIds: ['p1'], evidence: '甲把木箱踢向乙。乙躲开，木箱撞墙。', actor: '甲', target: '乙',
          action: '踢出木箱', phases: ['甲踢中木箱', '木箱飞向乙', '乙避开', '木箱撞墙'], result: '木箱撞墙，未击中乙', uncertainties: [] },
        { id: 'open', sourceParagraphIds: ['p2'], evidence: '乙开门。', actor: '乙', target: '门',
          action: '开门', phases: ['门打开'], result: '门打开', uncertainties: [] },
      ] },
    paragraphs: [
      { id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['kick'], text: first, stagingAdditions: ['乙侧身避开，原文未说明具体避让方式。'] },
      { id: 'v2', sourceParagraphIds: ['p2'], eventIds: ['open'], text: second, stagingAdditions: ['转动门把手是开门编排补充。'] },
    ], engineVersion: 'story-action-2.0', detailMode: 'detailed',
  };
  const board: Storyboard = {
    id: 'action-board', chapterId, sceneId: '', sequencePlanId: 'action-sequence', segmentId: 'action-segment', segmentIndex: 1,
    sourceStoryTitle: '走廊剧情', sourceStoryContent: first, sourceContentHash: sourceContentHash(first),
    workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
    pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
    converterPresetId: '', globalLock: '', finalPrompt: first,
    promptTrace: { modelRuleSetId: '', converterPresetId: '', sourceDocumentIds: [], referenceAssetIds: [],
      generatedAt: 1, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(first), shotPlanMode: 'ai-complete' },
    shots: [{ id: 'action-shot', index: 1, startSec: 0, endSec: 15, purpose: '已有动作', subject: '甲与乙', action: first,
      camera: '中景', lighting: '自然光', sound: '撞墙声', transition: '连续', result: '乙未被击中', referenceAssetIds: [], prompt: first, locked: false }],
    createdAt: 1, updatedAt: 1,
  };
  const plan: VideoSequencePlan = {
    id: 'action-sequence', chapterId, title: '走廊剧情', sourceStoryTitle: '走廊剧情', sourceStoryContent: story,
    sourceContentHash: sourceContentHash(story), planningMode: 'semantic-segments', planningStage: 'segmented',
    semanticPlanningSnapshot: { version: 1, directorSettingsFingerprint: 'action-settings',
      creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
      characterContinuity: [{ name: '甲' }, { name: '乙' }], originalSourceContext: snapshot },
    durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced',
    segments: [{ id: 'action-segment', index: 1, title: '踢出木箱', globalStartSec: 0, globalEndSec: 15, durationSec: 15,
      content: first, summary: '木箱飞过乙身旁', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '动作',
      entryState: '甲与乙在走廊', exitState: '木箱撞墙', transitionHint: '', storyboardId: board.id, status: 'ready',
      semanticSource: { sourceEvidence: [{ text: first }], events: [{ id: 'kick', description: first,
        causality: { actor: '甲', target: '乙', action: '踢出木箱', result: '未击中乙，撞墙', evidence: first, certainty: 'explicit' } }], dialogues: [] } },
      { id: 'door-segment', index: 2, title: '开门', globalStartSec: 15, globalEndSec: 30, durationSec: 15,
        content: second, summary: second, sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '开门', entryState: '', exitState: '门打开',
        transitionHint: '', status: 'planned', semanticSource: { sourceEvidence: [{ text: second }], events: [{ id: 'open', description: second }], dialogues: [] } }],
    createdAt: 1, updatedAt: 1,
  };
  state.project.assets = []; state.project.characters = []; state.project.locations = []; state.project.props = [];
  state.project.scenes = []; state.project.sequencePlans = [plan]; state.project.storyboards = [board];
  state.project.storyVisualConversions = [snapshot]; state.projects = [state.project];
  return { state, project: state.project, board, plan, snapshot };
};

const segmentContext = (input: ReturnType<typeof buildOfficialSeedanceInput>) =>
  input.sourceEvidence?.sequenceSegmentContext as SemanticSegmentSourceContext | undefined;

test('Seedance receives current segment action facts and matching adopted conversion as read-only narrative context', () => {
  const { project, board, snapshot } = makeFixture();
  const before = JSON.stringify(project);
  const context = segmentContext(buildOfficialSeedanceInput(project, board))!;
  assert.equal(context.kind, 'semantic-segment-source-v1');
  assert.deepEqual(context.segment.semanticSource.events.map((event) => event.id), ['kick'],
    'only the assigned current event is in performance scope');
  assert.equal(context.storyUnderstandingContext?.usage, 'understanding-only');
  assert.deepEqual(context.storyUnderstandingContext?.originalSourceContext?.actionPlan, snapshot.actionPlan);
  assert.deepEqual(context.storyUnderstandingContext?.originalSourceContext?.paragraphs, snapshot.paragraphs);
  assert.match(context.storyUnderstandingContext!.instruction, /不搬入前后段新剧情/u);
  assert.equal(JSON.stringify(project), before, 'building the request does not mutate saved conversion evidence');
  context.storyUnderstandingContext!.originalSourceContext!.actionPlan!.events[0].phases!.push('副本修改');
  assert.equal(JSON.stringify(project), before, 'returned action metadata cannot mutate the saved plan');
});

test('unmatched or outdated boards cannot receive another segment or chapter action evidence', () => {
  for (const change of [
    (fixture: ReturnType<typeof makeFixture>) => { fixture.board.sequencePlanId = 'other-plan'; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.board.segmentId = 'door-segment'; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.plan.segments[0].storyboardId = 'other-board'; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.board.chapterId = 'other-chapter'; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.board.sourceStoryContent = '用户已改写的另一段剧情'; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.board.sourceStale = true; },
    (fixture: ReturnType<typeof makeFixture>) => { fixture.plan.segments[0].semanticSource = undefined; },
  ]) {
    const fixture = makeFixture(); change(fixture);
    const input = buildOfficialSeedanceInput(fixture.project, fixture.board);
    assert.equal(segmentContext(input), undefined);
    assert.equal(input.sourceEvidence?.sourceStoryContent, fixture.board.sourceStoryContent,
      'mismatched plan evidence leaves the board current source intact');
  }
  const fixture = makeFixture();
  fixture.plan.semanticPlanningSnapshot!.originalSourceContext!.resultText = '另一个转换结果';
  assert.equal(segmentContext(buildOfficialSeedanceInput(fixture.project, fixture.board))?.storyUnderstandingContext?.originalSourceContext, undefined,
    'a conversion for another story cannot contribute original action facts');
});

test('explicit segment edits remain the performance source and old actions or dialogues stay read-only', () => {
  const { project, board, plan } = makeFixture();
  const segment = plan.segments[0];
  segment.semanticSource!.dialogues = [{ id: 'deleted-line', speaker: '乙', text: '别过来！' }];
  segment.content = '甲坐下，乙在门边等候。'; segment.contentOverridden = true;
  board.sourceStoryContent = semanticSegmentStoryContent(segment); board.finalPrompt = segment.content;
  board.shots[0].action = segment.content;
  const input = buildOfficialSeedanceInput(project, board);
  const context = segmentContext(input)!;
  assert.equal(context.contentOverridden, true);
  assert.equal(context.generationStoryContent, segment.content);
  assert.doesNotMatch(context.generationStoryContent, /别过来|踢出/u,
    'deleted action/dialogue evidence is not appended to the edited performance body');
  assert.match(context.storyUnderstandingContext!.instruction, /不从旧证据或全文恢复用户已删除、修改的事件和对白/u);
  assert.match(SEEDANCE_CHINESE_WRITER_RULE, /stagingAdditions 是转化时声明的编排补充，不冒充原文明确事实/u);
  assert.match(SEEDANCE_CHINESE_WRITER_RULE, /当前 canonicalPrompt 与已确认 shots 中的用户改动、镜头范围和时间仍优先/u);
});

test('action-evidence changes invalidate Seedance cache while preserving historical text', () => {
  const { project, board, snapshot } = makeFixture();
  const input = buildOfficialSeedanceInput(project, board);
  const fingerprint = getOfficialSeedanceSourceFingerprint(input);
  const promptZh = '视频规格：15秒。\n参考素材与职责：无。\n主体连续性：甲与乙。\n一句话概述：甲踢出木箱。\n连续时间轴：木箱飞过乙身旁撞墙。\n全局约束：身份和动作连续。';
  board.seedance25Output = { targetId: 'seedance-2.5', promptZh, durationSec: 15,
    sourceFingerprint: fingerprint, referenceManifest: [], warnings: [], generatedAt: 2 };
  assert.equal(hasCurrentSeedancePrompt(project, board), true);
  snapshot.actionPlan!.events[0].phases!.push('已确认的脚部作用与木箱运动衔接');
  assert.notEqual(getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board)), fingerprint);
  assert.equal(hasCurrentSeedancePrompt(project, board), false);
  assert.equal(board.seedance25Output.promptZh, promptZh);
});

test('persisting and reopening the same adopted action evidence keeps Seedance source identity stable', () => {
  const { state, project, board } = makeFixture();
  const before = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  const restoredBoard = restored.project.storyboards.find((candidate) => candidate.id === board.id)!;
  const restoredInput = buildOfficialSeedanceInput(restored.project, restoredBoard);
  const restoredContext = segmentContext(restoredInput);
  assert.ok(restoredContext?.storyUnderstandingContext?.originalSourceContext?.actionPlan,
    'valid completed board/segment ownership and adopted metadata survive reopening');
  assert.equal(getOfficialSeedanceSourceFingerprint(restoredInput), before,
    'restart does not spuriously invalidate a current action-aware delivery');
});
