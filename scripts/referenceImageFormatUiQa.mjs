import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Synthetic solid-color pixels only. This profile never reads production state
// or sends requests to an external image/text provider.
const require = createRequire(import.meta.url);
const { buildImageEditMultipart } = require('../electron/imageReferenceTransport.cjs');
const samples = JSON.parse(fs.readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8'));
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `reference-image-format-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reference QA evidence must stay below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'reference image format UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const png = `data:image/png;base64,${samples.png}`;
const mislabeled = `data:image/jpeg;base64,${samples.png}`;
const expectedBytes = Buffer.from(samples.png, 'base64');
const checks = []; const requests = []; const errors = []; const blockedRequests = [];
let browser; let context; let page;
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const enterImages = () => page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
const enterTasks = () => page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
const verifyMultipart = async (body, contentType, transport) => {
  const parsed = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  const files = [...parsed.values()].filter((value) => typeof value !== 'string');
  assert.equal(files.length, 1, `${transport}: selected reference is preserved exactly once`);
  assert.equal(files[0].type, 'image/png'); assert.match(files[0].name, /\.png$/u);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), expectedBytes, `${transport}: reference pixels are unchanged`);
  requests.push({ transport, mimeType: files[0].type, fileName: files[0].name, bytes: files[0].size, prompt: parsed.get('prompt') });
};
const run = async () => {
  await waitForCondition({ label: 'reference format QA Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('crash', () => errors.push('renderer crashed'));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__reference_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><title>Isolated reference format QA</title><body>Synthetic fixture</body></html>' }));
  await page.route('**/__qa_reference__/**', async (route) => {
    const request = route.request(); assert.match(request.url(), /\/images\/edits$/u);
    await verifyMultipart(request.postDataBuffer(), request.headers()['content-type'], 'browser');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: samples.png }] }) });
  });
  await page.exposeFunction('__qaDesktopRequest', async (payload) => {
    assert.equal(new URL(payload.url).origin, origin); assert.match(payload.url, /\/images\/edits$/u);
    assert.equal(payload.multipart.files[0].dataUrl, png, 'frontend normalizes the IPC payload');
    const encoded = buildImageEditMultipart(payload.multipart);
    await verifyMultipart(encoded.body, encoded.contentType, 'desktop bridge + production multipart encoder');
    return { status: 200, body: JSON.stringify({ data: [{ b64_json: samples.png }] }) };
  });
  await page.goto(`${origin}/__reference_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts'); const state = createInitialState(); const now = Date.now();
    const prop = { id: 'format-prop', name: '蓝色陶瓷杯', description: '合成测试用简单陶瓷杯', appearance: '蓝色陶瓷、完整手柄', material: '陶瓷', function: '盛水', anchor: '固定蓝色', assetIds: [] };
    const project = { ...state.project, id: 'reference-format-project', name: '参考图片格式测试', characters: [], locations: [], props: [prop], assets: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], sourceDocuments: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi.enabled = false; state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__qa_reference__/image`, apiKey: '', model: 'synthetic-image' };
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterImages();
  await page.locator('.image-asset-kind-tabs').getByRole('button', { name: '物品', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('format-prop');
  const upload = page.locator('.image-setting-references input[type="file"]');
  await upload.setInputFiles({ name: 'actually-png.jpg', mimeType: 'image/jpeg', buffer: expectedBytes });
  await page.waitForFunction(({ key, png }) => JSON.parse(localStorage.getItem(key)).project.assets.some((asset) => asset.name === 'actually-png.jpg' && asset.dataUrl === png && asset.mimeType === 'image/png'), { key: storageKey, png });
  const preview = page.getByAltText('普通参考图缩略图');
  assert.deepEqual(await preview.evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight, complete: img.complete, src: img.src })), { width: 2, height: 2, complete: true, src: png });
  const uploaded = (await readState()).project.assets.find((asset) => asset.name === 'actually-png.jpg');
  assert.equal(uploaded.fileName, 'actually-png.jpg', 'the user filename is retained as display metadata');
  assert.equal(uploaded.dataUrl, png, 'valid small uploads keep original encoded bytes');
  checks.push('Workbench upload accepts PNG bytes under .jpg / image/jpeg metadata; preview decodes and saved asset MIME is PNG without transcoding');
  await page.screenshot({ path: path.join(output, 'corrected-upload-preview.png') });

  for (const fixture of [
    { name: 'not-an-image.png', mimeType: 'image/png', buffer: Buffer.from('not an image'), message: /文件签名无效|内容已损坏/u },
    { name: 'truncated.png', mimeType: 'image/png', buffer: expectedBytes.subarray(0, 24), message: /无法解码|文件可能已损坏/u },
  ]) {
    const previousAssets = (await readState()).project.assets;
    await upload.setInputFiles(fixture); await page.getByText(fixture.message).last().waitFor();
    assert.deepEqual((await readState()).project.assets, previousAssets); assert.equal(requests.length, 0);
    checks.push(`${fixture.name}: clear upload error, no asset saved and no model request`);
  }

  // Recreate a pre-fix task referencing the same valid bytes under a wrong MIME
  // label, then use the real task-page retry after loading saved state.
  await page.goto(`${origin}/__reference_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, mislabeled, assetId }) => {
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const now = Date.now();
    project.assets = project.assets.map((asset) => asset.id === assetId ? { ...asset, dataUrl: mislabeled, mimeType: 'image/jpeg' } : asset);
    project.generationTasks = [{ id: 'legacy-format-task', kind: 'image', name: '旧格式参考图重试', assetKind: 'prop', imageVariant: 'showcase', status: 'failed', prompt: 'A single blue ceramic mug on a plain neutral background, complete handle, soft studio lighting, no text.', width: 1024, height: 1024, backend: 'openai', model: 'synthetic-image', sourceEntityId: 'format-prop', referenceScope: 'general', imagePromptFormat: 'natural-language', conversionSource: '蓝色陶瓷杯', conversionIdentityContext: '', converterSystemPrompt: '普通物品参考图', primaryReferenceAssetIds: [], referenceAssetIds: [assetId], createdAt: now, updatedAt: now, error: 'Historical MIME mismatch' }];
    state.projects = [project]; localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, mislabeled, assetId: uploaded.id });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterTasks();
  const originalTask = (await readState()).project.generationTasks.find((task) => task.id === 'legacy-format-task');
  await page.locator('#image-task-legacy-format-task .image-regenerate-button').click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks.some((task) => task.id !== 'legacy-format-task' && ['succeeded', 'failed'].includes(task.status)), storageKey, { timeout: 25_000 });
  const retriedState = await readState(); const retried = retriedState.project.generationTasks.find((task) => task.id !== 'legacy-format-task');
  assert.equal(retried.status, 'succeeded', retried.error); assert.equal(requests.length, 1);
  assert.equal(retriedState.project.assets.find((asset) => asset.id === uploaded.id).dataUrl, mislabeled, 'repair operates on outgoing copy, preserving original saved reference');
  assert.deepEqual(retriedState.project.generationTasks.find((task) => task.id === originalTask.id), originalTask);
  checks.push('Saved legacy wrong-MIME reference survives reload and real task-page regeneration succeeds through browser multipart with PNG MIME, .png name and original bytes');

  await page.evaluate(async ({ key, assetId }) => {
    const state = JSON.parse(localStorage.getItem(key)); const asset = state.project.assets.find((entry) => entry.id === assetId);
    const { requestImageModel } = await import('/src/services/llm.ts');
    window.lianhuaDesktop = { request: (payload) => window.__qaDesktopRequest(payload) };
    try { await requestImageModel(state.settings.imageApi, { prompt: 'A blue ceramic mug.', width: 1024, height: 1024, referenceImages: [asset.dataUrl] }); }
    finally { delete window.lianhuaDesktop; }
  }, { key: storageKey, assetId: uploaded.id });
  assert.equal(requests.length, 2); checks.push('Same legacy saved reference succeeds through real service + simulated desktop IPC + production Electron multipart encoder');
  await page.reload({ waitUntil: 'networkidle' }); await enterTasks();
  assert.equal((await readState()).project.generationTasks.find((task) => task.id === retried.id).status, 'succeeded');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'legacy-reference-retry.png') });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, requests, errors, blockedRequests }, null, 2));
  console.log(`Reference image format UI QA passed. Report: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, requests, errors, blockedRequests, error: String(error), stack: error?.stack }, null, 2)); throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
