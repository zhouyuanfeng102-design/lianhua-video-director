const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, safeStorage, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const nodeHttp = require('http');
const nodeHttps = require('https');
const nodeNet = require('net');
const { fileURLToPath, pathToFileURL } = require('url');
const {
  buildImageEditMultipart,
  readManagedImageDataUrl,
} = require('./imageReferenceTransport.cjs');
const { resolveSystemProxy, createProxyTunnelAgent, MODEL_CONNECT_TIMEOUT_MS } = require('./systemProxyTransport.cjs');
const { createVideoTransport } = require(path.join(__dirname, 'videoTransport.cjs'));
const { createRhTvManager } = require(path.join(__dirname, 'rhtvBridge/manager.cjs'));
const { importVideoArchive, hasZipSignature, isZipContentType } = require(path.join(__dirname, 'videoArchive.cjs'));
const { createVideoTaskCredentialVault } = require(path.join(__dirname, 'videoTaskCredentialVault.cjs'));
const { createVideoTaskCheckpointJournal, collectVideoFrozenAssets } = require(path.join(__dirname, 'videoTaskCheckpoint.cjs'));
const { collectImageReferenceSnapshotsForExport } = require(path.join(__dirname, 'imageReferenceSnapshots.cjs'));
const { isCompleteWebP } = require(path.join(__dirname, 'webpValidation.cjs'));
const { createVideoWorkbench } = require(path.join(__dirname, 'videoWorkbench.cjs'));
const { createVideoThumbnailService } = require(path.join(__dirname, 'videoThumbnail.cjs'));
const stateSerialization = require(path.join(__dirname, 'stateSerialization.cjs'));
const { createStatePersistence } = require(path.join(__dirname, 'statePersistence.cjs'));
const { createStateCloseGuard } = require(path.join(__dirname, 'stateCloseGuard.cjs'));
const { createRendererCrashRecovery } = require(path.join(__dirname, 'rendererCrashRecovery.cjs'));

const privateIpBlockList = new nodeNet.BlockList();
privateIpBlockList.addAddress('0.0.0.0', 'ipv4');
privateIpBlockList.addSubnet('10.0.0.0', 8, 'ipv4');
privateIpBlockList.addSubnet('100.64.0.0', 10, 'ipv4');
privateIpBlockList.addSubnet('127.0.0.0', 8, 'ipv4');
privateIpBlockList.addSubnet('169.254.0.0', 16, 'ipv4');
privateIpBlockList.addSubnet('172.16.0.0', 12, 'ipv4');
privateIpBlockList.addSubnet('192.168.0.0', 16, 'ipv4');
privateIpBlockList.addAddress('::', 'ipv6');
privateIpBlockList.addAddress('::1', 'ipv6');
privateIpBlockList.addSubnet('fc00::', 7, 'ipv6');
privateIpBlockList.addSubnet('fe80::', 10, 'ipv6');

protocol.registerSchemesAsPrivileged([{
  scheme: 'lianhua-asset',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
}]);

// `desktop` opens the built renderer; only `desktop:dev` passes --dev.
const isDev = process.argv.includes('--dev') || Boolean(process.env.ELECTRON_START_URL);
const devServerUrl = process.env.ELECTRON_START_URL || 'http://127.0.0.1:5173';

const projectRoot = path.resolve(__dirname, '..');
const rendererEntryPath = path.join(projectRoot, 'dist', 'index.html');

const ensureDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

const directoryHasEntries = (directory) => {
  try {
    return fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
};

const pathComparisonKey = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const isSamePath = (left, right) => pathComparisonKey(left) === pathComparisonKey(right);

const trustedLoopbackHostname = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost';

const isTrustedRendererUrl = (rawUrl, options = {}) => {
  try {
    const candidate = new URL(String(rawUrl || ''));
    const dev = options.dev === undefined ? isDev : Boolean(options.dev);
    const entryPath = options.rendererEntryPath || rendererEntryPath;
    if (!dev) {
      if (candidate.protocol !== 'file:' || candidate.username || candidate.password) return false;
      return isSamePath(fileURLToPath(candidate), entryPath);
    }
    const configured = new URL(String(options.devServerUrl || devServerUrl));
    if (
      configured.protocol !== 'http:'
      || configured.username
      || configured.password
      || !trustedLoopbackHostname(configured.hostname)
    ) return false;
    return candidate.protocol === 'http:'
      && !candidate.username
      && !candidate.password
      && candidate.origin === configured.origin;
  } catch {
    return false;
  }
};

const withTrustedIpcSender = (handler) => async (event, ...args) => {
  const frame = event?.senderFrame;
  if (!frame || frame.top !== frame || !isTrustedRendererUrl(frame.url)) {
    throw new Error('拒绝来自不受信任页面的桌面请求');
  }
  return handler(event, ...args);
};

const handleTrustedIpc = (channel, handler) => ipcMain.handle(channel, withTrustedIpcSender(handler));

const activeModelRequests = new Map();

const modelRequestAbortError = () => {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
};

const validModelRequestId = (requestId) => (
  typeof requestId === 'string'
  && requestId.length > 0
  && requestId.length <= 200
  && /^[A-Za-z0-9._:-]+$/u.test(requestId)
);

const abortModelRequestsForSender = (sender) => {
  const entry = activeModelRequests.get(sender);
  if (!entry) return 0;
  activeModelRequests.delete(sender);
  sender?.removeListener?.('destroyed', entry.onDestroyed);
  let count = 0;
  for (const controller of entry.requests.values()) {
    if (!controller.signal.aborted) {
      count += 1;
      controller.abort(modelRequestAbortError());
    }
  }
  entry.requests.clear();
  return count;
};

const registerModelRequest = (sender, requestId) => {
  if (!validModelRequestId(requestId)) throw new Error('模型请求 ID 无效');
  let entry = activeModelRequests.get(sender);
  if (!entry) {
    const onDestroyed = () => { abortModelRequestsForSender(sender); };
    entry = { requests: new Map(), onDestroyed };
    activeModelRequests.set(sender, entry);
    sender?.once?.('destroyed', onDestroyed);
  }
  if (entry.requests.has(requestId)) throw new Error('模型请求 ID 重复');
  const controller = new AbortController();
  entry.requests.set(requestId, controller);
  return controller;
};

const finishModelRequest = (sender, requestId, controller) => {
  const entry = activeModelRequests.get(sender);
  if (!entry || entry.requests.get(requestId) !== controller) return false;
  entry.requests.delete(requestId);
  if (!entry.requests.size) {
    activeModelRequests.delete(sender);
    sender?.removeListener?.('destroyed', entry.onDestroyed);
  }
  return true;
};

const cancelModelRequest = (sender, requestId) => {
  if (!validModelRequestId(requestId)) return false;
  const controller = activeModelRequests.get(sender)?.requests.get(requestId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort(modelRequestAbortError());
  return true;
};

const abortAllModelRequests = () => {
  let count = 0;
  for (const sender of [...activeModelRequests.keys()]) {
    count += abortModelRequestsForSender(sender);
  }
  return count;
};

const isPathInside = (root, candidate) => {
  const relative = path.relative(pathComparisonKey(root), pathComparisonKey(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const copyDirectory = (source, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile() && !fs.existsSync(to)) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
};

const copyDirectoryIfNeeded = (source, destination) => {
  if (!source || isSamePath(source, destination) || !fs.existsSync(source)) return false;
  try {
    copyDirectory(source, destination);
    return true;
  } catch {
    // A stale/locked legacy profile must never prevent the app from opening.
    return false;
  }
};

const resolveDataRoot = () => {
  const configured = String(process.env.LIANHUA_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);

  // Portable builds keep their data beside the executable. The previous
  // hard-coded E: fallback made one failing disk a single point of failure.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, '莲华视频导演台数据');
  }

  // Development profiles stay beside the checked-out project.
  if (isDev) return path.join(projectRoot, '莲华视频导演台数据');

  return path.join(path.dirname(process.execPath), '莲华视频导演台数据');
};

// Resolve and pin every Electron-managed writable path before ready so state,
// managed media, cache, logs and crash data stay under one visible root.
const legacyUserData = app.getPath('userData');
const preferredDataRoot = resolveDataRoot();
const runtimeOnlyEntries = new Set(['cache', 'crash-dumps', 'logs', 'temp', '路径说明.txt']);

const initializeStoragePaths = (candidateRoot, migrationSource = '') => {
  const dataRoot = path.resolve(candidateRoot);
  const paths = {
    dataRoot,
    sessionRoot: path.join(dataRoot, 'session'),
    cacheRoot: path.join(dataRoot, 'cache'),
    logsRoot: path.join(dataRoot, 'logs'),
    crashRoot: path.join(dataRoot, 'crash-dumps'),
    tempRoot: path.join(dataRoot, 'temp'),
    stateFile: path.join(dataRoot, 'project-state.json'),
    snapshotRoot: path.join(dataRoot, 'project-snapshots'),
    assetRoot: path.join(dataRoot, 'assets'),
    recoveryConfigFile: path.join(dataRoot, 'recovery-config.json'),
    secretVaultFile: path.join(dataRoot, 'credentials.safe')
  };
  const dataRootHasEntries = fs.existsSync(dataRoot)
    && fs.readdirSync(dataRoot).some((entry) => !runtimeOnlyEntries.has(entry));
  ensureDirectory(dataRoot);
  if (!dataRootHasEntries) copyDirectoryIfNeeded(migrationSource, dataRoot);
  for (const directory of [paths.sessionRoot, paths.cacheRoot, paths.logsRoot, paths.crashRoot, paths.tempRoot, paths.snapshotRoot, paths.assetRoot]) {
    ensureDirectory(directory);
  }
  return paths;
};

let storagePaths;
let startupRecoveryNotice = null;
try {
  storagePaths = initializeStoragePaths(preferredDataRoot, legacyUserData);
} catch (error) {
  if (isSamePath(preferredDataRoot, legacyUserData)) throw error;
  storagePaths = initializeStoragePaths(legacyUserData);
  startupRecoveryNotice = `首选数据目录 ${preferredDataRoot} 无法使用，已回退到 Electron 数据目录 ${storagePaths.dataRoot}：${error instanceof Error ? error.message : String(error)}`;
}
const {
  dataRoot, sessionRoot, cacheRoot, logsRoot, crashRoot, tempRoot,
  stateFile, snapshotRoot, assetRoot, recoveryConfigFile, secretVaultFile
} = storagePaths;
let lastRecoveryNotice = startupRecoveryNotice;
const approvedReadPaths = new Set();
const approveReadPath = (filePath) => approvedReadPaths.add(pathComparisonKey(filePath));
const isApprovedReadPath = (filePath) => approvedReadPaths.has(pathComparisonKey(filePath));

// Automated desktop tests may supply fixed dialog results. They are ignored
// unless an explicit QA flag is present, so packaged builds always show the
// normal native file picker.
const qaPath = (name) => (
  process.env.LIANHUA_QA_MODE === '1' && String(process.env[name] || '').trim()
    ? path.resolve(process.env[name])
    : ''
);

// Node/Electron child processes also consult these variables for temporary
// files. Set them before the app is ready so model/image adapters inherit the
// same selected data root.
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
process.env.TMPDIR = tempRoot;

try {
  fs.writeFileSync(
    path.join(dataRoot, '路径说明.txt'),
    [
      '莲华视频导演台本地数据目录',
      `项目数据与本地资产：${dataRoot}`,
      `浏览器会话与 localStorage：${sessionRoot}`,
      `缓存：${cacheRoot}`,
      `运行临时文件：${tempRoot}`,
      `日志：${logsRoot}`,
      `崩溃转储：${crashRoot}`
    ].join('\r\n'),
    'utf8'
  );
} catch {
  // The app can still run if a removable drive becomes unavailable.
}

app.setPath('userData', dataRoot);
app.setPath('sessionData', sessionRoot);
app.setPath('cache', cacheRoot);
app.setPath('temp', tempRoot);
app.setPath('crashDumps', crashRoot);
app.setAppLogsPath(logsRoot);

// The project library is one envelope, not a single image. Keep a finite,
// shared 256 MiB state limit while retaining the original media limits.
const MAX_STATE_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_MEDIA_DOWNLOAD_MS = 10 * 60 * 1000;
const encodeModelHttpResponse = (bytes, responseType = 'text', contentType = '') => {
  if (!['text', 'base64'].includes(responseType)) {
    throw new Error('模型接口 responseType 只允许 text 或 base64');
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return {
    body: responseType === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
    bodyEncoding: responseType,
    contentType: typeof contentType === 'string' ? contentType : '',
  };
};
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'
]);

const readJsonFile = (filePath, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
};

const validateStateText = (content) => {
  return stateSerialization.validateStateText(content);
};

// Project-library state envelopes can contain more than the active project.
// Backups and package exports must carry every referenced managed asset so an
// archived project remains usable after a restore or transfer.
const stateAssets = (state) => {
  const activeId = state?.activeProjectId || state?.project?.id;
  const projects = [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])]
    .filter(Boolean).sort((left, right) => (
      (left?.id === activeId ? -1 : 0) - (right?.id === activeId ? -1 : 0)
    ));
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

const fsyncDirectory = (directory) => {
  try {
    const handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
  } catch { /* Windows may not allow directory fsync. */ }
};

const localFileError = (error, operation = '保存本地文件') => {
  const reasons = {
    ENOSPC: '磁盘空间不足，请释放保存目录所在磁盘的空间后重试',
    EDQUOT: '磁盘存储配额已用尽，请增加配额或更换数据目录后重试',
    EACCES: '没有写入权限，请检查数据目录权限',
    EPERM: '操作被系统拒绝，请检查目录权限或文件占用',
    EBUSY: '文件正被其他程序占用，请关闭占用程序后重试',
    EROFS: '目标磁盘或目录为只读，请改用可写目录',
    ENOENT: '目标目录不存在或磁盘已断开，请检查数据目录',
    ENOTDIR: '目标路径不是有效目录，请检查数据目录',
    EISDIR: '目标文件路径指向了目录，请检查保存路径',
    EIO: '磁盘读写失败，请检查磁盘连接和健康状态',
    EMFILE: '打开的文件过多，请关闭其他占用程序后重试',
    ENFILE: '系统可用文件句柄不足，请关闭其他占用程序后重试',
  };
  const code = typeof error?.code === 'string' ? error.code : '';
  if (!Object.prototype.hasOwnProperty.call(reasons, code)) return error instanceof Error ? error : new Error(String(error));
  const localized = new Error(`${operation}失败：${reasons[code]}（${code}）`);
  localized.code = code;
  localized.cause = error;
  return localized;
};

const atomicWriteFile = (filePath, content) => {
  let directory;
  try { directory = ensureDirectory(path.dirname(filePath)); }
  catch (error) { throw localFileError(error); }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'w');
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (error) {
    try { if (handle !== undefined) fs.closeSync(handle); } catch { /* keep the write failure */ }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* leave the original file intact */ }
    throw localFileError(error);
  }
  const previous = `${filePath}.previous`;
  try {
    if (fs.existsSync(filePath)) {
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(filePath, previous);
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    let recoveryFailed = false;
    try { if (!fs.existsSync(filePath) && fs.existsSync(previous)) fs.renameSync(previous, filePath); }
    catch { recoveryFailed = true; }
    // If recovery is blocked, retain both complete candidates for recovery.
    // Never discard the only older copy just because the main name is absent.
    if (!recoveryFailed) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original failure */ }
    }
    throw localFileError(error);
  }
  try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch { /* the new main file is already safely saved */ }
  fsyncDirectory(directory);
};

const pathExistsAsync = async (filePath) => {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const stateChecksum = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

const normalizeRecoveryConfig = (raw) => ({
    backupDirectory: typeof raw?.backupDirectory === 'string' ? raw.backupDirectory : '',
    backupOnSave: raw?.backupOnSave !== false,
    allowPrivateNetwork: raw?.allowPrivateNetwork === true,
    keepCount: Number.isFinite(raw?.keepCount) ? Math.max(3, Math.min(100, raw.keepCount)) : 20
});

const recoveryConfig = () => normalizeRecoveryConfig(readJsonFile(recoveryConfigFile, {}));

const writeRecoveryConfig = (config) => atomicWriteFile(recoveryConfigFile, JSON.stringify(config, null, 2));

const fileSha256Async = async (filePath) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const writeExternalBackup = (serialized) => getStatePersistence().run('backup', { content: serialized });

const stripSecrets = (state) => {
  return stateSerialization.stripSecrets(state);
};

const collectSecrets = (state) => ({
  current: {
    text: state.settings?.textApi?.apiKey || '',
    vision: state.settings?.visionApi?.apiKey || '',
    image: state.settings?.imageApi?.apiKey || '',
    video: state.settings?.videoTaskApi?.apiKey || '',
    comfyuiVideo: state.settings?.comfyuiVideo?.apiKey || '',
    runningHubVideo: state.settings?.runningHubVideo?.apiKey || ''
  },
  credentials: Object.fromEntries((state.settings?.apiCredentialBook || []).map((item) => [item.id, item.apiKey || ''])),
  textProfiles: Object.fromEntries((state.settings?.textApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  visionProfiles: Object.fromEntries((state.settings?.visionApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  imageProfiles: Object.fromEntries((state.settings?.imageApiProfiles || []).map((item) => [item.id, item.apiKey || ''])),
  videoProfiles: Object.fromEntries((state.settings?.videoApiProfiles || []).map((item) => [item.id, item.apiKey || '']))
});

const secretCount = (secrets) => Object.values(secrets.current || {}).filter(Boolean).length
  + ['credentials', 'textProfiles', 'visionProfiles', 'imageProfiles', 'videoProfiles']
    .reduce((sum, key) => sum + Object.values(secrets[key] || {}).filter(Boolean).length, 0);

const saveSecrets = (secrets) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (secretCount(secrets) === 0) {
    try { if (fs.existsSync(secretVaultFile)) fs.unlinkSync(secretVaultFile); } catch { /* next save can retry */ }
    return true;
  }
  const payload = Buffer.from(JSON.stringify(secrets), 'utf8');
  atomicWriteFile(secretVaultFile, safeStorage.encryptString(payload.toString('utf8')));
  return true;
};

const loadSecrets = () => {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretVaultFile)) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(secretVaultFile)));
  } catch { return null; }
};

let statePersistence;
const getStatePersistence = () => {
  if (!statePersistence) {
    let cachedSecretText = '';
    let cachedEncryptedSecrets;
    statePersistence = createStatePersistence({
      dataRoot,
      loadSecrets,
      encryptSecrets: (secrets) => {
        // safeStorage is Electron-only; keep just this small credential operation
        // in main. No project parse/stringify/hash or state fsync happens here.
        if (!safeStorage.isEncryptionAvailable()) {
          if (secretCount(secrets) > 0) throw new Error('系统加密不可用，API 密钥未保存');
          return { mode: 'keep' };
        }
        if (secretCount(secrets) === 0) {
          cachedSecretText = '';
          cachedEncryptedSecrets = undefined;
          return { mode: 'remove' };
        }
        const secretText = JSON.stringify(secrets);
        // DPAPI ciphertext changes on every encryption, even for identical
        // keys. Reuse unchanged encrypted bytes so ordinary progress saves do
        // not repeatedly rewrite the vault and its recovery transaction.
        if (secretText !== cachedSecretText || !cachedEncryptedSecrets) {
          cachedEncryptedSecrets = safeStorage.encryptString(secretText);
          cachedSecretText = secretText;
        }
        return { mode: 'write', encrypted: cachedEncryptedSecrets };
      },
    });
  }
  return statePersistence;
};

const hydrateSecrets = (state) => {
  const secrets = loadSecrets();
  if (!secrets) return state;
  if (state.settings?.textApi) state.settings.textApi.apiKey = secrets.current?.text || state.settings.textApi.apiKey || '';
  if (state.settings?.visionApi) state.settings.visionApi.apiKey = secrets.current?.vision || state.settings.visionApi.apiKey || '';
  if (state.settings?.imageApi) state.settings.imageApi.apiKey = secrets.current?.image || state.settings.imageApi.apiKey || '';
  if (state.settings?.videoTaskApi) state.settings.videoTaskApi.apiKey = secrets.current?.video || state.settings.videoTaskApi.apiKey || '';
  if (state.settings?.comfyuiVideo) state.settings.comfyuiVideo.apiKey = secrets.current?.comfyuiVideo || state.settings.comfyuiVideo.apiKey || '';
  if (state.settings?.runningHubVideo) state.settings.runningHubVideo.apiKey = secrets.current?.runningHubVideo || state.settings.runningHubVideo.apiKey || '';
  const hydrateList = (list, vault) => (list || []).forEach((item) => { item.apiKey = vault?.[item.id] || item.apiKey || ''; });
  hydrateList(state.settings?.apiCredentialBook, secrets.credentials);
  hydrateList(state.settings?.textApiProfiles, secrets.textProfiles);
  hydrateList(state.settings?.visionApiProfiles, secrets.visionProfiles);
  hydrateList(state.settings?.imageApiProfiles, secrets.imageProfiles);
  hydrateList(state.settings?.videoApiProfiles, secrets.videoProfiles);
  return state;
};

const assetPathFromRelative = (relativePath) => {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(assetRoot, normalized);
  if (!isPathInside(assetRoot, resolved)) throw new Error('资产路径越界');
  return resolved;
};

const readManagedImageDataUrlForRenderer = (payload = {}) => readManagedImageDataUrl({
  assetRoot,
  relativePath: payload?.relativePath,
  expectedChecksum: payload?.expectedChecksum,
});

const fileSha256 = (filePath) => {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
};

const mediaKindFromExtension = (extension) => {
  if (['.mp4', '.webm', '.mov'].includes(extension)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(extension)) return 'audio';
  return 'image';
};

const copyIntoAssetStore = (sourcePath) => {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) throw new Error('不支持的媒体文件格式');
  const checksum = fileSha256(sourcePath);
  const kind = mediaKindFromExtension(extension);
  const relativePath = path.join(kind, `${checksum}${extension}`);
  const destination = assetPathFromRelative(relativePath);
  ensureDirectory(path.dirname(destination));
  if (!fs.existsSync(destination)) fs.copyFileSync(sourcePath, destination);
  const stat = fs.statSync(destination);
  return {
    fileName: path.basename(sourcePath),
    relativePath: relativePath.replace(/\\/g, '/'),
    checksum,
    sizeBytes: stat.size,
    mediaType: kind,
    managed: true,
    missing: false,
    url: `lianhua-asset://local/${relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`
  };
};

const isPrivateHostname = (hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const family = nodeNet.isIP(host);
  return family > 0 && privateIpBlockList.check(host, family === 4 ? 'ipv4' : 'ipv6');
};

const assertAllowedRemoteUrl = (rawUrl) => {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许请求 http(s) 地址');
  if (parsed.username || parsed.password) throw new Error('接口地址不能包含用户名或密码');
  const allowPrivate = recoveryConfig().allowPrivateNetwork || process.env.LIANHUA_ALLOW_PRIVATE_NETWORK === '1';
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
    throw new Error('已阻止本机或局域网地址；请在“API 设置 → 图片 API → ComfyUI”中开启“允许访问本机与局域网模型端点”。');
  }
  return parsed.toString();
};

const isPrivateIpAddress = (address) => {
  const normalized = String(address || '').toLowerCase();
  const family = nodeNet.isIP(normalized);
  return family > 0 && privateIpBlockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
};

// Electron's invoke rejection only retains Error.message. Keep the network
// phase/code in that message without leaking request headers, paths or tokens.
const modelNetworkError = (error, { url, stage = 'connect', route = 'unknown', responseReceived = false } = {}) => {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return error;
  if (error?.networkEndpoint && error?.networkStage) return error;
  const endpoint = (() => {
    try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}`; }
    catch { return '未知接口'; }
  })();
  const code = /^[A-Z0-9_]{1,80}$/u.test(String(error?.code || '')) ? String(error.code) : '';
  const rawMessage = String(error?.message || error || '网络连接失败');
  const safeMessage = rawMessage
    .replace(/https?:\/\/[^\s<>"'）)]+/giu, (value) => {
      try { const parsed = new URL(value); return `${parsed.protocol}//${parsed.host}`; }
      catch { return '[已隐藏接口地址]'; }
    })
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [已隐藏]')
    .replace(/\b(api[-_]?key|access[-_]?token|authorization|token|secret)\s*[=:]\s*[^\s,;]+/giu, '$1=[已隐藏]')
    .slice(0, 1000);
  // Node reports this precise error before an HTTPS request can be exchanged.
  if (stage === 'connect' && /before secure TLS connection was established/iu.test(rawMessage)) stage = 'tls-handshake';
  const stages = {
    dns: '域名解析',
    'proxy-resolution': '读取系统代理',
    'proxy-connect': '建立系统代理隧道',
    connect: '建立网络连接',
    'tls-handshake': 'TLS 握手',
    response: '等待接口响应',
    'response-body': '读取接口响应',
  };
  const routeLabel = route === 'system-proxy' ? '系统代理' : route === 'direct' ? '直连' : '尚未确定';
  const details = [code && `错误码：${code}`, `阶段：${stages[stage] || stages.connect}`, `接口：${endpoint}`, `路由：${routeLabel}`,
    responseReceived ? '已取得 HTTP 响应，响应读取未完成' : '未取得 HTTP 响应'].filter(Boolean);
  return Object.assign(new Error(`${safeMessage}（${details.join('；')}）`), {
    ...(code ? { code } : {}),
    networkStage: stage,
    networkEndpoint: endpoint,
    networkRoute: route,
    cause: error,
  });
};

const assertRemoteResolution = async (rawUrl) => {
  const url = assertAllowedRemoteUrl(rawUrl);
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = nodeNet.isIP(hostname);
  let addresses;
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw modelNetworkError(error, { url, stage: 'dns' });
  }
  if (!addresses.length) throw new Error('域名未解析到可连接地址');
  const allowPrivate = recoveryConfig().allowPrivateNetwork || process.env.LIANHUA_ALLOW_PRIVATE_NETWORK === '1';
  if (!allowPrivate && addresses.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error('域名解析到本机或局域网地址，已阻止请求');
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: Number(selected.family) || nodeNet.isIP(selected.address) };
};

const headersObject = (headers) => headers && typeof headers.entries === 'function'
  ? Object.fromEntries(headers.entries())
  : Array.isArray(headers)
    ? Object.fromEntries(headers)
    : { ...(headers || {}) };

const deleteHeaders = (headers, predicate) => {
  for (const name of Object.keys(headers)) {
    if (predicate(name.toLowerCase())) delete headers[name];
  }
};

const createModelHttpRequestOptions = (payload = {}, signal) => {
  const method = String(payload.method || 'POST').toUpperCase();
  const hasStringBody = typeof payload.body === 'string';
  if (payload.multipart != null && hasStringBody) {
    throw new Error('模型接口请求不能同时提供普通 body 和 multipart');
  }
  const headers = headersObject(payload.headers || { 'Content-Type': 'application/json' });
  let body = hasStringBody ? payload.body : undefined;
  if (payload.multipart != null) {
    if (method !== 'POST') throw new Error('multipart 模型接口只允许 POST');
    const multipart = buildImageEditMultipart(payload.multipart);
    deleteHeaders(headers, (name) => name === 'content-type' || name === 'content-length');
    headers['Content-Type'] = multipart.contentType;
    headers['Content-Length'] = String(multipart.contentLength);
    body = multipart.body;
  }
  return { method, headers, body, signal, noTimeout: true, ...(payload.redirect === 'error' ? { redirect: 'error' } : {}) };
};

const isSensitiveRedirectHeader = (name) => (
  ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'set-cookie'].includes(name)
  || /(?:^|[-_])(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret)(?:$|[-_])/.test(name)
);
const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const redirectRequestOptions = (options, status, currentUrl, nextUrl) => {
  const redirected = { ...options, headers: headersObject(options.headers) };
  let method = String(redirected.method || 'GET').toUpperCase();
  const switchToGet = (status === 301 || status === 302) && method === 'POST'
    || status === 303 && method !== 'HEAD';
  if (switchToGet) {
    method = 'GET';
    redirected.body = undefined;
    deleteHeaders(redirected.headers, (name) => [
      'content-encoding', 'content-language', 'content-length', 'content-location',
      'content-md5', 'content-type', 'transfer-encoding'
    ].includes(name));
  }
  redirected.method = method;

  if (new URL(currentUrl).origin !== new URL(nextUrl).origin) {
    deleteHeaders(redirected.headers, isSensitiveRedirectHeader);
    if (redirected.body !== undefined && redirected.body !== null && !['GET', 'HEAD'].includes(method)) {
      throw new Error('已阻止跨站重定向转发请求正文');
    }
  }
  return redirected;
};

const requestResolvedTarget = (target, options = {}) => new Promise((resolve, reject) => {
  const parsed = new URL(target.url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const headers = headersObject(options.headers);
  deleteHeaders(headers, (name) => name === 'host');
  headers.host = parsed.host;
  const lookup = (_lookupHostname, lookupOptions, callback) => {
    if (lookupOptions?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const transport = parsed.protocol === 'https:' ? nodeHttps : nodeHttp;
  let request;
  let stage = 'connect';
  const fail = (error) => reject(modelNetworkError(error, {
    url: target.url,
    stage,
    route: options.agent ? 'system-proxy' : 'direct',
  }));
  const connectTimeoutMs = options.connectTimeoutMs || MODEL_CONNECT_TIMEOUT_MS;
  const connectionTimer = options.noTimeout === true ? undefined : setTimeout(() => {
    const error = Object.assign(new Error(`模型接口连接超时（${Math.max(1, Math.round(connectTimeoutMs / 1000))} 秒），请检查网络或系统代理`), { code: 'ETIMEDOUT' });
    request?.destroy(error);
    fail(error);
  }, connectTimeoutMs);
  connectionTimer?.unref?.();
  const clearConnectionTimer = () => clearTimeout(connectionTimer);
  const connected = () => { stage = 'response'; clearConnectionTimer(); };
  try {
    request = transport.request(parsed, {
      agent: options.agent || false,
      method: options.method || 'GET',
      headers,
      lookup,
      signal: options.signal,
      ...(parsed.protocol === 'https:' && !nodeNet.isIP(hostname) ? { servername: hostname } : {})
    }, (incoming) => {
      connected();
      const status = incoming.statusCode || 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: {
          get: (name) => {
            const value = incoming.headers[String(name || '').toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          }
        },
        body: incoming
      });
    });
  } catch (error) {
    clearConnectionTimer();
    fail(error);
    return;
  }
  request.once('socket', (socket) => {
    if (options.noTimeout === true) socket.setTimeout?.(0);
    if (parsed.protocol === 'https:') {
      if (socket.authorized) connected();
      else {
        if (!socket.connecting) stage = 'tls-handshake';
        socket.once('connect', () => { stage = 'tls-handshake'; });
        socket.once('secureConnect', connected);
      }
    } else if (!socket.connecting) connected();
    else socket.once('connect', connected);
  });
  request.once('close', clearConnectionTimer);
  request.once('error', (error) => { clearConnectionTimer(); fail(error); });
  try {
    if (options.body === undefined || options.body === null) request.end();
    else request.end(options.body);
  } catch (error) {
    clearConnectionTimer();
    request.destroy();
    fail(error);
  }
});

const destroyResponseBody = (response) => {
  try { response?.body?.destroy?.(); } catch { /* the request is already being abandoned */ }
};

const fetchWithLimit = async (rawUrl, options = {}, maxBytes = MAX_HTTP_RESPONSE_BYTES) => {
  let target = await assertRemoteResolution(rawUrl);
  let requestOptions = { ...options, headers: headersObject(options.headers), method: String(options.method || 'GET').toUpperCase() };
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    // Explicitly allowed local model servers stay local. Public destinations
    // use the system route, while CONNECT still pins the validated origin IP.
    const proxySession = !isPrivateIpAddress(target.address) ? session?.defaultSession : undefined;
    let proxyUrl;
    try {
      proxyUrl = await resolveSystemProxy(target.url, {
        resolveProxy: proxySession?.resolveProxy ? (url) => proxySession.resolveProxy(url) : undefined,
        signal: requestOptions.signal,
        noTimeout: requestOptions.noTimeout === true,
      });
    } catch (error) {
      throw modelNetworkError(error, { url: target.url, stage: 'proxy-resolution' });
    }
    const connectDeadline = Date.now() + MODEL_CONNECT_TIMEOUT_MS;
    let proxyAgent;
    try {
      if (proxyUrl) {
        try {
          proxyAgent = await createProxyTunnelAgent(target, { proxyUrl, signal: requestOptions.signal, connectTimeoutMs: MODEL_CONNECT_TIMEOUT_MS, noTimeout: requestOptions.noTimeout === true });
        } catch (error) {
          throw modelNetworkError(error, { url: target.url, stage: 'proxy-connect', route: 'system-proxy' });
        }
      }
      const response = await requestResolvedTarget(target, {
        ...requestOptions,
        agent: proxyAgent,
        connectTimeoutMs: Math.max(1, connectDeadline - Date.now()),
      });
      if (HTTP_REDIRECT_STATUSES.has(response.status) && response.headers.get('location')) {
        if (requestOptions.redirect === 'error') { destroyResponseBody(response); throw new Error('此查询不允许接口重定向，请核对原始服务地址。'); }
        if (redirect === 3) { destroyResponseBody(response); throw new Error('接口重定向次数过多'); }
        destroyResponseBody(response);
        const nextUrl = new URL(response.headers.get('location'), target.url).toString();
        requestOptions = redirectRequestOptions(requestOptions, response.status, target.url, nextUrl);
        target = await assertRemoteResolution(nextUrl);
        continue;
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) { destroyResponseBody(response); throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`); }
      const chunks = [];
      let total = 0;
      if (response.body) {
        try {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk);
            total += bytes.length;
            if (total > maxBytes) { destroyResponseBody(response); throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`); }
            chunks.push(bytes);
          }
        } catch (error) {
          throw modelNetworkError(error, { url: target.url, stage: 'response-body', route: proxyUrl ? 'system-proxy' : 'direct', responseReceived: true });
        }
      }
      return { response, bytes: Buffer.concat(chunks) };
    } finally {
      proxyAgent?.destroy();
    }
  }
  throw new Error('请求失败');
};

const MAX_READABLE_MEDIA_STEM_LENGTH = 140;
const WINDOWS_RESERVED_FILE_STEM = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const clipFileStem = (value, length) => String(value || '').slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
const decodedFileName = (value) => {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
};
const readableMediaFileName = (rawName, extension) => {
  const requested = path.basename(String(rawName || ''))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
    .trim();
  const requestedExtension = path.extname(requested);
  const hasMediaExtension = ALLOWED_MEDIA_EXTENSIONS.has(requestedExtension.toLowerCase());
  let stem = (hasMediaExtension ? requested.slice(0, -requestedExtension.length) : requested)
    .replace(/[. ]+$/gu, '')
    .trim();
  stem = clipFileStem(stem, MAX_READABLE_MEDIA_STEM_LENGTH).trimEnd();
  if (!stem) stem = '生成视频';
  const firstStemPart = stem.split('.')[0].replace(/[. ]+$/gu, '');
  if (WINDOWS_RESERVED_FILE_STEM.test(firstStemPart)) stem = `_${stem}`;
  return `${stem}${extension}`;
};
const readableMediaNameKey = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
  .replace(/[. ]+$/gu, '')
  .toUpperCase();
const allocateReadableMediaRelativePath = (kind, fileName, checksum) => {
  const directory = ensureDirectory(path.join(assetRoot, kind));
  const entries = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile()) entries.set(readableMediaNameKey(entry.name), entry.name);
  }
  const extension = path.extname(fileName);
  const originalStem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let version = 1; version < 100_000; version += 1) {
    const suffix = version === 1 ? '' : ` · 第 ${version} 版`;
    const stem = clipFileStem(originalStem, MAX_READABLE_MEDIA_STEM_LENGTH - suffix.length).trimEnd();
    const candidate = `${stem}${suffix}${extension}`;
    const existing = entries.get(readableMediaNameKey(candidate));
    if (!existing) return path.join(kind, candidate);
    try {
      if (fileSha256(path.join(directory, existing)) === checksum) return path.join(kind, existing);
    } catch { /* An unreadable collision is occupied; allocate the next version. */ }
  }
  throw new Error('同名视频版本过多，无法分配安全文件名');
};
const allocateReadableMediaRelativePathAsync = async (kind, fileName, checksum) => {
  const directory = path.join(assetRoot, kind);
  await fs.promises.mkdir(directory, { recursive: true });
  const entries = new Map();
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) entries.set(readableMediaNameKey(entry.name), entry.name);
  }
  const extension = path.extname(fileName);
  const originalStem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let version = 1; version < 100_000; version += 1) {
    const suffix = version === 1 ? '' : ` · 第 ${version} 版`;
    const stem = clipFileStem(originalStem, MAX_READABLE_MEDIA_STEM_LENGTH - suffix.length).trimEnd();
    const candidate = `${stem}${suffix}${extension}`;
    const existing = entries.get(readableMediaNameKey(candidate));
    if (!existing) return path.join(kind, candidate);
    try {
      if (await fileSha256Async(path.join(directory, existing)) === checksum) return path.join(kind, existing);
    } catch { /* Unreadable collisions remain occupied. */ }
  }
  throw new Error('同名视频版本过多，无法分配安全文件名');
};
const DOWNLOAD_MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const DOWNLOAD_MIME_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/ogg', '.ogg'],
  ['audio/flac', '.flac'],
]);
const MAX_DOWNLOADED_MEDIA_SIGNATURE_BYTES = 4096;
const contentDispositionFileName = (value) => {
  const header = String(value || '');
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/iu)?.[1]?.trim().replace(/^"|"$/gu, '');
  if (encoded) return decodedFileName(encoded);
  const quoted = header.match(/filename\s*=\s*"((?:\\.|[^"])*)"/iu)?.[1];
  if (quoted) return quoted.replace(/\\([\\"])/gu, '$1');
  return header.match(/filename\s*=\s*([^;]+)/iu)?.[1]?.trim() || '';
};
const supportedExtension = (value) => {
  const extension = path.extname(String(value || '')).toLowerCase();
  return DOWNLOAD_MEDIA_EXTENSIONS.has(extension) ? extension : '';
};
const readEbmlVariableInteger = (bytes, offset, preserveMarker = false) => {
  if (!Buffer.isBuffer(bytes) || offset < 0 || offset >= bytes.length) return null;
  const first = bytes[offset];
  let marker = 0x80;
  let length = 1;
  while (length <= 8 && (first & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = BigInt(preserveMarker ? first : first & (marker - 1));
  for (let index = 1; index < length; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  if (!preserveMarker && value === (1n << BigInt(7 * length)) - 1n) return null;
  return { length, value };
};
const sniffEbmlDocType = (bytes) => {
  if (bytes.length < 5 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null;
  const headerSize = readEbmlVariableInteger(bytes, 4);
  if (!headerSize || headerSize.value > BigInt(Number.MAX_SAFE_INTEGER)) return '';
  let cursor = 4 + headerSize.length;
  const declaredEnd = cursor + Number(headerSize.value);
  const availableEnd = Math.min(declaredEnd, bytes.length);
  while (cursor < availableEnd) {
    const elementId = readEbmlVariableInteger(bytes, cursor, true);
    if (!elementId || elementId.length > 4) return '';
    cursor += elementId.length;
    const elementSize = readEbmlVariableInteger(bytes, cursor);
    if (!elementSize || elementSize.value > BigInt(Number.MAX_SAFE_INTEGER)) return '';
    cursor += elementSize.length;
    const elementEnd = cursor + Number(elementSize.value);
    if (elementEnd > availableEnd) return '';
    if (elementId.value === 0x4282n) {
      return bytes.subarray(cursor, elementEnd).toString('ascii').replace(/\0+$/gu, '').trim().toLowerCase();
    }
    cursor = elementEnd;
  }
  return '';
};
const ISO_BMFF_M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'M4R ', 'F4A ', 'F4B ']);
const ISO_BMFF_MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'F4V ', 'MSNV',
  'dash', 'msdh', 'msix', 'cmfc', 'cmfs',
]);
const sniffIsoBmffFamily = (bytes) => {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return null;
  const size32 = bytes.readUInt32BE(0);
  let bodyOffset = 8;
  let boxSize = size32;
  if (size32 === 1) {
    if (bytes.length < 24) return 'unknown';
    const extendedSize = bytes.readBigUInt64BE(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return 'unknown';
    boxSize = Number(extendedSize);
    bodyOffset = 16;
  } else if (size32 === 0) {
    return 'unknown';
  }
  if (boxSize < bodyOffset + 8 || (boxSize - bodyOffset - 8) % 4 !== 0 || bytes.length < bodyOffset + 8) return 'unknown';
  const availableEnd = Math.min(boxSize, bytes.length);
  const brands = [bytes.subarray(bodyOffset, bodyOffset + 4).toString('ascii')];
  for (let offset = bodyOffset + 8; offset + 4 <= availableEnd; offset += 4) {
    brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
  }
  if (brands.some((brand) => /^(?:3gp|3g2|3gs)/iu.test(brand))) return '3gp';
  if (brands.some((brand) => ISO_BMFF_M4A_BRANDS.has(brand))) return 'm4a';
  if (brands.includes('qt  ')) return 'mov';
  if (brands.some((brand) => ISO_BMFF_MP4_BRANDS.has(brand))) return 'mp4';
  return 'unknown';
};
const sniffDownloadedMediaExtension = (bytes) => {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return '';
  const ebmlDocType = sniffEbmlDocType(bytes);
  if (ebmlDocType !== null) {
    if (ebmlDocType === 'webm') return '.webm';
    if (ebmlDocType === 'matroska') throw new Error('结果媒体是暂不支持的 MKV/Matroska 容器');
    throw new Error(`结果媒体的 EBML DocType 无法识别${ebmlDocType ? `：${ebmlDocType}` : ''}`);
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return '.wav';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') return '.ogg';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'fLaC') return '.flac';
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') return '.mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return '.aac';
  const isoBmffFamily = sniffIsoBmffFamily(bytes);
  if (isoBmffFamily !== null) {
    if (isoBmffFamily === 'mp4') return '.mp4';
    if (isoBmffFamily === 'mov') return '.mov';
    if (isoBmffFamily === 'm4a') return '.m4a';
    if (isoBmffFamily === '3gp') throw new Error('结果媒体是暂不支持的 3GP/3G2 容器');
    throw new Error('结果媒体的 ISO-BMFF ftyp 品牌无法识别');
  }
  return '';
};
const resolveDownloadedMediaExtension = ({ bytes, contentType, dispositionName, targetUrl }) => {
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  if (normalizedContentType && normalizedContentType !== 'application/octet-stream' && !DOWNLOAD_MIME_EXTENSIONS.has(normalizedContentType)) {
    throw new Error(`结果媒体格式暂不支持：${normalizedContentType}`);
  }
  const declaredExtension = DOWNLOAD_MIME_EXTENSIONS.get(normalizedContentType) || '';
  const hintedExtension = supportedExtension(dispositionName) || supportedExtension(new URL(targetUrl).pathname);
  const sniffedExtension = sniffDownloadedMediaExtension(bytes);
  if (sniffedExtension) {
    const sniffedKind = mediaKindFromExtension(sniffedExtension);
    const expectedExtension = declaredExtension || hintedExtension;
    if (expectedExtension && mediaKindFromExtension(expectedExtension) !== sniffedKind) {
      throw new Error(`结果媒体内容与声明格式不一致：检测到${sniffedKind === 'audio' ? '音频' : '视频'}容器`);
    }
    return sniffedExtension;
  }
  if (declaredExtension) return declaredExtension;
  if (hintedExtension) return hintedExtension;
  throw new Error('无法确认结果媒体格式；请让接口返回正确的 Content-Type、文件扩展名或标准媒体容器');
};
const commitDownloadedMedia = async (temporary, { kind, requestedFileName, checksum, extension, useReadablePath }) => {
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const relativePath = useReadablePath
      ? await allocateReadableMediaRelativePathAsync(kind, requestedFileName, checksum)
      : path.join(kind, `${checksum}${extension}`);
    const destination = assetPathFromRelative(relativePath);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (await pathExistsAsync(destination)) {
      if (await fileSha256Async(destination) !== checksum) {
        if (useReadablePath) continue;
        throw new Error('托管媒体校验失败：内容寻址文件与 SHA-256 不一致');
      }
      await fs.promises.unlink(temporary);
      return relativePath;
    }
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error?.code)) throw error;
      try {
        await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError?.code === 'EEXIST') continue;
        throw copyError;
      }
    }
    await fs.promises.unlink(temporary);
    return relativePath;
  }
  throw new Error('同名视频版本过多，无法安全保存');
};
const copyImportedAssetIntoStore = (source, requestedRelativePath, checksum) => {
  let relativePath = String(requestedRelativePath || '').replace(/\\/gu, '/').replace(/^\/+/, '');
  const originalName = path.basename(relativePath);
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const destination = assetPathFromRelative(relativePath);
    ensureDirectory(path.dirname(destination));
    if (fs.existsSync(destination)) {
      if (fileSha256(destination) === checksum) return relativePath;
      const extension = path.extname(originalName).toLowerCase();
      if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) throw new Error(`项目包包含不支持的媒体格式：${originalName}`);
      const kind = mediaKindFromExtension(extension);
      const readableName = readableMediaFileName(originalName, extension);
      relativePath = allocateReadableMediaRelativePath(kind, readableName, checksum).replace(/\\/gu, '/');
      continue;
    }
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return relativePath;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`项目包资产同名版本过多：${originalName}`);
};
const remapImportedManagedPaths = (value, replacements) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => remapImportedManagedPaths(entry, replacements));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const originalPath = typeof value.relativePath === 'string' ? value.relativePath.replace(/\\/gu, '/') : '';
  const replacement = replacements.get(originalPath);
  if (replacement && replacement !== originalPath) {
    const originalFileName = path.basename(originalPath);
    const replacementFileName = path.basename(replacement);
    const originalStem = path.basename(originalFileName, path.extname(originalFileName));
    const replacementStem = path.basename(replacementFileName, path.extname(replacementFileName));
    value.relativePath = replacement;
    if (value.fileName === originalFileName) value.fileName = replacementFileName;
    if (value.name === originalStem) value.name = replacementStem;
    if (typeof value.url === 'string' && value.url.startsWith('lianhua-asset://local/')) {
      value.url = `lianhua-asset://local/${replacement.split('/').map(encodeURIComponent).join('/')}`;
    }
  }
  Object.values(value).forEach((entry) => remapImportedManagedPaths(entry, replacements));
};
const syncImportedGeneratedVideoNames = (state) => {
  const projects = [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])].filter(Boolean);
  const visited = new Set();
  for (const project of projects) {
    if (visited.has(project)) continue;
    visited.add(project);
    const namesByTaskId = new Map();
    for (const asset of project.assets || []) {
      if (!asset?.sourceVideoTaskId || typeof asset.fileName !== 'string') continue;
      const fileStem = path.basename(asset.fileName, path.extname(asset.fileName));
      if (asset.name === fileStem) namesByTaskId.set(asset.sourceVideoTaskId, fileStem);
      if (asset.videoSourceTask?.id === asset.sourceVideoTaskId && asset.videoSourceTask.videoJob?.snapshot?.draft && asset.name === fileStem) {
        asset.videoSourceTask.videoJob.snapshot.draft.name = fileStem;
      }
    }
    for (const task of project.generationTasks || []) {
      const name = namesByTaskId.get(task?.id);
      if (name && task.videoJob?.snapshot?.draft) task.videoJob.snapshot.draft.name = name;
    }
  }
};

const downloadIntoAssetStore = async (rawUrl, headers = {}, timeoutOptions = MAX_GENERATED_MEDIA_DOWNLOAD_MS) => {
  const options = timeoutOptions && typeof timeoutOptions === 'object' ? timeoutOptions : { timeoutMs: timeoutOptions };
  const maxBytes = Math.min(4 * 1024 * 1024 * 1024, Number(options.maxBytes) || 4 * 1024 * 1024 * 1024);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(new Error('视频下载已取消'));
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timeout = options.noTimeout === true ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('视频下载超时'));
  }, Math.max(1, Number(options.timeoutMs) || MAX_GENERATED_MEDIA_DOWNLOAD_MS));
  let activeResponse;
  let activeProxyAgent;
  let temporary = '';
  try {
    let target = await assertRemoteResolution(rawUrl);
    let requestOptions = { headers: headersObject(headers), method: 'GET', signal: controller.signal, noTimeout: options.noTimeout === true };
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      if (options.publicOnly === true && (isPrivateIpAddress(target.address) || new URL(target.url).protocol !== 'https:')) throw new Error('云端成片仅可从公网 HTTPS 地址下载');
      const proxySession = !isPrivateIpAddress(target.address) ? session?.defaultSession : undefined;
      const proxyUrl = await resolveSystemProxy(target.url, {
        resolveProxy: proxySession?.resolveProxy ? (url) => proxySession.resolveProxy(url) : undefined,
        signal: controller.signal,
        noTimeout: requestOptions.noTimeout,
      });
      if (proxyUrl) activeProxyAgent = await createProxyTunnelAgent(target, { proxyUrl, signal: controller.signal, noTimeout: requestOptions.noTimeout });
      const response = await requestResolvedTarget(target, { ...requestOptions, agent: activeProxyAgent });
      activeResponse = response;
      if (HTTP_REDIRECT_STATUSES.has(response.status) && response.headers.get('location')) {
        if (redirect === 3) { destroyResponseBody(response); throw new Error('下载重定向次数过多'); }
        destroyResponseBody(response);
        activeResponse = undefined;
        activeProxyAgent?.destroy();
        activeProxyAgent = undefined;
        const nextUrl = new URL(response.headers.get('location'), target.url).toString();
        requestOptions = redirectRequestOptions(requestOptions, response.status, target.url, nextUrl);
        target = await assertRemoteResolution(nextUrl);
        continue;
      }
      if (!response.ok || !response.body) { destroyResponseBody(response); throw new Error(`视频下载失败：HTTP ${response.status}`); }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType && !contentType.startsWith('video/') && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream' && !(options.allowVideoArchive === true && isZipContentType(contentType))) {
        destroyResponseBody(response);
        throw new Error(`结果地址返回了非媒体内容：${contentType}`);
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) { destroyResponseBody(response); throw new Error('下载文件超过大小限制'); }
      const dispositionName = contentDispositionFileName(response.headers.get('content-disposition'));
      temporary = path.join(tempRoot, `download-${randomUUID()}.part`);
      const handle = await fs.promises.open(temporary, 'wx');
      const hash = createHash('sha256');
      let sizeBytes = 0;
      let signatureBytes = Buffer.alloc(0);
      let lastProgressAt = 0;
      const emitProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 250) return;
        lastProgressAt = now;
        options.onProgress?.({ receivedBytes: sizeBytes, totalBytes: declared > 0 ? declared : undefined });
      };
      try {
        for await (const chunk of response.body) {
          if (controller.signal.aborted) throw new Error('视频下载已取消');
          const bytes = Buffer.from(chunk);
          sizeBytes += bytes.length;
          if (sizeBytes > maxBytes) { destroyResponseBody(response); throw new Error('下载文件超过大小限制'); }
          if (signatureBytes.length < MAX_DOWNLOADED_MEDIA_SIGNATURE_BYTES) {
            signatureBytes = Buffer.concat([signatureBytes, bytes.subarray(0, MAX_DOWNLOADED_MEDIA_SIGNATURE_BYTES - signatureBytes.length)]);
          }
          hash.update(bytes);
          // Await disk backpressure; do not block the Electron event loop for
          // every ComfyUI/local-network chunk or flood the renderer with IPC.
          await handle.writeFile(bytes);
          emitProgress();
        }
        if (sizeBytes === 0) throw new Error('视频下载返回了空文件');
        if (controller.signal.aborted) throw new Error('视频下载已取消');
        await handle.sync();
        emitProgress(true);
      } finally { await handle.close(); }

      const checksum = hash.digest('hex');
      const zipSignature = hasZipSignature(signatureBytes);
      let detectedVideoMime;
      if (!zipSignature && options.allowVideoArchive === true && (isZipContentType(contentType) || options.archiveHint === true)) {
        // Some workflow output descriptors retain "zip" after the provider has
        // already unpacked the response. Actual media bytes are authoritative.
        const extension = sniffDownloadedMediaExtension(signatureBytes);
        detectedVideoMime = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' })[extension];
        if (!detectedVideoMime) throw new Error('云端结果声明为 ZIP，但下载内容既不是有效 ZIP，也没有可用视频容器签名');
      }
      if (zipSignature) {
        if (options.allowVideoArchive !== true) throw new Error('结果是 ZIP 压缩包；当前下载入口未启用视频解压');
        const result = await importVideoArchive({
          archivePath: temporary, tempRoot, assetRoot, checksum,
          fileName: options.fileName,
          archiveFileName: dispositionName || decodedFileName(path.basename(new URL(target.url).pathname)) || '云端视频.zip',
          signal: controller.signal, onProgress: options.onProgress,
          sniffMediaExtension: sniffDownloadedMediaExtension,
          projectRoot, resourcesPath: process.resourcesPath,
        });
        await fs.promises.unlink(temporary);
        temporary = '';
        activeResponse = undefined;
        return result;
      }
      const extension = resolveDownloadedMediaExtension({
        bytes: signatureBytes,
        contentType: detectedVideoMime || contentType,
        dispositionName,
        targetUrl: target.url,
      });
      const kind = mediaKindFromExtension(extension);
      const parsedTarget = new URL(target.url);
      const upstreamName = dispositionName || parsedTarget.searchParams.get('filename') || decodedFileName(path.basename(parsedTarget.pathname));
      const requestedFileName = readableMediaFileName(options.fileName || upstreamName, extension);
      const useReadablePath = Boolean(String(options.fileName || '').trim());
      if (controller.signal.aborted) throw new Error('视频下载已取消');
      const relativePath = await commitDownloadedMedia(temporary, {
        kind,
        requestedFileName,
        checksum,
        extension,
        useReadablePath,
      });
      temporary = '';
      activeResponse = undefined;
      return {
        fileName: useReadablePath ? path.basename(relativePath) : requestedFileName,
        relativePath: relativePath.replace(/\\/g, '/'), checksum, sizeBytes, mediaType: kind,
        mimeType: detectedVideoMime || contentType || undefined, managed: true, missing: false,
        url: `lianhua-asset://local/${relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`
      };
    }
    throw new Error('视频下载失败');
  } catch (error) {
    destroyResponseBody(activeResponse);
    try { if (temporary) await fs.promises.rm(temporary, { force: true }); } catch { /* ignore cleanup */ }
    if (controller.signal.aborted) throw new Error(timedOut ? '视频下载超时' : '视频下载已取消');
    throw error;
  } finally {
    clearTimeout(timeout);
    activeProxyAgent?.destroy();
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
};

let videoTransport;
let rhtvManager;
const getRhTvManager = () => {
  if (!rhtvManager) rhtvManager = createRhTvManager({ root: path.join(dataRoot, 'rhtv-bridge'), projectRoot, resourcesPath: process.resourcesPath,
    downloadResult: async ({ url, jobId, signal }) => {
      if (!/^[a-f0-9-]{36}$/.test(jobId) || new URL(url).protocol !== 'https:') throw new Error('rhTV 原成片地址无效');
      const result = await downloadIntoAssetStore(url, {}, { signal, publicOnly: true, maxBytes: 2 * 1024 * 1024 * 1024 });
      if (result.mediaType !== 'video') throw new Error('rhTV 结果不是视频');
      return path.join(assetRoot, result.relativePath);
    },
  });
  return rhtvManager;
};
const getVideoTransport = () => {
  if (!videoTransport) videoTransport = createVideoTransport({
    fetchWithLimit,
    encodeResponse: encodeModelHttpResponse,
    downloadIntoAssetStore,
    assertRemoteResolution,
    isPrivateIpAddress,
    resolveProxy: session?.defaultSession?.resolveProxy ? (url) => session.defaultSession.resolveProxy(url) : undefined,
    resolveSystemProxy,
    createProxyTunnelAgent,
  });
  return videoTransport;
};
const videoTaskCredentialVault = createVideoTaskCredentialVault({
  filePath: path.join(dataRoot, 'video-task-credentials.safe'),
  safeStorage,
  atomicWriteFile,
});
const videoTaskCheckpointJournal = createVideoTaskCheckpointJournal({
  directory: path.join(dataRoot, 'video-task-checkpoints'), atomicWriteFile,
});

const MEDIA_MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mp4', '.m4a'],
  ['audio/ogg', '.ogg'],
  ['audio/flac', '.flac'],
]);

const normalizedMediaMimeType = (rawValue) => String(rawValue || '')
  .split(';')[0]
  .trim()
  .toLowerCase();

const assertMediaMimeType = (rawValue) => {
  const mimeType = normalizedMediaMimeType(rawValue);
  if (!/^(?:image|video|audio)\//i.test(mimeType)) throw new Error('保存内容不是受支持的图片或媒体格式');
  return mimeType;
};

const decodeMediaDataUrl = (dataUrl) => {
  const raw = String(dataUrl || '');
  const commaIndex = raw.indexOf(',');
  if (!raw.startsWith('data:') || commaIndex <= 5) throw new Error('图片数据格式无效');
  const metadata = raw.slice(5, commaIndex);
  const mimeType = assertMediaMimeType(metadata.split(';')[0]);
  const encoded = raw.slice(commaIndex + 1);
  let bytes;
  if (/;base64(?:;|$)/i.test(metadata)) {
    const compact = encoded.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
      throw new Error('图片 Base64 数据无效');
    }
    bytes = Buffer.from(compact, 'base64');
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(encoded), 'utf8');
    } catch {
      throw new Error('图片数据编码无效');
    }
  }
  if (!bytes.length) throw new Error('图片数据为空');
  if (bytes.length > MAX_IMAGE_EXPORT_BYTES) throw new Error('图片超过 64 MB 保存限制');
  return { bytes, mimeType };
};

const GENERATED_IMAGE_FORMATS = new Map([
  ['image/png', {
    extension: '.png',
    matches: (bytes) => bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  }],
  ['image/jpeg', {
    extension: '.jpg',
    matches: (bytes) => bytes.length >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  }],
  ['image/webp', {
    extension: '.webp',
    matches: (bytes) => bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  }],
]);

const decodeGeneratedImageDataUrl = (dataUrl) => {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:[^,]*;base64,([A-Za-z0-9+/\s]*={0,2})$/iu);
  if (!match) throw new Error('生成图片只允许 PNG、JPEG 或 WebP 的 Base64 data URL');
  const compact = match[1].replace(/\s+/gu, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new Error('生成图片 Base64 格式无效');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(compact.length * 3 / 4) - padding;
  if (estimatedBytes > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片超过 32 MB 托管上限');
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length) throw new Error('生成图片数据为空');
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片超过 32 MB 托管上限');
  const detected = [...GENERATED_IMAGE_FORMATS].find(([, format]) => format.matches(bytes));
  if (!detected) throw new Error('生成图片不是有效的 PNG、JPEG 或 WebP 图片（文件签名无效）');
  const [mimeType, format] = detected;
  // Keep original bytes, but reject truncated/undecodable files even if their
  // first few bytes happen to contain a supported signature.
  const ending = mimeType === 'image/png'
    ? Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    : Buffer.from([0xff, 0xd9]);
  const endingAt = bytes.lastIndexOf(ending);
  const complete = mimeType === 'image/webp' ? isCompleteWebP(bytes) : endingAt >= (mimeType === 'image/png' ? 8 : 3)
    && bytes.subarray(endingAt + ending.length).every((value) => [0, 9, 10, 13, 32].includes(value));
  let decodable = false;
  try { decodable = complete && (mimeType === 'image/webp' || !nativeImage.createFromBuffer(bytes).isEmpty()); } catch { /* normalize decoder failures without exposing payload bytes */ }
  if (!decodable) throw new Error('生成图片内容已损坏或截断，无法解码为有效图片');
  return { bytes, mimeType, extension: format.extension };
};

const generatedImageFileName = (rawName, extension) => {
  const requested = path.basename(String(rawName || ''))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim();
  const stem = path.basename(requested, path.extname(requested)).trim().slice(0, 160);
  return `${stem || 'generated-image'}${extension}`;
};

const storeGeneratedImageInAssetStore = async (payload) => {
  const input = typeof payload === 'string' ? { dataUrl: payload } : payload || {};
  const { bytes, mimeType, extension } = decodeGeneratedImageDataUrl(input.dataUrl);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const relativePath = path.join('image', `${checksum}${extension}`);
  const destination = assetPathFromRelative(relativePath);
  ensureDirectory(path.dirname(destination));
  if (!fs.existsSync(destination)) {
    atomicWriteFile(destination, bytes);
  } else if (fileSha256(destination) !== checksum) {
    throw new Error('托管图片校验失败：同名内容与 SHA-256 不一致');
  }
  const sizeBytes = fs.statSync(destination).size;
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  return {
    fileName: generatedImageFileName(input.fileName, extension),
    relativePath: normalizedRelativePath,
    checksum,
    sizeBytes,
    mediaType: 'image',
    mimeType,
    managed: true,
    missing: false,
    url: `lianhua-asset://local/${normalizedRelativePath.split('/').map(encodeURIComponent).join('/')}`,
  };
};

const exportMediaToPath = async (payload, destinationPath) => {
  const destination = path.resolve(String(destinationPath || ''));
  if (!destinationPath) throw new Error('保存路径为空');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  const sourceUrl = String(payload?.sourceUrl || '').trim();
  let relativePath = String(payload?.relativePath || '').trim();
  let dataUrl = String(payload?.dataUrl || '').trim();
  let remoteUrl = String(payload?.url || '').trim();
  if (sourceUrl.startsWith('lianhua-asset://')) {
    const parsed = new URL(sourceUrl);
    relativePath ||= parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } else if (sourceUrl.startsWith('data:')) {
    dataUrl ||= sourceUrl;
  } else if (/^https?:\/\//i.test(sourceUrl)) {
    remoteUrl ||= sourceUrl;
  } else if (sourceUrl) {
    throw new Error('只支持保存本地资产、data 地址或 http(s) 图片');
  }

  if (relativePath) {
    const source = assetPathFromRelative(relativePath);
    if (fs.existsSync(source)) {
      if (!isSamePath(source, destination)) await fs.promises.copyFile(source, destination);
      return destination;
    }
    if (!dataUrl && !remoteUrl) throw new Error('原文件缺失，无法保存，请先重连');
  }

  if (dataUrl) {
    const { bytes } = decodeMediaDataUrl(dataUrl);
    await fs.promises.writeFile(destination, bytes);
    return destination;
  }

  if (remoteUrl) {
    const fetched = await fetchWithLimit(remoteUrl, { method: 'GET', noTimeout: true }, MAX_IMAGE_EXPORT_BYTES);
    if (!fetched.response.ok) throw new Error(`图片下载失败：HTTP ${fetched.response.status}`);
    const responseMimeType = normalizedMediaMimeType(fetched.response.headers.get('content-type'));
    if (responseMimeType) assertMediaMimeType(responseMimeType);
    if (!fetched.bytes.length) throw new Error('图片下载结果为空');
    await fs.promises.writeFile(destination, fetched.bytes);
    return destination;
  }

  throw new Error('该资产只有提示词，没有可保存的图片文件');
};

const mediaExportExtension = (payload) => {
  const candidates = [payload?.defaultPath, payload?.fileName, payload?.relativePath, payload?.url, payload?.sourceUrl];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let candidatePath = String(candidate);
    try {
      if (/^https?:\/\//i.test(candidatePath)) candidatePath = new URL(candidatePath).pathname;
    } catch { /* use the raw candidate */ }
    const extension = path.extname(candidatePath).toLowerCase();
    if (ALLOWED_MEDIA_EXTENSIONS.has(extension)) return extension;
  }
  const dataMime = String(payload?.dataUrl || payload?.sourceUrl || '').match(/^data:([^;,]+)/i)?.[1];
  return MEDIA_MIME_EXTENSIONS.get(normalizedMediaMimeType(payload?.mimeType || dataMime)) || '.png';
};

const mediaExportDefaultName = (payload) => {
  const extension = mediaExportExtension(payload);
  const requested = path.basename(String(payload?.defaultPath || payload?.fileName || payload?.name || `莲华图片${extension}`))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()
    .slice(0, 180) || `莲华图片${extension}`;
  return path.extname(requested) ? requested : `${requested}${extension}`;
};

const runPowerShell = (command, environment) => new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()));
  });
});

const powershellArchive = async (sourceDirectory, destinationZip) => {
  const temporaryZip = `${destinationZip}.${randomUUID()}.zip`;
  try {
    await runPowerShell(
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; if ([System.IO.File]::Exists($env:LH_DEST)) { [System.IO.File]::Delete($env:LH_DEST) }; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:LH_SOURCE, $env:LH_DEST, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
      { LH_SOURCE: sourceDirectory, LH_DEST: temporaryZip }
    );
  } catch (error) {
    try { if (fs.existsSync(temporaryZip)) fs.unlinkSync(temporaryZip); } catch { /* ignore cleanup */ }
    throw new Error(error instanceof Error ? error.message : '项目包压缩失败');
  }
  if (fs.existsSync(destinationZip)) fs.unlinkSync(destinationZip);
  fs.renameSync(temporaryZip, destinationZip);
};

const powershellExpand = async (sourceZip, destinationDirectory) => {
  const temporaryZip = path.join(destinationDirectory, `${randomUUID()}.zip`);
  fs.copyFileSync(sourceZip, temporaryZip);
  try {
    await runPowerShell(
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:LH_SOURCE, $env:LH_DEST)",
      { LH_SOURCE: temporaryZip, LH_DEST: destinationDirectory }
    );
  } finally {
    try { fs.unlinkSync(temporaryZip); } catch { /* ignore cleanup */ }
  }
};

const formatConsoleMessageForLog = (details, legacyDetails = []) => {
  const hasDetailPayload = details
    && typeof details === 'object'
    && (typeof details.level === 'string' || typeof details.level === 'number')
    && typeof details.message === 'string';
  const [legacyLevel, legacyMessage, legacyLine, legacySourceId] = legacyDetails;
  const level = hasDetailPayload ? details.level : legacyLevel;
  const shouldLog = typeof level === 'number'
    ? level >= 2
    : level === 'warning' || level === 'error';
  if (!shouldLog) return null;
  const message = hasDetailPayload ? details.message : legacyMessage;
  const lineNumber = hasDetailPayload ? (details.lineNumber ?? details.line) : legacyLine;
  const sourceId = hasDetailPayload ? details.sourceId : legacySourceId;
  return `console level=${level} ${sourceId}:${lineNumber} ${message}`;
};

const stateCloseGuards = new WeakMap();
if (process.platform === 'win32') app.setAppUserModelId('com.lianhua.video-director');
function createWindow() {
  const appIcon = path.join(__dirname, '..', 'build', 'icon.png');
  if (isDev && !isTrustedRendererUrl(devServerUrl, { dev: true, devServerUrl, rendererEntryPath })) {
    throw new Error('ELECTRON_START_URL 只允许使用本机 127.0.0.1 或 localhost 的 HTTP 地址');
  }
  const win = new BrowserWindow({
    // Keep the first launch comfortable on 1080p/125% Windows desktops.
    // Users can still resize the window freely after opening it.
    width: 1280,
    height: 800,
    minWidth: 1120,
    minHeight: 720,
    center: true,
    backgroundColor: '#f2f4f7',
    title: '莲华视频导演台',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  stateCloseGuards.set(win.webContents, createStateCloseGuard({
    window: win,
    flush: () => statePersistence?.flush() || Promise.resolve(),
    showMessage: (options) => dialog.showMessageBox(win, options),
  }));

  const blockUntrustedNavigation = (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  };
  win.webContents.on('will-navigate', blockUntrustedNavigation);
  win.webContents.on('will-redirect', blockUntrustedNavigation);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const loadRenderer = () => isDev ? win.loadURL(devServerUrl) : win.loadFile(rendererEntryPath);

  const runtimeLog = path.join(logsRoot, 'renderer.log');
  const appendRuntimeLog = (line) => {
    try { fs.appendFileSync(runtimeLog, `[${new Date().toISOString()}] ${line}\r\n`, 'utf8'); } catch { /* ignore logging errors */ }
  };
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    appendRuntimeLog(`did-fail-load code=${code} mainFrame=${isMainFrame} url=${url} description=${description}`);
    if (isMainFrame && code !== -3 && isTrustedRendererUrl(url)) {
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<body style="margin:0;background:#f2f4f7;color:#26212d;font-family:Segoe UI;padding:40px"><h2>莲华视频导演台加载失败</h2><p>请查看数据目录 logs/renderer.log。</p></body>')}`);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    appendRuntimeLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  createRendererCrashRecovery({
    window: win,
    showMessage: (options) => dialog.showMessageBox(win, options),
    loadRenderer,
    isClosing: () => stateQuitInProgress || Boolean(stateCloseGuards.get(win.webContents)?.allowed || stateCloseGuards.get(win.webContents)?.pending),
    log: appendRuntimeLog,
  });
  win.webContents.on('console-message', (details, ...legacyDetails) => {
    const logLine = formatConsoleMessageForLog(details, legacyDetails);
    if (logLine) appendRuntimeLog(logLine);
  });
  void loadRenderer().catch((error) => appendRuntimeLog(`initial-load failed: ${String(error?.message || error).slice(0, 1000)}`));
}

let videoWorkbench;
let videoThumbnails;
const thumbnailOwners = new WeakSet();
const getVideoThumbnails = (event) => {
  if (!videoThumbnails || videoThumbnails.canRestart()) videoThumbnails = createVideoThumbnailService({ assetRoot, cacheRoot, projectRoot, resourcesPath: process.resourcesPath });
  const sender = event.sender;
  if (!thumbnailOwners.has(sender)) {
    thumbnailOwners.add(sender);
    const ownerId = sender.id;
    sender.once('destroyed', () => videoThumbnails?.cancelOwner(ownerId));
    sender.on('render-process-gone', () => videoThumbnails?.cancelOwner(ownerId));
  }
  return videoThumbnails;
};
const workbenchOwners = new WeakSet();
const getVideoWorkbench = () => {
  if (!videoWorkbench) videoWorkbench = createVideoWorkbench({ assetRoot, tempRoot, projectRoot, resourcesPath: process.resourcesPath });
  return videoWorkbench;
};
const workbenchProgressTarget = (event) => {
  const sender = event.sender;
  const ownerId = sender.id;
  if (!workbenchOwners.has(sender)) {
    workbenchOwners.add(sender);
    sender.once('destroyed', () => videoWorkbench?.cancelOwner(ownerId));
    sender.on('render-process-gone', () => videoWorkbench?.cancelOwner(ownerId));
  }
  return (payload) => { if (!sender.isDestroyed()) sender.send('lianhua:workbench-progress', payload); };
};

app.whenReady().then(() => {
  handleTrustedIpc('lianhua:get-video-thumbnail', (event, payload) => getVideoThumbnails(event).get(payload, event.sender.id));
  handleTrustedIpc('lianhua:cancel-video-thumbnails', (event, payload) => videoThumbnails?.cancelProject(payload?.projectId, event.sender.id) || 0);
  handleTrustedIpc('lianhua:video-workbench-status', () => getVideoWorkbench().status());
  handleTrustedIpc('lianhua:probe-workbench-video', (_event, source) => getVideoWorkbench().probe(source));
  handleTrustedIpc('lianhua:extract-workbench-frames', (event, payload) => getVideoWorkbench().extractFrames(payload, event.sender.id, workbenchProgressTarget(event)));
  handleTrustedIpc('lianhua:render-workbench-timeline', (event, payload) => getVideoWorkbench().renderTimeline(payload, event.sender.id, workbenchProgressTarget(event)));
  handleTrustedIpc('lianhua:cancel-workbench-job', (event, jobId) => getVideoWorkbench().cancel(jobId, event.sender.id));
  protocol.handle('lianhua-asset', (request) => {
    const url = new URL(request.url);
    const relativePath = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    try {
      const filePath = assetPathFromRelative(relativePath);
      if (!fs.existsSync(filePath)) return new Response('Asset not found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Invalid asset path', { status: 400 });
    }
  });

  handleTrustedIpc('lianhua:open-file', async (_event, filters) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: '文本文件', extensions: ['txt', 'md'] }]
    });
    const selected = result.canceled ? null : result.filePaths[0] || null;
    if (selected) approveReadPath(selected);
    return selected;
  });

  handleTrustedIpc('lianhua:save-file', async (_event, payload) => {
    const result = await dialog.showSaveDialog({
      defaultPath: payload?.defaultPath || '莲华视频导演台项目.json',
      filters: payload?.filters || [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    const fs = require('fs');
    fs.writeFileSync(result.filePath, String(payload?.content || ''), 'utf8');
    return result.filePath;
  });

  handleTrustedIpc('lianhua:save-media', async (_event, payload) => {
    const defaultPath = mediaExportDefaultName(payload || {});
    const sourceExtension = mediaExportExtension(payload || {}).slice(1);
    const fixedPath = qaPath('LIANHUA_QA_SAVE_MEDIA_PATH');
    const selectedPath = fixedPath || await dialog.showSaveDialog({
      title: '保存图片到电脑',
      defaultPath,
      filters: [{ name: '图片或媒体文件', extensions: [sourceExtension] }],
    }).then((result) => result.canceled ? '' : result.filePath || '');
    if (!selectedPath) return null;
    return exportMediaToPath(payload || {}, selectedPath);
  });

  handleTrustedIpc('lianhua:read-file', async (_event, filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    if (!isApprovedReadPath(resolved)) throw new Error('只允许读取用户刚刚选择的文件');
    return fs.readFileSync(resolved, 'utf8');
  });

  handleTrustedIpc('lianhua:storage-paths', async () => ({
    dataRoot,
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    cache: app.getPath('cache'),
    temp: app.getPath('temp'),
    logs: app.getPath('logs'),
    crashDumps: app.getPath('crashDumps'),
    assets: assetRoot,
    snapshots: snapshotRoot,
    recovery: recoveryConfig(),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }));

  handleTrustedIpc('lianhua:load-state', async () => {
    const result = await getStatePersistence().run('load');
    lastRecoveryNotice = result.notice || startupRecoveryNotice;
    return result.content;
  });

  handleTrustedIpc('lianhua:save-state', async (_event, content) => {
    // Shared validateStateText + final envelope-size/integrity checks run in
    // the ordered worker before any vault/state writes. Await is still durable,
    // including the external-backup result, not a fire-and-forget enqueue.
    return getStatePersistence().run('save', { content: typeof content === 'string' ? content : '' });
  });

  handleTrustedIpc('lianhua:complete-before-close', async (event, payload) => (
    stateCloseGuards.get(event.sender)?.acknowledge(payload) || false
  ));

  handleTrustedIpc('lianhua:recovery-status', async () => {
    const status = await getStatePersistence().run('status');
    return {
      ...status,
      lastRecoveryNotice: status.lastRecoveryNotice || lastRecoveryNotice,
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
  });

  handleTrustedIpc('lianhua:create-restore-point', async (_event, content) => {
    return getStatePersistence().run('restore-point', { content: String(content || '') });
  });

  handleTrustedIpc('lianhua:restore-snapshot', async (_event, snapshotId) => {
    return getStatePersistence().run('restore', { snapshotId: String(snapshotId || '') });
  });

  handleTrustedIpc('lianhua:choose-backup-directory', async () => {
    const fixedPath = qaPath('LIANHUA_QA_BACKUP_DIR');
    const selectedPath = fixedPath || await dialog.showOpenDialog({ title: '选择跨盘备份目录', properties: ['openDirectory', 'createDirectory'] })
      .then((result) => result.canceled ? '' : result.filePaths[0] || '');
    if (!selectedPath) return null;
    ensureDirectory(selectedPath);
    const config = { ...recoveryConfig(), backupDirectory: selectedPath };
    writeRecoveryConfig(config);
    return config;
  });

  handleTrustedIpc('lianhua:update-recovery-config', async (_event, patch) => {
    const current = recoveryConfig();
    const next = {
      ...current,
      backupOnSave: patch?.backupOnSave === undefined ? current.backupOnSave : Boolean(patch.backupOnSave),
      allowPrivateNetwork: patch?.allowPrivateNetwork === undefined ? current.allowPrivateNetwork : Boolean(patch.allowPrivateNetwork),
      keepCount: Number.isFinite(patch?.keepCount) ? Math.max(3, Math.min(100, patch.keepCount)) : current.keepCount
    };
    writeRecoveryConfig(next);
    return next;
  });

  handleTrustedIpc('lianhua:import-media', async (_event, payload) => {
    let sourcePath = typeof payload?.path === 'string' ? payload.path : '';
    if (!sourcePath) {
      const result = await dialog.showOpenDialog({
        title: '导入媒体资产',
        properties: ['openFile'],
        filters: [{ name: '媒体文件', extensions: [...ALLOWED_MEDIA_EXTENSIONS].map((item) => item.slice(1)) }]
      });
      if (result.canceled || !result.filePaths[0]) return null;
      sourcePath = result.filePaths[0];
    }
    return copyIntoAssetStore(sourcePath);
  });

  handleTrustedIpc('lianhua:store-generated-image', async (_event, payload) => (
    storeGeneratedImageInAssetStore(payload)
  ));

  handleTrustedIpc('lianhua:asset-status', async (_event, relativePath) => {
    try {
      const filePath = assetPathFromRelative(relativePath);
      if (!fs.existsSync(filePath)) return { exists: false, relativePath };
      const stat = fs.statSync(filePath);
      return { exists: true, relativePath, sizeBytes: stat.size, checksum: fileSha256(filePath), url: `lianhua-asset://local/${String(relativePath).split('/').map(encodeURIComponent).join('/')}` };
    } catch { return { exists: false, relativePath }; }
  });

  handleTrustedIpc('lianhua:read-managed-image-data-url', async (_event, payload) => (
    readManagedImageDataUrlForRenderer(payload)
  ));

  handleTrustedIpc('lianhua:relink-media', async (_event, asset) => {
    const result = await dialog.showOpenDialog({ title: `重新定位 ${asset?.fileName || '资产'}`, properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const imported = copyIntoAssetStore(result.filePaths[0]);
    if (asset?.checksum && imported.checksum !== asset.checksum) imported.checksumMismatch = true;
    return imported;
  });

  handleTrustedIpc('lianhua:reveal-asset', async (_event, relativePath) => {
    const filePath = assetPathFromRelative(relativePath);
    if (!fs.existsSync(filePath)) throw new Error('资产文件不存在');
    shell.showItemInFolder(filePath);
    return true;
  });

  handleTrustedIpc('lianhua:export-project-package', async (_event, payload) => {
    const state = validateStateText(String(payload?.content || ''));
    const fixedPath = qaPath('LIANHUA_QA_EXPORT_PATH');
    const selectedPath = fixedPath || await dialog.showSaveDialog({ defaultPath: `${payload?.fileName || '莲华视频项目'}.lhvd`, filters: [{ name: '莲华项目包', extensions: ['lhvd'] }] })
      .then((result) => result.canceled ? '' : result.filePath || '');
    if (!selectedPath) return null;
    ensureDirectory(path.dirname(selectedPath));
    const stage = ensureDirectory(path.join(tempRoot, `export-${randomUUID()}`));
    try {
      // Do not expand an accepted near-limit envelope with pretty-print
      // whitespace and create a package that its own importer cannot read.
      const exportedState = JSON.stringify(stripSecrets(state));
      validateStateText(exportedState);
      atomicWriteFile(path.join(stage, 'project.json'), exportedState);
      const stageAssets = ensureDirectory(path.join(stage, 'assets'));
      const manifest = [];
      const frozenImageAssets = collectImageReferenceSnapshotsForExport(state);
      const frozenImageChecksums = new Map(frozenImageAssets.map((asset) => [asset.relativePath, asset.checksum]));
      const exportedFiles = [...stateAssets(state), ...collectVideoFrozenAssets(state.project), ...frozenImageAssets];
      const copiedPaths = new Set();
      for (const asset of exportedFiles) {
        if (!asset?.relativePath) continue;
        if (copiedPaths.has(asset.relativePath)) continue;
        copiedPaths.add(asset.relativePath);
        try {
          const source = assetPathFromRelative(asset.relativePath);
          if (!fs.existsSync(source)) { manifest.push({ id: asset.id, missing: true, relativePath: asset.relativePath }); continue; }
          const checksum = fileSha256(source);
          const frozenImageChecksum = frozenImageChecksums.get(asset.relativePath);
          if (frozenImageChecksum && checksum !== frozenImageChecksum) {
            throw new Error(`图生图参考图内容已变化，未导出替换后的图片：${asset.relativePath}`);
          }
          const target = path.join(stageAssets, asset.relativePath);
          ensureDirectory(path.dirname(target));
          fs.copyFileSync(source, target);
          manifest.push({ id: asset.id, relativePath: asset.relativePath, checksum, sizeBytes: fs.statSync(source).size });
        } catch { manifest.push({ id: asset.id, missing: true, relativePath: asset.relativePath }); }
      }
      atomicWriteFile(path.join(stage, 'manifest.json'), JSON.stringify({ format: 'lianhua-project-package', version: 1, exportedAt: new Date().toISOString(), assets: manifest }, null, 2));
      await powershellArchive(stage, selectedPath);
      return { path: selectedPath, assetCount: manifest.filter((item) => !item.missing).length, missingCount: manifest.filter((item) => item.missing).length };
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });

  handleTrustedIpc('lianhua:import-project-package', async (_event, payload) => {
    let sourcePath = typeof payload?.path === 'string' ? payload.path.trim() : '';
    if (!sourcePath) sourcePath = qaPath('LIANHUA_QA_IMPORT_PATH');
    if (!sourcePath) {
      const result = await dialog.showOpenDialog({ title: '导入莲华项目包', properties: ['openFile'], filters: [{ name: '莲华项目包', extensions: ['lhvd'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      sourcePath = result.filePaths[0];
    }
    const stage = ensureDirectory(path.join(tempRoot, `import-${randomUUID()}`));
    try {
      await powershellExpand(sourcePath, stage);
      const state = validateStateText(fs.readFileSync(path.join(stage, 'project.json'), 'utf8'));
      const manifest = readJsonFile(path.join(stage, 'manifest.json'), { assets: [] });
      const stageAssetRoot = path.resolve(stage, 'assets');
      const replacements = new Map();
      for (const item of manifest.assets || []) {
        if (!item.relativePath || item.missing) continue;
        const originalRelativePath = String(item.relativePath).replace(/\\/gu, '/').replace(/^\/+/, '');
        const source = path.resolve(stageAssetRoot, originalRelativePath);
        if (!isPathInside(stageAssetRoot, source) || !fs.existsSync(source)) continue;
        const checksum = fileSha256(source);
        if (item.checksum && checksum !== String(item.checksum).toLowerCase()) throw new Error(`资产校验失败：${item.relativePath}`);
        const importedRelativePath = copyImportedAssetIntoStore(source, originalRelativePath, checksum);
        if (importedRelativePath !== originalRelativePath) replacements.set(originalRelativePath, importedRelativePath);
      }
      if (replacements.size) {
        remapImportedManagedPaths(state, replacements);
        syncImportedGeneratedVideoNames(state);
      }
      // Import also hydrates the current vault. Do not read it halfway through
      // a background state/vault commit for another pending autosave.
      await getStatePersistence().flush();
      return JSON.stringify(hydrateSecrets(state));
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });

  handleTrustedIpc('lianhua:submit-video-task', async (event, payload) => {
    if (!payload || typeof payload.endpoint !== 'string') throw new Error('请先配置视频任务 API 地址');
    const result = await getVideoTransport().request({
      requestId: payload.requestId || `legacy-video-${randomUUID()}`,
      url: payload.endpoint,
      method: payload.method || 'POST',
      headers: payload.headers || { 'Content-Type': 'application/json' },
      ...((payload.method || 'POST').toUpperCase() === 'GET' ? {} : { body: JSON.stringify(payload.body || {}) }),
    }, event.sender);
    let body;
    try { body = JSON.parse(result.body); } catch { body = { raw: result.body }; }
    return { status: result.status, body };
  });

  handleTrustedIpc('lianhua:download-generated-media', async (event, payload) => {
    if (!payload?.url) throw new Error('结果地址为空');
    return getVideoTransport().download(payload, event.sender);
  });
  handleTrustedIpc('lianhua:video-request', (event, payload) => getVideoTransport().request(payload, event.sender));
  handleTrustedIpc('lianhua:rhtv-request', (_event, payload) => getRhTvManager().call('request', payload));
  handleTrustedIpc('lianhua:rhtv-control', async (_event, payload) => {
    if (!payload || !['status', 'start', 'stop', 'login', 'prepare', 'handoff', 'import-result', 'cancel', 'materials', 'confirm-not-submitted', 'confirm-ended', 'automation', 'retry'].includes(payload.action)) throw new Error('rhTV 操作无效');
    const manager = getRhTvManager();
    if (payload.action === 'stop') return manager.close();
    if (payload.action === 'materials') {
      const file = await manager.call('materials', { jobId: payload.jobId });
      shell.showItemInFolder(file); return manager.call('status');
    }
    if (payload.action === 'import-result') {
      const selected = await dialog.showOpenDialog({ title: '选择此 rhTV 原任务的成片', properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov'] }] });
      if (selected.canceled || !selected.filePaths[0]) return manager.call('status');
      return manager.call('import-result', { jobId: payload.jobId, path: selected.filePaths[0] });
    }
    return manager.call(payload.action, { jobId: payload.jobId, enabled: payload.enabled });
  });
  handleTrustedIpc('lianhua:rhtv-download', async (_event, payload) => {
    const source = await getRhTvManager().call('result-file', { url: payload?.url });
    const expected = await fs.promises.realpath(path.join(dataRoot, 'rhtv-bridge', 'results', 'video'));
    const real = await fs.promises.realpath(source);
    if (path.dirname(real).toLowerCase() !== expected.toLowerCase()) throw new Error('rhTV 成片路径无效');
    const extension = path.extname(real);
    const fileName = readableMediaFileName(payload?.fileName || path.basename(real), extension);
    const temporary = path.join(tempRoot, `rhtv-${randomUUID()}.part`);
    let managed;
    try {
      await fs.promises.copyFile(real, temporary, fs.constants.COPYFILE_EXCL);
      const checksum = await fileSha256Async(temporary);
      const sizeBytes = (await fs.promises.stat(temporary)).size;
      const relativePath = (await commitDownloadedMedia(temporary, { kind: 'video', requestedFileName: fileName, checksum, extension, useReadablePath: true })).replace(/\\/gu, '/');
      managed = { fileName, relativePath, checksum, sizeBytes, mediaType: 'video', managed: true, missing: false,
        url: `lianhua-asset://local/${relativePath.split('/').map(encodeURIComponent).join('/')}` };
    } finally { await fs.promises.rm(temporary, { force: true }); }
    await getVideoWorkbench().probe({ assetId: managed.checksum, relativePath: managed.relativePath, expectedChecksum: managed.checksum });
    return managed;
  });
  handleTrustedIpc('lianhua:cancel-video-request', (event, requestId) => getVideoTransport().cancel(requestId, event.sender));
  handleTrustedIpc('lianhua:watch-video-progress', (event, payload) => getVideoTransport().watch(payload, event.sender));
  handleTrustedIpc('lianhua:unwatch-video-progress', (event, watchId) => getVideoTransport().unwatch(watchId, event.sender));
  handleTrustedIpc('lianhua:set-video-task-credential', (_event, payload) => videoTaskCredentialVault.set(payload));
  handleTrustedIpc('lianhua:get-video-task-credential', (_event, taskId) => videoTaskCredentialVault.get(taskId));
  handleTrustedIpc('lianhua:delete-video-task-credential', (_event, taskId) => videoTaskCredentialVault.delete(taskId));
  handleTrustedIpc('lianhua:save-video-task-checkpoint', (_event, task) => videoTaskCheckpointJournal.save(task));
  handleTrustedIpc('lianhua:get-video-task-checkpoint', (_event, taskId) => videoTaskCheckpointJournal.get(taskId));
  handleTrustedIpc('lianhua:delete-video-task-checkpoint', (_event, taskId) => videoTaskCheckpointJournal.delete(taskId));

  // Keep third-party model requests out of the renderer in the packaged app,
  // avoiding CORS failures while still letting the user choose the endpoint.
  handleTrustedIpc('lianhua:http-request', async (event, payload) => {
    if (!payload || typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)) {
      throw new Error('只允许请求 http(s) 模型接口地址');
    }
    const method = String(payload.method || 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new Error('模型接口只允许 GET 或 POST');
    if (payload.requestId != null && !validModelRequestId(payload.requestId)) {
      throw new Error('模型请求 ID 无效');
    }
    const requestId = payload.requestId || `legacy-model-${randomUUID()}`;
    const controller = registerModelRequest(event.sender, requestId);
    try {
      const fetched = await fetchWithLimit(
        payload.url,
        createModelHttpRequestOptions(payload, controller.signal)
      );
      const response = fetched.response;
      const encoded = encodeModelHttpResponse(
        fetched.bytes,
        payload.responseType || 'text',
        response.headers.get('content-type') || '',
      );
      return { status: response.status, ...encoded };
    } finally {
      finishModelRequest(event.sender, requestId, controller);
    }
  });
  handleTrustedIpc('lianhua:cancel-model-request', (event, requestId) => (
    cancelModelRequest(event.sender, requestId)
  ));

  handleTrustedIpc('lianhua:download-image', async (_event, payload) => {
    const url = typeof payload === 'string' ? payload : payload?.url;
    const headers = typeof payload === 'object' && payload && !Array.isArray(payload)
      ? headersObject(payload.headers)
      : {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('只允许下载 http(s) 图片地址');
    let response;
    let bytes;
    const fetched = await fetchWithLimit(url, { headers, noTimeout: true });
    response = fetched.response;
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    bytes = fetched.bytes;
    const encoded = bytes.toString('base64');
    const { mimeType } = decodeGeneratedImageDataUrl(`data:application/octet-stream;base64,${encoded}`);
    return `data:${mimeType};base64,${encoded}`;
  });

  handleTrustedIpc('lianhua:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  abortAllModelRequests();
  videoTransport?.close();
  videoWorkbench?.close();
  videoThumbnails?.close();
  if (videoThumbnails?.canRestart()) videoThumbnails = undefined;
  if (process.platform !== 'darwin') app.quit();
});

let stateQuitInProgress = false;
let stateQuitFlushed = false;
app.on('before-quit', (event) => {
  if (stateQuitFlushed) return;
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.some((win) => !stateCloseGuards.get(win.webContents)?.allowed)) {
    event.preventDefault();
    for (const win of windows) win.close();
    return;
  }
  if (!statePersistence && !rhtvManager) return;
  event.preventDefault();
  if (stateQuitInProgress) return;
  stateQuitInProgress = true;
  void Promise.all([statePersistence?.close(), rhtvManager?.close()]).then(() => {
    stateQuitFlushed = true;
    app.quit();
  }, async (error) => {
    stateQuitInProgress = false;
    if (!BrowserWindow.getAllWindows().length) createWindow();
    await dialog.showMessageBox({ type: 'error', title: '保存未确认，已取消退出', message: '本地保存尚未成功，请回到软件检查后重试。', detail: String(error?.message || error).slice(0, 2000), buttons: ['返回软件'] });
  });
});
