import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureOptionalQaArtifact } from './qaArtifacts.mjs';
import { waitForCondition } from './qaProcessHarness.mjs';

const port = Number(process.env.CDP_PORT || 9231);
const dataDirectory = process.env.LIANHUA_DATA_DIR;
const outputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-electron');
const exportPath = process.env.LIANHUA_QA_EXPORT_PATH;
const backupDirectory = process.env.LIANHUA_QA_BACKUP_DIR;
const savedImagePath = process.env.LIANHUA_QA_SAVE_MEDIA_PATH;
if (!dataDirectory) throw new Error('LIANHUA_DATA_DIR is required');
if (!exportPath || !backupDirectory || !savedImagePath) throw new Error('LIANHUA_QA_EXPORT_PATH, LIANHUA_QA_BACKUP_DIR, and LIANHUA_QA_SAVE_MEDIA_PATH are required');
const normalizeFsPath = (value) => {
  const normalized = path.resolve(String(value || '')).replace(/[\\/]+/gu, path.sep);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
fs.mkdirSync(outputDirectory, { recursive: true });
const fixtureMedia = Buffer.from('lianhua-project-package-ipc-media');
const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z6k9WQAAAABJRU5ErkJggg==', 'base64');
const fixtureImageDataUrl = `data:image/png;base64,${fixtureImage.toString('base64')}`;
const fixtureChecksum = createHash('sha256').update(fixtureMedia).digest('hex');
const fixtureRelativePath = `video/${fixtureChecksum}.mp4`;
const fixturePath = path.join(dataDirectory, 'assets', fixtureRelativePath);
fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
fs.writeFileSync(fixturePath, fixtureMedia);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);

let target;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(connectionTimeoutMs),
    }).then((response) => response.json());
    target = targets.find((item) => item.type === 'page' && item.title?.includes('莲华')) || targets.find((item) => item.type === 'page');
    if (target) break;
  } catch { /* Electron may still be starting. */ }
  await delay(250);
}
if (!target) throw new Error('Electron debugging target did not start');

const socket = new WebSocket(target.webSocketDebuggerUrl);
const waitForSocketOpen = () => new Promise((resolve, reject) => {
  if (socket.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('error', onError);
    socket.removeEventListener('close', onClose);
  };
  const onOpen = () => { cleanup(); resolve(); };
  const onError = () => { cleanup(); reject(new Error('CDP socket connection failed')); };
  const onClose = () => { cleanup(); reject(new Error('CDP socket closed before opening')); };
  const timer = setTimeout(() => { cleanup(); reject(new Error('CDP socket connection timed out')); }, connectionTimeoutMs);
  socket.addEventListener('open', onOpen, { once: true });
  socket.addEventListener('error', onError, { once: true });
  socket.addEventListener('close', onClose, { once: true });
});
try {
  await waitForSocketOpen();
} catch (error) {
  socket.close();
  throw error;
}
let id = 0;
const commandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_COMMAND_TIMEOUT_MS) || 10_000);
const startupCommandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_STARTUP_COMMAND_TIMEOUT_MS) || 60_000);
const pending = new Map();
const consoleErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id); pending.delete(message.id);
    globalThis.clearTimeout?.(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text || 'Runtime exception');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((item) => item.value || item.description || '').join(' '));
});
const failPending = (reason) => {
  const error = reason instanceof Error ? reason : new Error(`CDP socket ${String(reason || 'closed')}`);
  for (const handler of pending.values()) {
    globalThis.clearTimeout?.(handler.timer);
    handler.reject(error);
  }
  pending.clear();
};
socket.addEventListener('close', (event) => failPending(event.reason || 'closed'));
socket.addEventListener('error', (event) => failPending(event.message || 'error'));
const command = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
  if (typeof WebSocket !== 'undefined' && socket.readyState !== WebSocket.OPEN) {
    reject(new Error('CDP socket is not open'));
    return;
  }
  const commandId = ++id;
  const timer = globalThis.setTimeout?.(() => {
    pending.delete(commandId);
    reject(new Error(`CDP command timed out: ${method}`));
  }, timeoutMs);
  pending.set(commandId, { resolve, reject, timer });
  try {
    socket.send(JSON.stringify({ id: commandId, method, params }));
  } catch (error) {
    globalThis.clearTimeout?.(timer);
    pending.delete(commandId);
    reject(error);
  }
});
const evaluate = async (expression, timeoutMs = commandTimeoutMs) => {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Evaluation failed');
  return response.result.value;
};
await command('Runtime.enable', {}, startupCommandTimeoutMs).catch((error) => {
  failPending(error);
  socket.close();
  throw error;
});
try {
await command('Page.enable');
await waitForCondition({
  label: 'Electron renderer',
  timeoutMs: startupCommandTimeoutMs,
  intervalMs: 200,
  check: (remainingMs) => evaluate(
    `Boolean(document.querySelector('.app-shell') && window.lianhuaDesktop)`,
  Math.min(commandTimeoutMs, remainingMs),
  ),
});
const connectedRendererDataRoot = await evaluate(
  `(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot)()`,
  startupCommandTimeoutMs,
);
if (normalizeFsPath(connectedRendererDataRoot) !== normalizeFsPath(dataDirectory)) {
  throw new Error(`Electron smoke connected to the wrong data root: ${connectedRendererDataRoot}`);
}

const result = await evaluate(`(async () => {
  const key = 'lianhua_video_director_state_v22';
  for (let attempt = 0; attempt < 80 && !localStorage.getItem(key); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = JSON.parse(localStorage.getItem(key));
  if (!base?.project || !base?.settings) throw new Error('Initial application state was not persisted');
  const secret = 'LH_TEST_SECRET_NOT_REAL';
  const originalName = base.project.name;
  base.settings.textApi.apiKey = secret;
  base.project.assets = [{
    id: 'qa-package-media', name: 'qa-package.mp4', type: 'video', role: 'motion',
    mediaType: 'video', referenceRole: 'motion', relativePath: ${JSON.stringify(fixtureRelativePath)},
    checksum: ${JSON.stringify(fixtureChecksum)}, sizeBytes: ${fixtureMedia.length}, managed: true,
    missing: false, tags: ['qa'], createdAt: Date.now(), updatedAt: Date.now()
  }, ...(base.project.assets || []).filter((asset) => asset.id !== 'qa-package-media')];
  base.project.name = '恢复点版本';
  const activeProjectId = base.activeProjectId || base.project.id;
  const projectMirrorIndex = Array.isArray(base.projects)
    ? base.projects.findIndex((project) => project?.id === activeProjectId)
    : -1;
  if (!Array.isArray(base.projects)) base.projects = [];
  if (projectMirrorIndex >= 0) base.projects[projectMirrorIndex] = structuredClone(base.project);
  else base.projects.push(structuredClone(base.project));
  const saved = await window.lianhuaDesktop.saveState(JSON.stringify(base));
  const loaded = JSON.parse(await window.lianhuaDesktop.loadState());
  const restore = await window.lianhuaDesktop.createRestorePoint(JSON.stringify(base));
  const snapshotId = restore.path.split(/[\\/]/).pop();
  const changed = structuredClone(base);
  changed.project.name = '恢复后不应保留的版本';
  await window.lianhuaDesktop.saveState(JSON.stringify(changed));
  const restored = JSON.parse(await window.lianhuaDesktop.restoreSnapshot(snapshotId));
  const loadedAfterRestore = JSON.parse(await window.lianhuaDesktop.loadState());
  const backupConfig = await window.lianhuaDesktop.chooseBackupDirectory();
  const backupSaved = await window.lianhuaDesktop.saveState(JSON.stringify(restored));
  const exported = await window.lianhuaDesktop.exportProjectPackage({ content: JSON.stringify(restored), fileName: 'qa-roundtrip' });
  const imported = JSON.parse(await window.lianhuaDesktop.importProjectPackage());
  const savedImage = await window.lianhuaDesktop.saveMedia({
    sourceUrl: ${JSON.stringify(fixtureImageDataUrl)},
    fileName: 'qa-generated-image',
    mimeType: 'image/png',
    mediaType: 'image'
  });
  const status = await window.lianhuaDesktop.recoveryStatus();
  const paths = await window.lianhuaDesktop.storagePaths();
  const escaped = await window.lianhuaDesktop.assetStatus('../outside.txt');
  let privateNetworkBlocked = false;
  try { await window.lianhuaDesktop.request({ url: 'http://127.0.0.1:9199/test', method: 'GET' }); }
  catch (error) { privateNetworkBlocked = String(error).includes('阻止') || String(error).includes('局域网'); }
  let emptyStateRejected = false;
  try { await window.lianhuaDesktop.saveState(''); } catch { emptyStateRejected = true; }
  return {
    title: document.title,
    originalName,
    saved: Boolean(saved?.ok),
    secretHydrated: loaded.settings.textApi.apiKey === secret,
    restoreCreated: Boolean(restore?.ok),
    restoredStateReplaced: restored.project.name === '恢复点版本' && loadedAfterRestore.project.name === '恢复点版本',
    backupDirectorySelected: backupConfig?.backupDirectory || '',
    backupWritten: Boolean(backupSaved?.externalBackup),
    packageExported: Boolean(exported?.path && exported.assetCount === 1 && exported.missingCount === 0),
    packageImported: imported.project.name === restored.project.name && imported.project.assets.some((asset) => asset.checksum === ${JSON.stringify(fixtureChecksum)}),
    imageSaved: Boolean(savedImage),
    snapshotCount: status.snapshots.length,
    stateValid: status.stateValid,
    encryptionAvailable: status.encryptionAvailable,
    dataRoot: paths.dataRoot,
    assetEscapeRejected: escaped.exists === false,
    privateNetworkBlocked,
    emptyStateRejected,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`, startupCommandTimeoutMs);

const screenshotError = await captureOptionalQaArtifact('Electron screenshot', async () => {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(outputDirectory, 'electron.png'), Buffer.from(screenshot.data, 'base64'));
});
const statePath = path.join(dataDirectory, 'project-state.json');
const stateExists = fs.existsSync(statePath);
const stateText = stateExists ? fs.readFileSync(statePath, 'utf8') : '';
const disk = {
  stateExists,
  secretAbsentFromState: !stateText.includes('LH_TEST_SECRET_NOT_REAL'),
  encryptedVaultExists: fs.existsSync(path.join(dataDirectory, 'credentials.safe')),
  stateBytes: Buffer.byteLength(stateText),
  exportExists: fs.existsSync(exportPath),
  backupManifestExists: fs.existsSync(path.join(backupDirectory, '莲华视频导演台备份', 'backup-integrity.json')),
  backupAssetExists: fs.existsSync(path.join(backupDirectory, '莲华视频导演台备份', 'assets', fixtureRelativePath)),
  savedImageExists: fs.existsSync(savedImagePath),
  savedImageMatches: fs.existsSync(savedImagePath) && fs.readFileSync(savedImagePath).equals(fixtureImage),
};
const report = { result, disk, consoleErrors, screenshotError };
fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
const failed = Object.entries({
  saved: result.saved,
  secretHydrated: result.secretHydrated,
  restoreCreated: result.restoreCreated,
  restoredStateReplaced: result.restoredStateReplaced,
  backupDirectorySelected: path.resolve(result.backupDirectorySelected || '') === path.resolve(backupDirectory),
  backupWritten: result.backupWritten,
  packageExported: result.packageExported,
  packageImported: result.packageImported,
  imageSaved: result.imageSaved,
  stateValid: result.stateValid,
  encryptionAvailable: result.encryptionAvailable,
  assetEscapeRejected: result.assetEscapeRejected,
  privateNetworkBlocked: result.privateNetworkBlocked,
  emptyStateRejected: result.emptyStateRejected,
  noOverflow: !result.overflowX,
  stateExists: disk.stateExists,
  secretAbsentFromState: disk.secretAbsentFromState,
  encryptedVaultExists: disk.encryptedVaultExists,
  exportExists: disk.exportExists,
  backupManifestExists: disk.backupManifestExists,
  backupAssetExists: disk.backupAssetExists,
  savedImageExists: disk.savedImageExists,
  savedImageMatches: disk.savedImageMatches,
  noConsoleErrors: consoleErrors.length === 0,
}).filter(([, value]) => !value).map(([key]) => key);
if (failed.length) throw new Error(`Electron smoke failed: ${failed.join(', ')}\n${JSON.stringify(report, null, 2)}`);
console.log(JSON.stringify(report, null, 2));
} finally {
  failPending('electron smoke finished');
  socket.close();
}
