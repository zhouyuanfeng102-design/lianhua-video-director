import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Smoke the already-built production chunks with empty isolated browser
// storage. No source-module imports, real projects, or API calls are used.
const root = path.resolve(import.meta.dirname, '..');
const packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.join(outputBase, 'image-resolution-production-smoke');
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const report = { pass: false, productionDist: true, emptyIsolatedStorage: true, noProductionDataRead: true, noSourceImports: true, origin, stages: [], pageErrors: [], consoleErrors: [], blockedRequests: [], sourceRequests: [], httpFailures: [], screenshot: null };

assert.ok(path.relative(outputBase, outputDirectory) && !path.relative(outputBase, outputDirectory).startsWith('..'));
for (const directory of [path.join(root, 'output'), outputBase, outputDirectory]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow a symbolic link: ${directory}`);
}
await fs.mkdir(outputDirectory, { recursive: true });
assert.match(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), /assets\/index-[^"\s]+\.js/u);

const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const preview = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: preview, qaLabel: 'production image resolution bundle smoke', runTimeoutMs: 90_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;

async function run() {
  await waitForCondition({ label: 'local dist preview startup', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) {
      report.blockedRequests.push(url.href); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname.startsWith('/src/')) {
      report.sourceRequests.push(url.href); await route.abort('blockedbyclient'); return;
    }
    if (route.request().method() !== 'GET') {
      report.blockedRequests.push(`${route.request().method()} ${url.href}`); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) report.httpFailures.push({ url: response.url(), status: response.status() }); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').waitFor();
  assert.ok((await page.locator('body').innerText()).includes(`v${packageVersion}`));
  report.stages.push(`production-App-starts-and-displays-v${packageVersion}`);
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  const ordinary = page.getByRole('combobox', { name: '普通生图分辨率', exact: true });
  assert.equal(await ordinary.inputValue(), '1k');
  assert.deepEqual(await ordinary.locator('option').evaluateAll((items) => items.slice(0, 3).map((item) => item.textContent)), ['1K', '2K', '4K']);
  report.stages.push('new-ordinary-image-resolution-default-is-1K');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  const privateResolution = page.getByRole('combobox', { name: '私密生图分辨率', exact: true });
  assert.equal(await privateResolution.inputValue(), '1k');
  assert.deepEqual(await privateResolution.locator('option').evaluateAll((items) => items.slice(0, 3).map((item) => item.textContent)), ['1K', '2K', '4K']);
  report.stages.push('new-private-image-resolution-default-is-1K');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.blockedRequests, []);
  assert.deepEqual(report.sourceRequests, []);
  assert.deepEqual(report.httpFailures, []);
  report.screenshot = path.join(outputDirectory, 'production-private-default-1k.png');
  await page.screenshot({ path: report.screenshot, scale: 'css' });
  report.pass = true;
}

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page) {
    report.failure.bodyText = await page.locator('body').innerText().catch(() => '');
    report.screenshot = path.join(outputDirectory, 'production-failure.png');
    await page.screenshot({ path: report.screenshot, scale: 'css' }).catch(() => {});
  }
  process.exitCode = error.exitCode || 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  harness.markElectronStopping();
  await harness.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outputDirectory, 'preview-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: report.pass, stages: report.stages, pageErrors: report.pageErrors, report: path.join(outputDirectory, 'report.json'), screenshot: report.screenshot, failure: report.failure?.message }, null, 2));
