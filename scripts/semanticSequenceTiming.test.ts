import assert from 'node:assert/strict';
import { requestShotRecommendation } from '../src/services/llm';
import type { AiStoryboardShotPlan, TextApiConfig } from '../src/types';

// Synthetic in-memory replies only; never use real projects or paid APIs.
type RequestPayload = { body?: string };
type Reply = { status: number; body: string };
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://semantic-timing.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential', model: 'synthetic-timing', temperature: 0, maxTokens: 8192, vision: false,
};
const story = '林舟沿桥前行，保持同一个长事件的当前阶段。';
const params = (durationSec = 15) => ({
  durationSec, workflow: 'drama', pace: 'natural', story,
  sequenceSegmentContext: {
    kind: 'semantic-segment-source-v1', segmentIndex: 2, segmentCount: 3, segmentDurationSec: durationSec,
    segment: { content: story, semanticSource: { sourceEvidence: [{ text: story }], events: [{ id: 'same-long-event', description: '行进', phase: '中段' }], dialogues: [] } },
  },
});
const shot = (startSec: number, endSec: number, index = 1): AiStoryboardShotPlan => ({
  startSec, endSec, sourceExcerpt: story, purpose: `阶段${index}`, subject: '林舟',
  action: `完整AI动作${index}；保留原始措辞`, camera: '静止远景', transition: '按已完成状态接续',
  lighting: '自然日光', sound: '无', result: `事件推进到${index}`, space: '桥面', performance: '自然前行', direction: '向右', dialogue: '无',
});
const reply = (shots: AiStoryboardShotPlan[]): Reply => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ shots, aiReview: { status: 'passed', summary: '合成AI自检通过', issues: [] } }) },
}] }) });
const prompt = (payload: RequestPayload, role: string): string => {
  const body = JSON.parse(payload.body || '{}') as { messages?: Array<{ role: string; content: string }> };
  return body.messages?.find((message) => message.role === role)?.content ?? '';
};
const data = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match); return JSON.parse(match[1]);
};
const install = (answer: (payload: RequestPayload, index: number) => Reply) => {
  const calls: RequestPayload[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: RequestPayload) => { calls.push(payload); return answer(payload, calls.length - 1); } },
  } });
  return calls;
};
const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

test('valid semantic 0..D timelines preserve AI prose and add no call, including custom D above15', async () => {
  for (const duration of [1, 7, 12.34, 30, 300]) {
    const authored = [shot(0, duration)];
    const calls = install(() => reply(authored));
    const result = await requestShotRecommendation(config, params(duration), { reviewWithAi: true });
    assert.equal(calls.length, 2, 'only the existing plan and review calls are made');
    assert.deepEqual(result.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, duration]]);
    assert.equal(result.shots[0].action, authored[0].action);
    assert.equal(result.shots[0].dialogue, authored[0].dialogue);
    assert.match(prompt(calls[0], 'system'), new RegExp(`完整连续覆盖本段0–${duration}秒`, 'u'));
    assert.match(prompt(calls[1], 'system'), new RegExp(`每个镜头不超过 ${duration} 秒`, 'u'));
  }
});

test('start gaps, inter-shot gaps/overlap, short tails and overruns all reach the existing technical repair', async () => {
  const defects = [
    { label: 'nonzero first start', shots: [shot(3, 14)] },
    { label: 'internal gap', shots: [shot(0, 5), shot(6, 15, 2)] },
    { label: 'overlap', shots: [shot(0, 9), shot(8, 15, 2)] },
    { label: 'short tail', shots: [shot(0, 14)] },
    { label: 'overflow', shots: [shot(0, 16)] },
  ];
  for (const defect of defects) {
    const corrected = [shot(0, 6), shot(6, 15, 2)];
    const calls = install((payload, index) => {
      if (index < 2) return reply(defect.shots);
      const repair = data(prompt(payload, 'user'), 'storyboard_repair_data');
      assert.equal(repair.durationSec, 15);
      assert.equal(repair.durationAdjustmentPolicy, 'fixed');
      assert.equal(repair.requiredSegmentDurationSec, undefined, 'a semantic single segment does not become a master timeline');
      assert.deepEqual(repair.sequenceSegmentContext, params().sequenceSegmentContext);
      assert.equal(repair.sourceStory, story);
      assert.match(repair.validationError, /invalid|overflow|gap-overlap/u);
      assert.equal(JSON.parse(repair.originalStoryboardResponse).shots[0].startSec, defect.shots[0].startSec, 'original AI evidence is never retimed locally');
      return reply(corrected);
    });
    const result = await requestShotRecommendation(config, params(), { reviewWithAi: true });
    assert.equal(calls.length, 3, defect.label);
    assert.deepEqual(result.shots.map(({ startSec, endSec, action }) => ({ startSec, endSec, action })), corrected.map(({ startSec, endSec, action }) => ({ startSec, endSec, action })));
  }
});

test('numeric repair follows the latest failed candidate and stops after the existing three repairs', async () => {
  const failures = [[shot(2, 15)], [shot(0, 13)], [shot(0, 5), shot(6, 15, 2)], [shot(0, 16)]];
  const progress: number[] = [];
  const calls = install((payload, index) => {
    if (index >= 2) {
      const repair = data(prompt(payload, 'user'), 'storyboard_repair_data');
      assert.equal(repair.repairAttempt, index - 1);
      assert.deepEqual(JSON.parse(repair.previousRepairResponse).shots, failures[index - 2]);
    }
    return reply(failures[Math.max(0, index - 1)]);
  });
  await assert.rejects(requestShotRecommendation(config, params(), { reviewWithAi: true,
    onRepair: ({ attempt, maxAttempts }) => { progress.push(attempt); assert.equal(maxAttempts, 3); },
  }), /自动修复 3 次/u);
  assert.deepEqual(progress, [1, 2, 3]); assert.equal(calls.length, 5);
});

test('success on the last existing repair is accepted without changing D or semantic assignment', async () => {
  const calls = install((_payload, index) => reply(index === 4 ? [shot(0, 12.34)] : [shot(0, 12)]));
  const result = await requestShotRecommendation(config, params(12.34), { reviewWithAi: true });
  assert.equal(calls.length, 5); assert.equal(result.shots[0].endSec, 12.34);
});

test('stale/abort callbacks prevent a numeric repair from spending another request', async () => {
  let current = true;
  const calls = install(() => reply([shot(3, 14)]));
  await assert.rejects(requestShotRecommendation(config, params(), { reviewWithAi: true, isCurrent: () => current,
    onRepair: () => { current = false; },
  }), { name: 'AbortError' });
  assert.equal(calls.length, 2);
  const controller = new AbortController();
  const aborted = install(() => reply([shot(3, 14)]));
  await assert.rejects(requestShotRecommendation(config, params(), { reviewWithAi: true, signal: controller.signal,
    onRepair: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(aborted.length, 2);
});

test('semantic opt-in without separate review also uses D, not the historical15-second ceiling', async () => {
  const calls = install(() => reply([shot(0, 30)]));
  const result = await requestShotRecommendation(config, params(30));
  assert.equal(calls.length, 1); assert.equal(result.shots[0].endSec, 30);
});

test('reviewed legacy non-semantic calls retain their prior behavior and untouched prompt contract', async () => {
  const { sequenceSegmentContext: _semantic, ...legacy } = params();
  const calls = install(() => reply([shot(3, 14)]));
  const result = await requestShotRecommendation(config, legacy, { reviewWithAi: true });
  assert.equal(calls.length, 2); assert.equal(result.shots[0].startSec, 3); assert.equal(result.shots[0].endSec, 14);
  assert.match(prompt(calls[0], 'system'), /每个 master shot 的时长不得超过 15 秒/u);
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network: semantic timing tests are entirely mocked'); };
try {
  for (const entry of tests) { await entry.run(); console.log(`PASS ${entry.name}`); }
  console.log(`semanticSequenceTiming: ${tests.length}/${tests.length} passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
