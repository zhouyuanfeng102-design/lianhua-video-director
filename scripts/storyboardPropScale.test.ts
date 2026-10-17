import assert from 'node:assert/strict';
import {
  assertValidFinalImagePrompt, buildImagePromptConverterSystemPrompt,
  IMAGE_PROMPT_PROP_SCALE_CONTRACT, resolveImagePromptSelection, stripImagePromptNarrativeContracts,
  type ImagePromptAssetKind, type ImagePromptFormat,
} from '../src/imagePromptRules';
import { requestImagePromptConverter } from '../src/services/llm';
import { buildStoryboardImageRequests } from '../src/storyboardImages';
import {
  buildStoryboardImagePromptWithReferences, refreshStoryboardImageReferenceMetadata,
  stripStoryboardImageReferenceMetadata, STORYBOARD_PROP_REFERENCE_SCALE_BOUNDARY,
} from '../src/storyboardImageReferences';
import type { ImageVariant, Prop, ReferenceAsset, Storyboard, TextApiConfig, VideoShot } from '../src/types';

// Development-only contract and transport checks. Synthetic model replies do
// not establish that a real model retained scale or that an image is correct.
const count = (value: string, part: string): number => value.split(part).length - 1;
const formats: ImagePromptFormat[] = ['natural-language', 'sd-tags', 'nai-tags'];
const routes: { kind: ImagePromptAssetKind; variant?: ImageVariant; narrative: boolean }[] = [
  { kind: 'storyboard', narrative: true },
  { kind: 'storyboard', variant: 'storyboard-frame', narrative: true },
  { kind: 'storyboard', variant: 'first-frame', narrative: true },
  { kind: 'storyboard', variant: 'last-frame', narrative: true },
  { kind: 'grid', variant: 'grid', narrative: true },
  { kind: 'location', variant: 'snapshot', narrative: true },
  { kind: 'location', variant: 'first-frame', narrative: true },
  { kind: 'location', variant: 'landscape', narrative: false },
  { kind: 'character', variant: 'full-body', narrative: false },
  { kind: 'prop', variant: 'three-view', narrative: false },
];
const custom = '作者自定义：所有既定尺寸保留原单位，保留稀疏笔触。';
for (const route of routes) {
  const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: route.kind, imageVariant: route.variant });
  const before = JSON.stringify(selection);
  for (const format of formats) {
    const rules = buildImagePromptConverterSystemPrompt({ ...selection, ruleSet: { ...selection.ruleSet, format } },
      `${custom}\n${custom}`, route.variant);
    assert.equal(count(rules, IMAGE_PROMPT_PROP_SCALE_CONTRACT), route.narrative ? 1 : 0,
      `${route.kind}/${route.variant || 'default'}/${format} has only its intended scale contract`);
    assert.equal(count(rules, custom), 2, 'custom wording is not deduplicated or rewritten');
  }
  assert.equal(JSON.stringify(selection), before, 'request composition does not migrate saved presets');
}
assert.equal(stripImagePromptNarrativeContracts(`${custom}\n${IMAGE_PROMPT_PROP_SCALE_CONTRACT}\n${custom}`, 'storyboard'),
  `${custom}\n\n${custom}`, 'only the exact first-party scale block is removed before recomposition');

const props: Prop[] = [
  { id: 'beta', name: '贝塔魔棒', category: '变身器', material: '金属', appearance: '16cm，细长圆柱形手持装置',
    effect: '发光', stateRules: '正常长度16cm；仅当前剧情明确变大后长80cm。', assetIds: [] },
  { id: 'spear', name: '长枪', category: '武器', material: '木杆与金属枪尖', appearance: '全长2m',
    effect: '', stateRules: '本镜长度保持2m。', assetIds: [] },
];
const shot: VideoShot = {
  id: 'scale-shot', index: 1, startSec: 0, endSec: 10, purpose: '变身器状态变化',
  subject: '青岚握着贝塔魔棒，长枪斜靠在墙边',
  action: '起始贝塔魔棒长16cm；后半段魔棒明确变大到80cm，长枪始终长2m。',
  camera: '固定侧面中景', lighting: '窗边自然光', sound: '', result: '青岚握着变大后的80cm贝塔魔棒。',
  referenceAssetIds: [], prompt: '', transition: '', locked: false,
};
const board: Storyboard = {
  id: 'scale-board', sceneId: 'scale-scene', workflow: 'drama', inputMode: 'text', durationSec: 10,
  durationPreset: 'custom', shotMode: 'exact', pace: 'standard', aspectRatio: '16:9', resolution: '2K',
  audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  shots: [shot], finalPrompt: '', createdAt: 1, updatedAt: 1,
};
const context = { characters: [], locations: [], props, scenes: [], assets: [] };
const originalInputs = JSON.stringify({ board, context });
const [ordinary] = buildStoryboardImageRequests(board, 'storyboard-shots', context);
const [first, last] = buildStoryboardImageRequests(board, 'boundary-frames', context);
for (const request of [ordinary, first, last]) {
  for (const prop of props) assert.ok(request.conversionSource.includes(prop.appearance),
    `${request.purpose} preserves ${prop.name}'s exact dimensions and units in converter evidence`);
  assert.ok(request.conversionSource.includes(props[0].stateRules), 'default size and explicit state change stay available to the AI');
}
assert.match(first.conversionSource, /第一镜开始边界的入口状态/u);
assert.match(last.conversionSource, /最后一镜动作完成后的最终状态/u);
assert.ok(last.conversionSource.includes(shot.result));
assert.equal(JSON.stringify({ board, context }), originalInputs, 'frame construction does not change the source facts');

const knownReplies: Record<ImagePromptFormat, string> = {
  'natural-language': '侧面中景，青岚手握16cm长的贝塔魔棒，2m长的长枪斜靠在墙边。',
  'sd-tags': 'side view, Qing holding a 16cm Beta Capsule, 2m spear leaning against wall',
  'nai-tags': 'side view, 2m spear leaning against wall | Qing, holding a 16cm Beta Capsule',
};
for (const format of formats) assert.equal(assertValidFinalImagePrompt(knownReplies[format], format), knownReplies[format],
  'ordinary protocol cleaning retains numeric prop dimensions and their units');

const reference = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'composition', tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const boundProp = reference('beta-reference', { role: 'prop', referenceEntityBinding: { kind: 'prop', entityId: 'beta' } });
const metadataBody = knownReplies['natural-language'];
const referenceCases: { reference: ReferenceAsset; expected: boolean }[] = [
  { reference: boundProp, expected: true },
  { reference: reference('legacy-prop', { role: 'prop', sourceEntityKind: 'prop', sourceEntityId: 'beta' }), expected: true },
  { reference: { ...boundProp, referenceEntityBinding: null }, expected: false },
  { reference: { ...boundProp, referenceEntityBinding: { kind: 'prop', entityId: 'missing' } }, expected: false },
  { reference: reference('legacy-cleared', { role: 'prop', characterReferenceId: null }), expected: false },
  { reference: reference('legacy-stale', { role: 'prop', characterReferenceId: 'missing' }), expected: false },
  { reference: reference('composition'), expected: false },
];
for (const fixture of referenceCases) {
  const prompt = buildStoryboardImagePromptWithReferences(metadataBody, [fixture.reference], { props });
  assert.equal(count(prompt, STORYBOARD_PROP_REFERENCE_SCALE_BOUNDARY), fixture.expected ? 1 : 0,
    `${fixture.reference.id} receives only the boundary appropriate to its current binding`);
  assert.equal(stripStoryboardImageReferenceMetadata(prompt), metadataBody, 'reference mapping does not rewrite scale prose');
}
const firstReference = reference('same-batch-first', { role: 'first-frame' });
const referenceContext = { props, continuityAssetId: firstReference.id };
const continuityOnly = buildStoryboardImagePromptWithReferences(metadataBody, [firstReference], referenceContext);
assert.equal(count(continuityOnly, STORYBOARD_PROP_REFERENCE_SCALE_BOUNDARY), 0);
assert.match(continuityOnly, /不覆盖当前明确的道具尺寸/u);
const mixed = buildStoryboardImagePromptWithReferences(metadataBody, [boundProp, firstReference], referenceContext);
assert.equal(count(mixed, STORYBOARD_PROP_REFERENCE_SCALE_BOUNDARY), 1);
assert.equal(buildStoryboardImagePromptWithReferences(mixed, [boundProp, firstReference], referenceContext), mixed,
  'repeated metadata refresh does not duplicate the prop boundary');
assert.equal(stripStoryboardImageReferenceMetadata(mixed), metadataBody);
assert.equal(count(refreshStoryboardImageReferenceMetadata(mixed, [{ ...boundProp, referenceEntityBinding: null }], { props }),
  STORYBOARD_PROP_REFERENCE_SCALE_BOUNDARY), 0, 'clearing a prop binding removes its old scale boundary');

const selection = resolveImagePromptSelection({ backend: 'openai', assetKind: 'storyboard' });
const fixtures: { source: string; reply: string; format: ImagePromptFormat; variant?: ImageVariant; direct?: boolean }[] = [
  ...formats.map((format) => ({ source: ordinary.conversionSource, reply: knownReplies[format], format })),
  { source: first.conversionSource, reply: knownReplies['natural-language'], format: 'natural-language', variant: 'first-frame' },
  { source: last.conversionSource, reply: '侧面中景，青岚手握当前已经变大的80cm贝塔魔棒，2m长枪仍斜靠墙边。',
    format: 'natural-language', variant: 'last-frame' },
  { source: '青岚握着没有已知尺寸的护符，资料没有长度或比例尺。', reply: '侧面中景，青岚握着护符。',
    format: 'natural-language', direct: true },
  // Intentionally missing dimensions: accepted format-valid text demonstrates
  // the absence of a new local semantic veto, rewrite, review or retry.
  { source: ordinary.conversionSource, reply: '侧面中景，青岚举起手中的贝塔魔棒，长枪靠在墙边。', format: 'natural-language' },
];
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://prop-scale.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential', model: 'prop-scale-fixture', temperature: 0, maxTokens: 4096, vision: false,
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let current = 0;
let calls = 0;
let networkAttempts = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    calls += 1;
    const body = JSON.parse(payload.body || '{}');
    const system = body.messages.find((message: { role: string }) => message.role === 'system').content as string;
    const user = body.messages.find((message: { role: string }) => message.role === 'user').content as string;
    assert.equal(count(system, IMAGE_PROMPT_PROP_SCALE_CONTRACT), 1, 'final converter request carries one current scale contract');
    assert.ok(user.includes(JSON.stringify(fixtures[current].source)), 'the actual converter request preserves complete source facts');
    assert.equal(count(system, custom), 2, 'frozen custom text reaches the model unchanged');
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: fixtures[current].reply } }] }) };
  } },
} });
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Live network forbidden'); };
try {
  for (current = 0; current < fixtures.length; current += 1) {
    const fixture = fixtures[current];
    const rules = fixture.direct ? `${custom}\n${custom}` : [
      buildImagePromptConverterSystemPrompt({ ...selection, ruleSet: { ...selection.ruleSet, format: fixture.format } },
        `${custom}\n${custom}`, fixture.variant), IMAGE_PROMPT_PROP_SCALE_CONTRACT,
    ].join('\n');
    const frozen = { conversionSource: fixture.source, converterSystemPrompt: rules, prompt: '已保存原提示词' };
    const frozenBefore = JSON.stringify(frozen);
    const callsBefore = calls;
    const output = await requestImagePromptConverter(config, 'storyboard', frozen.conversionSource,
      fixture.format, frozen.converterSystemPrompt, '', fixture.variant);
    assert.equal(output, fixture.reply, 'model-authored size or omitted size passes through without local semantic rewriting');
    assert.equal(calls - callsBefore, 1, 'one existing conversion call, including unknown or omitted dimensions');
    assert.equal(JSON.stringify(frozen), frozenBefore, 'conversion leaves saved source, prompt and rule snapshot intact');
  }
  assert.equal(networkAttempts, 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log('Storyboard prop scale: scope, units, frame-state evidence, reference bindings and single-call mock transport passed. Real AI interpretation and generated image scale were not tested.');
