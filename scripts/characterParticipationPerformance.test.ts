import assert from 'node:assert/strict';
import { resolvePromptCharacterParticipation, resolveSeedanceCharacterParticipation } from '../src/characterParticipation';
import type { Character } from '../src/types';

const character = (id: string, name: string, aliases: string[] = []): Character => ({
  id, name, aliases, gender: '女', apparentAge: '成年', race: '人类', appearance: '黑色长发', outfit: '灰色外衣',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
});
const seedance = (subjects: string, timeline = '0–30秒，空地安静。') => [
  '视频规格：30秒，16:9。', '参考素材与职责：无图片参考。', `主体连续性：${subjects}`,
  '一句话概述：众人汇合。', `连续时间轴：\n${timeline}`, '全局约束：保持人物身份。',
].join('\n');

// Count expensive record-normalization reads, not elapsed time. This catches
// rebuilding the full alias catalog in every clause/shot without a flaky
// machine-speed threshold or production-only instrumentation hooks.
let descriptorReads = 0;
const people = ['青禾', '白露', '赤羽', '墨竹', '银霁', '嘉木', '秋水', '文兰'].map((name, index) => {
  const person = character(`person-${index}`, name);
  Object.defineProperty(person, 'appearance', { enumerable: true, configurable: true, get: () => {
    descriptorReads += 1;
    return '黑色长发，衣着连续。'.repeat(60);
  } });
  return person;
});
const declarations = people.map((person) => `${person.name}为女性，保持原有衣着。`).join('');
const countReads = (run: () => unknown): number => { descriptorReads = 0; run(); return descriptorReads; };
const shortReads = countReads(() => resolveSeedanceCharacterParticipation(seedance(declarations), people));
const longReads = countReads(() => resolveSeedanceCharacterParticipation(seedance(declarations.repeat(12)), people));
assert.equal(longReads, shortReads, 'additional subject clauses must not rebuild character aliases or normalize character dossiers');
assert.ok(shortReads > 0 && shortReads <= people.length * 12, 'each character is normalized only while constructing one request-local alias index');
const h3Body = people.map((person) => `${person.name}站在门口。`).join('');
const oneShotReads = countReads(() => resolvePromptCharacterParticipation(`integrated_multimodal_description: [Shot 1] ${h3Body}`, people));
const manyShotReads = countReads(() => resolvePromptCharacterParticipation(`integrated_multimodal_description: ${Array.from({ length: 12 }, (_, index) => `[Shot ${index + 1}] ${h3Body}`).join('\n')}`, people));
assert.equal(manyShotReads, oneShotReads, 'H3 shots share the same alias index within their current call');
assert.ok(oneShotReads <= people.length * 12);

const mutable = character('mutable', '晨星', ['OldAlias']);
const catalog = [mutable];
const visible = (label: string) => resolveSeedanceCharacterParticipation(seedance(`${label}为女性，保持原有衣着。`), catalog)
  .characters.filter((entry) => entry.presence === 'visible');
assert.equal(visible('晨星')[0]?.characterId, mutable.id);
assert.equal(visible('OldAlias')[0]?.characterId, mutable.id);
mutable.name = '暮云';
mutable.aliases!.splice(0, 1, 'NewAlias');
assert.deepEqual(visible('晨星'), [], 'mutating a name on the same object invalidates the next call naturally');
assert.deepEqual(visible('OldAlias'), [], 'mutating the same alias array cannot leave a stale alias index');
assert.equal(visible('暮云')[0]?.name, '暮云');
assert.equal(visible('NewAlias')[0]?.characterId, mutable.id);
const collision = character('collision', '远川', ['NewAlias']);
catalog.push(collision);
assert.deepEqual(visible('NewAlias'), [], 'a newly introduced alias collision is not assigned by stale cache');
assert.ok(resolveSeedanceCharacterParticipation(seedance('NewAlias为女性。'), catalog).ambiguousNames.includes('NewAlias'));
collision.dossier = { archivedIntoCharacterId: mutable.id } as Character['dossier'];
assert.equal(visible('NewAlias')[0]?.characterId, mutable.id, 'archive changes are reflected without replacing the catalog array');
assert.deepEqual(resolveSeedanceCharacterParticipation(seedance('暮云为女性。'), [mutable, mutable]).characters, [],
  'duplicate catalog entries retain ambiguous ownership even when they are the same object');

console.log(`characterParticipationPerformance passed: Seedance ${shortReads}/${longReads} and H3 ${oneShotReads}/${manyShotReads} descriptor reads; mutable names, aliases, collisions and archives stay current.`);
