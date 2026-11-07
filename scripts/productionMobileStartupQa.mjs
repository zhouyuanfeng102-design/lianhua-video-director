import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

// The already-built production graph is the subject. Never rebuild here.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `production-mobile-startup-${version}`);
await fs.mkdir(output, { recursive: true });
const report = { version, productionDist: true, isolatedStorage: true, passed: false, errors: [], blockedRequests: [], layouts: [], screenshots: [] };
const server = await preview({ root, preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  browser = await chromium.launch({ headless: true });
  for (const device of [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'desktop', width: 1280, height: 800, mobile: false }]) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, isMobile: device.mobile, hasTouch: device.mobile, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['blob:', 'data:'].includes(url.protocol) && (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/src/'))) {
        report.blockedRequests.push({ device: device.name, method: request.method(), url: `${url.origin}${url.pathname}` });
        await route.abort();
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.errors.push({ device: device.name, error: error.stack || error.message }));
    const capture = async (label) => {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell');
        const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
        return { mobileShell: shell?.classList.contains('mobile-shell'), zoom: shell && getComputedStyle(shell).zoom,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight,
          mobileNavBottom: nav?.bottom, heading: document.querySelector('.mobile-header strong, .section-heading h1, .section-heading h2')?.textContent };
      });
      report.layouts.push({ device: device.name, label, ...layout });
      assert.equal(layout.mobileShell, device.mobile, `${device.name} must use its actual production layout`);
      assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${device.name} ${label} must fit the window`);
      if (device.mobile) {
        assert.equal(Number(layout.zoom), 1, 'phone layout must not shrink the desktop canvas');
        assert.ok(layout.mobileNavBottom <= device.height + 1, 'phone navigation must remain reachable');
      }
      const screenshot = path.join(output, `${device.name}-${label}.png`);
      await page.screenshot({ path: screenshot, fullPage: false, animations: 'disabled' });
      report.screenshots.push(screenshot);
      assert.deepEqual(report.errors, [], 'production startup and navigation must not throw JavaScript errors');
    };
    await page.goto(origin, { waitUntil: 'networkidle', timeout: 60_000 });
    assert.deepEqual(report.errors, [], 'production module initialization must complete');
    await page.locator(device.mobile ? '.mobile-shell' : '.sidebar').waitFor();
    await capture('default');
    if (device.mobile) await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '素材', exact: true }).click();
    else await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
    await page.locator('.assets-view').waitFor();
    await capture('assets');
    if (device.mobile) await page.getByRole('button', { name: '打开 API 设置', exact: true }).click();
    else await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
    await page.locator('.settings-api-tabs').waitFor();
    await capture('api');
    await context.close();
  }
  assert.deepEqual(report.blockedRequests, [], 'isolated default pages must not request external services');
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
