import assert from 'node:assert/strict';
import { getPromptDialogues, isDialogueLanguagePreserved } from '../src/promptDialogueLanguage';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';

const militaryLine = '……风暴兵团正在遭受浪潮的攻击，我们的泉水老兄被黏菌的子实体堵在了墙角！';
const lastLine = '全速前进！';
const source = [
  'integrated_multimodal_description:',
  `[Shot 1] @边缘划水（沉着）举起军用对讲机；声音：动作层-[第1.3s起边缘划水原对白：“${militaryLine}”]；镜头：近景。`,
  `[Shot 2] At 00:04.000, 车队开始前进；台词：第1s原对白：“${lastLine}”；镜头：中景。`,
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const translateDescriptions = (text: string): string => text
  .replace(/第\s*(\d+(?:\.\d+)?)\s*(?:s|秒)(?:起)?/gu, 'at $1s ')
  .replaceAll('不要英文对白', 'no English dialogue')
  .replaceAll('原对白', 'original dialogue in Mandarin Chinese')
  .replaceAll('用英语说', 'says in English')
  .replaceAll('英文对白', 'dialogue in English')
  .replaceAll('立即前进！', 'Advance immediately!')
  .replaceAll('前进！', 'Advance!')
  .replaceAll('禁止通行', 'No entry')
  .replace(/[\p{Script=Han}]+/gu, 'visual detail')
  .replaceAll('；', '; ')
  .replaceAll('：', ': ')
  .replaceAll('。', '.');
const translate = (sourcePrompt: string, request: (system: string, user: string) => Promise<string>) => translateVideoPromptToEnglish({
  sourcePrompt, request, clean: (value) => value.trim(),
});

assert.equal(getPromptDialogues(source).length, 2);
assert.equal(getPromptDialogues(source)[0].speaker, '边缘划水');
assert.equal(getPromptDialogues(source)[1].speaker, '', 'a bare 原对白 label is not a speaker named 原');
let calls = 0;
const english = await translate(source, async (system, user) => {
  calls += 1;
  assert.match(system, /对白.*原语言/u);
  assert.doesNotMatch(system, /中文台词翻译为自然英文对白/u);
  assert.doesNotMatch(user, /风暴兵团|全速前进|边缘划水/u, 'utterances and both @ and bare speaker forms must be opaque before the API');
  assert.match(user, /__LH_DIALOGUE_001__/u);
  assert.match(user, /__LH_DIALOGUE_002__/u);
  return translateDescriptions(user);
});
assert.equal(calls, 1);
assert.ok(english.includes(militaryLine));
assert.ok(english.includes(lastLine));
assert.ok(english.includes('边缘划水'));
assert.match(english, /at 1\.3s/u);
assert.doesNotMatch(english, /__LH_|Edge Drifter/u);
assert.equal(isDialogueLanguagePreserved(source, english), true);

assert.equal(await translate(source, async () => english), english, 'original labels and original-language quotes may be returned directly');
const mixed = english.replace(`“${militaryLine}”`, '__LH_DIALOGUE_001__')
  .replace('[Shot 2]', '__LH_H3_TAG_002__');
assert.equal(await translate(source, async () => mixed), english, 'raw official tags and dialogue/token mixtures use the same full-prompt dictionary');

for (const corrupt of [
  english.replace(militaryLine, 'The Storm Corps is under attack!'),
  english.replace(militaryLine, lastLine).replace(`“${lastLine}”`, `“${militaryLine}”`),
  english.replace(`“${lastLine}”`, ''),
  english.replaceAll('边缘划水', 'Edge Drifter'),
]) {
  // The reorder case is constructed explicitly below; an accidental no-op
  // replacement must not be counted as a negative fixture.
  if (corrupt === english) continue;
  assert.equal(isDialogueLanguagePreserved(source, corrupt), false);
  await assert.rejects(translate(source, async () => corrupt), /对白|主体|说话人/u);
}
for (const readableVariant of [
  english.replace('at 1.3s', 'at 1.4s'),
  english.replace('in Mandarin Chinese', 'in English'),
]) {
  assert.equal(isDialogueLanguagePreserved(source, readableVariant), false,
    'the standalone diagnostic can report wording differences without blocking translation');
  assert.equal(await translate(source, async () => readableVariant), readableVariant,
    'readable timing/language prose remains model-owned; it is not an internal token or official cut failure');
}
const reordered = english.replace(militaryLine, '__FIRST__').replace(lastLine, militaryLine).replace('__FIRST__', lastLine);
assert.equal(isDialogueLanguagePreserved(source, reordered), false);
await assert.rejects(translate(source, async () => reordered), /对白/u);
assert.equal(await translate(source, async () => `${english}\n额外的中文画面描述。`), `${english}\n额外的中文画面描述。`,
  'a local Han-character detector must not discard an otherwise structurally valid AI response');
await assert.rejects(translate(source, async () => english.replace('[Shot 2]', '')), /官方标签/u);

const speechSource = (prefix: string, line = '前进！'): string => [
  'integrated_multimodal_description:',
  `[Shot 1] ${prefix}“${line}”`,
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');

for (const prefix of [
  '台词：@边缘划水说：',
  '不要英文对白，台词：@边缘划水说：',
  '用英文写提示词；台词：@边缘划水说：',
  '@边缘划水在学英语，原对白：',
  '原对白：',
]) {
  const prompt = speechSource(prefix);
  assert.equal(getPromptDialogues(prompt)[0]?.translateToEnglish, false, prefix);
  const preserved = await translate(prompt, async (_system, user) => {
    assert.match(user, /__LH_DIALOGUE_001__/u, prefix);
    return translateDescriptions(user);
  });
  assert.ok(preserved.includes('前进！'));
  assert.equal(isDialogueLanguagePreserved(prompt, preserved), true, prefix);
}

for (const prefix of ['台词：第1.3s @边缘划水用英语说：', '英文对白：', '用英语说：']) {
  const prompt = speechSource(prefix, '立即前进！');
  assert.equal(getPromptDialogues(prompt)[0]?.translateToEnglish, true, prefix);
  const translated = await translate(prompt, async (_system, user) => {
    assert.doesNotMatch(user, /__LH_DIALOGUE_/u);
    return translateDescriptions(user);
  });
  assert.match(translated, /Advance immediately!/u);
  assert.equal(isDialogueLanguagePreserved(prompt, translated), true);
  assert.equal(isDialogueLanguagePreserved(prompt, translated.replace('Advance immediately!', '立即前进！')), false);
}

const perLineException = [
  'integrated_multimodal_description:',
  '[Shot 1] 台词：@边缘划水用英语说：“前进！”',
  '[Shot 2] At 00:03.000, 台词：@边缘划水说：“前进！”',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const perLineEnglish = await translate(perLineException, async (_system, user) => translateDescriptions(user));
assert.match(perLineEnglish, /\[Shot 1\][^\n]*“Advance!”/u);
assert.match(perLineEnglish, /\[Shot 2\][^\n]*“前进！”/u, 'one English request must not translate another occurrence of the same dialogue');

for (const original of ['Hold position!', '前進してください！', 'Продолжайте!']) {
  const prompt = speechSource('台词：', original);
  const preserved = await translate(prompt, async (_system, user) => translateDescriptions(user));
  assert.ok(preserved.includes(original), 'existing English and other original languages stay byte-for-byte');
  assert.equal(isDialogueLanguagePreserved(prompt, preserved), true);
}

const signSource = [
  'integrated_multimodal_description:',
  '[Shot 1] 标牌上写着“禁止通行”；台词：无。',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
assert.equal(getPromptDialogues(signSource).length, 0);
const translatedSign = await translate(signSource, async (_system, user) => {
  assert.doesNotMatch(user, /__LH_DIALOGUE_/u);
  return translateDescriptions(user);
});
assert.match(translatedSign, /“No entry”/u);
assert.equal(await translate(signSource, async () => translatedSign.replace('No entry', '禁止通行')), translatedSign.replace('No entry', '禁止通行'),
  'the model can retain readable source-language sign text without a local semantic gate');

for (const cancelBefore of [true, false]) {
  let current = !cancelBefore;
  let requestCalls = 0;
  await assert.rejects(translateVideoPromptToEnglish({
    sourcePrompt: source, clean: (value) => value.trim(), isCurrent: () => current,
    request: async (_system, user) => { requestCalls += 1; current = false; return translateDescriptions(user); },
  }), { name: 'AbortError' });
  assert.equal(requestCalls, cancelBefore ? 0 : 1);
}
const singleQuoteSpeech = '[Shot 1] 主体：@边缘划水；声音：第1.3s边缘划水原对白：‘前进！’';
assert.equal(getPromptDialogues(singleQuoteSpeech).length, 1);
assert.equal(isDialogueLanguagePreserved(singleQuoteSpeech, '[Shot 1] Subject: @边缘划水; Sound: at 1.3s 边缘划水 original dialogue: ‘前进！’'), true);
assert.equal(isDialogueLanguagePreserved(singleQuoteSpeech, '[Shot 1] Subject: @边缘划水; Sound: at 1.3s 边缘划水 original dialogue: ‘Advance!’'), false);
assert.equal(isDialogueLanguagePreserved(singleQuoteSpeech, '[Shot 1] Subject: @边缘划水; at 1.3s caption for 边缘划水: ‘前进！’'), false, 'spoken words cannot silently become an on-screen caption');
console.log('prompt dialogue-language focused checks passed');
