const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const {
  validateStateText, prepareStateForSave, stateChecksum, stateAssets,
  hydrateStateSecrets, normalizeRecoveryConfig,
} = require('./stateSerialization.cjs');
const { collectImageReferenceSnapshotsForExport } = require('./imageReferenceSnapshots.cjs');

const localFileError = (error, operation = '保存本地文件') => {
  const reasons = {
    ENOSPC: '磁盘空间不足，请释放保存目录所在磁盘的空间后重试', EDQUOT: '磁盘存储配额已用尽，请增加配额或更换数据目录后重试',
    EACCES: '没有写入权限，请检查数据目录权限', EPERM: '操作被系统拒绝，请检查目录权限或文件占用',
    EBUSY: '文件正被其他程序占用，请关闭占用程序后重试', EROFS: '目标磁盘或目录为只读，请改用可写目录',
    ENOENT: '目标目录不存在或磁盘已断开，请检查数据目录', ENOTDIR: '目标路径不是有效目录，请检查数据目录',
    EISDIR: '目标文件路径指向了目录，请检查保存路径', EIO: '磁盘读写失败，请检查磁盘连接和健康状态',
    EMFILE: '打开的文件过多，请关闭其他占用程序后重试', ENFILE: '系统可用文件句柄不足，请关闭其他占用程序后重试',
  };
  const code = typeof error?.code === 'string' ? error.code : '';
  if (!Object.prototype.hasOwnProperty.call(reasons, code)) return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`${operation}失败：${reasons[code]}（${code}）`), { code, cause: error });
};

// This implementation is also used by the small main-thread vault/image
// writes, so save/restore keeps the exact same interrupted-rename guarantees.
const atomicWriteFile = (filePath, content, fs = nodeFs) => {
  const directory = path.dirname(filePath);
  try { fs.mkdirSync(directory, { recursive: true }); } catch (error) { throw localFileError(error); }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx');
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (error) {
    try { if (handle !== undefined) fs.closeSync(handle); } catch { /* preserve failure */ }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original */ }
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
    if (!recoveryFailed) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve failure */ }
    }
    throw localFileError(error);
  }
  try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch { /* saved main is durable */ }
  let directoryHandle;
  try {
    directoryHandle = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryHandle);
  } catch { /* Windows may not allow directory fsync. */ }
  finally { try { if (directoryHandle !== undefined) fs.closeSync(directoryHandle); } catch { /* best effort */ } }
};

const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const isPathInside = (root, candidate) => {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const createStateStore = ({ dataRoot, fs = nodeFs, now = Date.now }) => {
  // No operation accepts a caller-chosen write path. Main pins this root once.
  const root = path.resolve(dataRoot);
  const stateFile = path.join(root, 'project-state.json');
  const snapshotRoot = path.join(root, 'project-snapshots');
  const assetRoot = path.join(root, 'assets');
  const secretVaultFile = path.join(root, 'credentials.safe');
  const vaultTransactionFile = path.join(root, 'state-vault-transaction.json');
  const recoveryConfigFile = path.join(root, 'recovery-config.json');
  let lastSnapshotAt = 0;
  let lastRecoveryNotice = '';
  const readConfig = () => {
    try { return normalizeRecoveryConfig(JSON.parse(fs.readFileSync(recoveryConfigFile, 'utf8'))); }
    catch { return normalizeRecoveryConfig({}); }
  };
  const snapshotEntries = (validate = true) => {
    try {
      return fs.readdirSync(snapshotRoot).filter((entry) => /^project-.*\.json$/i.test(entry)).flatMap((id) => {
        try {
          const filePath = path.join(snapshotRoot, id);
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) return [];
          let valid = false;
          if (validate) { try { validateStateText(fs.readFileSync(filePath, 'utf8')); valid = true; } catch { /* reported */ } }
          return [{ id, name: id, createdAt: stat.mtimeMs, size: stat.size, valid }];
        } catch { return []; }
      }).sort((left, right) => right.createdAt - left.createdAt);
    } catch { return []; }
  };
  const writeSnapshot = (serialized, force = false) => {
    const timestamp = now();
    if (!force && timestamp - lastSnapshotAt < 10 * 60 * 1000) return null;
    const target = path.join(snapshotRoot, `project-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    atomicWriteFile(target, serialized, fs);
    lastSnapshotAt = timestamp;
    // Pruning only needs dates/sizes, not 20 complete JSON parses/checksums.
    for (const { id } of snapshotEntries(false).slice(readConfig().keepCount)) {
      try { fs.unlinkSync(path.join(snapshotRoot, id)); } catch { /* retain unavailable entries */ }
    }
    return target;
  };
  const fileSha256 = (filePath) => {
    const hash = createHash('sha256');
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    const descriptor = fs.openSync(filePath, 'r');
    try {
      let count;
      while ((count = fs.readSync(descriptor, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, count));
    } finally { fs.closeSync(descriptor); }
    return hash.digest('hex');
  };
  const replaceVault = (encrypted) => {
    if (encrypted !== null) {
      const bytes = Buffer.from(encrypted, 'base64');
      if (!fs.existsSync(secretVaultFile) || !fs.readFileSync(secretVaultFile).equals(bytes)) atomicWriteFile(secretVaultFile, bytes, fs);
      return;
    }
    // A failed deletion must not be reported as success and hydrate a key the
    // user has explicitly removed on their next launch.
    if (fs.existsSync(secretVaultFile)) fs.unlinkSync(secretVaultFile);
  };
  const recoverVaultTransaction = () => {
    if (!fs.existsSync(vaultTransactionFile)) return;
    let transaction;
    try {
      transaction = JSON.parse(fs.readFileSync(vaultTransactionFile, 'utf8'));
      const digest = (value) => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
      const encrypted = (value) => value === null || (typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value));
      if (transaction?.version !== 1 || !digest(transaction.previousStateChecksum)
        || !/^[a-f0-9]{64}$/u.test(transaction.nextStateChecksum || '')
        || !encrypted(transaction.previousVault) || !encrypted(transaction.nextVault)) throw new Error('invalid transaction');
    } catch {
      throw new Error('检测到未完成且无法校验的本地保存事务；项目和加密密钥均已保留，请先备份数据目录再检查');
    }
    const actual = fs.existsSync(stateFile) ? fileSha256(stateFile) : null;
    let encrypted;
    if (actual === transaction.nextStateChecksum) encrypted = transaction.nextVault;
    else if (actual === transaction.previousStateChecksum
      || (actual === null && fs.existsSync(`${stateFile}.previous`) && fileSha256(`${stateFile}.previous`) === transaction.previousStateChecksum)) encrypted = transaction.previousVault;
    else throw new Error('未完成保存事务与当前项目不匹配，已暂停保存以保护项目和密钥；请先备份数据目录再检查');
    replaceVault(encrypted);
    fs.unlinkSync(vaultTransactionFile);
  };
  const externalBackup = (payload, state, checksum) => {
    const config = readConfig();
    if (!config.backupOnSave || !config.backupDirectory) return null;
    const resolved = path.resolve(config.backupDirectory);
    if (pathKey(resolved) === pathKey(root)) return null;
    const targetRoot = path.join(resolved, '莲华视频导演台备份');
    const target = path.join(targetRoot, `project-latest-${checksum.slice(0, 12)}.json`);
    fs.mkdirSync(targetRoot, { recursive: true });
    if (!fs.existsSync(target)) atomicWriteFile(target, payload, fs);
    const manifest = [];
    const frozenImages = collectImageReferenceSnapshotsForExport(state);
    const frozenImageChecksums = new Map(frozenImages.map((asset) => [asset.relativePath, asset.checksum]));
    const seenPaths = new Set();
    for (const asset of [...stateAssets(state), ...frozenImages]) {
      if (seenPaths.has(asset.relativePath)) continue;
      seenPaths.add(asset.relativePath);
      try {
        const normalized = String(asset.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const source = path.resolve(assetRoot, normalized);
        const targetAssetRoot = path.resolve(targetRoot, 'assets');
        const destination = path.resolve(targetAssetRoot, normalized);
        if (!isPathInside(assetRoot, source) || !isPathInside(targetAssetRoot, destination)) throw new Error('备份资产路径越界');
        const stat = fs.statSync(source);
        if (!stat.isFile()) throw new Error('备份资产不是文件');
        // Realpath also rejects managed-directory symlinks escaping the store.
        if (!isPathInside(fs.realpathSync(assetRoot), fs.realpathSync(source))) throw new Error('备份资产真实路径越界');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!isPathInside(fs.realpathSync(targetRoot), fs.realpathSync(path.dirname(destination)))) throw new Error('备份目标真实路径越界');
        if (fs.existsSync(destination) && !isPathInside(fs.realpathSync(targetRoot), fs.realpathSync(destination))) throw new Error('备份目标真实路径越界');
        const assetChecksum = fileSha256(source);
        const frozenChecksum = frozenImageChecksums.get(asset.relativePath);
        if (frozenChecksum && frozenChecksum !== assetChecksum) throw new Error('图生图参考图快照校验不一致');
        if (asset.checksum && String(asset.checksum).toLowerCase() !== assetChecksum) throw new Error('备份源资产校验不一致');
        const matches = fs.existsSync(destination) && fs.statSync(destination).size === stat.size && fileSha256(destination) === assetChecksum;
        if (!matches) fs.copyFileSync(source, destination);
        if (!matches && fileSha256(destination) !== assetChecksum) throw new Error('备份资产写入校验失败');
        manifest.push({ id: asset.id, relativePath: asset.relativePath, checksum: assetChecksum, sizeBytes: stat.size, missing: false });
      } catch { manifest.push({ id: asset.id, relativePath: asset.relativePath, missing: true }); }
    }
    atomicWriteFile(path.join(targetRoot, 'backup-integrity.json'), JSON.stringify({ updatedAt: new Date(now()).toISOString(), stateFile: path.basename(target), stateChecksum: checksum, assets: manifest }, null, 2), fs);
    const backups = fs.readdirSync(targetRoot).filter((entry) => /^project-latest-.*\.json$/i.test(entry)).flatMap((entry) => {
      try { return [{ entry, time: fs.statSync(path.join(targetRoot, entry)).mtimeMs }]; } catch { return []; }
    }).sort((left, right) => right.time - left.time);
    for (const { entry } of backups.slice(config.keepCount)) fs.unlinkSync(path.join(targetRoot, entry));
    return target;
  };
  const save = async (content, encryptSecrets) => {
    const prepared = prepareStateForSave(content, now());
    recoverVaultTransaction();
    // Encryption is the sole main-thread callback and only carries credentials.
    // Full validation including the final byte limit precedes vault/state I/O.
    const vault = await encryptSecrets(prepared.secrets);
    if (vault?.mode === 'write') {
      if (!vault.encrypted?.byteLength) throw new Error('系统加密返回了空密钥数据，项目未保存');
    } else if (vault?.mode !== 'remove' && vault?.mode !== 'keep') throw new Error('系统加密未完成，项目未保存');
    const previousVault = fs.existsSync(secretVaultFile) ? fs.readFileSync(secretVaultFile).toString('base64') : null;
    const nextVault = vault.mode === 'write' ? Buffer.from(vault.encrypted).toString('base64') : vault.mode === 'remove' ? null : previousVault;
    const vaultChanged = nextVault !== previousVault;
    if (vaultChanged) {
      // Contains only already-encrypted bytes. A small, fsynced transaction
      // lets a restarted worker match keys to whichever state rename actually
      // committed, without replaying any generation request or changing the
      // existing project-state format.
      atomicWriteFile(vaultTransactionFile, JSON.stringify({ version: 1,
        previousStateChecksum: fs.existsSync(stateFile) ? fileSha256(stateFile) : fs.existsSync(`${stateFile}.previous`) ? fileSha256(`${stateFile}.previous`) : null,
        nextStateChecksum: prepared.checksum, previousVault, nextVault,
      }), fs);
    }
    try {
      if (vaultChanged) replaceVault(nextVault);
      atomicWriteFile(stateFile, prepared.payload, fs);
      if (vaultChanged) fs.unlinkSync(vaultTransactionFile);
    } catch (error) {
      try { recoverVaultTransaction(); }
      catch (recoveryError) {
        throw Object.assign(new Error(`${localFileError(error).message}；密钥事务已保留，待磁盘恢复后自动核对：${localFileError(recoveryError).message}`), { code: error?.code, cause: error });
      }
      throw localFileError(error);
    }
    writeSnapshot(prepared.payload);
    let external = null;
    let backupError = '';
    try { external = externalBackup(prepared.payload, prepared.state, prepared.checksum); }
    catch (error) { backupError = error instanceof Error ? error.message : String(error); }
    return { ok: true, checksum: prepared.checksum, externalBackup: external, backupError };
  };
  const load = (secrets) => {
    lastRecoveryNotice = '';
    try {
      if (!fs.existsSync(stateFile) && !fs.existsSync(`${stateFile}.previous`)) return { content: null, notice: '' };
      const state = validateStateText(fs.readFileSync(stateFile, 'utf8'));
      return { content: JSON.stringify(hydrateStateSecrets(state, secrets)), notice: '' };
    } catch (error) {
      try {
        const previous = validateStateText(fs.readFileSync(`${stateFile}.previous`, 'utf8'));
        lastRecoveryNotice = '检测到主状态不可读或上次保存中断，已从保留的上一份状态打开；原文件未自动改写';
        return { content: JSON.stringify(hydrateStateSecrets(previous, secrets)), notice: lastRecoveryNotice };
      } catch { /* try snapshots */ }
      for (const snapshot of snapshotEntries(false)) {
        try {
          const state = validateStateText(fs.readFileSync(path.join(snapshotRoot, snapshot.id), 'utf8'));
          lastRecoveryNotice = `主状态不可读，已从 ${new Date(snapshot.createdAt).toLocaleString()} 的恢复点打开`;
          return { content: JSON.stringify(hydrateStateSecrets(state, secrets)), notice: lastRecoveryNotice };
        } catch { /* try an older snapshot */ }
      }
      lastRecoveryNotice = `项目状态无法读取：${error instanceof Error ? error.message : String(error)}`;
      return { content: null, notice: lastRecoveryNotice };
    }
  };
  const recoveryStatus = () => {
    let stateValid = false;
    let checksum = '';
    let stateSize = 0;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      validateStateText(raw);
      stateValid = true;
      checksum = stateChecksum(raw);
      stateSize = Buffer.byteLength(raw, 'utf8');
    } catch { /* status reports invalid */ }
    return { dataRoot: root, stateFile, stateValid, stateChecksum: checksum, stateSize,
      snapshots: snapshotEntries(), recovery: readConfig(), lastRecoveryNotice };
  };
  const createRestorePoint = (content) => {
    const prepared = prepareStateForSave(content, now());
    return { ok: true, path: writeSnapshot(prepared.payload, true) };
  };
  const restoreSnapshot = (snapshotId, secrets) => {
    const id = path.basename(String(snapshotId || ''));
    if (id !== snapshotId || !/^project-.*\.json$/i.test(id)) throw new Error('恢复点名称无效');
    const raw = fs.readFileSync(path.join(snapshotRoot, id), 'utf8');
    const state = validateStateText(raw);
    if (fs.existsSync(stateFile)) writeSnapshot(fs.readFileSync(stateFile, 'utf8'), true);
    atomicWriteFile(stateFile, raw, fs);
    return JSON.stringify(hydrateStateSecrets(state, secrets));
  };
  const backup = (content) => {
    const prepared = prepareStateForSave(content, now());
    return externalBackup(prepared.payload, prepared.state, prepared.checksum);
  };
  return { save, load, recoveryStatus, createRestorePoint, restoreSnapshot, backup, recoverVaultTransaction };
};

module.exports = { createStateStore, atomicWriteFile, localFileError };
