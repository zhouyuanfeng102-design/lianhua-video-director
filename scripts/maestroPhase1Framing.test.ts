import assert from 'node:assert/strict';
import {
  MAESTRO_PHASE1_SYSTEM_PREFIX,
  MAESTRO_PROTOCOL_MARKER,
  prependMaestroPhase1Prefix,
} from '../src/maestroProtocol';
import {
  frameNsfwTextRequest,
  LIANHUA_NSFW_CREATIVE_GUIDANCE,
  LIANHUA_NSFW_FIXED_PREFIX,
} from '../src/nsfwPromptRules';

const adult = '两名恋人在卧室全裸相拥，原文明确进入性行为。';
const ordinary = '林舟推开院门，抬头看见檐下灯笼。';
const protocol = '<output_protocol>只返回约定正文。</output_protocol>';

const framed = (stage: string, user: string, layers = ['原有任务规则']) => frameNsfwTextRequest({
  stage, systemLayers: layers, userPrompt: user, finalInstruction: protocol,
});

const writeAdult = framed('story-preparation', adult);
const writeOrdinary = framed('story-preparation', ordinary);

assert.equal(
  writeAdult.systemLayers[0],
  writeOrdinary.systemLayers[0],
  'phase-1 ordinary/adult must share one fixed system prefix for cache hits',
);
assert.ok(writeAdult.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER));
assert.ok(writeAdult.systemLayers[0].startsWith(MAESTRO_PHASE1_SYSTEM_PREFIX));
assert.equal(writeAdult.systemLayers[0].includes(LIANHUA_NSFW_FIXED_PREFIX), false);
assert.equal(writeAdult.systemLayers[0].includes('莲华叙事编辑'), false);
assert.equal(writeAdult.systemLayers[0].includes(LIANHUA_NSFW_CREATIVE_GUIDANCE), false);
assert.ok(writeAdult.systemLayers[0].endsWith('原有任务规则'));
assert.equal(writeAdult.userPrompt, adult, 'user requirement stays last/outside the fixed prefix');
assert.equal(writeOrdinary.userPrompt, ordinary);

const visual = framed('story-visual-understanding', adult, ['画面转化任务规则']);
assert.ok(visual.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER));
assert.equal(visual.systemLayers[0].includes(LIANHUA_NSFW_FIXED_PREFIX), false);
assert.ok(visual.systemLayers[0].endsWith('画面转化任务规则'));

const custom = framed('image-custom-convert', adult, ['自定义生图转换规则']);
const customOrdinary = framed('image-custom-convert', ordinary, ['自定义生图转换规则']);
assert.equal(custom.systemLayers[0], customOrdinary.systemLayers[0]);
assert.ok(custom.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER));
assert.ok(custom.systemLayers[0].endsWith('自定义生图转换规则'));
assert.equal(custom.userPrompt, adult);
assert.equal(
  custom.systemLayers[0].includes(LIANHUA_NSFW_FIXED_PREFIX),
  false,
  'custom image keeps its own image NSFW rules; do not inject narrative text Role prefix',
);

const again = frameNsfwTextRequest({
  stage: 'story-preparation',
  systemLayers: writeAdult.systemLayers,
  userPrompt: ordinary,
  finalInstruction: protocol,
});
assert.equal(again.systemLayers[0], writeAdult.systemLayers[0], 'framing is idempotent');

const outside = framed('director-look', adult);
assert.ok(outside.systemLayers[0].startsWith(LIANHUA_NSFW_FIXED_PREFIX));
assert.equal(outside.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER), false);
assert.equal(outside.userPrompt, adult);

const once = prependMaestroPhase1Prefix(['task']);
const twice = prependMaestroPhase1Prefix(once);
assert.equal(once[0], twice[0]);

console.log('PASS maestro phase-1 keeps MAESTRO only and skips old NSFW Role');
