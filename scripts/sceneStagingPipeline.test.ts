import assert from 'node:assert/strict';
import { normalizeSceneStaging, type SceneStaging } from '../src/sceneStaging';
import { normalizeStoryVisualActionPlan, normalizeStoryVisualParagraphs } from '../src/storyVisualAction';
import { copySemanticSequencePlanningInput, normalizeSemanticSegmentSource, normalizeStoryVisualConversionSnapshot,
  semanticSegmentSourceContext, type SemanticSequencePlanningInput } from '../src/semanticSequencePlan';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import { requestShotRecommendation, requestStoryPreparationWithReview } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';

// Synthetic ordinary interaction. Tests exercise production transport and
// persistence shapes, not an AI's understanding or a video's visual quality.
const source = '林舟面对陈月，将信交给她，随后仍面对陈月退到门边。';
const scene: SceneStaging = {
  version: 1, sceneId: 'doorway-meeting', sourceEventIds: ['letter', 'retreat'],
  worldRelations: ['门边与庭院属于同一连续地面，陈月始终留在庭院'],
  participants: [
    { id: 'lin', name: '林舟', position: '庭院中陈月面前', bodyFacing: '陈月', gazeTarget: '陈月', actionTarget: '陈月手中的信' },
    { id: 'chen', name: '陈月', position: '庭院原位', bodyFacing: '林舟', gazeTarget: '林舟', actionTarget: '来信' },
  ],
  phases: [
    { id: 'give-letter', eventId: 'letter', participantIds: ['lin', 'chen'], startState: '两人在庭院相对站立',
      action: '林舟把信交到陈月手中', endState: '信已交出，两人仍相对站立' },
    { id: 'move-to-door', eventId: 'retreat', participantIds: ['lin'], startState: '林舟在陈月面前',
      action: '林舟仍面对陈月后退', motionPath: '从陈月面前沿原路后退', motionEndpoint: '门边',
      endState: '林舟停在门边仍面对陈月，陈月留在庭院' },
  ], entryState: '相对站立，信在林舟手中', exitState: '信在陈月手中，林舟退到门边仍面对她',
};
const original = structuredClone(scene);
const normalized = normalizeSceneStaging(scene)!;
normalized.participants![0].bodyFacing = '仅副本改变';
normalized.phases![1].participantIds!.push('副本');
assert.deepEqual(scene, original);
assert.equal(normalizeSceneStaging(undefined), undefined);
assert.deepEqual(normalizeStoryVisualParagraphs([{ id: 'old', text: '普通旧稿', sourceParagraphIds: [], eventIds: [], stagingAdditions: [] }]),
  [{ id: 'old', text: '普通旧稿', sourceParagraphIds: [], eventIds: [], stagingAdditions: [] }]);
assert.deepEqual(normalizeSemanticSegmentSource({ sourceEvidence: [], events: [], dialogues: [] }),
  { sourceEvidence: [], events: [], dialogues: [] });
const facts = { version: 1 as const, summary: '交信后保持朝向后退', sceneStaging: [scene], events: [
  { id: 'letter', sourceParagraphIds: ['p1'], evidence: '将信交给她', actor: '林舟', target: '陈月', action: '交信', result: '陈月持信', uncertainties: [] },
  { id: 'retreat', sourceParagraphIds: ['p1'], evidence: '随后仍面对陈月退到门边', actor: '林舟', target: '门边', action: '后退', result: '停在门边仍面对陈月', uncertainties: [] },
] };
assert.deepEqual(normalizeStoryVisualActionPlan(facts, source)?.sceneStaging, [scene]);

type CapturedRequest = { messages: Array<{ role: string; content: string }> };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://scene-staging.mock.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'synthetic-scene-model', temperature: 0, maxTokens: 8192, vision: false };
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
let requests: CapturedRequest[] = [];
const user = (request: CapturedRequest): string => request.messages.find((message) => message.role === 'user')?.content || '';
const envelope = (request: CapturedRequest, tag: string): Record<string, any> => {
  const text = user(request); const open = `<${tag}>`; const close = `</${tag}>`;
  return JSON.parse(text.slice(text.indexOf(open) + open.length, text.indexOf(close)));
};
const install = (reply: (request: CapturedRequest, index: number) => unknown): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedRequest;
      requests.push(request);
      const content = reply(request, requests.length - 1);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) };
    },
  } } });
};

try {
  globalThis.fetch = async () => { throw new Error('Synthetic staging tests cannot contact a provider'); };
  install((request, index) => {
    const data = envelope(request, 'story_visual_data');
    if (index === 0) return facts;
    assert.equal(index, 1, 'the existing understanding/body pair needs no new model stage');
    assert.deepEqual(data.actionPlan.sceneStaging, [scene]);
    return { paragraphs: [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['letter', 'retreat'],
      text: source, stagingAdditions: [], sceneStaging: scene }] };
  });
  const converted = await requestStoryPreparationWithReview(config, source);
  assert.equal(requests.length, 2);
  assert.deepEqual(converted.actionPlan?.sceneStaging, [scene]);
  assert.deepEqual(converted.paragraphs?.[0].sceneStaging, scene);
  const longSource = `${source.repeat(35)}\n\n${source.repeat(35)}`;
  let understandingCalls = 0;
  let bodyCalls = 0;
  install((request) => {
    const data = envelope(request, 'story_visual_data');
    if (data.stage === 'understanding') {
      understandingCalls++;
      return { version: 1, summary: '同一庭院连续交互', events: [{ ...facts.events[0], id: 'e-local',
        sourceParagraphIds: data.focusParagraphIds }], sceneStaging: [{ ...scene, sourceEventIds: ['e-local'],
        phases: [{ ...scene.phases![0], eventId: 'e-local' }] }] };
    }
    bodyCalls++;
    assert.equal(data.actionPlan.sceneStaging.length, understandingCalls,
      'assembled scene records reach each body batch rather than disappearing in compactPlan');
    assert.deepEqual(data.actionPlan.sceneStaging.map((item: SceneStaging) => item.sourceEventIds![0]),
      data.actionPlan.events.map((item: { id: string }) => item.id));
    assert.deepEqual(data.actionPlan.sceneStaging.map((item: SceneStaging) => item.phases![0].eventId),
      data.actionPlan.events.map((item: { id: string }) => item.id));
    return { paragraphs: [{ id: 'v-local', sourceParagraphIds: data.focusParagraphIds,
      eventIds: data.focusEvents.map((item: { id: string }) => item.id), text: data.sourceParagraphs.map((item: { text: string }) => item.text).join('\n\n'),
      stagingAdditions: [], sceneStaging: data.actionPlan.sceneStaging[0] }] };
  });
  const batched = await requestStoryPreparationWithReview({ ...config, maxTokens: 1000 }, longSource);
  assert.ok(understandingCalls > 1 && bodyCalls > 1);
  assert.equal(batched.actionPlan?.sceneStaging?.length, understandingCalls);
  assert.equal(requests.length, understandingCalls + bodyCalls, 'batch metadata adds no review or retry calls');
  const snapshot = normalizeStoryVisualConversionSnapshot({ id: 'ordinary-conversion', chapterId: 'chapter', sourceName: '交信',
    sourceText: source, resultText: converted.text, createdAt: 1, actionPlan: converted.actionPlan, paragraphs: converted.paragraphs })!;
  const input: SemanticSequencePlanningInput = copySemanticSequencePlanningInput({ title: '同一庭院', story: converted.text,
    segmentDurationSec: 15, directorSettingsFingerprint: 'ordinary-scene', originalSourceContext: snapshot,
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' } });
  const sceneParts = scene.phases!.map((phase) => ({ ...scene, phases: [phase],
    entryState: phase.startState, exitState: phase.endState }));
  const authored = { reason: '交信后接续后退', fitStatus: 'balanced', segments: sceneParts.map((part, index) => ({
    title: index ? '后退' : '交信', content: index ? '林舟仍面对陈月退到门边。' : '林舟面对陈月，将信交给她。',
    summary: '庭院同一场面', narrativePurpose: '推进同一互动', entryState: part.entryState, exitState: part.exitState,
    transitionHint: '沿末态继续', boundaryReason: '事件阶段接续', continuityPack: part.exitState,
    semanticSource: { sourceEvidence: [{ text: source }], events: [{ id: index ? 'retreat' : 'letter', description: '当前阶段',
      phase: part.phases![0].id }], dialogues: [], sceneStaging: [part] },
  })) };
  install((request) => {
    const data = JSON.parse(user(request).slice(user(request).indexOf('=') + 1));
    assert.deepEqual(data.originalSourceContext.actionPlan.sceneStaging, [scene]);
    assert.deepEqual(data.originalSourceContext.paragraphs[0].sceneStaging, scene);
    return authored;
  });
  const plan = await requestSemanticSequencePlan(config, input, undefined, { planId: 'ordinary-plan', now: () => 2 });
  assert.equal(requests.length, 1);
  assert.deepEqual(plan.segments.map((segment) => segment.semanticSource?.sceneStaging), sceneParts.map((part) => [part]));
  const context = semanticSegmentSourceContext(plan, plan.segments[1]);
  assert.deepEqual(context.segment.semanticSource.sceneStaging, [sceneParts[1]]);
  assert.deepEqual(context.storyUnderstandingContext?.originalSourceContext?.actionPlan?.sceneStaging, [scene]);
  context.segment.semanticSource.sceneStaging![0].participants![0].position = '请求副本';
  assert.deepEqual(plan.segments[1].semanticSource?.sceneStaging, [sceneParts[1]]);

  const shot = { startSec: 0, endSec: 15, sourceExcerpt: plan.segments[1].content, purpose: '保持交谈朝向完成后退',
    subject: '林舟与陈月', action: '林舟面对陈月后退到门边，陈月持信留在庭院',
    camera: '从两人交互轴一侧观察林舟的侧身与退路', transition: '从交信末态继续', lighting: '同一庭院日光',
    sound: '无', result: '林舟在门边仍面对陈月', space: '陈月留在庭院，林舟沿原路退至门边',
    direction: '林舟身体仍面向陈月，位移终点是门边', dialogue: '无', sceneStaging: [sceneParts[1]] };
  install((request) => {
    assert.deepEqual(envelope(request, 'storyboard_planning_data').sceneStaging, [sceneParts[1]]);
    return { sceneStaging: [sceneParts[1]], shots: [shot] };
  });
  const directed = await requestShotRecommendation(config, { durationSec: 15, workflow: 'drama', pace: 'normal',
    story: plan.segments[1].content, sequenceSegmentContext: semanticSegmentSourceContext(plan, plan.segments[1]) as unknown as Record<string, unknown> });
  assert.equal(requests.length, 1);
  assert.deepEqual(directed.sceneStaging, [sceneParts[1]]);
  assert.deepEqual(directed.shots[0].sceneStaging, [sceneParts[1]]);
  assert.equal(directed.shots[0].direction, shot.direction);

  install((request) => {
    assert.equal(Object.hasOwn(envelope(request, 'storyboard_planning_data'), 'sceneStaging'), false);
    return { sceneStaging: [scene], shots: [{ ...shot, sourceExcerpt: source, sceneStaging: [scene] }] };
  });
  const direct = await requestShotRecommendation(config, { durationSec: 15, workflow: 'drama', pace: 'normal', story: source });
  assert.equal(requests.length, 1, 'direct story-to-shots creates optional staging in the same request');
  assert.deepEqual(direct.sceneStaging, [scene]);

  const edited = structuredClone(plan);
  edited.segments[1].contentOverridden = true;
  edited.segments[1].content = '林舟留在陈月面前，没有后退。';
  install((request) => {
    const data = envelope(request, 'storyboard_planning_data');
    assert.equal(data.sourceStory, edited.segments[1].content);
    assert.equal(Object.hasOwn(data, 'sceneStaging'), false, 'old choices are not promoted after an explicit story edit');
    return { shots: [{ ...shot, sourceExcerpt: edited.segments[1].content, action: edited.segments[1].content, sceneStaging: [] }] };
  });
  const changed = await requestShotRecommendation(config, { durationSec: 15, workflow: 'drama', pace: 'normal', story: edited.segments[1].content,
    sequenceSegmentContext: semanticSegmentSourceContext(edited, edited.segments[1]) as unknown as Record<string, unknown> });
  assert.equal(requests.length, 1);
  assert.equal(changed.sceneStaging, undefined);
  console.log('PASS scene staging pipeline: ordinary story conversion, semantic allocation and direct/segmented directing preserve independent facing, path and endpoint without new model stages.');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
