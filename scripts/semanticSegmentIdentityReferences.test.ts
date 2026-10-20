import assert from 'node:assert/strict';
import { semanticSegmentIdentityReferenceIds } from '../src/semanticSegmentIdentityReferences';
import { buildGlobalLock } from '../src/promptEngine';
import { buildOfficialH3SubjectDefinitions } from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceContentHash';
import type { Character, Scene, SemanticSegmentSource, Storyboard } from '../src/types';

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
  const scoped = input('她向同伴摆手，随后转身。', source({
    sceneStaging: [{ version: 1, sceneId: 'clearing',
      participants: [{ id: 'local-mare', name: 'Mare', position: '队伍左侧' }],
      phases: [{ id: 'reply', participantIds: ['local-mare', 'akali', 'deleted-id'], action: '同伴拒绝' }],
    }],
  }));
  assert.deepEqual(semanticSegmentIdentityReferenceIds(scoped), ['mare', 'akali'],
    'adopted local participant mappings and phase character IDs preserve silent named group members');
  assert.deepEqual(semanticSegmentIdentityReferenceIds({ ...scoped, contentOverridden: true }), [],
    'a replaced segment does not revive prior scene participants or phases');
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('她对同伴发问。', source({
    events: [{ id: 'challenge', description: '', causality: {
      actor: '她', actorCharacterId: 'mare', target: '同伴', targetCharacterIds: ['akali', 'missing'],
      action: '挑战', result: '被拒绝', evidence: '向同伴发问', certainty: 'explicit',
    } }],
  }))), ['mare', 'akali'], 'multiple explicit target identities survive an unnamed group target');
  assert.deepEqual(semanticSegmentIdentityReferenceIds(input('她问了一声。', source({
    dialogues: [{ id: 'question', speaker: '她', speakerCharacterId: 'mare', text: '可以吗？',
      listenerCharacterIds: ['akali'], addressedCharacterIds: ['missing'] }],
  }))), ['mare', 'akali'], 'source speaker and listener IDs do not require repeated names in prose');
}

{
  const finalPrompt = '两位同伴安静地互相等待。';
  const board = {
    finalPrompt,
    promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete' },
    sceneStaging: [{ version: 1, sceneId: 'clearing', participants: [{ id: mare.id }] }],
    shots: [{ subject: '两位同伴', action: '互相等待', result: '', camera: '', prompt: '',
      sceneStaging: [{ version: 1, sceneId: 'clearing', phases: [{ id: 'wait', participantIds: [akali.id] }] }] }],
  } as unknown as Storyboard;
  const before = structuredClone(board);
  const definitions = buildOfficialH3SubjectDefinitions(board, { characters, assets: [] }, []);
  assert.deepEqual(definitions.filter((entry) => entry.kind === 'character').map((entry) => entry.name), [mare.name, akali.name],
    'adopted scene/shot identities reach official subject definitions despite unnamed group prose');
  assert.deepEqual(board, before, 'identity definitions do not mutate the adopted source');
  for (const edited of [
    { ...board, finalPrompt: '空地无人。' },
    { ...board, promptPlan: { canonicalPrompt: '空地无人。' } },
    { ...board, sourceStale: true },
    { ...board, promptTrace: { ...board.promptTrace, mode: 'local-fallback', convertedPromptFingerprint: undefined } },
    { ...board, promptTrace: { ...board.promptTrace, shotPlanMode: 'locally-edited' } },
  ] as Storyboard[]) {
    assert.deepEqual(buildOfficialH3SubjectDefinitions(edited, { characters, assets: [] }, []), [],
      'old board and shot participant IDs cannot revive actors after source, canonical or manual shot edits');
  }
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
