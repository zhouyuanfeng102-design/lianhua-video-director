import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('isolated Electron renderer crash leaves recovery in the main process and waits for user choice', { timeout: 40_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-renderer-recovery-'));
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
    assert.ok(path.basename(resolved).startsWith('lianhua-renderer-recovery-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.copyFileSync(new URL('../electron/rendererCrashRecovery.cjs', import.meta.url), path.join(root, 'rendererCrashRecovery.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'renderer-recovery-isolated-qa', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>isolated recovery fixture</title><p>synthetic project content</p>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRendererCrashRecovery } = require('./rendererCrashRecovery.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', ${JSON.stringify(profile)});
const finish = (result, code) => { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result)); app.exit(code); };
setTimeout(() => finish({ error: 'isolated recovery timed out' }, 1), 20_000).unref();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  let loads = 0;
  let dialogues = 0;
  let choose;
  let notified;
  const notice = new Promise((resolve) => { notified = resolve; });
  const userChoice = new Promise((resolve) => { choose = resolve; });
  const loadRenderer = () => { loads += 1; return win.loadFile(path.join(__dirname, 'index.html')); };
  const recovery = createRendererCrashRecovery({ window: win, loadRenderer,
    showMessage: (options) => { dialogues += 1; notified(options); return userChoice; },
  });
  try {
    await loadRenderer();
    const beforePid = win.webContents.getOSProcessId();
    const gone = new Promise((resolve) => win.webContents.once('render-process-gone', (_event, details) => resolve(details)));
    win.webContents.forcefullyCrashRenderer();
    const details = await gone;
    const options = await notice;
    assert.equal(win.isDestroyed(), false);
    assert.equal(loads, 1, 'no automatic reload before user choice');
    assert.equal(dialogues, 1);
    assert.equal(options.buttons[0], '重新打开界面');
    choose({ response: 0 });
    await recovery.pending;
    assert.equal(loads, 2);
    const title = await win.webContents.executeJavaScript('document.title');
    assert.equal(title, 'isolated recovery fixture');
    const afterPid = win.webContents.getOSProcessId();
    assert.notEqual(afterPid, beforePid);
    recovery.dispose();
    win.destroy();
    finish({ ok: true, reason: details.reason, loads, dialogues, beforePid, afterPid, title, electron: process.versions.electron }, 0);
  } catch (error) { finish({ error: error.stack || String(error) }, 1); }
});
`);
  const env = { ...process.env, LIANHUA_DATA_DIR: path.join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_START_URL;
  child = spawn(require('electron'), [root, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : {};
  assert.equal(code, 0, JSON.stringify(result) + '\n' + output.slice(-4000));
  assert.equal(result.ok, true);
  assert.equal(result.loads, 2);
  assert.equal(result.dialogues, 1);
  t.diagnostic(`Electron ${result.electron}: ${result.reason}; reopened only after explicit choice in a new renderer process.`);
});
