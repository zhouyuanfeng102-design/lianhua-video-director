import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Check the already-built renderer, never Vite's source-module dev server.
// Optional --electron <exe> uses the packaged file:// entry with a fresh,
// explicitly pinned profile. No production project or credential is loaded.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
const executable = electronOption === -1 ? null : path.resolve(process.argv[electronOption + 1] || '');
if (electronOption !== -1) assert.ok(process.argv[electronOption + 1], '--electron requires an executable path');
const output = path.join(root, 'output', 'playwright', `production-startup-${version}-${executable ? 'electron' : 'browser'}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow a symbolic link: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = { pass: false, version, packagedElectron: Boolean(executable), isolatedStorage: true,
  noProductionDataRead: true, stages: [], pageErrors: [], consoleErrors: [], blockedRequests: [], httpFailures: [] };
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
let child;
let browser;
let context;
let page;
let harness;
let dataRoot;

try {
  if (executable) {
    await fs.access(executable);
    dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
    // A non-runtime marker prevents main.cjs's empty-profile legacy migration.
    await fs.writeFile(path.join(dataRoot, 'qa-isolated-profile.txt'), 'Synthetic empty startup fixture. Do not import legacy state.\n');
    const env = { ...process.env, LIANHUA_DATA_DIR: dataRoot, LIANHUA_QA_MODE: '1' };
    delete env.ELECTRON_START_URL;
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [`--remote-debugging-port=${port}`, '--no-first-run'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    assert.match(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), /assets\/index-[^"\s]+\.js/u);
    const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  harness = createQaProcessHarness({ electron: child, qaLabel: 'production renderer startup', runTimeoutMs: 90_000, closeTimeoutMs: 10_000 });

  async function run() {
    await waitForCondition({ label: 'production entry startup', timeoutMs: 30_000, intervalMs: 100,
      check: async () => { try { return (await fetch(executable ? `${origin}/json/version` : origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = executable ? await chromium.connectOverCDP(origin) : await chromium.launch({ headless: true });
    context = executable ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
    assert.ok(context, 'packaged app must expose its isolated renderer context');
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const allowedHttp = !executable && url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/src/');
      if (/^https?:$/u.test(url.protocol) && !allowedHttp) {
        report.blockedRequests.push(`${request.method()} ${url.pathname}`);
        await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = executable ? context.pages().find((entry) => entry.url().startsWith('file:')) : await context.newPage();
    assert.ok(page, 'packaged app must load the local file entry');
    page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) report.httpFailures.push({ pathname: new URL(response.url()).pathname, status: response.status() }); });
    if (executable) {
      const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
      assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase(), 'desktop profile must be the synthetic fixture');
      report.stages.push('packaged-file-entry-and-isolated-data-root-confirmed');
      // Reload after attaching error listeners, so module TDZ failures cannot
      // escape detection just because the first window loaded before CDP.
      await page.reload({ waitUntil: 'networkidle' });
    } else {
      await page.goto(origin, { waitUntil: 'networkidle' });
    }
    assert.deepEqual(report.pageErrors, [], 'production module initialization must not throw');
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.sidebar').waitFor({ state: 'visible' });
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`), 'built renderer must show the release version');
    report.stages.push(`production-renderer-mounted-v${version}`);
    await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
    await page.locator('.source-settings-card').waitFor({ state: 'visible' });
    report.stages.push('prompt-director-entry-rendered');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.blockedRequests, []);
    assert.deepEqual(report.httpFailures, []);
    report.screenshot = path.join(output, 'startup.png');
    await page.screenshot({ path: report.screenshot, scale: 'css' });
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) {
    report.screenshot = path.join(output, 'startup-failure.png');
    await page.screenshot({ path: report.screenshot, scale: 'css' }).catch(() => {});
  }
} finally {
  if (!executable) await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  harness?.markElectronStopping();
  await harness?.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  if (harness) await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, stages: report.stages, pageErrors: report.pageErrors,
  failure: report.failure?.message, report: path.join(output, 'report.json') }, null, 2));
