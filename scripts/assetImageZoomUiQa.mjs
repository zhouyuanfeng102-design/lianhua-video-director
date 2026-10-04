import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated browser storage, synthetic bitmaps, and loopback Vite only. There is
// no desktop connection, production-state read, external request, or real save.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `asset-image-zoom-${Date.now()}`));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Image zoom QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Image zoom QA output must not traverse directory links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const viteBootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated image zoom QA Vite ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', viteBootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'asset image zoom UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const results = [];
const screenshots = [];
const scenarios = [
  { width: 1280, height: 800, font: 100 },
  { width: 1120, height: 720, font: 100 },
  { width: 1280, height: 800, font: 130 },
  { width: 1120, height: 720, font: 130 },
];

const zoomButton = (name) => page.locator('.asset-preview-modal').getByRole('button', { name, exact: true });
const zoomOutput = () => page.locator('.asset-preview-modal').getByLabel('图片缩放比例', { exact: true });
const waitForZoom = async (percentage) => {
  await page.waitForFunction((expected) => {
    const output = document.querySelector('.asset-preview-modal [aria-label="图片缩放比例"]');
    return output?.textContent?.trim() === `${expected}%`;
  }, percentage);
};

const layout = async () => page.locator('.asset-preview-modal').evaluate((modal) => {
  const pane = modal.querySelector('.asset-preview-pane');
  const image = pane.querySelector('img');
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const identify = (element) => element.getAttribute('aria-label') || element.textContent.trim();
  const controls = [...modal.querySelectorAll('button')].map((element) => {
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left); let right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top); let bottom = Math.min(innerHeight, rect.bottom);
    // The backdrop is fixed; page scrollers behind it do not clip the dialog.
    for (let ancestor = element.parentElement; ancestor && ancestor !== modal.parentElement; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor); const parent = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { left = Math.max(left, parent.left); right = Math.min(right, parent.right); }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { top = Math.max(top, parent.top); bottom = Math.min(bottom, parent.bottom); }
    }
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return {
      name: identify(element), ...box(element),
      fullyVisible: right - left >= rect.width - 1 && bottom - top >= rect.height - 1,
      reachable: Boolean(hit && (hit === element || element.contains(hit))),
    };
  });
  const overlappingControls = [];
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i]; const b = controls[j];
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlappingControls.push([a.name, b.name]);
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    fontScale: Number(getComputedStyle(modal).getPropertyValue('--ui-font-scale').trim()),
    modal: box(modal), pane: { ...box(pane), clientWidth: pane.clientWidth, clientHeight: pane.clientHeight, scrollWidth: pane.scrollWidth, scrollHeight: pane.scrollHeight },
    image: { ...box(image), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, transform: getComputedStyle(image).transform },
    controls, overlappingControls,
  };
});

const checkLayout = (value, label) => {
  assert.ok(value.modal.left >= -1 && value.modal.right <= value.viewport.width + 1 && value.modal.top >= -1 && value.modal.bottom <= value.viewport.height + 1, `${label}: dialog remains inside viewport`);
  assert.ok(value.pane.clientWidth > 0 && value.pane.clientHeight >= 100, `${label}: image retains usable space`);
  assert.deepEqual(value.controls.filter((control) => !control.fullyVisible || !control.reachable).map((control) => control.name), [], `${label}: zoom/close/save buttons remain fully visible and reachable`);
  assert.deepEqual(value.overlappingControls, [], `${label}: dialog controls do not overlap`);
  assert.equal(value.image.transform, 'none', `${label}: image uses real dimensions, not transform-only zoom`);
  assert.ok(Math.abs(value.image.width / value.image.height - value.image.naturalWidth / value.image.naturalHeight) < .005, `${label}: image aspect ratio is preserved`);
};

const checkFit = (value, label) => {
  checkLayout(value, label);
  assert.ok(value.image.width <= value.pane.clientWidth + 1 && value.image.height <= value.pane.clientHeight + 1, `${label}: whole image fits in pane`);
  assert.ok(value.image.left >= value.pane.left - 1 && value.image.right <= value.pane.right + 1 && value.image.top >= value.pane.top - 1 && value.image.bottom <= value.pane.bottom + 1, `${label}: image edges are not clipped`);
};

const capture = async (name, fit = false) => {
  // Let ResizeObserver, React layout effects, and browser hit testing settle
  // after a viewport change before measuring controls and the image.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const value = await layout();
  try { if (fit) checkFit(value, name); else checkLayout(value, name); }
  catch (error) { fs.writeFileSync(path.join(outputDirectory, `${name}-layout.json`), JSON.stringify(value, null, 2)); throw error; }
  const screenshot = `${name}.png`;
  await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
  screenshots.push(screenshot);
  return value;
};

const openAsset = async (id, viaThumbnail = true) => {
  const card = page.locator(`#asset-card-${id}`);
  if (viaThumbnail) await card.locator('.asset-preview-trigger').click();
  else await card.getByRole('button', { name: '查看大图并保存', exact: true }).click();
  await page.locator('.asset-image-viewer').waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.asset-preview-pane img');
    return Boolean(image?.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0);
  });
  await waitForZoom(100);
};

const checkScrollEdges = async (label) => {
  const edges = await page.locator('.asset-preview-pane').evaluate(async (pane) => {
    const image = pane.querySelector('img');
    const snapshot = () => {
      const p = pane.getBoundingClientRect(); const i = image.getBoundingClientRect();
      return { image: { left: i.left, top: i.top, right: i.right, bottom: i.bottom }, viewport: { left: p.left + pane.clientLeft, top: p.top + pane.clientTop, right: p.left + pane.clientLeft + pane.clientWidth, bottom: p.top + pane.clientTop + pane.clientHeight }, scrollLeft: pane.scrollLeft, scrollTop: pane.scrollTop };
    };
    pane.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const start = snapshot();
    pane.scrollTo(pane.scrollWidth, pane.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { start, end: snapshot(), maxX: pane.scrollWidth - pane.clientWidth, maxY: pane.scrollHeight - pane.clientHeight };
  });
  assert.ok(edges.maxX > 0 && edges.maxY > 0, `${label}: enlarged image creates both scroll ranges`);
  assert.ok(edges.start.image.left >= edges.start.viewport.left - 2 && edges.start.image.top >= edges.start.viewport.top - 2, `${label}: top and left edges can be reached`);
  assert.ok(edges.end.image.right <= edges.end.viewport.right + 2 && edges.end.image.bottom <= edges.end.viewport.bottom + 2, `${label}: bottom and right edges can be reached`);
  assert.ok(edges.end.scrollLeft >= edges.maxX - 1 && edges.end.scrollTop >= edges.maxY - 1, `${label}: scroll reaches the end of each axis`);
  return edges;
};

const seed = async (font) => page.evaluate(({ key, fontScale }) => {
  const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
  const image = (id, name, width, height, color) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, width, height);
    paint.strokeStyle = '#ef5675'; paint.lineWidth = 32; paint.strokeRect(16, 16, width - 32, height - 32);
    paint.fillStyle = '#fff'; paint.font = '64px sans-serif'; paint.fillText('SYNTHETIC QA', 80, 130);
    return { id, name, type: 'character', role: 'character', referenceRole: 'character', mediaType: 'image', mimeType: 'image/png', fileName: `${id}.png`, dataUrl: canvas.toDataURL('image/png'), width, height, source: 'upload', tags: ['隔离合成图片'], createdAt: now, updatedAt: now };
  };
  const assets = [image('zoom-portrait', '缩放测试竖图', 1024, 1536, '#648993'), image('zoom-landscape', '缩放测试横图', 1536, 1024, '#957b9a')];
  const project = { ...state.project, id: 'image-zoom-isolated-project', name: '隔离图片缩放测试', assets, characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], sourceDocuments: [], generationTasks: [], updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.settings.uiFontScalePercent = fontScale;
  for (const kind of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[kind].enabled = false; state.settings[kind].apiKey = ''; }
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
  localStorage.setItem(key, JSON.stringify(state));
}, { key: storageKey, fontScale: font });

const run = async () => {
  await waitForCondition({ label: 'image zoom Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  for (const scenario of scenarios) {
    context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height } });
    page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('download', () => errors.push('Unexpected real browser download'));
    await page.addInitScript(() => {
      window.__imageZoomQa = { saves: [], requests: [] };
      window.lianhuaDesktop = {
        onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
        saveMedia: async (payload) => { window.__imageZoomQa.saves.push(payload); return 'QA-MOCK-NO-FILE-SAVED.png'; },
        videoRequest: async (payload) => { window.__imageZoomQa.requests.push(payload); throw new Error('No real generation in image zoom QA'); },
      };
    });
    await page.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) {
        errors.push(`Unexpected network request: ${request.method()} ${url.href}`); await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await seed(scenario.font); await page.reload({ waitUntil: 'networkidle' });
    const originalAssets = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.assets, storageKey);
    await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
    await openAsset('zoom-portrait');
    const label = `${scenario.width}x${scenario.height}-font${scenario.font}`;
    const fit = await capture(`${label}-portrait-fit`, true);
    assert.equal(fit.fontScale, scenario.font / 100, `${label}: requested font scale is applied`);
    assert.equal(await zoomOutput().textContent(), '100%');
    await zoomButton('放大图片').focus(); await page.keyboard.press('Enter'); await waitForZoom(125);
    const larger = await layout();
    assert.ok(larger.image.width > fit.image.width * 1.20 && larger.image.height > fit.image.height * 1.20, `${label}: keyboard zoom-in enlarges actual bitmap dimensions`);
    await zoomButton('缩小图片').click(); await waitForZoom(100);
    await zoomButton('缩小图片').click(); await waitForZoom(75);
    const smaller = await layout();
    assert.ok(smaller.image.width < fit.image.width * .80 && smaller.image.height < fit.image.height * .80, `${label}: zoom-out shrinks actual bitmap dimensions`);
    await zoomButton('缩小图片').click(); await zoomButton('缩小图片').click(); await waitForZoom(25);
    assert.equal(await zoomButton('缩小图片').isDisabled(), true, `${label}: lower limit disables zoom-out`);
    await zoomButton('还原图片缩放').click(); await waitForZoom(100);
    checkFit(await layout(), `${label}-reset`);
    for (let percentage = 125; percentage <= 400; percentage += 25) { await zoomButton('放大图片').click(); await waitForZoom(percentage); }
    assert.equal(await zoomButton('放大图片').isDisabled(), true, `${label}: upper limit disables zoom-in`);
    const zoomed = await capture(`${label}-portrait-400`);
    const centerX = (zoomed.pane.left + zoomed.pane.clientWidth / 2 - zoomed.image.left) / zoomed.image.width;
    const centerY = (zoomed.pane.top + zoomed.pane.clientHeight / 2 - zoomed.image.top) / zoomed.image.height;
    assert.ok(Math.abs(centerX - .5) < .02 && Math.abs(centerY - .5) < .02, `${label}: zoom preserves the initial image center`);
    const edges = await checkScrollEdges(label);
    // Saving after zooming must still export exactly the original image source.
    await zoomButton('保存图片').click();
    await page.waitForFunction(() => window.__imageZoomQa.saves.length === 1);
    const save = await page.evaluate(() => window.__imageZoomQa.saves[0]);
    assert.equal(save.sourceUrl, originalAssets[0].dataUrl, `${label}: save source is not scaled or resampled`);
    assert.equal(save.fileName, originalAssets[0].fileName);
    const resizedViewport = scenario.width === 1280 ? { width: 1120, height: 720 } : { width: 1280, height: 800 };
    await page.setViewportSize(resizedViewport);
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, resizedViewport);
    await waitForZoom(400);
    const resized = await capture(`${label}-resized-400`);
    await checkScrollEdges(`${label}-resized`);
    await zoomButton('还原图片缩放').click(); await waitForZoom(100);
    await capture(`${label}-resized-fit`, true);
    await zoomButton('放大图片').click(); await waitForZoom(125);
    await page.keyboard.press('Escape'); await page.locator('.asset-preview-modal').waitFor({ state: 'detached' });
    await openAsset('zoom-portrait', false); checkFit(await layout(), `${label}-reopened`);
    await zoomButton('放大图片').click(); await waitForZoom(125);
    await zoomButton('关闭').click(); await page.locator('.asset-preview-modal').waitFor({ state: 'detached' });
    await openAsset('zoom-landscape');
    const landscape = await capture(`${label}-landscape-fit`, true);
    assert.ok(landscape.image.width > landscape.image.height, `${label}: switching assets loads landscape proportions`);
    await zoomButton('关闭').click();
    const afterAssets = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.assets, storageKey);
    assert.deepEqual(afterAssets, originalAssets, `${label}: viewing, zooming, and mock save do not mutate assets`);
    assert.deepEqual(await page.evaluate(() => window.__imageZoomQa.requests), []);
    assert.deepEqual(errors, []);
    results.push({ ...scenario, fit, zoomed, resized, landscape, scrollEdges: edges, keyboardZoom: true, boundsDisabled: true, resetAndReopen: true, originalSaveSource: true, originalAssetsUnchanged: true });
    console.log(JSON.stringify({ scenario: label, fit: [fit.image.width, fit.image.height], zoom400: [zoomed.image.width, zoomed.image.height], passed: true }));
    await context.close(); context = undefined;
  }
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, noRealSaves: true, outputDirectory, results, screenshots, errors }, null, 2));
  console.log(`Asset image zoom UI QA passed. Report: ${path.join(outputDirectory, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, results, screenshots, errors }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
