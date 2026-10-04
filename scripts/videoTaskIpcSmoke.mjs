import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const configuredDataDirectory = String(process.env.LIANHUA_DATA_DIR || '').trim();
if (!configuredDataDirectory) throw new Error('LIANHUA_DATA_DIR is required');
const dataDirectory = path.resolve(configuredDataDirectory);
const cdpPort = Number(process.env.CDP_PORT || 9231);
const apiPort = Number(process.env.MOCK_API_PORT || 9240);
const outputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-video-task');
fs.mkdirSync(outputDirectory, { recursive: true });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);

let submitCount = 0;
let statusCount = 0;
let lastSubmitBody = null;
const media = Buffer.from('lianhua-generated-video-result');
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${apiPort}`);
  if (request.method === 'POST' && url.pathname === '/tasks') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      submitCount += 1;
      lastSubmitBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      response.setHeader('Content-Type', 'application/json');
      if (submitCount === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: 'retry this request' } }));
      } else {
        response.end(JSON.stringify({ data: { task: { id: 'mock-job-1', state: 'queued' } } }));
      }
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/tasks/mock-job-1') {
    statusCount += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(statusCount === 1
      ? { data: { task: { id: 'mock-job-1', state: 'processing' } } }
      : { data: { task: { id: 'mock-job-1', state: 'completed' }, output: { video: { url: `http://127.0.0.1:${apiPort}/media/mock-job-1.mp4` } } } }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/media/mock-job-1.mp4') {
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('Content-Length', String(media.length));
    response.end(media);
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(apiPort, '127.0.0.1', resolve); });

let socket;
try {
  let target;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(connectionTimeoutMs),
      }).then((response) => response.json());
      target = targets.find((item) => item.type === 'page');
      if (target) break;
    } catch { /* Electron may still be starting. */ }
    await delay(250);
  }
  if (!target) throw new Error('Electron debugging target did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
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
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    globalThis.clearTimeout?.(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
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
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'undefined' && socket.readyState !== WebSocket.OPEN) {
      reject(new Error('CDP socket is not open'));
      return;
    }
    const commandId = ++id;
    const timer = globalThis.setTimeout?.(() => {
      pending.delete(commandId);
      reject(new Error(`CDP command timed out: ${method}`));
    }, commandTimeoutMs);
    pending.set(commandId, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id: commandId, method, params }));
    } catch (error) {
      globalThis.clearTimeout?.(timer);
      pending.delete(commandId);
      reject(error);
    }
  });
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Evaluation failed');
    return response.result.value;
  };
  await command('Runtime.enable').catch((error) => {
    failPending(error);
    socket.close();
    throw error;
  });
  try {
  const result = await evaluate(`(async () => {
    const endpoint = 'http://127.0.0.1:${apiPort}/tasks';
    const bridge = window.lianhuaDesktop;
    await bridge.updateRecoveryConfig({ allowPrivateNetwork: true });
    try {
      const first = await bridge.submitVideoTask({ endpoint, method: 'POST', body: { prompt: 'canonical prompt', client: { retry: 0 } } });
      const second = await bridge.submitVideoTask({ endpoint, method: 'POST', body: { prompt: 'canonical prompt', client: { retry: 1 } } });
      const running = await bridge.submitVideoTask({ endpoint: endpoint + '/mock-job-1', method: 'GET' });
      const succeeded = await bridge.submitVideoTask({ endpoint: endpoint + '/mock-job-1', method: 'GET' });
      const downloaded = await bridge.downloadGeneratedMedia({
        url: succeeded.body.data.output.video.url,
        fileName: 'IPC 视频：第 1 段',
      });
      return { first, second, running, succeeded, downloaded };
    } finally {
      await bridge.updateRecoveryConfig({ allowPrivateNetwork: false });
    }
  })()`);
  const blockedAfterReset = await evaluate(`(async () => {
    try { await window.lianhuaDesktop.submitVideoTask({ endpoint: 'http://127.0.0.1:${apiPort}/tasks', method: 'POST', body: {} }); return false; }
    catch { return true; }
  })()`);
  const report = {
    firstFailed: result.first.status === 503,
    retrySucceeded: result.second.status === 200 && result.second.body?.data?.task?.id === 'mock-job-1',
    requestMapped: lastSubmitBody?.prompt === 'canonical prompt' && lastSubmitBody?.client?.retry === 1,
    runningMapped: result.running.body?.data?.task?.state === 'processing',
    resultMapped: result.succeeded.body?.data?.output?.video?.url?.endsWith('/media/mock-job-1.mp4'),
    downloadedManaged: Boolean(result.downloaded?.managed && result.downloaded?.relativePath && result.downloaded?.checksum),
    downloadedReadableName: result.downloaded?.fileName === 'IPC 视频：第 1 段.mp4'
      && result.downloaded?.relativePath === 'video/IPC 视频：第 1 段.mp4',
    downloadedExists: Boolean(result.downloaded?.relativePath && fs.existsSync(path.join(dataDirectory, 'assets', result.downloaded.relativePath))),
    blockedAfterReset,
    submitCount,
    statusCount,
  };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  const failed = Object.entries(report).filter(([key, value]) => !['submitCount', 'statusCount'].includes(key) && !value).map(([key]) => key);
  if (failed.length || submitCount !== 2 || statusCount !== 2) throw new Error(`Video task IPC smoke failed: ${failed.join(', ')}\n${JSON.stringify(report, null, 2)}`);
  console.log(JSON.stringify(report, null, 2));
  } finally {
    failPending('video task smoke finished');
    socket.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
