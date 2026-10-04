import assert from 'node:assert/strict';
import { requestShotRecommendation, requestStoryDurationEstimate, type StoryDurationEstimate } from '../src/services/llm';
import { STORY_PACING_RULE, STORYBOARD_SPEECH_FIRST_PLANNING_RULE, STORYBOARD_SOURCE_PLANNING_AUTHORITY_RULE } from '../src/storyPacing';
import { buildShots } from '../src/promptEngine';
import { defaultStylePresets } from '../src/storage';
import type { AiStoryboardShotPlan, Scene, TextApiConfig } from '../src/types';

// Synthetic case-shaped dialogue. Only transport is tested: no paid model or
// real project data, and no claim that a mocked response proves model quality.
const lines = [
  '师傅若觉得不妥，也可以亲另一边。这样不就公平了？',
  '这样，你总该满意了。',
  '师傅果然还是偏心，你亲他的时候可比刚才温柔多了，待会儿让他自己说说，到底是哪边更好吧？',
];
assert.deepEqual(lines.map((line) => line.match(/\p{Script=Han}/gu)?.length), [21, 8, 39]);
const story = `成年乙停下脚步，对成年甲说：“${lines[0]}”成年甲亲吻成年丙的脸颊，离开后对成年乙说：“${lines[1]}”成年乙接着说：“${lines[2]}”随后三人沿原路继续行走。`;
const scene: Scene = { id: 'speech-scene', title: '纯合成轮流发话与口部动作', content: story,
  summary: story, characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
const shot = (startSec: number, endSec: number, patch: Partial<AiStoryboardShotPlan> = {}): AiStoryboardShotPlan => ({
  startSec, endSec, sourceExcerpt: story, subject: '成年甲、成年乙、成年丙',
  purpose: '依原文保持发话与反应次序', action: '三人保持原站位', camera: '同轴侧面中景，根据当前发话者转移重点',
  transition: '承接前镜结果', lighting: '沿用场内自然光', sound: '原对白及轻微环境声，无配乐',
  result: '保持原人物位置和朝向', space: '三人不越轴换位', direction: '维持原世界方向',
  performance: '听者保持听取反应，不做同步说话口型', dialogue: '无', ...patch,
});
const plannedShots: AiStoryboardShotPlan[] = [
  shot(0, 6.5, { subject: '成年乙', action: '成年乙停步，朝成年甲发话',
    dialogue: `第0.5–6.2s @成年乙（原声音身份、在画、听者成年甲）：“${lines[0]}”` }),
  shot(6.5, 9, { subject: '成年甲、成年丙', action: '成年甲靠近成年丙，亲吻脸颊，随后离开接触；此镜不说话',
    result: '亲吻已结束，成年甲嘴部恢复自由', camera: '同轴双人中近景看清接触和离开' }),
  shot(9, 15, { subject: '成年甲', action: '成年甲在接触结束后才开口回应成年乙，随后接收成年乙的反应',
    dialogue: `第0.3–3.2s @成年甲（原声音身份、在画、听者成年乙）：“${lines[1]}”` }),
  shot(15, 26, { subject: '成年乙', action: '成年乙保持同一世界方位，完整说完后一句；成年甲和成年丙听取',
    dialogue: `第0.2–10.7s @成年乙（原声音身份、在画、听者成年甲）：“${lines[2]}”` }),
  shot(26, 30, { action: '三人沿原路继续行走，不重复上段亲吻或对白' }),
];
const correctedEstimate: StoryDurationEstimate = { minSec: 30, recommendedSec: 30, maxSec: 45,
  fitStatus: 'balanced', reason: '先保留完整发话区间，再将长句和后续行走移入相邻完整15秒段。' };
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://speech-planning.test/v1/chat/completions',
  apiKey: 'mock', model: 'mock-only', temperature: 0.2, maxTokens: 8192, vision: false };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
type RequestBody = { messages: Array<{ role: string; content: string }> };
let responses: unknown[] = [];
const calls: RequestBody[] = [];
const install = (values: unknown[]): void => {
  calls.length = 0; responses = values;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
    request: async (payload: { body: string }) => {
      calls.push(JSON.parse(payload.body));
      assert.ok(responses.length, 'unexpected extra model call / new semantic audit');
      const response = responses.shift();
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: typeof response === 'string' ? response : JSON.stringify(response) } }] }) };
    },
  } } });
  globalThis.fetch = (() => assert.fail('real network is forbidden')) as typeof fetch;
};
const system = (index = 0) => calls[index].messages.find((message) => message.role === 'system')!.content;
const data = (tag: string, index = 0): Record<string, any> => {
  const user = calls[index].messages.find((message) => message.role === 'user')!.content;
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, tag); return JSON.parse(match[1]);
};
const params = { durationSec: 30, requiredSegmentDurationSec: 15, workflow: 'drama', pace: '自然', story };
let groups = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); groups += 1; console.log(`PASS ${name}`); };

try {
  await test('duration estimation carries complete speech/oral-action timing before choosing whole-segment multiples', async () => {
    install([{ ...correctedEstimate, minSec: 15, recommendedSec: 15 }, correctedEstimate]);
    const result = await requestStoryDurationEstimate(config, { title: scene.title, story, segmentDurationSec: 15,
      beats: [{ id: 'beat', index: 0, text: story, sourceStart: 0, sourceEnd: story.length, kind: 'dialogue', weight: 1 }] });
    assert.deepEqual(result, correctedEstimate);
    assert.equal(calls.length, 2, 'reuse existing estimate+review, no new audit');
    assert.equal(data('story_data').story, story);
    assert.ok(system().includes(STORY_PACING_RULE));
    assert.match(system(), /完整发话区间/u); assert.match(system(), /口部动作与说话的先后/u);
  });

  await test('21/8/39-character case preserves AI multi-shot scheduling, kiss-before-speech and long line in the next full window', async () => {
    install([{ shots: plannedShots }, { shots: plannedShots, aiReview: { status: 'revised', summary: '保留长句并前置发话安排', issues: [] } }]);
    const result = await requestShotRecommendation(config, params, { reviewWithAi: true });
    assert.equal(calls.length, 2, 'same original planning/review stages');
    for (const index of [0, 1]) {
      assert.ok(system(index).includes(STORYBOARD_SPEECH_FIRST_PLANNING_RULE));
      assert.match(system(index), /15秒视频段不等于1个15秒镜头/u);
      assert.match(system(index), /本镜相对起止区间/u);
    }
    assert.equal(data('storyboard_planning_data').requiredShotCount, undefined);
    assert.deepEqual(data('storyboard_planning_data').internalHardBoundariesSec, [15]);
    assert.equal(data('storyboard_ai_review_data', 1).sourceStory, story);
    assert.deepEqual(result.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 6.5], [6.5, 9], [9, 15], [15, 26], [26, 30]]);
    assert.deepEqual(result.shots.map((value) => value.dialogue), plannedShots.map((value) => value.dialogue));
    const materialized = buildShots({ scene, characters: [], locations: [], props: [], assets: [], workflow: 'drama',
      durationSec: 30, shotMode: 'auto', shotCount: result.count, pace: 'standard', camera: '', lighting: '',
      style: defaultStylePresets[0], extra: '', aiPlan: result });
    assert.equal(materialized.length, 5);
    for (const [index, expected] of plannedShots.entries()) {
      assert.equal(materialized[index].dialogue, expected.dialogue);
      assert.equal(materialized[index].action, expected.action);
      assert.equal(materialized[index].camera, expected.camera);
    }
    assert.equal(materialized[3].startSec, 15, 'corrected fixture no longer starts the long line at11s with only4s remaining');
    assert.equal(materialized[1].dialogue, '无');
  });

  await test('explicit unconfirmed-master permission transports an AI-authored full-segment expansion without another model request', async () => {
    const complete = { shots: plannedShots, durationEstimate: correctedEstimate };
    install([complete, complete]);
    const result = await requestShotRecommendation(config, { ...params, durationSec: 15, allowDurationExpansion: true }, { reviewWithAi: true });
    assert.equal(result.durationSec, 30); assert.deepEqual(result.durationEstimate, correctedEstimate);
    assert.equal(calls.length, 2);
    for (const [index, tag] of ['storyboard_planning_data', 'storyboard_ai_review_data'].entries()) {
      assert.equal(data(tag, index).durationSec, index === 0 ? 15 : 30,
        'AI-authored expansion becomes the sole duration contract for review');
      assert.equal(data(tag, index).allowDurationExpansion, true);
      assert.equal(data(tag, index).durationAdjustmentScope, 'unconfirmed-full-film-only');
      assert.match(system(index), /相邻窗口/u); assert.match(system(index), /recommendedSec不得小于输入durationSec/u);
    }
  });

  await test('expanded duration is kept in the structural repair payload', async () => {
    const expandedEstimate = { minSec: 195, recommendedSec: 210, maxSec: 225,
      fitStatus: 'balanced' as const, reason: '为完整保留对白增加一个15秒窗口。' };
    const expandedShots = Array.from({ length: 14 }, (_, index) => shot(index * 15, (index + 1) * 15,
      { action: `扩展镜头${index + 1}` }));
    const incompleteReview = { shots: expandedShots.slice(0, 13), durationEstimate: expandedEstimate };
    const complete = { shots: expandedShots, durationEstimate: expandedEstimate };
    install([complete, incompleteReview, complete]);
    const result = await requestShotRecommendation(config,
      { ...params, durationSec: 195, allowDurationExpansion: true }, { reviewWithAi: true });
    assert.equal(calls.length, 3, 'one AI review plus at most one structural repair');
    assert.equal(result.durationSec, 210);
    const review = data('storyboard_ai_review_data', 1);
    assert.equal(review.durationSec, 210);
    assert.deepEqual(review.internalHardBoundariesSec, Array.from({ length: 13 }, (_, index) => (index + 1) * 15));
    const repair = data('storyboard_repair_data', 2);
    assert.equal(repair.durationSec, 210, 'repair must not receive the stale 195-second request');
    assert.deepEqual(repair.internalHardBoundariesSec, review.internalHardBoundariesSec);
    assert.match(repair.validationError, /有效总时长=210秒/u);
  });

  await test('non-multiple expansion uses existing bounded numeric repair; source, full response and owner/order stay unchanged', async () => {
    for (const invalidTotal of [35, 30.004]) {
      const invalid = { shots: plannedShots, durationEstimate: { ...correctedEstimate, recommendedSec: invalidTotal } };
      const corrected = { shots: plannedShots, durationEstimate: correctedEstimate };
      install([invalid, invalid, corrected]);
      let repairs = 0;
      const result = await requestShotRecommendation(config, { ...params, durationSec: 15, allowDurationExpansion: true },
        { reviewWithAi: true, onRepair: () => { repairs += 1; } });
      assert.equal(repairs, 1); assert.equal(calls.length, 3);
      const repair = data('storyboard_repair_data', 2);
      assert.match(repair.validationError, /整数倍|两位小数/u);
      assert.equal(repair.sourceStory, story); assert.equal(repair.durationSec, 15);
      assert.equal(repair.allowDurationExpansion, true);
      assert.deepEqual(JSON.parse(repair.previousRepairResponse), invalid);
      assert.ok(system(2).includes(STORYBOARD_SPEECH_FIRST_PLANNING_RULE));
      assert.equal(result.durationSec, 30); assert.equal(result.durationEstimate?.recommendedSec, 30, '35 or30.004 is never locally rounded');
    }
  });

  await test('missing expansion estimate and downstream expansion attempts cannot silently retime a confirmed duration', async () => {
    const fixed = { shots: [shot(0, 15)] };
    for (const optIn of [false, true]) {
      install([{ shots: plannedShots }, { shots: plannedShots }, fixed]);
      const result = await requestShotRecommendation(config, { ...params, durationSec: 15, allowDurationExpansion: optIn }, { reviewWithAi: true });
      assert.equal(calls.length, 3);
      assert.equal(result.shots.at(-1)?.endSec, 15);
      assert.equal(result.durationEstimate, undefined);
      assert.equal(result.durationSec, optIn ? 15 : undefined);
    }
    install([{ shots: [shot(0, 15)], durationEstimate: correctedEstimate }]);
    const ordinary = await requestShotRecommendation(config, { ...params, durationSec: 15, requiredSegmentDurationSec: undefined, allowDurationExpansion: true });
    assert.equal(ordinary.durationEstimate, undefined); assert.equal(ordinary.durationSec, undefined);
    assert.equal(data('storyboard_planning_data').allowDurationExpansion, undefined);
  });

  await test('no new local content gate, fixed speech-rate formula or minimum-shot fallback is introduced', async () => {
    const modelOwned = shot(0, 15, { dialogue: `第11–15s @成年乙：“${lines[2]}”`, action: '模型自行选择的连续长镜头' });
    install([{ shots: [modelOwned] }]);
    const result = await requestShotRecommendation(config, { ...params, durationSec: 15 });
    assert.equal(calls.length, 1, 'local code does not re-review semantics or spend paid calls');
    assert.equal(result.count, 1); assert.equal(result.shots[0].dialogue, modelOwned.dialogue);
    assert.equal(result.shots[0].action, modelOwned.action);
  });

  await test('fixed15-second source review can replace an unconfirmed compressed tail without changing original speakers or user shot count', async () => {
    const tailLines = ['请你听我把这句话说完整。', '我有自己的事要告诉你。', '师兄，我……也有事要对你说。'];
    assert.deepEqual(tailLines.map((line) => line.match(/\p{Script=Han}/gu)?.length), [11, 10, 10],
      'synthetic31-character/3-line compressed-tail regression, never a production speech quota');
    const clipStory = `成年丙停步听取；成年甲说：“${tailLines[0]}”成年乙依次说：“${tailLines[1]}”“${tailLines[2]}”`;
    const compressedTail = [shot(0, 4), shot(4, 8), shot(8, 11.5), shot(11.5, 15, {
      dialogue: `本镜第0.2–1.4秒 @成年甲：“${tailLines[0]}”；本镜第1.5–2.6秒 @成年乙：“${tailLines[1]}”；本镜第2.8–3.4秒 @成年乙（柔和、断续）：“${tailLines[2]}”`,
    })];
    const corrected = [
      shot(0, 2, { action: '成年丙停步听取，成年甲转向成年丙；双方此时不说话' }),
      shot(2, 6, { action: '成年甲面向成年丙说完第一句', dialogue: `本镜第0.2–3.8秒 @成年甲（原声音、在画、听者成年丙）：“${tailLines[0]}”` }),
      shot(6, 10.5, { action: '成年乙面向成年丙说完第二句', dialogue: `本镜第0.2–4秒 @成年乙（原声音、在画、听者成年丙）：“${tailLines[1]}”` }),
      shot(10.5, 15, { action: '成年乙以原情绪和原顺序接续最后一句', dialogue: `本镜第0.2–4.2秒 @成年乙（原声音、在画、听者成年丙）：“${tailLines[2]}”` }),
    ];
    install([{ shots: compressedTail }, { shots: corrected, aiReview: { status: 'revised', summary: '重排未确认时窗，保留原话与发话人。', issues: [] } }]);
    const result = await requestShotRecommendation(config, {
      durationSec: 15, requiredShotCount: 4, workflow: 'drama', pace: '自然', story: clipStory,
    }, { reviewWithAi: true });
    assert.equal(calls.length, 2, 'reuse existing source review; no new speech budget gate or API stage');
    const original = data('storyboard_planning_data');
    const review = data('storyboard_ai_review_data', 1);
    for (const item of [original, review]) {
      assert.equal(item.durationSec, 15);
      assert.equal(item.requiredShotCount, 4);
      assert.equal(item.durationAdjustmentPolicy, 'fixed');
      assert.equal(item.sourcePlanningAuthority.sourceScope, 'single-clip');
      assert.equal(item.sourcePlanningAuthority.candidateStatus, 'unconfirmed-ai-draft');
      assert.equal(item.sourcePlanningAuthority.shotCountAuthority, 'user-fixed');
      assert.equal(item.sourcePlanningAuthority.dialogueTimeBasis, 'shot-relative');
      assert.equal(item.sourceStory, clipStory);
      for (const key of ['speechRate', 'dialogueBudget', 'requiredDialogues', 'dialoguePass']) assert.equal(key in item, false);
    }
    assert.deepEqual(original.sourcePlanningAuthority, review.sourcePlanningAuthority);
    assert.deepEqual(JSON.parse(review.originalStoryboardResponse).shots, compressedTail);
    for (const index of [0, 1]) {
      assert.ok(system(index).includes(STORYBOARD_SOURCE_PLANNING_AUTHORITY_RULE));
      assert.match(system(index), /不能把“保留有效内容”误读成锁死这些草稿数值/u);
      assert.doesNotMatch(system(index), /按剧情和已确定镜长自然安排/u);
    }
    assert.deepEqual(result.shots.map(({ startSec, endSec, dialogue }) => ({ startSec, endSec, dialogue })),
      corrected.map(({ startSec, endSec, dialogue }) => ({ startSec, endSec, dialogue })));
    assert.equal(result.durationEstimate, undefined);
  });

  await test('semantic single-clip scope overrides stale master expansion flags throughout initial, review and numeric repair', async () => {
    const context = { kind: 'semantic-segment-source-v1', contentOverridden: false,
      segment: { index: 3, content: story, entryState: '本段前置动作已结束', exitState: '本段原话说完' },
      semanticSource: { dialogues: [{ id: 'line-current', speaker: '成年乙', text: lines[0] }], events: [] } };
    const accidentalExpansion = { shots: plannedShots, durationEstimate: correctedEstimate };
    const fixedClip = [shot(0, 4), shot(4, 9), shot(9, 15)];
    install([accidentalExpansion, accidentalExpansion, { shots: fixedClip }]);
    const result = await requestShotRecommendation(config, {
      ...params, durationSec: 15, requiredSegmentDurationSec: 5, allowDurationExpansion: true,
      durationAdjustmentPolicy: 'ai-estimated', sequenceSegmentContext: context,
    }, { reviewWithAi: true });
    assert.equal(calls.length, 3, 'out-of-clip numeric boundary uses the same existing repair loop');
    let authority: unknown;
    for (const [index, tag] of ['storyboard_planning_data', 'storyboard_ai_review_data', 'storyboard_repair_data'].entries()) {
      const received = data(tag, index);
      assert.equal(received.durationSec, 15);
      assert.equal(received.initialRequestedDurationSec, 15);
      assert.equal(received.durationAdjustmentPolicy, 'fixed');
      assert.equal(received.allowDurationExpansion, undefined);
      assert.equal(received.requiredSegmentDurationSec, undefined, 'stale5-second full-film grid cannot split this15-second assigned clip');
      assert.equal(received.internalHardBoundariesSec, undefined);
      assert.equal(received.sourcePlanningAuthority.sourceScope, 'assigned-semantic-segment');
      assert.equal(received.sourcePlanningAuthority.shotCountAuthority, 'ai-auto');
      assert.deepEqual(received.sequenceSegmentContext, context, 'current segment facts stay intact; no other segment is injected');
      if (index === 0) authority = received.sourcePlanningAuthority;
      else assert.deepEqual(received.sourcePlanningAuthority, authority);
      assert.match(system(index), /只在本段内部先安排完整发话与互斥动作/u);
      assert.doesNotMatch(system(index), /durationAdjustmentPolicy=ai-estimated 仅授权|固定分段时长为 5 秒/u);
    }
    const diagnostic = data('storyboard_repair_data', 2).masterTimelineDiagnostic;
    assert.ok(diagnostic);
    assert.equal(diagnostic.allWindows.length, 1, 'numeric repair receives the current single-clip contract');
    assert.equal(diagnostic.allWindows[0].durationSec, 15);
    assert.equal(result.shots.at(-1)?.endSec, 15);
    assert.equal(result.durationEstimate, undefined);
  });

  await test('fixed full-film duration preserves its outer windows while AI-auto draft cuts may change in source review', async () => {
    const original = [shot(0, 15), shot(15, 30)];
    const revised = [shot(0, 5), shot(5, 15), shot(15, 21), shot(21, 30)];
    install([{ shots: original }, { shots: revised }]);
    const result = await requestShotRecommendation(config, { ...params, durationAdjustmentPolicy: 'fixed' }, { reviewWithAi: true });
    assert.equal(calls.length, 2);
    for (const [index, tag] of ['storyboard_planning_data', 'storyboard_ai_review_data'].entries()) {
      const received = data(tag, index);
      assert.equal(received.durationSec, 30);
      assert.deepEqual(received.internalHardBoundariesSec, [15]);
      assert.equal(received.sourcePlanningAuthority.sourceScope, 'unconfirmed-full-film');
      assert.equal(received.sourcePlanningAuthority.shotCountAuthority, 'ai-auto');
      assert.match(system(index), /窗口内部尚未确认的AI镜界与发话区间仍可重新安排/u);
      assert.doesNotMatch(system(index), /不得在单段、已确认总稿切片或普通格式转换中擅自增加durationEstimate、镜头边界/u);
    }
    assert.equal(result.count, 4);
    assert.deepEqual(result.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 5], [5, 15], [15, 21], [21, 30]]);
    assert.equal(result.durationEstimate, undefined);
  });
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = originalFetch;
}
console.log(`${groups} speech-first planning transport groups passed; no live model, project data or video generation used`);
