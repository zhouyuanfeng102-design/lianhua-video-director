import assert from 'node:assert/strict';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import type { SemanticSequencePlanningInput, SemanticSequenceResponse, SemanticSequenceResponseSegment } from '../src/semanticSequencePlan';
import type { TextApiConfig } from '../src/types';

// These synthetic replies verify the request and saved-plan contract. They do
// not establish whether a real model will choose natural action timing.
type HttpPayload = { body?: string };
type HttpReply = { status: number; body: string };
type WireBody = { messages: Array<{ role: string; content: string }> };
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://semantic-action-window.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential', model: 'synthetic-action-window',
  temperature: 0, maxTokens: 8192, vision: false,
};
const paragraphs = [
  '林舟在台边放下杯子，抚平袖口。',
  '林舟沿桌绕到陈岚面前，两人相距一步。',
  '林舟颔首，陈岚收肘起势。',
  '林舟连续直拳三次，陈岚侧移避开第一拳，再以左前臂挡住第二拳、右掌拨开第三拳。',
  '陈岚低扫两次，林舟分别提腿避开；第二次避开后，林舟右掌按在陈岚左肩。',
  '陈岚慢慢屈膝下沉，肩膀脱开掌心；林舟收手，退半步整理衣领。陈岚说：“到这里。”',
];
const story = paragraphs.join('\n\n');
const input = (): SemanticSequencePlanningInput => ({
  title: '自然动作窗口合成用例', story, segmentDurationSec: 15, durationMode: 'ai-estimated',
  directorSettingsFingerprint: 'synthetic-action-window-settings',
  creativeDirection: {
    directorStyle: { id: 'synthetic-director', name: '自然动作', summary: '连续因果与自然速度' },
    visualStyle: { name: '合成风格', prompt: '合成视觉' },
    stylePreset: { id: 'synthetic-style', name: '合成预设', visual: '自然观察', camera: '跟随行动', lighting: '现场光', sound: '同期声' },
    cameraTerms: [], lightingTerms: [], extraRequirement: '完整保留动作、三拳两扫及收手整理；慢慢仅用于屈膝下沉。',
  },
  pacing: { pace: 'natural', extraRequirement: '连续动作按真实因果推进' },
  characterContinuity: [{ id: 'lin', name: '林舟' }, { id: 'chen', name: '陈岚' }],
  shotMode: 'auto',
});
const actionEvents = [
  { id: 'put-cup', description: '林舟在台边放下杯子', phase: '开场先放下杯子' },
  { id: 'straighten-sleeve', description: '林舟抚平袖口', phase: '必要整理完整完成，接绕行' },
  { id: 'walk-around', description: '林舟沿桌绕到陈岚面前', phase: '沿真实路径到达一步距离' },
  { id: 'nod-and-prepare', description: '林舟颔首，陈岚收肘起势', phase: '颔首与回应连续接入交手' },
  { id: 'three-punches', description: paragraphs[3], phase: '连续三次直拳及对应三次避挡拨，不逐招停稳' },
  { id: 'two-sweeps', description: '陈岚低扫两次，林舟分别提腿避开', phase: '两次低扫与两次避开相继完成' },
  { id: 'press-shoulder', description: '第二次避开后，林舟右掌按在陈岚左肩', phase: '接触后持续按肩直到下沉脱开' },
  { id: 'sink-and-release', description: '陈岚慢慢屈膝下沉，肩膀脱开掌心', phase: '仅下沉慢慢进行，脱开后不再保持接触' },
  { id: 'recover-and-tidy', description: '林舟收手，退半步整理衣领', phase: '收手与必要整理都完整保留' },
];
const mergedWindow = (): SemanticSequenceResponseSegment => ({
  title: '整理、就位与连续交手',
  content: paragraphs.join(''),
  summary: '六个自然段中的连续事件共同占用一个生成窗口',
  narrativePurpose: '从准备、试探推进到按肩脱开和收手整理',
  entryState: '林舟在台边持杯，陈岚在桌前',
  exitState: '陈岚已脱开掌心，林舟收手退半步并整理衣领',
  transitionHint: '承接当前结果，不重演整理、绕行或交手',
  boundaryReason: '连续动作已推进至收手与原话完成，不按自然段切开',
  continuityPack: '杯子留在台边，按肩接触已经解除',
  semanticSource: {
    sourceEvidence: paragraphs.map((text) => ({ text })),
    events: structuredClone(actionEvents),
    dialogues: [{ id: 'stop-line', speaker: '陈岚', text: '到这里。', language: '中文' }],
  },
});
const response = (segments: SemanticSequenceResponseSegment[]): Omit<SemanticSequenceResponse, 'segmentCount'> => ({
  reason: '完整连续场面先按行为先后及自然速度编排，再分配足额时间窗。', fitStatus: 'balanced', segments,
});
const prompt = (payload: HttpPayload, role: string): string =>
  (JSON.parse(payload.body || '{}') as WireBody).messages.find((message) => message.role === role)?.content ?? '';
const envelope = (payload: HttpPayload): Record<string, unknown> => {
  const user = prompt(payload, 'user');
  assert.ok(user.startsWith('semantic_sequence_input='));
  return JSON.parse(user.split('\n', 1)[0].slice('semantic_sequence_input='.length)) as Record<string, unknown>;
};
const install = (authored: unknown): HttpPayload[] => {
  const calls: HttpPayload[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: HttpPayload): Promise<HttpReply> => {
      calls.push(payload);
      assert.equal(calls.length, 1, 'this valid planning reply requires no extra model step');
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(authored) } }] }) };
    } },
  } });
  return calls;
};
const assertSharedActionWindowRule = (system: string): void => {
  assert.match(system, /原文自然段、旧paragraphs条目、事件或phase条目不是已确认的视频段界/u);
  assert.match(system, /本次建立事件分配之后/u);
  assert.match(system, /AI适配与固定总时长共同采用先排整片、后切窗口/u);
  assert.match(system, /同一窗口可连续承接来自多个自然段的多个既有动作/u);
  assert.match(system, /不能把局部慢速扩散到整场/u);
  assert.match(system, /真实收手、整理、喘息与重新起势完整保留/u);
  assert.match(system, /不得写D–D秒、0秒区间/u);
  assert.match(system, /不能借重叠隐藏走路、取物、检查或坐下所需的过程/u);
  assert.match(system, /持械姿势只用于已声明的身份、外观或材质连续性/u);
  assert.match(system, /不授权在空手过程加入持械、兵刃接触、金属声或武器展示/u);
  assert.match(system, /不可把同时动作逐项排队/u);
  assert.match(system, /content在每句已分配对白的动作和发话位置写入【对白 对应id】，不把原话抄进JSON/u);
  assert.match(system, /正文记号与记录逐句对应，原字由区间取回，语言、归属与continuation一致/u);
};
const assertAuthoredActions = (segment: SemanticSequenceResponseSegment): void => {
  assert.equal(segment.content, paragraphs.join(''));
  assert.deepEqual(segment.semanticSource.sourceEvidence, paragraphs.map((text) => ({ text })));
  assert.deepEqual(segment.semanticSource.events, actionEvents);
  assert.match(segment.content, /连续直拳三次/u);
  assert.match(segment.content, /第一拳.*第二拳.*第三拳/u);
  assert.match(segment.content, /低扫两次.*第二次避开后/u);
  assert.match(segment.content, /抚平袖口.*慢慢屈膝下沉.*肩膀脱开掌心.*收手.*整理衣领/u);
  assert.deepEqual(segment.semanticSource.dialogues, mergedWindow().semanticSource.dialogues);
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network: action-window planning is fully mocked'); };
try {
  // An old UI total may still exist in state; it must not become an AI budget.
  const aiInput = { ...input(), requestedTotalDurationSec: 300 };
  const aiCalls = install(response([mergedWindow()]));
  const aiPlan = await requestSemanticSequencePlan(config, aiInput, undefined, { planId: 'synthetic-ai-window', now: () => 12345 });
  assert.equal(aiCalls.length, 1);
  const aiPayload = envelope(aiCalls[0]);
  assert.equal(aiPayload.story, story);
  assert.equal(aiPayload.durationMode, 'ai-estimated');
  assert.equal(aiPayload.durationAdjustmentPolicy, 'ai-chooses-segment-count');
  for (const key of ['requestedTotalDurationSec', 'totalDurationSec', 'requiredSegmentCount', 'segmentCount']) {
    assert.equal(Object.hasOwn(aiPayload, key), false, `AI must not inherit ${key}`);
  }
  assertSharedActionWindowRule(prompt(aiCalls[0], 'system'));
  assert.match(prompt(aiCalls[0], 'system'), /这不等于一个动作一个窗口或一个事件一个窗口/u);
  assert.match(prompt(aiCalls[0], 'system'), /若现有N×D只能把末尾串行动作压成D–D秒、瞬移或只写结果，先重新调配尚未确认的完整行动/u);
  assert.match(prompt(aiCalls[0], 'system'), /仍不足时增加所需的足额D秒窗口并在真实进度处切分/u);
  const exampleText = prompt(aiCalls[0], 'system').split('\n').find((line) => line.startsWith('{"reason":'));
  assert.ok(exampleText, 'the single response example is a complete JSON object');
  const example = JSON.parse(exampleText);
  assert.equal(example.segments[0].semanticSource.sceneStaging[0].version, 1);
  assert.equal(example.segments[0].semanticSource.dialogues[0].text, undefined);
  assert.deepEqual(
    [example.segments[0].semanticSource.dialogues[0].sourceStart, example.segments[0].semanticSource.dialogues[0].sourceEnd],
    [12, 24],
  );
  assert.equal(example.segments[0].semanticSource.sourceEvidence[0].text, undefined);
  assert.equal(example.segments[0].content.includes('【对白 dialogue-1】'), true);
  assert.equal(exampleText.includes('把标有'), false);
  assert.doesNotMatch(prompt(aiCalls[0], 'system'), /sceneId:string|sourceEventIds\?:string\[\]/u);
  const finalInstruction = prompt(aiCalls[0], 'user').split('\n\n').slice(1).join('\n\n');
  assert.match(finalInstruction, /生成窗口D=15秒/u);
  assert.match(finalInstruction, /来源记录，不是已分好的视频段/u);
  assert.match(finalInstruction, /reason、segments\.content、events\.phase、sceneStaging及入口\/出口必须表达同一次完整时间安排/u);
  assert.match(finalInstruction, /不减少动作次数、不删除整理喘息/u);
  assert.match(finalInstruction, /走向终点、取放检查及站稳落座都属于动作过程/u);
  assert.match(finalInstruction, /串行动作都不能标成D–D秒或在D秒才启动却同时完成/u);
  assert.equal(story.split('\n\n').length, 6);
  assert.equal(aiPlan.segments.length, 1, 'N comes from returned windows, not source paragraphs or event count');
  assert.equal(aiPlan.totalDurationSec, 15);
  assert.deepEqual(aiPlan.segments.map(({ globalStartSec, globalEndSec }) => [globalStartSec, globalEndSec]), [[0, 15]]);
  assert.equal(aiPlan.requestedTotalDurationSec, undefined);
  assert.equal(aiPlan.sourceStoryContent, story);
  assertAuthoredActions(aiPlan.segments[0] as SemanticSequenceResponseSegment);
  console.log('PASS AI adaptation: six source paragraphs remain one 15-second window, all authored actions retained, one mocked request');

  const continuingAction = '两人随后重新搭手，在十五秒内持续相互施压，最后同时松开。';
  const fixedInput = { ...input(), story: `${story}\n\n${continuingAction}`, durationMode: 'fixed' as const, requestedTotalDurationSec: 30 };
  const finalWindow: SemanticSequenceResponseSegment = {
    title: '持续搭手施压', content: continuingAction, summary: '新的持续行动', narrativePurpose: '完成持续施压练习',
    entryState: mergedWindow().exitState, exitState: '两人已经松开', transitionHint: '不重播前窗交手',
    boundaryReason: '持续施压完成', continuityPack: '双手已经解除接触',
    semanticSource: { sourceEvidence: [{ text: continuingAction }],
      events: [{ id: 'sustained-pressure', description: continuingAction, phase: '搭手、持续施压到最后松开' }], dialogues: [] },
  };
  const fixedCalls = install(response([mergedWindow(), finalWindow]));
  const fixedPlan = await requestSemanticSequencePlan(config, fixedInput, undefined, { planId: 'synthetic-fixed-window', now: () => 12346 });
  assert.equal(fixedCalls.length, 1);
  const fixedPayload = envelope(fixedCalls[0]);
  assert.equal(fixedPayload.story, fixedInput.story);
  assert.equal(fixedPayload.durationAdjustmentPolicy, 'fixed-total-duration');
  assert.equal(fixedPayload.segmentDurationSec, 15);
  assert.equal(fixedPayload.requestedTotalDurationSec, 30);
  assert.equal(fixedPayload.totalDurationSec, 30);
  assert.equal(fixedPayload.requiredSegmentCount, 2);
  assertSharedActionWindowRule(prompt(fixedCalls[0], 'system'));
  assert.match(prompt(fixedCalls[0], 'system'), /T=30秒/u);
  assert.match(prompt(fixedCalls[0], 'system'), /N=2段/u);
  assert.match(prompt(fixedCalls[0], 'system'), /T、D、N固定后不得套用AI适配的加窗权限/u);
  assert.match(prompt(fixedCalls[0], 'system'), /不能静默加长、越界完成或把动作移出用户固定范围/u);
  assert.match(prompt(fixedCalls[0], 'user').split('\n\n').slice(1).join('\n\n'), /全片T=30秒固定/u);
  assert.equal(fixedPlan.durationMode, 'fixed');
  assert.equal(fixedPlan.requestedTotalDurationSec, 30);
  assert.equal(fixedPlan.totalDurationSec, 30);
  assert.equal(fixedPlan.segments.length, 2);
  assert.deepEqual(fixedPlan.segments.map(({ globalStartSec, globalEndSec }) => [globalStartSec, globalEndSec]), [[0, 15], [15, 30]]);
  assertAuthoredActions(fixedPlan.segments[0] as SemanticSequenceResponseSegment);
  assert.deepEqual(fixedPlan.segments[1].semanticSource, finalWindow.semanticSource);
  assert.equal(fixedPlan.segments[1].content, continuingAction);
  console.log('PASS fixed duration: shared cross-paragraph scheduling keeps T=30, D=15, N=2, one mocked request');
  console.log('semanticActionWindowPlanning: 2/2 passed (request/materialization contract only; no real model quality claim)');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
