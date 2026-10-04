import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One focused sidebar matrix. Only fresh browser storage and synthetic logs;
// no production files, external requests, real clipboard writes or generation.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'sidebar-fit-0.5.85'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Sidebar QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Sidebar QA output cannot traverse directory links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const errorKey = 'lianhua_runtime_error_log_v1';
const expectedLabels = ['项目总览', '剧情解析', '提示词导演台', '视频导演台', '分镜时间线', '生成任务', '图像工作台', '视频工作台', '资产库', '规则中心', 'API 设置'];
const viewports = [{ width: 1280, height: 800 }, { width: 1280, height: 650 }, { width: 1280, height: 500 }, { width: 900, height: 600 }];
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Sidebar fit isolated fixture ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused sidebar fit UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const measurements = [];
const resizeRecoveries = [];
const screenshots = [];

const settle = async () => {
  await page.evaluate(() => { window.__sidebarFitStable = undefined; });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.sidebar nav');
    const first = document.querySelector('.sidebar .nav-item');
    const footer = document.querySelector('.sidebar-footer');
    if (!nav || !first || !footer) return false;
    const key = [nav.clientHeight, nav.clientWidth, first.getBoundingClientRect().height.toFixed(3), footer.getBoundingClientRect().top.toFixed(3), getComputedStyle(first).fontSize].join('|');
    const prior = window.__sidebarFitStable;
    window.__sidebarFitStable = { key, count: prior?.key === key ? prior.count + 1 : 0 };
    return window.__sidebarFitStable.count >= 4;
  }, undefined, { timeout: 12_000, polling: 'raf' });
};

const measure = async (label) => {
  await settle();
  const data = await page.evaluate(() => {
    const rect = (element) => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }; };
    const nav = document.querySelector('.sidebar nav');
    const brand = document.querySelector('.brand');
    const footer = document.querySelector('.sidebar-footer');
    const main = document.querySelector('.main');
    const shell = document.querySelector('.app-shell');
    const mainHeading = document.querySelector('.crumb h1');
    const navStyle = getComputedStyle(nav);
    const buttons = [...nav.querySelectorAll('.nav-item')].map((button) => {
      const name = button.querySelector('.nav-item-label');
      const range = document.createRange(); range.selectNodeContents(name);
      const textRect = range.getBoundingClientRect();
      const bounds = rect(button);
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { label: name.textContent.trim(), rect: bounds, layoutHeight: button.offsetHeight, labelRect: rect(name), textRect: { x: textRect.x, y: textRect.y, right: textRect.right, bottom: textRect.bottom }, clientWidth: name.clientWidth, scrollWidth: name.scrollWidth, clientHeight: name.clientHeight, scrollHeight: name.scrollHeight, hit: button === hit || button.contains(hit) };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight }, fontScale: Number(shell.dataset.uiFontScale),
      brand: rect(brand), footer: rect(footer), nav: rect(nav), sidebar: rect(document.querySelector('.sidebar')),
      navOverflow: navStyle.overflowY, navScrollTop: nav.scrollTop, navClientHeight: nav.clientHeight, navScrollHeight: nav.scrollHeight,
      navScrollbarWidth: nav.offsetWidth - nav.clientWidth - parseFloat(navStyle.borderLeftWidth) - parseFloat(navStyle.borderRightWidth),
      buttons, renderScale: buttons[0].rect.height / buttons[0].layoutHeight,
      utility: [...nav.querySelectorAll('.update-log-trigger,.runtime-error-log-trigger,.runtime-error-log-latest,.nav-section-label')].map((element) => ({ text: element.textContent.trim(), rect: rect(element) })),
      mainTransform: getComputedStyle(main).transform, mainZoom: getComputedStyle(main).zoom,
      shellTransform: getComputedStyle(shell).transform, shellZoom: getComputedStyle(shell).zoom,
      mainHeadingFontSize: parseFloat(getComputedStyle(mainHeading).fontSize),
      hasNotice: Boolean(document.querySelector('.sidebar-notice')), hasLatestError: Boolean(document.querySelector('.runtime-error-log-latest')),
    };
  });
  assert.deepEqual(data.buttons.map((button) => button.label), expectedLabels, `${label}: all ten columns remain present`);
  assert.ok(data.brand.y >= -1 && data.brand.bottom <= data.nav.y + 1, `${label}: brand/nav overlap`);
  assert.ok(data.nav.bottom <= data.footer.y + 1 && data.footer.bottom <= data.viewport.height + 1, `${label}: nav/footer overlap or clipped footer`);
  assert.ok(data.sidebar.bottom <= data.viewport.height + 1, `${label}: sidebar exceeds available window height`);
  assert.ok(!(['auto', 'scroll'].includes(data.navOverflow) && data.navScrollHeight > data.navClientHeight + 1), `${label}: sidebar still needs a scrolling viewport`);
  assert.ok(data.navScrollbarWidth <= 1.5, `${label}: a scrollbar gutter consumes sidebar width`);
  for (const button of data.buttons) {
    assert.ok(button.rect.y >= data.nav.y - 1 && button.rect.bottom <= data.nav.bottom + 1, `${label}: ${button.label} is vertically clipped`);
    assert.ok(button.rect.x >= data.nav.x - 1 && button.rect.right <= data.nav.right + 1, `${label}: ${button.label} is horizontally clipped`);
    assert.ok(button.hit, `${label}: ${button.label} is obscured and not clickable`);
    assert.ok(button.scrollWidth <= button.clientWidth + 1, `${label}: ${button.label} still ellipsizes (${button.scrollWidth}/${button.clientWidth})`);
    assert.ok(button.scrollHeight <= button.clientHeight + 1, `${label}: ${button.label} text height is clipped`);
    assert.ok(button.textRect.x >= button.labelRect.x - 1 && button.textRect.right <= button.labelRect.right + 1, `${label}: ${button.label} real glyph range is clipped`);
    assert.ok(button.textRect.y >= button.rect.y - 1 && button.textRect.bottom <= button.rect.bottom + 1, `${label}: ${button.label} glyphs overflow the card`);
  }
  for (const item of data.utility) assert.ok(item.rect.y >= data.nav.y - 1 && item.rect.bottom <= data.nav.bottom + 1, `${label}: utility item clipped: ${item.text}`);
  assert.equal(data.mainTransform, 'none', `${label}: main content must not inherit sidebar shrink`);
  assert.equal(data.shellTransform, 'none', `${label}: entire application must not shrink`);
  assert.ok(['1', 'normal'].includes(data.mainZoom) && ['1', 'normal'].includes(data.shellZoom), `${label}: sidebar fit changed body/application zoom`);
  await page.mouse.move(data.nav.x + 3, data.nav.y + data.nav.height / 2);
  await page.mouse.wheel(0, 650);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterWheel = await page.locator('.sidebar nav').evaluate((nav) => nav.scrollTop);
  assert.equal(afterWheel, data.navScrollTop, `${label}: wheel changed internal nav scrollTop`);
  await page.mouse.move(data.sidebar.right + 12, 10);
  return { label, ...data, scrollTopAfterWheel: afterWheel };
};

const showNotice = async () => {
  await page.locator('.sidebar .runtime-error-log-trigger').click();
  const dialog = page.getByRole('dialog', { name: '报错日志', exact: true });
  await dialog.getByRole('button', { name: '复制日志', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.sidebar-notice.error').waitFor();
};

const run = async () => {
  await waitForCondition({ label: 'sidebar fit Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  for (const feedback of [false, true]) {
    context = await browser.newContext({ viewport: viewports[0] });
    page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__sidebar_fit_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__sidebar_fit_qa__', '1'); }
      // A failed clipboard stub creates the existing error notice without
      // modifying the operating-system clipboard or contacting an API.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('isolated clipboard stub'); } } });
      const originalExec = document.execCommand?.bind(document);
      document.execCommand = (command, ...args) => command === 'copy' ? false : originalExec?.(command, ...args) || false;
    });
    await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
      errors.push(`Unexpected non-local request: ${route.request().url()}`); await route.abort('blockedbyclient');
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await page.evaluate(({ stateKey, logKey, hasErrors }) => {
      const state = JSON.parse(localStorage.getItem(stateKey));
      state.project = { ...state.project, id: 'sidebar-fit-project', name: '侧栏布局隔离验收', assets: [], generationTasks: [], storyboards: [], sequencePlans: [] };
      state.projects = [state.project]; state.activeProjectId = state.project.id;
      state.settings.uiFontScalePercent = 100;
      for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[key].enabled = false;
      localStorage.setItem(stateKey, JSON.stringify(state));
      localStorage.setItem(logKey, JSON.stringify(hasErrors ? [{ id: 'sidebar-fit-error', occurredAt: Date.now(), stage: 'storyboard-translate', message: '仅用于侧栏尺寸验收的合成错误记录。', projectId: state.project.id, projectName: state.project.name }] : []));
    }, { stateKey: storageKey, logKey: errorKey, hasErrors: feedback });
    await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
    await page.locator('.sidebar .nav-item').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(outputDirectory, `sidebar-${feedback ? 'feedback' : 'normal'}-snapshot.yml`), await page.locator('.sidebar').ariaSnapshot());
    if (feedback) {
      const errorsOnly = await measure('latest-error-before-notice');
      assert.equal(errorsOnly.hasLatestError, true); assert.equal(errorsOnly.hasNotice, false);
      measurements.push(errorsOnly);
    }
    for (const fontScale of [100, 130]) {
      await page.setViewportSize(viewports[0]);
      if (fontScale !== 100) {
        await page.getByRole('button', { name: '界面与字体设置', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '界面设置', exact: true });
        await dialog.getByLabel('自定义字体大小百分比', { exact: true }).fill(String(fontScale));
        await dialog.getByRole('button', { name: '完成', exact: true }).click();
      }
      let tall;
      let short;
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        if (feedback) await showNotice();
        const label = `${feedback ? 'notice-error' : 'normal'}-${viewport.width}x${viewport.height}-font${fontScale}`;
        const result = await measure(label);
        assert.equal(result.fontScale, fontScale);
        assert.equal(result.hasLatestError, feedback);
        assert.equal(result.hasNotice, feedback);
        if (viewport.width === 1280 && viewport.height === 800) tall = result;
        if (viewport.width === 1280 && viewport.height === 500) short = result;
        if (viewport.width === 1280 && tall) assert.equal(result.mainHeadingFontSize, tall.mainHeadingFontSize, `${label}: height-only sidebar fit changed the main heading font`);
        measurements.push(result);
        if ((!feedback && fontScale === 100 && viewport.height === 800) || (fontScale === 130 && (viewport.height === 500 || feedback && viewport.width === 900))) {
          const file = `${label}.png`; await page.screenshot({ path: path.join(outputDirectory, file), fullPage: false }); screenshots.push(file);
        }
      }
      assert.ok(short.renderScale < tall.renderScale - 0.01, 'reducing window height must automatically apply a smaller nav-only fit');
      await page.setViewportSize(viewports[0]);
      if (feedback) await showNotice();
      const recovered = await measure(`${feedback ? 'notice-error' : 'normal'}-height-restored-font${fontScale}`);
      assert.ok(Math.abs(recovered.renderScale - tall.renderScale) < 0.03, 'restoring window height must release stale sidebar shrink');
      resizeRecoveries.push({ feedback, fontScale, tallScale: tall.renderScale, shortScale: short.renderScale, restoredScale: recovered.renderScale });
    }
    await context.close(); context = undefined;
  }
  assert.deepEqual(errors, []);
  const report = { isolatedStorage: true, noProductionDataRead: true, matrixCases: measurements.length, resizeRecoveries, screenshots, measurements, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ matrixCases: measurements.length, resizeRecoveries, screenshots, errors }, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), cause: error?.cause ? String(error.cause) : undefined, measurements, resizeRecoveries, errors }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
