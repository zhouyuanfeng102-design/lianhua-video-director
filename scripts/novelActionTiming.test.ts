import assert from 'node:assert/strict';
import { requestShotRecommendation, requestStoryPreparationWithReview } from '../src/services/llm';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import { normalizeStoryVisualConversionSnapshot, type SemanticSequencePlanningInput } from '../src/semanticSequencePlan';
import type { SceneStaging } from '../src/sceneStaging';
import type { StoryVisualActionPlan } from '../src/storyVisualAction';
import type { TextApiConfig } from '../src/types';
import { NOVEL_ACTION_SOURCE_RULE, NOVEL_ACTION_DELIVERY_RULE } from '../src/novelActionDirection';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE, withVideoActionChoreographyScope } from '../src/videoActionChoreographyRules';
import { PRE_NATURAL_TEMPO_VIDEO_ACTION_CHOREOGRAPHY_RULE } from '../src/novelActionLegacyRequestRules';
import { readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';

// Offline request/transport fixtures. The supplied timing is not a claim that
// a live model or video will follow it; no endpoint or user project is touched.
const sourceParagraphs = [
  '甲点头，乙回礼。两人几乎同时沉身起势。甲探步虚晃，乙偏头退半步；甲收回半步，稳住。',
  '乙蹬地前突，左手挑肘，同时右手取面。甲压肘并后仰，接着转身推开来臂。乙横移半步回正，右手收胸，左手护肋。',
  '两人没有兵刃，力留七分，又过几个照面。甲推拨压，乙低挑变高，退进交替。',
  '乙缓缓绕行三步，甲随之转身；第三步乙突然矮身，左手扫甲脚踝。甲提起前脚，同时右手按向乙肩背。乙受压下沉，左掌撑地、右脚后蹬，身体横移脱开按压，随后翻身站起。',
  '甲收手于胸前，不追击，等乙站稳。乙拍去掌上尘土、理好衣带，抬头重新起势，呼吸稍快。',
];
const source = sourceParagraphs.join('\n\n');
const facts: StoryVisualActionPlan = {
  version: 1, sourceParagraphs: sourceParagraphs.map((text, i) => ({ id: `p${i + 1}`, text })),
  summary: '切磋限力但真实交手；三步后突扫，提脚与按肩同时，受压后脱身，双方实际收手整理。',
  events: sourceParagraphs.map((evidence, i) => ({
    id: `e${i + 1}`, sourceParagraphIds: [`p${i + 1}`], evidence, actor: '甲与乙', target: '对方',
    action: evidence, result: i === 4 ? '乙已重新起势' : '按原文接续', uncertainties: [],
  })),
};
const timedScene: SceneStaging = {
  version: 1, sceneId: 'sparring', sourceEventIds: ['e3', 'e4', 'e5'],
  participants: [{ id: 'a', name: '甲', actionTarget: '乙' }, { id: 'b', name: '乙', actionTarget: '甲' }],
  phases: [
    { id: 'exchanges', eventId: 'e3', action: '段内0–6秒，接续几个照面，推拨压与低挑变高、退进交替；限力七分但动作实时完成。', endState: '交手后转入绕行' },
    { id: 'three-steps', eventId: 'e4', action: '6–9秒乙缓缓绕行三步，甲同时随转；第三步末乙突然矮身。', endState: '第三步触发低扫' },
    { id: 'press-escape', eventId: 'e4', action: '9–11秒乙左手扫脚踝，甲提脚同时下按肩背；乙受压下沉，撑地蹬腿横移，至脱开时压力结束。', endState: '已脱开而未站起' },
    { id: 'rise', eventId: 'e4', action: '11–12秒乙接续横移翻身站起。', endState: '乙起身未重新起势' },
    { id: 'wait', eventId: 'e5', action: '12–15秒甲收手于胸前，等待乙站稳，与乙整理同时。', endState: '甲未追击' },
    { id: 'recover', eventId: 'e5', action: '12–15秒乙拍土、理衣带，抬头重新起势；呼吸稍快随动作持续。', endState: '乙已重新起势' },
  ], exitState: '双方再次起势，甲未追击',
};
const paragraphs = sourceParagraphs.map((text, i) => ({ id: `v${i + 1}`, sourceParagraphIds: [`p${i + 1}`],
  eventIds: [`e${i + 1}`], text, stagingAdditions: [] }));
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://action-timing.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'mock', temperature: 0, maxTokens: 8192, vision: false };
const oldWindow = globalThis.window;
const oldFetch = globalThis.fetch;
let requests: CapturedStoryRequest[] = [];
const system = (request: CapturedStoryRequest) => request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
const dataOf = (request: CapturedStoryRequest, tag: string): Record<string, any> => {
  const user = request.messages.find(({ role }) => role === 'user')!.content;
  const json = tag === 'semantic_sequence_input' ? user.slice(user.indexOf('=') + 1)
    : user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))?.[1];
  assert.ok(json, `expected ${tag}`);
  return JSON.parse(json);
};
const install = (answer: (request: CapturedStoryRequest, index: number) => unknown) => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify(answer(request, requests.length - 1)),
      } }] }) };
    },
  } } });
};

try {
  globalThis.fetch = async () => { throw new Error('Timing tests may not make live requests'); };
  const baseline = JSON.stringify({ facts, timedScene });
  install((request, index) => {
    assert.ok(index < 2, 'source conversion uses only its existing two stages');
    const data = readStoryVisualData(request);
    assert.equal(data.sourceTextOrRequirement, source);
    assert.ok(system(request).includes(NOVEL_ACTION_SOURCE_RULE));
    if (index === 0) {
      assert.ok(JSON.stringify(request.messages).includes('不单独当作耗时动作'),
        'the understanding-stage instruction reaches its existing user message');
      return { version: facts.version, summary: facts.summary, events: facts.events };
    }
    assert.deepEqual((data.actionPlan as StoryVisualActionPlan).events, facts.events,
      'legacy mixed constraint-and-exchanges event is transported without dropping its actual exchanges');
    return { paragraphs };
  });
  const converted = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize', undefined,
    { detailMode: 'detailed' });
  assert.equal(requests.length, 2);
  assert.deepEqual(converted.actionPlan?.events, facts.events);
  assert.deepEqual(converted.paragraphs?.map(({ text }) => text), sourceParagraphs,
    'conversion transport preserves counts, simultaneous hands, sustained pressure, actual recovery');

  const originalSourceContext = normalizeStoryVisualConversionSnapshot({
    id: 'timing-fixture', chapterId: 'chapter', sourceName: '动作', sourceText: source,
    resultText: converted.text, createdAt: 1, actionPlan: converted.actionPlan, paragraphs: converted.paragraphs,
  })!;
  const input: SemanticSequencePlanningInput = {
    title: '全部动作的固定窗口', story: converted.text, segmentDurationSec: 15,
    durationMode: 'fixed', requestedTotalDurationSec: 30, directorSettingsFingerprint: 'timing-fixture',
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '保留全部动作，以自然速度完成。' },
    characterContinuity: [], originalSourceContext,
  };
  const contents = [sourceParagraphs.slice(0, 2).join('\n\n'), sourceParagraphs.slice(2).join('\n\n')];
  const segments = contents.map((content, index) => ({
    title: `片段${index + 1}`, content, summary: '完整动作与因果', narrativePurpose: '完整切磋',
    entryState: index ? '双方继续交手' : '双方站定', exitState: index ? timedScene.exitState : '双方继续交手',
    transitionHint: '从当前动作直接接续', boundaryReason: '持续交手跨窗口', continuityPack: '同一场面同一交手',
    semanticSource: { sourceEvidence: [{ text: content }],
      events: facts.events.slice(index ? 2 : 0, index ? 5 : 2).map(({ id, action }) => ({ id, description: action })),
      dialogues: [], ...(index ? { sceneStaging: [timedScene] } : {}) },
  }));
  install((request, index) => {
    assert.equal(index, 0, 'fixed source planning remains one request');
    const data = dataOf(request, 'semantic_sequence_input');
    assert.equal(data.requiredSegmentCount, 2);
    assert.equal(data.requestedTotalDurationSec, 30);
    assert.deepEqual(data.originalSourceContext.actionPlan.events, facts.events);
    assert.match(system(request), /phase.action或semanticSource.events.phase/u);
    assert.match(system(request), /不可把同时动作逐项排队/u);
    return { reason: '完整事件在固定窗口中连续推进', fitStatus: 'balanced', segments };
  });
  const plan = await requestSemanticSequencePlan(config, input, undefined, { planId: 'timed', now: () => 1 });
  assert.equal(requests.length, 1);
  assert.equal(plan.totalDurationSec, 30);
  assert.deepEqual(plan.segments.map(({ globalStartSec, globalEndSec }) => [globalStartSec, globalEndSec]), [[0, 15], [15, 30]]);
  assert.deepEqual(plan.segments.map(({ content }) => content), contents);
  assert.deepEqual(plan.segments[1].semanticSource?.sceneStaging, [timedScene],
    'parallel waiting/recovery windows and pressure-to-escape completion survive phase transport');

  const action = timedScene.phases!.map(({ action }) => action).join('\n');
  install((request, index) => {
    assert.equal(index, 0, 'storyboard uses its current request only');
    const data = dataOf(request, 'storyboard_planning_data');
    assert.equal(data.sourceStory, contents[1]);
    assert.deepEqual(data.sceneStaging, [timedScene]);
    assert.match(system(request), /performance\.shots\[\]\.events/u);
    assert.match(system(request), /允许同时事件时窗重叠/u);
    assert.match(system(request), /旧镜内等分时窗/u);
    return { reason: '自然完成点与并行恢复', sceneStaging: [timedScene], shots: [{
      startSec: 0, endSec: 15, sourceExcerpt: contents[1], purpose: '完整交手与恢复', subject: '甲、乙',
      action, performance: action, space: '同一切磋场地', camera: '保持双方动作可见', direction: '沿当前交互关系',
      transition: '保留真实末态', lighting: '自然光', sound: '当下脚步及衣物摩擦', dialogue: '无',
      result: timedScene.exitState, sceneStaging: [timedScene],
    }] };
  });
  const shotPlan = await requestShotRecommendation(config, { story: contents[1], durationSec: 15,
    workflow: 'drama', pace: 'standard', sceneStaging: [timedScene] });
  assert.equal(requests.length, 1);
  assert.equal(shotPlan.shots[0].endSec, 15);
  assert.equal(shotPlan.shots[0].action, action);
  assert.equal(shotPlan.shots[0].performance, action);
  assert.deepEqual(shotPlan.shots[0].sceneStaging, [timedScene]);

  const custom = '用户自己的规则保持不变。';
  const oldPreset = `${custom}\n\n${PRE_NATURAL_TEMPO_VIDEO_ACTION_CHOREOGRAPHY_RULE}`;
  const upgraded = withVideoActionChoreographyScope(oldPreset, 'generation');
  assert.equal(upgraded, `${custom}\n\n${VIDEO_ACTION_CHOREOGRAPHY_RULE}`,
    'saved old first-party rule is replaced, not accumulated beside the new timing contract');
  assert.equal(withVideoActionChoreographyScope(upgraded, 'generation'), upgraded, 'request composition is idempotent');
  assert.ok(NOVEL_ACTION_DELIVERY_RULE.includes('真实多次行动不能因此减为一次'));
  assert.equal(JSON.stringify({ facts, timedScene }), baseline, 'requests do not rewrite saved source or timing');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: oldWindow });
  globalThis.fetch = oldFetch;
}
console.log('PASS natural action timing: source conversion (2 existing calls), fixed planning (1), storyboard (1), full-action/parallel-phase transport and exact legacy replacement; offline fixtures, no video-quality claim.');
