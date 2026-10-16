import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteAssetFromProject } from '../src/assetDeletion';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { materializeSemanticSequencePlan, semanticSequenceCharacters, semanticSequenceSourceFingerprint, semanticSegmentSourceContext } from '../src/semanticSequencePlan';
import type { SemanticSequencePlanningInput, SemanticSequenceResponse } from '../src/semanticSequencePlan';
import type { VideoGenerationTask } from '../src/types';

test('semantic planning freezes voices through save/reload without borrowing later live changes', () => {
  const state = createInitialState();
  const actor = { ...state.project.characters[0], voiceProfile: { version: 2, perceivedAge: '年轻女性', timbre: '清亮', source: 'manual' as const } };
  const request: SemanticSequencePlanningInput = { title: '声音继承', story: '她说：“回去吧。”', segmentDurationSec: 15,
    directorSettingsFingerprint: 'voice-fixture', creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
    characterContinuity: [actor] };
  const response: SemanticSequenceResponse = { segmentCount: 1, reason: '单句自然说完', fitStatus: 'balanced', segments: [{
    title: '说话', content: request.story, summary: '说话', narrativePurpose: '交谈', entryState: '相对站立', exitState: '听者转身',
    transitionHint: '连续', boundaryReason: '对白结束', continuityPack: '同一人物', semanticSource: {
      sourceEvidence: [{ text: request.story }], events: [{ id: 'e1', description: '发话' }],
      dialogues: [{ id: 'd1', speaker: actor.name, text: '回去吧。', language: '中文' }],
    },
  }] };
  const plan = materializeSemanticSequencePlan(request, response, { planId: 'voice-plan', now: 1 });
  state.project = { ...state.project, characters: [actor], sequencePlans: [plan] }; state.projects = [state.project];
  const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  const saved = reloaded.project.sequencePlans[0];
  assert.deepEqual(saved.semanticPlanningSnapshot?.characterContinuity[0].voiceProfile, actor.voiceProfile);
  assert.deepEqual(semanticSegmentSourceContext(saved, saved.segments[0]).characterContinuity[0].voiceProfile, actor.voiceProfile);
  const changedLive = { ...actor, voiceProfile: { version: 3, timbre: '另一声音' } };
  assert.deepEqual(semanticSequenceCharacters(saved, [changedLive])[0].voiceProfile, actor.voiceProfile);
  const previousFingerprint = semanticSequenceSourceFingerprint(saved);
  const changedPlan = structuredClone(saved);
  changedPlan.semanticPlanningSnapshot!.characterContinuity[0].voiceProfile = changedLive.voiceProfile;
  assert.notEqual(semanticSequenceSourceFingerprint(changedPlan), previousFingerprint);
  const legacy = structuredClone(saved);
  delete legacy.semanticPlanningSnapshot!.characterContinuity[0].voiceProfile;
  assert.equal(semanticSequenceCharacters(legacy, [changedLive])[0].voiceProfile, undefined);
});

test('deleting a voice sample detaches current choices while preserving voice text and frozen task history', () => {
  const state = createInitialState();
  const actor = { ...state.project.characters[0], voiceProfile: { version: 2, timbre: '清亮', referenceAssetId: 'voice-sample', source: 'manual' as const } };
  const history = { id: 'saved-video', kind: 'video', name: '旧任务', status: 'succeeded', model: 'fixture', request: '', createdAt: 1, updatedAt: 1,
    requestBody: { prompt: '旧对白与声线' }, videoJob: { stage: 'succeeded', snapshot: { audios: [{ assetId: 'voice-sample', checksum: 'original' }] } } } as unknown as VideoGenerationTask;
  const project = { ...state.project, characters: [actor], assets: [{ id: 'voice-sample', name: '样音', type: 'audio' as const,
    role: 'audio' as const, mediaType: 'audio' as const, tags: [], createdAt: 1, updatedAt: 1 }], generationTasks: [history],
    voicePresets: { characters: { [actor.id]: { assetId: 'voice-sample' } } } };
  const original = JSON.stringify(project);
  const result = deleteAssetFromProject(project, 'voice-sample', 2);
  assert.deepEqual(result.characters[0].voiceProfile, { version: 3, timbre: '清亮', source: 'manual' });
  assert.equal(result.voicePresets?.characters[actor.id], undefined);
  assert.deepEqual(result.generationTasks, project.generationTasks);
  assert.equal(JSON.stringify(project), original);
  const sampleOnly = { ...project, characters: [{ ...actor, voiceProfile: { version: 2, referenceAssetId: 'voice-sample' } }] };
  assert.equal(deleteAssetFromProject(sampleOnly, 'voice-sample', 2).characters[0].voiceProfile, undefined);
});
