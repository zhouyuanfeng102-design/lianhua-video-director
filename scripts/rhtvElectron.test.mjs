import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');

test('Electron ASAR uploads a large original and recovers the same worker job after restart', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-electron-'));
  const stage = path.join(root, 'stage'); const resultFile = path.join(root, 'result.json');
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('rhtv-electron-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(stage);
  fs.cpSync(path.resolve('electron', 'rhtvBridge'), path.join(stage, 'electron', 'rhtvBridge'), { recursive: true });
  fs.copyFileSync(path.resolve('electron', 'videoWorkbench.cjs'), path.join(stage, 'electron', 'videoWorkbench.cjs'));
  fs.cpSync(path.dirname(require.resolve('playwright-core/package.json')), path.join(stage, 'node_modules', 'playwright-core'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'rhtv-isolated-qa', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(stage, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createRhTvManager } = require('./electron/rhtvBridge/manager.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
app.whenReady().then(async () => {
  const manager = createRhTvManager({ root: ${JSON.stringify(path.join(root, 'data'))}, projectRoot: __dirname, resourcesPath: process.resourcesPath });
  try {
    const runtime = typeof require('playwright-core').chromium.launchPersistentContext;
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(23 * 1024 * 1024, 65)]);
    const uploaded = await manager.call('request', { url: 'http://rhtv.localhost/v1/assets', method: 'POST',
      multipart: { files: [{ fieldName: 'file', fileName: 'large.png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }] } });
    if (uploaded.status !== 200) throw new Error(uploaded.body);
    const asset = JSON.parse(uploaded.body);
    const request = { protocol_version: 1, client_id: 'asar-test', model_key: 'minimax-h3-rh-enhanced', mode: 'reference', prompt: 'local-only test', cost_policy: 'free_only', parameters: { duration: 5, resolution: '768p', aspect_ratio: '16:9' }, references: [
      { upload_id: asset.upload_id, asset_id: 'large-original', slot_index: 4, role: 'character', character_ids: ['one', 'two'] },
    ] };
    const first = await manager.call('request', { url: 'http://rhtv.localhost/v1/videos', method: 'POST', body: JSON.stringify(request) });
    await manager.close();
    await manager.call('start');
    const recovered = await manager.call('request', { url: 'http://rhtv.localhost/v1/videos/by-client/asar-test', method: 'GET' });
    const status = await manager.call('status');
    await manager.close();
    const cached = fs.readFileSync(path.join(${JSON.stringify(path.join(root, 'data'))}, 'assets', asset.upload_id));
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ first, recovered, status, runtime, originalUnchanged: cached.equals(bytes), sizeBytes: cached.length, archive: __dirname, electron: process.versions.electron }));
    app.exit(0);
  } catch (error) {
    await manager.close().catch(() => {});
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ error: error.stack }));
    app.exit(1);
  }
});
`);
  const archive = path.join(root, 'app.asar'); await createPackage(stage, archive);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_START_URL;
  child = spawn(require('electron'), [archive], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : {};
  assert.equal(code, 0, JSON.stringify(result) + output.slice(-4000));
  assert.equal(result.runtime, 'function'); assert.match(result.archive, /app\.asar$/);
  assert.equal(result.first.status, 200);
  assert.equal(result.recovered.status, 200);
  assert.equal(JSON.parse(result.first.body).id, JSON.parse(result.recovered.body).id);
  const reference = JSON.parse(result.recovered.body).references[0];
  assert.equal(reference.slot_index, 4);
  assert.deepEqual(reference.character_ids, ['one', 'two']);
  assert.equal(result.originalUnchanged, true);
  assert.equal(result.sizeBytes, 23 * 1024 * 1024 + 8);
  assert.equal(result.status.automatic_submission, false);
  assert.equal(result.status.browser, 'Edge 未启动');
  t.diagnostic(`Electron ${result.electron}: ASAR worker, 23 MB original-byte upload and original-job recovery passed; no browser launched.`);
});
