import assert from 'node:assert/strict';
import { buildSeedanceTranslationDocument, renderSeedanceTranslationDocument, SeedanceTranslationSerializationError } from '../src/seedanceTranslationDocument';
import { translateSeedancePromptToEnglish } from '../src/seedancePrompt';

const source = [
  '主体连续性：甲，男；乙，女。',
  '一句话概述：甲问“至于吗”，乙答“当然”。',
  '连续时间轴：',
  '【0s-7.5s】甲低声问乙：“至于吗？”',
  '【7.5s-15s】乙对甲回答：“当然！”',
].join('\n');
const document = buildSeedanceTranslationDocument(source);
assert.deepEqual(document.units.filter((unit) => unit.section === 'summary').flatMap((unit) => unit.literals.filter((literal) => literal.kind === 'dialogue')), [],
  'summary quotations describe events and are not extra spoken occurrences');
assert.deepEqual(document.units.flatMap((unit) => unit.literals.filter((literal) => literal.kind === 'dialogue').map((literal) => literal.text)), ['“至于吗？”', '“当然！”']);
assert.ok(document.layout.some((atom) => 'text' in atom && atom.text === '【0s-7.5s】'));
assert.ok(document.layout.some((atom) => 'text' in atom && atom.text === '【7.5s-15s】'));
assert.ok(document.slots.every((slot) => !/[【】]/u.test(slot.sourceText)), 'both timestamp brackets belong to the fixed source node');

const phrases = new Map([
  ['，男；', ', male; '],
  ['，女。', ', female.'],
  ['问“至于吗”，', ' asks whether that is necessary; '],
  ['答“当然”。', ' replies that it is.'],
  ['低声问', ' quietly asks '],
  ['对', ' answers '],
  ['回答：', ': '],
]);
const response = JSON.stringify({ slots: document.slots.map((slot) => {
  assert.ok(phrases.has(slot.sourceText), `all descriptions have a deliberate English fixture: ${slot.sourceText}`);
  return { id: slot.id, text: phrases.get(slot.sourceText)! };
}) });
const expected = [
  'Subject continuity:甲, male; 乙, female.',
  'One-sentence summary:甲 asks whether that is necessary; 乙 replies that it is.',
  'Continuous timeline:',
  '【0s-7.5s】甲 quietly asks 乙: “至于吗？”',
  '【7.5s-15s】乙 answers 甲: “当然！”',
].join('\n');
assert.equal(renderSeedanceTranslationDocument(document, response), expected,
  'coordinated English descriptions render naturally around fixed speakers, original dialogue and fractional shot boundaries');
assert.equal(document.sourcePrompt, source);

let calls = 0;
assert.equal(await translateSeedancePromptToEnglish({ sourcePrompt: source, request: async (_system, user, transport) => {
  calls += 1;
  const input = JSON.parse(user);
  assert.equal(input.sourcePrompt, source);
  assert.equal(transport?.sourceDocumentTranslation, true);
  assert.ok(input.slots.every((slot: { before: string; after: string }) => slot.before.length <= 80 && slot.after.length <= 80));
  assert.ok(input.units.some((unit: { sourceText: string }) => unit.sourceText.includes('甲问“至于吗”')));
  assert.doesNotMatch(user, /__LH_|__H3_/u);
  return response;
} }), expected);
assert.equal(calls, 1, 'summary and timeline quotes do not cause a review or repair call');

for (const boundary of ['【 0秒至7.5秒 】', '[0 sec to 7.5 sec]', '（0.00–7.500秒）', '(00:00–00:07.500)']) {
  const timed = buildSeedanceTranslationDocument(`连续时间轴：\n${boundary}甲说道：“好。”`, [{ id: 'a', name: '甲' }]);
  const renderedBoundary = boundary.replace(/秒/gu, 's').replace(/至/gu, '–');
  assert.ok(timed.layout.some((atom) => 'text' in atom && atom.text === renderedBoundary), `${boundary} stays one complete boundary`);
  assert.ok(timed.slots.every((slot) => !/[【】[\]（）()]/u.test(slot.sourceText)));
}
const quoted = buildSeedanceTranslationDocument(
  '连续时间轴：\n0秒至1.25秒，甲（压低声音、像在说“悄悄话”）：“他说‘走吧’。”\n1.25秒至2.5秒，乙 says: \'好的！\'',
  [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }],
);
assert.deepEqual(quoted.units.flatMap((unit) => unit.literals.filter((literal) => literal.kind === 'dialogue').map((literal) => literal.text)),
  ['“他说‘走吧’。”', "'好的！'"], 'delivery-note quotes are descriptions; nested real speech and ASCII-quoted speech stay literal');

const references = buildSeedanceTranslationDocument(
  '参考素材与职责：@Image 1 是林霜；@Video 2 是动作；@Audio 3 是声音；@Clay Render 4 是空间。\n连续时间轴：\n0秒至15秒，林霜看向屏幕，屏幕显示：“请保留30秒。”',
  [{ id: 'lin', name: '林霜', aliases: ['不在正文的别名'] }],
);
const fixed = references.units.flatMap((unit) => unit.literals);
assert.deepEqual(fixed.filter((literal) => literal.kind === 'reference').map((literal) => literal.text), ['@Image 1', '@Video 2', '@Audio 3', '@Clay Render 4']);
assert.ok(fixed.some((literal) => literal.kind === 'visible-text' && literal.text === '“请保留30秒。”'));
assert.ok(!references.slots.some((slot) => /林霜|@(?:Image|Video|Audio|Clay Render)|请保留30秒/u.test(slot.sourceText)),
  'identity, reference IDs and printed words are not translated description slots');

for (const invalid of ['', 'not json', '{}', '{"slots":[]}', JSON.stringify({ slots: document.slots.map((slot) => ({ id: slot.id, text: '' })) })]) {
  assert.throws(() => renderSeedanceTranslationDocument(document, invalid), (error: unknown) => error instanceof SeedanceTranslationSerializationError
    && error.retryable === false && error.code === 'invalid_response');
}
const reversed = JSON.stringify({ slots: JSON.parse(response).slots.reverse() });
assert.equal(renderSeedanceTranslationDocument(document, reversed), expected, 'response array order cannot move source-owned facts or shot boundaries');
console.log('Seedance source document: summary/speech distinction, fixed names/references/fractional times, complete brackets, natural English assembly and serialization-only failures passed.');
