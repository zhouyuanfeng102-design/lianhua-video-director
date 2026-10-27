const path = require('node:path');
const { Worker } = require('node:worker_threads');

const STATE_PERSISTENCE_OPERATION_TIMEOUT_MS = 30_000;

const createStatePersistence = ({ dataRoot, encryptSecrets, loadSecrets = () => null, keepAlive = true, operationTimeoutMs = STATE_PERSISTENCE_OPERATION_TIMEOUT_MS, workerFactory = (file, options) => new Worker(file, options) }) => {
  const pinnedRoot = path.resolve(dataRoot);
  let worker;
  let active;
  let sequence = 0;
  let pendingCount = 0;
  let queue = Promise.resolve();
  let closing = false;
  let closed = false;
  let discarded = false;
  let lastSaveError;
  const unpackError = (details) => Object.assign(new Error(details?.message || '状态保存线程意外停止，项目保存未确认'), { code: details?.code });
  const failWorker = (instance, error, terminate = true) => {
    if (worker !== instance) return;
    worker = undefined;
    const operation = active;
    active = undefined;
    if (operation?.timer) clearTimeout(operation.timer);
    const stopped = terminate ? Promise.resolve().then(() => instance.terminate()).catch(() => {}) : Promise.resolve();
    void stopped.then(() => operation?.reject(unpackError(error)));
  };
  const ensureWorker = () => {
    if (worker) return worker;
    const instance = workerFactory(path.join(__dirname, 'statePersistenceWorker.cjs'), {
      workerData: { kind: 'lianhua-state-persistence', dataRoot: pinnedRoot },
      // A large state should not inherit tiny parent worker heap overrides.
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    worker = instance;
    instance.on('message', (message) => {
      if (worker !== instance || !active || message?.id !== active.id) return;
      if (message.type === 'encrypt-secrets' || message.type === 'load-secrets') {
        Promise.resolve().then(() => message.type === 'encrypt-secrets' ? encryptSecrets(message.secrets) : loadSecrets()).then((value) => {
          if (worker === instance && active?.id === message.id) instance.postMessage({ type: 'credential-result', id: message.id, value });
        }, (error) => {
          if (worker === instance && active?.id === message.id) instance.postMessage({ type: 'credential-result', id: message.id, error: { message: error instanceof Error ? error.message : String(error), code: error?.code } });
        }).catch((error) => failWorker(instance, error));
        return;
      }
      if (message.type !== 'result') return;
      const operation = active;
      active = undefined;
      if (operation.timer) clearTimeout(operation.timer);
      instance.unref();
      if (message.error) operation.reject(unpackError(message.error));
      else operation.resolve(message.value);
    });
    instance.on('error', (error) => failWorker(instance, error));
    instance.on('exit', (code) => {
      if (worker !== instance) return;
      failWorker(instance, new Error(`状态保存线程已退出（${code}），本次保存未确认；请重试保存`), false);
    });
    instance.unref();
    return instance;
  };
  const run = (operation, payload = {}) => {
    if (closed || closing) return Promise.reject(new Error('应用正在关闭，请等待本地保存完成'));
    pendingCount += 1;
    // Exactly one dispatched operation at a time. Do not coalesce explicit
    // persistence barriers or allow restore/load to overtake an earlier save.
    const result = queue.then(() => new Promise((resolve, reject) => {
      try {
        if (discarded) throw new Error('状态保存已中断');
        const instance = ensureWorker();
        const id = ++sequence;
        const timer = setTimeout(() => {
          if (worker !== instance || active?.id !== id) return;
          failWorker(instance, Object.assign(new Error('本地保存线程响应超时，本次保存结果未确认；请检查项目状态后重试。'), { code: 'STATE_PERSISTENCE_TIMEOUT' }));
        }, operationTimeoutMs);
        timer.unref?.();
        active = { id, resolve, reject, timer };
        if (keepAlive) instance.ref();
        else instance.unref();
        instance.postMessage({ type: 'operation', id, operation, payload });
      } catch (error) {
        if (active?.resolve === resolve) {
          if (active.timer) clearTimeout(active.timer);
          active = undefined;
        }
        worker?.unref();
        reject(error);
      }
    }));
    const tracked = result.then((value) => {
      if (operation === 'save' || operation === 'restore') lastSaveError = undefined;
      return value;
    }, (error) => {
      if (operation === 'save' || operation === 'restore') lastSaveError = error;
      throw error;
    }).finally(() => { pendingCount -= 1; });
    queue = tracked.catch(() => {});
    return tracked;
  };
  const flush = async () => {
    // Also include writes enqueued while an earlier operation was completing.
    let barrier;
    do { barrier = queue; await barrier; } while (barrier !== queue);
    if (lastSaveError) throw lastSaveError;
  };
  const close = async () => {
    if (closed) return;
    closing = true;
    try { await flush(); }
    catch (error) { closing = false; throw error; }
    const instance = worker;
    worker = undefined;
    if (instance) await instance.terminate();
    closed = true;
  };
  // Explicit discard is only for isolated-test cleanup or a user's confirmed
  // exit after a reported save failure. Ordinary quit always calls close().
  const discard = async () => {
    closing = true;
    discarded = true;
    const instance = worker;
    worker = undefined;
    if (active?.timer) clearTimeout(active.timer);
    active?.reject(new Error('状态保存已中断'));
    active = undefined;
    if (instance) await instance.terminate();
    await queue;
    closed = true;
  };
  return { run, flush, close, discard, get pendingCount() { return pendingCount; }, get lastSaveError() { return lastSaveError; } };
};

module.exports = { createStatePersistence };
