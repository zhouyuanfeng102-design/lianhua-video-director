import assert from 'node:assert/strict';
import { applyOfficialH3Prompt, getOfficialH3SubmissionIssue, hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { normalizeH3DeliveryWarnings, storyboardH3DeliveryWarnings } from '../src/h3DeliveryWarnings';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import type { Storyboard } from '../src/types';

// All data are synthetic. No app profile or provider request is used.
const source: Storyboard = {
  id: 'delivery-availability', sceneId: 'scene', workflow: 'drama', inputMode: 'text', durationSec: 5,
  durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '',
  globalLock: '', finalPrompt: '【0s-5s】主体：阿青；空间：院子；动作：走向门口；光影：日光；镜头：中景；台词：无；音效：脚步。',
  shots: [{ id: 'shot-1', index: 1, startSec: 0, endSec: 5, subject: '阿青', action: '走向门口', camera: '中景',
    lighting: '日光', sound: '脚步', referenceAssetIds: [], prompt: '阿青走向门口。', locked: false }],
  createdAt: 1, updatedAt: 1,
};
const context = { assets: [], characters: [], locations: [], props: [] };
const compiled = applyOfficialH3Prompt(source, context);
// The exact AI text is authoritative even when its typography does not match
// the old local protocol checker and auxiliary records are missing.
const zh = '[Shot5] 阿青走向门口，停步。\r\n';
const en = '[Shot5] A Qing walks to the gate and stops.\n';
const board: Storyboard = {
  ...compiled, officialPromptZh: zh, officialPromptEn: en, officialPromptEnSource: zh,
  targetOutput: { ...compiled.targetOutput!, prompt: zh },
  h3IdentityBindings: undefined, h3CharacterParticipation: undefined,
  h3DeliveryWarnings: ['人物关联待完善'], h3DeliveryWarningsEn: ['英文时间轴待完善'],
};
assert.equal(hasCurrentOfficialH3Prompt(board, context), true);
assert.equal(hasCurrentOfficialH3EnglishPrompt(board, context), true);
for (const language of ['zh', 'en'] as const) {
  assert.equal(getOfficialH3SubmissionIssue({ model: 'minimax-h3', prompt: language === 'zh' ? zh : en }, board, context, language), undefined);
}
assert.equal(hasCurrentOfficialH3Prompt({ ...board, officialPromptSource: 'wrong-project-source' }, context), false);
assert.equal(hasCurrentOfficialH3EnglishPrompt({ ...board, officialPromptEnSource: 'another Chinese draft' }, context), false);
assert.equal(hasCurrentOfficialH3Prompt({ ...board, officialPromptZh: ' ' }, context), false);
assert.match(getOfficialH3SubmissionIssue({ model: 'minimax-h3', prompt: 'unrelated request' }, board, context)!, /不是当前官方/);
assert.deepEqual(storyboardH3DeliveryWarnings(board, 'zh'), ['人物关联待完善']);
assert.deepEqual(storyboardH3DeliveryWarnings(board, 'en'), ['中文交付：人物关联待完善', '英文时间轴待完善']);
assert.deepEqual(storyboardH3DeliveryWarnings({ ...board, h3DeliveryWarningsEn: undefined }, 'en'), ['中文交付：人物关联待完善']);
assert.deepEqual(normalizeH3DeliveryWarnings([' 提醒 ', null, 1, '', '提醒']), ['提醒']);

const revision = createStoryboardRevision(board, [], { id: 'saved-warning' });
board.h3DeliveryWarnings!.push('later notice');
assert.deepEqual(revision.h3DeliveryWarnings, ['人物关联待完善']);
const restored = restoreStoryboardRevisionSnapshot(board, revision);
assert.deepEqual(restored.h3DeliveryWarnings, ['人物关联待完善']);
assert.deepEqual(restored.h3DeliveryWarningsEn, ['英文时间轴待完善']);
const legacy = createStoryboardRevision({ ...board, h3DeliveryWarnings: undefined, h3DeliveryWarningsEn: undefined });
assert.deepEqual(storyboardH3DeliveryWarnings(restoreStoryboardRevisionSnapshot(board, legacy)), [], 'legacy restoration clears newer notices');

const state = createInitialState();
state.project = { ...state.project, id: 'isolated-delivery-test', storyboards: [{ ...restored, revisions: [revision] }] };
state.projects = [state.project]; state.activeProjectId = state.project.id;
const normalized = normalizeState(state);
const saved = normalizeState(JSON.parse(serializeStateForStorage(normalized).serialized)).project.storyboards[0];
assert.deepEqual(saved.h3DeliveryWarnings, restored.h3DeliveryWarnings);
assert.deepEqual(saved.h3DeliveryWarningsEn, restored.h3DeliveryWarningsEn);
assert.deepEqual(saved.revisions![0].h3DeliveryWarnings, revision.h3DeliveryWarnings);
assert.deepEqual(saved.revisions![0].h3DeliveryWarningsEn, revision.h3DeliveryWarningsEn);
assert.equal(saved.officialPromptZh, zh); assert.equal(saved.officialPromptEn, en);
assert.deepEqual(normalizeState(normalized), normalized);
console.log('PASS saved bilingual H3 remains available with notices and missing auxiliary data; source safety and notice persistence remain intact');
