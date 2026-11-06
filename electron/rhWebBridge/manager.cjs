const { Worker } = require('node:worker_threads');
const path = require('node:path');

function createRhWebManager(options) {
  let worker;
  let sequence = 0;
  let stopping;
  const pending = new Map();
  const stopped = () => ({ running: false, message: 'RH 网页窗口未打开' });
  function ensure() {
    if (stopping) throw new Error('RH 网页窗口正在关闭');
    if (worker) return worker;
    const instance = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: options });
    worker = instance;
    const rejectAll = (message) => {
      if (worker === instance) worker = undefined;
      for (const [id, entry] of pending) {
        if (entry.worker !== instance) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error(message));
        pending.delete(id);
      }
    };
    instance.on('message', ({ id, result, error }) => {
      const entry = pending.get(id);
      if (!entry || entry.worker !== instance) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    });
    instance.on('error', (error) => rejectAll(`RH 网页窗口中断：${error.message}`));
    instance.on('exit', () => rejectAll('RH 网页窗口已退出'));
    return instance;
  }
  function call(action, payload = {}) {
    if (!worker && action === 'status') return Promise.resolve(stopped());
    const instance = ensure();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('RH 网页操作超时。已点过运行的任务不会再点一次。'));
      }, action === 'request' ? 600000 : 180000);
      timer.unref();
      pending.set(id, { resolve, reject, timer, worker: instance });
      instance.postMessage({ id, action, payload });
    });
  }
  return {
    call,
    close() {
      if (stopping) return stopping;
      if (!worker) return Promise.resolve(stopped());
      const instance = worker;
      stopping = call('close').finally(async () => {
        await instance.terminate();
        if (worker === instance) worker = undefined;
        stopping = undefined;
      });
      return stopping.then(stopped);
    },
  };
}

module.exports = { createRhWebManager };
