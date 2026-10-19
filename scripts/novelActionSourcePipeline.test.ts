import assert from 'node:assert/strict';
import { requestShotRecommendation, requestStoryPreparationWithReview, requestStoryVisualParagraphRewrite } from '../src/services/llm';
import { STORY_VISUAL_ENGINE_VERSION, type StoryVisualActionPlan, type StoryVisualParagraph } from '../src/storyVisualAction';
import { NOVEL_ACTION_SOURCE_RULE, NOVEL_ACTION_CONTINUITY_RULE, NOVEL_ACTION_FRAME_RULE } from '../src/novelActionDirection';
import type { SceneStaging } from '../src/sceneStaging';
import type { Character, TextApiConfig } from '../src/types';
import { readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';

// Synthetic transport checks: supplied model answers are fixtures, never an
// assertion that the real model understands motion or a video looks natural.
const character: Character = {
  id: 'person-lin', name: '林澜', gender: '女', apparentAge: '成年', race: '人类', height: '约一米七',
  appearance: '黑发', outfit: '蓝外套', personality: '克制，听完再回应', motionHabits: '动作轻缓',
  signatureProps: '随身旧怀表', anchor: '蓝外套黑发', negativeContinuity: '保持普通人的身体结构', assetIds: [],
  nsfwProfile: { fullBody: 'private-profile-content-sentinel' },
};
const extendedCharacter = { ...character, dossier: { notes: 'internal-dossier-content-sentinel' },
  unrequestedRuntimeField: 'runtime-extension-content-sentinel' };
const source = '林澜把杯子递给周明。周明接稳后，听见门响，抬杯的动作停住，随后把杯子放回桌上。'
  + '\n\n林澜想拉住周明，却在碰到前收回手。门已经打开，谁开的仍不知道。她每天清晨练剑；若有人闯入，她才会拔剑。';
const body = '林澜将杯子递到周明手边，周明接稳后她松手。门响时，周明正抬起杯子，动作短暂停住；随后将杯底落回桌面，再松开手。'
  + '\n\n林澜朝周明伸手，却在碰到之前停住，将手收回。门已打开，开门者仍未知。她每天清晨练剑；若有人闯入，她才会拔剑。';
const facts: StoryVisualActionPlan = {
  version: 1, sourceParagraphs: source.split('\n\n').map((text, index) => ({ id: `p${index + 1}`, text })),
  summary: '交接后门响打断抬杯；杯归桌面。伸手在接触前中止，开门者未知，练剑为习惯，拔剑仅为条件。',
  events: [
    { id: 'e-cup', sourceParagraphIds: ['p1'], evidence: '林澜把杯子递给周明。', actor: '林澜', target: '周明', action: '交接杯子',
      phases: ['周明接稳'], result: '杯子由周明持有', uncertainties: ['双方具体握持方式未说明'] },
    { id: 'e-interrupt', sourceParagraphIds: ['p1'], evidence: '听见门响，抬杯的动作停住，随后把杯子放回桌上。', actor: '周明', target: '杯子',
      action: '门响打断抬杯，随后放回桌上', result: '杯子在桌上', uncertainties: [] },
    { id: 'e-abort', sourceParagraphIds: ['p2'], evidence: '林澜想拉住周明，却在碰到前收回手。', actor: '林澜', target: '周明',
      action: '想拉住但在接触前中止', result: '没有碰到', uncertainties: [] },
    { id: 'e-door', sourceParagraphIds: ['p2'], evidence: '门已经打开，谁开的仍不知道。', actor: '', target: '门', action: '门已打开',
      result: '开着', uncertainties: ['开门者未知'] },
    { id: 'e-habit', sourceParagraphIds: ['p2'], evidence: '她每天清晨练剑；若有人闯入，她才会拔剑。', actor: '林澜', target: '',
      action: '练剑是日常习惯，拔剑是未触发条件', result: '本场未执行练剑或拔剑', uncertainties: [] },
  ],
};
const scene: SceneStaging = {
  version: 1, sceneId: 'room', sourceEventIds: ['e-cup', 'e-interrupt', 'e-abort', 'e-door'],
  worldRelations: ['林澜与周明在桌旁；门在同一房间'],
  participants: [{ id: 'person-lin', name: '林澜', actionTarget: '周明' }, { id: 'person-zhou', name: '周明', actionTarget: '杯子' }],
  phases: [
    { id: 'cup-transfer', eventId: 'e-cup', participantIds: ['person-lin', 'person-zhou'], startState: '杯子由林澜持有',
      action: '周明接稳后林澜松手', endState: '同一杯子由周明持有，林澜的手已收回' },
    { id: 'cup-put-down', eventId: 'e-interrupt', startState: '周明持杯上抬，门响传来', action: '暂停后将杯底落桌再松手',
      endState: '杯子在桌面，双方均未持杯，周明已经听见门响' },
    { id: 'reach-aborted', eventId: 'e-abort', startState: '林澜想留住周明', action: '伸手在触及前停住并收回',
      endState: '林澜没有抓住周明，未拔剑，开门者仍未揭示' },
  ], entryState: '林澜持杯', exitState: '杯在桌上；未抓住周明；门开着，开门者未知',
};
const paragraphs: StoryVisualParagraph[] = [{ id: 'v1', sourceParagraphIds: ['p1', 'p2'], eventIds: facts.events.map(({ id }) => id),
  text: body, stagingAdditions: ['杯底落到桌面后再松手；作为既有放杯动作的实现'], sceneStaging: scene }];
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://novel-actions.invalid/v1/chat/completions',
  apiKey: 'synthetic-no-network', model: 'mock', temperature: 0, maxTokens: 8192, vision: false };
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
let requests: CapturedStoryRequest[] = [];
const system = (request: CapturedStoryRequest) => request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
const dataOf = (request: CapturedStoryRequest, tag: string): Record<string, any> => {
  const user = request.messages.find(({ role }) => role === 'user')!.content;
  const text = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))?.[1];
  assert.ok(text, `missing ${tag} production request data`);
  return JSON.parse(text);
};
const install = (handler: (request: CapturedStoryRequest, index: number) => unknown) => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(handler(request, requests.length - 1)) } }] }) };
    },
  } } });
};
const assertOrdinaryCharacter = (actual: Record<string, unknown>, request: CapturedStoryRequest) => {
  for (const key of ['personality', 'motionHabits', 'height', 'signatureProps', 'negativeContinuity'] as const) {
    assert.equal(actual[key], character[key], `${key} reaches the actual request`);
  }
  const wire = JSON.stringify(request);
  for (const sentinel of ['private-profile-content-sentinel', 'internal-dossier-content-sentinel', 'runtime-extension-content-sentinel']) {
    assert.ok(!wire.includes(sentinel), `ordinary direction must not serialize ${sentinel}`);
  }
};
const baseline = JSON.stringify({ facts, paragraphs, character: extendedCharacter });
let checks = 0;
try {
  globalThis.fetch = async () => { throw new Error('Offline test must never call a live endpoint'); };
  for (const detailMode of ['detailed', 'faithful'] as const) {
    install((request, index) => {
      assert.ok(index < 2, 'use the existing understanding and visualizing requests only');
      const data = readStoryVisualData(request);
      assert.equal(data.sourceTextOrRequirement, source);
      assert.equal(data.detailMode, detailMode);
      assert.equal(data.engineVersion, STORY_VISUAL_ENGINE_VERSION);
      assertOrdinaryCharacter((data.continuity as { characters: Record<string, unknown>[] }).characters[0], request);
      assert.ok(system(request).includes(NOVEL_ACTION_SOURCE_RULE));
      assert.ok(system(request).includes(NOVEL_ACTION_CONTINUITY_RULE));
      if (index === 0) {
        assert.equal(data.stage, 'understanding');
        return { version: facts.version, summary: facts.summary, events: facts.events };
      }
      assert.equal(data.stage, 'visualizing');
      assert.deepEqual((data.actionPlan as StoryVisualActionPlan).events, facts.events,
        'intent, abort, condition and unknown source survive the fact-to-body handoff');
      return { paragraphs: detailMode === 'detailed' ? paragraphs : [{ ...paragraphs[0], text: source, stagingAdditions: [], sceneStaging: undefined }] };
    });
    const result = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize', undefined,
      { characters: [extendedCharacter], detailMode });
    assert.equal(requests.length, 2, 'no new model stage or automatic retry');
    assert.equal(result.text, detailMode === 'detailed' ? body : source);
    assert.deepEqual(result.actionPlan, facts, 'director choices do not overwrite source uncertainties');
    assert.deepEqual(result.paragraphs?.[0].sceneStaging, detailMode === 'detailed' ? scene : undefined);
    assert.deepEqual(result.paragraphs?.[0].stagingAdditions, detailMode === 'detailed' ? paragraphs[0].stagingAdditions : []);
    assert.equal(result.engineVersion, STORY_VISUAL_ENGINE_VERSION);
    checks++;
  }

  install((request, index) => {
    assert.equal(index, 0);
    const data = readStoryVisualData(request);
    assert.equal(data.stage, 'rewriting');
    assert.equal(data.previousParagraph?.sceneStaging?.phases?.[2].endState, scene.phases![2].endState);
    assertOrdinaryCharacter((data.continuity as { characters: Record<string, unknown>[] }).characters[0], request);
    return { paragraph: paragraphs[0] };
  });
  const rewritten = await requestStoryVisualParagraphRewrite(config, source,
    { text: body, warnings: [], actionPlan: facts, paragraphs, engineVersion: STORY_VISUAL_ENGINE_VERSION, detailMode: 'detailed' },
    'v1', undefined, undefined, { characters: [extendedCharacter] });
  assert.equal(requests.length, 1, 'user-selected local rewrite remains one request');
  assert.deepEqual(rewritten.paragraphs![0].sceneStaging, scene);
  checks++;

  // Direct novel input and already adopted ordinary-action staging both flow
  // through the real storyboard request. No precondition on special headings.
  for (const adopted of [false, true]) {
    install((request, index) => {
      assert.equal(index, 0, 'valid direct planning needs no additional stage');
      const data = dataOf(request, 'storyboard_planning_data');
      assert.equal(data.sourceStory, adopted ? body : source);
      assertOrdinaryCharacter(data.characterContinuity[0], request);
      assert.ok(system(request).includes(NOVEL_ACTION_SOURCE_RULE), 'direct novel planning receives general action authority');
      assert.ok(system(request).includes(NOVEL_ACTION_CONTINUITY_RULE));
      assert.ok(system(request).includes(NOVEL_ACTION_FRAME_RULE));
      assert.deepEqual(data.sceneStaging, adopted ? [scene] : undefined);
      return { reason: '同一场面中的交接、信息打断与未完成伸手', sceneStaging: [scene], shots: [{
        startSec: 0, endSec: 15, sourceExcerpt: adopted ? body : source, purpose: '呈现原定普通行为', subject: '林澜、周明',
        action: body, performance: '沿信息触发暂停，不追加喝水或拔剑', space: '同一房间的桌边与门口',
        camera: '中景保持双人与杯子可读', direction: '沿既定相对位置', transition: '沿放杯末态继续', lighting: '室内自然光',
        sound: '门响和杯底接触桌面的声音', dialogue: '无', result: scene.exitState, sceneStaging: [scene],
      }] };
    });
    const planned = await requestShotRecommendation(config, { durationSec: 15, workflow: 'drama', pace: 'standard',
      story: adopted ? body : source, characterContinuity: [extendedCharacter], ...(adopted ? { sceneStaging: [scene] } : {}) });
    assert.equal(requests.length, 1);
    assert.deepEqual(planned.sceneStaging, [scene]);
    assert.deepEqual(planned.shots[0].sceneStaging, [scene]);
    assert.equal(planned.shots[0].action, body);
    assert.equal(planned.shots[0].result, scene.exitState);
    checks++;
  }
  assert.equal(JSON.stringify({ facts, paragraphs, character: extendedCharacter }), baseline, 'requests do not mutate saved facts, staging or dossiers');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow });
  globalThis.fetch = previousFetch;
}
console.log(`PASS novel action source pipeline: ${checks} offline production-path checks; ordinary character projection, modal/prop state transport, existing request counts. No generated-video quality claim.`);
