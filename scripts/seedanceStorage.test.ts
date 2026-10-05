import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION,
  createInitialState,
  normalizeState,
  serializeStateForStorage,
} from '../src/storage';

const validSeedanceOutput = {
  targetId: 'seedance-2.5' as const,
  promptZh: '中文 Seedance 官方稿',
  promptEn: 'English Seedance official prompt',
  durationSec: 45,
  sourceFingerprint: 'seedance-source-fingerprint',
  referenceManifest: [{ token: '@Image 1', assetId: 'asset-1' }],
  warnings: [],
  generatedAt: 1_800_000_000_000,
  englishSourceFingerprint: 'seedance-source-fingerprint',
};

const makeState = (storyboards: unknown[]) => {
  const initial = createInitialState();
  return normalizeState({
    ...initial,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      ...initial.project,
      storyboards,
    },
  });
};

const boardFrom = (seedance25Output?: unknown, revisions?: unknown[]) => ({
  id: 'seedance-storage-board',
  name: 'Seedance storage test',
  workflow: 'all',
  finalPrompt: '镜头从左向右移动。',
  durationSec: 45,
  ...(seedance25Output === undefined ? {} : { seedance25Output }),
  ...(revisions === undefined ? {} : { revisions }),
});

// A valid bilingual output survives normalize + serialized persistence,
// including a revision snapshot and the custom duration.
const persisted = makeState([
  boardFrom(validSeedanceOutput, [{ id: 'revision-1', seedance25Output: validSeedanceOutput }]),
]);
const persistedBoard = persisted.project.storyboards[0] as any;
assert.deepEqual(persistedBoard.seedance25Output, validSeedanceOutput);
assert.deepEqual(persistedBoard.revisions[0].seedance25Output, validSeedanceOutput);
const serialized = serializeStateForStorage(persisted).serialized;
const reloadedBoard = normalizeState(JSON.parse(serialized)).project.storyboards[0] as any;
assert.deepEqual(reloadedBoard.seedance25Output, validSeedanceOutput);
assert.deepEqual(reloadedBoard.revisions[0].seedance25Output, validSeedanceOutput);

// Older projects have no Seedance field and must remain field-free after
// normalization instead of inheriting a fallback value.
const legacyBoard = makeState([boardFrom()]).project.storyboards[0] as any;
assert.equal(Object.prototype.hasOwnProperty.call(legacyBoard, 'seedance25Output'), false);

// Malformed output is discarded at both board and revision levels. In
// particular, an invalid value must not leak back through the board spread.
const invalidBoard = makeState([
  boardFrom({ targetId: 'seedance-2.5', promptZh: '缺少 fingerprint' }, [
    { id: 'revision-invalid', seedance25Output: { targetId: 'other-model', promptZh: '错误数据' } },
  ]),
]).project.storyboards[0] as any;
assert.equal(Object.prototype.hasOwnProperty.call(invalidBoard, 'seedance25Output'), false);
assert.equal(Object.prototype.hasOwnProperty.call(invalidBoard.revisions[0], 'seedance25Output'), false);

// An optional English value with the wrong type is removed while the valid
// Chinese output remains usable.
const chineseOnly = makeState([
  boardFrom({ ...validSeedanceOutput, promptEn: 123 }),
]).project.storyboards[0] as any;
assert.equal(chineseOnly.seedance25Output.promptEn, undefined);
assert.equal(chineseOnly.seedance25Output.promptZh, validSeedanceOutput.promptZh);

console.log('seedance storage normalization tests passed');
