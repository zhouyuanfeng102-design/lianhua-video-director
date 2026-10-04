const fs = require('node:fs');

// Kept outside project JSON/snapshots/packages. A task retains the credential
// it was submitted with even after the user's current API profile changes.
const createVideoTaskCredentialVault = ({ filePath, safeStorage, atomicWriteFile }) => {
  const memory = new Map();
  let loaded = false;
  const taskKey = (value) => {
    const key = String(value || '').trim();
    if (!key || key.length > 200 || /[\r\n\u0000]/u.test(key)) throw new Error('视频任务标识无效');
    return key;
  };
  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(filePath)) return;
    try {
      const records = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
      for (const [key, value] of Object.entries(records || {})) {
        if (typeof value === 'string' && value) memory.set(taskKey(key), value);
      }
    } catch {
      // Do not replace an unreadable vault with a partial set of credentials.
      loaded = false;
      throw new Error('无法读取视频任务的加密凭据；原凭据文件已保留');
    }
  };
  const persist = () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    atomicWriteFile(filePath, safeStorage.encryptString(JSON.stringify(Object.fromEntries(memory))));
    return true;
  };
  return {
    set({ taskId, apiKey } = {}) {
      const key = taskKey(taskId);
      if (typeof apiKey !== 'string' || apiKey.length > 16_384) throw new Error('视频任务凭据格式无效');
      load();
      if (apiKey) memory.set(key, apiKey); else memory.delete(key);
      return { persisted: persist() };
    },
    get(taskId) { load(); return memory.get(taskKey(taskId)) || null; },
    delete(taskId) {
      load();
      const deleted = memory.delete(taskKey(taskId));
      if (deleted) persist();
      return deleted;
    },
  };
};

module.exports = { createVideoTaskCredentialVault };
