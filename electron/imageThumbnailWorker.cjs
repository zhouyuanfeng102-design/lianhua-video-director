const { parentPort, workerData } = require('node:worker_threads');
const { decodeThumbnail } = require('./imageThumbnail.cjs');

const jobs = new Map();
let closing = false;
const closeWhenIdle = () => { if (closing && !jobs.size) parentPort.close(); };
const suspend = (error) => {
  closing = true;
  parentPort.postMessage({ type: 'suspended', message: error.message });
  for (const job of jobs.values()) job.stop?.();
};

parentPort.on('message', (message) => {
  if (message.type === 'cancel') {
    const job = jobs.get(message.id);
    if (job) { job.cancelled = true; job.stop?.(); }
    return;
  }
  if (message.type === 'close') {
    closing = true;
    for (const job of jobs.values()) { job.cancelled = true; job.stop?.(); }
    closeWhenIdle();
    return;
  }
  if (message.type !== 'decode' || closing) return;
  const job = { cancelled: false };
  jobs.set(message.id, job);
  const options = { ...workerData, onChildSpawn: (pid) => parentPort.postMessage({ type: 'started', id: message.id, pid }) };
  decodeThumbnail(message.filePath, options, suspend, job).then((bytes) => {
    const transferable = new Uint8Array(bytes);
    parentPort.postMessage({ id: message.id, bytes: transferable.buffer }, [transferable.buffer]);
  }, (error) => {
    parentPort.postMessage({ id: message.id, error: { name: error.name, message: error.message } });
  }).finally(() => { jobs.delete(message.id); closeWhenIdle(); });
});
