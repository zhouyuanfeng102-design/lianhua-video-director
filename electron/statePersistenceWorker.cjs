const { parentPort, workerData } = require('node:worker_threads');
const { createStateStore } = require('./statePersistenceStore.cjs');

if (!parentPort || workerData?.kind !== 'lianhua-state-persistence') throw new Error('状态保存线程启动参数无效');
const store = createStateStore({ dataRoot: workerData.dataRoot });
const credentialWaiters = new Map();
let activeId;
const errorDetails = (error) => ({ message: error instanceof Error ? error.message : String(error), code: error?.code });

parentPort.on('message', async (message) => {
  if (message?.type === 'credential-result') {
    const waiter = credentialWaiters.get(message.id);
    if (!waiter) return;
    credentialWaiters.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.value);
    return;
  }
  if (message?.type !== 'operation') return;
  const { id, operation, payload } = message;
  if (activeId !== undefined) {
    parentPort.postMessage({ type: 'result', id, error: { message: '状态保存线程收到并发操作，已拒绝乱序写入' } });
    return;
  }
  activeId = id;
  try {
    // Reconcile an interrupted state/vault pair before main is asked to
    // decrypt credentials. Never hydrate old endpoint settings with new keys.
    store.recoverVaultTransaction();
    const credentials = (type, secrets) => new Promise((resolve, reject) => {
      credentialWaiters.set(id, { resolve, reject });
      parentPort.postMessage({ type, id, secrets });
    });
    let value;
    switch (operation) {
      case 'save':
        value = await store.save(payload.content, (secrets) => credentials('encrypt-secrets', secrets));
        break;
      case 'load': value = store.load(await credentials('load-secrets')); break;
      case 'status': value = store.recoveryStatus(); break;
      case 'restore-point': value = store.createRestorePoint(payload.content); break;
      case 'restore': value = store.restoreSnapshot(payload.snapshotId, await credentials('load-secrets')); break;
      case 'backup': value = store.backup(payload.content); break;
      default: throw new Error('未知状态保存操作');
    }
    parentPort.postMessage({ type: 'result', id, value });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, error: errorDetails(error) });
  } finally { activeId = undefined; }
});
