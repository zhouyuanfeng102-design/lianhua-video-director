import assert from 'node:assert/strict';
import { normalizeState, serializeStateForStorage, createInitialState } from '../src/storage';
import { stampCharacterParticipation, resolveStoryboardCharacterParticipation } from '../src/characterParticipation';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import { repairH3IdentityBindings } from '../src/h3IdentityRepair';
import { commitH3IdentityRepair } from '../src/h3IdentityRepairCommit';
import { getH3IdentityBindingIssues } from '../src/h3IdentityBindings';
import { hasCurrentOfficialH3EnglishPrompt } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { makeIdentityRepairProject, identityRepairResultFor } from './h3IdentityRepairCommit.test';

// Persistence, revision restoration and explicit repair are the only write
// boundaries in this test. Every project is synthetic; no disk profile/API.
const state = createInitialState();
state.project = makeIdentityRepairProject();
state.projects = [state.project];
state.activeProjectId = state.project.id;
const source = state.project.storyboards[1];
source.h3CharacterParticipation = stampCharacterParticipation(source.officialPromptZh!, {
  version: 1, characters: [{ characterId: 'amu', name: '阿沐', presence: 'visible', shotIndex: 1,
    evidence: '阿沐', speaking: true }],
});
source.revisions = [createStoryboardRevision(source, [], { id: 'participation-revision', createdAt: 1 })];
const normalized = normalizeState(state);
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(normalized).serialized));
const saved = reloaded.project.storyboards.find((board) => board.id === source.id)!;
assert.deepEqual(saved.h3CharacterParticipation, source.h3CharacterParticipation);
assert.deepEqual(saved.revisions![0].h3CharacterParticipation, source.h3CharacterParticipation);
assert.equal(saved.officialPromptZh, source.officialPromptZh);
assert.equal(saved.officialPromptEn, source.officialPromptEn);
assert.deepEqual(normalizeState(normalized), normalized, 'new optional metadata remains normalization-idempotent');

const revision = createStoryboardRevision(source, [], { id: 'new-cast' });
const restored = restoreStoryboardRevisionSnapshot({ ...source, h3CharacterParticipation: undefined }, revision);
assert.deepEqual(restored.h3CharacterParticipation, source.h3CharacterParticipation);
const legacyRevision = createStoryboardRevision({ ...source, h3CharacterParticipation: undefined }, [], { id: 'old-cast' });
assert.equal(restoreStoryboardRevisionSnapshot(source, legacyRevision).h3CharacterParticipation, undefined,
  'restoring an old revision cannot carry newer cast metadata into old text');
const before = JSON.stringify(state.project);
const repaired = commitH3IdentityRepair(state.project, source.id, {
  zh: identityRepairResultFor(source, 'zh'), en: identityRepairResultFor(source, 'en'),
});
const result = repaired.storyboards[1];
assert.equal(JSON.stringify(state.project), before);
assert.notEqual(result.h3CharacterParticipation!.promptFingerprint, source.h3CharacterParticipation.promptFingerprint);
assert.deepEqual(result.h3CharacterParticipation!.characters, source.h3CharacterParticipation.characters);
assert.equal(resolveStoryboardCharacterParticipation(result, repaired.characters, result.officialPromptZh!).usedFallback, false);
assert.equal(hasCurrentOfficialH3EnglishPrompt(result, officialH3ContextForStoryboard(repaired, result)), true);

const latePrompt = 'integrated_multimodal_description: [Shot 1] A quiet empty corridor.\n[Shot 2] At 00:02.000 Alice stands by the door.\n[Shot 3] At 00:04.000 Bob walks into the corridor.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
const lateCharacters = [{ id: 'alice', name: '爱丽丝' }, { id: 'bob', name: '鲍勃' }];
const lateResult = await repairH3IdentityBindings({ prompt: latePrompt, characters: lateCharacters, language: '英文',
  targetCharacterIds: ['alice', 'bob'], request: async () => JSON.stringify({ characters: [
    { characterId: 'alice', name: '爱丽丝', referenceAnchor: 'Identity: 爱丽丝.', insertIdentitySentence: 'Identity: 爱丽丝.',
      inPromptEvidence: 'Alice stands by the door.' },
    { characterId: 'bob', name: '鲍勃', referenceAnchor: 'Identity: 鲍勃.', insertIdentitySentence: 'Identity: 鲍勃.',
      inPromptEvidence: 'Bob walks into the corridor.' },
  ] }),
});
assert.equal(lateResult.edits.length, 2);
assert.match(lateResult.prompt, /\[Shot 2\] At 00:02\.000\nIdentity: 爱丽丝\./u);
assert.match(lateResult.prompt, /\[Shot 3\] At 00:04\.000\nIdentity: 鲍勃\./u);
assert.deepEqual(getH3IdentityBindingIssues(lateResult.prompt, lateResult.identityBindings, lateCharacters), []);
let undo = lateResult.prompt;
let shift = 0;
for (const edit of [...lateResult.edits].sort((a, b) => a.start - b.start)) {
  assert.equal(undo.slice(edit.start, edit.start + edit.text.length), edit.text);
  undo = undo.slice(0, edit.start) + undo.slice(edit.start + edit.text.length);
  shift += edit.text.length;
}
assert.equal(undo, latePrompt, 'per-shot identity repair keeps every original source byte');
assert.ok(shift > 0);
console.log('character participation persistence: normalization, paired language, revisions, atomic repair and late-shot insertions passed');
