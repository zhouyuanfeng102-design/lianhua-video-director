import assert from 'node:assert/strict';
import { requestStoryPreparationWithReview, requestShotRecommendation } from '../src/services/llm';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import { normalizeStoryVisualConversionSnapshot, semanticSegmentSourceContext } from '../src/semanticSequencePlan';
import { STORY_GROUP_PARTICIPATION_RULE, STORY_TIME_RELATION_RULE, STORY_VISIBLE_TIME_TRANSITION_RULE } from '../src/storySceneParticipationRules';
import type { SceneStaging } from '../src/sceneStaging';
import type { TextApiConfig } from '../src/types';

// Offline transport fixture: this verifies the actual request contracts and
// existing metadata handoffs, not a model's comprehension or generated video.
const source = '战后数天后，夏娃修复完成，从战舰走出拥抱吴小观。\n\n随后的日子里吴小观逐渐痊愈。这一天他独自盘坐清点奖励，随后向龙娘和熊娘提出较量，两人笑着拒绝。龙娘说：“以后再来吧。”塔菲在另一侧看着他们。\n\n更晚的时候西里斯才来到营地。';
const body = '战后数天后，夏娃从战舰走出，抱住吴小观。随后又过了一些日子，吴小观伤势大致痊愈。这一天他独自盘坐清点奖励，起身走向龙娘与熊娘提出较量。两人笑着拒绝，龙娘对他说：“以后再来吧。”塔菲在另一侧旁观。\n\n更晚的时候西里斯来到营地。';
const characters = ['吴小观', '夏娃', '龙娘', '熊娘', '塔菲', '西里斯'].map((name, index) => ({ id: `person-${index}`, name }));
const scene: SceneStaging = {
  version: 1, sceneId: 'forest-camp', sourceEventIds: ['hug', 'rewards', 'refusal'],
  participants: characters.slice(0, 5).map(({ id, name }) => ({ id, name })),
  phases: [
    { id: 'hug-phase', eventId: 'hug', participantIds: ['person-0', 'person-1'],
      startState: '战后数天后，夏娃修复完成', action: '夏娃走出战舰抱住吴小观', endState: '两人相拥' },
    { id: 'rewards-phase', eventId: 'rewards', participantIds: ['person-0'],
      startState: '相拥之后又经过一些日子，吴小观伤势大致痊愈，独自盘坐',
      action: '吴小观清点奖励', endState: '吴小观起身' },
    { id: 'refusal-phase', eventId: 'refusal', participantIds: ['person-0', 'person-2', 'person-3', 'person-4'],
      startState: '吴小观面向龙娘与熊娘，塔菲在另一侧', action: '吴小观请求较量，龙娘与熊娘笑着拒绝，塔菲旁观',
      endState: '吴小观受挫，龙娘说完原话' },
  ],
};
const facts = { version: 1, summary: '保留开场与相拥之后两处时间关系，以及两人共同拒绝',
  events: scene.phases!.map((phase, index) => ({
    id: phase.eventId, sourceParagraphIds: [index ? 'p2' : 'p1'], evidence: source.split('\n\n')[index ? 1 : 0],
    actor: index === 0 ? '夏娃' : index === 1 ? '吴小观' : '龙娘、熊娘',
    target: '吴小观', action: phase.action, phases: [phase.startState, phase.action, phase.endState],
    result: phase.endState, uncertainties: [],
  })), sceneStaging: [scene],
};
const paragraph = { id: 'v1', sourceParagraphIds: ['p1', 'p2', 'p3'], eventIds: ['hug', 'rewards', 'refusal'],
  text: body, stagingAdditions: [], sceneStaging: scene };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://story-group-time.mock.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'offline-fixture', temperature: 0, maxTokens: 8192, vision: false };
type Request = { messages: Array<{ role: string; content: string }> };
const user = (request: Request) => request.messages.find((message) => message.role === 'user')?.content || '';
const system = (request: Request) => request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
const envelope = (request: Request, tag: string) => {
  const text = user(request);
  return JSON.parse(text.slice(text.indexOf(`<${tag}>`) + tag.length + 2, text.indexOf(`</${tag}>`)));
};
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
let requests: Request[] = [];
const install = (reply: (request: Request, index: number) => unknown) => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request: Request = JSON.parse(payload.body || '{}');
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify(reply(request, requests.length - 1)) } }] }) };
    },
  } } });
};
try {
  globalThis.fetch = async () => { throw new Error('This test must not contact a model provider'); };
  install((request, index) => {
    assert.ok(system(request).includes(STORY_GROUP_PARTICIPATION_RULE));
    assert.ok(system(request).includes(STORY_TIME_RELATION_RULE));
    assert.ok(!system(request).includes(STORY_VISIBLE_TIME_TRANSITION_RULE), 'conversion does not pre-author photography');
    const data = envelope(request, 'story_visual_data');
    assert.equal(data.sourceTextOrRequirement, source);
    if (index === 0) {
      assert.equal(data.stage, 'understanding');
      return facts;
    }
    assert.equal(index, 1, 'no additional review or retry stage');
    assert.deepEqual(data.actionPlan.sceneStaging, [scene]);
    assert.deepEqual(data.actionPlan.events[2].phases, facts.events[2].phases);
    return { paragraphs: [paragraph] };
  });
  const converted = await requestStoryPreparationWithReview(config, source);
  assert.equal(requests.length, 2);
  assert.deepEqual(converted.paragraphs?.[0].sceneStaging, scene);
  const snapshot = normalizeStoryVisualConversionSnapshot({ id: 'conversion', chapterId: 'chapter', sourceName: '森林',
    sourceText: source, resultText: converted.text, createdAt: 1, actionPlan: converted.actionPlan, paragraphs: converted.paragraphs })!;
  const segmentBody = body.split('\n\n')[0];
  const plannedSegment = { title: '归来、清点与被拒', content: segmentBody, summary: '两处时间关系，随后群体拒绝',
    narrativePurpose: '自信被拒的落差', entryState: scene.phases![0].startState, exitState: scene.phases![2].endState,
    transitionHint: '当前动作结束，更晚另有来访者', boundaryReason: '群体回应结束', continuityPack: '龙娘与熊娘拒绝，塔菲旁观',
    semanticSource: { sourceEvidence: [{ text: source.split('\n\n').slice(0, 2).join('\n\n') }],
      events: [{ id: 'refusal', description: '吴小观请求与两人较量，两人笑着拒绝', causality: {
        actor: '吴小观', target: '龙娘、熊娘', actorCharacterId: 'person-0', targetCharacterIds: ['person-2', 'person-3'],
        action: '请求较量', result: '两人笑着拒绝', evidence: '向龙娘和熊娘提出较量，两人笑着拒绝', certainty: 'explicit',
      } }], dialogues: [{ id: 'line-1', speaker: '龙娘', speakerCharacterId: 'person-2', text: '以后再来吧。',
        listenerCharacterIds: ['person-0'] }], sceneStaging: [scene] },
  };
  install((request) => {
    assert.ok(system(request).includes(STORY_GROUP_PARTICIPATION_RULE));
    assert.ok(system(request).includes(STORY_TIME_RELATION_RULE));
    assert.ok(!system(request).includes('群体、匿名或未知角色用原称呼'));
    const payload = user(request).split('\n\n')[0];
    const data = JSON.parse(payload.slice(payload.indexOf('=') + 1));
    assert.deepEqual(data.characterContinuity, characters);
    assert.equal(data.originalSourceContext.sourceText, source);
    assert.deepEqual(data.originalSourceContext.paragraphs[0].sceneStaging, scene);
    return { reason: '事件窗口安排', fitStatus: 'balanced', segments: [plannedSegment, {
      ...plannedSegment, title: '更晚来访', content: '更晚的时候西里斯来到营地。',
      entryState: '更晚的时候', exitState: '西里斯到达', semanticSource: { sourceEvidence: [], events: [], dialogues: [] },
    }] };
  });
  const plan = await requestSemanticSequencePlan(config, { title: '森林', story: converted.text, originalSourceContext: snapshot,
    segmentDurationSec: 30, directorSettingsFingerprint: 'forest', characterContinuity: characters,
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' } }, undefined, { planId: 'plan', now: () => 2 });
  assert.equal(requests.length, 1);
  const context = semanticSegmentSourceContext(plan, plan.segments[0]);
  assert.deepEqual(context.segment.semanticSource.events[0].causality?.targetCharacterIds, ['person-2', 'person-3']);
  assert.deepEqual(context.segment.semanticSource.sceneStaging, [scene]);
  assert.ok(!context.segment.semanticSource.sceneStaging![0].participants!.some((person) => person.id === 'person-5'),
    'the later arrival is not locally inserted into an earlier scene from the character library');
  const transition = '相拥画面淡出；同一空地通过简短光影流逝过渡到一些日子后吴小观独自盘坐。';
  const shot = { startSec: 0, endSec: 30, sourceExcerpt: segmentBody, purpose: '保留群体互动与两处时间关系',
    subject: '吴小观、夏娃、龙娘、熊娘、塔菲', action: segmentBody, camera: '按上述先后观察各事件',
    transition, lighting: '场景原定日光', sound: '龙娘说原话', result: '两人拒绝，吴小观受挫',
    space: '当前各自所处位置见场面阶段', performance: '龙娘与熊娘笑着拒绝，塔菲旁观',
    direction: '吴小观面向龙娘与熊娘', dialogue: '龙娘：“以后再来吧。”', sceneStaging: [scene] };
  install((request) => {
    assert.ok(system(request).includes(STORY_GROUP_PARTICIPATION_RULE));
    assert.ok(system(request).includes(STORY_TIME_RELATION_RULE));
    assert.ok(system(request).includes(STORY_VISIBLE_TIME_TRANSITION_RULE));
    const data = envelope(request, 'storyboard_planning_data');
    assert.deepEqual(data.sceneStaging, [scene]);
    assert.equal(data.sceneStaging[0].phases[0].startState, '战后数天后，夏娃修复完成');
    assert.equal(data.sceneStaging[0].phases[1].startState, '相拥之后又经过一些日子，吴小观伤势大致痊愈，独自盘坐');
    return { shots: [shot], sceneStaging: [scene] };
  });
  const directed = await requestShotRecommendation(config, { durationSec: 30, workflow: 'drama', pace: 'normal',
    story: segmentBody, sequenceSegmentContext: context as unknown as Record<string, unknown> });
  assert.equal(requests.length, 1);
  assert.equal(directed.shots[0].transition, transition);
  assert.deepEqual(directed.sceneStaging, [scene]);
  assert.equal(directed.shots[0].performance, shot.performance);
  console.log('PASS group/time pipeline: existing conversion, semantic allocation and directing requests preserve known group identities, separate time jumps and authored visible transitions; no new stages or local cast inference.');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
