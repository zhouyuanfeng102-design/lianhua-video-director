import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectCreationLabel, projectCreationTime, sortProjectsByCreation } from '../src/projectLibrary';

const older = { id: 'older', createdAt: 1000, updatedAt: 999999 };
const newer = { id: 'newer', createdAt: 2000, updatedAt: 1 };
const same = { id: 'same', createdAt: 2000, updatedAt: 888888 };
const unknown = { id: 'unknown', createdAt: 0, updatedAt: Date.now() };
const input = [older, newer, same, unknown];
const before = JSON.stringify(input);
assert.deepEqual(sortProjectsByCreation(input).map((item) => item.id), ['newer', 'same', 'older', 'unknown']);
assert.equal(JSON.stringify(input), before, 'display ordering never reorders the stored library or changes project data');
assert.equal(sortProjectsByCreation(input)[0], newer, 'sorting does not rewrite project objects');
older.updatedAt += 999999;
assert.deepEqual(sortProjectsByCreation(input).map((item) => item.id), ['newer', 'same', 'older', 'unknown'], 'saving an old project must not move it to the top');
const changedSaveTime = { ...older, updatedAt: 1 };
assert.equal(projectCreationLabel(older), projectCreationLabel(changedSaveTime), 'display text ignores update time');
for (const createdAt of [undefined, null, '', '1234', Number.NaN, Infinity, -1, 0, 8.64e15 + 1]) {
  assert.equal(projectCreationTime({ createdAt }), 0);
  assert.equal(projectCreationLabel({ createdAt }), '创建时间未知');
}
assert.deepEqual(sortProjectsByCreation([{ createdAt: 0 }, {}, { createdAt: null }]), [{ createdAt: 0 }, {}, { createdAt: null }], 'unknown timestamps retain input order');
assert.match(projectCreationLabel({ createdAt: new Date(2026, 8, 10, 12, 34).getTime() }), /^创建于 .*2026.*09.*10.*12:34/u);
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(app, /sortProjectsByCreation\(Array\.from\(byId\.values\(\)\)\)/u);
assert.match(app, /projectCreationLabel\(item\)/u);
console.log('Project library: creation-descending, stable ties, invalid/unknown dates, immutable data and App display wiring passed');
