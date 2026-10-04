import assert from 'node:assert/strict';
import {
  createH3OutputAllowance,
  h3OutputRetryDecision,
  type H3OutputAllowance,
} from '../src/h3OutputRecovery';

let groups = 0;
const group = (fn: () => void): void => { fn(); groups += 1; };
const responseError = (code: string) => Object.assign(new Error(`Synthetic ${code}`), { name: 'TextModelResponseError', code });
const httpError = (status: number, message: string) => Object.assign(new Error(message), { name: 'TextModelHttpError', status });

group(() => {
  const config = Object.freeze({ maxTokens: 6000, model: 'synthetic-model' });
  assert.deepEqual(createH3OutputAllowance(config.maxTokens), { maxTokens: 6000, growthCeiling: 65_536 });
  assert.deepEqual(createH3OutputAllowance(config.maxTokens, true), { maxTokens: 12_000, growthCeiling: 65_536 });
  assert.equal(config.maxTokens, 6000);
});

group(() => {
  for (const invalid of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(createH3OutputAllowance(invalid, true), undefined);
  }
  assert.equal(h3OutputRetryDecision(responseError('length'), undefined).retry, false);
});

group(() => {
  assert.deepEqual(createH3OutputAllowance(40_000, true), { maxTokens: 65_536, growthCeiling: 65_536 });
  assert.deepEqual(createH3OutputAllowance(70_000, true), { maxTokens: 70_000, growthCeiling: 70_000 });
  assert.deepEqual(createH3OutputAllowance(70_000), { maxTokens: 70_000, growthCeiling: 70_000 });
});

group(() => {
  const initial = Object.freeze(createH3OutputAllowance(6000, true)!);
  const decision = h3OutputRetryDecision(responseError('length'), initial);
  assert.equal(decision.retry, true);
  assert.equal(decision.allowance?.maxTokens, 24_000);
  assert.equal(initial.maxTokens, 12_000);
  assert.notEqual(decision.allowance, initial);
  assert.match(decision.explanation, /12000 → 24000/u);
});

group(() => {
  let allowance = createH3OutputAllowance(6000, true)!;
  const tokens: number[] = [];
  for (let retry = 0; retry < 3; retry += 1) {
    allowance = h3OutputRetryDecision(responseError('reasoning_only'), allowance).allowance!;
    tokens.push(allowance.maxTokens);
  }
  assert.deepEqual(tokens, [24_000, 48_000, 65_536]);
  assert.equal(h3OutputRetryDecision(responseError('length'), allowance).allowance?.maxTokens, 65_536);
});

group(() => {
  const allowance = createH3OutputAllowance(70_000)!;
  assert.equal(h3OutputRetryDecision(responseError('length'), allowance).allowance?.maxTokens, 70_000);
  const decision = h3OutputRetryDecision(httpError(400, 'max_tokens must be less than or equal to 32768'), allowance);
  assert.equal(decision.retry, true);
  assert.equal(decision.allowance?.maxTokens, 32_768);
  assert.equal(decision.allowance?.growthCeiling, 70_000);
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  for (const code of ['empty_content', 'invalid_response']) {
    const result = h3OutputRetryDecision(responseError(code), allowance);
    assert.equal(result.retry, true);
    assert.equal(result.allowance, allowance);
  }
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  for (const code of ['refusal', 'content_filter', 'unknown']) {
    const result = h3OutputRetryDecision(responseError(code), allowance);
    assert.equal(result.retry, false);
    assert.equal(result.allowance, allowance);
  }
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  for (const message of [
    'max_tokens must be less than or equal to 8,192',
    'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]',
    'This model supports at most 8192 output tokens',
    'max_completion_tokens cannot exceed 8192',
    'max_output_tokens upper limit is 8192',
    'max_tokens 不能超过8192',
    '最大输出token上限为8192',
  ]) {
    const result = h3OutputRetryDecision(httpError(400, message), allowance);
    assert.equal(result.retry, true, message);
    assert.equal(result.allowance?.maxTokens, 8192, message);
    assert.equal(result.allowance?.providerLimit, 8192, message);
    const next = h3OutputRetryDecision(responseError('length'), result.allowance);
    assert.equal(next.allowance?.maxTokens, 8192, 'A provider ceiling survives later truncation');
  }
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  for (const message of [
    'Maximum context window is 8192; max_tokens must be less than or equal to 1000',
    'input tokens exceed max_tokens limit 8192',
    'prompt length exceeds 8192 tokens',
    '上下文长度超限，max_tokens不能超过8192',
    '输入长度超过限制，max_output_tokens must be less than or equal to 8192',
    'max_tokens is too large',
    'max_tokens must be greater than or equal to 1',
    'max_tokens must be less than or equal to 0',
    'max_tokens must be less than or equal to 99999999999999999999999',
    'max_tokens must be less than or equal to 20000',
  ]) {
    assert.equal(h3OutputRetryDecision(httpError(400, message), allowance).retry, false, message);
  }
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  const message = 'max_tokens must be less than or equal to 8192';
  assert.equal(h3OutputRetryDecision(httpError(422, message), allowance).retry, true);
  for (const status of [401, 403, 408, 429, 500, 502, 503]) {
    assert.equal(h3OutputRetryDecision(httpError(status, message), allowance).retry, false);
  }
});

group(() => {
  const allowance = createH3OutputAllowance(6000, true)!;
  for (const error of [
    Object.assign(responseError('length'), { name: 'AbortError' }),
    Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
    new Error('Failed to fetch'),
    new Error('JSON交付缺少canonicalPrompt'),
    { name: 'TextModelResponseError', code: 'length' },
    'max_tokens must be less than or equal to 8192',
  ]) {
    assert.equal(h3OutputRetryDecision(error, allowance).retry, false);
  }
});

group(() => {
  const allowance: H3OutputAllowance = { maxTokens: 8192, growthCeiling: 65_536, providerLimit: 8192 };
  const lowered = h3OutputRetryDecision(httpError(400, 'max_tokens must be less than or equal to 4096'), allowance);
  assert.equal(lowered.allowance?.providerLimit, 4096);
  assert.equal(h3OutputRetryDecision(responseError('length'), lowered.allowance).allowance?.maxTokens, 4096);
  assert.deepEqual(allowance, { maxTokens: 8192, growthCeiling: 65_536, providerLimit: 8192 });
});

group(() => {
  // Simulate the caller-owned shared phase budget: one structure repair and
  // two capacity recoveries consume the same three slots, never nested loops.
  let usedRetries = 1;
  let calls = 1;
  let allowance = createH3OutputAllowance(6000, true)!;
  const originalMessages = Object.freeze({ system: 'synthetic original contract', user: 'synthetic original evidence' });
  while (true) {
    const decision = h3OutputRetryDecision(responseError('length'), allowance);
    if (!decision.retry || usedRetries >= 3) break;
    usedRetries += 1;
    allowance = decision.allowance!;
    calls += 1;
    assert.equal(originalMessages.system, 'synthetic original contract');
    assert.equal(originalMessages.user, 'synthetic original evidence');
  }
  assert.equal(usedRetries, 3);
  assert.equal(calls, 3);
  assert.equal(allowance.maxTokens, 48_000);
});

console.log(`${groups} H3 output recovery groups passed; no live model calls, saved API edits or semantic gates used`);
