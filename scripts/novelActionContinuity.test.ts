import assert from 'node:assert/strict';
import { NOVEL_ACTION_SOURCE_RULE, NOVEL_ACTION_CONTINUITY_RULE } from '../src/novelActionDirection';
import { normalizeSceneStaging, type SceneStaging } from '../src/sceneStaging';
import { copySemanticSequencePlanningInput, normalizeStoryVisualConversionSnapshot,
  semanticSegmentSourceContext, type SemanticSequencePlanningInput,
  type SemanticSequenceResponseSegment } from '../src/semanticSequencePlan';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { TextApiConfig } from '../src/types';

// Synthetic model replies exercise the real request, normalization, frozen
// source and storage paths. They do not assert model or video performance.
const story = '林舟把信交给陈月，说：“消息在信里。”陈月将信放在桌上，端起茶杯。林舟说：“渡口出事了。”她举杯的动作停住，随后把杯子放回桌上。林舟转身走向门外；陈月伸手想拉住他，终于又放下手，留在桌边。林舟穿过敞开的门，走到走廊尽头。';
const starts = [
  '两人站在桌旁，信由林舟持有，杯在桌上，通往走廊的门敞开。',
  '信仍在两人指间，陈月尚未完全接稳；杯仍在桌上。',
  '陈月已听到渡口消息，信与杯都在桌上，林舟仍在桌旁，门敞开。',
  '林舟已到门槛处继续向走廊移动；陈月已收回伸出的手，未接触林舟，留在桌旁。',
];
const ends = [...starts.slice(1), '林舟停在走廊尽头；陈月仍留在桌旁，信与杯在桌上，门保持敞开，未发生拉住。'];
const contents = [
  '林舟把信递到陈月伸来的手中，说：“消息在信里。”陈月的手接触信，交接仍在继续。',
  '陈月接稳同一封信后林舟松手。她把信放在桌上，端起杯子。林舟说：“渡口出事了。”她举杯的动作停住，望向林舟，片刻后把杯底落回桌面并松手，没有饮水。',
  '林舟转身朝敞开的门走去。陈月伸手想拉住他，手在碰到之前停住，随后放下，仍在桌边。林舟走到门槛处，步伐仍在继续。',
  '林舟沿前段未完的行进跨过门槛，继续走过走廊，最终停在尽头。陈月留在桌旁，信与杯没有移动。',
];
const phases: NonNullable<SceneStaging['phases']>[] = [
  [{ id: 'handover', eventId: 'letter', participantIds: ['lin', 'chen'], startState: starts[0],
    action: '陈月接触林舟递来的信，交接进行中', endState: ends[0] }],
  [{ id: 'handover', eventId: 'letter', participantIds: ['lin', 'chen'], startState: starts[1],
    action: '陈月接稳后林舟松手，陈月把信放在桌上', endState: '信在桌上，林舟手中无信' },
  { id: 'cup-interrupted', eventId: 'cup', participantIds: ['chen'], startState: '杯在桌上',
    action: '端杯时听见渡口消息，动作停住；稍后把杯放回桌面再松手', endState: ends[1] }],
  [{ id: 'walk-to-corridor', eventId: 'leave', participantIds: ['lin'], startState: starts[2],
    action: '转身从桌旁走到门槛，仍在前行', motionPath: '从桌旁朝敞开的门移动',
    motionEndpoint: '门槛处，尚未到走廊尽头', endState: ends[2] },
  { id: 'reach-aborted', eventId: 'reach', participantIds: ['chen'], startState: '陈月在桌旁',
    action: '伸手想拉住林舟，接触前停住并收回', endState: '未抓住林舟，留在桌旁' }],
  [{ id: 'walk-to-corridor', eventId: 'leave', participantIds: ['lin'], startState: starts[3],
    action: '继续跨门槛，沿走廊走到尽头并停下', motionPath: '从门槛接续经过走廊',
    motionEndpoint: '走廊尽头', endState: ends[3] }],
];
const staging: SceneStaging[] = phases.map((part, index) => ({
  version: 1, sceneId: 'room-and-corridor', sourceEventIds: [...new Set(part.map((phase) => phase.eventId!))],
  worldRelations: ['桌旁经敞开的门通向走廊；同一连续时间，没有跳时'],
  participants: [
    { id: 'lin', name: '林舟', position: index < 3 ? '桌旁至门槛的当前阶段' : '门槛处',
      bodyFacing: index < 2 ? '陈月' : '朝门外走廊', actionTarget: index < 2 ? '同一封信' : '走廊尽头' },
    { id: 'chen', name: '陈月', position: '桌旁', bodyFacing: '林舟', gazeTarget: '林舟' },
  ], phases: part, entryState: starts[index], exitState: ends[index],
}));
const segments: SemanticSequenceResponseSegment[] = staging.map((scene, index) => ({
  title: ['递信', '接稳与消息', '未完成的挽留', '沿走廊离开'][index], content: contents[index],
  summary: '同一场面中动作改变后续状态', narrativePurpose: '推进交接、获知和离开',
  entryState: starts[index], exitState: ends[index], transitionHint: '沿当前状态继续',
  boundaryReason: '在未完成阶段自然接续', continuityPack: ends[index],
  semanticSource: {
    sourceEvidence: [{ text: story }],
    events: scene.phases!.map((phase) => ({ id: phase.eventId!, description: phase.action!, phase: phase.id })),
    dialogues: index < 2 ? [{ id: `line-${index + 1}`, speaker: '林舟', speakerCharacterId: 'lin',
      listenerCharacterIds: ['chen'], text: index ? '渡口出事了。' : '消息在信里。' }] : [],
    sceneStaging: [scene],
  },
}));
const reply = { reason: '同一场面的交接与移动跨窗口继续，动作没有重新开始', fitStatus: 'balanced', segments };
const input: SemanticSequencePlanningInput = {
  title: '普通行为接续', story, segmentDurationSec: 15, directorSettingsFingerprint: 'synthetic-general-actions',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '保留未完成的挽留，不追加新剧情。' },
  characterContinuity: [
    { id: 'lin', name: '林舟', height: '178厘米', personality: '克制', motionHabits: '停稳后交物',
      bodyPlan: '普通人类身体', signatureProps: '当前信件', outfit: '素色外套' },
    { id: 'chen', name: '陈月', personality: '寡言', motionHabits: '听消息时会停下手中动作' },
  ],
};
type RequestBody = { messages: Array<{ role: string; content: string }> };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://novel-action-continuity.mock.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'synthetic-model', temperature: 0, maxTokens: 8192, vision: false };
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
const requests: RequestBody[] = [];
const system = (request: RequestBody) => request.messages.find((message) => message.role === 'system')!.content;
const data = (request: RequestBody): Record<string, any> => {
  const message = request.messages.find((item) => item.role === 'user')!.content;
  assert.ok(message.startsWith('semantic_sequence_input='), 'these fixtures use only the first planning request');
  return JSON.parse(message.slice(message.indexOf('=') + 1));
};

try {
  globalThis.fetch = async () => { throw new Error('No real model requests in continuity tests'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as RequestBody;
      requests.push(request);
      assert.ok(system(request).includes(NOVEL_ACTION_SOURCE_RULE));
      assert.ok(system(request).includes(NOVEL_ACTION_CONTINUITY_RULE));
      assert.equal(system(request).split('NOVEL_ACTION_SOURCE_V1').length - 1, 1);
      assert.equal(system(request).split('NOVEL_ACTION_CONTINUITY_V1').length - 1, 1);
      assert.match(system(request), /直接输入小说时，在这一次请求内/u);
      assert.match(system(request), /用户明确的剧情修改、分段边界与固定时长优先/u);
      assert.match(system(request), /原文允许同时发生的行走、取放、观察、倾听与现场信息可以和发话并行/u);
      assert.equal(data(request).story, story);
      assert.deepEqual(data(request).characterContinuity, input.characterContinuity);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }) };
    },
  } } });

  const rawPlan = await requestSemanticSequencePlan(config, input, undefined, { planId: 'raw-action-plan', now: () => 1 });
  assert.equal(requests.length, 1, 'raw-story choreography belongs to the existing planning call');
  assert.equal(Object.hasOwn(data(requests[0]), 'originalSourceContext'), false);
  assert.deepEqual(rawPlan.segments.map((segment) => segment.content), contents);
  assert.deepEqual(rawPlan.segments.map((segment) => segment.semanticSource?.sceneStaging), staging.map((scene) => [scene]));
  assert.deepEqual(rawPlan.segments.map((segment) => [segment.globalStartSec, segment.globalEndSec]),
    [[0, 15], [15, 30], [30, 45], [45, 60]]);

  // The same adopted IDs and prose are supplied on the normal converted-story
  // entry. Fixed duration remains 60 seconds; the metadata creates no call.
  const originalSourceContext = normalizeStoryVisualConversionSnapshot({
    id: 'adopted-actions', chapterId: 'chapter', sourceName: '普通动作原文', sourceText: story,
    resultText: story, createdAt: 1,
    actionPlan: { version: 1, summary: '信、杯与离开', events: [{ id: 'letter', sourceParagraphIds: ['p1'],
      evidence: '林舟把信交给陈月', actor: '林舟', target: '陈月', action: '交信', result: '陈月接信', uncertainties: [] }],
    sceneStaging: staging },
    paragraphs: [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['letter'], text: story,
      stagingAdditions: ['交接跨窗口仍是同一次交信'], sceneStaging: staging[0] }],
  })!;
  const adoptedInput = copySemanticSequencePlanningInput({ ...input, durationMode: 'fixed',
    requestedTotalDurationSec: 60, originalSourceContext });
  const adoptedPlan = await requestSemanticSequencePlan(config, adoptedInput, undefined, { planId: 'adopted-action-plan', now: () => 2 });
  assert.equal(requests.length, 2, 'each user generation uses one model call');
  assert.equal(data(requests[1]).requiredSegmentCount, 4);
  assert.equal(adoptedPlan.totalDurationSec, 60);
  assert.deepEqual(data(requests[1]).originalSourceContext.actionPlan.sceneStaging, staging);
  assert.deepEqual(adoptedPlan.semanticPlanningSnapshot?.originalSourceContext, originalSourceContext);

  // Optional state prose survives storage without local event classification,
  // phase rewriting, adding a successful contact, or requiring new metadata.
  const initial = createInitialState();
  const legacy = structuredClone(rawPlan);
  legacy.id = 'legacy-without-staging';
  for (const segment of legacy.segments) delete segment.semanticSource!.sceneStaging;
  initial.project.sequencePlans = [rawPlan, adoptedPlan, legacy];
  initial.projects = [initial.project];
  const restored = normalizeState(JSON.parse(serializeStateForStorage(initial).serialized));
  const saved = restored.project.sequencePlans.find((plan) => plan.id === rawPlan.id)!;
  assert.deepEqual(saved.segments.map((segment) => segment.content), contents);
  assert.deepEqual(saved.segments.map((segment) => segment.semanticSource?.sceneStaging), staging.map((scene) => [scene]));
  assert.equal(saved.segments[0].semanticSource!.sceneStaging![0].phases![0].id,
    saved.segments[1].semanticSource!.sceneStaging![0].phases![0].id, 'one handover carries across windows');
  assert.equal(saved.segments[2].semanticSource!.sceneStaging![0].phases![0].id,
    saved.segments[3].semanticSource!.sceneStaging![0].phases![0].id, 'one walk carries across windows');
  assert.equal(saved.segments[2].semanticSource!.sceneStaging![0].phases![1].endState, '未抓住林舟，留在桌旁');
  assert.equal(normalizeSceneStaging({ version: 1, sceneId: 'legacy-scene' })!.phases, undefined);
  assert.ok(restored.project.sequencePlans.find((plan) => plan.id === legacy.id)!.segments
    .every((segment) => segment.semanticSource?.sceneStaging === undefined));

  const context = semanticSegmentSourceContext(saved, saved.segments[3]);
  assert.deepEqual(context.segment.semanticSource.sceneStaging, [staging[3]]);
  assert.deepEqual(context.characterContinuity, input.characterContinuity);
  context.segment.semanticSource.sceneStaging![0].phases![0].startState = 'only the request copy changes';
  assert.equal(saved.segments[3].semanticSource!.sceneStaging![0].phases![0].startState, starts[3]);
  const edited = structuredClone(saved);
  edited.segments[2].contentOverridden = true;
  edited.segments[2].content = '两人安静地留在桌边，没有离开。';
  const editedContext = semanticSegmentSourceContext(edited, edited.segments[2]);
  assert.equal(editedContext.contentOverridden, true);
  assert.equal(editedContext.generationStoryContent, edited.segments[2].content);
  assert.match(editedContext.storyUnderstandingContext!.instruction, /不从旧证据或全文恢复用户已删除、修改的事件和对白/u);
  assert.equal(requests.length, 2, 'storage and handoff perform no model work');
  console.log('PASS novel action continuity: one-call raw/adopted planning, fixed duration, handover, interruption, aborted contact, movement and legacy storage.');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
