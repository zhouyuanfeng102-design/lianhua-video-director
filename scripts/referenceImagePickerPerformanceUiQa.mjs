import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// A targeted, headless fixture of the production picker and its real CSS.
// The manifest contains offline thumbnails generated from actual images by the
// desktop backend. This test neither starts the full App nor opens its profile.
// Usage: LH_REFERENCE_THUMBNAIL_MANIFEST=<temporary manifest> node <this file>
const root = path.resolve(import.meta.dirname, '..');
const manifestPath = process.env.LH_REFERENCE_THUMBNAIL_MANIFEST || process.argv[2];
assert.ok(manifestPath, 'Provide LH_REFERENCE_THUMBNAIL_MANIFEST with assets and native thumbnails');
const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
const deliveryDelayMs = Number(process.env.LH_REFERENCE_THUMBNAIL_DELIVERY_DELAY_MS || 30);
assert.ok(Number.isFinite(deliveryDelayMs) && deliveryDelayMs >= 0 && deliveryDelayMs <= 1000, 'Use a bounded IPC-delivery delay');
assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 18, 'Use the actual multi-row image fixture');
assert.ok(Array.isArray(manifest.thumbnails), 'Manifest thumbnails must be an array');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'lianhua-reference-picker-performance-'));
const mask = (text) => Array.from(text || '').map((char) => /\s/u.test(char) ? char : /[\x00-\x7f]/u.test(char) ? 'A' : '字').join('');
const assets = manifest.assets.map((asset, index) => ({
  id: `fixture-asset-${index + 1}`,
  name: `图${String(index + 1).padStart(2, '0')}${mask(asset.name).slice(3)}`,
  type: asset.type || 'reference', role: asset.role || 'composition',
  referenceRole: asset.referenceRole, tags: [],
  fileName: `anonymous-${index + 1}.png`, mediaType: 'image', mimeType: 'image/png',
  managed: true, missing: false,
  relativePath: asset.relativePath, checksum: asset.checksum,
  width: asset.width, height: asset.height, sizeBytes: asset.sizeBytes,
  updatedAt: asset.updatedAt || 0,
  url: `http://127.0.0.1:1/original-forbidden/${index + 1}.png`,
}));
assert.ok(assets.every((asset) => asset.relativePath && asset.checksum), 'Managed fixtures retain the source path/checksum');
const thumbnails = new Map();
for (const thumbnail of manifest.thumbnails) {
  const bytes = thumbnail.filePath ? await fs.readFile(path.resolve(path.dirname(path.resolve(manifestPath)), thumbnail.filePath)) : undefined;
  const dataUrl = thumbnail.dataUrl || (bytes ? `data:image/png;base64,${bytes.toString('base64')}` : '');
  assert.match(dataUrl, /^data:image\/png;base64,/u, 'Use actual backend PNG thumbnail bytes');
  const png = bytes || Buffer.from(dataUrl.split(',')[1], 'base64');
  const sizeBytes = png.length;
  assert.ok(sizeBytes >= 24, 'Thumbnail PNG contains its actual dimensions');
  thumbnails.set(thumbnail.relativePath, { dataUrl, mimeType: 'image/png', width: thumbnail.width || png.readUInt32BE(16), height: thumbnail.height || png.readUInt32BE(20), sizeBytes });
}
assert.ok(assets.every((asset) => thumbnails.has(asset.relativePath)), 'Every source asset has an actual offline thumbnail');
const entry = `
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReferenceImagePickerModal } from './src/components/ReferenceImagePickerModal';
const sourceAssets = ${JSON.stringify(assets)};
const sourceFingerprint = JSON.stringify(sourceAssets);
const qa = window.__referencePickerQa = { requests: [], pending: [], confirmations: [], loads: [], longTasks: [], frames: [], start: 0, dom: 0, paint: 0, hold: false, fail: false };
let priorFrame = performance.now();
function frame(at) { if (qa.start) qa.frames.push({ at, gap: at - priorFrame }); priorFrame = at; requestAnimationFrame(frame); }
requestAnimationFrame(frame);
new PerformanceObserver((entries) => { for (const item of entries.getEntries()) qa.longTasks.push({ at: item.startTime, duration: item.duration }); }).observe({ type: 'longtask', buffered: true });
const geometry = () => {
  const list = document.querySelector('.reference-image-picker-list');
  if (!list) return [];
  const bounds = list.getBoundingClientRect();
  return [...list.querySelectorAll('.reference-image-picker-item')].map((item) => {
    const thumb = item.querySelector('.reference-image-picker-thumb');
    const rect = thumb.getBoundingClientRect();
    const name = item.querySelector('.reference-image-name-text').textContent;
    const asset = qa.activeAssets.find((value) => value.name === name);
    return { id: asset.id, relativePath: asset.relativePath, visible: rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right };
  });
};
window.lianhuaDesktop = { getImageThumbnail: async (request) => {
  const id = qa.requests.length;
  const item = { id, key: request.expectedChecksum, relativePath: request.relativePath, at: performance.now(), visible: geometry().some((entry) => entry.relativePath === request.relativePath && entry.visible) };
  qa.requests.push(item);
  if (qa.hold) await new Promise((resolve) => qa.pending.push({ id, resolve }));
  if (qa.fail) { item.failed = true; throw new Error('Controlled thumbnail failure'); }
  await new Promise((resolve) => setTimeout(resolve, ${deliveryDelayMs}));
  const result = await fetch('/thumbnail?path=' + encodeURIComponent(request.relativePath)).then((response) => { if (!response.ok) throw new Error('Fixture thumbnail unavailable'); return response.json(); });
  item.settled = true;
  return result;
} };
qa.release = (id) => { const index = qa.pending.findIndex((item) => item.id === id); if (index >= 0) qa.pending.splice(index, 1)[0].resolve(); };
qa.geometry = geometry;
qa.integrity = () => JSON.stringify(sourceAssets) === sourceFingerprint;
document.addEventListener('load', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest('.reference-image-picker-thumb')) return;
  const name = image.closest('.reference-image-picker-item').querySelector('.reference-image-name-text').textContent;
  const asset = qa.activeAssets.find((value) => value.name === name);
  if (!asset) return;
  const item = { id: asset.id, at: performance.now(), width: image.naturalWidth, height: image.naturalHeight, dataUrl: image.src.startsWith('data:image/png;base64,') };
  qa.loads.push(item);
  requestAnimationFrame(() => requestAnimationFrame(() => item.twoRafAt = performance.now()));
}, true);
function Fixture() {
  const [open, setOpen] = useState(false);
  const [currentAssets, setAssets] = useState(sourceAssets);
  const [selected, setSelected] = useState('');
  qa.activeAssets = currentAssets;
  qa.configureProbe = (letter) => setAssets([{ ...sourceAssets[0], id: 'probe-' + letter, name: 'Probe ' + letter, checksum: letter.repeat(64) }]);
  qa.useOriginalAssets = () => setAssets(sourceAssets);
  qa.close = () => setOpen(false);
  qa.open = () => setOpen(true);
  useLayoutEffect(() => {
    if (!open) return;
    if (qa.start && !qa.dom) { qa.dom = performance.now(); qa.initialGeometry = geometry(); requestAnimationFrame(() => requestAnimationFrame(() => qa.paint = performance.now())); }
  }, [open]);
  return <><button id="open-picker" onClick={() => { if (!qa.start) qa.start = performance.now(); setOpen(true); }}>Open picker</button>
    <ReferenceImagePickerModal open={open} assets={currentAssets} selectedAssetId={selected}
      onClose={() => setOpen(false)} onConfirm={(asset) => { qa.confirmations.push({ id: asset.id, originalObject: currentAssets.find((value) => value.id === asset.id) === asset, originalUrl: asset.url.includes('/original-forbidden/'), sizeBytes: asset.sizeBytes, hasDataUrl: !!asset.dataUrl }); setSelected(asset.id); setOpen(false); }} />
  </>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const compiled = await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'reference-picker-performance-fixture.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await fs.readFile(path.join(root, 'src/styles.css'), 'utf8')) + '\n' + (await fs.readFile(path.join(root, 'src/appThemes.css'), 'utf8'));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(compiled.outputFiles[0].contents); return; }
  if (url.pathname === '/styles.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(css); return; }
  if (url.pathname === '/thumbnail') {
    const thumbnail = thumbnails.get(url.searchParams.get('path'));
    response.writeHead(thumbnail ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(thumbnail || {})); return;
  }
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return; }
  response.writeHead(404); response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const blockedRequests = [], errors = [], stages = [];
let browser, page, measurement;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') && ['/', '/bundle.js', '/styles.css', '/thumbnail'].includes(new URL(url).pathname)) await route.continue();
    else { blockedRequests.push(url); await route.abort(); }
  });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => window.__referencePickerQa.requests.length), 0, 'Closed picker does not request thumbnails');
  const cdp = await context.newCDPSession(page);
  const trace = [];
  cdp.on('Tracing.dataCollected', (data) => trace.push(...data.value));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', options: 'record-as-much-as-possible' });
  await page.locator('#open-picker').click();
  await page.waitForFunction(() => { const qa = window.__referencePickerQa; const visible = qa.initialGeometry?.filter((item) => item.visible); return visible?.length && visible.every((item) => qa.loads.some((load) => load.id === item.id && load.twoRafAt)); });
  measurement = await page.evaluate(() => {
    const qa = window.__referencePickerQa, visible = qa.initialGeometry.filter((item) => item.visible), ids = new Set(visible.map((item) => item.id));
    const loads = qa.loads.filter((item) => ids.has(item.id));
    const first = Math.min(...loads.map((item) => item.at)), last = Math.max(...loads.map((item) => item.at));
    return { domMountedMs: qa.dom - qa.start, twoRafMs: qa.paint - qa.start, firstImageLoadMs: first - qa.start, visibleAllLoadMs: last - qa.start, postLoadTwoRafVisibleMs: Math.max(...loads.map((item) => item.twoRafAt)) - qa.start, visibleIds: [...ids], requestedCount: qa.requests.length, requestedOnlyVisible: qa.requests.every((item) => item.visible), dimensions: loads.map(({ id, width, height, dataUrl }) => ({ id, width, height, dataUrl })), longTasks: qa.longTasks.filter((item) => item.at >= qa.start && item.at <= last + 100).map((item) => ({ at: item.at - qa.start, duration: item.duration })), maxFrameGapMs: Math.max(...qa.frames.filter((item) => item.at <= last + 100).map((item) => item.gap)) };
  });
  const traceFinished = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); await traceFinished;
  const decode = trace.filter((event) => event.name === 'Decode Image' && event.ph === 'X');
  measurement.decodeImage = { count: decode.length, totalThreadMs: decode.reduce((sum, event) => sum + (event.dur || 0) / 1000, 0), maxMs: Math.max(0, ...decode.map((event) => (event.dur || 0) / 1000)) };
  assert.ok(measurement.visibleIds.length < assets.length, 'Fixture includes offscreen assets');
  assert.equal(measurement.requestedCount, measurement.visibleIds.length, 'Only intersecting thumbnails are requested initially');
  assert.equal(measurement.requestedOnlyVisible, true, 'The list root clips every initial thumbnail request');
  assert.ok(measurement.dimensions.every((item) => item.dataUrl && item.width <= 320 && item.height <= 320), 'Rendered previews use the returned small PNGs');
  stages.push('initial-visible-only-real-thumbnails-and-measurement');

  await page.getByRole('button', { name: '关闭资产图片选择器', exact: true }).click();
  const firstRequestCount = await page.evaluate(() => window.__referencePickerQa.requests.length);
  await page.locator('#open-picker').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.reference-image-picker-thumb img')].length > 0 && [...document.querySelectorAll('.reference-image-picker-thumb img')].every((image) => image.complete && image.naturalWidth));
  assert.equal(await page.evaluate(() => window.__referencePickerQa.requests.length), firstRequestCount, 'Reopening reuses successful thumbnail cache');
  stages.push('reopen-cache-reuse');

  const targetIndex = assets.length - 1, target = assets[targetIndex];
  await page.getByRole('searchbox', { name: '搜索资产图片', exact: true }).fill(`图${String(targetIndex + 1).padStart(2, '0')}`);
  await page.waitForFunction(() => document.querySelectorAll('.reference-image-picker-item').length === 1);
  await page.waitForFunction(() => document.querySelector('.reference-image-picker-thumb img')?.naturalWidth > 0);
  await page.locator('.reference-image-picker-item').click();
  await page.getByRole('button', { name: '使用所选图片', exact: true }).click();
  const confirmation = await page.evaluate(() => window.__referencePickerQa.confirmations.at(-1));
  assert.deepEqual(confirmation, { id: target.id, originalObject: true, originalUrl: true, sizeBytes: target.sizeBytes, hasDataUrl: false }, 'Selection returns the intact original asset object and ID');
  assert.equal(await page.evaluate(() => window.__referencePickerQa.integrity()), true, 'Preview/search/selection do not rewrite the source asset');
  stages.push('search-and-confirm-original-asset');

  await page.locator('#open-picker').click();
  await page.locator('.reference-image-picker-list').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => { const qa = window.__referencePickerQa; return qa.geometry().filter((item) => item.visible).every((item) => qa.loads.some((load) => load.id === item.id)); });
  assert.equal(await page.evaluate(() => window.__referencePickerQa.requests.every((request) => request.visible)), true, 'Scrolling requests remaining images only when they enter the list viewport');
  stages.push('scroll-unseen-thumbnails-on-demand');

  await page.getByRole('button', { name: '关闭资产图片选择器', exact: true }).click();
  await page.evaluate(() => { const qa = window.__referencePickerQa; qa.configureProbe('a'); qa.hold = true; });
  await page.locator('#open-picker').click();
  await page.waitForFunction(() => window.__referencePickerQa.pending.length === 1);
  const staleRequest = await page.evaluate(() => window.__referencePickerQa.pending[0].id);
  await page.getByRole('button', { name: '关闭资产图片选择器', exact: true }).click();
  await page.evaluate(() => window.__referencePickerQa.configureProbe('b'));
  await page.locator('#open-picker').click();
  await page.waitForFunction(() => window.__referencePickerQa.pending.length === 2);
  const currentRequest = await page.evaluate(() => window.__referencePickerQa.pending.at(-1).id);
  await page.evaluate((id) => window.__referencePickerQa.release(id), staleRequest);
  await page.waitForFunction((id) => window.__referencePickerQa.requests[id].settled, staleRequest);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.reference-image-picker-thumb img').count(), 0, 'Closed/previous-source result cannot populate the reopened thumbnail');
  await page.evaluate((id) => window.__referencePickerQa.release(id), currentRequest);
  await page.waitForFunction(() => document.querySelector('.reference-image-picker-thumb img')?.naturalWidth > 0);
  stages.push('late-result-after-close-does-not-pollute-new-source');

  await page.getByRole('button', { name: '关闭资产图片选择器', exact: true }).click();
  await page.evaluate(() => { const qa = window.__referencePickerQa; qa.configureProbe('c'); qa.hold = false; qa.fail = true; });
  await page.locator('#open-picker').click();
  await page.waitForFunction(() => window.__referencePickerQa.requests.at(-1)?.failed);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.reference-image-picker-thumb img').count(), 0, 'Desktop thumbnail failure does not fall back to loading the original');
  assert.deepEqual(blockedRequests, [], 'The optimized picker never requests original files or external APIs');
  assert.deepEqual(errors, [], 'No unhandled errors');
  stages.push('failed-thumbnail-keeps-light-placeholder');

  const baselinePath = process.env.LH_REFERENCE_PICKER_BASELINE || path.join(os.tmpdir(), 'lianhua-picker-readonly-20261014-report.json');
  const baseline = await fs.readFile(baselinePath, 'utf8').then((text) => JSON.parse(text)).catch(() => undefined);
  const originalBaseline = baseline?.reports?.find((item) => item.mode === 'original');
  const report = { passed: true, stages, viewport: [1920, 1080], browser: browser.version(), assetCount: assets.length, originalBytes: assets.reduce((sum, asset) => sum + (asset.sizeBytes || 0), 0), allThumbnailBytes: [...thumbnails.values()].reduce((sum, thumbnail) => sum + thumbnail.sizeBytes, 0), firstVisibleThumbnailBytes: assets.filter((asset) => measurement.visibleIds.includes(asset.id)).reduce((sum, asset) => sum + thumbnails.get(asset.relativePath).sizeBytes, 0), deliveryDelayMs, measurement, baseline: originalBaseline ? { assetCount: baseline.imageCount, firstImageLoadMs: originalBaseline.firstImageLoadMs, visibleAllLoadMs: originalBaseline.visibleAllLoadMs, allImageLoadMs: originalBaseline.allImageLoadMs, requestedCount: originalBaseline.requestedCount, longTaskCount: originalBaseline.longTasks.length, maxFrameGapMs: originalBaseline.maxFrameGapMs } : null, caveat: 'Real thumbnails are generated offline. Renderer fixture mocks only IPC delivery with a configured delay; cold generation/queue cost is measured separately. Load/RAF marks are not direct visual-appearance assertions. Baseline is reused, not rerun; fixture asset counts may differ if the user generated more images.', errors, blockedRequests };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, stages, measurement, firstVisibleThumbnailBytes: report.firstVisibleThumbnailBytes, allThumbnailBytes: report.allThumbnailBytes, baseline: report.baseline, report: path.join(output, 'report.json') }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(error), stages, measurement, errors, blockedRequests }, null, 2));
  console.error(error); console.error(`Report: ${path.join(output, 'report.json')}`); process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
