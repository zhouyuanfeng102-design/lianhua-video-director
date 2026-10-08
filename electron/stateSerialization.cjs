const { createHash } = require('node:crypto');

// There is no aggregate library quota. The durable store partitions projects
// and externalizes inline media before committing its small library index.
const MAX_STATE_BYTES = Number.POSITIVE_INFINITY;
const stateChecksum = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

const validateStateSize = (content) => {
  if (typeof content !== 'string' || !content.trim()) throw new Error('项目状态为空');
  const stateBytes = Buffer.byteLength(content, 'utf8');
  if (stateBytes > MAX_STATE_BYTES) throw new Error(`项目状态大小为 ${(stateBytes / 1024 / 1024).toFixed(1)} MiB，超过 ${MAX_STATE_BYTES / 1024 / 1024} MiB 本地保存上限。请先导出不常用项目备份，再按需整理项目库；现有文件和素材未被删除`);
  return stateBytes;
};

const validateStateText = (content, { allowLibraryManifest = false } = {}) => {
  validateStateSize(content);
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('项目状态 JSON 格式无效，现有文件未修改'); }
  if (!parsed || typeof parsed !== 'object' || !parsed.project || !parsed.settings) throw new Error('项目状态结构无效');
  if (parsed.storageFormat && !allowLibraryManifest) {
    throw new Error('这是分项目存储索引，请连同项目目录通过兼容版本读取；不能将索引当作完整项目导入');
  }
  if (parsed.integrity?.algorithm === 'sha256' && typeof parsed.integrity.checksum === 'string') {
    const { integrity, ...state } = parsed;
    if (stateChecksum(JSON.stringify(state)) !== integrity.checksum) throw new Error('项目状态完整性校验失败');
  }
  return parsed;
};

const SECRET_LIST_KEYS = ['apiCredentialBook', 'textApiProfiles', 'visionApiProfiles', 'imageApiProfiles', 'videoApiProfiles'];
const SECRET_CURRENT_KEYS = ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo'];

// Only settings contain credentials. Copy those small records rather than
// JSON-cloning the entire project library (which can be hundreds of MiB).
const stripSecrets = (state) => {
  const clone = { ...state, settings: { ...state.settings } };
  const clear = (value) => value && typeof value === 'object' && 'apiKey' in value ? { ...value, apiKey: '' } : value;
  for (const key of SECRET_CURRENT_KEYS) {
    if (key in clone.settings) clone.settings[key] = clear(clone.settings[key]);
  }
  for (const key of SECRET_LIST_KEYS) {
    if (key in clone.settings) clone.settings[key] = (clone.settings[key] || []).map(clear);
  }
  return clone;
};

const collectSecrets = (state) => ({
  current: {
    text: state.settings?.textApi?.apiKey || '', vision: state.settings?.visionApi?.apiKey || '',
    image: state.settings?.imageApi?.apiKey || '', video: state.settings?.videoTaskApi?.apiKey || '',
    comfyuiVideo: state.settings?.comfyuiVideo?.apiKey || '',
    runningHubVideo: state.settings?.runningHubVideo?.apiKey || '',
  },
  credentials: Object.fromEntries((state.settings?.apiCredentialBook || []).map((item) => [item.id, item.apiKey || ''])),
  textProfiles: Object.fromEntries((state.settings?.textApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  visionProfiles: Object.fromEntries((state.settings?.visionApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  imageProfiles: Object.fromEntries((state.settings?.imageApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  videoProfiles: Object.fromEntries((state.settings?.videoApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
});

const secretCount = (secrets) => Object.values(secrets.current || {}).filter(Boolean).length
  + ['credentials', 'textProfiles', 'visionProfiles', 'imageProfiles', 'videoProfiles']
    .reduce((sum, key) => sum + Object.values(secrets[key] || {}).filter(Boolean).length, 0);

const hydrateStateSecrets = (state, secrets) => {
  if (!secrets) return state;
  for (const [key, secretKey] of [['textApi', 'text'], ['visionApi', 'vision'], ['imageApi', 'image'], ['videoTaskApi', 'video'], ['comfyuiVideo', 'comfyuiVideo'], ['runningHubVideo', 'runningHubVideo']]) {
    if (state.settings?.[key]) state.settings[key].apiKey = secrets.current?.[secretKey] || state.settings[key].apiKey || '';
  }
  for (const [key, vaultKey] of [['apiCredentialBook', 'credentials'], ['textApiProfiles', 'textProfiles'], ['visionApiProfiles', 'visionProfiles'], ['imageApiProfiles', 'imageProfiles'], ['videoApiProfiles', 'videoProfiles']]) {
    (state.settings?.[key] || []).forEach((item) => { item.apiKey = secrets[vaultKey]?.[item.id] || item.apiKey || ''; });
  }
  // The on-disk, secret-free checksum was verified before hydration. It no
  // longer describes this in-memory credential-bearing envelope; never return
  // a stale checksum that prevents a subsequent save/export from validating.
  delete state.integrity;
  return state;
};

const prepareStateForSave = (content, savedAt = Date.now()) => {
  const state = validateStateText(content);
  const secrets = collectSecrets(state);
  const protectedState = stripSecrets(state);
  // A loaded envelope may already have integrity. It is not part of the next
  // state checksum; retaining it would make the replacement unreadable.
  delete protectedState.integrity;
  const serialized = JSON.stringify(protectedState);
  const integrity = { algorithm: 'sha256', checksum: stateChecksum(serialized), savedAt };
  // The object has just been validated/serialized. Appending its own generated
  // envelope avoids another full stringify + parse + stringify of the library.
  const payload = `${serialized.slice(0, -1)},"integrity":${JSON.stringify(integrity)}}`;
  validateStateSize(payload);
  return { payload, state: protectedState, secrets, checksum: stateChecksum(payload) };
};

const stateAssets = (state) => {
  const activeId = state?.activeProjectId || state?.project?.id;
  const projects = [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])]
    .filter(Boolean).sort((left, right) => ((left?.id === activeId ? -1 : 0) - (right?.id === activeId ? -1 : 0)));
  const seenPaths = new Set();
  const assets = [];
  for (const project of projects) {
    for (const asset of project?.assets || []) {
      if (!asset?.relativePath || seenPaths.has(asset.relativePath)) continue;
      seenPaths.add(asset.relativePath);
      assets.push(asset);
    }
  }
  return assets;
};

const normalizeRecoveryConfig = (raw) => ({
  backupDirectory: typeof raw?.backupDirectory === 'string' ? raw.backupDirectory : '',
  backupOnSave: raw?.backupOnSave !== false,
  allowPrivateNetwork: raw?.allowPrivateNetwork === true,
  keepCount: Number.isFinite(raw?.keepCount) ? Math.max(3, Math.min(100, raw.keepCount)) : 20,
});

module.exports = { MAX_STATE_BYTES, stateChecksum, validateStateSize, validateStateText, stripSecrets,
  collectSecrets, secretCount, hydrateStateSecrets, prepareStateForSave, stateAssets, normalizeRecoveryConfig };
