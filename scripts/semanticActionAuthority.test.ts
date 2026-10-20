import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import {
  materializeSemanticSequencePlan, semanticSegmentSourceContext,
  type SemanticSequencePlanningInput, type SemanticSequenceResponse,
} from '../src/semanticSequencePlan';
import type { TextApiConfig } from '../src/types';

// Regression fixture: the persisted event records stop at a shoulder check,
// while this same segment's complete prose continues through a waist-grab escape.
// This exercises the actual request transport, not a claim about model/video quality.
const content = '乙蹬地抢攻，甲在来手接近时压肘闪身。乙低扫甲脚踝，甲提脚同时按肩；乙撑地蹬腿横移脱开，翻身站起、拍土理带。甲抓袖进步肩撞，乙退到台边稳住。乙接着肘扫，甲撑地踢腿脱开；两人收手整理衣袖裙摆。乙抱住甲腰并别腿，甲沉重心撑开双臂破解抱腰，后撤半步抬手；乙松手踉跄站定。';
const incompleteEvents = [
  { id: 'e8', description: '乙抢攻', phase: '0–5秒抢攻' },
  { id: 'e9', description: '甲回应', phase: '5–10秒压肘闪身' },
  { id: 'e20', description: '肩撞后退到台边', phase: '10–15秒肩撞与退到台边' },
];
const oldScene = {
  version: 1 as const, sceneId: 'sparring', sourceEventIds: ['e8', 'e9', 'e20'],
  participants: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }],
  phases: incompleteEvents.map(({ id, description, phase }) => ({ id: `phase-${id}`, eventId: id, action: `${phase}，${description}` })),
  exitState: '乙已退到台边',
};
const input: SemanticSequencePlanningInput = {
  title: '完整攻防', story: content, segmentDurationSec: 15, durationMode: 'fixed', requestedTotalDurationSec: 15,
  directorSettingsFingerprint: 'synthetic-action-authority',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' }, characterContinuity: [],
};
const response: SemanticSequenceResponse = {
  segmentCount: 1, reason: '已保存的历史计划', fitStatus: 'balanced', segments: [{
    title: '抢攻至抱腰破解', content, summary: '全部交手', narrativePurpose: '连续攻防',
    entryState: '双方站定', exitState: '抱腰已破解，双方站定', transitionHint: '继续对峙',
    boundaryReason: '固定窗口', continuityPack: '同一场面',
    semanticSource: { sourceEvidence: [{ text: content }], events: incompleteEvents, dialogues: [], sceneStaging: [oldScene] },
  }],
};
const plan = materializeSemanticSequencePlan(input, response, { planId: 'incomplete-records', now: 1 });
const planBefore = JSON.stringify(plan);
const context = semanticSegmentSourceContext(plan, plan.segments[0]);
assert.equal(context.generationStoryContent, content);
assert.deepEqual(context.segment.semanticSource.events, incompleteEvents);
assert.equal(context.sourceAuthority?.performanceSource, 'generationStoryContent');

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://semantic-action-authority.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'mock', temperature: 0, maxTokens: 8192, vision: false };
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
type Request = { messages: Array<{ role: string; content: string }> };
const requests: Request[] = [];
const dataOf = (request: Request): Record<string, any> => {
  const user = request.messages.find(({ role }) => role === 'user')!.content;
  const match = user.match(/<storyboard_planning_data>\s*([\s\S]*?)\s*<\/storyboard_planning_data>/u);
  assert.ok(match, 'only the original planning request is expected');
  return JSON.parse(match[1]);
};

try {
  globalThis.fetch = async () => { throw new Error('This fixture cannot make live requests'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as Request;
      requests.push(request);
      const data = dataOf(request);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ reason: '完整正文统一排程', shots: [{
          startSec: 0, endSec: 15, sourceExcerpt: data.sourceStory, purpose: '完整攻防', subject: '甲、乙',
          action: data.sourceStory, camera: '中全景保持双方可见', transition: '连续动作', lighting: '日光',
          sound: '脚步与衣物摩擦', result: '抱腰已破解，双方站定', space: '比武台',
          direction: '双方相对', performance: '来招与回应同步衔接', dialogue: '无',
        }] }),
      } }] }) };
    },
  } } });

  // Old serialized contexts lack sourceAuthority. The existing request receives
  // the current contract without rewriting the project, dropping its evidence,
  // or deriving a local event whitelist/timing replacement.
  const legacy = structuredClone(context);
  delete legacy.sourceAuthority;
  const legacyBefore = JSON.stringify(legacy);
  const result = await requestShotRecommendation(config, {
    story: '调用方的旧摘要只写到肩撞', durationSec: 15, workflow: 'drama', pace: 'standard',
    requiredSegmentDurationSec: 5, allowDurationExpansion: true,
    sequenceSegmentContext: legacy as unknown as Record<string, unknown>,
  });
  assert.equal(requests.length, 1, 'no model review, repair or extra planning call was introduced');
  const data = dataOf(requests[0]);
  assert.equal(data.sourceStory, content, 'complete assigned prose beats a stale caller summary');
  assert.equal(data.sequenceSegmentContext.generationStoryContent, data.sourceStory);
  assert.deepEqual(data.sequenceSegmentContext.segment.semanticSource.events, incompleteEvents);
  assert.deepEqual(data.sceneStaging, [oldScene], 'existing state evidence is retained without local retiming');
  assert.equal(data.sourcePlanningAuthority.performanceSource, 'sourceStory');
  assert.equal(data.sourcePlanningAuthority.sourceRecordsRole, 'supporting-evidence-not-action-allowlist');
  assert.equal(data.sequenceSegmentContext.sourceAuthority.recordTimingRole, 'unconfirmed-timing-hints');
  assert.equal(data.durationSec, 15);
  assert.equal(data.durationAdjustmentPolicy, 'fixed');
  assert.equal(data.requiredSegmentDurationSec, undefined);
  const rules = requests[0].messages.filter(({ role }) => role === 'system').map(({ content: text }) => text).join('\n');
  assert.doesNotMatch(rules, /本段只推进已分配phase|事件ID可跨段但只演当前phase/u,
    'the previous contradictory phase-only contract must not reach the model');
  assert.match(rules, /来招尚在接近时闪避或格挡即同时发生/u);
  assert.match(rules, /支撑脚蹬地推动身体/u);
  assert.equal(result.shots[0].action, content, 'postprocessing does not trim later waist-grab actions');
  assert.equal(result.shots[0].endSec, 15);
  assert.equal(JSON.stringify(legacy), legacyBefore);
  assert.equal(JSON.stringify(plan), planBefore);

  // An explicit user edit remains authoritative: stale records must not restore
  // removed events or dialogue. The old timing contract is still only evidence.
  const editedPlan = structuredClone(plan);
  editedPlan.segments[0].content = '乙缓缓绕行三步，甲随转；双方收手站定。';
  editedPlan.segments[0].contentOverridden = true;
  editedPlan.segments[0].semanticSource!.dialogues = [{ id: 'old-line', speaker: '甲', text: '历史对白' }];
  const editedContext = semanticSegmentSourceContext(editedPlan, editedPlan.segments[0]);
  const editedBefore = JSON.stringify(editedPlan);
  await requestShotRecommendation(config, { story: content, durationSec: 15, workflow: 'drama', pace: 'standard',
    sequenceSegmentContext: editedContext as unknown as Record<string, unknown> });
  assert.equal(requests.length, 2, 'each explicit call remains one model request');
  const editedData = dataOf(requests[1]);
  assert.equal(editedData.sourceStory, editedPlan.segments[0].content);
  assert.equal(editedData.sceneStaging, undefined, 'edited prose does not adopt old phase state as a fresh schedule');
  assert.equal(JSON.stringify(editedPlan), editedBefore);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
console.log('PASS semantic action authority: complete prose with incomplete legacy events, synchronized response contract, fixed duration, user edit precedence, unchanged saved data and one offline request per invocation.');
