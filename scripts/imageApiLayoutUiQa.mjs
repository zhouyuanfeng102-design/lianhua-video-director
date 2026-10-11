import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// This is one focused pass over the built renderer. Every setting is synthetic;
// no save, model fetch, import, generation, or task action is performed.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
assert.ok(electronOption === -1 || process.argv[electronOption + 1], '--electron requires an executable path');
const executable = electronOption === -1 ? null : path.resolve(process.argv[electronOption + 1]);
const output = path.join(root, 'output', 'playwright', `image-api-layout-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow a symbolic link: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = {
  pass: false, version, packagedElectron: Boolean(executable), isolatedStorage: true,
  noProductionDataRead: true, stages: [], layouts: [], screenshots: [],
  pageErrors: [], consoleErrors: [], blockedRequests: [], httpFailures: [],
};
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
let child;
let harness;
let browser;
let context;
let page;
let dataRoot;
const tolerance = 1.1;
const insideX = (outer, inner) => inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance;
const insideY = (outer, inner) => inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
const overlap = (left, right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance
  && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance;

try {
  if (executable) {
    await fs.access(executable);
    dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
    await fs.writeFile(path.join(dataRoot, 'qa-isolated-profile.txt'), 'Synthetic empty layout fixture. Do not import legacy state.\n');
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
  harness = createQaProcessHarness({ electron: child, qaLabel: 'image API layout', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });

  async function snapshot(name, { allowFormVerticalScroll = false } = {}) {
    const layout = await page.locator('.image-api-card').evaluate((card) => {
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0
          && !element.closest('[hidden], [aria-hidden="true"]');
      };
      const fieldLabel = (field) => field.querySelector(':scope > label, :scope > span')?.textContent?.trim() || '';
      const form = card.querySelector('.image-api-form');
      return {
        viewport: { width: innerWidth, height: innerHeight }, card: rect(card), form: rect(form),
        formClientHeight: form.clientHeight, formScrollHeight: form.scrollHeight,
        formClientWidth: form.clientWidth, formScrollWidth: form.scrollWidth,
        formScrollTop: form.scrollTop,
        sections: [...form.querySelectorAll(':scope > .image-api-section')].map((section) => ({
          className: section.className, heading: section.querySelector('h3')?.textContent?.trim(), rect: rect(section),
          fields: [...section.querySelectorAll('.field')].filter(visible).map((field) => ({
            label: fieldLabel(field), rect: rect(field),
            controls: [...field.querySelectorAll('input:not([type="checkbox"]), select, button')].filter(visible)
              .map((control) => ({ tag: control.tagName, type: control.type, text: control.textContent?.trim() || '', rect: rect(control) })),
          })),
        })),
      };
    });
    report.layouts.push({ name, allowFormVerticalScroll, ...layout });
    assert.equal(layout.sections.length, 2, `${name}: exactly two image API sections`);
    assert.match(layout.sections[0].className, /image-api-connection/u, `${name}: connection section first`);
    assert.match(layout.sections[1].className, /image-api-generation/u, `${name}: generation section second`);
    assert.equal(layout.sections[0].heading, '接口连接');
    assert.equal(layout.sections[1].heading, '模型与输出');
    assert.ok(insideX(layout.card, layout.form) && insideY(layout.card, layout.form), `${name}: form stays in card`);
    assert.ok(layout.formScrollWidth <= layout.formClientWidth + tolerance, `${name}: no horizontal form overflow`);
    if (!allowFormVerticalScroll) {
      assert.ok(layout.formScrollHeight <= layout.formClientHeight + tolerance, `${name}: complete form visible without vertical overflow`);
    }
    for (const section of layout.sections) {
      assert.ok(insideX(layout.card, section.rect), `${name}: ${section.heading} stays horizontally in card`);
      if (!allowFormVerticalScroll) assert.ok(insideY(layout.card, section.rect), `${name}: ${section.heading} stays vertically in card`);
      for (const field of section.fields) {
        assert.ok(insideX(section.rect, field.rect) && insideY(section.rect, field.rect), `${name}: ${field.label} stays in its section`);
        for (const control of field.controls) {
          assert.ok(insideX(field.rect, control.rect), `${name}: ${field.label} control does not extend horizontally`);
          assert.ok(insideY(field.rect, control.rect), `${name}: ${field.label} control stays in its field`);
          if (control.tag === 'INPUT' || control.tag === 'SELECT') {
            assert.ok(Math.abs(control.rect.height - 32) <= tolerance,
              `${name}: ${field.label} ${control.tag} height is 32px, got ${control.rect.height}`);
          }
        }
        for (let index = 0; index < field.controls.length; index += 1) {
          for (const other of field.controls.slice(index + 1)) {
            assert.ok(!overlap(field.controls[index].rect, other.rect), `${name}: ${field.label} controls do not overlap`);
          }
        }
      }
      for (let index = 0; index < section.fields.length; index += 1) {
        for (const other of section.fields.slice(index + 1)) {
          assert.ok(!overlap(section.fields[index].rect, other.rect), `${name}: fields ${section.fields[index].label} and ${other.label} do not overlap`);
        }
      }
    }
    assert.ok(!overlap(layout.sections[0].rect, layout.sections[1].rect), `${name}: sections do not overlap`);
    assert.ok(layout.card.left >= -tolerance && layout.card.right <= layout.viewport.width + tolerance
      && layout.card.top >= -tolerance && layout.card.bottom <= layout.viewport.height + tolerance, `${name}: card stays in viewport`);
    return layout;
  }

  async function screenshot(name) {
    const destination = path.join(output, `${name}.png`);
    await page.screenshot({ path: destination, scale: 'css' });
    report.screenshots.push(destination);
  }

  async function checkMainFieldsVisible(labels) {
    for (const label of labels) {
      // Resolve the field by its own label, excluding hidden ComfyUI manager controls.
      const field = page.locator('.image-api-card .image-api-section .field').filter({
        has: page.locator(':scope > label, :scope > span').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') }),
      });
      assert.equal(await field.count(), 1, `one visible main field for ${label}`);
      await field.scrollIntoViewIfNeeded();
      const visible = await field.evaluate((element) => {
        const current = element.getBoundingClientRect();
        const form = element.closest('.image-api-form').getBoundingClientRect();
        const control = element.querySelector('input:not([type="checkbox"]), select');
        const target = control?.getBoundingClientRect() || current;
        return target.left >= form.left - 1 && target.right <= form.right + 1
          && target.top >= form.top - 1 && target.bottom <= form.bottom + 1
          && target.top >= 0 && target.bottom <= innerHeight;
      });
      assert.ok(visible, `${label}: main control visible inside form and viewport`);
    }
  }

  async function run() {
    await waitForCondition({ label: 'built image API renderer startup', timeoutMs: 30_000, intervalMs: 100,
      check: async () => { try { return (await fetch(executable ? `${origin}/json/version` : origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = executable ? await chromium.connectOverCDP(origin) : await chromium.launch({ headless: true });
    context = executable ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1120, height: 720 }, serviceWorkers: 'block' });
    assert.ok(context, 'isolated renderer context must exist');
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const allowedHttp = !executable && url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/src/');
      if (/^https?:$/u.test(url.protocol) && !allowedHttp) {
        report.blockedRequests.push({ method: request.method(), pathname: url.pathname });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    page = executable ? context.pages().find((entry) => entry.url().startsWith('file:')) : await context.newPage();
    assert.ok(page, 'built renderer page must exist');
    page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) report.httpFailures.push({ pathname: new URL(response.url()).pathname, status: response.status() }); });
    if (executable) {
      const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
      assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase(), 'desktop data root must be the isolated QA profile');
      await page.reload({ waitUntil: 'networkidle' });
    } else {
      await page.goto(origin, { waitUntil: 'networkidle' });
    }
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`), 'built renderer shows the release version');
    assert.deepEqual(report.pageErrors, [], 'production initialization has no pageerror');
    await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
    const card = page.locator('.image-api-card');
    if (!(await card.isVisible())) await page.locator('.settings-api-tabs').getByRole('tab', { name: '图片 API', exact: true }).click();
    await card.waitFor({ state: 'visible' });
    const backend = card.getByLabel('后端', { exact: true });
    await backend.selectOption('openai');
    await card.getByLabel('API 地址', { exact: true }).fill('https://relay.example.invalid/v1');
    await card.getByLabel('API 密钥', { exact: true }).fill('qa-synthetic-image-key');
    await card.getByLabel('模型 / 工作流', { exact: true }).fill('gpt-image-2.5-sunburst-low');
    report.stages.push('built-renderer-and-synthetic-settings-ready');

    const openaiLabels = ['后端', 'API 地址', 'API 密钥', '模型 / 工作流', '生图协议', '模型分辨率规格'];
    for (const [width, height] of [[1120, 720], [1280, 800], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = `openai-${width}x${height}`;
      await snapshot(name);
      await checkMainFieldsVisible(openaiLabels);
      const tier = card.locator('.image-api-resolution-options').getByLabel('2K', { exact: true });
      await tier.setChecked(!(await tier.isChecked()));
      const restore = card.getByRole('button', { name: '恢复模型默认', exact: true });
      await restore.waitFor({ state: 'visible' });
      const alignment = await card.locator('.image-api-resolution-row').evaluate((row) => {
        const options = row.querySelector('.image-api-resolution-options').getBoundingClientRect();
        const button = row.querySelector('button').getBoundingClientRect();
        const parent = row.getBoundingClientRect();
        return {
          centerDelta: Math.abs((options.top + options.bottom) / 2 - (button.top + button.bottom) / 2),
          overlaps: Math.min(options.right, button.right) > Math.max(options.left, button.left) + 1,
          inside: button.left >= parent.left - 1 && button.right <= parent.right + 1,
        };
      });
      assert.ok(alignment.centerDelta <= 2 && !alignment.overlaps && alignment.inside, `${name}: restore button aligns with resolution choices`);
      await snapshot(`${name}-resolution-override`);
      await restore.click();
      assert.equal(await restore.count(), 0, `${name}: restore model default removes override`);
      await screenshot(name);
    }
    report.stages.push('openai-fields-32px-two-sections-three-window-sizes-and-resolution-restore-checked');

    await page.setViewportSize({ width: 1120, height: 720 });
    for (const value of ['sd_webui', 'novelai', 'comfyui']) {
      await backend.selectOption(value);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = `${value}-1120x720`;
      await snapshot(name, { allowFormVerticalScroll: value === 'comfyui' });
      await checkMainFieldsVisible(value === 'comfyui'
        ? ['后端', 'ComfyUI API 根地址', 'API 密钥（可选）', '宽高像素步长', '接口路径模式', '提交路径', '当前 Workflow']
        : ['后端', 'API 地址', 'API 密钥', '模型 / 工作流', '宽高像素步长']);
      await card.locator('.image-api-form').evaluate((form) => { form.scrollTop = 0; });
      await screenshot(name);
    }
    report.stages.push('sd-webui-novelai-comfyui-main-fields-and-no-horizontal-overflow-checked-at-1120x720');

    await backend.selectOption('openai');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await card.getByLabel('API 地址', { exact: true }).fill('https://relay.example.invalid/v1');
    await card.getByLabel('模型 / 工作流', { exact: true }).fill('gpt-image-2.5-sunburst-low');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await snapshot('final-openai-1920x1080');
    await screenshot('image-api-final-1920x1080');
    assert.deepEqual(report.pageErrors, [], 'production module has no pageerror');
    assert.deepEqual(report.consoleErrors, [], 'renderer has no console errors');
    assert.deepEqual(report.blockedRequests, [], 'settings-only QA issues no external requests');
    assert.deepEqual(report.httpFailures, [], 'built entry has no HTTP failure');
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) {
    const destination = path.join(output, 'image-api-failure.png');
    await page.screenshot({ path: destination, scale: 'css' }).then(() => report.screenshots.push(destination)).catch(() => {});
  }
} finally {
  if (!executable) await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  harness?.markElectronStopping();
  await harness?.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  if (harness) await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, stages: report.stages, pageErrors: report.pageErrors,
  failure: report.failure?.message, report: path.join(output, 'report.json') }, null, 2));
