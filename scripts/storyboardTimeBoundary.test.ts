import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import { formatUserFacingError } from '../src/userFacingError';
import type { AiStoryboardShotPlan, TextApiConfig } from '../src/types';

// Entirely synthetic HTTP replies: no real endpoint, user project or paid API.
type Payload = { body?: string };
type Params = Parameters<typeof requestShotRecommendation>[1];
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://storyboard-time.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-key', model: 'synthetic-time', temperature: 0, maxTokens: 4096, vision: false,
};
const params: Params = { durationSec: 15, workflow: 'drama', pace: 'natural', story: '林舟停步，看向院门，轻声说：“请稍等。”' };
const semantic: Params = { ...params, sequenceSegmentContext: {
  kind: 'semantic-segment-source-v1', segmentIndex: 6, segmentCount: 7, segmentDurationSec: 15,
  segment: { content: params.story },
} };
const prose = {
  sourceExcerpt: params.story, purpose: '停步回应', subject: '林舟', action: '林舟停步，看向院门，轻声回应。',
  camera: '固定侧面中景', transition: '动作结果后切换', lighting: '自然日光', sound: '自然现场声', result: '林舟保持停步',
  space: '院门外', performance: '神情自然', direction: '朝向院门', dialogue: '第1s–第2s @林舟：“请稍等。”',
};
const shot = (startSec: number, endSec: number) => ({ ...prose, startSec, endSec });
const response = (shots: unknown[]) => ({ shots, aiReview: { status: 'passed', summary: '合成自检', issues: [] } });
const requestText = (payload: Payload, role: string) => {
  const body = JSON.parse(payload.body || '{}');
  return String(body.messages?.find((message: { role: string }) => message.role === role)?.content || '');
};
const requestData = (payload: Payload, tag: string): Record<string, any> => {
  const match = requestText(payload, 'user').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match); return JSON.parse(match[1]);
};
const install = (answer: (payload: Payload, index: number) => unknown) => {
  const calls: Payload[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: Payload) => {
      calls.push(payload);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer(payload, calls.length - 1)) } }] }) };
    } },
  } });
  return calls;
};
const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });
const assertProse = (shots: readonly AiStoryboardShotPlan[]) => shots.forEach((item) => {
  for (const key of Object.keys(prose) as Array<keyof typeof prose>) assert.equal(item[key], prose[key], `time decoding must not rewrite ${key}`);
});

test('equivalent seconds and conventional clock representations no longer enter repair', async () => {
  for (const times of [
    ['0', '15'], ['0s', '15s'], ['０秒', '１５秒'], ['0 sec', '15 seconds'], ['0ms', '15000毫秒'],
    ['00:00', '00:15'], ['00:00:00', '00:00:15'], ['0.000 s', '15.000秒'],
  ]) {
    const calls = install(() => response([{ ...prose, startSec: times[0], endSec: times[1] }]));
    const result = await requestShotRecommendation(config, semantic, { reviewWithAi: true,
      onRepair: () => assert.fail(`equivalent notation is not a defect: ${times}`),
    });
    assert.equal(calls.length, 2); assert.deepEqual(result.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 15]]);
    assertProse(result.shots);
  }
});

test('documented and conventional boundary aliases are decoded without inventing boundaries', async () => {
  for (const [start, end] of [['globalStartSec', 'globalEndSec'], ['startTime', 'endTime'], ['start', 'end']]) {
    const calls = install(() => response([{ ...prose, [start]: '0s', [end]: '15秒' }]));
    const result = await requestShotRecommendation(config, params);
    assert.equal(calls.length, 1); assert.deepEqual(result.shots, [shot(0, 15)]);
  }
});

test('explicit complete ranges are readable without using the per-shot localTimeRangeSec', async () => {
  for (const [field, value] of [
    ['timeRangeSec', [0, 15]], ['timeRange', '【0s–15s】'], ['timeRange', '00:00 - 00:15'], ['timeRange', '0秒至15秒'],
  ] as const) {
    const calls = install(() => response([{ ...prose, [field]: value }]));
    const result = await requestShotRecommendation(config, params);
    assert.equal(calls.length, 1); assert.deepEqual(result.shots, [shot(0, 15)]);
  }
});

test('fractional shot timestamps retain exact duration and source prose', async () => {
  const calls = install(() => response([
    { ...prose, startSec: '0s', endSec: '00:04.25' }, { ...prose, startSec: '4250ms', endSec: '00:15' },
  ]));
  const result = await requestShotRecommendation(config, params);
  assert.equal(calls.length, 1); assert.deepEqual(result.shots, [shot(0, 4.25), shot(4.25, 15)]);
});

test('known segment six can decode a complete explicitly global75–90 window as segment0–15', async () => {
  const calls = install(() => response([
    { ...prose, globalStartSec: '01:15', globalEndSec: '01:21.5' },
    { ...prose, globalStartSec: '01:21.5', globalEndSec: '01:30' },
  ]));
  const result = await requestShotRecommendation(config, semantic, { reviewWithAi: true });
  assert.equal(calls.length, 2); assert.deepEqual(result.shots, [shot(0, 6.5), shot(6.5, 15)]);
  assertProse(result.shots);
});

test('canonical local boundaries stay authoritative when optional global coordinates also exist', async () => {
  const calls = install(() => response([{ ...shot(0, 15), globalStartSec: 75, globalEndSec: 90, localTimeRangeSec: [0, 15] }]));
  const result = await requestShotRecommendation(config, semantic, { reviewWithAi: true });
  assert.equal(calls.length, 2); assert.deepEqual(result.shots, [shot(0, 15)]);
});

test('unlabelled late start, partial global window and unknown index are never guessed or clamped', async () => {
  for (const [input, authored] of [
    [semantic, [shot(75, 90)]],
    [semantic, [{ ...prose, globalStartSec: 78, globalEndSec: 90 }]],
    [{ ...semantic, sequenceSegmentContext: { ...semantic.sequenceSegmentContext, segmentIndex: undefined } }, [{ ...prose, globalStartSec: 75, globalEndSec: 90 }]],
  ] as const) {
    const calls = install((payload, index) => {
      if (index < 2) return response([...authored]);
      const data = requestData(payload, 'storyboard_repair_data');
      assert.deepEqual(JSON.parse(data.previousRepairResponse).shots, authored, 'repair receives untouched authored times');
      assert.ok(data.masterTimelineDiagnostic); return response([shot(0, 15)]);
    });
    const result = await requestShotRecommendation(config, input, { reviewWithAi: true });
    assert.equal(calls.length, 3); assert.deepEqual(result.shots, [shot(0, 15)]);
  }
});

test('null, booleans, blank and containers cannot masquerade as a zero start', async () => {
  for (const value of [null, false, true, '', ' ', [], {}, '00:00:00:12', '3 or 4s', '00:70', 'NaN', 'Infinity']) {
    const calls = install((payload, index) => {
      if (index < 2) return response([{ ...shot(0, 15), startSec: value }]);
      const data = requestData(payload, 'storyboard_repair_data');
      assert.equal(data.shotTimeDiagnostic.shotIndex, 1);
      assert.deepEqual(data.shotTimeDiagnostic.receivedTimeFields.startSec, value);
      assert.match(data.validationError, /字段“startSec”不是有效秒数/u);
      assert.match(data.shotTimeDiagnostic.expected, /0–15秒/u);
      return response([shot(0, 15)]);
    });
    const result = await requestShotRecommendation(config, semantic, { reviewWithAi: true });
    assert.equal(calls.length, 3); assert.deepEqual(result.shots, [shot(0, 15)]);
  }
});

test('missing absolute positions receive targeted same-API repair instead of derived starts or durations', async () => {
  for (const timing of [{ durationSec: 15, localTimeRangeSec: [0, 15] }, { startSec: 0, durationSec: 15 }, { endSec: 15 }]) {
    const calls = install((payload, index) => {
      if (index < 2) return response([{ ...prose, ...timing }]);
      const data = requestData(payload, 'storyboard_repair_data');
      assert.equal(data.shotTimeDiagnostic.shotIndex, 1);
      assert.match(data.shotTimeDiagnostic.reason, /缺少/u);
      assert.deepEqual(data.shotTimeDiagnostic.receivedTimeFields, timing);
      assert.equal(data.masterTimelineDiagnostic, undefined, 'unreadable fields cannot become misleading NaN grid evidence');
      return response([shot(0, 15)]);
    });
    assert.deepEqual((await requestShotRecommendation(config, semantic, { reviewWithAi: true })).shots, [shot(0, 15)]);
    assert.equal(calls.length, 3);
  }
});

test('real gaps in compatible time notation still reach AI with numeric rather than NaN diagnostics', async () => {
  const calls = install((payload, index) => {
    if (index < 2) return response([{ ...prose, startSec: '0s', endSec: '4s' }, { ...prose, startSec: '5s', endSec: '15s' }]);
    const data = requestData(payload, 'storyboard_repair_data');
    assert.equal(data.masterTimelineDiagnostic.kind, 'gap-overlap');
    assert.equal(data.masterTimelineDiagnostic.offendingShot.startSec, 5);
    assert.equal(data.shotTimeDiagnostic, undefined); return response([shot(0, 6), shot(6, 15)]);
  });
  const result = await requestShotRecommendation(config, semantic, { reviewWithAi: true });
  assert.equal(calls.length, 3); assert.deepEqual(result.shots, [shot(0, 6), shot(6, 15)]);
});

test('all three phases carry the same coordinate contract and latest concrete repair evidence', async () => {
  const states = [response([{ ...prose, startSec: 'broken', endSec: 15 }]), response([shot(0, 0)]), response([{ ...prose, endSec: 15 }])];
  const calls = install((payload, index) => {
    const tag = index === 0 ? 'storyboard_planning_data' : index === 1 ? 'storyboard_ai_review_data' : 'storyboard_repair_data';
    const data = requestData(payload, tag);
    assert.deepEqual(data.shotTimeCoordinateContract.outputRangeSec, [0, 15]);
    assert.equal(data.shotTimeCoordinateContract.boundaryTimeBasis, 'current-segment-seconds');
    assert.match(requestText(payload, 'system'), /startSec.*endSec.*本段内镜头位置/u);
    if (index >= 2) {
      assert.equal(data.repairAttempt, index - 1);
      assert.ok(data.shotTimeDiagnostic);
      assert.deepEqual(JSON.parse(data.previousRepairResponse), states[Math.min(index - 2, 2)]);
    }
    return states[Math.min(Math.max(index - 1, 0), 2)];
  });
  await assert.rejects(requestShotRecommendation(config, semantic, { reviewWithAi: true }), /自动修复 3 次.*第 1 镜时间边界无效.*缺少字段“startSec”.*endSec.*15/u);
  assert.equal(calls.length, 5);
});

test('time errors expose safe field/type evidence while raw prose and deep objects stay in internal repair data', async () => {
  const marker = 'PRIVATE_STORY_AND_KEY_MARKER_sk-secret-never-log';
  for (const [value, expectedSummary] of [
    [null, '空值'], [false, '布尔值'], ['  ', '空文本'],
    [`剧情误填：${marker.repeat(40)}`, '非时间文本'],
    [{ nested: { key: marker, body: marker.repeat(40) } }, '对象'],
    [[marker, { key: marker }], '数组（2项）'],
  ] as const) {
    const progress: string[] = [];
    const calls = install((payload, index) => {
      if (index >= 2) {
        const repair = requestData(payload, 'storyboard_repair_data');
        assert.deepEqual(repair.shotTimeDiagnostic.receivedTimeFields.startSec, value, 'internal AI repair gets the full original, without a120-character cut');
        assert.doesNotMatch(repair.validationError, /PRIVATE_STORY_AND_KEY_MARKER|secret-never-log/u);
      }
      return response([{ ...prose, startSec: value, endSec: 15 }]);
    });
    let message = '';
    await assert.rejects(requestShotRecommendation(config, semantic, { reviewWithAi: true, onRepair: ({ detail }) => progress.push(detail) }), (error: unknown) => {
      assert.ok(error instanceof Error); message = error.message; return true;
    });
    assert.equal(calls.length, 5); assert.ok(message.length < 1500, 'no recursive object dump or unbounded prose enters the public message');
    assert.ok(message.includes(`字段“startSec”=${expectedSummary}`));
    for (const displayed of [...progress, message, formatUserFacingError(message)]) {
      assert.doesNotMatch(displayed, /PRIVATE_STORY_AND_KEY_MARKER|secret-never-log/u);
      assert.match(displayed, /第 1 镜时间边界无效.*不是有效秒数/u);
      assert.match(displayed, /当前输出范围0–15秒/u);
      assert.doesNotMatch(displayed, /未识别|暂时无法确定/u);
    }
  }
});

test('display length limits never replace validation or truncate the value given to AI repair', async () => {
  const valid = `0.${'0'.repeat(200)}`;
  const validCalls = install(() => response([{ ...prose, startSec: valid, endSec: 15 }]));
  assert.deepEqual((await requestShotRecommendation(config, params)).shots, [shot(0, 15)]);
  assert.equal(validCalls.length, 1, 'a long but equivalent numeric spelling is still valid');
  const invalid = `${valid} RAW_SECRET_MARKER_after_120_characters`;
  const calls = install((payload, index) => {
    if (index >= 2) {
      const repair = requestData(payload, 'storyboard_repair_data');
      assert.equal(repair.shotTimeDiagnostic.receivedTimeFields.startSec, invalid);
      assert.match(repair.validationError, /非时间文本/u);
      assert.doesNotMatch(repair.validationError, /RAW_SECRET_MARKER/u);
      return response([shot(0, 15)]);
    }
    return response([{ ...prose, startSec: invalid, endSec: 15 }]);
  });
  assert.deepEqual((await requestShotRecommendation(config, semantic, { reviewWithAi: true })).shots, [shot(0, 15)]);
  assert.equal(calls.length, 3, 'a valid numeric prefix cannot conceal malformed trailing text');
});

test('safe error formatting preserves known field aliases, controlled time values and actual cause', async () => {
  for (const fields of [
    { startSec: null, endSec: '15s' }, { startTime: false, endTime: '15 seconds' },
    { startSec: '15 sec', endSec: '00:10' }, { startSec: '0', endSec: false },
  ]) {
    install(() => response([{ ...prose, ...fields }]));
    await assert.rejects(requestShotRecommendation(config, semantic, { reviewWithAi: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const shown = formatUserFacingError(error);
      assert.match(shown, /第 1 镜时间边界无效/u);
      assert.match(shown, /不是有效秒数|起止顺序错误/u);
      assert.match(shown, /当前输出范围0–15秒/u);
      assert.doesNotMatch(shown, /未识别|暂时无法确定/u);
      for (const value of Object.values(fields)) if (typeof value === 'string') assert.ok(shown.includes(JSON.stringify(value)));
      assert.equal(formatUserFacingError(shown), shown);
      return true;
    });
  }
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected real network call in storyboard time tests'); };
try {
  for (const entry of tests) { await entry.run(); console.log(`PASS ${entry.name}`); }
  console.log(`storyboardTimeBoundary: ${tests.length}/${tests.length} passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
