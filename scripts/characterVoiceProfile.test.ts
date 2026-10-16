import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCharacterVoiceProfile, updateCharacterVoiceProfile } from '../src/characterVoiceProfile';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';

test('voice profiles retain explicit content, validate revisions and reject empty/unknown fields', () => {
  for (const value of [undefined, null, [], '', 7, {}, { version: 9, source: 'manual' }, { timbre: '  ', perceivedAge: 18 }]) {
    assert.equal(normalizeCharacterVoiceProfile(value), undefined);
  }
  assert.deepEqual(normalizeCharacterVoiceProfile({ version: 3, perceivedAge: ' 年轻女性 ', timbre: ' 清亮 ', language: ' 普通话 ',
    accent: ' 标准 ', style: ' 从容 ', notes: ' 情绪独立 ', referenceAssetId: ' audio-a ', source: 'reference', invented: '忽略' }),
  { version: 3, perceivedAge: '年轻女性', timbre: '清亮', language: '普通话', accent: '标准', style: '从容', notes: '情绪独立', referenceAssetId: 'audio-a', source: 'reference' });
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.deepEqual(normalizeCharacterVoiceProfile({ version, timbre: '明亮', source: 'unknown' }), { version: 1, timbre: '明亮' });
  }
});

test('voice profile revisions change only for saved meaningful changes', () => {
  const first = updateCharacterVoiceProfile(undefined, { version: 80, timbre: '清亮', source: 'manual' })!;
  assert.equal(first.version, 1);
  const unchanged = updateCharacterVoiceProfile(first, { version: 99, timbre: ' 清亮 ', source: 'manual', unknown: 'x' })!;
  assert.deepEqual(unchanged, first);
  const changed = updateCharacterVoiceProfile(first, { timbre: '清亮轻盈', source: 'manual' })!;
  assert.equal(changed.version, 2);
  assert.equal(updateCharacterVoiceProfile(changed, { version: 100, source: 'manual', timbre: ' ' }), undefined);
  assert.equal(updateCharacterVoiceProfile(changed, undefined), undefined);
  assert.equal(updateCharacterVoiceProfile(undefined, { perceivedAge: '年轻成人' })?.version, 1);
});

test('explicit voice profiles survive save/reload without changing revisions or voice presets', () => {
  const state = createInitialState();
  const profile = { version: 4, perceivedAge: '18—22岁年轻女性', timbre: '清亮轻盈', referenceAssetId: 'audio-imported-later', source: 'manual' as const };
  state.project.characters[0] = { ...state.project.characters[0], apparentAge: '18岁', actualAge: '280岁', voiceProfile: profile };
  state.project.voicePresets = { characters: { [state.project.characters[0].id]: { assetId: 'execution-audio', retainMode: 'reference' } } };
  state.projects = [state.project];
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.deepEqual(reloaded.project.characters[0].voiceProfile, profile);
  assert.deepEqual(reloaded.project.voicePresets, state.project.voicePresets);
  assert.deepEqual(normalizeState(reloaded).project.characters[0].voiceProfile, profile);
});

test('legacy projects and explicitly cleared voices never acquire an inferred or inherited identity', () => {
  const state = createInitialState();
  const actor = { ...state.project.characters[0], apparentAge: '18岁', actualAge: '280岁' };
  delete actor.voiceProfile;
  state.project.characters = [actor]; state.projects = [state.project];
  const legacy = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(legacy.project.characters[0].voiceProfile, undefined);
  assert.equal(Object.hasOwn(legacy.project.characters[0], 'voiceProfile'), false);
  actor.voiceProfile = { version: 2, timbre: '母项目音色' };
  const partial = normalizeState({ ...state, projects: [{ id: 'imported', name: '导入旧项目', characters: [{ ...actor, voiceProfile: undefined }], assets: [] }] });
  assert.equal(partial.projects.find((project) => project.id === 'imported')?.characters[0].voiceProfile, undefined);
  state.project.characters = [{ ...actor, voiceProfile: updateCharacterVoiceProfile(actor.voiceProfile, undefined) }];
  state.projects = [state.project];
  const cleared = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(cleared.project.characters[0].voiceProfile, undefined);
  assert.equal(Object.hasOwn(cleared.project.characters[0], 'voiceProfile'), false);
});
