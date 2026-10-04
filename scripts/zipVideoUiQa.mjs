import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Caller owns the persistent Playwright session. Real task-card and engine code,
// fake provider/download IPC, no credentials, media or production project writes.
export async function installZipVideoUiQa(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  page.setDefaultTimeout(7000);
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort());
  if (page.routeWebSocket) await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/__zip_video_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__zip_video_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { VideoTaskCard } = await import('/src/components/VideoDirectorView.tsx');
    const { VideoGenerationEngine } = await import('/src/videoGeneration.ts');
    const { createVideoRuntimeStore } = await import('/src/videoRuntimeStore.ts');
    const { createInitialState } = await import('/src/storage.ts');
    await import('/src/styles.css');
    const e = React.createElement, state = createInitialState(), store = createVideoRuntimeStore();
    state.project.id = 'zip-ui-project'; state.project.name = 'ZIP成片恢复隔离验收'; state.project.assets = [];
    const api = { enabled: true, provider: 'runninghub', model: '云端ZIP视频工作流', endpoint: 'https://cloud.invalid/openapi/v2/run/ai-app/130', statusEndpointTemplate: 'https://cloud.invalid/openapi/v2/query', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url' };
    const response = { status: 'SUCCESS', taskId: 'original-cloud-id', results: [{ outputType: 'zip', nodeId: '186', url: 'https://files.invalid/video.zip' }, { outputType: 'txt', nodeId: '187', url: 'https://files.invalid/prompt.txt' }] };
    const makeTask = (suffix) => ({ id: `zip-ui-${suffix}`, kind: 'video', storyboardId: '', targetId: '云端ZIP视频', status: 'failed', remoteTaskId: `original-cloud-${suffix}`, response: { ...response, taskId: `original-cloud-${suffix}` }, error: 'RunningHub 已完成，但旧版没有识别ZIP输出', createdAt: 1, updatedAt: 2, requestBody: {},
      videoJob: { stage: 'failed', message: '旧版本接收失败', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] }, snapshot: { projectId: state.project.id, clientId: `client-${suffix}`, images: [], connection: { backend: 'api', api }, draft: { name: suffix === 'single' ? '云端成功的旧ZIP任务' : 'ZIP包含两个视频', backend: 'api', prompt: '隔离视频提示词', references: [], parameters: {} } } } });
    state.project.generationTasks = [makeTask('single'), makeTask('multi')]; state.projects = [state.project]; state.activeProjectId = state.project.id;
    const qa = window.__zipVideoQa = { state, queries: [], downloads: [], persisted: 0, mode: 'single', errors: [], checkpoints: new Map(), pending: undefined };
    const media = (name) => ({ fileName: `${name}.mp4`, relativePath: `video/archive-qa/${name}.mp4`, checksum: `fixture-${name}`, sizeBytes: 2048, mediaType: 'video', mimeType: 'video/mp4', managed: true, missing: false, url: `https://files.invalid/${name}.mp4` });
    let update;
    const engine = new VideoGenerationEngine({ getState: () => qa.state, setState: (updater) => { qa.state = updater(qa.state); update?.(qa.state); }, persistState: async () => { qa.persisted += 1; }, onRuntime: (id, value) => store.update(id, value), onRemoveRuntime: (id) => store.remove(id), desktop: {
      videoRequest: async (request) => { qa.queries.push(request); if (!request.url.endsWith('/query')) throw new Error('QA禁止任何新生成请求'); const id = JSON.parse(request.body).taskId; return { status: 200, body: JSON.stringify({ ...response, taskId: id }) }; },
      downloadGeneratedMedia: async (request) => { qa.downloads.push(request); if (qa.mode === 'failure') throw new Error('ZIP下载失败：HTTP 403，隔离过期模拟'); if (qa.mode === 'hold') await new Promise((resolve) => { qa.pending = resolve; }); return { ...media(qa.mode === 'multi' ? '版本A' : '成片'), archiveFileName: '云端输出.zip', ...(qa.mode === 'multi' ? { additionalVideos: [media('版本B')] } : {}) }; },
      cancelVideoRequest: async () => true, onVideoProgress: () => () => {}, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
      setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => '',
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; }, getVideoTaskCheckpoint: async (id) => qa.checkpoints.get(id) || null,
    } });
    qa.engine = engine; qa.dispose = () => { engine.dispose(); store.dispose(); };
    function Harness() { const [current, setState] = React.useState(state); update = setState; return e('main', { className: 'app-shell', style: { display: 'block', minHeight: '100dvh', padding: 18, '--ui-font-scale': 1 } }, e('h1', null, '视频任务 · ZIP结果恢复'), current.project.generationTasks.map((task) => e(VideoTaskCard, { key: task.id, task, assets: current.project.assets, runtimeStore: store, onRecoverResult: (id) => engine.recoverResult(id), onRetryDownload: (id) => engine.retryDownload(id), onSelectResultVideo: (id, assetId) => engine.selectResultVideo(id, assetId), onCancel: (id) => engine.cancel(id) }))); }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  });
  await page.locator('[data-video-task-id="zip-ui-single"]').waitFor();
}

export async function runZipVideoUiQa(page, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const first = page.locator('[data-video-task-id="zip-ui-single"]');
  const second = page.locator('[data-video-task-id="zip-ui-multi"]');
  assert.match(await first.innerText(), /云端已成功，待取回成片/u);
  await page.screenshot({ path: path.join(outputDirectory, 'old-failed-zip.png'), scale: 'css', animations: 'disabled' });
  await first.getByRole('button', { name: '重新获取成片（不重新生成）', exact: true }).click();
  await page.waitForFunction(() => window.__zipVideoQa.state.project.generationTasks[0].resultAssetId);
  assert.match(await first.innerText(), /已完成/u);
  await page.evaluate(() => { window.__zipVideoQa.mode = 'multi'; });
  await second.getByRole('button', { name: '重新获取成片（不重新生成）', exact: true }).click();
  await page.waitForFunction(() => window.__zipVideoQa.state.project.generationTasks[1].videoJob.resultSelectionRequired === true);
  assert.equal(await second.getByRole('button', { name: '用作本任务成片', exact: true }).count(), 2);
  assert.equal(await page.locator('video').count(), 0, 'task recovery remains a static-thumbnail UI');
  const layouts = [];
  for (const size of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(size);
    await second.scrollIntoViewIfNeeded();
    layouts.push(await second.locator('.vd-result-selection').evaluate((node) => ({ scrolls: node.scrollWidth > node.clientWidth + 1,
      buttons: [...node.querySelectorAll('button')].map((button) => { const b = button.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return Boolean(hit && (button === hit || button.contains(hit))); }) })));
    await page.screenshot({ path: path.join(outputDirectory, `multiple-${size.width}.png`), scale: 'css', animations: 'disabled' });
  }
  await second.getByRole('button', { name: '用作本任务成片', exact: true }).nth(1).click();
  await page.waitForFunction(() => Boolean(window.__zipVideoQa.state.project.generationTasks[1].resultAssetId) && !window.__zipVideoQa.state.project.generationTasks[1].videoJob.resultSelectionRequired);
  const evidence = await page.evaluate(() => { const q = window.__zipVideoQa; const t = q.state.project.generationTasks[1]; return { requests: q.queries.length, downloads: q.downloads.length, allowArchive: q.downloads.every((d) => d.allowVideoArchive === true), assets: q.state.project.assets.length, selected: q.state.project.assets.find((a) => a.id === t.resultAssetId)?.fileName }; });
  assert.equal(evidence.downloads, 2); assert.equal(evidence.assets, 3); assert.equal(evidence.selected, '版本B.mp4'); assert.equal(evidence.allowArchive, true);
  assert.ok(layouts.every((row) => !row.scrolls && row.buttons.every(Boolean)));
  return { ...evidence, layouts };
}
