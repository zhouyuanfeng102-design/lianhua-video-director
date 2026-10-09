import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One production portable launch, one native upload and one renderer reload.
// A fresh nonempty profile prevents legacy-user-data import. No API jobs run.
const root = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const configuredExecutable = String(process.env.APP_EXECUTABLE || '').trim();
assert.ok(configuredExecutable, 'APP_EXECUTABLE must name the new portable EXE');
const executable = fs.realpathSync.native(path.resolve(configuredExecutable));
assert.ok(fs.statSync(executable).isFile() && /\.exe$/iu.test(executable));
assert.ok(!/(?:^|[\\/])(?:node_modules|win-unpacked)(?:[\\/]|$)/iu.test(executable)
  && path.basename(executable).toLowerCase() !== 'electron.exe', 'Use the portable deliverable');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
assert.match(expectedVersion, /^\d+\.[0-9]\.[0-9]$/u, 'Use a release version following the decimal digit rule');
const qaRoot = fs.mkdtempSync(path.join(root, `.qa-story-reference-packaged-${expectedVersion}-`));
const dataDirectory = path.join(qaRoot, 'profile');
const outputDirectory = path.join(qaRoot, 'output');
fs.mkdirSync(dataDirectory); fs.mkdirSync(outputDirectory);
fs.writeFileSync(path.join(dataDirectory, '.qa-isolated-profile'), 'Isolated reference entry packaged QA\n', { flag: 'wx' });
const normalizePath = (value) => path.resolve(value).toLowerCase();
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const port = await findAvailableTcpPort();
const cdpUrl = `http://127.0.0.1:${port}`;
const environment = { ...process.env, LIANHUA_DATA_DIR: dataDirectory };
for (const key of ['ELECTRON_START_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LIANHUA_QA_MODE']) delete environment[key];
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
  cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'reference entry portable QA', runTimeoutMs: 150_000, closeTimeoutMs: 15_000 });
let browser; let page; let cdp; let failure; let closedGracefully = false;
const errors = { runtime: [], page: [], console: [], rendererLog: [], externalRequests: [] };
const checks = [];
const report = { executable, expectedVersion, dataDirectory, outputDirectory, launcherPid: child.pid, checks, errors };
const rendererLogPath = path.join(dataDirectory, 'logs', 'renderer.log');
const collectRendererLog = () => {
  if (!fs.existsSync(rendererLogPath)) return;
  const content = fs.readFileSync(rendererLogPath, 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'renderer.log'), content);
  errors.rendererLog = content.split(/\r?\n/u).filter((line) => /console level=(?:error|3)\b|did-fail-load|render-process-gone|initial-load failed:/u.test(line));
};
const readNativeState = () => page.evaluate(async () => {
  const content = await window.lianhuaDesktop.loadState();
  return content ? JSON.parse(content) : null;
});
const waitNativeState = async (label, predicate) => {
  let saved;
  await waitForCondition({ label, timeoutMs: 15_000, intervalMs: 160, check: async () => {
    saved = await readNativeState(); return Boolean(saved && predicate(saved));
  } });
  return saved;
};
const run = async () => {
  await waitForCondition({ label: 'portable debugging endpoint', timeoutMs: 90_000, intervalMs: 200, check: async () => {
    try { return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  const context = browser.contexts()[0]; assert.ok(context);
  await waitForCondition({ label: 'portable renderer page', timeoutMs: 15_000, intervalMs: 100, check: () => {
    page = context.pages().find((candidate) => candidate.url().startsWith('file:')) || context.pages()[0]; return Boolean(page);
  } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()); });
  await context.route(/^https?:\/\//u, async (route) => {
    errors.externalRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  cdp = await context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.runtime.push(exceptionDetails.exception?.description || exceptionDetails.text));
  await cdp.send('Runtime.enable');
  await page.locator('.app-shell .sidebar .nav-item').first().waitFor({ timeout: 30_000 });
  assert.match(page.url(), /^file:.*[\\/]resources[\\/]app\.asar[\\/]dist[\\/]index\.html$/iu);
  report.rendererUrl = page.url();
  const paths = await page.evaluate(() => window.lianhuaDesktop.storagePaths());
  assert.equal(normalizePath(paths.dataRoot), normalizePath(dataDirectory));
  report.isolatedProfileConfirmed = true;
  report.actualVersion = (await page.locator('.sidebar-version > span:last-child').innerText()).trim();
  assert.equal(report.actualVersion, `v${expectedVersion}`);
  checks.push('production app.asar, release version and isolated native data directory');

  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const mode = page.getByRole('group', { name: '本章视频创作方式' });
  const textMode = mode.getByRole('button', { name: '文生视频', exact: true });
  const imageMode = mode.getByRole('button', { name: '图生视频', exact: true });
  await textMode.waitFor({ state: 'visible' }); await imageMode.waitFor({ state: 'visible' });
  assert.equal(await textMode.getAttribute('aria-pressed'), 'true');
  const chapterId = await page.getByRole('combobox', { name: '当前章节', exact: true }).inputValue();
  assert.ok(chapterId, 'UI must select an actual chapter, including the initial default chapter');
  const story = page.locator('.story-source-textarea');
  const sourceStory = '便携版隔离验收：让图1中的人物走过石桥，随后向我挥手。';
  await story.fill(sourceStory);
  await imageMode.click();
  await page.getByRole('region', { name: '本章参考图片' }).waitFor({ state: 'visible' });
  assert.equal(await story.inputValue(), sourceStory);
  const upload = page.getByLabel('上传参考图片，一次一张');
  assert.equal(await upload.getAttribute('multiple'), null);
  checks.push('chapter text/image buttons, reference panel and unchanged story input');

  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 96;
    const context = canvas.getContext('2d'); context.fillStyle = '#badacf'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#cc4f86'; context.fillRect(1600, 16, 160, 64); context.fillStyle = '#243d40'; context.fillRect(24, 20, 52, 68);
    return canvas.toDataURL('image/png');
  });
  const original = Buffer.from(dataUrl.split(',')[1], 'base64');
  const originalPath = path.join(qaRoot, 'synthetic-reference-original-1800px.png');
  fs.writeFileSync(originalPath, original, { flag: 'wx' });
  // connectOverCDP is treated as a remote browser by Playwright, which turns
  // setInputFiles paths into synthetic File buffers without Electron's native
  // path. CDP's native file selection preserves webUtils.getPathForFile.
  const { root: documentNode } = await cdp.send('DOM.getDocument');
  const { nodeId: inputNodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.story-reference-file-input' });
  assert.ok(inputNodeId, 'reference file input must exist');
  await upload.evaluate((input) => input.addEventListener('change', (event) => {
    window.__qaReferenceNativeFile = event.target.files[0];
  }, { capture: true, once: true }));
  await cdp.send('DOM.setFileInputFiles', { nodeId: inputNodeId, files: [originalPath] });
  const { result: nativeFileHandle } = await cdp.send('Runtime.evaluate', { expression: 'window.__qaReferenceNativeFile', returnByValue: false });
  assert.ok(nativeFileHandle.objectId, 'capture the actual DOM File before the app clears the input');
  const { path: nativeFilePath } = await cdp.send('DOM.getFileInfo', { objectId: nativeFileHandle.objectId });
  assert.equal(normalizePath(nativeFilePath), normalizePath(originalPath));
  report.nativeFileSelection = { method: 'DOM.setFileInputFiles', nativeFilePath };
  const card = page.getByRole('article', { name: '图1参考图', exact: true });
  await card.waitFor({ state: 'visible' });
  const saved = await waitNativeState('native reference and asset save', (state) => {
    const project = state.project; const workspace = project.chapterWorkspaces?.[chapterId];
    const reference = workspace?.storyReferences?.[0];
    return workspace?.storyInputMode === 'image' && reference?.number === 1 && project.assets.some((asset) => asset.id === reference.assetId && asset.managed);
  });
  const project = saved.project;
  const workspace = project.chapterWorkspaces[chapterId]; const reference = workspace.storyReferences[0];
  const storedAsset = project.assets.find((asset) => asset.id === reference.assetId);
  assert.equal(reference.status, 'unrecognized');
  assert.equal(storedAsset.checksum, checksum(original));
  assert.equal(storedAsset.sizeBytes, original.length);
  assert.equal(storedAsset.dataUrl, undefined, 'native upload must be managed rather than inline image data');
  const managedPath = path.resolve(paths.assets, storedAsset.relativePath);
  const relativeManaged = path.relative(path.resolve(paths.assets), managedPath);
  assert.ok(relativeManaged && !relativeManaged.startsWith('..') && !path.isAbsolute(relativeManaged));
  assert.equal(checksum(fs.readFileSync(managedPath)), checksum(original), 'desktop import must retain original bytes');
  const managedData = await page.evaluate((asset) => window.lianhuaDesktop.readManagedImageDataUrl({ relativePath: asset.relativePath, expectedChecksum: asset.checksum }), storedAsset);
  const returnedDataUrl = typeof managedData === 'string' ? managedData : managedData.dataUrl;
  assert.equal(checksum(Buffer.from(returnedDataUrl.split(',')[1], 'base64')), checksum(original));
  report.upload = { assetId: storedAsset.id, referenceId: reference.id, chapterId, number: reference.number,
    originalWidth: 1800, originalSizeBytes: original.length, originalChecksum: checksum(original), managedChecksum: storedAsset.checksum, relativePath: storedAsset.relativePath };
  checks.push('real desktop importMedia: original PNG enters native asset library and chapter with matching SHA-256');

  await textMode.click(); assert.equal(await story.inputValue(), sourceStory);
  await imageMode.click(); assert.equal(await story.inputValue(), sourceStory);
  await waitNativeState('native mode and story draft save', (state) => {
    const project = state.project; const workspace = project.chapterWorkspaces?.[chapterId];
    return workspace?.storyInputMode === 'image' && (workspace.storyDraft?.content || project.storyDraft?.content) === sourceStory;
  });
  await page.screenshot({ path: path.join(outputDirectory, '01-uploaded-reference.png') });
  // Remove only the isolated browser mirror. The next renderer load must use
  // the real desktop save; no seeded renderer state substitutes for recovery.
  await page.evaluate(() => localStorage.removeItem('lianhua_video_director_state_v22'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await card.waitFor({ state: 'visible' });
  assert.equal(await imageMode.getAttribute('aria-pressed'), 'true');
  assert.equal(await story.inputValue(), sourceStory);
  const restored = await readNativeState();
  const restoredReference = restored.project.chapterWorkspaces[chapterId].storyReferences[0];
  assert.equal(restoredReference.id, reference.id); assert.equal(restoredReference.number, 1);
  const restoredAsset = restored.project.assets.find((asset) => asset.id === restoredReference.assetId);
  assert.equal(restoredAsset.relativePath, storedAsset.relativePath); assert.equal(restoredAsset.checksum, checksum(original));
  await card.locator('img').evaluate((image) => image.decode());
  assert.equal(await card.locator('img').evaluate((image) => image.naturalWidth), 1800);
  await page.screenshot({ path: path.join(outputDirectory, '02-native-reload.png') });
  checks.push('text survives mode switches; cleared browser cache reload restores native mode, draft, stable number and original image');
  report.nativeReloadVerified = true;
  collectRendererLog();
  for (const [kind, entries] of Object.entries(errors)) assert.deepEqual(entries, [], `${kind} must remain empty`);
  harness.markElectronStopping();
  await page.evaluate(() => { setTimeout(() => window.close(), 0); });
  await harness.waitForElectronClose();
  assert.equal(child.exitCode, 0); closedGracefully = true;
};
const closeConnection = async (close) => {
  let timer;
  try { await Promise.race([Promise.resolve().then(close).catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 2500); })]); }
  finally { clearTimeout(timer); }
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  failure = error;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }).catch(() => {});
} finally {
  harness.markElectronStopping();
  try { await harness.stopAll(); } catch (error) { failure ||= error; }
  await closeConnection(() => cdp?.detach()); await closeConnection(() => browser?.close());
  collectRendererLog();
  if (!failure && Object.values(errors).some((entries) => entries.length)) failure = new Error('Runtime or renderer errors were recorded');
  fs.writeFileSync(path.join(outputDirectory, 'process.log'), harness.readElectronLog());
  Object.assign(report, { passed: !failure, closedGracefully, exitCode: child.exitCode, noGenerationSubmitted: true, ...(failure ? { failure: String(failure) } : {}) });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
