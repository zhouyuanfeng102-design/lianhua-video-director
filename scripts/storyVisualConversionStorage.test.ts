import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { matchingStoryVisualConversion } from '../src/storyVisualConversion';
import type { StoryVisualConversionSnapshot } from '../src/types';

const state = createInitialState();
const chapterId = state.project.sourceDocuments[0]?.id;
assert.ok(chapterId);
const snapshot: StoryVisualConversionSnapshot = {
  id: 'conversion-test', chapterId, sourceName: '原文',
  sourceText: '  红铠人挥动长枪。敌兵被打飞，像撞上无形的墙。“退后！”队长喊道。\n',
  resultText: '红铠人用长枪击飞冲来的敌兵，队长看见后喊道：“退后！”',
  createdAt: 10,
};
state.project.storyVisualConversions = [snapshot];
state.projects = [state.project, { ...state.project, id: 'isolated-project', storyVisualConversions: undefined }];
const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.deepEqual(restored.project.storyVisualConversions, [snapshot], 'save/reload keeps exact original and adopted text');
assert.equal(matchingStoryVisualConversion(restored.project, chapterId, snapshot.resultText)?.sourceText, snapshot.sourceText);
assert.equal(matchingStoryVisualConversion(restored.project, 'other-chapter', snapshot.resultText), undefined);
assert.equal(matchingStoryVisualConversion(restored.project, chapterId, `${snapshot.resultText}用户修改。`), undefined);
assert.equal(restored.projects.find((project) => project.id === 'isolated-project')?.storyVisualConversions, undefined,
  'another project cannot inherit the active project original');
assert.deepEqual(normalizeState(restored), restored, 'new optional collection remains idempotent');

const invalid = normalizeState({ ...state, project: { ...state.project, storyVisualConversions: [
  snapshot, null, {}, { ...snapshot, chapterId: '' }, { ...snapshot, sourceText: '' },
  { ...snapshot, resultText: 3 }, { ...snapshot, createdAt: '10' },
] } });
assert.deepEqual(invalid.project.storyVisualConversions, [snapshot], 'malformed entries cannot become original evidence');
assert.notEqual(invalid.project.storyVisualConversions![0], snapshot, 'normalization copies provenance instead of mutating input');

const old = normalizeState({ ...state, project: { ...state.project, storyVisualConversions: [] } });
assert.equal(Object.hasOwn(old.project, 'storyVisualConversions'), false, 'empty and old projects have no invented original or undefined key');
assert.deepEqual(normalizeState(old), old);
console.log('Story visual conversion storage: 10 checks passed');
