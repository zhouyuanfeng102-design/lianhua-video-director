import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const qaArtifacts = await import('./qaArtifacts.mjs');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

const runScript = (scriptPath, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal, stderr, stdout }));
});

test('persistent QA reports retain partial page evidence and the original failure', async (t) => {
  assert.equal(typeof qaArtifacts.runWithPersistentQaReport, 'function');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-report-helper-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const report = { url: 'http://app.test/', pages: [], consoleErrors: [] };
  const failure = new Error('API settings single-screen check failed');

  await assert.rejects(
    qaArtifacts.runWithPersistentQaReport(temporaryRoot, report, async () => {
      report.pages.push({ navigation: '项目总览', fileName: '01-项目总览.png' });
      throw failure;
    }),
    (error) => error === failure,
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'report.json'), 'utf8')), {
    url: 'http://app.test/',
    pages: [{ navigation: '项目总览', fileName: '01-项目总览.png' }],
    consoleErrors: [],
    passed: false,
    status: 'failed',
    error: 'API settings single-screen check failed',
  });
});

test('persistent QA reports mark successful runs without changing their page evidence', async (t) => {
  assert.equal(typeof qaArtifacts.runWithPersistentQaReport, 'function');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-report-helper-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const report = { url: 'http://app.test/', pages: [], consoleErrors: [] };

  const settled = await qaArtifacts.runWithPersistentQaReport(temporaryRoot, report, async () => {
    report.pages.push({ navigation: '项目总览', fileName: '01-项目总览.png' });
  });

  assert.equal(settled, report);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'report.json'), 'utf8')), {
    url: 'http://app.test/',
    pages: [{ navigation: '项目总览', fileName: '01-项目总览.png' }],
    consoleErrors: [],
    passed: true,
    status: 'passed',
    error: null,
  });
});

test('UI smoke persists a structured failed report when the CDP socket cannot connect', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-ui-smoke-output-report-'));
  const outputDirectory = path.join(temporaryRoot, 'qa-output');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  let debuggerPort = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{
        id: 'failure-target',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: `ws://127.0.0.1:${debuggerPort}/devtools/page/failure-target`,
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  debuggerPort = await listen(server);
  t.after(() => close(server));

  const appUrl = 'http://127.0.0.1:5197/report-probe';
  const result = await runScript(path.join(root, 'scripts', 'uiSmoke.mjs'), {
    APP_URL: appUrl,
    CDP_CONNECTION_TIMEOUT_MS: '1000',
    CDP_PORT: String(debuggerPort),
    QA_BOOTSTRAP_ONLY: '1',
    QA_OUTPUT: outputDirectory,
  });

  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(outputDirectory, 'report.json');
  assert.equal(
    fs.existsSync(reportPath),
    true,
    `the failed run must leave report.json in QA_OUTPUT\n${result.stdout}\n${result.stderr}`,
  );
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const { error, ...reportWithoutError } = report;
  assert.deepEqual(reportWithoutError, {
    url: appUrl,
    deviceScaleFactor: 1,
    pages: [],
    consoleErrors: [],
    passed: false,
    status: 'failed',
  });
  assert.match(error, /CDP|WebSocket|socket/iu);
});
