import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

// Test the built renderer, not Vite's source-module graph. A pure helper put in
// the wrong manual chunk can pass component tests but fail before React mounts.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `production-startup-${version}`);
await fs.mkdir(output, { recursive: true });
const report = { passed: false, version, productionDist: true, isolatedStorage: true, pageErrors: [], blockedRequests: [] };
const server = await preview({ root, preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/src/')) {
      report.blockedRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort(); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.deepEqual(report.pageErrors, [], 'production module initialization must complete before React mounts');
  await page.locator('.sidebar').waitFor();
  assert.ok((await page.locator('body').innerText()).includes(`v${version}`));
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.locator('.section-heading').getByRole('heading', { name: '视频导演台', exact: true }).waitFor();
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blockedRequests, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
