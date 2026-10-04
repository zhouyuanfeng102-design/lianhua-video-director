const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');

// A kernel-owned pipe releases on worker exit, including abnormal termination.
async function acquireBridgeLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const real = fs.realpathSync(root);
  const key = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex');
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\lianhua-rhtv-${key}` : path.join(real, 'bridge.sock');
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`rhTV 数据目录正在被另一实例使用或无法锁定（${error.code}）；未接收任务`)));
    server.listen(address, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}

module.exports = { acquireBridgeLock };
