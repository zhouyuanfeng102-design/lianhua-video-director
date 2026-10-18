import assert from 'node:assert/strict';
import {
  buildPromptTranslationDocument,
  renderPromptTranslationDocument,
} from '../src/promptTranslationDocument';
import type { H3IdentityBindings, H3PerformancePlan } from '../src/types';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';

const sourceCharacters = [
  { id: 'lin-mu', name: '林沐', aliases: ['师弟'], relationship: '叶清碧的徒弟、祈凌霜的师弟' },
  { id: 'ye-qingbi', name: '叶清碧', aliases: ['师傅'], relationship: '林沐与祈凌霜的师傅' },
  { id: 'qi-lingshuang', name: '祈凌霜', aliases: ['师姐'], relationship: '林沐的师姐、叶清碧的徒弟' },
];
const anchors = [
  '林沐 (S1) 是青年男性人族，黑色长发束起。',
  '叶清碧 (S2) 是25岁女性人族，身着素雅青白长袍。',
  '祈凌霜 (S3) 是19岁女性人族，身着轻便明快长袍。',
];
const identityBindings: H3IdentityBindings = {
  version: 1,
  characters: sourceCharacters.map((character, index) => ({
    characterId: character.id,
    name: character.name,
    speakerToken: `(S${index + 1})`,
    relationship: character.relationship,
    referenceAnchor: anchors[index],
  })),
};
const sourcePrompt = [
  'integrated_multimodal_description:',
  '[Shot 1] 林沐居中，叶清碧在他左侧，祈凌霜在他右侧。',
  ...anchors,
  '1.50—2.55秒，叶清碧 (S2，女性发声身份，自然发声) 收手后面向林沐，轻声提醒：<d>[Chinese] 吃东西时慢一些。</d>',
  '2.75—3.45秒，林沐 (S1，男性发声身份，自然发声) 面向叶清碧致谢：<d>[Chinese] 多谢师傅。</d>',
  '3.55—6.55秒，祈凌霜 (S3，女性发声身份，自然发声) 先看叶清碧，再向林沐发问：<d>[Chinese] 师傅擦得真仔细。师弟，要是我来擦，你是不是也会说多谢？</d>',
  '[Shot 2] At 00:06.200, 摄影机保持同一平视中景，不切换景别。',
  '7.55–9.20秒，祈凌霜 (S3，19岁女性发声身份，自然发声) 面向林沐发话：<d>[Chinese]我就知道你会喜欢。那这一串呢？味道比刚才的更清爽。</d>',
  '9.55–11.05秒，叶清碧 (S2，25岁女性发声身份，自然发声) 面向林沐说：<d>[Chinese]先尝这个。不要只听师姐的，她买东西总爱挑最显眼的。</d>',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');

const translateDescription = (text: string): string => text
  .replaceAll('青年男性人族', 'young male human')
  .replaceAll('女性人族', 'female human')
  .replaceAll('女性发声身份', 'female vocal identity')
  .replaceAll('男性发声身份', 'male vocal identity')
  .replaceAll('自然发声', 'natural delivery')
  .replaceAll('摄影机保持同一平视中景，不切换景别。', 'The camera retains the same eye-level medium shot without changing scale.');

const document = buildPromptTranslationDocument({ sourcePrompt, identityBindings, sourceCharacters });
assert.ok(document.slots.length > 0, 'descriptions must be available to the single translation request');
assert.equal(document.characters[1].relationship, '林沐与祈凌霜的师傅');
assert.equal(document.utterances.length, 5, 'each source utterance becomes one indivisible spoken unit');
const translationSlots = document.slots.map((slot) => ({ id: slot.id, text: translateDescription(slot.sourceText) }));

// The model authors description slots; the source document owns the surrounding speech and H3 structure.
const exposedDescriptions = document.slots.map((slot) => slot.sourceText).join('\n');
assert.doesNotMatch(exposedDescriptions, /林沐|叶清碧|祈凌霜|\(S[123]\)|多谢师傅|吃东西时慢一些/u);
assert.doesNotMatch(exposedDescriptions, /[（(]S\b/u,
  'S prefixes inside combined delivery annotations belong to the source, including (S2，女性发声身份)');
assert.doesNotMatch(exposedDescriptions, /\[Shot [12]\]|00:06\.200|1\.50—2\.55|2\.75—3\.45|7\.55–9\.20|9\.55–11\.05/u);
const rendered = renderPromptTranslationDocument(document, {
  slots: translationSlots,
  prompt: '[Shot 9] At 00:59.000, Qi Lingxue (S9) says the wrong dialogue.',
  characters: [{ name: 'Qi Lingxue', speakerToken: '(S9)' }],
});
assert.deepEqual(rendered.deliveryWarnings, []);
assert.doesNotMatch(rendered.prompt, /Qi Lingxue|S9|00:59\.000/u, 'whole-body replacements outside slots have no authority');
for (const fixedText of [
  '[Shot 1]', '[Shot 2]', 'At 00:06.200', '1.50—2.55', '2.75—3.45', '3.55—6.55', '7.55–9.20', '9.55–11.05',
  '<d>[Chinese] 吃东西时慢一些。</d>',
  '<d>[Chinese] 多谢师傅。</d>',
  '<d>[Chinese] 师傅擦得真仔细。师弟，要是我来擦，你是不是也会说多谢？</d>',
  '<d>[Chinese]我就知道你会喜欢。那这一串呢？味道比刚才的更清爽。</d>',
  '<d>[Chinese]先尝这个。不要只听师姐的，她买东西总爱挑最显眼的。</d>',
]) assert.ok(rendered.prompt.includes(fixedText), `source-owned content must survive translation: ${fixedText}`);
assert.match(rendered.prompt, /The camera retains the same eye-level medium shot without changing scale\./u,
  'the existing camera description is translated without changing the source shot structure');

const reminder = rendered.prompt.split('\n').find((line) => line.startsWith('1.50—2.55'));
const thanks = rendered.prompt.split('\n').find((line) => line.startsWith('2.75—3.45'));
assert.match(reminder ?? '', /叶清碧.*S2.*female vocal identity.*natural delivery/u,
  'the third-segment reminder keeps its full S2 delivery identity');
assert.match(thanks ?? '', /林沐.*S1.*male vocal identity.*natural delivery/u,
  'the third-segment thanks keeps its full S1 delivery identity');
const teasing = document.utterances.find((utterance) => utterance.text.includes('师傅擦得真仔细'));
assert.equal(teasing?.speakerCharacterId, 'qi-lingshuang', '师傅 in dialogue is an addressee, not the speaker');
assert.equal(teasing?.speakerToken, '(S3)', 'looking at another named character must not steal the speaking turn');

assert.ok(rendered.identityBindings, 'paired H3 identity metadata must be delivered with the rendered prompt');
for (const [index, binding] of rendered.identityBindings.characters.entries()) {
  assert.equal(binding.characterId, sourceCharacters[index].id);
  assert.equal(binding.name, sourceCharacters[index].name);
  assert.equal(binding.speakerToken, `(S${index + 1})`);
  assert.equal(binding.relationship, sourceCharacters[index].relationship);
  assert.ok(rendered.prompt.includes(binding.referenceAnchor), 'the anchor is an exact span in the same rendered prompt');
  assert.ok(binding.referenceAnchor.includes(binding.name), 'the metadata and prose share the same canonical name');
  assert.notEqual(binding.referenceAnchor, anchors[index], 'identity description translation also updates its paired anchor');
}

for (const response of [translationSlots, Object.fromEntries(translationSlots.map((slot) => [slot.id, slot.text]))]) {
  assert.deepEqual(renderPromptTranslationDocument(document, response), rendered,
    'array and slot-map responses render the same source-owned document');
}

// An incomplete response falls back locally; it cannot discard speech or demand another request.
const untranslated = renderPromptTranslationDocument(document, { slots: [] });
assert.equal(untranslated.prompt, sourcePrompt);
assert.ok(untranslated.deliveryWarnings.length > 0);
const omittedSlot = document.slots.find((slot) => slot.sourceText.includes('女性人族'));
assert.ok(omittedSlot, 'the identity description supplies a representative missing slot');
const incomplete = renderPromptTranslationDocument(document, {
  slots: translationSlots.filter((slot) => slot.id !== omittedSlot.id),
});
assert.ok(incomplete.deliveryWarnings.length > 0);
assert.ok(incomplete.prompt.includes(sourcePrompt.slice(omittedSlot.sourceStart, omittedSlot.sourceEnd)), 'an absent unit retains its exact complete source description');
assert.deepEqual(
  Array.from(incomplete.prompt.matchAll(/<d>[\s\S]*?<\/d>/gu), (match) => match[0]),
  Array.from(sourcePrompt.matchAll(/<d>[\s\S]*?<\/d>/gu), (match) => match[0]),
  'a missing description never removes, reorders or rewrites any Chinese dialogue',
);

// Repeated canonical names, overlapping Chinese names and Latin word boundaries must coexist.
const overlapping = buildPromptTranslationDocument({
  sourcePrompt: '[Shot 1] @沈砚青看向沈砚；沈砚转向沈砚青。Ann faces Anna near Annabelle. Anna nods to Ann beside the Annual banner.',
  sourceCharacters: [
    { id: 'shen-yan', name: '沈砚' }, { id: 'shen-yanqing', name: '沈砚青' },
    { id: 'ann', name: 'Ann' }, { id: 'anna', name: 'Anna' },
  ],
});
const overlapResult = renderPromptTranslationDocument(overlapping, {
  slots: overlapping.slots.map((slot) => ({ id: slot.id, text: slot.sourceText.replaceAll('Annabelle', 'the wall').replaceAll('Annual', 'plain') })),
});
assert.equal(overlapResult.prompt.match(/沈砚青/gu)?.length, 2);
assert.equal(overlapResult.prompt.match(/沈砚(?!青)/gu)?.length, 2);
assert.equal(overlapResult.prompt.match(/\bAnn\b/gu)?.length, 2, 'Ann must not be extracted from Annabelle or Annual');
assert.equal(overlapResult.prompt.match(/\bAnna\b/gu)?.length, 2, 'Anna remains distinct from its shorter overlapping name');
assert.doesNotMatch(overlapResult.prompt, /Annabelle|Annual/u, 'ordinary Latin words stay in the model-authored description slots');

// Protocol-looking text inside dialogue is spoken content, including newlines and example cut markers.
const protocolDialogue = '<d>[Chinese]师傅，下面只是格式样例：\n[Shot 99] At 00:59.999, <Subject 4>。\noverall_soundscape: N/A。</d>';
const quotedProtocol = buildPromptTranslationDocument({
  sourcePrompt: `[Shot 1] 祈凌霜 (S3) 面向叶清碧说：${protocolDialogue}`,
  identityBindings,
  sourceCharacters,
});
assert.equal(quotedProtocol.utterances.length, 1);
assert.equal(quotedProtocol.utterances[0].speakerCharacterId, 'qi-lingshuang');
const protocolResult = renderPromptTranslationDocument(quotedProtocol, {
  slots: quotedProtocol.slots.map((slot) => ({ id: slot.id, text: slot.sourceText.replaceAll('Annabelle', 'the wall').replaceAll('Annual', 'plain') })),
});
assert.ok(protocolResult.prompt.includes(protocolDialogue), 'a spoken protocol example remains one unchanged utterance');
assert.doesNotMatch(quotedProtocol.slots.map((slot) => slot.sourceText).join('\n'), /Shot 99|59\.999|Subject 4|格式样例/u,
  'dialogue examples must never become independently translatable H3 structure');

// Full-width delivery annotations carry the same explicit IDs, with source glyphs intact.
const wideSource = sourcePrompt.replace(/\((S[123])，([^()\n]*)\)/gu, '（$1，$2）');
const wide = buildPromptTranslationDocument({ sourcePrompt: wideSource, sourceCharacters,
  sourceDialogues: [{ id: 'source-teasing', text: '师傅擦得真仔细。师弟，要是我来擦，你是不是也会说多谢？',
    speakerCharacterId: 'qi-lingshuang', listenerCharacterIds: ['lin-mu'], addressedCharacterIds: ['ye-qingbi', 'lin-mu'] }] });
assert.deepEqual(wide.utterances.map((utterance) => utterance.speakerCharacterId),
  ['ye-qingbi', 'lin-mu', 'qi-lingshuang', 'qi-lingshuang', 'ye-qingbi']);
assert.deepEqual(wide.utterances.map((utterance) => utterance.speakerToken), ['(S2)', '(S1)', '(S3)', '(S3)', '(S2)']);
assert.equal(wide.utterances[2].id, 'source-teasing');
assert.deepEqual(wide.utterances[2].listenerCharacterIds, ['lin-mu']);
assert.deepEqual(wide.utterances[2].addressedCharacterIds, ['ye-qingbi', 'lin-mu']);
const wideRendered = renderPromptTranslationDocument(wide, { slots: wide.slots.map((slot) => ({ id: slot.id, text: translateDescription(slot.sourceText) })) });
assert.match(wideRendered.prompt, /叶清碧 （S2，female vocal identity，natural delivery）/u);
assert.match(wideRendered.prompt, /祈凌霜 （S3，female vocal identity，natural delivery）/u);
assert.doesNotMatch(wide.slots.map((slot) => slot.sourceText).join('\n'), /林沐|叶清碧|祈凌霜|[（(]S|S[123]/u);
const fullWidthId = buildPromptTranslationDocument({ sourcePrompt: '[Shot 1] 祈凌霜（Ｓ３，女性发声身份）说：<d>[Chinese]师傅，您先尝。</d>', sourceCharacters });
assert.equal(fullWidthId.utterances[0].speakerCharacterId, 'qi-lingshuang');
assert.equal(fullWidthId.utterances[0].speakerToken, '(S3)');
assert.ok(renderPromptTranslationDocument(fullWidthId, { slots: fullWidthId.slots.map((slot) => ({ id: slot.id, text: translateDescription(slot.sourceText) })) }).prompt.includes('（Ｓ３，female vocal identity）'),
  'full-width source voice glyphs stay immutable while their explicitly declared identity remains readable');
const plainNamedVoice = buildPromptTranslationDocument({
  sourcePrompt: '[Shot 1] 祈凌霜(S3)：<d>[Chinese]师傅，您先尝。</d>', sourceCharacters,
});
assert.equal(plainNamedVoice.utterances[0].speakerCharacterId, 'qi-lingshuang',
  'an explicit name beside the final voice token supplies its known ID without identity metadata');
assert.equal(plainNamedVoice.utterances[0].speakerToken, '(S3)');
const unownedVoice = buildPromptTranslationDocument({
  sourcePrompt: '[Shot 1] 祈凌霜看向林沐。 (S9)：<d>[Chinese]稍等。</d>', sourceCharacters,
});
assert.equal(unownedVoice.utterances[0].speakerCharacterId, undefined,
  'a standalone unowned voice token cannot claim a preceding narrative character');
assert.equal(unownedVoice.utterances[0].speakerToken, '(S9)');

// Historical Subject-name declarations remain source facts without requiring new metadata.
const historicalSource = [
  'subject_definitions:',
  '<Subject 1> is 叶清碧 referenced from <Picture 1>: 女性。',
  '<Subject 2> is 祈凌霜 referenced from <Picture 2>: 女性。',
  'summary: 叶清碧看向祈凌霜。',
  'retention_analysis: <Subject 1> and <Subject 2> fully_preserved.',
  'detailed_description:',
  '[Shot 1] <Subject 2>说：<d>[Chinese]师傅，您先尝。</d>',
  'overall_soundscape: N/A',
  'non_diegetic_music: N/A',
].join('\n');
const historical = buildPromptTranslationDocument({ sourcePrompt: historicalSource, sourceCharacters });
assert.equal(historical.characters.find((character) => character.characterId === 'qi-lingshuang')?.subjectToken, '<Subject 2>');
assert.equal(historical.utterances[0].speakerCharacterId, 'qi-lingshuang');
assert.equal(historical.utterances[0].addressedCharacterIds, undefined, '师傅 in a line does not fabricate a target ID');
assert.doesNotMatch(historical.slots.map((slot) => slot.sourceText).join('\n'), /叶清碧|祈凌霜|Subject|Picture/u);
const unnamedIds = buildPromptTranslationDocument({ sourcePrompt: historicalSource });
assert.equal(unnamedIds.characters.length, 0, 'a declared historical name does not fabricate a project ID');
assert.doesNotMatch(unnamedIds.slots.map((slot) => slot.sourceText).join('\n'), /叶清碧|祈凌霜/u,
  'explicit legacy Subject names remain fixed even without project IDs');

// Numbers and several names share a complete translation group, not isolated lexical context.
const ageSource = '[Shot 1] 叶清碧 (S2) 是25岁女性。';
const age = buildPromptTranslationDocument({ sourcePrompt: ageSource, sourceCharacters });
assert.equal(age.groups.length, 1);
assert.equal(age.groups[0].sourceText, ageSource);
assert.deepEqual(age.groups[0].slotIds, age.slots.map((slot) => slot.id));
assert.ok(age.slots.every((slot) => slot.groupSourceText === ageSource && slot.groupId === age.groups[0].id));
assert.equal(age.slots.length, 1, 'a whole identity sentence is one translation unit, not numeric/name gaps');
const ageSlot = age.slots[0];
const ageName = ageSlot.protectedText!.find((literal) => literal.text === '叶清碧')!.token;
const ageVoice = ageSlot.protectedText!.find((literal) => literal.text === '(S2)')!.token;
const ageNumber = ageSlot.protectedText!.find((literal) => literal.text === '25')!.token;
const ageResult = renderPromptTranslationDocument(age, { slots: [{ id: ageSlot.id,
  text: `${ageName} ${ageVoice} is a ${ageNumber}-year-old woman.` }] });
assert.equal(ageResult.prompt, '[Shot 1] 叶清碧 (S2) is a 25-year-old woman.');
const reorderedSpeech = buildPromptTranslationDocument({ sourcePrompt: '[Shot 1] 叶清碧对林沐说：<d>[Chinese]慢些吃。</d>', sourceCharacters });
assert.equal(reorderedSpeech.slots.length, 1, 'speaker, listener, verb and exact speech share a complete sentence');
const turn = reorderedSpeech.slots[0];
const tokenFor = (text: string): string => turn.protectedText!.find((literal) => literal.text === text)!.token;
const reorderedResult = renderPromptTranslationDocument(reorderedSpeech, { slots: [{ id: turn.id,
  text: `${tokenFor('叶清碧')} says to ${tokenFor('林沐')}: ${tokenFor('<d>[Chinese]慢些吃。</d>')}` }] });
assert.equal(reorderedResult.prompt, '[Shot 1] 叶清碧 says to 林沐: <d>[Chinese]慢些吃。</d>');
assert.deepEqual(reorderedResult.deliveryWarnings, []);
const multiCharacterGroup = document.groups.find((group) => group.sourceText.startsWith('3.55—6.55'));
assert.ok(multiCharacterGroup?.sourceText.includes('祈凌霜') && multiCharacterGroup.sourceText.includes('叶清碧') && multiCharacterGroup.sourceText.includes('林沐'));
assert.equal(multiCharacterGroup?.slotIds.length, 1, 'one complete turn is not scattered across several translation fragments');

// The recorded segment 2 puts several turns in one prose paragraph, following a
// separate three-person Identity paragraph. These cues retain that exact shape.
const continuousTurns = buildPromptTranslationDocument({ sourceCharacters, sourcePrompt: [
  '[Shot 1] Identity: 林沐 (S1), 青年男性。Identity: 叶清碧 (S2), 25岁女性。Identity: 祈凌霜 (S3), 19岁女性。',
  '祈凌霜（S3，19岁女性发声身份，自然发声）在2.35–3.95秒画内侧脸面向林沐发话，口型清楚只属于祈凌霜；林沐持稳果串并看向她，叶清碧在旁倾听。<d>[Chinese]这串看着最甜，你先尝。</d>'
    + '林沐（S1，青年男性发声身份，自然发声）在4.90–6.20秒画内对祈凌霜说：<d>[Chinese]确实不错，酸甜正好。</d>'
    + '祈凌霜（S3，19岁女性发声身份，自然发声）在7.55–9.20秒画内侧脸面向林沐发话，口型只属于祈凌霜；林沐边听边查看双手中的两串果子，叶清碧观察，不替她发声。<d>[Chinese]我就知道你会喜欢。那这一串呢？味道比刚才的更清爽。</d>'
    + '叶清碧（S2，25岁女性发声身份，自然发声）在9.55–11.05秒从林沐自身左侧面向林沐画内发话，口型只属于叶清碧；林沐看着掌中的浅色果子，祈凌霜倾听，不做该句口型。<d>[Chinese]先尝这个。不要只听师姐的，她买东西总爱挑最显眼的。</d>'
    + '祈凌霜（S3，19岁女性发声身份，自然发声）在11.25–11.95秒画内对叶清碧发问，口型只属于祈凌霜；林沐继续安静品尝，叶清碧保持倾听。<d>[Chinese]师傅这是在说我挑得不仔细？</d>'
    + '叶清碧（S2，25岁女性发声身份，自然发声）在11.95–13.25秒画内平静回应，目光落在林沐掌中的浅色果子，口型只属于叶清碧；祈凌霜听着她的话，林沐继续品尝，不做清晰说话口型。<d>[Chinese]我只是在提醒他多尝一种。好不好吃，还是由他自己说。</d>'
    + '林沐（S1，青年男性发声身份，自然发声）在13.65–14.35秒画内面向两人发话，口型只属于林沐；祈凌霜带笑倾听，叶清碧保持克制的听者反应。<d>[Chinese]师姐挑的甜，师傅挑的清爽，都很好吃。</d>'
    + '祈凌霜（S3，19岁女性发声身份，自然发声）在14.35–14.85秒画内带笑面向林沐接话，口型只属于祈凌霜；林沐和叶清碧保持倾听，不替她发声。<d>[Chinese]师弟这答案倒是很会照顾人。</d>',
].join('\n') });
assert.deepEqual(continuousTurns.utterances.map((utterance) => utterance.speakerCharacterId),
  ['qi-lingshuang', 'lin-mu', 'qi-lingshuang', 'ye-qingbi', 'qi-lingshuang', 'ye-qingbi', 'lin-mu', 'qi-lingshuang']);
assert.deepEqual(continuousTurns.utterances.map((utterance) => utterance.speakerToken),
  ['(S3)', '(S1)', '(S3)', '(S2)', '(S3)', '(S2)', '(S1)', '(S3)']);
assert.doesNotMatch(continuousTurns.slots.map((slot) => slot.sourceText).join('\n'), /林沐|叶清碧|祈凌霜|[（(]S|S[123]/u);

const visibleText = buildPromptTranslationDocument({ sourceCharacters, sourcePrompt: [
  '[Shot 1] 墙上写着“禁止进入”；屏幕显示“任务完成”；字幕：「稍后继续」。',
  '标牌上写着“师傅 <Subject 8> [Shot 99] At 00:59.999”；The sign reads "请勿触摸".',
  '气氛是“安静”；他脸上写着‘惊讶’；镜头标题是“侧脸特写”。',
  '祈凌霜(S3)说：“我会等你。”',
  '林沐(S1)站在屏幕旁说：“我来读。”',
].join('\n') });
assert.deepEqual(visibleText.slots.flatMap((slot) => (slot.protectedText || []).filter((literal) => literal.kind === 'visible-text').map((literal) => literal.text)),
  ['“禁止进入”', '“任务完成”', '「稍后继续」', '“师傅 <Subject 8> [Shot 99] At 00:59.999”', '"请勿触摸"']);
assert.equal(visibleText.utterances.length, 2, 'visible signs and subtitles do not create dialogue or absorb a person speaking beside a screen');
assert.equal(visibleText.utterances[0].speakerCharacterId, 'qi-lingshuang');
assert.equal(visibleText.utterances[0].text, '我会等你。');
assert.equal(visibleText.utterances[1].speakerCharacterId, 'lin-mu');
assert.equal(visibleText.utterances[1].text, '我来读。');
assert.doesNotMatch(visibleText.slots.map((slot) => slot.sourceText).join('\n'), /禁止进入|任务完成|稍后继续|请勿触摸|Shot 99|59\.999/u);
assert.match(visibleText.slots.map((slot) => slot.sourceText).join('\n'), /安静/u);
assert.match(visibleText.slots.map((slot) => slot.sourceText).join('\n'), /惊讶/u, 'a metaphor on a face remains a translatable description');
assert.match(visibleText.slots.map((slot) => slot.sourceText).join('\n'), /侧脸特写/u, 'a production title is not visible scene lettering');
const visibleResult = renderPromptTranslationDocument(visibleText, { slots: visibleText.slots.map((slot) => ({ id: slot.id,
  text: slot.sourceText.replaceAll('安静', 'quiet').replaceAll('惊讶', 'surprised').replaceAll('侧脸特写', 'profile close-up') })) });
for (const literal of ['“禁止进入”', '“任务完成”', '「稍后继续」', '“师傅 <Subject 8> [Shot 99] At 00:59.999”', '"请勿触摸"', '“我会等你。”']) assert.ok(visibleResult.prompt.includes(literal));
assert.match(visibleResult.prompt, /quiet/u);
assert.match(visibleResult.prompt, /surprised/u);
assert.match(visibleResult.prompt, /profile close-up/u);

// Reported segment 5: complete speaker/time/listener relations are rendered
// from the paired plan, not reconstructed from translated gaps in old prose.
const declaration = '没错，我们的君王是为了支配你们而来的，下跪低头吧。';
const performance: H3PerformancePlan = {
  version: 1, timeBase: 'shot', descriptionLanguage: 'zh',
  characters: [
    { characterId: 'king', visualDescription: '成年兽人王。', voiceDescription: '成年男性声线。' },
    { characterId: 'shalltear', visualDescription: '红铠吸血鬼。', voiceDescription: '女性吸血鬼声线。' },
    { characterId: 'aura', visualDescription: '金发精灵。' },
  ],
  shots: [
    { shotIndex: 1, startSec: 0, visualDescription: '三人保持既定站位。', events: [] },
    { shotIndex: 2, startSec: 8.2, visualDescription: '机位保持不变。', events: [
      { kind: 'visual', eventId: 'look', sourceFact: '没有看见与龙僵持不下的矮人和骷髅头盔者。',
        description: '目光扫过场地后回到红铠，眉头微锁。', silentCharacterIds: ['king'] },
      { kind: 'speech', eventId: 'question', dialogueId: 'b1-d11', text: '支配？', language: 'Chinese',
        speakerCharacterIds: ['king'], listenerCharacterIds: ['shalltear'], channel: 'on-screen', startSec: 0.8, endSec: 2,
        delivery: '短促反问。' },
      { kind: 'speech', eventId: 'declaration', dialogueId: 'b1-d12', text: declaration, language: 'Chinese',
        speakerCharacterIds: ['shalltear'], listenerCharacterIds: ['king'], channel: 'on-screen', startSec: 2.4, endSec: 6.2,
        delivery: '平静而明确。', speakerAction: '保持红铠中的既定姿态。',
        reactions: [{ characterId: 'king', description: '沉默注视红铠。', presence: 'visible' },
          { characterId: 'aura', description: '旁观双方。', presence: 'visible' }] },
    ] },
  ],
  overallSoundscape: '远处脚步。', nonDiegeticMusic: 'N/A',
};
const performanceBindings: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'king', name: '贝里尤洛', referenceAnchor: '贝里尤洛。' },
  { characterId: 'shalltear', name: '夏提雅', referenceAnchor: '夏提雅。' },
  { characterId: 'aura', name: '亚乌拉', referenceAnchor: '亚乌拉。' },
], performance };
const staleBody = `integrated_multimodal_description:\n[Shot 1] 贝里尤洛说话，夏提雅不张嘴。\n[Shot 2] At 00:08.200 from 6.20 to 夏提雅 seconds, 贝里尤洛 speaks <d>[Chinese] ${declaration}</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const performanceDocument = buildPromptTranslationDocument({ sourcePrompt: staleBody, identityBindings: performanceBindings });
assert.ok(performanceDocument.slots.some((slot) => slot.role === 'listener-reaction' && slot.ownerCharacterIds?.[0] === 'king'));
assert.doesNotMatch(performanceDocument.slots.map((slot) => slot.sourceText).join('\n'), /下跪低头|骷髅头盔|与龙僵持|夏提雅不张嘴|6\.20/u,
  'read-only source facts, original speech, clocks and stale prose are outside the translation fields');
const performanceTranslation: Record<string, string> = {
  '成年兽人王。': 'An adult orc king.', '成年男性声线。': 'An adult male voice.',
  '红铠吸血鬼。': 'A vampire in red armor.', '女性吸血鬼声线。': 'A female vampire voice.', '金发精灵。': 'A blond elf.',
  '三人保持既定站位。': 'The three retain their authored positions.', '机位保持不变。': 'The camera remains in place.',
  '目光扫过场地后回到红铠，眉头微锁。': 'His gaze scans the ground and returns to the red armor with a slight frown.',
  '短促反问。': 'A brief questioning delivery.', '平静而明确。': 'Calm and definite.',
  '保持红铠中的既定姿态。': 'Holds the authored posture inside the red armor.',
  '沉默注视红铠。': 'Watches the red armor silently.', '旁观双方。': 'Observes both participants.', '远处脚步。': 'Distant footsteps.',
};
const performanceResult = renderPromptTranslationDocument(performanceDocument, { slots: performanceDocument.slots.map((slot) => ({
  id: slot.id, text: performanceTranslation[slot.sourceText] || slot.sourceText,
})), performance: { shots: [{ events: [{ speakerCharacterIds: ['king'], text: '篡改台词' }] }] } });
assert.deepEqual(performanceResult.deliveryWarnings, []);
assert.match(performanceResult.prompt, /From 9\.00 to 10\.20 seconds[^\n]*贝里尤洛 \(S1\)[^\n]*<d>\[Chinese\] 支配？<\/d>/u);
assert.match(performanceResult.prompt, /From 10\.60 to 14\.40 seconds[^\n]*夏提雅 \(S2\)[^\n]*to 贝里尤洛[^\n]*<d>\[Chinese\] 没错/u);
assert.match(performanceResult.prompt, /夏提雅 produces the speaking lip movements/u);
assert.match(performanceResult.prompt, /贝里尤洛[^\n]*Watches the red armor silently/u);
assert.match(performanceResult.prompt, /夏提雅[^\n]*A female vampire voice/u);
assert.doesNotMatch(performanceResult.prompt, /夏提雅不张嘴|from 6\.20|骷髅头盔|与龙僵持|篡改台词|亚乌拉 \(S\d+\)/u);
assert.deepEqual(readH3PromptProtocol(performanceResult.prompt).sections,
  ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']);
assert.equal(performanceResult.identityBindings?.performance?.timeBase, 'clip');
assert.equal(performanceResult.identityBindings?.performance?.shots[1].events[2].startSec, 10.6);
assert.equal(performanceResult.identityBindings?.events?.find((event) => event.dialogueId === 'b1-d12')?.speakerCharacterId, 'shalltear');
assert.equal(performanceBindings.performance?.timeBase, 'shot', 'translation does not mutate the saved source plan');

// Full reference keeps independent Subject/Picture/Audio identities, translating
// only authored descriptions and additional non-character reference definitions.
const fullBindings = structuredClone(performanceBindings);
fullBindings.characters.forEach((entry, index) => { entry.subjectToken = `<Subject ${index + 1}>`; });
const fullSource = [
  'subject_definitions:',
  '<Subject 1> is 贝里尤洛 referenced from <Picture 5>: 兽人王。',
  '<Subject 2> is 夏提雅 referenced from <Picture 3>, voice from <Audio 1>: 红铠。',
  '<Subject 3> is 亚乌拉 referenced from <Picture 4>: 精灵。',
  '<Picture 1> 是开场构图。',
  'summary: 三人交谈。', 'retention_analysis: fully_preserved.', 'detailed_description:',
  '[Shot 1] 三人站定。', '[Shot 2] At 00:08.200 三人交谈。', 'overall_soundscape: 远处脚步。', 'non_diegetic_music: N/A',
].join('\n');
const fullDocument = buildPromptTranslationDocument({ sourcePrompt: fullSource, identityBindings: fullBindings });
const fullResult = renderPromptTranslationDocument(fullDocument, { slots: fullDocument.slots.map((slot) => ({ id: slot.id,
  text: performanceTranslation[slot.sourceText] || slot.sourceText.replace('是开场构图。', 'is the opening composition.'),
})) });
assert.match(fullResult.prompt, /<Subject 1>[^\n]*贝里尤洛[^\n]*<Picture 5>/u);
assert.match(fullResult.prompt, /<Subject 2>[^\n]*夏提雅[^\n]*<Picture 3>[^\n]*<Audio 1>/u);
assert.match(fullResult.prompt, /<Picture 1> is the opening composition\./u);
assert.match(fullResult.prompt, /<Subject 2>[^\n]*夏提雅[^\n]*\(S2\)[^\n]*<d>\[Chinese\] 没错/u);
assert.deepEqual(readH3PromptProtocol(fullResult.prompt).sections,
  ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
assert.equal(fullResult.prompt.match(/is 贝里尤洛/gu)?.length, 1, 'old person definitions are not appended behind their rebuilt version');

const joinedIdentities = buildPromptTranslationDocument({ sourcePrompt: `[Shot 1] ${anchors.join(' ')}`, identityBindings, sourceCharacters });
assert.equal(joinedIdentities.slots.length, 3, 'legacy complete identity declarations may share a line without becoming shared anchors');
const joinedResult = renderPromptTranslationDocument(joinedIdentities, { slots: joinedIdentities.slots.map((slot) => ({ id: slot.id, text: translateDescription(slot.sourceText) })) });
for (const binding of joinedResult.identityBindings!.characters) {
  assert.ok(joinedResult.prompt.includes(binding.referenceAnchor));
  assert.ok(!sourceCharacters.some((character) => character.id !== binding.characterId && binding.referenceAnchor.includes(character.name)),
    'one translated identity anchor does not absorb the other declared people');
}

const voiceOnlyBindings = structuredClone(fullBindings);
voiceOnlyBindings.performance!.characters!.push({ characterId: 'narrator', name: '旁白声', presence: 'offscreen',
  visualDescription: '', voiceDescription: '低沉旁白。' });
voiceOnlyBindings.performance!.shots[0].events.push({ kind: 'speech', eventId: 'narration', dialogueId: 'narration-1',
  speakerCharacterIds: ['narrator'], text: '暮色降临。', language: 'Chinese', channel: 'voiceover', startSec: 0, endSec: 1.5 });
for (const voiceDefinition of ['声音身份: 旁白声 (S1)，声音参考为<Audio 2>。', 'Voice identity: 旁白声 (S1), referenced from <Audio 2>.']) {
  const voiceOnlySource = fullSource.replace('summary:', `${voiceDefinition}\nVoice identity: 未绑定访客 (S8).\nsummary:`);
  const voiceOnlyDocument = buildPromptTranslationDocument({ sourcePrompt: voiceOnlySource, identityBindings: voiceOnlyBindings });
  assert.deepEqual(voiceOnlyDocument.performanceCharacterAudio?.find(([id]) => id === 'narrator')?.[1], [2],
    'an explicitly named saved voice-only source retains its declared audio reference');
  const voiceOnlyResult = renderPromptTranslationDocument(voiceOnlyDocument, { slots: voiceOnlyDocument.slots.map((slot) => ({
    id: slot.id, text: performanceTranslation[slot.sourceText] || slot.sourceText.replace('低沉旁白。', 'A low narrator voice.'),
  })) });
  assert.equal(voiceOnlyResult.prompt.match(/(?:Voice identity|声音身份): 旁白声/gu)?.length, 1,
    'the previous generated voice-only definition is replaced, not appended to the rebuilt definition');
  assert.match(voiceOnlyResult.prompt, /Voice identity: 旁白声 \(S1\)[^\n]*<Audio 2>/u);
  assert.match(voiceOnlyResult.prompt, /Voice identity: 未绑定访客 \(S8\)\./u,
    'a voice not explicitly named in the saved plan is not assigned, removed or inferred');
}

console.log('promptTranslationDocument: complete units, owned speech events, reference identities and legacy anchors passed');
