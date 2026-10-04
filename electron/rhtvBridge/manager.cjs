const { Worker } = require('node:worker_threads');
const path = require('node:path');

function createRhTvManager(options) {
  const { downloadResult, ...workerOptions } = options;
  let worker;
  let sequence = 0;
  let stopping;
  let manuallyStopped = false;
  const pending = new Map();
  const downloads = new Map();
  const stopped = () => ({ running: false, browser: '浏览器未启动', automatic_submission: false, jobs: [], message: 'rhTV 桥接未启动' });
  function ensure() {
    if (stopping) throw new Error('rhTV 桥接正在关闭');
    if (worker) return worker;
    const instance = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: workerOptions }); worker = instance;
    const rejectAll = (message) => {
      if (worker === instance) worker = undefined;
      for (const [id, entry] of pending) if (entry.worker === instance) { clearTimeout(entry.timer); entry.reject(new Error(message)); pending.delete(id); }
      for (const [id, entry] of downloads) if (entry.worker === instance) { entry.controller.abort(); downloads.delete(id); }
    };
    instance.on('message', ({ id, result, error, type, payload }) => {
      if (type === 'cancel-download') { downloads.get(id)?.controller.abort(); return; }
      if (type === 'download') {
        if (downloads.has(id)) return;
        const controller = new AbortController();
        downloads.set(id, { worker: instance, controller });
        void Promise.resolve().then(() => {
          if (!downloadResult || stopping) throw new Error('自动下载器不可用或桥接正在停止');
          return downloadResult({ ...payload, signal: controller.signal });
        }).then((file) => instance.postMessage({ type: 'download-result', id, file }),
          () => instance.postMessage({ type: 'download-result', id, error: '原成片下载失败，请检查网络并重试下载' }))
          .catch(() => {}).finally(() => downloads.delete(id));
        return;
      }
      const entry = pending.get(id); if (!entry || entry.worker !== instance) return;
      pending.delete(id); clearTimeout(entry.timer); if (error) entry.reject(new Error(error)); else entry.resolve(result);
    });
    instance.on('error', (error) => rejectAll(`rhTV 桥接中断：${error.message}；任务不会自动重投`));
    instance.on('exit', () => rejectAll('rhTV 桥接已退出；任务保留，可恢复原任务查询'));
    return instance;
  }
  function call(action, payload = {}) {
    if (!worker && action === 'status') return Promise.resolve(stopped());
    if (action === 'start' || action === 'login') manuallyStopped = false;
    if (manuallyStopped) return Promise.reject(new Error('rhTV 桥接已停止，请先在视频 API 中启动桥接；没有重新提交任务'));
    const instance = ensure(); const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('rhTV 操作超时，原任务可能仍在处理；请检查状态，不要重新提交')); }, 180000);
      timer.unref(); pending.set(id, { resolve, reject, timer, worker: instance }); instance.postMessage({ id, action, payload });
    });
  }
  return {
    call,
    close() {
      if (stopping) return stopping;
      if (!worker) { manuallyStopped = true; return Promise.resolve(stopped()); }
      const instance = worker;
      stopping = call('stop').finally(async () => { await instance.terminate(); if (worker === instance) worker = undefined; stopping = undefined; });
      manuallyStopped = true;
      return stopping.then(stopped);
    },
  };
}
module.exports = { createRhTvManager };
