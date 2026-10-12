import assert from 'node:assert/strict';
import { semanticSegmentIdentityReferenceIds } from '../src/semanticSegmentIdentityReferences';
import { buildGlobalLock } from '../src/promptEngine';
import type { Character, Scene, SemanticSegmentSource } from '../src/types';

const character = (id: string, name: string, aliases: string[] = []): Character => ({
  id, name, aliases, assetIds: [], gender: '女', apparentAge: '', race: '', appearance: '稳定人物外貌',
  outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '',
});
const mare = character('mare', '马雷', ['Mare']);
const akali = character('akali', '阿卡利', ['Akali']);
const absent = character('absent', '其他段人物', ['Elsewhere']);
const characters = [mare, akali, absent];
const source = (patch: Partial<SemanticSegmentSource> = {}): SemanticSegmentSource => ({
  sourceEvidence: [], events: [], dialogues: [], ...patch,
});
const input = (content: string, semanticSource = source()) => ({
  characters, content, segment: { entryState: '', exitState: '', semanticSource },
});

{
  const request = input('马雷语气充满试探，阿卡利只用冰冷的目光回应。');
  const before = structuredClone(request);
  const ids = semanticSegmentIdentityReferenceIds(request);
  assert.deepEqual(ids, ['mare', 'akali'], 'a known identity does not need a recognized action verb');
  const scene = { content: request.content, characterIds: ids, propIds: [] } as unknown as Scene;
  const lock = buildGlobalLock(scene, characters, [], [], []);
  assert.match(lock, /马雷[^\n]*性别设定：女/u, 'Mare gender reaches the actual global identity lock');
  assert.match(lock, /阿卡利/u);
  assert.ok(!lock.includes(absent.name), 'the complete character catalog is not a segment cast list');
  assert.deepEqual(request, before, 'identity selection does not rewrite the saved source or catalog');
}

{
  const ids = semanticSegmentIdentityReferenceIds(input('她警惕地停下。', source({
    dialogues: [{ id: 'line-1', speaker: '马雷', text: '等一下。' }],
  })));
  assert.deepEqual(ids, ['mare'], 'the real dialogue speaker supplies identity without a body name or speaking keyword');
}

{
  const relation = { actor: 'Mare', target: '阿卡利', action: '试探', result: '', evidence: '', certainty: 'explicit' as const };
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('两人继续对峙。', source({
    events: [{ id: 'event-1', description: '', causality: relation }],
  }))), ['mare', 'akali'], 'unique actor and target aliases supply identities when old plans have no character IDs');
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('攻击来源不明。', source({
    events: [{ id: 'event-1', description: '', causality: { ...relation, certainty: 'unknown', targetCharacterId: 'akali' } }],
  }))), ['akali'], 'uncertain causal actors are not locally guessed');
}

{
  assert.deepEqual(semanticSegmentIdentityReferenceIds({
    ...input('镜头停在门口。'), savedSceneCharacterIds: ['mare', 'unknown-id'],
  }), ['mare'], 'saved source-scene IDs remain identity references without forcing screen presence');
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('阿卡利说：“听说马雷已经离开。”')), ['mare', 'akali'],
    'a mentioned name may supply identity facts; this function makes no visibility decision');
}

{
  const original = input('阿卡利独自等候。', source({
    sourceEvidence: [{ text: '其他段人物与马雷同行。' }],
    events: [{ id: 'event-1', description: '', causality: {
      actor: '马雷', target: '其他段人物', actorCharacterId: 'mare', targetCharacterId: 'absent',
      action: '', result: '', evidence: '', certainty: 'explicit',
    } }],
    dialogues: [{ id: 'line-1', speaker: '马雷', text: '我来了。' }],
  }));
  original.segment.entryState = '马雷还在门口。';
  original.segment.exitState = '其他段人物走进。';
  assert.deepEqual(semanticSegmentIdentityReferenceIds({
    ...original, contentOverridden: true, savedSceneCharacterIds: ['mare', 'absent'],
  }), ['akali'], 'a user replacement cannot recover removed identities from old IDs, boundaries, events, lines or evidence');
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('阿卡利独自等候。', source({
    sourceEvidence: [{ text: '其他段人物与马雷同行。' }],
  }))), ['akali'], 'read-only source evidence is not a cast instruction');
}

{
  const forms = [character('mare-a', '马雷·普通形态', ['马雷']), character('mare-b', '马雷·转化形态', ['马雷'])];
  assert.deepEqual(semanticSegmentIdentityReferenceIds({ ...input('马雷继续等候。'), characters: forms }), [],
    'an ambiguous alias does not select both forms');
  assert.deepEqual(semanticSegmentIdentityReferenceIds({ ...input('Mare keeps still.'), contentOverridden: true }), ['mare']);
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('A nightmare passes through the market.')), [],
    'English aliases require word boundaries');
}

console.log('semanticSegmentIdentityReferences: source identity facts reach globalLock without action heuristics, visibility guesses, deleted-cast restoration or full-catalog activation.');
