import assert from 'node:assert/strict';
import { extractSourceDialogues, renderShotPrompt, validateStoryboardPrompt } from '../src/promptEngine';
import { defaultRuleSets } from '../src/storage';
import type { VideoShot } from '../src/types';

const rule = defaultRuleSets.find((item) => item.mode === 'timeline')!;
const source = [
  '【场景1：客栈】',
  '出场人物：李云、阿青',
  '剧情：李云停步，木牌写着“禁止进入”。',
  '对白：',
  '李云：“先走。”',
  '阿青：不要丢下我。',
  '李云：“我  会回来。”',
  '任务：找到出口。',
  '背景信息：城门将在天亮时关闭。',
].join('\n');
const lines = extractSourceDialogues(source);
assert.deepEqual(lines.map(({ text, speakerCandidate }) => ({ text, speakerCandidate })), [
  { text: '先走。', speakerCandidate: '李云' },
  { text: '不要丢下我。', speakerCandidate: '阿青' },
  { text: '我  会回来。', speakerCandidate: '李云' },
]);
for (const line of lines) {
  assert.ok(source.slice(line.sourceStart, line.sourceEnd).includes(line.text));
}
assert.deepEqual(extractSourceDialogues('李云说道：“回头。”“回头。”阿青说道：“回头。”').map((line) => [line.text, line.speakerCandidate]), [
  ['回头。', '李云'], ['回头。', '李云'], ['回头。', '阿青'],
]);

const longLine = '……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！';
const shot: VideoShot = {
  id: 'preserve-draft-dialogue', index: 1, startSec: 0, endSec: 1.2,
  purpose: '交代警报', subject: '李云',
  action: `李云抬头，李云喊道：“${longLine}”“回头。”阿青问道：“你说什么？”`,
  camera: '中景', lighting: '4500K左侧光', transition: '', result: '阿青望向出口',
  sound: '', referenceAssetIds: [], prompt: '', locked: false,
};
const prompt = renderShotPrompt(shot, 1.2, [], [shot], 'stereo', rule);
const dialogue = prompt.match(/；台词：(.+?)；音效：/u)?.[1] || '';
assert.ok(dialogue.includes(`@李云："${longLine}"`), 'a draft must not clip long authored dialogue to a fitting clause');
assert.match(dialogue, /@李云："回头。".*@阿青："你说什么？"/u, 'later dialogue must never disappear when earlier speech consumes the rough budget');
const offsets = Array.from(dialogue.matchAll(/第([\d.]+)s/gu), (match) => Number(match[1]));
assert.equal(offsets.length, 3);
assert.ok(offsets.every((offset, index) => offset >= 0 && offset < 1.2 && (!index || offset > offsets[index - 1])));
const report = validateStoryboardPrompt({ durationSec: 1.2, workflow: 'drama', inputMode: 'text', shots: [shot], finalPrompt: prompt, ruleSetId: rule.id }, [], rule);
assert.ok(!report.errors.some((error) => /台词|对白/u.test(error)), report.errors.join('\n'));
assert.equal(report.valid, true, report.errors.join('\n'));
assert.ok(!report.warnings.some((warning) => /语速估算|开口前停顿/u.test(warning)), 'full dialogue remains valid without the retired speaking-rate advisory');

const labeledShot = { ...shot, endSec: 8, action: '李云：“Keep  the door open.”\n阿青：我会等你。' };
const labeledPrompt = renderShotPrompt(labeledShot, 8, [], [labeledShot], 'stereo', rule);
assert.match(labeledPrompt, /@李云："Keep  the door open\."/u);
assert.match(labeledPrompt, /@阿青："我会等你。"/u);
console.log('dialoguePreservationDraft: source extraction and full local-draft dialogue passed');
