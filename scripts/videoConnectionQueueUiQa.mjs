import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

// This mounts only the production controls/card in a fresh browser context.
// The engine is used solely to derive its queue presentation from synthetic
// state; start/reconcile/resume, provider bridges and the real App are absent.
export async function installVideoConnectionQueueFixture(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const blockedRequests = [];
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin && ['GET', 'HEAD'].includes(request.method()) || ['data:', 'blob:'].includes(url.protocol)) {
      await route.continue(); return;
    }
    blockedRequests.push({ origin: url.origin, method: request.method() }); await route.abort('blockedbyclient');
  });
  await page.routeWebSocket(/.*/u, (socket) => {
    const url = new URL(socket.url()); const local = new URL(origin);
    if (url.hostname === local.hostname && url.port === local.port) socket.connectToServer();
    else { blockedRequests.push({ origin: url.origin, method: 'WEBSOCKET' }); socket.close(); }
  });
  await page.route('**/__video_connection_queue_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__video_connection_queue_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { VideoExecutionControls } = await import('/src/components/VideoExecutionControls.tsx');
    const { VideoTaskCard } = await import('/src/components/VideoDirectorView.tsx');
    const { VideoGenerationEngine } = await import('/src/videoGeneration.ts');
    const { createVideoRuntimeStore } = await import('/src/videoRuntimeStore.ts');
    const { createInitialState } = await import('/src/storage.ts');
    await import('/src/styles.css');
    const e = React.createElement; const now = Date.now();
    let state = createInitialState();
    Object.assign(state.settings, { videoExecutionMode: 'concurrent', videoExecutionConcurrency: 2 });
    const connection = { backend: 'api', api: { enabled: false, provider: 'runninghub', runningHubAppId: 'fixture-app', model: '隔离云端工作流',
      endpoint: 'https://queue-ui-fixture.invalid/task/openapi/create?token=qa-never-a-real-url-secret',
      statusEndpointTemplate: 'https://queue-ui-fixture.invalid/task/openapi/status',
      authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'url' } };
    const makeTask = (id, name, projectId, stopped = false) => ({
      id, kind: 'video', storyboardId: '', targetId: 'qa-cloud', status: 'running', remoteTaskId: `remote-${id}`,
      requestBody: {}, createdAt: now - 30_000, updatedAt: now - 5_000,
      videoJob: { stage: stopped ? 'stopped' : 'running', trackingStopped: stopped,
        preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
        snapshot: { projectId, clientId: `client-${id}`, images: [], connection: structuredClone(connection),
          draft: { name, backend: 'api', prompt: `qa-private-prompt-${id}`, references: [], parameters: {} } } },
    });
    const first = makeTask('cloud-busy-one', '山路旧任务一', 'qa-previous-a', true);
    const second = makeTask('cloud-busy-two', '市集旧任务二 · City market old task two - original queue checkpoint', 'qa-previous-b');
    const target = makeTask('cloud-awaiting', '山门外青石长阶 · 第1段 · English', 'qa-active');
    Object.assign(target, { status: 'draft', remoteTaskId: undefined, batchId: 'qa-chain', batchIndex: 1, batchTotal: 7, createdAt: now });
    Object.assign(target.videoJob, { stage: 'queued', trackingStopped: false, batchQueueState: 'ready', preparation: { version: 1, phase: 'preparing', uploadedImages: [] } });
    target.videoJob.snapshot.batchCompletionOrder = true;
    const comfy = Array.from({ length: 7 }, (_, index) => {
      const task = makeTask(`comfy-old-${index}`, `不相关本地旧任务${index + 1}`, 'qa-local', true);
      task.videoJob.snapshot.connection = { backend: 'comfyui', comfyui: { enabled: false, baseUrl: 'http://127.0.0.1:65501' } };
      task.videoJob.snapshot.draft.backend = 'comfyui'; return task;
    });
    const makeProject = (id, name, tasks) => ({ ...structuredClone(state.project), id, name,
      assets: [], storyboards: [], sequencePlans: [], characters: [], scenes: [], generationTasks: tasks });
    state.project = makeProject('qa-active', '当前长剧情项目', [target]);
    state.activeProjectId = state.project.id;
    state.projects = [state.project, makeProject('qa-previous-a', '此前项目甲', [first]),
      makeProject('qa-previous-b', '此前项目乙', [second]), makeProject('qa-local', '不相关本地项目', comfy)];
    const qa = window.__videoConnectionQueueQa = { changes: [], actions: [], apiCalls: 0, originalRemote: JSON.stringify([first, second, ...comfy]) };
    const runtimeStore = createVideoRuntimeStore();
    const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
      onRuntime: (id, runtime) => runtimeStore.update(id, runtime) });
    // The synthetic local row represents a journal already checked by the
    // scheduler. No checkpoint IO is permitted by this display-only fixture.
    engine.restoredCheckpoints.add(target.id);
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const currentTask = () => state.project.generationTasks.find((task) => task.id === target.id);
    const refresh = () => {
      // Deliberately invoke presentation only. Calling the actual admission or
      // dispatch path belongs to the separate queue safety suite, never this UI.
      engine.markLocallyQueued(currentTask());
      root.render(e('main', { className: 'video-director', style: { margin: '16px', maxWidth: '1200px' } },
        e('h1', null, '连接队列隔离验收'),
        e(VideoExecutionControls, { settings: state.settings, onChange: (patch) => {
          qa.changes.push(structuredClone(patch)); state.settings = { ...state.settings, ...patch }; refresh();
        } }),
        e(VideoTaskCard, { task: currentTask(), assets: [], runtimeStore,
          onResume: (id) => qa.actions.push(['resume', id]), onCancel: (id) => qa.actions.push(['cancel', id]),
          onReuse: (task) => qa.actions.push(['reuse', task.id]) })));
    };
    qa.inspect = () => ({ task: structuredClone(currentTask()), settings: { mode: state.settings.videoExecutionMode, count: state.settings.videoExecutionConcurrency },
      remote: JSON.stringify(state.projects.filter((project) => project.id !== state.project.id).flatMap((project) => project.generationTasks)),
      actions: [...qa.actions], changes: [...qa.changes], apiCalls: qa.apiCalls, storageLength: localStorage.length });
    qa.dispose = () => { root.unmount(); engine.dispose(); runtimeStore.dispose(); };
    refresh();
  });
  await page.locator('[data-video-task-id="cloud-awaiting"] .vd-task-message').waitFor();
  return { blockedRequests };
}

export async function runVideoConnectionQueueUiAssertions(page, outputDirectory) {
  const screenshots = []; const layouts = []; const checks = [];
  const card = page.locator('[data-video-task-id="cloud-awaiting"]');
  const message = card.locator('.vd-task-message').first();
  const text = await message.innerText();
  assert.match(text, /RunningHub/u, 'queue message identifies the constrained connection');
  for (const label of ['此前项目甲', '山路旧任务一', '此前项目乙', '市集旧任务二']) assert.ok(text.includes(label), `queue blockers should be locatable: ${label}`);
  assert.ok(text.includes('City market old task two - original queue checkpoint'), 'English blocker titles stay readable instead of being reduced to a tail number');
  assert.doesNotMatch(text, /不相关本地|comfy-old|127\.0\.0\.1|qa-never-a-real-url-secret|qa-private-prompt/u, 'other backends, credentials and private prompts must not appear in the blockers');
  assert.match(text, /尚未提交|尚未发送/u, 'unsubmitted status remains explicit');
  const controls = page.locator('.video-execution-controls');
  assert.match(await controls.innerText(), /同一连接/u);
  assert.match(await controls.innerText(), /不同连接/u);
  assert.match(await controls.locator('.video-execution-limit').innerText(), /连接.*2/u);
  assert.equal(await card.getByRole('button', { name: '恢复查询原任务', exact: true }).count(), 0, 'a local waiting row cannot query a nonexistent remote id');
  assert.equal(await card.getByRole('button', { name: '载入相同设置再次生成', exact: true }).count(), 0, 'a queued chain member cannot create a replacement paid task');
  checks.push('same-connection-project-and-task-blockers-visible-without-unrelated-backends');

  await page.getByLabel('视频并发数量', { exact: true }).fill('3');
  await page.waitForFunction(() => window.__videoConnectionQueueQa.inspect().settings.count === 3);
  assert.match(await controls.locator('.video-execution-limit').innerText(), /连接.*3/u);
  await page.getByLabel('视频执行方式', { exact: true }).selectOption('queue');
  assert.equal(await page.getByLabel('视频并发数量', { exact: true }).isDisabled(), true);
  assert.match(await controls.locator('.video-execution-limit').innerText(), /同一连接/u);
  await page.getByLabel('视频执行方式', { exact: true }).selectOption('concurrent');
  await page.getByLabel('视频并发数量', { exact: true }).fill('2');
  await card.locator('summary').click();
  assert.match(await card.locator('.vd-prompt-preview').innerText(), /qa-private-prompt-cloud-awaiting/u, 'the original prompt remains available only in its explicit snapshot');
  await card.locator('summary').click();
  checks.push('controls-and-snapshot-only-inspection-never-dispatch-or-recover-tasks');

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1150, height: 760 }, { width: 1120, height: 760 }]) {
    await page.setViewportSize(viewport);
    const layout = await message.evaluate((node) => {
      const rect = node.getBoundingClientRect(); const owner = node.closest('article');
      return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        messageLeft: rect.left, messageRight: rect.right, messageWidth: node.clientWidth, messageScrollWidth: node.scrollWidth,
        cardWidth: owner.clientWidth, cardScrollWidth: owner.scrollWidth };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1, 'page must not overflow horizontally');
    assert.ok(layout.messageLeft >= 0 && layout.messageRight <= layout.viewportWidth, 'connection blockers fit viewport');
    assert.ok(layout.messageScrollWidth <= layout.messageWidth + 1 && layout.cardScrollWidth <= layout.cardWidth + 1, 'long blocker metadata wraps in card');
    layouts.push({ viewport, ...layout });
    const fileName = `connection-queue-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(outputDirectory, fileName), fullPage: true }); screenshots.push(fileName);
  }
  const state = await page.evaluate(() => window.__videoConnectionQueueQa.inspect());
  assert.deepEqual(state.actions, []); assert.equal(state.apiCalls, 0); assert.equal(state.storageLength, 0);
  assert.equal(state.remote, await page.evaluate(() => window.__videoConnectionQueueQa.originalRemote), 'display must not query, cancel, mark finished or modify existing remote records');
  assert.equal(state.task.remoteTaskId, undefined); assert.equal(state.task.videoJob.preparation.phase, 'preparing');
  checks.push('small-window-blocker-summary-wraps-and-all-original-remote-records-remain-unchanged');
  return { passed: true, checks, queueMessage: text, screenshots, layouts };
}

export async function runStandaloneVideoConnectionQueueUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..');
  const outputDirectory = path.join(root, 'output', 'playwright', `video-connection-queue-${Date.now()}`);
  await fs.mkdir(outputDirectory, { recursive: true });
  const port = await findAvailableTcpPort();
  const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } }); let browser;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); const errors = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    const { blockedRequests } = await installVideoConnectionQueueFixture(page, `http://127.0.0.1:${address.port}`);
    const report = await runVideoConnectionQueueUiAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no real provider request attempted');
    await page.evaluate(() => window.__videoConnectionQueueQa.dispose());
    const result = { ...report, errors, blockedRequests, outputDirectory };
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(result, null, 2)); return result;
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause) }, null, 2));
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true });
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneVideoConnectionQueueUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
