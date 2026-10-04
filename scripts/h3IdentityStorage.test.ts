import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import { normalizeH3IdentityBindings } from '../src/h3IdentityBindings';
import { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { hasCurrentTextApiConversion, isSequenceSegmentComplete } from '../src/appEffects';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AudioCue, H3IdentityBindings, Storyboard } from '../src/types';

// Synthetic text only: never reads or migrates a user's project on disk.
const bindings: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'adult-a', name: '成年甲', subjectToken: '<Subject 1>', speakerToken: '(S1)',
    referenceAnchor: 'Identity: 成年甲 (S1), 蓝外套。' },
  { characterId: 'adult-b', name: '成年乙', subjectToken: '<Subject 2>',
    referenceAnchor: 'Identity: 成年乙, 白外套。' },
] };
const englishBindings: H3IdentityBindings = { version: 1, characters: bindings.characters.map((entry) => ({
  ...entry, referenceAnchor: entry.referenceAnchor.replace('蓝外套。', 'blue coat.').replace('白外套。', 'white coat.'),
})) };
const board: Storyboard = {
  id: 'h3-storage-test', sceneId: 'scene', workflow: 'drama', inputMode: 'text', durationSec: 15,
  durationPreset: '15s', shotMode: 'auto', shotCount: 1, pace: 'standard', aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '',
  globalLock: '', finalPrompt: '保留原稿的空白\r\n与文字  ',
  officialPromptZh: 'video_generation_prompt: [Shot 1] Identity: 成年甲 (S1), 蓝外套。\r\n保留原稿  ',
  officialPromptEn: 'video_generation_prompt: [Shot 1] Identity: 成年甲 (S1), blue coat.\nOriginal  ',
  h3IdentityBindings: bindings, h3IdentityBindingsEn: englishBindings,
  shots: [{ id: 'shot-a', index: 1, startSec: 0, endSec: 15, subject: '成年甲', action: '交谈',
    purpose: '确认路线', camera: '中景', lighting: '日光', sound: '原声音', result: '', transition: '',
    dialogue: '成年甲：请带上地图。', referenceAssetIds: [], locked: false, prompt: '原镜头完整稿' }],
  audioLedger: [{ id: 'voice-a', kind: 'dialogue', label: '原对白', speaker: '成年甲',
    text: '请带上地图。', startSec: 2, endSec: 5 }],
  createdAt: 1, updatedAt: 2,
};
const clone = <T>(value: T): T => structuredClone(value);
let passed = 0;
const test = (name: string, run: () => void): void => { run(); passed += 1; console.log(`PASS ${name}`); };
const persist = (value: Storyboard): Storyboard => {
  const state = createInitialState();
  state.project = { ...state.project, id: 'isolated-h3-project', storyboards: [value] };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  return normalizeState(JSON.parse(serializeStateForStorage(state).serialized)).project.storyboards[0];
};

test('both language identity bindings survive normalized storage without rewriting prompt bytes', () => {
  const saved = persist(clone(board));
  assert.deepEqual(saved.h3IdentityBindings, bindings);
  assert.deepEqual(saved.h3IdentityBindingsEn, englishBindings);
  assert.equal(saved.finalPrompt, board.finalPrompt);
  assert.equal(saved.officialPromptZh, board.officialPromptZh);
  assert.equal(saved.officialPromptEn, board.officialPromptEn);
  assert.deepEqual(saved.audioLedger, board.audioLedger);
});

test('revision snapshots clone identities, shots and audio and survive reload', () => {
  const current = clone(board);
  const revision = createStoryboardRevision(current, { createdAt: 10 });
  const before = clone(revision);
  current.h3IdentityBindings!.characters[0].referenceAnchor = 'later identity';
  current.h3IdentityBindingsEn!.characters[0].referenceAnchor = 'later English identity';
  current.audioLedger![0].startSec = 9;
  current.shots[0].prompt = 'later shot';
  assert.deepEqual(revision, before);
  const loaded = persist({ ...current, revisions: [revision] }).revisions![0];
  assert.deepEqual(loaded.h3IdentityBindings, bindings);
  assert.deepEqual(loaded.h3IdentityBindingsEn, englishBindings);
  assert.deepEqual(loaded.audioLedger, board.audioLedger);
  assert.equal(loaded.shotCount, 1); assert.equal(loaded.durationSec, 15);
});

test('restoring a revision restores matching identities, count and voice windows independently', () => {
  const revision = createStoryboardRevision(clone(board));
  const current = { ...clone(board), shots: board.shots.map((shot) => ({ ...shot })), shotCount: 4, durationSec: 60,
    audioLedger: [{ id: 'later', kind: 'silence', label: 'later layout' }] as AudioCue[] };
  const restored = restoreStoryboardRevisionSnapshot(current, revision);
  assert.equal(restored.shotCount, 1); assert.equal(restored.durationSec, 15);
  assert.deepEqual(restored.h3IdentityBindings, bindings);
  assert.deepEqual(restored.h3IdentityBindingsEn, englishBindings);
  assert.deepEqual(restored.audioLedger, board.audioLedger);
  restored.audioLedger![0].startSec = 10;
  restored.h3IdentityBindings!.characters[0].referenceAnchor = 'modified after restore';
  restored.shots[0].prompt = 'modified after restore';
  assert.equal(revision.audioLedger![0].startSec, 2);
  assert.equal(revision.h3IdentityBindings!.characters[0].referenceAnchor, bindings.characters[0].referenceAnchor);
  assert.equal(revision.shots[0].prompt, board.shots[0].prompt);
});

test('legacy restore clears later identities and audio instead of attaching them to old text', () => {
  const revision = createStoryboardRevision(clone(board));
  delete revision.h3IdentityBindings; delete revision.h3IdentityBindingsEn;
  delete revision.shotMode; delete revision.recommendedShotCount;
  delete revision.shotCount; delete revision.durationSec; delete revision.audioLedger;
  const restored = restoreStoryboardRevisionSnapshot({ ...clone(board), shots: board.shots.map((shot) => ({ ...shot })), shotCount: 8 }, revision);
  assert.equal(restored.h3IdentityBindings, undefined); assert.equal(restored.h3IdentityBindingsEn, undefined);
  assert.equal(restored.audioLedger, undefined); assert.equal(restored.shotCount, 1);
  assert.equal(restored.finalPrompt, board.finalPrompt);
  assert.equal(restored.officialPromptZh, board.officialPromptZh);
});

test('legacy persistence never fabricates identities or rewrites old text', () => {
  const legacy = clone(board);
  delete legacy.h3IdentityBindings; delete legacy.h3IdentityBindingsEn;
  const saved = persist(legacy);
  assert.equal(saved.h3IdentityBindings, undefined); assert.equal(saved.h3IdentityBindingsEn, undefined);
  assert.equal(saved.officialPromptZh, legacy.officialPromptZh);
  assert.equal(saved.finalPrompt, legacy.finalPrompt);
});

test('malformed optional metadata is dropped without becoming a text migration or content gate', () => {
  assert.equal(normalizeH3IdentityBindings({ version: 1, characters: 'not-an-array' }), undefined);
  const malformed = clone(board);
  malformed.h3IdentityBindings = { version: 2, characters: [] } as unknown as H3IdentityBindings;
  const saved = persist(malformed);
  assert.equal(saved.h3IdentityBindings, undefined);
  assert.deepEqual(saved.h3IdentityBindingsEn, englishBindings);
  assert.equal(saved.officialPromptZh, malformed.officialPromptZh);
  assert.equal(saved.finalPrompt, malformed.finalPrompt);
});

const apiCompleteBoard = (): Storyboard => {
  const canonicalPrompt = '【0s-15s】主体：@成年甲 正在 [站在桌旁交谈]；空间：原桌旁；光影：日光；镜头：中景；台词：成年甲 第2-5秒：“请带上地图。”；音效：无';
  const current = clone(board);
  return applyOfficialH3Prompt({
    ...current, finalPrompt: canonicalPrompt, sequencePlanId: 'saved-plan', segmentId: 'saved-segment',
    shots: current.shots.map((shot) => ({ ...shot, prompt: canonicalPrompt })),
    promptPlan: { canonicalPrompt, durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      workflow: 'drama', inputMode: 'text', shotIds: ['shot-a'], referenceAssetIds: [],
      constraints: ['画幅16:9', '导演风格自然'], trace: { ruleSetId: 'test-rule', converterId: 'test-converter' } },
    promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(canonicalPrompt),
      modelRuleSetId: 'test-rule', converterPresetId: 'test-converter', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1 },
  }, { assets: [], characters: [] });
};

test('new revisions persist independent adapter inputs and exact API provenance across reload', () => {
  const current = apiCompleteBoard();
  const revision = createStoryboardRevision(current);
  const expectedPlan = clone(current.promptPlan); const expectedTrace = clone(current.promptTrace);
  current.promptPlan!.constraints.push('later controls');
  current.promptTrace!.sourceDocumentIds.push('later-source');
  const saved = persist({ ...current, revisions: [revision] }).revisions![0];
  assert.deepEqual(saved.promptPlan, expectedPlan); assert.deepEqual(saved.promptTrace, expectedTrace);
  assert.deepEqual(revision.promptPlan, expectedPlan); assert.deepEqual(revision.promptTrace, expectedTrace);
});

test('restoring matching new plan/trace keeps the exact H3 fingerprint and sequence completion usable', () => {
  const original = apiCompleteBoard();
  const saved = createStoryboardRevision(original);
  const loaded = persist({ ...original, revisions: [saved] }).revisions![0];
  const revision = { ...saved, ...loaded, shots: (loaded.shots || []).map((shot) => ({ ...shot })) };
  const current = { ...original, shots: original.shots.map((shot) => ({ ...shot })),
    promptPlan: { ...original.promptPlan!, constraints: ['later unrelated constraints'] },
    promptTrace: { ...original.promptTrace!, convertedPromptFingerprint: 'later-unrelated-fingerprint' } };
  const restored = restoreStoryboardRevisionSnapshot(current, revision);
  assert.equal(hasCurrentOfficialH3Prompt(restored, { assets: [], characters: [] }), true);
  assert.equal(hasCurrentTextApiConversion(restored), true);
  assert.equal(isSequenceSegmentComplete({ id: 'saved-segment', status: 'ready', storyboardId: restored.id }, [restored], 'saved-plan'), true);
  assert.equal(restored.officialPromptZh, original.officialPromptZh);
  assert.equal(restored.officialPromptSource, original.officialPromptSource);
  restored.promptPlan!.constraints.push('edit after restore');
  restored.promptTrace!.sourceDocumentIds.push('edit-after-restore');
  assert.deepEqual(revision.promptPlan, original.promptPlan);
  assert.deepEqual(revision.promptTrace, original.promptTrace);
});

test('legacy revisions without plan/trace clear current evidence and cannot gain an AI-complete claim', () => {
  const current = apiCompleteBoard();
  const revision = createStoryboardRevision(current);
  delete revision.promptPlan; delete revision.promptTrace;
  const restored = restoreStoryboardRevisionSnapshot({ ...current, shots: current.shots.map((shot) => ({ ...shot })) }, revision);
  assert.equal(restored.promptPlan, undefined); assert.equal(restored.promptTrace, undefined);
  assert.equal(hasCurrentTextApiConversion(restored), false);
  assert.equal(isSequenceSegmentComplete({ id: 'saved-segment', status: 'ready', storyboardId: restored.id }, [restored], 'saved-plan'), false);
  assert.equal(restored.officialPromptZh, current.officialPromptZh);
});

test('new auto-count revisions persist and restore absent user count independently of AI recommendation', () => {
  const original = { ...clone(board), shotMode: 'auto' as const, shotCount: undefined, recommendedShotCount: 3,
    shots: [0, 1, 2].map((index) => ({ ...clone(board.shots[0]), id: `before-${index}` })) };
  const repaired = { ...original, recommendedShotCount: 4,
    shots: [0, 1, 2, 3].map((index) => ({ ...clone(board.shots[0]), id: `after-${index}` })) };
  const before = createStoryboardRevision(original);
  const after = createStoryboardRevision(repaired, [before]);
  const loaded = persist({ ...repaired, revisions: [before, after] }).revisions!;
  const restore = (current: typeof repaired, index: number) => restoreStoryboardRevisionSnapshot(current,
    { ...loaded[index], storyboardId: board.id, revision: index + 1, shots: loaded[index].shots!.map((shot) => ({ ...shot })) });
  const restoredBefore = restore(repaired, 0);
  assert.equal(restoredBefore.shotMode, 'auto'); assert.equal(restoredBefore.shotCount, undefined);
  assert.equal(restoredBefore.recommendedShotCount, 3); assert.equal(restoredBefore.shots.length, 3);
  const restoredAfter = restore(restoredBefore, 1);
  assert.equal(restoredAfter.shotMode, 'auto'); assert.equal(restoredAfter.shotCount, undefined);
  assert.equal(restoredAfter.recommendedShotCount, 4); assert.equal(restoredAfter.shots.length, 4);
  const configured = createStoryboardRevision({ ...original, shotCount: 7, recommendedShotCount: undefined });
  const restoredConfigured = restoreStoryboardRevisionSnapshot(repaired, configured);
  assert.equal(restoredConfigured.shotCount, 7, 'auto mode preserves a saved inactive exact-count setting');
  assert.equal(restoredConfigured.recommendedShotCount, undefined, 'new snapshots do not borrow a later AI recommendation');
});

console.log(`H3 identity storage/revision tests passed: ${passed}`);
