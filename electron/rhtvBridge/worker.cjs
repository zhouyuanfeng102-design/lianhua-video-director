const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { createRhTvService, ORIGIN } = require('./service.cjs');
const { createRhTvBrowser } = require('./browser.cjs');
const { createVideoWorkbench } = require('../videoWorkbench.cjs');
const { acquireBridgeLock } = require('./lock.cjs');
const { randomUUID } = require('node:crypto');
const downloads = new Map();
function downloadResult({ signal, ...payload }) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => { parentPort.postMessage({ type: 'cancel-download', id }); finish(new Error('下载跟踪已停止')); };
    const finish = (error, file) => { downloads.delete(id); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(file); };
    downloads.set(id, finish);
    if (signal.aborted) { finish(new Error('下载跟踪已停止')); return; }
    signal.addEventListener('abort', abort, { once: true });
    parentPort.postMessage({ type: 'download', id, payload });
  });
}
const browser = createRhTvBrowser({ root: workerData.root });
const media = createVideoWorkbench({ assetRoot: path.join(workerData.root, 'results'), tempRoot: path.join(workerData.root, 'media-temp'),
  projectRoot: workerData.projectRoot, resourcesPath: workerData.resourcesPath });
let releaseLock;
const ready = acquireBridgeLock(workerData.root).then((release) => {
  releaseLock = release;
  return createRhTvService({ root: workerData.root, browser, downloadResult, validateResult: (source) => media.probe(source) });
});
void ready.catch(() => {});
parentPort.on('message', async ({ id, action, payload, type, file, error }) => {
  if (type === 'download-result') { downloads.get(id)?.(error ? new Error(error) : undefined, file); return; }
  try {
    if (action === 'stop') {
      const service = await ready.catch(() => undefined);
      try { await service?.close(); } finally { media.close(); await releaseLock?.(); releaseLock = undefined; }
      parentPort.postMessage({ id, result: { stopped: true } });
      return;
    }
    const service = await ready;
    let result;
    if (action === 'status') result = service.status();
    else if (action === 'start') result = await service.start();
    else if (action === 'login') { await service.start(); await browser.login(); result = service.status(); }
    else if (action === 'automation') { await service.start(); result = service.automation(payload.enabled); }
    else if (action === 'retry') { result = await service.retry(payload.jobId); }
    else if (action === 'prepare' || action === 'handoff') { await service.prepare(payload.jobId); result = service.status(); }
    else if (action === 'cancel') { service.cancel(payload.jobId); result = service.status(); }
    else if (action === 'materials') result = service.materials(payload.jobId);
    else if (action === 'confirm-not-submitted') { await service.confirmNotSubmitted(payload.jobId); result = service.status(); }
    else if (action === 'confirm-ended') { await service.confirmEnded(payload.jobId); result = service.status(); }
    else if (action === 'import-result') { await service.importResult(payload.jobId, payload.path); result = service.status(); }
    else if (action === 'result-file') {
      const url = new URL(payload.url);
      const match = url.pathname.match(/^\/v1\/videos\/([a-f0-9-]{36})\/content$/);
      if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password || !match) throw new Error('结果地址不属于原 rhTV 任务');
      result = await service.resultFile(match[1]);
    } else if (action === 'request') {
      await service.start();
      const url = new URL(payload.url);
      if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) throw new Error('只接受受管 rhTV 本机请求');
      let body = payload.body;
      if (payload.multipart) {
        if (url.pathname !== '/v1/assets' || payload.multipart.files?.length !== 1 || payload.body != null) throw new Error('图片上传格式无效');
        body = { data_url: payload.multipart.files[0].dataUrl };
      }
      try {
        const data = await service.dispatch(payload.method || 'GET', url.pathname, body);
        result = { status: 200, body: JSON.stringify(data) };
      } catch (error) { result = { status: error.status || 500, body: JSON.stringify({ message: error.message }) }; }
    }
    else throw new Error('不支持的 rhTV 桥接操作');
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
