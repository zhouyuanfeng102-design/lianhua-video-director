import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { updateLogEntries } from '../src/updateLog.ts';

const root = path.resolve(import.meta.dirname, '..');
const electronSmokeSource = fs.readFileSync(path.join(root, 'scripts', 'electronSmoke.mjs'), 'utf8');
const sequenceUiQaSource = fs.readFileSync(path.join(root, 'scripts', 'sequenceUiQa.mjs'), 'utf8');

test('packaged smoke script remains valid JavaScript', () => {
  const scriptPath = path.join(root, 'scripts', 'packagedSmoke.mjs');
  const result = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('sequence UI QA derives the complete ordered update log from authoritative release metadata', () => {
  assert.match(sequenceUiQaSource, /import \{ updateLogEntries \} from '\.\.\/src\/updateLog\.ts';/u);
  assert.match(sequenceUiQaSource, /const expectedUpdateLogVersions = updateLogEntries\.map\(\(\{ version \}\) => version\);/u);
  assert.match(sequenceUiQaSource, /const expectedUpdateLogCurrentVersion = String\(packageInfo\.version \|\| ''\)\.trim\(\);/u);
  assert.match(sequenceUiQaSource, /expectedUpdateLogVersions\[0\] !== expectedUpdateLogCurrentVersion/u);
  assert.match(sequenceUiQaSource, /JSON\.stringify\(versions\) === JSON\.stringify\(expectedVersions\)/u);
  assert.match(sequenceUiQaSource, /result\.currentVersion !== expectedUpdateLogCurrentVersion/u);
  assert.doesNotMatch(sequenceUiQaSource, /const expectedUpdateLogVersions = \[/u);
  assert.doesNotMatch(sequenceUiQaSource, /result\.currentVersion !== ['"]\d+\.\d+\.\d+['"]/u);
});

test('sequence UI mock preserves source coverage and every requested fixed-grid boundary', () => {
  const fixtureStart = sequenceUiQaSource.indexOf('const qaTaggedJson = ');
  const fixtureEnd = sequenceUiQaSource.indexOf('const qaSegmentationResponse =', fixtureStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'QA storyboard fixture must remain independently checkable');
  const makeResponse = vm.runInNewContext(
    `${sequenceUiQaSource.slice(fixtureStart, fixtureEnd)}\nqaShotRecommendationResponse;`,
  );
  const sourceStory = '甲推门进入。乙从木箱后站起。甲放下武器。乙转身走出。';
  for (const [durationSec, requiredSegmentDurationSec, requiredShotCount] of [
    [24, 8, undefined],
    [30, 15, undefined],
    [16, 4, undefined],
    [24, 8, 3],
    [1, 1, undefined],
  ]) {
    const result = JSON.parse(makeResponse(`<storyboard_planning_data>${JSON.stringify({
      sourceStory,
      durationSec,
      requiredSegmentDurationSec,
      requiredShotCount,
    })}</storyboard_planning_data>`));
    assert.equal(result.shots.map((shot) => shot.sourceExcerpt).join(''), sourceStory);
    assert.equal(result.shots.length, requiredShotCount || 4);
    assert.equal(result.shots[0].startSec, 0);
    assert.equal(result.shots.at(-1).endSec, durationSec);
    for (let index = 0; index < result.shots.length; index += 1) {
      const shot = result.shots[index];
      assert.ok(shot.endSec > shot.startSec);
      if (index) assert.equal(shot.startSec, result.shots[index - 1].endSec);
    }
    for (let boundary = requiredSegmentDurationSec; boundary < durationSec; boundary += requiredSegmentDurationSec) {
      assert.ok(result.shots.some((shot) => shot.endSec === boundary), `mock must emit ${boundary}s fixed boundary`);
      assert.ok(result.shots.some((shot) => shot.startSec === boundary), `mock must start the next shot at ${boundary}s`);
    }
    if (durationSec === 24 && requiredShotCount === undefined) {
      assert.deepEqual(result.shots.map((shot) => shot.endSec), [5, 8, 16, 24]);
    }
  }
  assert.throws(() => makeResponse(`<storyboard_planning_data>${JSON.stringify({
    sourceStory,
    durationSec: 24,
    requiredSegmentDurationSec: 7,
  })}</storyboard_planning_data>`), /integer number of fixed-duration segments/u);
});

test('update-log QA metadata retains 0.5.62 and 0.5.61 in newest-first order', () => {
  const versions = updateLogEntries.map(({ version }) => version);
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(versions[0], packageInfo.version, 'the current release must lead the update log');
  assert.equal(new Set(versions).size, versions.length, 'release entries must not be duplicated');
  const version062Index = versions.indexOf('0.5.62');
  assert.notEqual(version062Index, -1, '0.5.62 must remain in the update log');
  assert.equal(versions[version062Index + 1], '0.5.61', '0.5.62 must not replace or skip 0.5.61');
  const newestFirst = [...versions].sort((left, right) => {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    return rightParts[0] - leftParts[0] || rightParts[1] - leftParts[1] || rightParts[2] - leftParts[2];
  });
  assert.deepEqual(versions, newestFirst, 'the authoritative release list must remain newest first');
});

test('electron smoke derives stateExists from the state file and fails the smoke when it is absent', () => {
  assert.match(electronSmokeSource, /const stateExists = fs\.existsSync\(statePath\);/);
  assert.match(electronSmokeSource, /stateExists:\s*disk\.stateExists/);
  assert.doesNotMatch(electronSmokeSource, /stateExists:\s*true/);
});

test('electron smoke target selection tolerates a page target without a title', () => {
  const assignment = electronSmokeSource.match(/target\s*=\s*(targets\.find\(\(item\).*?\)\s*\|\|\s*targets\.find\(\(item\).*?\));/);
  assert.ok(assignment, 'Electron target selection expression must remain discoverable');
  const selectTarget = vm.runInNewContext(`(targets) => ${assignment[1]}`);
  const untitledPage = { type: 'page' };

  assert.doesNotThrow(() => selectTarget([untitledPage]));
  assert.equal(selectTarget([untitledPage]), untitledPage);
});

for (const scriptName of ['desktopQa.mjs', 'mediaQa.mjs']) {
  test(`${scriptName} delegates aggregate shutdown to the verified QA harness and always writes its log`, () => {
    const source = fs.readFileSync(path.join(root, 'scripts', scriptName), 'utf8');
    assert.match(source, /Promise\.race\(\[[^\]]*qaFailure[^\]]*\]\)/s);
    assert.doesNotMatch(source, /\belectronFailure\b/);
    assert.match(source, /try\s*\{\s*await stopAll\(\);\s*\}\s*finally\s*\{\s*fs\.writeFileSync\(path\.join\(outputDirectory, 'electron-process\.log'\)/s);
    assert.doesNotMatch(source, /spawnSync\('taskkill\.exe'/);
  });
}
