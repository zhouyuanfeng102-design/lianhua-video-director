import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { matchingStoryVisualConversion, rememberStoryVisualConversion } from '../src/storyVisualConversion';
import type { StoryVisualConversionSnapshot } from '../src/types';

const project = createInitialState().project;
const original = '\n 红铠人举枪，敌人被击飞。侍从说：“飞出去了……”\n';
const adopted = '夏提雅挥枪迎击敌人。敌人受击飞出。侍从说：“飞出去了……”';
const snapshot: StoryVisualConversionSnapshot = {
  id: 'visual-1', chapterId: 'chapter-a', sourceName: '第一章',
  sourceText: original, resultText: adopted, createdAt: 1,
};
assert.equal(matchingStoryVisualConversion(project, 'chapter-a', adopted), undefined,
  'legacy drafts without a conversion must not fabricate an original manuscript');
const remembered = rememberStoryVisualConversion(project, snapshot);
assert.equal(project.storyVisualConversions, undefined, 'adoption cannot mutate the prior project snapshot');
assert.equal(remembered.storyVisualConversions?.[0].sourceText, original, 'keep the exact pre-conversion text');
assert.equal(matchingStoryVisualConversion(remembered, 'chapter-a', `\n${adopted}\n`)?.id, snapshot.id);
assert.equal(matchingStoryVisualConversion(remembered, 'chapter-b', adopted), undefined, 'same prose in another chapter is not this original');
assert.equal(matchingStoryVisualConversion(remembered, undefined, adopted), undefined);
assert.equal(matchingStoryVisualConversion(remembered, 'chapter-a', `${adopted}手动修改剧情。`), undefined,
  'a manual edit cannot silently inherit stale original evidence');
assert.equal(matchingStoryVisualConversion(remembered, 'chapter-a', original), undefined,
  'restoring the source ceases to advertise the abandoned converted draft');
const newer = { ...snapshot, id: 'visual-2', createdAt: 2, sourceText: '确认后的新版原稿' };
const history = rememberStoryVisualConversion(remembered, newer);
assert.equal(history.storyVisualConversions?.length, 2, 'keep prior versions for review');
assert.equal(matchingStoryVisualConversion(history, 'chapter-a', adopted)?.id, newer.id);
assert.equal(rememberStoryVisualConversion(history, newer).storyVisualConversions?.length, 2, 'one adoption ID is idempotent');
assert.equal(matchingStoryVisualConversion({ storyVisualConversions: [] }, 'chapter-a', adopted), undefined,
  'a second project cannot borrow the first project history');
console.log('Story visual conversion provenance: 12 checks passed.');
