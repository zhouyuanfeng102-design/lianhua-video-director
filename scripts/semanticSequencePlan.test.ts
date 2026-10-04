import assert from 'node:assert/strict';
import {
  assertSemanticSequencePlanningInput, copySemanticSequencePlanningInput, isSemanticSequencePlan,
  materializeSemanticSequencePlan, normalizeSemanticSegmentSource, parseSemanticSequenceResponse,
  normalizeSemanticSequenceRequestedTotalDuration,
  SemanticSequenceTechnicalError, semanticSegmentSourceContext, semanticSequenceSourceFingerprint,
  semanticSegmentStoryContent,
  validateSemanticSequencePlan,
} from '../src/semanticSequencePlan';
import type { SemanticSequencePlanningInput, SemanticSequenceResponse } from '../src/semanticSequencePlan';
import type { VideoSequencePlan } from '../src/types';

const cases: Array<{ name: string; run: () => void }> = [];
const test = (name: string, run: () => void) => cases.push({ name, run });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const source = '林舟推开门，轻声说：“等我回来。”他走过长桥，直到抵达山巅。第二段独有原文尾句。';
const input = (duration = 15): SemanticSequencePlanningInput => ({
  title: '纯合成语义分段故事', story: source, segmentDurationSec: duration, directorSettingsFingerprint: 'synthetic-direction-v1',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '  完整末句保持\n', directorStyle: { name: '观察式', summary: '完整说明' } },
  pacing: { pace: 'natural', directorStyle: '观察式', extraRequirement: '  完整末句保持\n' },
  characterContinuity: [{ id: 'synthetic-lin', name: '林舟', appearance: '短发', outfit: '蓝外套', bodyPlan: '普通人类体态' }],
  sourceSceneIds: ['synthetic-scene'], shotMode: 'auto',
});
const response = (count = 2): SemanticSequenceResponse => ({
  segmentCount: count, reason: '一项长事件的真实推进需要这些完整窗口。', fitStatus: 'balanced',
  segments: Array.from({ length: count }, (_, index) => ({
    title: `AI 段 ${index + 1}`, content: `  AI完整正文${index + 1}，不是原文子串。\n`, summary: '摘要', narrativePurpose: '真实推进',
    entryState: `连续入口${index}`, exitState: `连续出口${index + 1}`, transitionHint: '从已完成状态继续', boundaryReason: '因果进程', continuityPack: '不重演前段动作',
    semanticSource: {
      sourceEvidence: [{ text: '林舟推开门', sourceStart: 0, sourceEnd: 5 }],
      events: [{ id: 'e-long', description: '持续行进', phase: `阶段${index + 1}` }],
      dialogues: [{ id: 'd-long', speaker: '林舟', text: index === 0 ? '等我' : '回来。', language: '中文', continuation: `接续${index + 1}` }],
    },
  })),
});
const wireResponse = (count = 2): Omit<SemanticSequenceResponse, 'segmentCount'> => {
  const { reason, fitStatus, segments } = response(count);
  return { reason, fitStatus, segments };
};
const materialize = (value = response(), request = input()): VideoSequencePlan => materializeSemanticSequencePlan(request, value, { planId: 'semantic-domain-fixture', now: 100 });

test('new wire protocol derives N from complete AI segments without requiring a second count', () => {
  for (const count of [1, 3, 8]) for (const duration of [15, 12.34]) {
    const authored = wireResponse(count);
    const before = JSON.stringify(authored);
    const parsed = parseSemanticSequenceResponse(before, input(duration));
    assert.equal(parsed.segmentCount, count);
    assert.deepEqual(parsed.segments, authored.segments);
    assert.equal(parsed.reason, authored.reason);
    assert.equal(parsed.fitStatus, authored.fitStatus);
    const plan = materialize(parsed, input(duration));
    assert.equal(plan.totalDurationSec, Math.round(duration * 100) * count / 100);
    assert.equal(plan.segments.length, count);
    assert.ok(plan.segments.every((segment) => segment.durationSec === duration));
    assert.deepEqual(plan.segments.map((segment) => segment.content), authored.segments.map((segment) => segment.content));
    assert.equal(JSON.stringify(authored), before, 'deriving metadata must not mutate model-authored content');
  }
});

test('legacy counts remain compatible only when consistent; contradictions report both safe numeric values', () => {
  assert.deepEqual(parseSemanticSequenceResponse(JSON.stringify(response()), input()), response());
  for (const [declared, actual] of [[8, 6], [3, 4]]) {
    const authored = { ...wireResponse(actual), segmentCount: declared };
    const before = JSON.stringify(authored);
    assert.throws(() => parseSemanticSequenceResponse(before, input()), (error: unknown) => {
      assert.ok(error instanceof SemanticSequenceTechnicalError);
      assert.equal(error.kind, 'invalid-shape');
      assert.match(error.message, new RegExp(`AI 声明 ${declared} 段，实际返回 ${actual} 段`));
      assert.match(error.message, /segmentCount 与 segments 数量不一致/u);
      return true;
    });
    assert.equal(JSON.stringify(authored), before, 'no local trimming, padding or count correction');
  }
  const privateMarker = 'SYNTHETIC_PRIVATE_COUNT_VALUE';
  for (const count of [null, true, '2', [], {}, privateMarker, 0, -1, 1.5, 901, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...wireResponse(), segmentCount: count }), input()), (error: unknown) => {
      assert.ok(error instanceof SemanticSequenceTechnicalError);
      assert.match(error.message, /旧格式段数字段 segmentCount 必须为 1–900 的整数/u);
      assert.doesNotMatch(error.message, new RegExp(privateMarker));
      return true;
    });
  }
});

test('count-free responses retain nonempty-array, capacity and complete-body contracts', () => {
  for (const segments of [undefined, null, [], 'not-array']) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...wireResponse(), segments }), input()),
      (error: unknown) => error instanceof SemanticSequenceTechnicalError && /segments 必须是非空数组/u.test(error.message));
  }
  assert.equal(parseSemanticSequenceResponse(JSON.stringify(wireResponse(900)), input(4)).segmentCount, 900);
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(wireResponse(901)), input(1)),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /实际返回 901 段/u.test(error.message));
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(wireResponse(900)), input(4.01)),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /3609 秒.*3600 秒/u.test(error.message));
  const missingBody = wireResponse();
  missingBody.segments[1].content = ' ';
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(missingBody), input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /第 2 段缺少 content 正文/u.test(error.message));
});

test('fixed totals use actual array length with or without a legacy count, never a declared budget alone', () => {
  const request: SemanticSequencePlanningInput = { ...input(), durationMode: 'fixed', requestedTotalDurationSec: 90 };
  const authored = wireResponse(6);
  const plan = materialize(parseSemanticSequenceResponse(JSON.stringify(authored), request), request);
  assert.equal(plan.totalDurationSec, 90);
  assert.equal(plan.requestedTotalDurationSec, 90);
  assert.equal(plan.segments.length, 6);
  for (const count of [5, 7]) for (const candidate of [wireResponse(count), { ...wireResponse(count), segmentCount: 6 }]) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(candidate), request), (error: unknown) => {
      assert.ok(error instanceof SemanticSequenceTechnicalError);
      assert.match(error.message, new RegExp(`固定总时长需要 6 段（90 秒 ÷ 每段 15 秒），实际返回 ${count} 段`));
      return true;
    });
  }
});

test('count-free wrapped responses preserve prose and later truncated responses never publish an earlier plan', () => {
  const authored = wireResponse(3);
  const json = JSON.stringify(authored);
  const expected = { ...authored, segmentCount: 3 };
  for (const raw of [json, `说明\n\`\`\`json\n${json}\n\`\`\``, JSON.stringify({ data: authored }),
    JSON.stringify({ result: json }), JSON.stringify(json), `${json}\n{"note":"完成"}`]) {
    assert.deepEqual(parseSemanticSequenceResponse(raw, input()), expected);
  }
  for (const raw of [json.slice(0, -1), `${JSON.stringify(wireResponse(1))}\n${json.slice(0, -1)}`,
    JSON.stringify({ result: authored }).slice(0, -1)]) {
    assert.throws(() => parseSemanticSequenceResponse(raw, input()),
      (error: unknown) => error instanceof SemanticSequenceTechnicalError && error.kind === 'incomplete-json');
  }
});

test('explicit user edits are marked downstream without rewriting the original evidence', () => {
  const plan = materialize();
  const segment = plan.segments[0];
  const original = clone(segment.semanticSource);
  segment.content = '用户修改后的本段：林舟保持沉默，收回铜铃。';
  segment.contentOverridden = true;
  const context = semanticSegmentSourceContext(plan, segment);
  assert.equal(context.contentOverridden, true);
  assert.equal(context.segment.content, segment.content);
  assert.deepEqual(context.segment.semanticSource, original);
});

test('AI authors every body and semantic boundary; local code creates only IDs and D windows', () => {
  const authored = response(3);
  const plan = materialize(authored, input(12.34));
  assert.equal(plan.planningMode, 'semantic-segments');
  assert.equal(plan.planningStage, 'segmented');
  assert.equal(plan.segmentationSource, 'ai');
  assert.equal(plan.totalDurationSec, 37.02);
  assert.equal(plan.masterStoryboardId, undefined);
  assert.equal(plan.masterPromptConfirmedFingerprint, undefined);
  assert.deepEqual(plan.segments.map((segment) => [segment.globalStartSec, segment.globalEndSec, segment.durationSec]), [[0, 12.34, 12.34], [12.34, 24.68, 12.34], [24.68, 37.02, 12.34]]);
  plan.segments.forEach((segment, index) => {
    assert.equal(segment.content, authored.segments[index].content);
    assert.deepEqual(segment.semanticSource, authored.segments[index].semanticSource);
    assert.equal(segment.sourceShotIds, undefined);
    assert.equal(segment.storyboardId, undefined);
    assert.deepEqual(segment.sourceBeatIds, []);
  });
  assert.equal(plan.sourceStoryContent, source);
  assert.deepEqual(validateSemanticSequencePlan(plan), []);
  assert.equal(isSemanticSequencePlan(plan), true);
});

test('fitStatus accepts only unambiguous case and edge-whitespace variants without changing AI prose', () => {
  for (const status of ['comfortable', 'balanced', 'compressed', 'insufficient'] as const) {
    const authored = { ...response(), fitStatus: status };
    for (const variant of [status, status.toUpperCase(), ` \t${status[0].toUpperCase()}${status.slice(1)}\r\n`, `\u3000${status}\u3000`]) {
      const candidate = { ...authored, fitStatus: variant };
      const before = JSON.stringify(candidate);
      const parsed = parseSemanticSequenceResponse(before, input());
      assert.deepEqual(parsed, authored, 'only the protocol spelling can change, never AI prose, dialogue or evidence');
      assert.equal(materialize(parsed).fitStatus, status);
      assert.equal(JSON.stringify(candidate), before);
    }
  }
});

test('missing, mistyped and unknown fitStatus give actionable diagnostics without inventing an assessment', () => {
  const cases: Array<[unknown, string]> = [
    [undefined, '缺失'], [null, '不能为空'], [[], '必须是字符串（收到数组）'],
    [{ status: 'balanced' }, '必须是字符串（收到对象）'], [1, '必须是字符串（收到数字）'],
    [true, '必须是字符串（收到布尔值）'], ['', '不能是空字符串'], [' \t\n', '不能是空字符串'],
    ...['wrong', 'ok', 'sufficient', '适合', '不足', 'balanced / compressed', 'not insufficient', 'balanced（适中）',
      'SYNTHETIC_PRIVATE_FIT_STATUS_VALUE'].map((value): [unknown, string] => [value, '不是支持的状态值']),
  ];
  for (const [value, detail] of cases) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...response(), fitStatus: value }), input()), (error: unknown) => {
      assert.ok(error instanceof SemanticSequenceTechnicalError);
      assert.equal(error.kind, 'invalid-shape');
      assert.equal(error.issues.length, 1);
      assert.ok(error.message.includes(`$.fitStatus ${detail}`));
      assert.match(error.message, /comfortable（宽裕）、balanced（适中）、compressed（紧凑）、insufficient（不足）/u);
      assert.match(error.message, /必须仅返回一个英文状态，解释写入 reason/u);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_FIT_STATUS_VALUE/u);
      return true;
    });
  }
});

test('one long source/event or utterance ID may continue across segments without a local content gate', () => {
  const sparse = response(4);
  sparse.segments.forEach((segment) => {
    segment.content = '……';
    segment.summary = ''; segment.narrativePurpose = '';
    segment.semanticSource.events[0].description = '站立、凝视、未结束的动作';
  });
  assert.deepEqual(validateSemanticSequencePlan(materialize(sparse)), []);
  const emptyOwnership = response(1);
  emptyOwnership.segments[0].semanticSource = { sourceEvidence: [], events: [], dialogues: [] };
  assert.deepEqual(validateSemanticSequencePlan(materialize(emptyOwnership)), []);
});

test('source evidence and AI prose stay separate; all stored values are detached', () => {
  const request = input();
  const authored = response();
  const requestBefore = JSON.stringify(request);
  const authoredBefore = JSON.stringify(authored);
  const plan = materialize(authored, request);
  assert.equal(JSON.stringify(request), requestBefore);
  assert.equal(JSON.stringify(authored), authoredBefore);
  assert.notStrictEqual(plan.semanticPlanningSnapshot!.creativeDirection, request.creativeDirection);
  assert.notStrictEqual(plan.segments[0].semanticSource, authored.segments[0].semanticSource);
  plan.segments[0].semanticSource!.events[0].phase = 'mutated request output';
  plan.semanticPlanningSnapshot!.creativeDirection.cameraTerms.push('mutated request output');
  plan.semanticPlanningSnapshot!.characterContinuity[0].name = 'mutated request output';
  assert.equal(JSON.stringify(request), requestBefore);
  assert.equal(JSON.stringify(authored), authoredBefore);
});

test('input copying keeps complete ordinary facts but never copies image assets/private dossiers', () => {
  const request = input();
  request.characterContinuity = [{ ...request.characterContinuity![0], assetIds: ['private-image'], nsfwProfile: { fullBody: 'private dossier' } } as NonNullable<SemanticSequencePlanningInput['characterContinuity']>[number]];
  const copied = copySemanticSequencePlanningInput(request);
  assert.equal(JSON.stringify(copied).includes('private-image'), false);
  assert.equal(JSON.stringify(copied).includes('private dossier'), false);
  assert.equal(copied.creativeDirection.extraRequirement, request.creativeDirection.extraRequirement);
  assert.notStrictEqual(copied.pacing, request.pacing);
});

test('N can independently grow or shrink; only numerical capacity limits constrain it', () => {
  assert.equal(materialize(response(1)).totalDurationSec, 15);
  assert.equal(materialize(response(8)).totalDurationSec, 120);
  assert.equal(materialize(response(12), input(300)).totalDurationSec, 3600);
  assert.equal(materialize(response(900), input(4)).segments.length, 900);
  assert.throws(() => materialize(response(900), input(4.01)), SemanticSequenceTechnicalError);
  for (const duration of [0, 0.99, 300.01, 1.111, Infinity, NaN]) assert.throws(() => assertSemanticSequencePlanningInput(input(duration)), SemanticSequenceTechnicalError);
  for (const count of [0, -1, 1.5, 901]) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...response(), segmentCount: count }), input()), SemanticSequenceTechnicalError);
  }
});

test('UI total selection rounds upward to full centisecond windows within both delivery limits', () => {
  for (const [total, duration, expected] of [
    [31, 15, 45], [30, 15, 30], [15.001, 15, 30], [0, 15, 15], [-20, 15, 15],
    [NaN, 12.34, 12.34], [12.34 * 3, 12.34, 37.02], [37.03, 12.34, 49.36],
    [3600, 12.34, 3590.94], [3600, 1, 900], [3600, 4, 3600],
    [Infinity, 12.34, 3590.94], [-Infinity, 15, 15], [3601, 300, 3600],
  ]) assert.equal(normalizeSemanticSequenceRequestedTotalDuration(total, duration), expected);
  for (const duration of [0, 300.01, 1.111, NaN]) {
    assert.throws(() => normalizeSemanticSequenceRequestedTotalDuration(30, duration), SemanticSequenceTechnicalError);
  }
});

test('fixed request totals are strict numbers and full D multiples; input copying never rounds them', () => {
  const request: SemanticSequencePlanningInput = { ...input(12.34), durationMode: 'fixed', requestedTotalDurationSec: 37.02 };
  const before = JSON.stringify(request);
  assertSemanticSequencePlanningInput(request);
  assert.equal(copySemanticSequencePlanningInput(request).requestedTotalDurationSec, 37.02);
  assert.equal(JSON.stringify(request), before);
  for (const total of [undefined, 0, 0.99, -15, NaN, Infinity, 3600.01, 31, 30.001]) {
    assert.throws(() => assertSemanticSequencePlanningInput({ ...input(), durationMode: 'fixed', requestedTotalDurationSec: total }), SemanticSequenceTechnicalError);
  }
  assert.throws(() => assertSemanticSequencePlanningInput({ ...input(1), durationMode: 'fixed', requestedTotalDurationSec: 901 }), SemanticSequenceTechnicalError);
  assertSemanticSequencePlanningInput({ ...input(1), durationMode: 'fixed', requestedTotalDurationSec: 900 });
  assertSemanticSequencePlanningInput({ ...input(4), durationMode: 'fixed', requestedTotalDurationSec: 3600 });
  assert.throws(() => assertSemanticSequencePlanningInput({ ...input(), durationMode: 'unknown' as 'fixed' }), SemanticSequenceTechnicalError);
});

test('fixed mode requires exactly T divided by D AI bodies and preserves every authored field', () => {
  const request: SemanticSequencePlanningInput = { ...input(12.34), durationMode: 'fixed', requestedTotalDurationSec: 37.02 };
  const authored = response(3);
  const before = JSON.stringify({ request, authored });
  const plan = materialize(authored, request);
  assert.equal(plan.durationMode, 'fixed');
  assert.equal(plan.requestedTotalDurationSec, 37.02);
  assert.equal(plan.totalDurationSec, 37.02);
  assert.equal(plan.semanticPlanningSnapshot!.durationMode, 'fixed');
  assert.equal(plan.semanticPlanningSnapshot!.requestedTotalDurationSec, 37.02);
  assert.deepEqual(plan.segments.map(({ content, semanticSource }) => ({ content, semanticSource })), authored.segments.map(({ content, semanticSource }) => ({ content, semanticSource })));
  assert.equal(JSON.stringify({ request, authored }), before);
  assert.deepEqual(validateSemanticSequencePlan(plan), []);
  for (const count of [1, 2, 4]) {
    assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(response(count)), request),
      (error: unknown) => error instanceof SemanticSequenceTechnicalError && error.kind === 'invalid-shape' && /固定总时长需要 3 段.*实际返回/u.test(error.message));
    assert.throws(() => materialize(response(count), request), SemanticSequenceTechnicalError);
  }
});

test('AI mode discards every previous fixed total and lets the model independently choose N', () => {
  for (const durationMode of [undefined, 'ai-estimated'] as const) for (const total of [15, 30, -1, NaN, Infinity]) {
    const request = { ...input(), durationMode, requestedTotalDurationSec: total };
    assertSemanticSequencePlanningInput(request);
    const copied = copySemanticSequencePlanningInput(request);
    assert.equal(Object.hasOwn(copied, 'requestedTotalDurationSec'), false);
    assert.equal(copied.durationMode, durationMode);
    const plan = materialize(response(8), request);
    assert.equal(plan.durationMode, 'ai-estimated');
    assert.equal(plan.totalDurationSec, 120);
    assert.equal(Object.hasOwn(plan, 'requestedTotalDurationSec'), false);
    assert.equal(Object.hasOwn(plan.semanticPlanningSnapshot!, 'requestedTotalDurationSec'), false);
    assert.deepEqual(validateSemanticSequencePlan(plan), []);
  }
});

test('saved modes and budgets must agree with their snapshot and exact segment count', () => {
  const original = materialize(response(), { ...input(), durationMode: 'fixed', requestedTotalDurationSec: 30 });
  for (const mutate of [
    (plan: VideoSequencePlan) => { plan.durationMode = 'ai-estimated'; },
    (plan: VideoSequencePlan) => { plan.requestedTotalDurationSec = 45; },
    (plan: VideoSequencePlan) => { delete plan.requestedTotalDurationSec; },
    (plan: VideoSequencePlan) => { plan.semanticPlanningSnapshot!.durationMode = 'ai-estimated'; },
    (plan: VideoSequencePlan) => { delete plan.semanticPlanningSnapshot!.durationMode; },
    (plan: VideoSequencePlan) => { plan.semanticPlanningSnapshot!.requestedTotalDurationSec = 45; },
    (plan: VideoSequencePlan) => { delete plan.semanticPlanningSnapshot!.requestedTotalDurationSec; },
  ]) { const changed = clone(original); mutate(changed); assert.ok(validateSemanticSequencePlan(changed).length); }
  const ai = materialize();
  ai.requestedTotalDurationSec = 30;
  assert.ok(validateSemanticSequencePlan(ai).length);
  delete ai.requestedTotalDurationSec;
  ai.semanticPlanningSnapshot!.requestedTotalDurationSec = 30;
  assert.ok(validateSemanticSequencePlan(ai).length);
});

test('new request modes and budgets own source identity while old AI snapshots stay unchanged', () => {
  const oldAi = materialize();
  const before = JSON.stringify(oldAi);
  const oldIdentity = semanticSequenceSourceFingerprint(oldAi);
  assert.equal(Object.hasOwn(oldAi.semanticPlanningSnapshot!, 'durationMode'), false);
  assert.deepEqual(validateSemanticSequencePlan(oldAi), []);
  assert.equal(JSON.stringify(oldAi), before);
  const explicitAi = materialize(response(), { ...input(), durationMode: 'ai-estimated', requestedTotalDurationSec: 999 });
  assert.notEqual(semanticSequenceSourceFingerprint(explicitAi), oldIdentity);
  delete explicitAi.semanticPlanningSnapshot!.durationMode;
  assert.equal(semanticSequenceSourceFingerprint(explicitAi), oldIdentity);
  const fixed = materialize(response(), { ...input(), durationMode: 'fixed', requestedTotalDurationSec: 30 });
  const fixedIdentity = semanticSequenceSourceFingerprint(fixed);
  assert.notEqual(fixedIdentity, oldIdentity);
  const modeChanged = clone(fixed);
  modeChanged.durationMode = 'ai-estimated';
  delete modeChanged.requestedTotalDurationSec;
  modeChanged.semanticPlanningSnapshot!.durationMode = 'ai-estimated';
  delete modeChanged.semanticPlanningSnapshot!.requestedTotalDurationSec;
  assert.deepEqual(validateSemanticSequencePlan(modeChanged), []);
  assert.notEqual(semanticSequenceSourceFingerprint(modeChanged), fixedIdentity);
  const budgetChanged = clone(fixed); budgetChanged.requestedTotalDurationSec = 45;
  assert.notEqual(semanticSequenceSourceFingerprint(budgetChanged), fixedIdentity);
});

test('fenced/prefixed JSON and escaped braces parse; malformed roots and trailing partial output fail', () => {
  const authored = response();
  authored.segments[0].content = '道具内容：{"x":"}\\\""} 保留';
  const json = JSON.stringify(authored);
  assert.deepEqual(parseSemanticSequenceResponse(`说明\n\`\`\`json\n${json}\n\`\`\``, input()), authored);
  assert.deepEqual(parseSemanticSequenceResponse(`{"draft":true}\n${json}`, input()), authored);
  assert.throws(() => parseSemanticSequenceResponse(`${json}\n{"incomplete":`, input()), SemanticSequenceTechnicalError);
  for (const raw of ['[]', 'null', '{bad}', '{"segmentCount":2}', JSON.stringify({ ...authored, segments: 'not-array' })]) {
    assert.throws(() => parseSemanticSequenceResponse(raw, input()), SemanticSequenceTechnicalError);
  }
});

test('prose braces and trailing metadata never hide or replace a complete plan', () => {
  const authored = response();
  authored.segments[0].content = '  保留 {道具}、"引号"、\\路径及换行\n末句  ';
  const json = JSON.stringify(authored);
  for (const raw of [
    `示例形状 {segmentCount, segments\n${json}`,
    `${json}\n备注：请替换 {title`,
    `说明 {占位符\n\`\`\`json\n${json}\n\`\`\`\n备注 {末句`,
    `示例：{"segmentCount":1,"segments":...\n\`\`\`json\n${json}\n\`\`\``,
    `${json}\n附加说明：{"note":"完成"}`,
    `${json}\n附加说明：{"note":"segments"}`,
    `${json}\n附加说明：{"title"}`,
  ]) assert.deepEqual(parseSemanticSequenceResponse(raw, input()), authored);
});

test('bounded JSON-string decoding and explicit data/result wrappers preserve the whole authored plan', () => {
  const authored = response();
  const json = JSON.stringify(authored);
  for (const raw of [
    JSON.stringify(json), JSON.stringify(JSON.stringify(json)),
    `说明\n${JSON.stringify(json)}\n完成。`,
    JSON.stringify({ data: authored }), JSON.stringify({ result: authored }),
    JSON.stringify({ data: { result: authored } }), JSON.stringify({ result: json }),
    JSON.stringify({ data: authored, result: 'ok' }), JSON.stringify({ result: json, data: { status: 'ok' } }),
    `说明\n${JSON.stringify({ data: authored })}\n{"note":"完成"}`,
  ]) assert.deepEqual(parseSemanticSequenceResponse(raw, input()), authored);
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(JSON.stringify(JSON.stringify(json))), input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && error.kind === 'invalid-json');
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ data: authored, result: response(1) }), input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /多个 data\/result/u.test(error.message));
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ unrelated: authored }), input()), SemanticSequenceTechnicalError);
});

test('the last explicit plan is selected whole and a later broken plan never falls back to an example', () => {
  const first = response(1);
  const last = response(3);
  last.reason = '最后的完整计划';
  const prefix = `${JSON.stringify(first)}\n`;
  assert.deepEqual(parseSemanticSequenceResponse(`${prefix}${JSON.stringify(last)}\n{"note":"完成"}`, input()), last);
  assert.throws(() => parseSemanticSequenceResponse(`${prefix}{"segmentCount":3,"segments":oops}`, input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && error.kind === 'invalid-json');
  assert.throws(() => parseSemanticSequenceResponse(`${prefix}{"data":{"segmentCount":3,"segments":oops}}`, input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && error.kind === 'invalid-json');
  assert.throws(() => parseSemanticSequenceResponse(`${prefix}${JSON.stringify({ ...last, fitStatus: 'wrong' })}`, input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /fitStatus/u.test(error.message));
  assert.throws(() => parseSemanticSequenceResponse(`${prefix}${JSON.stringify({ data: first, result: last })}`, input()),
    (error: unknown) => error instanceof SemanticSequenceTechnicalError && /多个 data\/result/u.test(error.message));
});

test('JSON failures distinguish missing, malformed and unfinished output without revealing response content', () => {
  const json = JSON.stringify(response());
  const marker = 'SYNTHETIC_PRIVATE_RESPONSE_MARKER';
  const failures: Array<[string, 'missing-json' | 'invalid-json' | 'incomplete-json']> = [
    [`说明 ${marker} {占位符`, 'missing-json'],
    [`{"segmentCount":2,,"reason":"${marker}"}`, 'invalid-json'],
    [`{"segmentCount":2,"reason":"${marker}`, 'incomplete-json'],
    [json.slice(0, -1), 'incomplete-json'],
    [`${json}\n{"incomplete":`, 'incomplete-json'],
    [`${json}\n${JSON.stringify(response(1)).slice(0, -1)}`, 'incomplete-json'],
    [JSON.stringify({ data: response() }).slice(0, -1), 'incomplete-json'],
    [JSON.stringify(json.slice(0, -1)), 'incomplete-json'],
    [`${json}\n${JSON.stringify(json.slice(0, -1))}`, 'incomplete-json'],
    [`\`\`\`json\n${json.slice(0, -1)}\n\`\`\``, 'incomplete-json'],
  ];
  for (const [raw, kind] of failures) {
    assert.throws(() => parseSemanticSequenceResponse(raw, input()), (error: unknown) => {
      assert.ok(error instanceof SemanticSequenceTechnicalError);
      assert.equal(error.kind, kind);
      assert.equal(error.diagnostics?.responseLength, raw.length);
      assert.equal(error.message.includes(marker), false);
      assert.equal(JSON.stringify(error.issues).includes(marker), false);
      assert.ok(Object.values(error.diagnostics ?? {}).every((value) => typeof value === 'number'));
      return true;
    });
  }
  const defaultError = new SemanticSequenceTechnicalError(['合成字段错误']);
  assert.equal(defaultError.kind, 'invalid-shape');
  assert.equal(defaultError.message, 'AI 语义分段结构无效：合成字段错误');
});

test('wrong optional numeric fields are repaired by the model, not locally retimed', () => {
  const request = input(15);
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...response(), totalDurationSec: 29 }), request), SemanticSequenceTechnicalError);
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify({ ...response(), segmentDurationSec: 10 }), request), SemanticSequenceTechnicalError);
  const wrongWindow = { ...response(), segments: response().segments.map((segment, index) => ({ ...segment, durationSec: index === 0 ? 10 : 15 })) };
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(wrongWindow), request), SemanticSequenceTechnicalError);
  const wrongEvidence = response();
  wrongEvidence.segments[0].semanticSource.sourceEvidence[0].sourceEnd = source.length + 1;
  assert.throws(() => parseSemanticSequenceResponse(JSON.stringify(wrongEvidence), request), SemanticSequenceTechnicalError);
});

test('persisted-plan validation verifies raw source hash, total, IDs and integer indices only', () => {
  const original = materialize();
  for (const mutate of [
    (plan: VideoSequencePlan) => { plan.sourceStoryContent += ' changed'; },
    (plan: VideoSequencePlan) => { plan.sourceContentHash = 'wrong'; },
    (plan: VideoSequencePlan) => { plan.totalDurationSec -= 0.01; },
    (plan: VideoSequencePlan) => { plan.segments[1].id = plan.segments[0].id; },
    (plan: VideoSequencePlan) => { plan.segments[0].index = 1.5; },
    (plan: VideoSequencePlan) => { plan.segments[1].globalStartSec = 14; },
  ]) { const changed = clone(original); mutate(changed); assert.ok(validateSemanticSequencePlan(changed).length); }
  const legacy = { ...original, planningMode: undefined, semanticPlanningSnapshot: undefined, masterStoryboardId: 'historical-master' };
  const before = JSON.stringify(legacy);
  assert.equal(isSemanticSequencePlan(legacy), false);
  assert.deepEqual(validateSemanticSequencePlan(legacy), []);
  assert.equal(JSON.stringify(legacy), before);
});

test('source fingerprint changes with semantics/direction but not asynchronous generation bookkeeping', () => {
  const original = materialize();
  const identity = semanticSequenceSourceFingerprint(original);
  const job = clone(original);
  job.updatedAt = 500; job.segments[0].status = 'ready'; job.segments[0].storyboardId = 'generated-board'; job.segments[0].failureReason = 'old failure';
  assert.equal(semanticSequenceSourceFingerprint(job), identity);
  for (const mutate of [
    (plan: VideoSequencePlan) => { plan.segments[0].content += ' new body'; },
    (plan: VideoSequencePlan) => { plan.segments[0].semanticSource!.dialogues[0].text += ' new line'; },
    (plan: VideoSequencePlan) => { plan.semanticPlanningSnapshot!.creativeDirection.extraRequirement += ' new requirement'; },
    (plan: VideoSequencePlan) => { plan.semanticPlanningSnapshot!.characterContinuity[0].outfit = 'new outfit'; },
  ]) { const changed = clone(original); mutate(changed); assert.notEqual(semanticSequenceSourceFingerprint(changed), identity); }
});

test('single-segment context never imports the full original or another segment dialogue', () => {
  const authored = response();
  authored.segments[1].content = 'OTHER_SEGMENT_BODY';
  authored.segments[1].semanticSource.dialogues[0].text = 'OTHER_SEGMENT_DIALOGUE';
  const plan = materialize(authored);
  const context = semanticSegmentSourceContext(plan, plan.segments[0]);
  assert.equal(context.segment.content, plan.segments[0].content);
  assert.equal(context.generationStoryContent, semanticSegmentStoryContent(plan.segments[0]));
  assert.deepEqual(context.segment.semanticSource, plan.segments[0].semanticSource);
  assert.equal(context.segmentCount, 2);
  const serialized = JSON.stringify(context);
  for (const foreign of ['第二段独有原文尾句', 'OTHER_SEGMENT_BODY', 'OTHER_SEGMENT_DIALOGUE']) assert.equal(serialized.includes(foreign), false);
  context.segment.semanticSource.dialogues[0].text = 'isolated change';
  context.creativeDirection.cameraTerms.push('isolated change');
  assert.equal(plan.segments[0].semanticSource!.dialogues[0].text, '等我');
  assert.deepEqual(plan.semanticPlanningSnapshot!.creativeDirection.cameraTerms, []);
});

test('complete segment generation source includes assigned speech missing from the prose without changing saved data', () => {
  const segment = {
    content: '  林舟把铜铃放在桌上，苏禾抬头。\n',
    semanticSource: {
      sourceEvidence: [{ text: '林舟把铜铃放在桌上。' }],
      events: [{ id: 'put-bell', description: '放下铜铃' }],
      dialogues: [
        { id: 'line-1', speaker: '林舟', text: '请把铜铃收好。', language: '中文' },
        { id: 'line-2', speaker: '苏禾', text: '我会收好，\n等你回来。', continuation: '接续本段前半句' },
      ],
    },
  };
  const before = JSON.stringify(segment);
  const generated = semanticSegmentStoryContent(segment);
  assert.ok(generated.startsWith(segment.content), 'saved prose stays an exact prefix so existing source positions remain valid');
  assert.ok(generated.includes(JSON.stringify(segment.semanticSource.dialogues, null, 2)), 'all original speech fields are preserved');
  assert.match(generated, /正文未写出的已分配对白仍属于本段/u);
  assert.equal(JSON.stringify(segment), before, 'generation never mutates saved source or ownership');
});

test('generation source does not infer or deduplicate speech from prose wording', () => {
  const dialogues = [
    { id: 'first-call', speaker: '林舟', text: '请等一下。' },
    { id: 'second-call', speaker: '林舟', text: '请等一下。' },
  ];
  const content = '林舟说：“请等一下。”走到门口时，他又说：“请等一下。”';
  const generated = semanticSegmentStoryContent({ content, semanticSource: { sourceEvidence: [], events: [], dialogues } });
  assert.ok(generated.includes(content));
  assert.ok(generated.includes(JSON.stringify(dialogues, null, 2)), 'identical real utterances retain distinct records');
  assert.match(generated, /同一次发话只执行一次/u);
  assert.match(generated, /原文真实重复发话及continuation接续按各自记录保留/u);
});

test('user-edited segments and segments without assigned speech retain the exact body', () => {
  const dialogues = [{ id: 'old-line', speaker: '林舟', text: '旧的原话。' }];
  for (const content of ['', '  用户改成静默等候。\r\n']) {
    assert.equal(semanticSegmentStoryContent({ content, contentOverridden: true,
      semanticSource: { sourceEvidence: [], events: [], dialogues } }), content);
    assert.equal(semanticSegmentStoryContent({ content }), content);
    assert.equal(semanticSegmentStoryContent({ content, semanticSource: { sourceEvidence: [], events: [], dialogues: [] } }), content);
  }
  const plan = materialize();
  const segment = { ...plan.segments[0], content: '用户保留的当前正文。', contentOverridden: true };
  const context = semanticSegmentSourceContext(plan, segment);
  assert.equal(context.segment.content, segment.content);
  assert.equal(context.generationStoryContent, segment.content);
  assert.deepEqual(context.segment.semanticSource, segment.semanticSource, 'historical ownership stays as evidence only');
});

test('normalizer copies complete semantic data without inventing missing semantic arrays', () => {
  const original = response().segments[0].semanticSource;
  const normalized = normalizeSemanticSegmentSource(original)!;
  assert.deepEqual(normalized, original);
  assert.notStrictEqual(normalized.events[0], original.events[0]);
  assert.equal(normalizeSemanticSegmentSource({ sourceEvidence: [] }), undefined);
  assert.equal(normalizeSemanticSegmentSource({ ...original, dialogues: [{ id: 'x', text: 'no speaker field' }] }), undefined);
});

for (const entry of cases) { entry.run(); console.log(`PASS ${entry.name}`); }
console.log(`semanticSequencePlan: ${cases.length}/${cases.length} passed`);
