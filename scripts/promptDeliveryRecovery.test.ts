import assert from 'node:assert/strict';
import { applyConvertedPromptToShots } from '../src/masterTimeline';
import { createH3IdentityDeliveryReader, readH3DeliveryEnvelope } from '../src/h3IdentityBindings';
import { planH3MetadataRepair, applyH3MetadataRepair } from '../src/h3DeliveryRepair';
import { readStoryboardTextFields, StoryboardFieldValidationError, applyStoryboardFieldRepair } from '../src/storyboardDelivery';
import { requestShotRecommendation } from '../src/services/llm';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { formatUserFacingError } from '../src/userFacingError';
import type { H3IdentityBindings, TextApiConfig, VideoShot } from '../src/types';

let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); count++; console.log(`PASS ${name}`); };
const action = '抬手指向地图→放下手';
const line = (value: string) => `【0s-5s】 主体：@旅人甲（专注）[朝向：地图] ${value}；空间：大厅；光影：自然光；镜头：固定中景；台词：无；音效：无`;
const seed: VideoShot = { id: 'shot-1', index: 1, startSec: 0, endSec: 5, subject: '旅人甲', action: '旧动作不得补用',
  purpose: '查看地图', camera: '固定中景', lighting: '自然光', sound: '无', result: '手已放下',
  transition: '自然结束', referenceAssetIds: [], prompt: '', locked: false };

await test('equivalent explicit action wrappers are accepted without altering the authored text', () => {
  for (const value of [`正在 [${action}]`, `正在 ［${action}］`, `正在 【${action}】`, `正在 ${action}`, `动作：[${action}]`, `动作链：${action}`]) {
    const result = applyConvertedPromptToShots([seed], line(value), 5);
    assert.equal(result[0].action, action, value);
    assert.equal(result[0].prompt, line(value));
    assert.equal(result[0].id, seed.id);
  }
  for (const value of ['站在桌旁', '正在 []', '正在 [', '正在 ［抬手', '正在 【】']) {
    assert.throws(() => applyConvertedPromptToShots([seed], line(value), 5), /动作链|缺少必填字段/u);
  }
  assert.throws(() => applyConvertedPromptToShots([seed], line('').replace('空间：大厅', `空间：正在 [${action}]`), 5), /动作链/u);
});

const sample = { startSec: 0, endSec: 5, sourceExcerpt: '旅人甲查看大厅地图。',
  purpose: '查看地图', subject: '旅人甲', action, camera: '固定中景', transition: '自然结束',
  lighting: '自然光', sound: '无', result: '手已放下', space: '大厅', performance: '专注', direction: '朝向地图', dialogue: '无' };
const delivery = (shot: Record<string, unknown> = sample) => ({ aiReview: { status: 'passed', summary: '分镜已检查', issues: [] },
  reason: '地图观察', breakdown: ['查看地图'], shots: [shot] });
await test('action aliases and flat string arrays are lossless; ambiguous or missing fields remain errors', () => {
  for (const replacement of [{ action }, { action: ['抬手指向地图', '放下手'] }, { action: undefined, actionChain: action },
    { action: undefined, 动作链: ['抬手指向地图', '放下手'] }, { action, action_chain: action }]) {
    assert.equal(readStoryboardTextFields(delivery({ ...sample, ...replacement }))[0].action, action);
  }
  for (const replacement of [{ action: [] }, { action: ['抬手', {}] }, { action: {} }, { action: ' ' },
    { action: undefined }, { action, actionChain: '走开' }]) {
    assert.throws(() => readStoryboardTextFields(delivery({ ...sample, ...replacement })), StoryboardFieldValidationError);
  }
});

await test('targeted field repairs preserve all other shots, timings and valid content', () => {
  const broken = { ...delivery({ ...sample, action: undefined, lighting: null }), shots: [
    { ...sample, action: undefined, lighting: null }, { ...sample, startSec: 5, endSec: 10 },
  ] };
  let issue!: StoryboardFieldValidationError;
  try { readStoryboardTextFields(broken); assert.fail('missing fields must fail'); } catch (error) {
    assert.ok(error instanceof StoryboardFieldValidationError); issue = error;
  }
  assert.deepEqual(issue.issues.map((item) => item.path), ['shots[0].action', 'shots[0].lighting']);
  const fields = { action, lighting: '自然光' };
  const patch = { shotFieldPatches: [{ shotIndex: 0, fields }] };
  const fixed = JSON.parse(applyStoryboardFieldRepair(issue, JSON.stringify(patch)));
  assert.deepEqual(fixed.shots, [sample, { ...sample, startSec: 5, endSec: 10 }]);
  assert.deepEqual(JSON.parse(applyStoryboardFieldRepair(issue, JSON.stringify(fixed))), fixed);
  for (const bad of [
    { shotFieldPatches: [] }, { shotFieldPatches: [patch.shotFieldPatches[0], patch.shotFieldPatches[0]] },
    { shotFieldPatches: [{ shotIndex: 0, fields: { ...fields, subject: '乙' } }] },
    { shotFieldPatches: [{ shotIndex: 0, fields: { action } }] },
    { ...fixed, shots: [{ ...fixed.shots[0], endSec: 4 }, fixed.shots[1]] },
    { ...fixed, shots: [fixed.shots[0], { ...fixed.shots[1], action: '走开' }] },
  ]) assert.throws(() => applyStoryboardFieldRepair(issue, JSON.stringify(bad)), /只允许补齐/u);
  assert.equal(broken.shots[0].lighting, null);
  assert.match(formatUserFacingError(issue), /shots\[0\]\.action/u);
  assert.doesNotMatch(formatUserFacingError(issue), /服务返回了未识别/u);
});

const meta = { sourceBeatIds: ['beat-1'], sourceExcerpt: sample.sourceExcerpt, sourceLocationStatus: 'unlocated', nsfwContinuity: null, visiblePrivatePartsByCharacter: {} };
const bindings = (anchor: string, speaking = false): H3IdentityBindings => ({ version: 1, characters: [
  { characterId: 'traveler-1', name: '旅人甲', referenceAnchor: anchor, ...(speaking ? { speakerToken: '(S1)' } : {}) },
] });
const prompt = (anchor: string, movement = '旅人甲查看地图。') => `integrated_multimodal_description: [Shot 1] ${anchor} ${movement}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const zhAnchor = '身份：旅人甲，蓝色外套。';
const enAnchor = 'Identity: 旅人甲, blue coat.';
const makeEnvelope = (speaking: boolean, broken = false) => {
  const anchor = `身份：旅人甲${speaking ? ' (S1)' : ''}，蓝色外套。`;
  return JSON.stringify({ h3Prompt: prompt(anchor), identityBindings: bindings(anchor, speaking), shotSourceIds: [['shot-1']],
    shotMetadata: [{ ...meta, ...(broken ? { sourceLocationStatus: 'located' } : {}) }] });
};
await test('invalid draft voice tokens never become confirmed mappings; declared known people cannot disappear', () => {
  const characters = [{ id: 'traveler-1', name: '旅人甲' }];
  const reader = createH3IdentityDeliveryReader(undefined, characters);
  assert.throws(() => reader(makeEnvelope(true, true)), /sourceStart/u);
  assert.ok(reader(makeEnvelope(false)).identityBindings);
  assert.throws(() => reader(JSON.stringify({ h3Prompt: prompt(zhAnchor) })), /遗漏绑定/u);
  assert.throws(() => reader(JSON.stringify({ h3Prompt: prompt(zhAnchor), identityBindings: { version: 1, characters: [] } })), /清空|遗漏/u);
  const locked = createH3IdentityDeliveryReader(bindings('身份：旅人甲 (S1)，蓝色外套。', true), characters);
  let error: unknown;
  try { locked(makeEnvelope(false)); } catch (failure) { error = failure; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /声源编号/u);
  assert.match(formatUserFacingError(error), /声源编号/u);
  assert.doesNotMatch(formatUserFacingError(error), /服务返回了未识别/u);
  assert.deepEqual(planH3MetadataRepair(makeEnvelope(false), error)?.fields, ['identityBindings']);
  const unknown = makeEnvelope(false).replaceAll('traveler-1', 'unknown-id');
  const unknownReader = createH3IdentityDeliveryReader(undefined, characters);
  assert.throws(() => unknownReader(unknown));
  assert.ok(unknownReader(makeEnvelope(false)).identityBindings);
});

await test('a valid English body missing its binding is repaired using metadata only', async () => {
  const english = prompt(enAnchor, 'The traveler looks at the map.');
  let requests = 0; let received: H3IdentityBindings | undefined;
  const translated = await translateVideoPromptToEnglish({ sourcePrompt: prompt(zhAnchor), identityBindings: bindings(zhAnchor),
    clean: (value) => value, onIdentityBindings: (value) => { received = value; },
    request: async (system, user) => {
      requests++;
      if (requests === 1) {
        assert.match(system, /本次外层交付仅返回JSON对象/u);
        assert.doesNotMatch(system, /只返回描述为英文/u);
        return english;
      }
      assert.match(system, /metadataPatch/u);
      const data = JSON.parse(user.match(/<h3_metadata_repair_data>\s*([\s\S]*?)\s*<\/h3_metadata_repair_data>/u)![1]);
      assert.equal(data.lockedDelivery.h3Prompt, english);
      assert.deepEqual(data.repairFields, ['identityBindings']);
      assert.equal(data.sourcePrompt, prompt(zhAnchor));
      return JSON.stringify({ metadataPatch: { identityBindings: bindings(enAnchor) } });
    } });
  assert.equal(requests, 2); assert.equal(translated, english); assert.deepEqual(received, bindings(enAnchor));
  const reader = createH3IdentityDeliveryReader(bindings(zhAnchor));
  let issue: unknown; try { reader(english); } catch (error) { issue = error; }
  const plan = planH3MetadataRepair(english, issue)!;
  assert.throws(() => applyH3MetadataRepair(plan, JSON.stringify({ h3Prompt: `${english} edited`, identityBindings: bindings(enAnchor) })), /逐字保持/u);
  assert.equal(readH3DeliveryEnvelope(applyH3MetadataRepair(plan, JSON.stringify({ metadataPatch: { identityBindings: bindings(enAnchor) } }))).h3Prompt, english);
});

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'synthetic-key', model: 'fixture-model', temperature: 0, maxTokens: 8192, vision: false };
const oldWindow = globalThis.window; const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No real network allowed in this regression'); };
try {
  await test('real storyboard pipeline repairs only missing action and stops after three failed patches', async () => {
    for (const scenario of ['array', 'missing', 'invalid-patch'] as const) {
      let requests = 0;
      const broken = delivery({ ...sample, action: scenario === 'array' ? ['抬手指向地图', '放下手'] : undefined });
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
        request: async (payload: { body?: string }) => {
          requests++;
          const body = JSON.parse(payload.body!);
          let response: unknown = broken;
          if (requests > 2) {
            const user = body.messages.find((item: { role: string }) => item.role === 'user').content as string;
            const data = JSON.parse(user.match(/<storyboard_field_repair_data>\s*([\s\S]*?)\s*<\/storyboard_field_repair_data>/u)![1]);
            assert.deepEqual(data.lockedDelivery, JSON.parse(JSON.stringify(broken)));
            assert.equal(data.sourceStory, sample.sourceExcerpt);
            assert.deepEqual(data.issues.map((issue: { path: string }) => issue.path), ['shots[0].action']);
            response = { shotFieldPatches: [{ shotIndex: 0, fields: { action, ...(scenario === 'invalid-patch' ? { subject: '乙' } : {}) } }] };
          }
          return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }) };
        },
      } } });
      const request = () => requestShotRecommendation(config, { durationSec: 5, story: sample.sourceExcerpt,
        workflow: 'drama', pace: 'normal', requiredShotCount: 1 }, { reviewWithAi: true });
      if (scenario === 'invalid-patch') {
        await assert.rejects(request, /自动修复 3 次.*上次字段修复未采纳/u);
        assert.equal(requests, 5);
      } else {
        const result = await request();
        assert.equal(result.shots[0].action, action); assert.equal(result.shots[0].camera, sample.camera);
        assert.equal(requests, scenario === 'array' ? 2 : 3);
      }
    }
  });
} finally {
  globalThis.fetch = oldFetch;
  if (oldWindow === undefined) delete (globalThis as unknown as Record<string, unknown>).window;
  else globalThis.window = oldWindow;
}
console.log(`Prompt delivery recovery: ${count} offline groups passed`);
