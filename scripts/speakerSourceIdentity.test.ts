import assert from 'node:assert/strict';
import {
  materializeSemanticSequencePlan, normalizeSemanticSegmentSource, semanticSegmentSourceContext,
} from '../src/semanticSequencePlan';
import { normalizeH3IdentityBindings } from '../src/h3IdentityBindings';
import { inspectH3IdentityBindings } from '../src/h3DeliverySchema';
import type { SemanticSequencePlanningInput, SemanticSequenceResponse } from '../src/semanticSequencePlan';

const dialogue = {
  id: 'line-1', speaker: '莲华', text: '师父，请尝一口。', language: '中文',
  speakerCharacterId: 'lianhua', listenerCharacterIds: ['master'], addressedCharacterIds: ['master'],
};
const source = { sourceEvidence: [{ text: dialogue.text }], events: [], dialogues: [dialogue] };
const normalized = normalizeSemanticSegmentSource(source)!;
assert.deepEqual(normalized, source);
assert.notEqual(normalized.dialogues[0].listenerCharacterIds, dialogue.listenerCharacterIds);
assert.notEqual(normalized.dialogues[0].addressedCharacterIds, dialogue.addressedCharacterIds);
normalized.dialogues[0].listenerCharacterIds!.push('another-listener');
assert.deepEqual(dialogue.listenerCharacterIds, ['master'], 'reader must copy optional arrays without mutating source');

const legacyLine = { id: 'legacy', speaker: '师姐', text: '师父，给你。' };
const legacy = normalizeSemanticSegmentSource({ ...source, dialogues: [legacyLine] })!;
assert.deepEqual(legacy.dialogues, [legacyLine], 'historical fields stay absent; a vocative must not infer speaker or listener IDs');
const emptyLists = { ...dialogue, listenerCharacterIds: [], addressedCharacterIds: [] };
assert.deepEqual(normalizeSemanticSegmentSource({ ...source, dialogues: [emptyLists] })!.dialogues, [emptyLists]);
const unreadableOptional = normalizeSemanticSegmentSource({ ...source, dialogues: [{ ...legacyLine,
  speakerCharacterId: null, listenerCharacterIds: 42, addressedCharacterIds: [false],
}] });
assert.deepEqual(unreadableOptional!.dialogues, [legacyLine], 'unreadable optional metadata adds no rejection condition');

const request: SemanticSequencePlanningInput = {
  title: '称呼与说话人', story: '莲华说：“师父，请尝一口。”', segmentDurationSec: 15,
  directorSettingsFingerprint: 'speaker-source-fixture',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
  characterContinuity: [{ id: 'lianhua', name: '莲华' }, { id: 'master', name: '玄师' }],
};
const authored: SemanticSequenceResponse = {
  segmentCount: 1, reason: '原始分段保持', fitStatus: 'balanced', segments: [{
    title: '分享', content: request.story, summary: '分享', narrativePurpose: '同场对话',
    entryState: '两人同场', exitState: '发话结束', transitionHint: '保持原状态',
    boundaryReason: '原始边界', continuityPack: '原始接续', semanticSource: source,
  }],
};
const plan = materializeSemanticSequencePlan(request, authored, { planId: 'speaker-source', now: 100 });
assert.deepEqual(plan.segments[0].semanticSource, source);
const context = semanticSegmentSourceContext(plan, plan.segments[0]);
assert.deepEqual(context.segment.semanticSource.dialogues, [dialogue]);
assert.equal(plan.segments[0].content, request.story);
assert.equal(plan.segments[0].durationSec, 15);

const identity = { version: 1, characters: [{ characterId: 'lianhua', name: '莲华',
  referenceAnchor: 'Identity: 莲华, a woman in white.', relationship: '玄师的弟子；称玄师为师父。',
}] };
assert.deepEqual(normalizeH3IdentityBindings(identity), identity, 'existing relationship and Chinese original name survive normalization');
const { relationship: _relationship, ...legacyIdentity } = identity.characters[0];
assert.deepEqual(normalizeH3IdentityBindings({ version: 1, characters: [legacyIdentity] })!.characters, [legacyIdentity]);
const unreadableRelationship = inspectH3IdentityBindings({ version: 1, characters: [{ ...legacyIdentity, relationship: 42 }] });
assert.deepEqual(unreadableRelationship.issues, []);
assert.deepEqual(unreadableRelationship.value!.characters, [legacyIdentity]);

const actionRoles = { id: 'wipe', description: '玄师擦去莲华左颊糖汁', causality: {
  actor: '玄师', target: '莲华', action: '擦拭', result: '糖汁擦净', evidence: '玄师伸手擦去糖汁', certainty: 'explicit',
  actorCharacterId: 'master', targetCharacterId: 'lianhua', targetCharacterIds: ['lianhua'],
} };
const actionSource = normalizeSemanticSegmentSource({ ...source, events: [actionRoles] })!;
assert.deepEqual(actionSource.events, [actionRoles]);
assert.notEqual(actionSource.events[0].causality!.targetCharacterIds, actionRoles.causality.targetCharacterIds);
assert.equal(actionSource.events[0].causality!.actorCharacterId, 'master');
assert.equal(actionSource.dialogues[0].speakerCharacterId, 'lianhua', 'an action actor and the speaker remain independent');

console.log('speakerSourceIdentity: explicit dialogue roles, historical compatibility and relationship metadata passed.');
