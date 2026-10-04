import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertReleaseVersion, compareVersions, DECIMAL_RELEASE_START, nextReleaseVersion, parseVersion,
} from './releaseVersion.mjs';

const nextVersionScript = path.resolve(import.meta.dirname, 'nextVersion.mjs');

test('new releases start at 0.6.0 and minor/patch stay single decimal digits', () => {
  assert.equal(DECIMAL_RELEASE_START, '0.6.0');
  for (const version of ['0.6.0', '0.6.9', '0.9.9', '1.0.0', '9.9.9', '10.0.0']) {
    assert.equal(assertReleaseVersion(version), version);
  }
  for (const version of ['0.5.9', '0.5.160', '0.6.10', '0.10.0', '1.0.10', '1.10.0']) {
    assert.throws(() => assertReleaseVersion(version), /Invalid release version/u);
  }
});

test('next release carries each decimal digit and bridges the preserved historical series', () => {
  for (const [current, next] of [
    ['0.5.159', '0.6.0'], ['0.5.160', '0.6.0'], ['0.6.0', '0.6.1'],
    ['0.6.8', '0.6.9'], ['0.6.9', '0.7.0'], ['0.9.9', '1.0.0'],
    ['1.0.9', '1.1.0'], ['1.9.9', '2.0.0'], ['9.9.9', '10.0.0'],
  ]) {
    assert.equal(nextReleaseVersion(current), next, current);
  }
  assert.throws(() => nextReleaseVersion('0.6.10'), /Invalid release version/u);
  assert.throws(() => nextReleaseVersion('0.10.0'), /Invalid release version/u);
  assert.throws(() => nextReleaseVersion(`${Number.MAX_SAFE_INTEGER}.9.9`), /safe integer/u);
});

test('historical releases keep numeric component ordering without reinterpretation', () => {
  assert.deepEqual(parseVersion('0.5.160'), [0, 5, 160]);
  for (const [older, newer] of [
    ['0.5.19', '0.5.160'], ['0.5.99', '0.5.160'], ['0.5.160', '0.6.0'],
    ['0.6.0', '0.6.10'], ['0.9.9', '0.10.0'], ['0.10.0', '1.0.0'],
  ]) {
    assert.equal(compareVersions(older, newer), -1);
    assert.equal(compareVersions(newer, older), 1);
  }
  assert.equal(compareVersions('0.5.160', '0.5.160'), 0);
});

test('version parsing rejects malformed, ambiguous and unsafe components', () => {
  for (const version of [
    undefined, null, 6, '', '0.6', '0.6.0.1', 'v0.6.0', '0.6.0-beta', '0.6.0+build',
    ' 0.6.0', '0.6.0 ', '0.6.0\n', '0.6.0\r\n', '00.6.0', '0.06.0', '0.6.00', '-1.0.0', '0.-6.0',
    '0.6.-1', '0.6.NaN', '0.6.1e1', '9007199254740992.0.0',
  ]) {
    assert.throws(() => parseVersion(version), /Invalid version/u, String(version));
  }
});

test('next-version reads the current package and leaves fixture files byte-identical', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-next-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const contents = '{"version":"0.6.9"}\n';
  fs.writeFileSync(packagePath, contents, 'utf8');
  fs.writeFileSync(lockPath, 'LOCK-SENTINEL', 'utf8');
  const entriesBefore = fs.readdirSync(root);
  const result = spawnSync(process.execPath, [nextVersionScript], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.7.0');
  assert.equal(fs.readFileSync(packagePath, 'utf8'), contents);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'LOCK-SENTINEL');
  assert.deepEqual(fs.readdirSync(root), entriesBefore);
});

test('next-version supports explicit input and rejects invalid input without publishing', () => {
  for (const [args, expected, status] of [
    [['0.5.160'], '0.6.0', 0], [['0.9.9'], '1.0.0', 0],
    [['0.6.10'], 'Invalid release version', 1], [['0.6.0', 'extra'], 'Usage:', 1],
  ]) {
    const result = spawnSync(process.execPath, [nextVersionScript, ...args], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal((status === 0 ? result.stdout : result.stderr).includes(expected), true);
    if (status !== 0) assert.equal(result.stdout, '');
  }
});
