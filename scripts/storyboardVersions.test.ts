import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  comparePromptText,
  createABCandidates,
  createStoryboardRevision,
  type StoryboardRevision,
} from '../src/storyboardVersions';
import * as storyboardVersions from '../src/storyboardVersions';

const revisionHelpers = storyboardVersions as typeof storyboardVersions & Record<string, any>;

assert.equal(
  typeof revisionHelpers.restoreStoryboardRevisionSnapshot,
  'function',
  'revision restoration must be implemented as an immutable helper',
);
const liveBoard = {
  id: 'board-restore',
  finalPrompt: '当前提示词',
  englishPrompt: 'current prompt',
  englishPromptSource: '当前提示词',
  officialPromptZh: '当前官方中文稿',
  officialPromptEn: 'current official English prompt',
  officialPromptSource: '当前提示词',
  officialPromptEnSource: '当前官方中文稿',
  targetModelId: 'seedance-2.0',
  shots: [{ id: 'live-shot', prompt: '当前镜头稿' }],
  promptPlan: { canonicalPrompt: '恢复前的旧适配源' },
  promptTrace: { mode: 'text-api' },
  updatedAt: 300,
};
const savedRevision: StoryboardRevision = {
  id: 'board-restore-r1',
  storyboardId: 'board-restore',
  revision: 1,
  createdAt: 100,
  finalPrompt: 'API 润色后保存的提示词',
  englishPrompt: 'saved polished prompt',
  officialPromptZh: '保存时的官方中文稿',
  officialPromptEn: 'saved official English prompt',
  officialPromptSource: 'API 润色后保存的提示词',
  officialPromptEnSource: '保存时的官方中文稿',
  targetModelId: 'seedance-2.0',
  shots: [{ id: 'saved-shot', prompt: '保存时镜头稿' }],
};
const restoredBoard = revisionHelpers.restoreStoryboardRevisionSnapshot(
  liveBoard,
  savedRevision,
);
assert.equal(restoredBoard.finalPrompt, savedRevision.finalPrompt);
assert.equal(restoredBoard.englishPrompt, savedRevision.englishPrompt);
assert.deepEqual(restoredBoard.shots, savedRevision.shots);
assert.notStrictEqual(restoredBoard.shots, savedRevision.shots);
assert.notStrictEqual(restoredBoard.shots[0], savedRevision.shots[0]);
assert.equal(restoredBoard.englishPromptSource, savedRevision.finalPrompt);
assert.equal(restoredBoard.officialPromptZh, savedRevision.officialPromptZh);
assert.equal(restoredBoard.officialPromptEn, savedRevision.officialPromptEn);
assert.equal(restoredBoard.officialPromptSource, savedRevision.officialPromptSource);
assert.equal(restoredBoard.officialPromptEnSource, savedRevision.officialPromptEnSource);
assert.equal(restoredBoard.targetModelId, savedRevision.targetModelId);
assert.equal(restoredBoard.promptPlan, undefined, 'restoring must invalidate the old adapter source');
assert.equal(restoredBoard.promptTrace, undefined, 'restoring must not retain provenance for another prompt');
assert.equal(liveBoard.finalPrompt, '当前提示词', 'the live storyboard must remain immutable');

const savedOfficialRevision = createStoryboardRevision({
  id: 'board-save-official',
  finalPrompt: '内部规范时间轴',
  englishPrompt: 'internal canonical timeline',
  officialPromptZh: '官方 H3 中文交付稿',
  officialPromptEn: 'official H3 English delivery prompt',
  officialPromptSource: '内部规范时间轴',
  officialPromptEnSource: '官方 H3 中文交付稿',
  targetModelId: 'minimax-h3',
  shots: [],
  updatedAt: 400,
});
assert.equal(savedOfficialRevision.officialPromptZh, '官方 H3 中文交付稿');
assert.equal(savedOfficialRevision.officialPromptEn, 'official H3 English delivery prompt');
assert.equal(savedOfficialRevision.officialPromptSource, '内部规范时间轴');
assert.equal(savedOfficialRevision.officialPromptEnSource, '官方 H3 中文交付稿');
assert.equal(savedOfficialRevision.targetModelId, 'minimax-h3');

const restoredLegacyRevision = revisionHelpers.restoreStoryboardRevisionSnapshot(
  liveBoard,
  {
    id: 'board-restore-legacy-r1',
    storyboardId: 'board-restore',
    revision: 1,
    createdAt: 90,
    finalPrompt: '旧版本内部稿',
    shots: [],
  },
);
assert.equal(restoredLegacyRevision.officialPromptZh, undefined);
assert.equal(restoredLegacyRevision.officialPromptEn, undefined);
assert.equal(restoredLegacyRevision.officialPromptSource, undefined);
assert.equal(restoredLegacyRevision.officialPromptEnSource, undefined);
assert.equal(restoredLegacyRevision.targetModelId, undefined);
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const restoreRevisionSource = appSource.slice(
  appSource.indexOf('const restoreRevision ='),
  appSource.indexOf('const migratePreservedPrompt ='),
);
assert.match(
  restoreRevisionSource,
  /restoreStoryboardRevisionSnapshot\(/u,
  'the UI restore action must use the exact immutable revision snapshot',
);
assert.doesNotMatch(
  restoreRevisionSource,
  /rebuildStoryboard\(/u,
  'restoring a saved revision must not rebuild and overwrite its final prompt',
);
assert.match(
  restoreRevisionSource,
  /hasSavedTargetModel[\s\S]*?restoredTargetModelId[\s\S]*?targetModelId:\s*restoredTargetModelId/u,
  'restoring a revision must use its saved target model and only infer legacy metadata when absent',
);
assert.match(
  appSource.slice(appSource.indexOf('const normalizedRevisionHistory'), appSource.indexOf('const saveRevision')),
  /targetModelId:\s*revision\.targetModelId/u,
  'revision history normalization must persist target model metadata',
);

const nestedRevision: StoryboardRevision = {
  id: 'board-1-r2',
  storyboardId: 'board-1',
  revision: 2,
  createdAt: 200,
  finalPrompt: 'nested revision prompt',
  englishPrompt: 'nested revision prompt in English',
  shots: [],
};

const importedConflictHistory: StoryboardRevision[] = [
  {
    id: 'board-conflict-r2',
    storyboardId: 'board-conflict',
    revision: 2,
    createdAt: 100,
    finalPrompt: 'imported base revision',
    shots: [],
  },
  {
    id: 'board-conflict-r2-3',
    storyboardId: 'board-conflict',
    revision: 2,
    createdAt: 200,
    finalPrompt: 'imported suffixed revision',
    shots: [],
  },
];
const collisionSafeRevision = createStoryboardRevision(
  { id: 'board-conflict', finalPrompt: 'new revision', shots: [] },
  importedConflictHistory,
  { revision: 2, createdAt: 300 },
);
assert.equal(collisionSafeRevision.id, 'board-conflict-r2-4');
assert.equal(
  importedConflictHistory.some((revision) => revision.id === collisionSafeRevision.id),
  false,
  'a revision ID must remain unique when imported history already contains the first suffixed candidate',
);

const result = createABCandidates(
  { id: 'base-candidate', prompt: 'base prompt' },
  [{ label: 'B', revision: nestedRevision }],
);
const nestedCandidate = result.candidates[1];

assert.equal(nestedCandidate.id, nestedRevision.id);
assert.equal(nestedCandidate.revisionId, nestedRevision.id);
assert.equal(nestedCandidate.prompt, nestedRevision.finalPrompt);
assert.equal(nestedCandidate.englishPrompt, nestedRevision.englishPrompt);

const largeLeftPrompt = Array.from(
  { length: 5_000 },
  (_, index) => `左侧镜头 ${index}`,
).join('\n');
const largeRightPrompt = Array.from(
  { length: 5_000 },
  (_, index) => `右侧镜头 ${index}`,
).join('\n');
const largeComparisonStartedAt = performance.now();
const largeComparison = comparePromptText(largeLeftPrompt, largeRightPrompt);
const largeComparisonElapsedMs = performance.now() - largeComparisonStartedAt;
assert.equal(largeComparison.removed.length, 5_000);
assert.equal(largeComparison.added.length, 5_000);
assert.ok(
  largeComparisonElapsedMs < 250,
  `large prompt comparison must stay interactive; received ${Math.round(largeComparisonElapsedMs)}ms`,
);

const orderedCommonLines = Array.from(
  { length: 1_100 },
  (_, index) => `共同镜头 ${index}`,
);
const movedLineComparison = comparePromptText(
  ['移动行', ...orderedCommonLines].join('\n'),
  [...orderedCommonLines, '移动行'].join('\n'),
);
assert.deepEqual(
  movedLineComparison.unchanged,
  orderedCommonLines,
  'large diff matching must not let one moved line hide the ordered common body',
);
assert.deepEqual(movedLineComparison.removed, ['移动行']);
assert.deepEqual(movedLineComparison.added, ['移动行']);

const repeatedCommonLines = Array.from({ length: 1_001 }, () => '重复镜头');
const repeatedMovedLineComparison = comparePromptText(
  ['移动行', ...repeatedCommonLines].join('\n'),
  [...repeatedCommonLines, '移动行'].join('\n'),
);
assert.equal(
  repeatedMovedLineComparison.unchanged.length,
  repeatedCommonLines.length,
  'large repeated input must keep its common body when one boundary line moves',
);
assert.deepEqual(repeatedMovedLineComparison.removed, ['移动行']);
assert.deepEqual(repeatedMovedLineComparison.added, ['移动行']);
assert.deepEqual(
  repeatedMovedLineComparison.entries
    .filter((entry) => entry.type !== 'added')
    .map((entry) => entry.text),
  ['移动行', ...repeatedCommonLines],
  'large diff entries must reconstruct the left input in order',
);
assert.deepEqual(
  repeatedMovedLineComparison.entries
    .filter((entry) => entry.type !== 'removed')
    .map((entry) => entry.text),
  [...repeatedCommonLines, '移动行'],
  'large diff entries must reconstruct the right input in order',
);

console.log('storyboard A/B candidate revision-shape tests passed');
