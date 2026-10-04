import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'packagedSmoke.mjs'), 'utf8');
const smokeExpectations = await import('./packagedSmokeExpectations.mjs').catch(() => ({}));

test('state-mutating QA entry points target the current application localStorage key', () => {
  const storageSource = fs.readFileSync(path.join(root, 'src', 'storage.ts'), 'utf8');
  const currentStorageKey = storageSource.match(
    /export const STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/u,
  )?.[1];
  assert.ok(currentStorageKey, 'src/storage.ts must export a literal STORAGE_KEY');

  for (const scriptName of [
    'packagedSmoke.mjs',
    'electronSmoke.mjs',
    'uiSmoke.mjs',
    'sequenceUiQa.mjs',
    'workflowUiSmoke.mjs',
    'storyboardShotPickerQa.mjs',
  ]) {
    const qaSource = fs.readFileSync(path.join(root, 'scripts', scriptName), 'utf8');
    const referencedStorageKeys = [...new Set(
      qaSource.match(/lianhua_video_director_state_v\d+/gu) || [],
    )];
    assert.deepEqual(
      referencedStorageKeys,
      [currentStorageKey],
      `${scriptName} must use the current application STORAGE_KEY`,
    );
  }
});

test('packaged smoke derives schema 16 from current source and rejects a schema 15 package', () => {
  assert.equal(typeof smokeExpectations.resolveExpectedSchemaVersion, 'function');
  assert.equal(typeof smokeExpectations.collectPackagedSmokeFailures, 'function');
  assert.equal(smokeExpectations.EXPECTED_UNIFIED_VIDEO_CONVERTER_VERSION, '1.7.0');

  const expectedSchemaVersion = smokeExpectations.resolveExpectedSchemaVersion({
    configuredValue: '',
    storageSource: 'export const CURRENT_SCHEMA_VERSION = 16;',
  });
  assert.equal(expectedSchemaVersion, 16);
  assert.equal(smokeExpectations.resolveExpectedSchemaVersion({
    configuredValue: '17',
    storageSource: 'export const CURRENT_SCHEMA_VERSION = 16;',
  }), 17);

  const passingReport = {
    title: '莲华视频导演台',
    version: 'v0.5.45',
    schemaVersion: 16,
    unifiedVideoConverterVersion: smokeExpectations.EXPECTED_UNIFIED_VIDEO_CONVERTER_VERSION,
    unifiedVideoConverterHasHighDetailContract: true,
    saved: true,
    reloaded: true,
    restoreCreated: true,
    stateValid: true,
    encryptionAvailable: true,
    dataRootIsolated: true,
    stateFileExists: true,
    snapshotExists: true,
    viewports: [{}, {}, {}],
  };
  const inputs = {
    expectedVersion: '0.5.45',
    expectedSchemaVersion,
    requiredViewportCount: 3,
    apiViewportsPass: true,
    consoleErrors: [],
  };

  assert.deepEqual(smokeExpectations.collectPackagedSmokeFailures({
    report: passingReport,
    ...inputs,
  }), []);
  assert.deepEqual(smokeExpectations.collectPackagedSmokeFailures({
    report: { ...passingReport, schemaVersion: 15 },
    ...inputs,
  }), ['currentSchema']);
  assert.deepEqual(smokeExpectations.collectPackagedSmokeFailures({
    report: { ...passingReport, version: 'v0.5.450' },
    ...inputs,
  }), ['correctVersion']);
  assert.deepEqual(smokeExpectations.collectPackagedSmokeFailures({
    report: { ...passingReport, unifiedVideoConverterVersion: '1.3.0' },
    ...inputs,
  }), ['currentUnifiedVideoConverter']);
  assert.deepEqual(smokeExpectations.collectPackagedSmokeFailures({
    report: { ...passingReport, unifiedVideoConverterHasHighDetailContract: false },
    ...inputs,
  }), ['highDetailVideoContract']);
});

test('packaged smoke checks the complete current v1.6 video contract including AI dialogue and spatial staging', () => {
  const markers = smokeExpectations.CURRENT_UNIFIED_VIDEO_CONVERTER_CONTRACT_MARKERS;
  assert.ok(Array.isArray(markers));
  assert.ok(markers.length >= 9, 'the smoke contract must cover existing detail rules and the new AI voice/spatial staging rules');

  const nsfwRulesSource = fs.readFileSync(path.join(root, 'src', 'nsfwPromptRules.ts'), 'utf8');
  const videoRulesSource = fs.readFileSync(path.join(root, 'src', 'videoConversionRules.ts'), 'utf8');
  for (const marker of markers) {
    assert.ok(`${nsfwRulesSource}\n${videoRulesSource}`.includes(marker), `current video contract must contain packaged-smoke marker: ${marker}`);
  }
  assert.match(source, /JSON\.stringify\(CURRENT_UNIFIED_VIDEO_CONVERTER_CONTRACT_MARKERS\)/u);
  assert.match(
    source,
    /unifiedVideoContractMarkers\.every\(\(marker\) => unifiedVideoRules\.includes\(marker\)\)/u,
  );
  assert.doesNotMatch(
    source,
    /【六、条件触发的高细节视频转化】|普通剧情按普通事件链转换|不淡化、不淡出、不跳过/u,
  );
});

test('packaged smoke only resets managed QA directories and requires one isolated data root', () => {
  assert.match(source, /prepareQaOutputDirectory/u);
  assert.match(source, /normalizeFsPath/u);
  assert.match(source, /configuredDataDirectory[\s\S]*expectedDataDirectory[\s\S]*must match/u);
  assert.doesNotMatch(source, /fs\.rmSync\(dataDirectory/u);
  assert.doesNotMatch(source, /fs\.rmSync\(outputDirectory/u);
});

test('packaged smoke seeds its isolated profile only after validation and cleanup, before executable startup', () => {
  const markerName = '.qa-isolated-profile';
  const dataValidationIndex = source.indexOf("throw new Error('LIANHUA_DATA_DIR and EXPECTED_DATA_DIR must match')");
  const overlapValidationIndex = source.indexOf("throw new Error('QA data and output directories must be separate')");
  const dataPrepareIndex = source.indexOf('const dataDirectory = prepareQaOutputDirectory(');
  const outputPrepareIndex = source.indexOf('const outputDirectory = prepareQaOutputDirectory(');
  const markerIndex = source.indexOf(`fs.writeFileSync(path.join(dataDirectory, '${markerName}')`);
  const spawnIndex = source.indexOf('const child = spawn(executable,');
  assert.ok(dataValidationIndex >= 0 && overlapValidationIndex >= 0);
  assert.ok(dataPrepareIndex > Math.max(dataValidationIndex, overlapValidationIndex));
  assert.ok(outputPrepareIndex > dataPrepareIndex);
  assert.ok(markerIndex > outputPrepareIndex, 'the marker must never be written into an unvalidated or uncleared directory');
  assert.ok(spawnIndex > markerIndex, 'the empty-root migration guard must exist before Electron starts');
  assert.match(source.slice(markerIndex, spawnIndex), /flag:\s*'wx'/u);

  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const runtimeOnlyEntries = mainSource.match(/const runtimeOnlyEntries = new Set\((\[[^\]]*\])\);/u)?.[1];
  assert.ok(runtimeOnlyEntries, 'desktop empty-root detection must expose the runtime-only entry list');
  assert.equal(runtimeOnlyEntries.includes(markerName), false, 'the QA marker must count as a non-empty profile');
  assert.match(mainSource, /if \(!dataRootHasEntries\) copyDirectoryIfNeeded\(migrationSource, dataRoot\);/u);
});

test('packaged smoke allocates a dynamic port and only terminates its spawned process tree', () => {
  assert.match(source, /findAvailableTcpPort/u);
  assert.match(source, /configuredPort\s*\?\?\s*await findAvailableTcpPort\(\)/u);
  assert.doesNotMatch(source, /Get-CimInstance/u);
  assert.doesNotMatch(source, /CommandLine\s+-match/u);
});

test('packaged smoke rejects an explicitly non-numeric CDP port instead of treating it as omitted', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-packaged-port-'));
  const dataDirectory = path.join(temporaryRoot, 'data');
  const outputDirectory = path.join(temporaryRoot, 'output');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'packagedSmoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_EXECUTABLE: process.execPath,
      CDP_CONNECTION_TIMEOUT_MS: '10',
      CDP_PORT: 'not-a-number',
      CDP_STARTUP_COMMAND_TIMEOUT_MS: '25',
      EXPECTED_DATA_DIR: dataDirectory,
      LIANHUA_DATA_DIR: dataDirectory,
      QA_OUTPUT: outputDirectory,
    },
    timeout: 3000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Invalid CDP_PORT: not-a-number/u);
});

test('packaged smoke refuses an explicitly occupied CDP port before attaching to another service', async (t) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-packaged-port-'));
  const dataDirectory = path.join(temporaryRoot, 'data');
  const outputDirectory = path.join(temporaryRoot, 'output');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'packagedSmoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_EXECUTABLE: process.execPath,
      CDP_CONNECTION_TIMEOUT_MS: '10',
      CDP_PORT: String(address.port),
      CDP_STARTUP_COMMAND_TIMEOUT_MS: '25',
      EXPECTED_DATA_DIR: dataDirectory,
      LIANHUA_DATA_DIR: dataDirectory,
      QA_OUTPUT: outputDirectory,
    },
    timeout: 3000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /CDP_PORT.*already in use.*refusing/u);
});

test('packaged smoke verifies the connected data root before any state mutation', () => {
  const identityIndex = source.indexOf('connectedRendererDataRoot');
  const mutationIndex = source.indexOf("state.project.name =");
  assert.ok(identityIndex >= 0, 'the connected renderer data root must be read');
  assert.ok(mutationIndex > identityIndex, 'data-root identity must be checked before state mutation');
});

test('packaged smoke validates every required viewport, panel axis, and the exact version token', () => {
  for (const [width, height] of [[1120, 720], [1280, 720], [1280, 800]]) {
    assert.match(source, new RegExp(`width:\\s*${width},\\s*height:\\s*${height}`, 'u'));
  }
  assert.match(source, /Emulation\.setDeviceMetricsOverride/u);
  assert.match(source, /defaultPanelIsImage/u);
  assert.match(source, /imageFieldControlsVisible/u);
  assert.match(source, /contentOverflowX/u);
  assert.match(source, /workspaceOverflowX/u);
  assert.match(source, /bodyOverflowX/u);
  assert.match(source, /closest\('details:not\(\[open\]\)'\)/u);
  assert.match(source, /visibleSummary\?\.contains\(element\)/u);
  assert.doesNotMatch(source, /report\.version\.includes/u);
});

test('packaged smoke frame wait falls back when animation frames are background-throttled', async () => {
  const assignmentStart = source.indexOf('const nextFrame = ');
  const assignmentEnd = source.indexOf('\n      const panelIds', assignmentStart);
  assert.ok(assignmentStart >= 0 && assignmentEnd > assignmentStart, 'nextFrame assignment must be present');
  const expression = source
    .slice(assignmentStart + 'const nextFrame = '.length, assignmentEnd)
    .trim()
    .replace(/;$/u, '');

  let fallbackScheduled = false;
  const nextFrame = Function(
    'requestAnimationFrame',
    'setTimeout',
    'clearTimeout',
    `return (${expression});`,
  )(
    () => {},
    (callback) => {
      fallbackScheduled = true;
      queueMicrotask(callback);
      return 1;
    },
    () => {},
  );

  const outcome = await Promise.race([
    nextFrame().then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25)),
  ]);
  assert.equal(outcome, 'resolved');
  assert.equal(fallbackScheduled, true);
});
