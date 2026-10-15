import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, waitForCondition } from './qaProcessHarness.mjs';

// Targeted production-renderer check. Every project, task, snapshot and write is
// synthetic and confined to a freshly created workspace QA profile. The small
// launch wrappers record counts/timings only and deny provider/network calls.
const root = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const require = createRequire(import.meta.url);
const { createInitialState, normalizeState, needsInitialDesktopSave } = await tsImport('../src/storage.ts', import.meta.url);
const { samePersistedData } = await tsImport('../src/projectLibraryRuntime.ts', import.meta.url);
const { createStateStore, atomicWriteFile } = require('../electron/statePersistenceStore.cjs');
const { writeProjectLibrary } = require('../electron/projectLibraryStore.cjs');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')), 'Build the production renderer before this focused check');
const qaRoot = fs.mkdtempSync(path.join(root, '.qa-large-library-startup-'));
const dataRoot = path.join(qaRoot, 'profile');
const output = path.join(qaRoot, 'output');
fs.mkdirSync(dataRoot); fs.mkdirSync(output);
fs.writeFileSync(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic large-library startup QA. No legacy import.\n', { flag: 'wx' });
const stateFile = path.join(dataRoot, 'project-state.json');
const metricsFile = path.join(output, 'metrics.jsonl');
const packageFile = path.join(output, 'current-project.lhvd');
const workerEntry = path.join(qaRoot, 'worker-probe.cjs');
const appEntry = path.join(qaRoot, 'app-probe.cjs');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const initial = createInitialState();
const seedTime = Date.UTC(2026, 9, 15, 0, 0);
const activeId = 'startup-000';
const archiveId = 'startup-042';
const taskId = 'startup-099';
const nameOf = (id) => `启动专项 · 项目 ${id.slice(-3)}`;
const chapterName = '隔离合成章节';
const changedChapterName = '专项编辑后章节';
const expected = new Map();
const expectedTasks = ['qa-unknown-video', 'qa-pending-image', 'qa-continuable-video'];
const report = { version, passed: false, dataRoot, output, productionDist: true, syntheticProjects: 100,
  sourceSnapshots: 20, noProductionDataRead: true, noProductionDataWritten: true, noProviderCallsAllowed: true,
  qaWindowPolicy: { hiddenFromConstruction: true, showAndFocusSuppressed: true, visibleWindowsAllowed: false },
  earlierHarnessVisibilityIncident: { profile: path.join(root, '.qa-large-library-startup-ziAsKA', 'profile'), electronPid: 150228,
    syntheticOnly: true, productionProfileAccessed: false, cause: 'The original QA wrapper did not override BrowserWindow visibility; its invalid synthetic task produced the visible connection error.',
    corrected: 'All subsequent launches construct hidden windows and assert they remain hidden.' },
  checks: [], errors: [], screenshots: [], launches: [], timings: {}, io: {} };
const checked = (label) => { report.checks.push(label); console.log(label); };
const readMetrics = () => fs.existsSync(metricsFile) ? fs.readFileSync(metricsFile, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
const manifest = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const pointers = (value = manifest()) => new Map([value.project, ...(value.projects || [])].map((pointer) => [pointer.id, pointer.hash]));
const projectFile = (id, value = manifest()) => path.join(dataRoot, 'project-library', `${pointers(value).get(id)}.json`);
const readProject = (id) => JSON.parse(fs.readFileSync(projectFile(id), 'utf8'));
const projectCard = (page, id) => page.locator(`.project-library-item[data-project-id="${id}"]`);

const makeProject = (index) => {
  const id = `startup-${String(index).padStart(3, '0')}`;
  const sourceId = `${id}-chapter`;
  const project = { ...structuredClone(initial.project), id, name: nameOf(id), description: `合成项目 ${index}，仅验证本地启动、切换和保存。`,
    activeChapterId: sourceId, chapterWorkspaces: {}, storyDraft: { name: chapterName, content: '合成剧情。', updatedAt: seedTime },
    sourceDocuments: [{ id: sourceId, name: chapterName, content: '合成剧情。', createdAt: seedTime, updatedAt: seedTime }],
    characters: [], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
    createdAt: seedTime + index, updatedAt: seedTime };
  project.scenes = Array.from({ length: 3 }, (_, scene) => ({ id: `${id}-scene-${scene}`, title: `合成场景 ${scene + 1}`,
    content: '成年旅人在桥边交谈。', summary: '合成场景', characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: seedTime, updatedAt: seedTime }));
  const prompt = 'integrated_multimodal_description: [Shot 1] Adult travelers speak on a bridge.\n\noverall_soundscape: Wind.\n\nnon_diegetic_music: N/A';
  const snapshot = (task) => ({ projectId: id, clientId: `qa-client-${task}`, images: [],
    draft: { name: task, backend: 'api', prompt: 'Synthetic stopped task. Never submit.', references: [], parameters: {} },
    connection: { backend: 'api', api: { ...initial.settings.videoTaskApi, enabled: false, provider: 'generic', apiKey: '',
      endpoint: 'https://qa.invalid/generate', statusEndpointTemplate: 'https://qa.invalid/tasks/{id}', model: 'qa-disabled' } } });
  project.storyboards = Array.from({ length: 4 }, (_, board) => ({ id: `${id}-board-${board}`, chapterId: sourceId,
    sceneId: project.scenes[board % 3].id, sourceStoryContent: '合成剧情。', sourceStoryTitle: '合成场景', workflow: 'drama', inputMode: 'text',
    durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    stylePresetId: initial.settings.defaultStylePresetId, ruleSetId: initial.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '',
    shots: [{ id: `${id}-shot-${board}`, index: 1, startSec: 0, endSec: 5, subject: '成年旅人', action: '交谈', camera: '中景固定', lighting: '自然光',
      sound: '风声', transition: '自然', result: '交谈', referenceAssetIds: [], prompt, locked: false }], finalPrompt: prompt,
    officialPromptZh: prompt, officialPromptEn: prompt, officialPromptEnSource: prompt, targetModelId: 'minimax-h3', createdAt: seedTime, updatedAt: seedTime }));
  if (id === taskId) project.generationTasks = [
    { id: expectedTasks[0], kind: 'video', storyboardId: '', targetId: 'qa-disabled', status: 'unknown', remoteTaskId: 'qa-existing-remote', requestBody: {},
      videoJob: { stage: 'unknown', trackingStopped: true, snapshot: snapshot(expectedTasks[0]), preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] } }, createdAt: seedTime, updatedAt: seedTime },
    { id: expectedTasks[1], kind: 'image', name: '已生成、待手动保存的合成图片', assetKind: 'custom', imageVariant: 'portrait', status: 'succeeded',
      customImageSavePending: true, prompt: '合成图', width: 64, height: 64, backend: 'openai-compatible', model: 'qa-disabled', createdAt: seedTime, updatedAt: seedTime },
    { id: expectedTasks[2], kind: 'video', storyboardId: '', targetId: 'qa-disabled', status: 'failed', requestBody: {},
      videoJob: { stage: 'failed', trackingStopped: true, snapshot: snapshot(expectedTasks[2]) }, error: '仅用于检查续跑记录保留', createdAt: seedTime, updatedAt: seedTime },
  ];
  return project;
};

const seedStarted = performance.now();
const smallProjects = Array.from({ length: 100 }, (_, index) => makeProject(index));
let seed = normalizeState({ ...initial, project: smallProjects[0], projects: smallProjects, activeProjectId: activeId });
for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) {
  if (seed.settings[key]) { seed.settings[key].enabled = false; seed.settings[key].apiKey = ''; }
}
for (const key of ['apiCredentialBook', 'textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles']) seed.settings[key] = [];
// Keep normal editor text small; large archived document payloads model library
// history without introducing pixels or a huge visible textarea into this check.
const bigProjectBytes = Math.round(5.88 * 1024 * 1024);
const ordinaryBytes = Math.round((154 * 1024 * 1024 - bigProjectBytes) / 99);
for (const project of seed.projects) {
  const targetBytes = project.id === archiveId ? bigProjectBytes : ordinaryBytes;
  project.sourceDocuments.push({ id: `${project.id}-history`, name: '合成历史原文', content: '', createdAt: seedTime, updatedAt: seedTime });
  const baseBytes = Buffer.byteLength(JSON.stringify(project));
  project.sourceDocuments[1].content = `QA HISTORY ${project.id}\n` + 'x'.repeat(Math.max(0, targetBytes - baseBytes - 23));
  expected.set(project.id, { sourceHash: digest(project.sourceDocuments[1].content), promptHash: digest(project.storyboards[0].finalPrompt),
    counts: { sourceDocuments: project.sourceDocuments.length, scenes: project.scenes.length, storyboards: project.storyboards.length, assets: project.assets.length } });
}
seed.project = seed.projects.find((project) => project.id === activeId);
// This check measures an already-current saved workspace. Finish the fixture's
// own chapter/profile defaults before writing it, then prove normalization is
// idempotent; real migrations remain covered by the storage migration checks.
seed = normalizeState(seed);
assert.equal(samePersistedData(seed, normalizeState(seed)), true, 'the steady-state fixture must have no pending schema/default migrations');
const written = writeProjectLibrary({ ...seed, projects: seed.projects.map((project) => project.id === activeId ? { id: activeId, __activeProjectReference: true } : project) },
  { root: dataRoot, writeFile: atomicWriteFile, savedAt: seedTime });
fs.writeFileSync(stateFile, written.payload, { flag: 'wx' });
const snapshotsRoot = path.join(dataRoot, 'project-snapshots'); fs.mkdirSync(snapshotsRoot);
for (let index = 0; index < 20; index++) {
  const name = `project-${new Date(seedTime - (index + 1) * 60_000).toISOString().replace(/[:.]/gu, '-')}-qa${String(index).padStart(6, '0')}.json`;
  fs.writeFileSync(path.join(snapshotsRoot, name), written.payload, { flag: 'wx' });
}
const originalManifest = fs.readFileSync(stateFile);
const originalPointers = pointers();
report.fixture = { projectBlockBytes: written.projectFiles.reduce((sum, item) => sum + item.sizeBytes, 0), manifestBytes: written.payload.length,
  largestProjectBytes: fs.statSync(projectFile(archiveId)).size, pendingTaskProjectId: taskId };
seed = null;
const seedStore = createStateStore({ dataRoot });
assert.equal(typeof seedStore.loadWorkspace, 'function', 'The compact workspace storage implementation must be present before this check');
const primeStarted = performance.now();
const prime = JSON.parse(seedStore.loadWorkspace(null).content);
report.timings.firstIndexPreparationMs = Math.round(performance.now() - primeStarted);
assert.equal(prime.projects.length, 100);
assert.deepEqual(prime.projects.filter((project) => !project.__activeProjectReference && !project.__projectLibraryReference).map((project) => project.id).sort(), [taskId]);
assert.equal(prime.project.id, activeId);
assert.equal(prime.projects.filter((project) => project.__projectLibraryReference).length, 98);
assert.equal(needsInitialDesktopSave(normalizeState(prime)), false, 'the compact synthetic workspace must have no pending migration or unsaved project before the UI starts');
report.timings.fixturePreparationMs = Math.round(performance.now() - seedStarted);
checked('100 synthetic projects (~154 MiB), one 5.88 MiB archive, 20 shared-block recovery points and one unfinished-task archive prepared in a new isolated profile');

fs.writeFileSync(workerEntry, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const rawRead = fs.readFileSync.bind(fs);
const rawWrite = fs.writeFileSync.bind(fs);
const rawAppend = fs.appendFileSync.bind(fs);
const rawOpen = fs.openSync.bind(fs);
const rawClose = fs.closeSync.bind(fs);
const descriptors = new Map();
fs.openSync = (file, ...args) => { const descriptor = rawOpen(file, ...args); descriptors.set(descriptor, file); return descriptor; };
fs.closeSync = (descriptor) => { try { return rawClose(descriptor); } finally { descriptors.delete(descriptor); } };
let active;
const classify = (file) => {
  if (typeof file === 'number') file = descriptors.get(file);
  if (typeof file !== 'string') return '';
  const relative = path.relative(workerData.dataRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.startsWith('project-library' + path.sep) ? 'blocks' : relative.startsWith('project-snapshots' + path.sep) ? 'snapshots' : 'metadata';
};
fs.readFileSync = (file, ...args) => {
  const result = rawRead(file, ...args); const kind = classify(file);
  if (active && kind) { active.reads[kind]++; active.readBytes[kind] += typeof result === 'string' ? Buffer.byteLength(result) : result.length;
    if (kind === 'blocks') active.blockHashes.push(path.basename(file, '.json')); }
  return result;
};
fs.writeFileSync = (file, content, ...args) => { const kind = classify(file);
  if (active && kind) { active.writes[kind]++; active.writeBytes[kind] += typeof content === 'string' ? Buffer.byteLength(content) : content?.length || 0; }
  return rawWrite(file, content, ...args);
};
parentPort.on('message', (message) => {
  if (message?.type === 'operation') active = { type: 'storage', session: workerData.__qaSession, operation: message.operation, id: message.id,
    started: performance.now(), reads: { blocks: 0, snapshots: 0, metadata: 0 }, readBytes: { blocks: 0, snapshots: 0, metadata: 0 },
    writes: { blocks: 0, snapshots: 0, metadata: 0 }, writeBytes: { blocks: 0, snapshots: 0, metadata: 0 }, blockHashes: [] };
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...args) => {
  if (message?.type === 'result' && active) { active.durationMs = Math.round(performance.now() - active.started); delete active.started;
    active.failed = Boolean(message.error); rawAppend(workerData.__qaMetrics, JSON.stringify(active) + '\n'); active = undefined; }
  return post(message, ...args);
};
require(workerData.__qaOriginalEntry);
`);

fs.writeFileSync(appEntry, String.raw`
const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');
const threads = require('node:worker_threads');
const Module = require('node:module');
const qaRoot = __dirname;
const projectRoot = path.dirname(qaRoot);
const metrics = path.join(qaRoot, 'output', 'metrics.jsonl');
const sessionId = process.env.LIANHUA_STARTUP_QA_SESSION;
const record = (value) => fs.appendFileSync(metrics, JSON.stringify({ session: sessionId, ...value }) + '\n');
// Only this synthetic launch sees the module proxy. Construct hidden from the
// outset, suppress later show/focus calls, and retain rendering while hidden.
const NativeWindow = electron.BrowserWindow;
class HiddenWindow extends NativeWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); this.hide(); }
  show() { this.hide(); }
  showInactive() { this.hide(); }
  focus() {}
}
const hiddenElectron = Object.create(electron);
Object.defineProperty(hiddenElectron, 'BrowserWindow', { value: HiddenWindow, enumerable: true });
const loadModule = Module._load;
Module._load = function(request, parent, isMain) { return request === 'electron' ? hiddenElectron : loadModule.call(this, request, parent, isMain); };
record({ type: 'qa-process', pid: process.pid, parentPid: process.ppid, dataRoot: process.env.LIANHUA_DATA_DIR });
const NativeWorker = threads.Worker;
threads.Worker = class extends NativeWorker {
  constructor(file, options) {
    if (String(file).endsWith('statePersistenceWorker.cjs')) super(path.join(qaRoot, 'worker-probe.cjs'), { ...options,
      workerData: { ...options.workerData, __qaSession: sessionId, __qaMetrics: metrics, __qaOriginalEntry: String(file) } });
    else super(file, options);
  }
};
const handle = electron.ipcMain.handle.bind(electron.ipcMain);
const blocked = new Set(['lianhua:submit-video-task', 'lianhua:video-request', 'lianhua:rhtv-request', 'lianhua:rhtv-download',
  'lianhua:download-generated-media', 'lianhua:http-request', 'lianhua:download-image', 'lianhua:watch-video-progress']);
electron.ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (blocked.has(channel)) { record({ type: 'blocked-provider', channel, method: args[0]?.method || (channel.includes('submit') ? 'POST' : 'GET') });
    throw new Error('Synthetic startup QA blocks all provider calls'); }
  if (!/lianhua:(?:load|save|recovery|restore|create-restore|export|import)/u.test(channel)) return listener(event, ...args);
  const begin = performance.now(); const item = { type: 'ipc', channel, argumentBytes: typeof args[0] === 'string' ? Buffer.byteLength(args[0]) : 0 };
  if (channel === 'lianhua:save-state' && typeof args[0] === 'string') {
    const state = JSON.parse(args[0]); item.referenceMismatches = [];
    for (const entry of [state.project, ...(state.projects || [])]) {
      const ref = entry.__projectLibraryReference; if (!ref) continue;
      try {
        const summary = JSON.parse(fs.readFileSync(path.join(process.env.LIANHUA_DATA_DIR, 'project-library-index', ref.hash + '.' + ref.schemaVersion + '.json'), 'utf8'));
        for (const key of ['id', 'name', 'description', 'createdAt', 'updatedAt', 'backgroundSuspended']) {
          if (entry[key] !== undefined && entry[key] !== summary.summary[key]) item.referenceMismatches.push({ id: entry.id, key });
        }
        for (const key of Object.keys(summary.counts)) if (ref.counts?.[key] !== summary.counts[key]) item.referenceMismatches.push({ id: entry.id, key: 'counts.' + key });
      } catch { item.referenceMismatches.push({ id: entry.id, key: 'unrecognized-hash' }); }
    }
  }
  try { const result = await listener(event, ...args); item.durationMs = Math.round(performance.now() - begin);
    item.resultBytes = typeof result === 'string' ? Buffer.byteLength(result) : 0;
    if (channel === 'lianhua:load-workspace-state' && typeof result === 'string') {
      const state = JSON.parse(result); item.compact = { activeId: state.project.id, count: state.projects.length,
        referenceIds: state.projects.filter((p) => p.__projectLibraryReference).map((p) => p.id),
        fullIds: state.projects.filter((p) => !p.__projectLibraryReference && !p.__activeProjectReference).map((p) => p.id) };
    }
    record(item); return result;
  } catch (error) {
    item.failed = true; item.error = error.message; item.durationMs = Math.round(performance.now() - begin);
    if (channel === 'lianhua:save-state' && typeof args[0] === 'string') {
      item.syntheticPayloadFile = path.join(qaRoot, 'output', 'failed-save-' + sessionId + '-' + Date.now() + '.json');
      fs.writeFileSync(item.syntheticPayloadFile, args[0], { flag: 'wx' });
    }
    record(item); throw error;
  }
});
electron.app.setAppPath(projectRoot);
electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
  record({ type: 'blocked-network', method: details.method }); callback({ cancel: true });
}));
require(path.join(projectRoot, 'electron', 'main.cjs'));
`);

let app; let page; let harness; let failure; let launchNumber = 0;
const launch = async (expectedId) => {
  const session = String(++launchNumber); const begin = performance.now();
  const env = { ...process.env, LIANHUA_DATA_DIR: dataRoot, LIANHUA_QA_MODE: '1', LIANHUA_STARTUP_QA_SESSION: session,
    LIANHUA_QA_EXPORT_PATH: packageFile, LIANHUA_QA_IMPORT_PATH: packageFile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_START_URL', 'NODE_OPTIONS']) delete env[key];
  app = await electron.launch({ args: [appEntry], cwd: root, env, timeout: 35_000 });
  harness = createQaProcessHarness({ electron: app.process(), qaLabel: 'isolated large-library production startup', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('crash', () => report.errors.push('renderer crashed'));
  await page.evaluate(() => {
    const qa = window.__largeStartupQa = { frameGaps: [], longTasks: [], lastFrame: performance.now() };
    const frame = (now) => { qa.frameGaps.push(now - qa.lastFrame); qa.lastFrame = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    try { new PerformanceObserver((entries) => qa.longTasks.push(...entries.getEntries().map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration }))))
      .observe({ type: 'longtask', buffered: true }); } catch { /* engine without long-task entries still provides frame intervals */ }
  });
  await page.locator('.sidebar .nav-item').first().waitFor({ state: 'visible' });
  await page.locator('.sidebar').getByText(nameOf(expectedId), { exact: true }).waitFor();
  await page.locator('.project-loading-overlay').waitFor({ state: 'hidden' });
  assert.equal((await page.locator('.sidebar-version > span:last-child').innerText()).trim(), `v${version}`, 'The production build must match the current package');
  assert.match(page.url(), /^file:/u, 'The renderer must use built local production chunks');
  const actual = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
  assert.equal(path.resolve(actual).toLowerCase(), dataRoot.toLowerCase());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false, 'Synthetic QA must never display or focus a desktop window');
  const mainProcess = await app.evaluate(() => ({ pid: process.pid, parentPid: process.ppid }));
  const launched = { session, launcherPid: app.process().pid, mainPid: mainProcess.pid, parentPid: mainProcess.parentPid,
    processToReadyMs: Math.round(performance.now() - begin), activeId: expectedId, hiddenWindow: true };
  report.launches.push(launched);
  return launched;
};
const snapshotPerformance = async (entry) => {
  const stats = await page.evaluate(() => { const qa = window.__largeStartupQa; return { observedFrames: qa.frameGaps.length,
    maxFrameGapMs: Math.round(Math.max(0, ...qa.frameGaps)), longTasks: qa.longTasks.map((item) => ({ startMs: Math.round(item.startMs), durationMs: Math.round(item.durationMs) })) }; });
  Object.assign(entry, stats);
};
const close = async () => {
  if (!app) return;
  const child = app.process(); harness.markElectronStopping();
  const closing = app.waitForEvent('close', { timeout: 30_000 });
  await page.evaluate(() => { setTimeout(() => window.close(), 0); }); await closing;
  assert.equal(child.exitCode, 0); await harness.stopAll();
  app = null; page = null; harness = null;
};
const openLibrary = async () => {
  await page.locator('.topbar .top-action-library').click();
  await page.getByRole('dialog', { name: '项目库', exact: true }).waitFor();
};
const assertAuthored = (project) => {
  assert.equal(digest(project.sourceDocuments[1].content), expected.get(project.id).sourceHash, 'the complete archived source must survive lazy loading and saves');
  assert.equal(digest(project.storyboards[0].finalPrompt), expected.get(project.id).promptHash, 'the authored prompt must survive lazy loading and saves');
};
const screenshot = async (name) => { await page.screenshot({ path: path.join(output, name), fullPage: false }); report.screenshots.push(name); };

try {
  const first = await launch(activeId);
  // A bounded idle window detects the old startup autosave/restore-point path.
  await page.waitForTimeout(1400);
  const startup = readMetrics().filter((item) => item.session === first.session);
  const loads = startup.filter((item) => item.type === 'ipc' && item.compact);
  assert.equal(loads.length, 1, 'one compact workspace request must initialize the app');
  assert.equal(loads[0].compact.count, 100);
  assert.equal(loads[0].compact.referenceIds.length, 98);
  assert.ok(loads[0].compact.fullIds.includes(taskId), 'the archived unfinished-task project must remain available to background controllers');
  assert.equal(startup.filter((item) => item.type === 'ipc' && item.channel === 'lianhua:save-state').length, 0, 'unmodified startup must not save the entire library');
  assert.equal(startup.filter((item) => item.type === 'ipc' && item.channel === 'lianhua:create-restore-point').length, 0, 'unmodified startup must not create a recovery point');
  const startupStorage = startup.filter((item) => item.type === 'storage');
  assert.ok(startupStorage.length > 0, 'the I/O probe must observe the real persistence worker');
  assert.equal(startupStorage.reduce((sum, item) => sum + item.reads.snapshots, 0), 0, 'startup must not read all snapshot manifests or their project bodies');
  assert.ok(startupStorage.reduce((sum, item) => sum + item.reads.blocks, 0) <= 3, 'steady-state startup reads only the active and necessary task projects');
  assert.ok(fs.readFileSync(stateFile).equals(originalManifest), 'unmodified startup must preserve the manifest byte-for-byte');
  report.io.startup = startupStorage;
  checked('production startup returns 100 projects with 98 lightweight references, retains the unfinished-task archive, and does not autosave or scan recovery-point bodies');

  const listStarted = performance.now(); await openLibrary();
  assert.equal(await page.locator('.project-library-item').count(), 100);
  for (const id of [activeId, archiveId, taskId]) {
    const count = expected.get(id).counts;
    const text = await projectCard(page, id).locator('.project-library-meta').innerText();
    assert.match(text, new RegExp(`${count.sourceDocuments}\\s*篇剧情`));
    assert.match(text, new RegExp(`${count.scenes}\\s*个场景`));
    assert.match(text, new RegExp(`${count.storyboards}\\s*组分镜`));
  }
  report.timings.projectListMs = Math.round(performance.now() - listStarted);
  const layout = await page.locator('.project-library-modal').evaluate((element) => {
    const rect = element.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.top >= 0 && layout.bottom <= layout.height + 1);
  assert.ok(layout.scrollWidth <= layout.width + 1); report.libraryLayout = layout;
  await screenshot('01-hundred-project-library.png');
  await snapshotPerformance(first);
  checked('100 project rows show accurate source/scene/storyboard counts with the library dialog contained within the window');

  const switchedAt = performance.now();
  await projectCard(page, archiveId).locator('.project-library-select').click();
  await page.locator('.sidebar').getByText(nameOf(archiveId), { exact: true }).waitFor();
  await page.locator('.project-loading-overlay').waitFor({ state: 'hidden' });
  report.timings.lazyArchiveSwitchMs = Math.round(performance.now() - switchedAt);
  const lazyLoad = readMetrics().filter((item) => item.type === 'ipc' && item.channel === 'lianhua:load-project');
  assert.ok(lazyLoad.length >= 1, 'clicking a reference must request its project body');
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.locator('.story-source-textarea').waitFor();
  assert.equal(await page.locator('.story-source-textarea').inputValue(), '合成剧情。');
  const loadedArchive = await page.evaluate(async ({ id, hash }) => window.lianhuaDesktop.loadProject(id, hash), { id: archiveId, hash: originalPointers.get(archiveId) });
  assertAuthored(loadedArchive.project);
  await screenshot('02-lazy-loaded-archive.png');
  checked('a previously unopened 5.88 MiB archive loads on selection and retains its complete historical source and authored prompt');

  const beforeEdit = pointers();
  const editMetricStart = readMetrics().length;
  await page.locator('.story-input-card input').first().fill(changedChapterName);
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await waitForCondition({ label: 'single-project edit persisted', timeoutMs: 30_000, intervalMs: 120, check: () => {
    try { return manifest().project.id === archiveId && readProject(archiveId).sourceDocuments[0].name === changedChapterName; } catch { return false; }
  } });
  const afterEdit = pointers();
  for (const [id, hash] of beforeEdit) if (id !== archiveId) assert.equal(afterEdit.get(id), hash, `unchanged project ${id} keeps its immutable block`);
  assert.notEqual(afterEdit.get(archiveId), beforeEdit.get(archiveId));
  assertAuthored(readProject(archiveId));
  assert.deepEqual(readProject(taskId).generationTasks.map((task) => task.id), expectedTasks);
  const editStorage = readMetrics().slice(editMetricStart).filter((item) => item.type === 'storage');
  report.io.singleProjectEdit = editStorage;
  assert.ok(editStorage.filter((item) => item.operation === 'save').every((item) => new Set(item.blockHashes).size <= 4), 'saving one edited project must not reread every unrelated project body');
  checked('editing one chapter changes only its project hash; the other 99 project hashes and all unfinished/continuable task records remain intact');

  await page.locator('.topbar button[title="撤销（Ctrl+Z）"]').click();
  await waitForCondition({ label: 'undo of the lazy-loaded project edit persisted', timeoutMs: 30_000, intervalMs: 120, check: () => {
    try { return readProject(archiveId).sourceDocuments[0].name === chapterName; } catch { return false; }
  } });
  assertAuthored(readProject(archiveId));
  assert.deepEqual(readProject(taskId).generationTasks.map((task) => task.id), expectedTasks);
  await page.locator('.topbar button[title="重做（Ctrl+Y）"]').click();
  await waitForCondition({ label: 'redo of the lazy-loaded project edit persisted', timeoutMs: 30_000, intervalMs: 120, check: () => {
    try { return readProject(archiveId).sourceDocuments[0].name === changedChapterName; } catch { return false; }
  } });
  assertAuthored(readProject(archiveId));
  assert.deepEqual(readProject(taskId).generationTasks.map((task) => task.id), expectedTasks);
  checked('one undo/redo cycle retains the materialized archive and all background task records while restoring/reapplying the chapter edit');

  // Reject a forged compact pointer without permitting any durable replacement.
  const beforeForged = fs.readFileSync(stateFile);
  const rejected = await page.evaluate(async () => {
    const desktop = window.lianhuaDesktop; const raw = JSON.parse(await desktop.loadWorkspaceState());
    const reference = raw.projects.find((project) => project.__projectLibraryReference);
    reference.__projectLibraryReference.hash = 'f'.repeat(64);
    try { await desktop.saveState(JSON.stringify(raw)); return false; } catch { return true; }
  });
  assert.equal(rejected, true); assert.ok(fs.readFileSync(stateFile).equals(beforeForged));
  const recoveredSave = await page.evaluate(async () => {
    const desktop = window.lianhuaDesktop;
    return desktop.saveState(await desktop.loadWorkspaceState());
  });
  assert.equal(recoveredSave.ok, true, 'a valid save clears the deliberately injected persistence failure before export/import and normal close');
  checked('an unknown/tampered project reference is rejected without changing the manifest, and a subsequent valid save succeeds');

  await page.locator('.topbar').getByRole('button', { name: '导出项目', exact: true }).click();
  await waitForCondition({ label: 'complete active-project package', timeoutMs: 30_000, intervalMs: 100, check: () => fs.existsSync(packageFile) && fs.statSync(packageFile).size > 0 });
  const exported = await page.evaluate(async () => JSON.parse(await window.lianhuaDesktop.importProjectPackage(null)));
  assert.equal(exported.project.id, archiveId); assertAuthored(exported.project);
  assert.equal(exported.projects.filter((project) => project.id !== archiveId).length, 0);
  checked('the ordinary export button emits one complete current-project package, without mixing in compact references to other projects');
  await close();

  const second = await launch(archiveId);
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.locator('.story-source-textarea').waitFor();
  assert.equal(await page.locator('.story-input-card input').first().inputValue(), changedChapterName);
  assertAuthored(readProject(archiveId));
  assert.deepEqual(readProject(taskId).generationTasks.map((task) => task.id), expectedTasks);
  await snapshotPerformance(second); await screenshot('03-restarted-current-project.png');
  checked('normal window close/restart retains the edited current project, complete archived content, and the unfinished-task archive');

  // Real recovery uses a full validated snapshot; no synthetic shortcut API is
  // substituted. Full recovery is intentionally outside startup measurements.
  const restoreId = fs.readdirSync(snapshotsRoot).filter((name) => name.endsWith('.json') && name.includes('-qa')).sort()[0];
  const restored = await page.evaluate(async (id) => JSON.parse(await window.lianhuaDesktop.restoreSnapshot(id)), restoreId);
  assert.equal(restored.project.id, activeId);
  assert.equal(restored.projects.length, 100);
  assert.equal(restored.projects.some((project) => project.__projectLibraryReference), false);
  const restoredArchive = restored.projects.find((project) => project.id === archiveId);
  assertAuthored(restoredArchive); assert.equal(restoredArchive.sourceDocuments[0].name, chapterName);
  checked('an actual retained recovery point restores all 100 fully validated projects and the pre-edit chapter name');

  const allMetrics = readMetrics();
  const providerAttempts = allMetrics.filter((item) => item.type === 'blocked-provider');
  assert.equal(providerAttempts.filter((item) => item.method === 'POST' || item.channel.includes('submit')).length, 0, 'archived existing tasks must never be automatically submitted again');
  report.blockedProviderAttempts = providerAttempts;
  report.blockedNetworkAttempts = allMetrics.filter((item) => item.type === 'blocked-network');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  failure = error; report.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
} finally {
  if (app) {
    // Direct restore above changes durable state outside React. Do not close via
    // React's save callback afterward, which would intentionally save old UI.
    harness?.markElectronStopping();
    await Promise.race([app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2500))]);
    await harness?.stopAll().catch((error) => { failure ||= error; });
  }
  if (failure) report.passed = false;
  report.metricsFile = metricsFile;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(output, 'report.json'), timings: report.timings,
    launches: report.launches, checks: report.checks, failure: report.failure?.message }, null, 2));
}
if (failure) throw failure;
