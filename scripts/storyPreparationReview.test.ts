import assert from 'node:assert/strict';
import { getStoryPreparationParagraphs, normalizeStoryPreparationResult, reviewStoryOptimization, type StoryPreparationResult } from '../src/storyPreparationReview';

let checks = 0;
const source = '甲踢开门，低声说：“等等。”';
for (const candidate of [
  '甲推开门，高声说：“快走。”',
  'Lin opens the door and walks into the room.',
  '## 门口\n**动作：** 甲推门。',
  '{"optimizedStory":"甲推门。',
  '{"场景":[{"内容":"甲推门。"}]}',
  '{"error":{"message":"AI正文未按约定包装"}}',
  '---\n???', '{}', '[]', 'null', 'true', '',
]) {
  const prepared = reviewStoryOptimization(source, candidate);
  assert.deepEqual(prepared, { text: candidate, warnings: [] }, 'format, dialogue and content differences never trigger local grading or rejection');
  checks += 1;
}

const body = '甲抬脚蹬开门。\n\n门板向内摆动，他随即进入。';
for (const candidate of [
  JSON.stringify(body), JSON.stringify({ visualStory: body }), JSON.stringify({ optimizedStory: body, notes: 'AI附注' }),
  `\uFEFF\r\n\`\`\`text\r\n${body.replace(/\n/gu, '\r\n')}\r\n\`\`\``,
]) {
  assert.deepEqual(normalizeStoryPreparationResult(candidate), { text: body, warnings: [] }, 'known transport wrappers are display formatting only');
  checks += 1;
}
const ambiguous = JSON.stringify({ visualStory: '甲推门。', text: '乙关门。' });
assert.equal(normalizeStoryPreparationResult(ambiguous).text, ambiguous, 'ambiguous bodies are not locally chosen or rewritten');
checks += 1;

const plain: StoryPreparationResult = { text: body, warnings: [] };
const paragraphs = getStoryPreparationParagraphs(plain);
assert.deepEqual(paragraphs.map(({ id, text }) => ({ id, text })), [
  { id: 'paragraph-1', text: '甲抬脚蹬开门。' },
  { id: 'paragraph-2', text: '门板向内摆动，他随即进入。' },
]);
assert.ok(paragraphs.every((paragraph) => paragraph.sourceParagraphIds.length === 0 && paragraph.eventIds.length === 0));
assert.equal(getStoryPreparationParagraphs({ ...plain, text: body.replace(/\n/gu, '\r\n') })[1].id, 'paragraph-2', 'plain text paragraph IDs stay stable for navigation and user-requested rewrite');
checks += 1;

const aiParagraphs = paragraphs.map((paragraph, index) => ({ ...paragraph, id: `ai-${index}`, sourceParagraphIds: ['unknown-original-id'], eventIds: ['unknown-event-id'] }));
assert.deepEqual(getStoryPreparationParagraphs({ ...plain, paragraphs: aiParagraphs }), aiParagraphs, 'unknown AI references do not prevent metadata presentation or paragraph selection');
const mismatched = getStoryPreparationParagraphs({ ...plain, paragraphs: [{ ...aiParagraphs[0], text: '旧正文。' }] });
assert.equal(mismatched[0].text, '甲抬脚蹬开门。', 'navigation always follows current visible prose instead of replacing it with metadata text');
assert.equal(mismatched[0].id, 'paragraph-1');
checks += 1;

console.log(`${checks} AI-owned story presentation checks passed`);
