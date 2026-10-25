import assert from 'node:assert/strict';
import { MAESTRO_PROTOCOL_MARKER } from '../src/maestroProtocol';
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

const write = framed('story-preparation', adult);
const plain = framed('story-preparation', ordinary);
assert.equal(write.systemLayers[0], plain.systemLayers[0], 'adult and ordinary requests share one system prefix');
assert.ok(write.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER));
assert.equal(write.systemLayers[0].includes(LIANHUA_NSFW_FIXED_PREFIX), false, 'phase-1 skips old NSFW Role prefix');
assert.equal(write.systemLayers[0].includes(LIANHUA_NSFW_CREATIVE_GUIDANCE), false);
assert.ok(write.systemLayers[0].endsWith('原有任务规则'));
assert.equal(write.userPrompt, adult, 'user requirement is not mixed into the fixed prefix');
assert.equal(plain.userPrompt, ordinary);
assert.equal(write.finalInstruction, protocol);

const judge = framed('director-look', adult);
assert.ok(judge.systemLayers[0].startsWith(LIANHUA_NSFW_FIXED_PREFIX));
assert.equal(judge.systemLayers[0].startsWith(MAESTRO_PROTOCOL_MARKER), false);
assert.equal(judge.userPrompt, adult);
assert.equal(judge.userPrompt.includes(LIANHUA_NSFW_CREATIVE_GUIDANCE), false);

const image = framed('image-prompt-convert', adult);
assert.deepEqual(image.systemLayers, ['原有任务规则']);
assert.equal(image.userPrompt, adult);

const unstaged = framed('', adult);
assert.deepEqual(unstaged.systemLayers, ['原有任务规则']);

const layers = framed('convert', adult, ['第一层固定规则', '第二层格式']);
assert.ok(layers.systemLayers[0].startsWith(LIANHUA_NSFW_FIXED_PREFIX));
assert.ok(layers.systemLayers[0].includes(LIANHUA_NSFW_CREATIVE_GUIDANCE));
assert.ok(layers.systemLayers[0].includes('第一层固定规则'));
assert.equal(layers.systemLayers[1], '第二层格式');
assert.equal(layers.systemLayers.length, 2);
assert.equal(layers.userPrompt, adult);

const again = frameNsfwTextRequest({
  stage: 'convert', systemLayers: layers.systemLayers, userPrompt: layers.userPrompt, finalInstruction: protocol,
});
assert.equal(again.systemLayers[0], layers.systemLayers[0]);
assert.equal(again.userPrompt, adult);

assert.doesNotMatch(LIANHUA_NSFW_FIXED_PREFIX + LIANHUA_NSFW_CREATIVE_GUIDANCE, /未成年|未满|名器概率|违法路径|忘记.?AI|只能用中文/u);
console.log('PASS nsfw text framing: phase-1 uses MAESTRO only; other stages keep old NSFW prefix');
