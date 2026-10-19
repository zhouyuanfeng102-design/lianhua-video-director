import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the actual portable package once, without loading user data or
// submitting generation requests. Keep the isolated profile as release evidence.
const root = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const configuredExecutable = String(process.env.APP_EXECUTABLE || '').trim();
assert.ok(configuredExecutable, 'APP_EXECUTABLE must point to the portable EXE');
const executable = fs.realpathSync.native(path.resolve(configuredExecutable));
assert.ok(fs.statSync(executable).isFile() && /\.exe$/iu.test(executable), 'APP_EXECUTABLE must be an existing EXE');
assert.ok(!/(?:^|[\\/])(?:node_modules|win-unpacked)(?:[\\/]|$)/iu.test(executable)
  && path.basename(executable).toLowerCase() !== 'electron.exe', 'Use the portable EXE, not development Electron');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outputBase = path.join(root, 'output', 'playwright');
fs.mkdirSync(outputBase, { recursive: true });
const outputDirectory = fs.mkdtempSync(path.join(outputBase, `packaged-startup-${expectedVersion}-`));
const dataDirectory = path.join(outputDirectory, 'isolated-profile');
const bootstrapTemp = path.join(outputDirectory, 'portable-bootstrap');
fs.mkdirSync(dataDirectory);
fs.mkdirSync(bootstrapTemp);
// Electron migrates legacy data only into empty profiles. This non-runtime entry
// must exist before the child starts, even though no project fixture is needed.
fs.writeFileSync(path.join(dataDirectory, '.qa-isolated-profile'), 'Isolated packaged startup smoke. Never import production data.\n', { flag: 'wx' });
const normalizePath = (value) => path.resolve(value).toLowerCase();
const port = await findAvailableTcpPort();
const cdpOrigin = `http://127.0.0.1:${port}`;
const environment = { ...process.env, LIANHUA_DATA_DIR: dataDirectory,
  TEMP: bootstrapTemp, TMP: bootstrapTemp, TMPDIR: bootstrapTemp };
for (const key of ['ELECTRON_START_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LIANHUA_QA_MODE']) delete environment[key];
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
  cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'packaged startup smoke', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
const report = { passed: false, executable, expectedVersion, dataDirectory, outputDirectory,
  launcherPid: child.pid, isolatedProfileConfirmed: false, noGenerationSubmitted: true,
  pageErrors: [], runtimeErrors: [], rendererErrors: [], externalRequests: [], screenshots: [] };
let browser;
let page;
let runtimeSession;
let failure;
let closedGracefully = false;

const collectRendererLog = () => {
  const logPath = path.join(dataDirectory, 'logs', 'renderer.log');
  const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  fs.writeFileSync(path.join(outputDirectory, 'renderer.log'), content);
  report.rendererErrors = content.split(/\r?\n/u)
    .filter((line) => /console level=(?:error|3)\b|did-fail-load|render-process-gone|initial-load failed:/u.test(line));
};
const screenshot = async (name) => {
  await page.screenshot({ path: path.join(outputDirectory, name), fullPage: false, timeout: 5000 });
  report.screenshots.push(name);
};
const boundedCleanup = async (operation) => {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(operation).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 2500); })]);
  } finally { clearTimeout(timer); }
};

const run = async () => {
  await waitForCondition({ label: 'portable EXE debugging endpoint', timeoutMs: 75_000, intervalMs: 200,
    check: async () => {
      try { return (await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    } });
  browser = await chromium.connectOverCDP(cdpOrigin, { timeout: 15_000 });
  const context = browser.contexts()[0];
  assert.ok(context, 'Packaged Electron must expose its default context');
  await context.route(/^https?:\/\//u, async (route) => {
    report.externalRequests.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort('blockedbyclient');
  });
  await waitForCondition({ label: 'packaged renderer page', timeoutMs: 15_000, intervalMs: 100,
    check: () => {
      page = context.pages().find((candidate) => candidate.url().startsWith('file:')) || context.pages()[0];
      return Boolean(page);
    } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
  runtimeSession = await context.newCDPSession(page);
  runtimeSession.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    report.runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  await runtimeSession.send('Runtime.enable');
  await page.waitForFunction(() => Boolean(window.lianhuaDesktop?.storagePaths));
  const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
  assert.equal(normalizePath(actualRoot), normalizePath(dataDirectory), 'The EXE must use the isolated data root');
  report.isolatedProfileConfirmed = true;
  report.actualDataRoot = actualRoot;
  await page.locator('.app-shell').waitFor({ state: 'visible' });
  await page.locator('.sidebar').waitFor({ state: 'visible' });
  assert.match(page.url(), /^file:.*[\\/]resources[\\/]app\.asar[\\/]dist[\\/]index\.html$/iu,
    'The renderer must load production files inside the portable package');
  report.rendererUrl = page.url();
  report.actualVersion = (await page.locator('.sidebar-version > span:last-child').innerText()).trim();
  assert.equal(report.actualVersion, `v${expectedVersion}`);
  await screenshot('01-startup.png');
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.locator('.section-heading').getByRole('heading', { name: '视频导演台', exact: true }).waitFor({ state: 'visible' });
  await screenshot('02-video-director.png');
  collectRendererLog();
  for (const key of ['pageErrors', 'runtimeErrors', 'rendererErrors', 'externalRequests']) {
    assert.deepEqual(report[key], [], `${key} must remain empty during packaged startup and navigation`);
  }
  harness.markElectronStopping();
  // Close only the endpoint whose isolated data root was confirmed above.
  const browserSession = await browser.newBrowserCDPSession();
  await boundedCleanup(() => browserSession.send('Browser.close'));
  await harness.waitForElectronClose();
  assert.equal(child.exitCode, 0, 'Portable EXE must exit normally');
  closedGracefully = true;
};

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
} finally {
  harness.markElectronStopping();
  // Fallback cleanup targets the spawned PID and its children only. It never
  // matches by application name or touches other open Lianhua processes.
  try { await harness.stopAll(); } catch (error) { failure ||= error; }
  await boundedCleanup(() => runtimeSession?.detach());
  await boundedCleanup(() => browser?.close());
  collectRendererLog();
  if (!failure && report.rendererErrors.length) failure = new Error('Renderer errors were recorded during shutdown');
  fs.writeFileSync(path.join(outputDirectory, 'process.log'), harness.readElectronLog());
  Object.assign(report, { passed: !failure, closedGracefully, exitCode: child.exitCode,
    ...(failure ? { failure: failure.stack || String(failure) } : {}) });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, version: report.actualVersion, isolatedProfileConfirmed: report.isolatedProfileConfirmed,
    report: path.join(outputDirectory, 'report.json'), screenshots: report.screenshots,
    ...(failure ? { failure: failure.message || String(failure) } : {}) }, null, 2));
}
if (failure) process.exitCode = 1;
