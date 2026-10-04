import assert from 'node:assert/strict';
import {
  compareOptimizationDialogue,
  extractOptimizationDialogueLines,
  type OptimizationDialogueLine,
} from '../src/storyOptimizationDialogue';

let checks = 0;
const extract = (text: string, dialogueField = false) => {
  const lines = extractOptimizationDialogueLines(text, { dialogueField });
  for (const line of lines) {
    assert.equal(text.slice(line.start, line.end), line.utterance, 'spans reference the exact original caller string');
    assert.ok(line.start >= 0 && line.end > line.start && line.end <= text.length);
  }
  return lines;
};
const brief = (lines: OptimizationDialogueLine[]) => lines.map(({ utterance, speaker }) => ({ utterance, speaker }));
const preserves = (source: string, candidate: string): void => {
  assert.deepEqual(compareOptimizationDialogue(extract(source), extract(candidate, true)), [], `${source} → ${candidate}`);
  checks += 1;
};
const rejects = (source: string, candidate: string, kind: string): void => {
  assert.ok(compareOptimizationDialogue(extract(source), extract(candidate, true)).some((item) => item.kind === kind), `${source} → ${candidate} must reject ${kind}`);
  checks += 1;
};

for (const [source, candidate] of [
  ['我应道：“行！”', '我：“行！”'],
  ['“行！”我应得干脆。', '我：“行！”'],
  ['祈凌霜挑眉问：“你去哪？”', '祈凌霜：“你去哪？”'],
  ['祈凌霜愣了一下才说：“行！”', '祈凌霜：“行！”'],
  ['她忽然问：“你去哪？”', '她：“你去哪？”'],
  ['祈凌霜说：“你去哪？”', '祈凌霜（轻声）：“你去哪？”'],
  ['祈凌霜（低声）说：“你去哪？”', '祈凌霜：“你去哪？”'],
  ['祈凌霜用轻柔的声音说：“你去哪？”', '祈凌霜：“你去哪？”'],
  ['我对师傅说：“行！”', '我：“行！”'],
  ['祈凌霜对叶清菱说：“行！”', '祈凌霜：“行！”'],
  ['祈凌霜向叶清菱说：“行！”', '祈凌霜：“行！”'],
  ['李朝阳说：“行！”', '李朝阳：“行！”'],
  ['祂用和蔼的声音回答道：“不必惊慌。”', '母巢：“不必惊慌。”'],
  ['祈凌霜说：“你去哪？等我一起。”', '祈凌霜：“你去哪？\n等我一起。”'],
  ['祈凌霜说：“你好！”', '祈凌霜：「你好!」'],
  ['祈凌霜说：‘你好！’', '祈凌霜：“你好！”'],
  ["祈凌霜说'你好！'", '祈凌霜：“你好！”'],
  ['祈凌霜说：“先等我”', '祈凌霜：先等我'],
  ['祈凌霜说：“你别急。我很快回来。”', '祈凌霜：你别急。我很快回来。'],
  ['总指挥命令：开火！', '总指挥：开火！'],
  ['林澜：任务：保护你。', '林澜：“任务：保护你。”'],
  ['007说：“30分钟后出发。”', '007：30分钟后出发。'],
  ['10说：“30分钟后出发。”', '10：30分钟后出发。'],
  ['“你去哪？”祈凌霜问。', '祈凌霜：“你去哪？”'],
  ['祈凌霜说：“回来！”\n叶清菱说：“好的。”', '祈凌霜：“回来！”叶清菱：“好的。”'],
  ['祈凌霜说：“回来！”\n叶清菱说：“好的。”', '祈凌霜：“回来！”\n叶清菱说道：“好的。”'],
  ['祈凌霜说：“回来！”叶清菱说：“好的。”', '祈凌霜：回来！叶清菱：好的。'],
  ['祈凌霜说：“回来”叶清菱说：“好的”', '祈凌霜：回来 叶清菱：好的'],
  ['祈凌霜说：“我听见他喊“救命”，你呢？”', '祈凌霜：“我听见他喊‘救命’，你呢？”'],
  ['祈凌霜说：“I\'m here, now here!”', '祈凌霜：“I\'m here,\r\nnow here!”'],
  ['祈凌霜说：“Don’t move.”', '祈凌霜：“Don\'t move.”'],
  ['祈凌霜说：“……回来。”', '祈凌霜：“...回来。”'],
  ['祈凌霜说：“回来……等一下。”', '祈凌霜：“回来......等一下。”'],
  ['祈凌霜说：“...回来。”', '祈凌霜：“……回来。”'],
]) preserves(source, candidate);

const longSpeech = `这是长对白。${'请保持原文不变。'.repeat(80)}`;
preserves(`祈凌霜说：“${longSpeech}”`, `祈凌霜：“${longSpeech}”`);
assert.deepEqual(brief(extract(`祈凌霜说：“${longSpeech}”`)), [{ speaker: '祈凌霜', utterance: longSpeech }]);
checks += 1;

const visibleSource = '祈凌霜咬了一口灵桃，汁水沾在唇上，亮晶晶的。她抬头看我，忽然凑近，用只有我们三人能听见的声音说：“下次出门，我还要走你左边。”\n“行，左边归你，右边归师傅。”我应得干脆。';
preserves(visibleSource, '祈凌霜：“下次出门，我还要走你左边。”\n我：“行，左边归你，右边归师傅。”');
assert.deepEqual(brief(extract(visibleSource)), [
  { utterance: '下次出门，我还要走你左边。', speaker: '' },
  { utterance: '行，左边归你，右边归师傅。', speaker: '' },
]);
checks += 1;

for (const text of [
  '祈凌霜看到标牌上写着“禁止通行！”，便停下。',
  '屏幕显示：“准备完成！”',
  '他拿起题为《旧事》的书，书名旁写着“新编版。”',
  '祈凌霜拿着“灵桃”走过来。',
  '指挥部没有要求回援，也没有让他们继续支援，而是直接改了任务：在地精兵团的支援下，对浪潮指挥部发起袭击。',
  '而是直接改了任务：在地精兵团的支援下，对浪潮指挥部发起袭击。',
  '车队接到一条命令：转向北二环线。',
  '接着调整了行动计划：前往北二环线。',
  '10:30开始集合，林澜走进车站。',
  '7:05集合。23：59.林澜进入车站。',
]) {
  assert.deepEqual(extract(text), [], 'known written/title quotations are not direct speech');
  checks += 1;
}
assert.deepEqual(brief(extract('祈凌霜说：“屏幕显示准备完成！”')), [{ speaker: '祈凌霜', utterance: '屏幕显示准备完成！' }]);
checks += 1;
assert.deepEqual(brief(extract('祈凌霜：他说“你好。”', true)), [{ speaker: '祈凌霜', utterance: '他说“你好。”' }], 'inner quotations in bare dialogue are not duplicate turns');
checks += 1;
assert.deepEqual(brief(extract('James\' map放在桌上。祈凌霜说：“别动它。”')), [{ speaker: '祈凌霜', utterance: '别动它。' }], 'a possessive apostrophe must not swallow later dialogue');
checks += 1;
assert.deepEqual(brief(extract('“回来！”\n叶清菱回答。')), [{ speaker: '', utterance: '回来！' }], 'a new paragraph is not the previous quotation\'s attribution');
checks += 1;
assert.deepEqual(brief(extract('“回来！”叶清菱说：“好的。”')), [{ speaker: '', utterance: '回来！' }, { speaker: '叶清菱', utterance: '好的。' }], 'the next explicit turn is not a postfix attribution');
checks += 1;
assert.deepEqual(brief(extract('10:30：“开始集合。”')), [{ speaker: '', utterance: '开始集合。' }], 'a time before quoted text must not lock the minute value as a speaker');
checks += 1;
assert.deepEqual(brief(extract('10:30开始集合，林澜说：“到了。”')), [{ speaker: '林澜', utterance: '到了。' }], 'time narration must not consume a later actual utterance');
checks += 1;
assert.deepEqual(brief(extract('007：30分钟后出发。')), [{ speaker: '007', utterance: '30分钟后出发。' }], 'three-digit explicit character codes are not time labels');
checks += 1;

for (const [source, candidate, kind] of [
  ['祈凌霜说：“你去哪？”', '祈凌霜：“你要去哪？”', 'text'],
  ['祈凌霜说：“你去哪？”', '祈凌霜：“你去哪。”', 'text'],
  ['祈凌霜说：“行，左边归你。”', '祈凌霜：“行、左边归你。”', 'text'],
  ['祈凌霜说：“你去哪？等我一起。”', '祈凌霜：“你去哪？”', 'text'],
  ['祈凌霜说：“你去哪？”', '叶清菱：“你去哪？”', 'speaker'],
  ['祈凌霜挑眉问：“你去哪？”', '叶清菱：“你去哪？”', 'speaker'],
  ['祈凌霜对叶清菱说：“你去哪？”', '叶清菱：“你去哪？”', 'speaker'],
  ['“你去哪？”祈凌霜问。', '叶清菱：“你去哪？”', 'speaker'],
  ['祈凌霜说：“你去哪？”', '她：“你去哪？”', 'speaker'],
  ['祈凌霜说：“回来！”叶清菱说：“好的。”', '祈凌霜：“回来！”\n我：“好的。”', 'speaker'],
  ['祈凌霜说：“回来！”叶清菱说：“好的。”', '叶清菱：“好的。”\n祈凌霜：“回来！”', 'text'],
  ['祈凌霜说：“回来！”叶清菱说：“好的。”', '祈凌霜：“回来！”', 'missing'],
  ['祈凌霜说：“回来！”', '祈凌霜：“回来！”叶清菱：“好的。”', 'extra'],
  ['祈凌霜说：“now here”', '祈凌霜：“nowhere”', 'text'],
  ['祈凌霜说：“Wait!!”', '祈凌霜：“Wait!”', 'text'],
  ['祈凌霜说：“等一下……”', '祈凌霜：“等一下.”', 'text'],
  ['祈凌霜说：“等一下……”', '祈凌霜：“等一下..”', 'text'],
  ['祈凌霜说：“等一下……”', '祈凌霜：“等一下....”', 'text'],
  ['祈凌霜说：“等一下……”', '祈凌霜：“等一下….”', 'text'],
  ['祈凌霜说：“等一下……”', '祈凌霜：“等一下.........”', 'text'],
  ['祈凌霜说：“Don\'t move.”', '祈凌霜：“Dont move.”', 'text'],
  ['祈凌霜说：“Don\'t move.”', '祈凌霜：“Don”t move.”', 'text'],
  ['祈凌霜说：“我听见他喊“救命”，你呢？”', '祈凌霜：“我听见他喊‘救命’，他呢？”', 'text'],
]) rejects(source, candidate, kind);

const mismatch = compareOptimizationDialogue(extract('祈凌霜说：“回来！”叶清菱说：“好的。”'), extract('祈凌霜：“回来！”', true));
assert.deepEqual(mismatch, [{ index: 2, kind: 'missing', expected: { utterance: '好的。', speaker: '叶清菱' } }]);
checks += 1;
for (const speaker of ['彼得', '张得志', '袁了凡']) {
  assert.deepEqual(brief(extract(`${speaker}说：“守信。”`)), [{ speaker, utterance: '守信。' }], 'characters in a real name are not narrative stop words');
  assert.deepEqual(brief(extract(`${speaker}：守信。`)), [{ speaker, utterance: '守信。' }]);
  rejects(`${speaker}说：“守信。”`, '李云：“守信。”', 'speaker');
  checks += 2;
}
console.log(`storyOptimizationDialogue: ${checks} checks passed`);
