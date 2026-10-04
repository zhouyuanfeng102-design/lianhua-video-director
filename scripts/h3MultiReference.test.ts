import assert from 'node:assert/strict';
import { compileTargetPrompt, type PromptAdapterInput } from '../src/promptAdapters';

const facts = ['左眉银色细疤与黑色长发', '浅金色瞳孔与白色发带', '深蓝短袍与青铜腰牌'];
const uses = ['图一独有构图：朱红窗棂框住左侧边缘。', '图二独有构图：月光从右上方照亮石阶。'];
const refs = uses.map((responsibility, index) => ({
  id: `picture-${index + 1}`, name: `构图图${index + 1}`, mediaType: 'image', role: 'composition', responsibility,
}));
const input: PromptAdapterInput = {
  canonicalPrompt: [
    '【0s-5s】 主体：@甲；动作：甲推开木门；空间：门廊；光影：左侧月光；镜头：中景；台词：第1s @甲："跟我来。"；音效：环境层-[无] 动作层-[第2s木门轻响] 情绪层-[无配乐]',
    '【5s-10s】 主体：@乙；动作：乙接住甲递来的钥匙；空间：石阶；光影：左侧月光；镜头：近景；台词：无；音效：环境层-[无] 动作层-[第1s钥匙轻碰] 情绪层-[无配乐]',
    '【10s-15s】 主体：@丙；动作：丙回身合上木门；空间：门廊；光影：左侧月光；镜头：中景；台词：无；音效：环境层-[无] 动作层-[第2s门闩合拢] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3',
  references: refs,
  subjectDefinitions: ['甲', '乙', '丙'].map((name, index) => ({
    name, kind: 'character', appearance: facts[index], referenceAssetIds: refs.map((ref) => ref.id),
  })),
};
const before = structuredClone(input);
const compiled = compileTargetPrompt(input);
const definitions = compiled.prompt.split('subject_definitions:')[1].split('summary:')[0];
const retention = compiled.prompt.split('retention_analysis:')[1].split('detailed_description:')[0];
const detailed = compiled.prompt.split('detailed_description:')[1].split('overall_soundscape:')[0];
assert.equal((definitions.match(/^<Subject /gmu) || []).length, 3, 'two pictures must not become two extra identities when their subjects are already bound');
for (const line of definitions.split('\n').filter((line) => line.startsWith('<Subject '))) {
  assert.match(line, /referenced from <Picture 1>、<Picture 2>/u);
}
for (const fact of facts) assert.equal(compiled.prompt.split(fact).length - 1, 1, 'full identity facts belong in one Subject definition only');
for (const use of uses) {
  assert.equal(compiled.prompt.split(use).length - 1, 1, 'each picture-specific use must survive exactly once');
  assert.ok(retention.includes(use), 'picture-specific uses must stay with their reference, not with a character or shot action');
  assert.equal(detailed.includes(use), false);
}
assert.equal((detailed.match(/\[Shot \d+\]/gu) || []).length, 3);
for (const fact of ['推开木门', '递来的钥匙', '回身合上木门', '跟我来。', 'At 00:05.000', 'At 00:10.000']) assert.ok(detailed.includes(fact));
assert.deepEqual(input, before);
assert.deepEqual(compiled.referenceManifest.assets.map((asset) => asset.id), refs.map((ref) => ref.id));
assert.deepEqual(compiled.parameters, compileTargetPrompt({ ...input, references: refs.slice(0, 1) }).parameters);

const unmapped = compileTargetPrompt({ ...input, subjectDefinitions: [] });
assert.equal((unmapped.prompt.split('summary:')[0].match(/^<Subject /gmu) || []).length, 2, 'unidentified images must retain their own safe fallback definitions');
for (const use of uses) assert.equal(unmapped.prompt.split(use).length - 1, 1, 'fallback reference content must not be copied into the shot again');
const singleUnknown = compileTargetPrompt({ ...input, references: [...refs, { id: 'unknown', name: '未关联参考', mediaType: 'image', role: 'composition', responsibility: '独有未知姿态：背对镜头，左手持伞。' }] });
assert.equal((singleUnknown.prompt.split('summary:')[0].match(/^<Subject /gmu) || []).length, 4);
assert.equal(singleUnknown.prompt.split('独有未知姿态：背对镜头，左手持伞。').length - 1, 1);

const keyframe = compileTargetPrompt({ ...input, references: [{ ...refs[0], role: 'first-frame' }] });
assert.ok(keyframe.prompt.startsWith('For the target video'));
assert.doesNotMatch(keyframe.prompt, /subject_definitions:|<Subject /u);
assert.match(keyframe.prompt, /图一独有构图/u, 'keyframe mode must retain its reference context without a full-reference wrapper');

console.log('H3 shared multi-reference rendering checks passed');
