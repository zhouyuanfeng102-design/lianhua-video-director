import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// The caller owns the persistent Playwright session. This module never starts
// a browser, accesses real API credentials, or submits a generation request.
// User-provided sample paths are read-only; media and state written by the real
// backend stay inside a fresh temporary directory and never become fixtures.
const root = path.resolve(import.meta.dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const require = createRequire(mainPath);
const runtimeProcess = require('node:process');
const { updateCrc32 } = require('./videoArchive.cjs');
const { createVideoTaskCheckpointJournal } = require('./videoTaskCheckpoint.cjs');
const BRIDGE = '__runningHubMultiOutputQaBridge';
const TASK_ID = 'multi-output-recovery-qa';
export const QA_INVENTORY = [
  'Old succeeded-but-unsaved task: click recover, try the first ZIP then the real video ZIP, show completed without a generation POST.',
  'Actual media: preserve original MP4 bytes, video dimensions, duration and AAC; persist the winning URL in task, asset and checkpoint.',
  'Controls and layout: recovery action and snapshot details remain visible; task stays thumbnail-only at 1120/1280 widths and 100/130% fonts.',
  'Off-happy-path coverage: first ZIP contains no video; explicit output filter must not escape to another node; cancellation/stale callbacks are covered by engine regression tests.',
];
const hashFile = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const inside = (parent, target) => {
  const relative = path.relative(parent, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const summarizeProbe = (probe) => ({
  durationSec: Number(probe.format?.duration),
  streams: probe.streams.map(({ codec_type, codec_name, width, height }) => ({ codec_type, codec_name, width, height })),
});
const probeFile = (filePath) => summarizeProbe(JSON.parse(execFileSync(
  path.join(root, 'build', 'media-tools', 'win32-x64', 'ffprobe.exe'),
  ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
)));

function textOnlyZip() {
  const name = Buffer.from('debug/manifest.txt');
  const bytes = Buffer.from('QA debug output; no generated video in this first archive.');
  const crc = updateCrc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x31e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

function loadProductionBackend(directory) {
  const paths = {};
  const electron = {
    app: { getPath: (name) => paths[name] || path.join(directory, name), setPath: (name, value) => { paths[name] = value; }, setAppLogsPath() {} },
    BrowserWindow: class {}, dialog: {}, ipcMain: {}, net: {}, shell: {},
    protocol: { registerSchemesAsPrivileged() {} }, safeStorage: { isEncryptionAvailable: () => false },
  };
  const context = vm.createContext({
    AbortController, Buffer, URL, Response, console, setTimeout, clearTimeout,
    process: { argv: ['node', mainPath], env: { ...runtimeProcess.env, LIANHUA_DATA_DIR: path.join(directory, 'data'), LIANHUA_ALLOW_PRIVATE_NETWORK: '1' }, execPath: runtimeProcess.execPath, platform: runtimeProcess.platform, pid: runtimeProcess.pid },
    require: (specifier) => specifier === 'electron' ? electron : require(specifier), __dirname: path.dirname(mainPath), __filename: mainPath,
  });
  const source = fs.readFileSync(mainPath, 'utf8');
  const boundary = source.indexOf("if (process.platform === 'win32')");
  assert.ok(boundary > 0, 'Stop before actual Electron application bootstrap');
  vm.runInContext(`${source.slice(0, boundary)}\n;globalThis.harness={downloadIntoAssetStore,atomicWriteFile,assetRoot,tempRoot};`, context);
  return context.harness;
}

export async function createRunningHubMultiOutputUiQa({ archivePath, videoPath }) {
  const inputArchive = fs.realpathSync(archivePath);
  const inputVideo = fs.realpathSync(videoPath);
  assert.ok(fs.statSync(inputArchive).isFile() && fs.statSync(inputVideo).isFile());
  const initialHashes = { archive: hashFile(inputArchive), video: hashFile(inputVideo) };
  const originalProbe = probeFile(inputVideo);
  assert.ok(originalProbe.streams.some((stream) => stream.codec_type === 'video'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-multi-output-ui-'));
  const directoryReal = fs.realpathSync(directory);
  let backend, journal, server, address, closed = false;
  const activeDownloads = new Map();
  const metrics = { downloads: [], queries: 0, generationAttempts: 0, served: [], checkpoints: 0, saves: 0, results: [], failures: [] };
  const debugZip = textOnlyZip();
  const originalFilesUnchanged = () => {
    assert.deepEqual({ archive: hashFile(inputArchive), video: hashFile(inputVideo) }, initialHashes, 'Original sample files must remain unchanged');
    return true;
  };
  const cleanup = async () => {
    if (closed) return { originalFilesUnchanged: originalFilesUnchanged(), isolatedTemporaryFilesRemoved: true };
    closed = true;
    for (const { controller } of activeDownloads.values()) controller.abort();
    await Promise.allSettled([...activeDownloads.values()].map(({ pending }) => pending));
    if (server?.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    const unchanged = originalFilesUnchanged();
    assert.equal(fs.realpathSync(directory), directoryReal);
    assert.equal(path.dirname(directoryReal), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directoryReal).startsWith('lianhua-multi-output-ui-'));
    assert.equal(inside(directoryReal, inputArchive), false);
    assert.equal(inside(directoryReal, inputVideo), false);
    fs.rmSync(directoryReal, { recursive: true, force: true });
    return { originalFilesUnchanged: unchanged, isolatedTemporaryFilesRemoved: true };
  };
  try {
    backend = loadProductionBackend(directory);
    journal = createVideoTaskCheckpointJournal({ directory: path.join(directory, 'journal'), atomicWriteFile: backend.atomicWriteFile });
    server = http.createServer((request, response) => {
      const label = request.url === '/qa-first.zip' ? 'first-debug-zip' : request.url === '/qa-video.zip' ? 'second-video-zip' : request.url === '/qa-text.txt' ? 'third-text' : 'unexpected';
      metrics.served.push(label);
      if (request.method !== 'GET' || label === 'unexpected') { response.writeHead(404); response.end(); return; }
      if (label === 'second-video-zip') {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(fs.statSync(inputArchive).size) });
        const stream = fs.createReadStream(inputArchive);
        stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
      } else {
        const bytes = label === 'first-debug-zip' ? debugZip : Buffer.from('QA non-video text output.');
        response.writeHead(200, { 'Content-Type': label === 'first-debug-zip' ? 'application/zip' : 'text/plain', 'Content-Length': String(bytes.length) }); response.end(bytes);
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    address = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await cleanup(); throw error; }

  const response = { status: 'SUCCESS', taskId: 'qa-existing-cloud-task', results: [
    { nodeId: 'debug-node', outputType: 'zip', url: `${address}/qa-first.zip` },
    { nodeId: 'video-node', outputType: 'zip', url: `${address}/qa-video.zip` },
    { nodeId: 'text-node', outputType: 'txt', url: `${address}/qa-text.txt` },
  ] };
  const handleBridge = async ({ method, payload }) => {
    assert.equal(closed, false, 'QA fixture is already closed');
    if (method === 'request') {
      if (payload.url !== `${address}/provider/query`) { metrics.generationAttempts += 1; throw new Error('QA禁止发起任何新生成请求'); }
      metrics.queries += 1;
      assert.equal(JSON.parse(payload.body).taskId, response.taskId, 'Only the original fake task can be queried');
      return { status: 200, body: JSON.stringify(response) };
    }
    if (method === 'download') {
      const outputIndex = response.results.findIndex((entry) => entry.url === payload.url);
      assert.ok(outputIndex === 0 || outputIndex === 1, 'Only the two declared ZIP candidates may be downloaded');
      assert.equal(payload.allowVideoArchive, true);
      metrics.downloads.push(outputIndex + 1);
      const controller = new AbortController();
      const pending = backend.downloadIntoAssetStore(payload.url, payload.headers || {}, { ...payload, signal: controller.signal });
      activeDownloads.set(payload.requestId, { controller, pending });
      try {
        const result = await pending;
        metrics.results.push(result);
        return result;
      } catch (error) { metrics.failures.push({ outputIndex: outputIndex + 1, message: error.message }); throw error; }
      finally { activeDownloads.delete(payload.requestId); }
    }
    if (method === 'checkpointSave') { metrics.checkpoints += 1; return journal.save(payload); }
    if (method === 'checkpointGet') return journal.get(payload);
    if (method === 'persist') {
      metrics.saves += 1;
      backend.atomicWriteFile(path.join(directory, 'isolated-project.json'), JSON.stringify(payload));
      return true;
    }
    if (method === 'cancel') { activeDownloads.get(payload)?.controller.abort(); return true; }
    throw new Error('Unknown isolated QA operation');
  };

  return {
    taskId: TASK_ID, response,
    api: { enabled: true, provider: 'runninghub', model: '隔离多输出工作流', endpoint: `${address}/provider/run`, statusEndpointTemplate: `${address}/provider/query`, authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url', runningHubOutputNodeIds: [] },
    handleBridge, cleanup, originalFilesUnchanged,
    diagnostics: () => ({ downloads: metrics.downloads.slice(), queries: metrics.queries, generationAttempts: metrics.generationAttempts, failures: metrics.failures.length }),
    verify: (renderer) => {
      assert.deepEqual(metrics.downloads, [1, 2]);
      assert.deepEqual(metrics.served, ['first-debug-zip', 'second-video-zip']);
      assert.equal(metrics.generationAttempts, 0); assert.equal(metrics.queries, 0);
      assert.equal(metrics.results.length, 1); assert.equal(metrics.failures.length, 1);
      assert.match(metrics.failures[0].message, /ZIP/u);
      const result = metrics.results[0];
      const savedPath = path.join(backend.assetRoot, result.relativePath);
      assert.ok(inside(backend.assetRoot, fs.realpathSync(savedPath)));
      const resultHash = hashFile(savedPath);
      assert.equal(resultHash, initialHashes.video); assert.equal(result.checksum, resultHash);
      const probe = probeFile(savedPath); assert.deepEqual(probe, originalProbe);
      assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'), 'The real recovered sample retains its AAC audio');
      assert.equal(renderer.status, 'succeeded'); assert.equal(renderer.resultUrl, response.results[1].url);
      assert.equal(renderer.assetResultUrl, response.results[1].url); assert.equal(renderer.checksum, initialHashes.video);
      assert.equal(renderer.taskCount, 1); assert.equal(renderer.assetCount, 1); assert.equal(renderer.downloadError, undefined);
      const checkpoint = journal.get(TASK_ID);
      assert.equal(checkpoint.resultUrl, response.results[1].url); assert.equal(checkpoint.resultAssetId, renderer.resultAssetId);
      const savedProject = JSON.parse(fs.readFileSync(path.join(directory, 'isolated-project.json'), 'utf8'));
      assert.equal(savedProject.project.generationTasks[0].resultUrl, response.results[1].url);
      assert.equal(savedProject.project.assets[0].videoSourceTask.resultUrl, response.results[1].url);
      return {
        downloads: metrics.downloads.slice(), served: metrics.served.slice(), queries: metrics.queries, generationRequests: metrics.generationAttempts,
        savedVideoCount: metrics.results.length, persistedProjectWrites: metrics.saves, checkpointWrites: metrics.checkpoints,
        recoveredFileMatchesOriginal: true, taskAssetJournalUseSecondOutput: true, probe, originalFilesUnchanged: originalFilesUnchanged(),
      };
    },
  };
}

export async function setupRunningHubMultiOutputUiQa(page, baseUrl, fixture) {
  const origin = new URL(baseUrl).origin;
  page.setDefaultTimeout(15_000);
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort());
  if (page.routeWebSocket) await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.exposeFunction(BRIDGE, fixture.handleBridge);
  await page.route('**/__runninghub_multi_output_fixture.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>',
  }));
  await page.goto(`${origin}/__runninghub_multi_output_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ api, response, taskId, bridgeName }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { VideoTaskCard } = await import('/src/components/VideoDirectorView.tsx');
    const { VideoGenerationEngine } = await import('/src/videoGeneration.ts');
    const { createVideoRuntimeStore } = await import('/src/videoRuntimeStore.ts');
    const { createInitialState } = await import('/src/storage.ts');
    await import('/src/styles.css');
    const e = React.createElement, state = createInitialState(), runtimeStore = createVideoRuntimeStore();
    state.project.id = 'multi-output-isolated-project'; state.project.name = '云端多输出成片恢复验收'; state.project.assets = [];
    const task = {
      id: taskId, kind: 'video', storyboardId: '', targetId: '隔离云端工作流', status: 'succeeded', remoteTaskId: response.taskId,
      response, resultUrl: response.results[0].url, createdAt: 1, updatedAt: 2, requestBody: {},
      videoJob: {
        stage: 'succeeded', message: '生成成功，保存失败；重试只保存，不重复生成',
        downloadError: '云端 ZIP 已接收，但其中没有可用的 MP4、MOV 或 WebM 视频',
        preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
        snapshot: { projectId: state.project.id, clientId: 'multi-output-isolated-client', images: [], connection: { backend: 'api', api },
          draft: { name: '隔离恢复成片', backend: 'api', prompt: '隔离QA视频提示词', references: [], parameters: {} } },
      },
    };
    state.project.generationTasks = [task]; state.projects = [state.project]; state.activeProjectId = state.project.id;
    const bridge = (method, payload) => window[bridgeName]({ method, payload });
    await bridge('checkpointSave', task);
    const qa = window.__runningHubMultiOutputUiQa = { state, completedActions: 0, errors: [] };
    let update;
    const engine = new VideoGenerationEngine({
      getState: () => qa.state, setState: (updater) => { qa.state = updater(qa.state); update?.(qa.state); },
      persistState: async () => { await bridge('persist', qa.state); },
      onRuntime: (id, value) => runtimeStore.update(id, value), onRemoveRuntime: (id) => runtimeStore.remove(id),
      desktop: {
        videoRequest: (request) => bridge('request', request), downloadGeneratedMedia: (request) => bridge('download', request),
        cancelVideoRequest: (requestId) => bridge('cancel', requestId),
        onVideoProgress: () => () => {}, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
        setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => '',
        saveVideoTaskCheckpoint: (value) => bridge('checkpointSave', value), getVideoTaskCheckpoint: (id) => bridge('checkpointGet', id),
      },
    });
    qa.engine = engine;
    const recover = async (id) => {
      try { await engine.recoverResult(id); } catch (error) { qa.errors.push(error.message); }
      finally { qa.completedActions += 1; }
    };
    function Harness() {
      const [current, setCurrent] = React.useState(state); update = setCurrent;
      return e('main', { className: 'app-shell', style: { display: 'block', minHeight: '100dvh', padding: 18, '--ui-font-scale': 1 } },
        e('h1', null, '视频任务 · 多输出成片恢复'),
        e('p', null, '隔离验收：调试ZIP在前，视频ZIP在后。只获取原任务成片，不重新生成。'),
        ...current.project.generationTasks.map((item) => e(VideoTaskCard, {
          key: item.id, task: item, assets: current.project.assets, runtimeStore,
          onRecoverResult: recover, onRetryDownload: (id) => engine.retryDownload(id), onCancel: (id) => engine.cancel(id),
        })),
      );
    }
    const reactRoot = ReactDOM.createRoot(document.getElementById('root'));
    reactRoot.render(e(Harness)); qa.dispose = () => { engine.dispose(); runtimeStore.dispose(); reactRoot.unmount(); };
  }, { api: fixture.api, response: fixture.response, taskId: fixture.taskId, bridgeName: BRIDGE });
  await page.locator(`[data-video-task-id="${fixture.taskId}"]`).waitFor();
}

export async function runRunningHubMultiOutputUiQa(page, fixture, outputDirectory) {
  const output = outputDirectory && path.resolve(outputDirectory);
  if (output) {
    assert.ok(inside(path.join(root, 'output'), output), 'Screenshots and aggregate QA reports must stay in workspace/output');
    fs.mkdirSync(output, { recursive: true });
    assert.ok(inside(fs.realpathSync(path.join(root, 'output')), fs.realpathSync(output)));
  }
  const card = page.locator(`[data-video-task-id="${fixture.taskId}"]`);
  assert.match(await card.innerText(), /生成成功，保存失败/u);
  if (output) await page.screenshot({ path: path.join(output, 'before-recovery.png'), scale: 'css', animations: 'disabled' });
  await card.getByRole('button', { name: '重新获取成片（不重新生成）', exact: true }).click();
  await page.waitForFunction(() => window.__runningHubMultiOutputUiQa.completedActions === 1, null, { timeout: 60_000 });
  const renderer = await page.evaluate(() => {
    const qa = window.__runningHubMultiOutputUiQa, task = qa.state.project.generationTasks[0];
    const asset = qa.state.project.assets.find((item) => item.id === task.resultAssetId);
    return { status: task.status, resultUrl: task.resultUrl, resultAssetId: task.resultAssetId, assetResultUrl: asset?.videoSourceTask?.resultUrl,
      checksum: asset?.checksum, taskCount: qa.state.project.generationTasks.length, assetCount: qa.state.project.assets.length,
      downloadError: task.videoJob.downloadError, errors: qa.errors.slice() };
  });
  assert.equal(renderer.errors.length, 0, JSON.stringify(renderer.errors));
  const report = fixture.verify(renderer);
  assert.match(await card.innerText(), /已完成/u);
  assert.doesNotMatch(await card.innerText(), /没有可用的 MP4/u);
  assert.equal(await page.locator('video').count(), 0, 'The task card remains static and does not decode the real sample');
  report.layouts = [];
  for (const size of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(size);
    for (const scale of [1, 1.3]) {
      await page.locator('main').evaluate((element, value) => element.style.setProperty('--ui-font-scale', String(value)), scale);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { horizontallyFits: element.scrollWidth <= element.clientWidth + 1, withinViewport: rect.left >= 0 && rect.right <= innerWidth + 1 };
      });
      assert.ok(geometry.horizontallyFits && geometry.withinViewport);
      report.layouts.push({ ...size, fontScale: scale, ...geometry });
      if (output) await page.screenshot({ path: path.join(output, `recovered-${size.width}-${Math.round(scale * 100)}.png`), scale: 'css', animations: 'disabled' });
    }
  }
  if (output) fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export async function cleanupRunningHubMultiOutputUiQa(page, fixture) {
  try {
    if (page && !page.isClosed()) await page.evaluate(() => window.__runningHubMultiOutputUiQa?.dispose?.());
  } finally { return await fixture.cleanup(); }
}
