import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');
const electron = require('electron');
const moduleRoot = path.resolve(import.meta.dirname, '..', 'electron');

test('packaged Electron can run state worker inside app.asar with main-only safeStorage', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-state-asar-'));
  const stage = path.join(root, 'stage');
  const profile = path.join(root, 'profile');
  const resultFile = path.join(root, 'result.json');
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('lianhua-state-asar-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.mkdirSync(stage);
  for (const file of ['statePersistence.cjs', 'statePersistenceWorker.cjs', 'statePersistenceStore.cjs', 'stateSerialization.cjs', 'imageReferenceSnapshots.cjs', 'projectLibraryStore.cjs', 'stateMediaFiles.cjs', 'imageReferenceTransport.cjs', 'webpValidation.cjs']) {
    fs.copyFileSync(path.join(moduleRoot, file), path.join(stage, file));
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'state-asar-isolated-qa', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(stage, 'main.cjs'), `
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createStatePersistence } = require('./statePersistence.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', ${JSON.stringify(profile)});
app.whenReady().then(async () => {
  const dataRoot = ${JSON.stringify(path.join(root, 'data'))};
  const vaultFile = path.join(dataRoot, 'credentials.safe');
  const persistence = createStatePersistence({ dataRoot,
    encryptSecrets: (secrets) => ({ mode: 'write', encrypted: safeStorage.encryptString(JSON.stringify(secrets)) }),
    loadSecrets: () => JSON.parse(safeStorage.decryptString(fs.readFileSync(vaultFile))),
  });
  try {
    await persistence.run('status');
    const content = JSON.stringify({ project: { id: 'asar-only-synthetic', description: 'x'.repeat(73 * 1024 * 1024) }, settings: { textApi: { apiKey: 'fake-asar-fixture-key' } } });
    let ticks = 0;
    let maximumGap = 0;
    let previousTick = performance.now();
    const started = previousTick;
    const heartbeat = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - previousTick); previousTick = now; ticks += 1; }, 10);
    let result;
    try { result = await persistence.run('save', { content }); }
    finally { clearInterval(heartbeat); }
    const durationMs = performance.now() - started;
    const loaded = JSON.parse((await persistence.run('load')).content);
    await persistence.close();
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ ok: result.ok, id: loaded.project.id, key: loaded.settings.textApi.apiKey, electron: process.versions.electron, archivePath: __dirname, durationMs, ticks, maximumGap }));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ error: error.stack || String(error) }));
    await persistence.discard();
    app.exit(1);
  }
});
`);
  const archive = path.join(root, 'app.asar');
  await createPackage(stage, archive);
  const env = { ...process.env, LIANHUA_DATA_DIR: path.join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_START_URL;
  child = spawn(electron, [archive, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : {};
  assert.equal(exitCode, 0, JSON.stringify(result) + '\n' + output.slice(-4000));
  assert.equal(result.ok, true);
  assert.equal(result.key, 'fake-asar-fixture-key');
  assert.equal(result.id, 'asar-only-synthetic');
  assert.match(result.archivePath, /app\.asar$/u);
  assert.ok(result.ticks >= 8);
  assert.ok(result.maximumGap < result.durationMs * 0.6);
  t.diagnostic(`Electron ${result.electron}: packaged worker + encrypted save/load passed; 73 MiB save=${result.durationMs.toFixed(0)}ms, ticks=${result.ticks}, max main-loop gap=${result.maximumGap.toFixed(0)}ms`);
});
