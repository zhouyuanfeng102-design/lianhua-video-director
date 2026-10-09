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

// Historical artifacts remain literal evidence. This fix changes new
// compilation/validation, not loading or rewriting previously saved text.
const historicalRuleEcho = {
  ...validSeedanceOutput,
  promptZh: '历史中文稿\n转换器 智能导演：requiredDialogues逐句保留完整对白。\n转换器输出：不要输出规则解释。',
  promptEn: 'Historical English source; preserve this saved original.',
};
const unchangedHistoricalRuleEcho = structuredClone(historicalRuleEcho);
const historicalPromptPlan = {
  canonicalPrompt: '镜头从左向右移动。', durationSec: 45, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  workflow: 'all', inputMode: 'text', shotIds: [], referenceAssetIds: [],
  constraints: ['制作要求：保留晨光。', '转换器 智能导演：requiredDialogues逐句保留完整对白。', '转换器输出：不要输出规则解释。'],
  trace: { ruleSetId: 'historical-rules', converterId: 'historical-converter' },
};
const historicalState = makeState([{
  ...boardFrom(historicalRuleEcho, [{ id: 'historical-rule-echo', seedance25Output: historicalRuleEcho }]),
  promptPlan: historicalPromptPlan,
}]);
const historicalReload = normalizeState(JSON.parse(serializeStateForStorage(historicalState).serialized)).project.storyboards[0];
assert.deepEqual(historicalReload.seedance25Output, unchangedHistoricalRuleEcho, 'loading must not silently delete or rewrite an old Seedance source');
assert.deepEqual(historicalReload.revisions?.[0].seedance25Output, unchangedHistoricalRuleEcho, 'saved revisions preserve the original evidence too');
assert.deepEqual(historicalRuleEcho, unchangedHistoricalRuleEcho);
assert.equal(historicalReload.promptPlan?.canonicalPrompt, historicalPromptPlan.canonicalPrompt);
assert.deepEqual(historicalReload.promptPlan?.constraints, historicalPromptPlan.constraints, 'loading does not silently rewrite the historical source plan either');

console.log('seedance storage normalization tests passed');
