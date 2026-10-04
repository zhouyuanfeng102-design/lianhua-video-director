import assert from 'node:assert/strict';
import { H3DeliveryValidationError, h3FieldIssue } from '../src/h3DeliverySchema';
import { applyH3MetadataRepair, planH3MetadataRepair } from '../src/h3DeliveryRepair';
import { createH3IdentityDeliveryReader, normalizeH3IdentityBindings, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { readH3StagingShotMetadata } from '../src/h3StagingMetadata';
import { createRuntimeErrorLogEntry } from '../src/runtimeErrorLog';
import { formatUserFacingError } from '../src/userFacingError';

// Neutral synthetic data only. No real projects, credentials, or model calls.
const anchor = '身份：成年工作人员，蓝色外套。';
const h3 = `integrated_multimodal_description: [Shot 1] ${anchor} 在工作室整理地图。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const bindings = { version: 1, characters: [{ characterId: 'worker', name: '成年工作人员', referenceAnchor: anchor }] };
const metadata = { sourceBeatIds: ['beat-1'], sourceExcerpt: '整理地图', sourceLocationStatus: 'unlocated', nsfwContinuity: null, visiblePrivatePartsByCharacter: {} };
const delivery = { h3Prompt: h3, canonicalPrompt: 'unchanged canonical fixture', identityBindings: bindings, shotSourceIds: [['shot-1']], shotMetadata: [metadata] };
let count = 0;
const test = (name: string, run: () => void) => { run(); count += 1; console.log(`PASS ${name}`); };
const fieldErrors = (run: () => unknown) => {
  try { run(); } catch (error) { assert.ok(error instanceof H3DeliveryValidationError); return error; }
  throw new Error('Expected a structured field error');
};

test('only absent optional tokens and numeric version spelling are normalized without mutating the input', () => {
  for (const optional of [undefined, null, '', '  ']) {
    const input = { version: '1', characters: [{ ...bindings.characters[0], subjectToken: optional, speakerToken: optional }] };
    const before = structuredClone(input);
    assert.deepEqual(normalizeH3IdentityBindings(input), bindings);
    assert.deepEqual(readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: h3, identityBindings: input })).identityBindings, bindings);
    assert.deepEqual(input, before);
  }
});

test('bad required IDs, records, tokens, and versions still fail with exact paths', () => {
  for (const [field, value] of [['characterId', null], ['name', ''], ['referenceAnchor', []], ['speakerToken', '(S0)'], ['subjectToken', false]] as const) {
    const input = { ...bindings, characters: [{ ...bindings.characters[0], [field]: value }] };
    const error = fieldErrors(() => readH3DeliveryEnvelope(JSON.stringify({ h3Prompt: h3, identityBindings: input })));
    assert.equal(error.issues[0].path, `identityBindings.characters[0].${field}`);
  }
  for (const version of [0, 2, '01', true, {}, [1], null]) assert.equal(normalizeH3IdentityBindings({ ...bindings, version }), undefined);
  assert.equal(normalizeH3IdentityBindings({ version: 1, characters: new Array(257).fill(bindings.characters[0]) }), undefined);
});

test('optional empty values cannot clear an already declared speaker or a voice present in its anchor', () => {
  const voicedAnchor = '身份：成年工作人员 (S1)，蓝色外套。';
  const voiced = { version: 1 as const, characters: [{ ...bindings.characters[0], referenceAnchor: voicedAnchor, speakerToken: '(S1)' }] };
  const source = { h3Prompt: h3.replace(anchor, voicedAnchor), identityBindings: voiced };
  const emptySpeaker = { ...source, identityBindings: { ...voiced, characters: [{ ...voiced.characters[0], speakerToken: null }] } };
  assert.throws(() => readH3DeliveryEnvelope(JSON.stringify(emptySpeaker)), /speaker-token-mismatch/u);
  const read = createH3IdentityDeliveryReader(voiced);
  assert.throws(() => read(JSON.stringify({ h3Prompt: h3, identityBindings: { ...voiced, characters: [{ ...bindings.characters[0], speakerToken: '' }] } })), /已确认映射/u);
  assert.throws(() => read(JSON.stringify({ h3Prompt: h3, identityBindings: { version: 1, characters: [] } })), /不能清空/u);
});

test('collect identity and per-shot schema errors together instead of hiding later failures', () => {
  const error = fieldErrors(() => readH3DeliveryEnvelope(JSON.stringify({
    ...delivery, identityBindings: { ...bindings, characters: [{ ...bindings.characters[0], speakerToken: false }] },
    shotMetadata: [{ ...metadata, sourceBeatIds: 'wrong', sourceLocationStatus: 'unknown' }, { ...metadata, nsfwContinuity: undefined }], shotSourceIds: ['shot-1'],
  })));
  assert.deepEqual(error.issues.map((issue) => issue.path).sort(), [
    'identityBindings.characters[0].speakerToken', 'shotMetadata[0].sourceBeatIds', 'shotMetadata[0].sourceLocationStatus',
    'shotMetadata[1].nsfwContinuity', 'shotSourceIds[0]',
  ].sort());
});

test('provenance coordinates stay strict and valid null/no-state cases keep their original meaning', () => {
  assert.deepEqual(readH3StagingShotMetadata([null, { ...metadata, sourceStart: null, sourceEnd: null }]), [null, metadata]);
  for (const [change, path] of [
    [{ sourceStart: 0 }, 'sourceStart'],
    [{ sourceLocationStatus: 'located', sourceStart: '0', sourceEnd: 1 }, 'sourceStart'],
    [{ sourceLocationStatus: 'located', sourceStart: 4, sourceEnd: 3 }, 'sourceEnd'],
    [{ visiblePrivatePartsByCharacter: [] }, 'visiblePrivatePartsByCharacter'],
    [{ nsfwContinuity: { clothingState: null } }, 'nsfwContinuity.clothingState'],
    [{ nsfwContinuity: { invented: 'value' } }, 'nsfwContinuity'],
  ] as const) {
    const error = fieldErrors(() => readH3StagingShotMetadata([{ ...metadata, ...change }]));
    assert.ok(error.issues.some((issue) => issue.path === `shotMetadata[0].${path}`));
  }
  const input = { ...metadata, sourceLocationStatus: 'located', sourceStart: 0, sourceEnd: 4 };
  assert.deepEqual(readH3StagingShotMetadata([input]), [input]);
});

test('type summaries survive user-facing formatting and runtime persistence without copying returned content', () => {
  const secret = 'sensitive-secret-response-string';
  const error = fieldErrors(() => readH3DeliveryEnvelope(JSON.stringify({ ...delivery, identityBindings: { ...bindings, characters: [{ ...bindings.characters[0], speakerToken: secret }] } })));
  const wrapped = new Error(`AI已自动重试修复交付排程3次，仍未返回可同步的数据：${error.message}`);
  const entry = createRuntimeErrorLogEntry({ stage: 'storyboard-convert', error: wrapped })!;
  assert.ok(!JSON.stringify(entry).includes(secret));
  assert.match(entry.message, /identityBindings\.characters\[0\]\.speakerToken/u);
  assert.match(entry.message, /实际字符串/u);
  const shown = formatUserFacingError(entry.message);
  assert.doesNotMatch(shown, /未识别|暂时无法/u);
  assert.ok(shown.includes('identityBindings.characters[0].speakerToken'));
  assert.equal(formatUserFacingError(shown), shown);
});

const badDelivery = { ...delivery, shotMetadata: [{ ...metadata, sourceBeatIds: null }] };
const badResponse = JSON.stringify(badDelivery);
const error = fieldErrors(() => readH3DeliveryEnvelope(badResponse));
const plan = planH3MetadataRepair(badResponse, error)!;

test('metadata-only repair locks the entire body, canonical text, and other accepted metadata', () => {
  assert.deepEqual(plan.fields, ['shotMetadata']);
  const repaired = applyH3MetadataRepair(plan, JSON.stringify({ metadataPatch: { shotMetadata: [metadata] } }));
  assert.deepEqual(JSON.parse(repaired), delivery);
  assert.equal(JSON.parse(repaired).h3Prompt, h3);
  assert.deepEqual(plan.delivery, badDelivery);
  assert.deepEqual(readH3DeliveryEnvelope(repaired).shotMetadata, [metadata]);
});

test('full envelope representation is accepted only if locked fields are unchanged', () => {
  assert.deepEqual(JSON.parse(applyH3MetadataRepair(plan, JSON.stringify(delivery))), delivery);
  for (const change of [ { h3Prompt: `${h3} altered` }, { canonicalPrompt: 'altered' }, { identityBindings: { version: 1, characters: [] } }, { extra: true } ]) {
    assert.throws(() => applyH3MetadataRepair(plan, JSON.stringify({ ...delivery, ...change })), H3DeliveryValidationError);
  }
});

test('partial, unrelated, prototype, and body-changing patches cannot be applied', () => {
  for (const invalid of [
    '{', 'null', JSON.stringify({ metadataPatch: {} }), JSON.stringify({ metadataPatch: { shotMetadata: [metadata], h3Prompt: 'changed' } }),
    JSON.stringify({ metadataPatch: { shotMetadata: [metadata] }, h3Prompt: 'changed' }),
    '{"metadataPatch":{"__proto__":{"polluted":true},"shotMetadata":[]}}',
  ]) assert.throws(() => applyH3MetadataRepair(plan, invalid), H3DeliveryValidationError);
  assert.equal(Object.getPrototypeOf(plan.delivery), Object.prototype);
});

test('body or semantic errors never get silently turned into metadata-only patches', () => {
  assert.equal(planH3MetadataRepair(badResponse, new Error('anchor mismatch')), undefined);
  assert.equal(planH3MetadataRepair('{', error), undefined);
  assert.equal(planH3MetadataRepair(JSON.stringify({ ...badDelivery, h3Prompt: '' }), error), undefined);
  assert.equal(planH3MetadataRepair(badResponse, new H3DeliveryValidationError([h3FieldIssue('canonicalPrompt', '正文', null)])), undefined);
});

console.log(`H3 delivery schema: ${count} offline regression cases passed`);
