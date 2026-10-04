import assert from 'node:assert/strict';
import { H3PromptDisplay, parseH3Sections, splitH3ReadableFields, splitH3Shots, type H3Section } from '../src/components/H3PromptDisplay';

const prompt = [
  '首尾帧参考对齐：第一张图负责起始画面，第二张图负责末段画面。',
  '保留这段前置说明，不属于官方 section。',
  'subject_definitions:',
  '<Subject 1> 师傅；<Picture 1> 人物参考。',
  '',
  'retention_analysis:',
  'retention_analysis 正文引用 [Shot 2]，这里仍然是一段连续性说明，不是新镜头。',
  '',
  'integrated_multimodal_description:',
  '[Shot 1] At 00:00.000 师傅把药草递向徒弟。',
  '[Shot 2] At 00:05.000 徒弟说：“对白里不要拆成 [Shot 3] 标记。”',
  '',
  'overall_soundscape:',
  '只有递药草时的手部动作声。',
  '',
  'non_diegetic_music: N/A',
].join('\n');

// The renderer is deliberately a raw-text transport boundary.  It must hand
// React the exact string that the H3 request/export path supplied; section
// parsers below are test/compatibility helpers only and may not be used to
// rebuild or reorder the displayed prompt.
const rendered = H3PromptDisplay({ prompt, language: 'zh' });
assert.equal(rendered.type, 'pre');
assert.equal(rendered.props.className, 'h3-prompt-original');
assert.equal(rendered.props.children, prompt, 'display component forwards the exact H3 source string');
assert.equal(Object.prototype.hasOwnProperty.call(rendered.props, 'dangerouslySetInnerHTML'), false,
  'raw H3 text is passed as a text child, never reparsed as markup');

const parts = parseH3Sections(prompt);
assert.equal(parts[0].name, 'preamble');
assert.equal((parts[0] as { body: string }).body, '首尾帧参考对齐：第一张图负责起始画面，第二张图负责末段画面。\n保留这段前置说明，不属于官方 section。\n');
const sections = parts.filter((part): part is H3Section => part.name !== 'preamble');
assert.deepEqual(sections.map((section) => section.name), [
  'subject_definitions', 'retention_analysis', 'integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music',
]);
assert.match(sections[1].body, /引用 \[Shot 2\]/u);
assert.equal(sections[1].body.includes('[Shot 3]'), false);

const description = sections.find((section) => section.name === 'integrated_multimodal_description')!;
const shots = splitH3Shots(description.body);
assert.equal(shots.length, 2);
assert.equal(shots[0].marker, '[Shot 1] At 00:00.000');
assert.doesNotMatch(shots[0].body, /At 00:00\.000/u);
assert.equal(shots[1].marker, '[Shot 2] At 00:05.000');
assert.match(shots[1].body, /对白里不要拆成 \[Shot 3\] 标记/u);
const fields = splitH3ReadableFields('主体：师傅；空间：山道；台词：师傅说“声音：不是字段”。；声音：递药草的动作声。');
assert.deepEqual(fields.map((field) => field.label), ['主体：', '空间：', '台词：', '声音：']);
assert.match(fields[2].value, /声音：不是字段/u, 'quoted dialogue must remain in the dialogue value');

// A mid-sentence marker is not a shot boundary. Returning no split leaves the
// complete body visible in the section renderer and avoids local interpretation.
assert.deepEqual(splitH3Shots('对白中提到 [Shot 2]，但没有逐行镜头标题。'), []);
assert.deepEqual(parseH3Sections('没有官方标题的原文'), [{ name: 'preamble', body: '没有官方标题的原文', start: 0, end: 9 }]);

console.log('h3PromptDisplay parser tests passed');
