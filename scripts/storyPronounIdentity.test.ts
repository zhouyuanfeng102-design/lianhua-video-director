import assert from 'node:assert/strict';
import { foldSolePronounCharacters } from '../src/services/llm';

const story = '她独自站在台心。一个人立在台心，身形落在白玉面上。';
const folded = foldSolePronounCharacters([
  { name: '无名主角', appearance: '鹅蛋脸，五官清秀，磨形细长', outfit: '白衣' },
  { name: '她', appearance: '' },
], story);
assert.equal(folded.length, 1);
assert.equal(folded[0]?.name, '无名主角');
assert.ok(folded[0]?.aliases?.includes('她'));
assert.equal(folded[0]?.appearance, '');
assert.equal(folded[0]?.outfit, '');

const kept = foldSolePronounCharacters([
  { name: '千仞雪', appearance: '白发' },
  { name: '比比东', appearance: '黑发' },
  { name: '她' },
], '千仞雪与比比东同在殿内。她看向比比东。');
assert.deepEqual(kept.map((character) => character.name), ['千仞雪', '比比东']);

const saved = foldSolePronounCharacters([
  { name: '无名主角', existingEntityId: 'saved', appearance: '用户写的长眉' },
  { name: '她' },
], story);
assert.equal(saved[0]?.appearance, '用户写的长眉');

console.log('story pronoun identity: one 她 is 无名主角, and a face the source never wrote is left empty.');
