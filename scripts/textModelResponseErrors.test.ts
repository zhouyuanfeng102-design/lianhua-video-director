import assert from 'node:assert/strict';
import {
  requestAiStorySegmentation,
  requestDirectorDecision,
  requestShotRecommendation,
  requestStoryDurationEstimate,
  requestStoryPreparation,
  requestTextModel,
  TextModelHttpError,
  TextModelResponseError,
} from '../src/services/llm';
import type { AiStorySegmentationInput, TextModelResponseErrorCode } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';
import { formatSafeErrorDiagnostics, getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import { formatUserFacingError } from '../src/userFacingError';

// Neutral fictional fixtures and in-memory HTTP only. No project files or live API.
type HttpResult = { status: number; body: string };
const config: TextApiConfig = {
  enabled: true,
  provider: 'openai_compatible',
  baseUrl: 'https://text.example.test/v1/chat/completions',
  apiKey: 'NEUTRAL_MOCK_KEY',
  model: 'mock-text-model',
  temperature: 0.2,
  maxTokens: 32768,
  vision: true,
};
const story = '守灯人推开木门，点亮窗边的灯。';
const systemMarker = 'NEUTRAL_SYSTEM_MARKER';
const inputMarker = 'NEUTRAL_INPUT_MARKER';
const responseMarker = 'NEUTRAL_RESPONSE_MARKER';
const reasoningMarker = 'NEUTRAL_REASONING_MARKER';
const imageData = 'iVBORw0KGgo=';
const imageUrl = `data:image/png;base64,${imageData}`;
const sensitiveMarkers = [config.apiKey, systemMarker, inputMarker, responseMarker, reasoningMarker, imageData, imageUrl];
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>): void => { tests.push({ name, run }); };
const response = (payload: unknown): HttpResult => ({ status: 200, body: JSON.stringify(payload) });
const textResponse = (content: string): HttpResult => response({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const installFake = (request: (call: number) => HttpResult): (() => number) => {
  let calls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { lianhuaDesktop: { request: async () => request(++calls) } },
  });
  return () => calls;
};
const assertNoResponseEcho = (error: Error): void => {
  for (const marker of sensitiveMarkers) {
    assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(marker), false, `diagnostic must not echo ${marker}`);
  }
};
const assertVisibleReason = (error: Error, expected: RegExp): void => {
  const options = { knownSecrets: [config.apiKey], sensitiveTexts: sensitiveMarkers };
  const safeError = getSafeErrorDiagnostics(error, options);
  // TaskErrorDetails uses this exact safe-error -> formatter summary path.
  // String/message paths also cover stored task errors and notifications.
  for (const input of [error, error.message, String(error), safeError]) {
    const shown = formatUserFacingError(input);
    assert.match(shown, expected);
    assert.doesNotMatch(shown, /服务返回了未识别的错误|操作失败，暂时无法识别具体原因/u);
    assert.equal(formatUserFacingError(shown), shown, 'redisplay must retain the same reason');
    for (const marker of sensitiveMarkers) assert.equal(shown.includes(marker), false);
  }
  const details = formatSafeErrorDiagnostics(error, options);
  assert.match(details, expected);
  for (const marker of sensitiveMarkers) assert.equal(details.includes(marker), false);
  if (error instanceof TextModelResponseError) {
    assert.equal(safeError.code, error.code);
    assert.ok(formatUserFacingError(safeError).includes(error.code), 'summary retains the code inline or as an error-code label');
    assert.ok(details.includes(`错误码：${error.code}`));
  }
};
const protocolReasons: Record<TextModelResponseErrorCode, RegExp> = {
  refusal: /明确拒绝.*不会自动进行 JSON 格式重试/u,
  content_filter: /内容过滤.*不会自动进行 JSON 格式重试/u,
  length: /最大输出额度.*不会自动进行 JSON 格式重试/u,
  reasoning_only: /思考内容.*没有返回正文/u,
  empty_content: /缺少正文/u,
  invalid_response: /不是有效的 JSON 协议对象/u,
};
const protocolError = (code: TextModelResponseErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof TextModelResponseError);
  assert.equal(error.name, 'TextModelResponseError');
  assert.equal(error.code, code);
  assert.equal(error.retryable, false);
  assertNoResponseEcho(error);
  assertVisibleReason(error, protocolReasons[code]);
  return true;
};
const requestRaw = (activeConfig = config) => requestTextModel(activeConfig, systemMarker, inputMarker, undefined, { referenceImages: [imageUrl] });
const protocolResponses: Array<{ code: 'refusal' | 'content_filter' | 'length'; payload: unknown }> = [
  { code: 'refusal', payload: { choices: [{ message: { content: null, refusal: responseMarker }, finish_reason: 'stop' }] } },
  { code: 'content_filter', payload: { choices: [{ message: { content: responseMarker }, finish_reason: 'content_filter' }] } },
  { code: 'length', payload: { choices: [{ message: { content: '{"mode":"narrative","reason":"complete-looking"}' }, finish_reason: 'length' }] } },
];

test('explicit refusal, filtering and output limits are typed terminal errors even with body text', async () => {
  for (const fixture of protocolResponses) {
    const calls = installFake(() => response(fixture.payload));
    await assert.rejects(() => requestRaw(), protocolError(fixture.code));
    assert.equal(calls(), 1);
  }
  installFake(() => response({ choices: [{ message: { refusal: responseMarker, content: '{"mode":"narrative"}' } }] }));
  await assert.rejects(() => requestRaw(), protocolError('refusal'));
});

test('refusal content blocks stop both OpenAI-compatible and Claude responses', async () => {
  for (const content of [
    [{ type: 'refusal', refusal: responseMarker }],
    [{ type: 'text', text: responseMarker }, { type: 'refusal', refusal: responseMarker }],
  ]) {
    installFake(() => response({ choices: [{ message: { content } }] }));
    await assert.rejects(() => requestRaw(), protocolError('refusal'));
    installFake(() => response({ content, stop_reason: 'end_turn' }));
    await assert.rejects(() => requestRaw({ ...config, provider: 'claude' }), protocolError('refusal'));
  }
});

test('Claude refusal and max_tokens stop reasons never return partial text', async () => {
  for (const [stopReason, code] of [['refusal', 'refusal'], ['max_tokens', 'length']] as const) {
    const calls = installFake(() => response({ content: [{ type: 'text', text: responseMarker }], stop_reason: stopReason }));
    await assert.rejects(() => requestRaw({ ...config, provider: 'claude' }), protocolError(code));
    assert.equal(calls(), 1);
  }
});

test('reasoning-only, missing body and malformed API envelopes have distinct diagnostics', async () => {
  for (const message of [{ reasoning_content: reasoningMarker }, { reasoning: reasoningMarker, content: [] }]) {
    installFake(() => response({ choices: [{ message, finish_reason: 'stop' }] }));
    await assert.rejects(() => requestRaw(), protocolError('reasoning_only'));
    installFake(() => response({ choices: [{ message, finish_reason: 'length' }] }));
    await assert.rejects(() => requestRaw(), protocolError('length'));
  }
  for (const content of [[{ type: 'thinking', thinking: reasoningMarker }], [{ type: 'redacted_thinking', data: reasoningMarker }]]) {
    installFake(() => response({ content, stop_reason: 'end_turn' }));
    await assert.rejects(() => requestRaw({ ...config, provider: 'claude' }), protocolError('reasoning_only'));
    installFake(() => response({ content, stop_reason: 'max_tokens' }));
    await assert.rejects(() => requestRaw({ ...config, provider: 'claude' }), protocolError('length'));
  }
  for (const payload of [{}, { choices: [] }, { choices: [{ message: { content: '  ' } }] }]) {
    installFake(() => response(payload));
    await assert.rejects(() => requestRaw(), protocolError('empty_content'));
  }
  for (const body of [responseMarker, 'null', '[]', '"text-envelope"']) {
    installFake(() => ({ status: 200, body }));
    await assert.rejects(() => requestRaw(), protocolError('invalid_response'));
  }
});

test('HTTP failures preserve numeric status without global retries or image/key echoes', async () => {
  for (const status of [400, 401, 403, 422, 429, 500, 502, 503, 504]) {
    const calls = installFake(() => ({ status, body: JSON.stringify({ error: {
      message: `服务请求失败：HTTP ${status}；${config.apiKey}；${imageUrl}；${imageData}`,
    } }) }));
    await assert.rejects(requestRaw, (error: unknown) => {
      assert.ok(error instanceof TextModelHttpError);
      assert.equal(error.name, 'TextModelHttpError'); assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`, 'u'));
      for (const secret of [config.apiKey, imageUrl, imageData]) {
        assert.equal(`${error.message}\n${JSON.stringify(error)}`.includes(secret), false, 'HTTP classification must not retain echoed credentials or image bytes');
      }
      return true;
    });
    assert.equal(calls(), 1, 'HTTP retry policy belongs to the explicitly authorized operation, not common transport');
  }
});

test('explicit provider output-cap rejection keeps status and safe numeric evidence for a scoped retry', async () => {
  for (const status of [400, 422]) {
    const calls = installFake(() => ({ status, body: JSON.stringify({ error: { message: 'Invalid max_tokens value: valid range is [1, 8192]' } }) }));
    await assert.rejects(requestRaw, (error: unknown) => {
      assert.ok(error instanceof TextModelHttpError); assert.equal(error.status, status);
      assert.match(error.message, /max_tokens.*8192/u); return true;
    });
    assert.equal(calls(), 1, 'even explicit output-cap rejections do not create common-transport hidden calls');
  }
});

test('reasoning quota errors stay terminal to ordinary JSON repair despite scoped tail retry support', async () => {
  const calls = installFake(() => response({ choices: [{ message: { content: null, reasoning_content: reasoningMarker }, finish_reason: 'length' }] }));
  await assert.rejects(requestDecision, protocolError('length'));
  assert.equal(calls(), 1, 'tail-frame retry permission must not broaden story or director operations');
});

test('body wording never acts as a local refusal heuristic and successful extraction stays compatible', async () => {
  const text = 'I cannot find the lamp; refusal, content_filter and length are words on a sign.';
  for (const payload of [
    { choices: [{ message: { content: `  ${text}  `, refusal: null }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: text, refusal: '' } }] },
    { choices: [{ message: { content: [{ type: 'text', text }] } }] },
    { choices: [{ text }] },
    { output_text: text },
  ]) {
    installFake(() => response(payload));
    assert.equal(await requestRaw(), text);
  }
  installFake(() => response({ content: [{ type: 'thinking', thinking: reasoningMarker }, { type: 'text', text }], stop_reason: 'end_turn' }));
  assert.equal(await requestRaw({ ...config, provider: 'claude' }), text);
});

const requestDecision = () => requestDirectorDecision(config, story, '', 'drama');
const assertJsonDiagnostic = async (content: string, expected: RegExp): Promise<void> => {
  const calls = installFake(() => textResponse(content));
  await assert.rejects(requestDecision, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof TextModelResponseError, false, 'JSON format failure must not be misreported as a provider refusal');
    assert.match(error.message, expected);
    assertNoResponseEcho(error);
    assertVisibleReason(error, expected);
    return true;
  });
  assert.equal(calls(), 1);
};

test('plain-text JSON failures mention possible explanations without asserting a refusal', async () => {
  for (const content of [responseMarker, `I cannot determine the location. ${responseMarker}`]) {
    await assertJsonDiagnostic(content, /非 JSON 文本.*可能.*未提供明确拒绝标记.*无法确认/u);
  }
});

test('malformed, incomplete, other JSON values and field mismatches stay distinguishable', async () => {
  await assertJsonDiagnostic(`{"mode":"narrative","reason":"${responseMarker}",}`, /JSON 语法损坏/u);
  await assertJsonDiagnostic(`{"mode":"narrative","reason":"${responseMarker}"`, /未闭合.*可能.*被截断.*格式损坏/u);
  for (const content of ['[]', 'null', '42', `"${responseMarker}"`]) {
    await assertJsonDiagnostic(content, /其他 JSON 值类型/u);
  }
  for (const content of [`{"mode":"unknown","reason":"${responseMarker}"}`, '{}', '{"envelope":{"mode":"narrative"}}']) {
    await assertJsonDiagnostic(content, /字段类型或结构不符合预期/u);
  }
  installFake(() => textResponse(`{"reason":"${responseMarker}"}`));
  await assert.rejects(() => requestStoryDurationEstimate(config, {
    title: '守灯人', story,
    beats: [{ id: 'lamp-beat', index: 1, text: story, weight: 1, kind: 'visible-action', sourceStart: 0, sourceEnd: story.length }],
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assertVisibleReason(error, /缺少必需字段：minSec、recommendedSec、maxSec、fitStatus、reason/u);
    return true;
  });
  installFake(() => textResponse('{"unrecognized":"neutral-value"}'));
  await assert.rejects(() => requestStoryPreparation(config, story, undefined, undefined, 'expand'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assertVisibleReason(error, /expandedStory 或 optimizedStory 单字段.*字段类型或结构不符合预期/u);
    return true;
  });
});

test('legacy JSON-only records explain the missing historical evidence without inventing a cause', () => {
  for (const oldMessage of [
    '文本模型返回的资料补齐结果不是有效JSON对象',
    '文本模型返回的智能导演结果不是有效 JSON 对象。',
    '任务处理失败：文本模型返回的剧情分段结果不是有效 JSON 对象',
  ]) {
    const error = Object.freeze(new Error(oldMessage));
    for (const input of [error, oldMessage, String(error), getSafeErrorDiagnostics(error)]) {
      const shown = formatUserFacingError(input);
      assert.match(shown, /不是有效\s*JSON\s*对象/u);
      assert.match(shown, /该旧记录未保存原始响应\/结束原因，无法进一步确定/u);
      assert.doesNotMatch(shown, /明确拒绝|被截断|内容过滤|服务返回了未识别的错误/u);
      assert.equal(formatUserFacingError(shown), shown);
    }
    assert.equal(error.message, oldMessage, 'historical records must remain untouched');
    assert.equal(getSafeErrorDiagnostics(error).message, oldMessage, 'technical details retain the actual recorded evidence');
  }
  for (const message of [
    '文本模型返回的资料补齐结果不是有效 JSON 对象：JSON 语法损坏，无法解析',
    '文本模型返回的资料补齐结果不是有效 JSON 对象：返回了其他 JSON 值类型',
    '文本模型返回的资料补齐结果字段类型或结构不符合预期',
  ]) assert.doesNotMatch(formatUserFacingError(message), /旧记录|未保存原始响应/u);
  for (const metadata of [{ status: 200 }, { status: 503 }, { code: 'RESPONSE_PROTOCOL' }]) {
    assert.doesNotMatch(formatUserFacingError({ message: '文本模型返回的资料补齐结果不是有效 JSON 对象', ...metadata }), /旧记录|未保存原始响应/u);
  }
});

test('protocol and field contexts do not globally whitelist arbitrary English provider prose', () => {
  for (const word of ['refusal', 'length', 'reason', 'expandedStory', 'recommendedSec']) {
    assert.match(formatUserFacingError(`文本模型请求失败：${word} unexpected vendor explanation`), /未识别/u);
  }
  for (const message of [
    '文本模型返回的结果缺少必需字段：minSec opaqueFailure',
    '文本模型返回的结果缺少必需字段：reason、breakdown，unexpected issue',
  ]) assert.match(formatUserFacingError(message), /未识别/u, 'schema-label masking must not swallow unrelated prose after the identifiers');
});

test('valid JSON selection preserves BOM, fences, explanatory text, escaped braces and final eligible object', async () => {
  for (const content of [
    '\uFEFF {"mode":"narrative","reason":"灯亮起"}',
    '```json\n{"mode":"narrative","reason":"灯亮起"}\n```',
    '说明：{"mode":"narrative","reason":"灯亮起"}',
    '{"mode":"action","reason":"草稿"}\n{"mode":"narrative","reason":"灯亮起"}',
    '{"mode":"invalid"}\n{"mode":"narrative","reason":"灯亮起"}',
  ]) {
    installFake(() => textResponse(content));
    assert.deepEqual(await requestDecision(), { workflow: 'drama', reason: '灯亮起' });
  }
  const reason = '灯罩上的 {图案} 与 "刻字"';
  installFake(() => textResponse(JSON.stringify({ mode: 'narrative', reason })));
  assert.deepEqual(await requestDecision(), { workflow: 'drama', reason });
});

test('terminal response errors do not trigger the preparation output-limit compatibility retry', async () => {
  for (const fixture of protocolResponses) {
    const calls = installFake(() => response(fixture.payload));
    await assert.rejects(() => requestStoryPreparation(config, story), protocolError(fixture.code));
    assert.equal(calls(), 1);
  }
});

const shot = {
  startSec: 0, endSec: 3, sourceExcerpt: story, purpose: '点灯', subject: '守灯人', action: story,
  camera: '固定中景', transition: '动作完成', lighting: '窗边灯光', sound: '动作层-[第1s木门轻响]', result: '灯已经点亮',
};
const shotParams: Parameters<typeof requestShotRecommendation>[1] = {
  durationSec: 3, workflow: 'drama', pace: 'normal', story, requiredShotCount: 1,
};

test('storyboard initial, review and repair protocol failures preserve their type and stop further requests', async () => {
  for (const fixture of protocolResponses) {
    for (const stage of ['initial', 'review', 'repair', 'review-repair'] as const) {
      const reviewWithAi = stage === 'review' || stage === 'review-repair';
      const failureCall = stage === 'initial' ? 1 : stage === 'review-repair' ? 3 : 2;
      let reviews = 0;
      let repairs = 0;
      const calls = installFake((call) => call === failureCall
        ? response(fixture.payload)
        : textResponse(call === 1 && reviewWithAi ? JSON.stringify({ shots: [shot] }) : '{"shots":['));
      await assert.rejects(() => requestShotRecommendation(config, shotParams, {
        reviewWithAi,
        onReview: () => { reviews += 1; },
        onRepair: () => { repairs += 1; },
      }), protocolError(fixture.code));
      assert.equal(calls(), failureCall);
      assert.equal(reviews, reviewWithAi ? 1 : 0);
      assert.equal(repairs, stage === 'repair' || stage === 'review-repair' ? 1 : 0);
    }
  }
});

const segmentationInput: AiStorySegmentationInput = {
  title: '守灯人', story, totalDurationSec: 3, maxSegmentDurationSec: 3,
  beats: [{ id: 'lamp-beat', index: 1, text: story, weight: 1, kind: 'visible-action', sourceStart: 0, sourceEnd: story.length }],
  masterShots: [{ ...shot, id: 'lamp-shot', index: 1, authoredBy: 'text-api', sourceBeatIds: ['lamp-beat'] }],
};

test('segmentation review and repair propagate terminal protocol errors without losing their code', async () => {
  for (const fixture of protocolResponses) {
    for (const reviewWithAi of [false, true]) {
      let repairs = 0;
      const calls = installFake((call) => call === 1 ? textResponse('{"segments":[') : response(fixture.payload));
      await assert.rejects(() => requestAiStorySegmentation(config, segmentationInput, undefined, {
        reviewWithAi,
        onRepair: () => { repairs += 1; },
      }), protocolError(fixture.code));
      assert.equal(calls(), 2);
      assert.equal(repairs, reviewWithAi ? 0 : 1);
    }
  }
});

test('ordinary malformed storyboard JSON retains its existing bounded repair path', async () => {
  let repairs = 0;
  const calls = installFake((call) => textResponse(call === 1 ? '{"shots":[' : JSON.stringify({ shots: [shot] })));
  const result = await requestShotRecommendation(config, shotParams, { onRepair: () => { repairs += 1; } });
  assert.equal(calls(), 2);
  assert.equal(repairs, 1);
  assert.equal(result.shots[0].action, story);
});

globalThis.fetch = async () => { throw new Error('Live network is disabled in text-model response tests'); };
const failures: Array<{ name: string; error: unknown }> = [];
try {
  for (const item of tests) {
    try {
      await item.run();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.error(`not ok - ${item.name}`);
      console.error(error);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
if (failures.length) throw new AggregateError(failures.map(({ error }) => error), `${failures.length} text-model response check(s) failed`);
console.log(`${tests.length} text-model response error checks passed`);
