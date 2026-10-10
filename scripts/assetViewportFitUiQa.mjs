import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App, neutral local images, isolated browser storage. QA_CASE can repeat
// one failed scope without re-running scopes already recorded as passing.
const root = path.resolve(import.meta.dirname, '..');
const runId = Date.now();
const outputRoot = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputRoot, `asset-viewport-fit-${runId}`));
const relative = path.relative(outputRoot, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Asset fit QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Asset fit QA output must not traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const selectedCases = new Set((process.env.QA_CASE || 'matrix,capacity,pagination,filters,large-night').split(','));
const matrixLabels = process.env.QA_MATRIX_LABEL ? new Set(process.env.QA_MATRIX_LABEL.split(',')) : null;
const nightViewport = process.env.QA_NIGHT_VIEWPORT;
const projectId = 'qa-asset-viewport-fit-project';
const viewports = [
  { width: 1480, height: 900 }, { width: 1280, height: 720 },
  { width: 1024, height: 768 }, { width: 900, height: 650 },
];
const checks = []; const errors = []; const blockedRequests = []; const screenshots = []; const layout = [];
let browser; let context; let page; let currentScope = 'startup';
const cacheDir = path.join(root, `.qa-asset-viewport-fit-${runId}`, 'vite');
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite';const server=await createServer({cacheDir:${JSON.stringify(cacheDir)},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});await server.listen();console.log('Asset viewport fit isolated QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'asset viewport fit', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
const mark = (text) => { checks.push({ scope: currentScope, text }); console.log(text); };
const capture = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', fullPage: false }); screenshots.push(file);
};
const cards = () => page.locator('.asset-page-grid > .asset-card');
const next = () => page.locator('.assets-toolbar .compact-pager').getByRole('button', { name: '下一页', exact: true });
const previous = () => page.locator('.assets-toolbar .compact-pager').getByRole('button', { name: '上一页', exact: true });
const search = () => page.getByPlaceholder('搜索资产名称、标签或提示词', { exact: true });
const chapters = () => page.getByRole('combobox', { name: '资产章节筛选', exact: true });
const visibleIds = () => cards().evaluateAll((elements) => elements.map((element) => element.id.replace(/^asset-card-/u, '')));
const pager = () => page.locator('.assets-toolbar .compact-pager').evaluateAll((elements) => {
  if (!elements.length) return { page: 1, total: 1 };
  const match = elements[0].innerText.match(/(\d+)\s*\/\s*(\d+)/u);
  if (!match) throw new Error('No valid asset page status');
  return { page: Number(match[1]), total: Number(match[2]) };
});

async function stabilize() {
  await page.locator('.assets-view').waitFor();
  await page.waitForFunction(async () => {
    const snapshot = () => {
      const view = document.querySelector('.assets-view');
      const grid = view?.querySelector('.asset-page-grid');
      const box = view?.getBoundingClientRect();
      const gridBox = grid?.getBoundingClientRect();
      return JSON.stringify({ view: box && [box.x, box.y, box.width, box.height],
        grid: gridBox && [gridBox.x, gridBox.y, gridBox.width, gridBox.height],
        count: grid?.children.length || 0, data: grid && { ...grid.dataset },
        cards: [...(grid?.children || [])].map((card) => { const b = card.getBoundingClientRect(); return [card.id, b.width, b.height, b.y]; }),
      });
    };
    let last = snapshot();
    for (let index = 0; index < 5; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = snapshot(); if (current !== last) return false; last = current;
    }
    return [...document.querySelectorAll('.asset-page-grid img')].every((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15000 });
}

async function updateFixture(patch) {
  await page.locator('.assets-view').evaluate((element, { patch, projectId }) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let component = key && element[key];
    while (component && !(component.memoizedProps?.state && typeof component.memoizedProps?.setBackgroundState === 'function')) component = component.return;
    if (!component) throw new Error('Cannot locate real asset library App context');
    component.memoizedProps.setBackgroundState((current) => {
      if (current.project.id !== projectId) throw new Error('Only synthetic fixture may be changed');
      const project = { ...current.project, ...(patch.count !== undefined ? { assets: window.__assetFitFixtureAssets.slice(0, patch.count) } : {}),
        ...(patch.video ? { assets: [window.__assetFitFixtureAssets[0], window.__assetFitFixtureVideo] } : {}),
      };
      return { ...current, project, projects: current.projects.map((item) => item.id === projectId ? project : item),
        settings: { ...current.settings, ...(patch.theme ? { theme: patch.theme } : {}),
          ...(patch.font ? { uiFontScalePercent: patch.font } : {}), ...(patch.color ? { themeColor: patch.color } : {}),
        },
      };
    });
  }, { patch, projectId });
  if (patch.theme) await page.waitForFunction((mode) => document.documentElement.dataset.colorMode === mode, patch.theme);
  if (patch.font) await page.waitForFunction((font) => document.querySelector('[data-ui-font-scale]')?.getAttribute('data-ui-font-scale') === String(font), patch.font);
  await stabilize();
}

async function assertFit(label, { imageCount, openDetails = false, media = 'image' } = {}) {
  await stabilize();
  const result = await page.locator('.assets-view').evaluate((view) => {
    const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const geometry = (element) => element && ({ box: rect(element), clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      overflowX: getComputedStyle(element).overflowX, overflowY: getComputedStyle(element).overflowY });
    const grid = view.querySelector('.asset-page-grid'); const gridBox = grid && rect(grid);
    const assetCards = [...view.querySelectorAll('.asset-page-grid > .asset-card')].map((card) => {
      const box = rect(card); const image = card.querySelector('.asset-preview-trigger img'); const style = image && getComputedStyle(image);
      const buttons = [...card.querySelectorAll('.asset-actions button')].map((button) => ({ text: button.textContent, box: rect(button) }));
      const details = card.querySelector('.asset-metadata-details');
      return { id: card.id, box, thumb: geometry(card.querySelector('.asset-thumb')),
        image: image && { box: rect(image), objectFit: style.objectFit, filter: style.filter, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
        buttons, details: details && { open: details.open, box: rect(details), content: geometry(details.querySelector('.asset-metadata-content')) },
        fitsGrid: gridBox && box.x >= gridBox.x - 1 && box.right <= gridBox.right + 1 && box.y >= gridBox.y - 1 && box.bottom <= gridBox.bottom + 1,
      };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, mode: document.documentElement.dataset.colorMode,
      font: document.querySelector('[data-ui-font-scale]')?.getAttribute('data-ui-font-scale'),
      root: geometry(document.documentElement), body: geometry(document.body), workspace: geometry(view.closest('.workspace')), view: geometry(view),
      grid: geometry(grid), gridData: grid && { ...grid.dataset }, cards: assetCards,
      toolbar: geometry(view.querySelector('.assets-toolbar')), pager: geometry(view.querySelector('.compact-pager')),
      theme: { card: assetCards.length ? getComputedStyle(view.querySelector('.asset-card')).backgroundColor : undefined,
        surface: getComputedStyle(view).backgroundColor },
    };
  });
  layout.push({ scope: currentScope, label, ...result });
  for (const [name, value] of Object.entries({ root: result.root, body: result.body, workspace: result.workspace, view: result.view, grid: result.grid })) {
    if (!value) continue;
    assert.ok(value.scrollWidth <= value.clientWidth + 2, `${label}: ${name} horizontal overflow ${value.scrollWidth}/${value.clientWidth}`);
    assert.ok(value.scrollHeight <= value.clientHeight + 2, `${label}: ${name} vertical overflow ${value.scrollHeight}/${value.clientHeight}`);
    assert.ok(value.box.x >= -1 && value.box.right <= result.viewport.width + 1, `${label}: ${name} width outside viewport`);
    assert.ok(value.box.y >= -1 && value.box.bottom <= result.viewport.height + 1, `${label}: ${name} height outside viewport`);
  }
  for (const card of result.cards) {
    assert.equal(card.fitsGrid, true, `${label}: ${card.id} is clipped by asset grid`);
    assert.ok(card.thumb?.box.height > 0, `${label}: positive image frame height`);
    if (media === 'image') {
      assert.equal(card.image?.objectFit, 'contain', `${label}: whole image must fit frame`);
      assert.equal(card.image?.filter, 'none', `${label}: real image colors unchanged`);
    }
    for (const button of card.buttons) {
      assert.ok(button.box.x >= card.box.x - 1 && button.box.right <= card.box.right + 1 && button.box.y >= card.box.y - 1 && button.box.bottom <= card.box.bottom + 1,
        `${label}: ${card.id} action ${button.text} is clipped`);
    }
  }
  const status = await pager(); assert.ok(status.page >= 1 && status.page <= status.total, `${label}: legal page number`);
  if (imageCount !== undefined) {
    if (!imageCount) assert.equal(result.cards.length, 0, `${label}: empty view`);
    else assert.ok(result.cards.length > 0 && result.cards.length <= imageCount, `${label}: valid visible slice`);
  }
  if (openDetails) assert.ok(result.cards.some((card) => card.details?.open), `${label}: expanded metadata remains present`);
  return { ...result, pageStatus: status };
}

async function resetFilters() {
  await search().fill(''); await chapters().selectOption('all');
  while (await previous().count() && await previous().isEnabled()) { await previous().click(); await stabilize(); }
}

async function newFixture() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: viewports[0], serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.hostname === '127.0.0.1' && url.port === String(port) && url.pathname === '/') { socket.connectToServer(); return; }
    blockedRequests.push(`WEBSOCKET ${socket.url()}`); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== base || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__asset_fit_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Neutral asset fixture</title><body>Synthetic asset viewport fixture only</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${base}/__asset_fit_fixture.html`);
  await page.evaluate(async (projectId) => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState(); const now = 1791564900000;
    const colors = ['#8ea8b5', '#b79bb0', '#a2b5a0', '#bead8b', '#9998b7'];
    const sizes = [[256, 144], [144, 256], [192, 192], [384, 96], [96, 384]];
    const assets = Array.from({ length: 41 }, (_, index) => {
      const [width, height] = sizes[index % sizes.length]; const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const paint = canvas.getContext('2d'); paint.fillStyle = colors[index % colors.length]; paint.fillRect(0, 0, width, height);
      paint.fillStyle = '#ece7d8'; paint.fillRect(width * .2, height * .18, width * .6, height * .64);
      paint.fillStyle = '#45505b'; paint.font = '14px sans-serif'; paint.fillText(String(index + 1), width * .45, height * .52);
      return { id: `qa-fit-${String(index + 1).padStart(2, '0')}`, name: index === 3 ? '中性合成图 04 · 这是一张用于验证较长名称显示的图片' : `中性合成图 ${String(index + 1).padStart(2, '0')}`,
        type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'),
        chapterId: index % 3 === 0 ? 'qa-fit-chapter-1' : index % 3 === 1 ? 'qa-fit-chapter-2' : undefined,
        width, height, sizeBytes: 1234567 + index, checksum: 'b'.repeat(64), source: 'upload',
        tags: ['纯合成中性图片', index % 2 ? '奇数检索标签' : '偶数检索标签', '资产库视口验证'],
        visualAnchor: '中性几何方块。此处为较长的资产说明，用于确认详细信息展开以后只在限定区域显示，不会扩大整个资产库页面。',
        createdAt: now + index, updatedAt: now + index,
      };
    });
    const sourceDocuments = [1, 2].map((n) => ({ id: `qa-fit-chapter-${n}`, name: `合成第 ${n} 章`, content: '本地合成资产容量检查，无生成请求。', createdAt: now, updatedAt: now }));
    const project = { ...state.project, id: projectId, name: '资产视口隔离检查', description: '纯合成中性资产', assets,
      sourceDocuments, activeChapterId: sourceDocuments[0].id, chapterWorkspaces: {}, scenes: [], storyboards: [], sequencePlans: [], characters: [], locations: [], props: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const kind of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[kind] = { ...state.settings[kind], enabled: false, apiKey: '' };
    for (const kind of ['Text', 'Vision', 'Image', 'Video']) { state.settings[`${kind.toLowerCase()}ApiProfiles`] = []; state.settings[`active${kind}ApiProfileId`] = null; }
    state.settings.apiCredentialBook = []; state.settings.uiFontScalePercent = 100; state.settings.theme = 'light'; state.settings.themeColor = 'classic';
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, projectId);
  await page.goto(base, { waitUntil: 'networkidle', timeout: 50000 });
  assert.equal(await page.evaluate(() => typeof window.lianhuaDesktop), 'undefined');
  await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
  await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
  await page.locator('.assets-view').evaluate((element) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$')); let component = key && element[key];
    while (component && !(component.memoizedProps?.state && typeof component.memoizedProps?.setBackgroundState === 'function')) component = component.return;
    if (!component) throw new Error('Cannot locate synthetic asset fixture');
    window.__assetFitFixtureAssets = component.memoizedProps.state.project.assets;
  });
  await stabilize();
}

async function run() {
  await waitForCondition({ label: 'asset fit App Vite', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  await newFixture();
  if (selectedCases.has('runtime')) {
    currentScope = 'runtime';
    await page.waitForFunction(() => Number(document.querySelector('.asset-page-grid')?.dataset.pageSize) > 0);
    mark('Repaired fixture permits only its own local Vite socket; real App starts with stable positive capacity');
  }
  if (selectedCases.has('matrix')) {
    currentScope = 'matrix';
    for (const count of [41, 7, 1, 0]) {
      await resetFilters(); await updateFixture({ count });
      for (const viewport of viewports) {
        const label = `${count}-images-${viewport.width}x${viewport.height}`;
        if (matrixLabels && !matrixLabels.has(label)) continue;
        await page.setViewportSize(viewport);
        const result = await assertFit(label, { imageCount: count });
        if (count === 41) {
          assert.equal(await page.locator('.asset-metadata-details[open]').count(), 0, `${label}: metadata initially collapsed`);
          await capture(`light-${label}`);
          await cards().first().locator('.asset-metadata-details > summary').click();
          await assertFit(`${label}-expanded`, { imageCount: count, openDetails: true });
          if (viewport.width === 900) await capture(`light-${label}-expanded`);
          await cards().first().locator('.asset-metadata-details > summary').click();
        }
        if (count === 1) assert.equal(result.cards.length, 1);
        mark(`${label}: image frames and all card actions fit; no document/workspace/view/grid scrolling`);
      }
    }
  }
  if (selectedCases.has('capacity')) {
    currentScope = 'capacity'; await updateFixture({ count: 37 }); await resetFilters();
    await page.setViewportSize({ width: 1280, height: 600 }); const short = await assertFit('37-images-height600', { imageCount: 37 });
    await page.setViewportSize({ width: 1280, height: 1000 }); const tall = await assertFit('37-images-height1000', { imageCount: 37 });
    assert.ok(tall.cards.length > short.cards.length, `More available height must increase capacity: ${short.cards.length} -> ${tall.cards.length}`);
    await page.setViewportSize({ width: 1280, height: 600 }); const resizedBack = await assertFit('37-images-resize-back-height600', { imageCount: 37 });
    assert.equal(resizedBack.cards.length, short.cards.length, 'Height shrink recalculates capacity');
    mark(`37 images: height-only resize changes capacity ${short.cards.length} → ${tall.cards.length} → ${resizedBack.cards.length}`);
  }
  if (selectedCases.has('pagination')) {
    currentScope = 'pagination'; await updateFixture({ count: 41 }); await resetFilters(); await page.setViewportSize(viewports[1]); await stabilize();
    const seen = []; const pageNumbers = []; const firstIds = await visibleIds();
    await cards().first().getByRole('checkbox').check(); const firstSelected = firstIds[0]; let secondSelected;
    for (let index = 0; index < 50; index++) {
      const status = await pager(); pageNumbers.push(status.page); const ids = await visibleIds();
      assert.ok(ids.length > 0); seen.push(...ids); await assertFit(`pagination-page-${status.page}`, { imageCount: 41 });
      if (status.page === 2) { await cards().first().getByRole('checkbox').check(); secondSelected = ids[0]; }
      if (!await next().count() || !await next().isEnabled()) break;
      await next().click(); await stabilize();
    }
    assert.equal(seen.length, 41, 'All assets reachable exactly once across pages'); assert.equal(new Set(seen).size, 41);
    assert.deepEqual([...new Set(seen)].sort(), Array.from({ length: 41 }, (_, index) => `qa-fit-${String(index + 1).padStart(2, '0')}`).sort());
    assert.ok(secondSelected, 'A second page exists');
    const last = await pager(); assert.equal(last.page, last.total); assert.equal(await next().isEnabled(), false);
    while (await previous().isEnabled()) { await previous().click(); await stabilize(); }
    assert.equal(await page.locator(`#asset-card-${firstSelected}`).getByRole('checkbox').isChecked(), true);
    await next().click(); await stabilize();
    assert.equal(await page.locator(`#asset-card-${secondSelected}`).getByRole('checkbox').isChecked(), true);
    await page.getByRole('button', { name: '用选中 2 张普通图片生成视频', exact: true }).waitFor();
    mark(`41 images reachable without duplicates on ${last.total} pages; two cross-page selections remain checked when revisiting`);
    await capture('pagination-cross-page-selection-1280x720');
  }
  if (selectedCases.has('filters')) {
    currentScope = 'filters'; await updateFixture({ count: 41 }); await resetFilters(); await page.setViewportSize(viewports[1]); await stabilize();
    while (await next().count() && await next().isEnabled()) { await next().click(); await stabilize(); }
    await search().fill('中性合成图 41'); await assertFit('search-single-from-final-page', { imageCount: 1 });
    assert.deepEqual(await visibleIds(), ['qa-fit-41']); assert.deepEqual(await pager(), { page: 1, total: 1 });
    await search().fill('没有这个资产'); await assertFit('search-empty-from-final-page', { imageCount: 0 }); assert.deepEqual(await pager(), { page: 1, total: 1 });
    await search().fill(''); await chapters().selectOption('qa-fit-chapter-2'); await assertFit('chapter-filter-from-final-page', { imageCount: 14 });
    assert.equal((await pager()).page, 1);
    const seen = [];
    for (let index = 0; index < 50; index++) {
      seen.push(...await visibleIds()); if (!await next().count() || !await next().isEnabled()) break; await next().click(); await stabilize();
    }
    assert.equal(new Set(seen).size, 14, 'Chapter filter reaches all and only chapter 2 assets');
    assert.ok(seen.every((id) => (Number(id.slice(-2)) - 1) % 3 === 1));
    await chapters().selectOption('shared'); await assertFit('shared-filter-resets-page', { imageCount: 13 }); assert.equal((await pager()).page, 1);
    mark('Search to single/zero results and chapter/shared filters reset stale pages to a legal first page and retain correct asset scope');
  }
  if (selectedCases.has('large-night')) {
    currentScope = 'large-night'; await updateFixture({ count: 41, font: 125, theme: 'dark', color: 'classic' }); await resetFilters();
    for (const viewport of [viewports[1], viewports[3]]) {
      if (nightViewport && nightViewport !== `${viewport.width}x${viewport.height}`) continue;
      await page.setViewportSize(viewport); const label = `night-font125-${viewport.width}x${viewport.height}`;
      const result = await assertFit(label, { imageCount: 41 });
      assert.equal(result.mode, 'dark'); assert.notEqual(result.theme.card, 'rgb(255, 255, 255)');
      await capture(label); await cards().first().locator('.asset-metadata-details > summary').click();
      await assertFit(`${label}-expanded`, { imageCount: 41, openDetails: true }); await capture(`${label}-expanded`);
      await cards().first().locator('.asset-metadata-details > summary').click();
      mark(`${label}: adaptive frames/actions and expanded information fit without outer scrolling; neutral source image colors preserved`);
    }
  }
  if (selectedCases.has('video')) {
    currentScope = 'video';
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 108;
      const paint = canvas.getContext('2d'); paint.fillStyle = '#8ea8b5'; paint.fillRect(0, 0, 144, 108);
      const dataUrl = await new Promise((resolve, reject) => {
        const stream = canvas.captureStream(10); const chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = reject; recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
          reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
        };
        recorder.start(); setTimeout(() => recorder.stop(), 230);
      });
      window.__assetFitFixtureVideo = { id: 'qa-fit-video', name: '合成中性视频 · 视口检查', type: 'video', role: 'motion', referenceRole: 'motion',
        mediaType: 'video', mimeType: 'video/webm', dataUrl, width: 144, height: 108, durationSec: .23, source: 'upload',
        firstFrameAssetId: window.__assetFitFixtureAssets[0].id, tags: ['纯合成中性视频'], createdAt: 1791564900000, updatedAt: 1791564900000,
      };
    });
    await updateFixture({ video: true });
    await page.locator('.asset-library-tabs').getByRole('button', { name: '视频资产库', exact: true }).click();
    await page.getByRole('heading', { name: '视频资产库', exact: true }).waitFor();
    await page.setViewportSize(viewports[3]);
    const result = await assertFit('single-synthetic-video-900x650', { media: 'video' });
    assert.equal(result.cards.length, 1); await cards().first().getByRole('button', { name: '播放视频：合成中性视频 · 视口检查', exact: true }).waitFor();
    await cards().first().locator('.asset-metadata-details > summary').click();
    await assertFit('single-synthetic-video-900x650-expanded', { media: 'video', openDetails: true });
    await capture('single-synthetic-video-900x650-expanded');
    assert.equal(await page.locator('.asset-card video').count(), 0, 'List does not load any video player');
    mark('One local synthetic video card and expanded metadata fit 900x650 without outer/grid scrolling; no playback/upload/generation action');
  }
  assert.deepEqual(errors, [], 'No page or console errors'); assert.deepEqual(blockedRequests, [], 'No external/provider requests or actions');
  currentScope = 'complete'; mark('Real App isolated synthetic assets only; zero API/generation actions and no production data read');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, cases: [...selectedCases], checks, layout, errors, blockedRequests, screenshots,
    noProductionDataRead: true, generationActions: 0, paidRequests: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, output, screenshots, checkCount: checks.length }));
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
    await page.locator('.assets-view').innerText({ timeout: 2000 }).then((text) => fs.writeFileSync(path.join(output, 'failure.txt'), text)).catch(() => {});
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, failedScope: currentScope, error: String(error), cases: [...selectedCases], checks, layout, errors, blockedRequests, screenshots,
    noProductionDataRead: true, generationActions: 0, paidRequests: 0 }, null, 2));
  console.error(JSON.stringify({ output, failedScope: currentScope, error: String(error), errors })); throw error;
}
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
