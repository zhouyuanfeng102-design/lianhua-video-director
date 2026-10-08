const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readProjectLibrary, isProjectLibraryManifest } = require('./projectLibraryStore.cjs');
const { collectStateMediaFiles } = require('./stateMediaFiles.cjs');

const statOrMissing = (fs, file) => { try { return fs.lstatSync(file); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } };
const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const safeRelative = (value) => {
  const relative = typeof value === 'string' ? value.replace(/\\/gu, '/') : '';
  if (!relative || /^(?:\/|[a-z]:|[a-z]+:)/iu.test(relative) || /[:\u0000-\u001f]/u.test(relative)
    || !relative.split('/').every((part) => part && part !== '.' && part !== '..')) throw new Error('备份素材路径无效，未导入项目');
  return relative;
};
const safeDirectory = (fs, directory, create) => {
  let stat = statOrMissing(fs, directory);
  if (!stat && create) {
    const parent = path.dirname(directory);
    if (parent !== directory) safeDirectory(fs, parent, true);
    fs.mkdirSync(directory);
    stat = fs.lstatSync(directory);
  }
  if (!stat) throw new Error('备份素材目录不存在，未导入项目');
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('素材目录包含符号链接或非目录，已停止导入');
};
const safeMediaPath = (fs, root, relative, create = false) => {
  const parts = safeRelative(relative).split('/');
  let directory = path.resolve(root);
  safeDirectory(fs, directory, create);
  for (const part of parts.slice(0, -1)) { directory = path.join(directory, part); safeDirectory(fs, directory, create); }
  const file = path.join(directory, parts.at(-1));
  const stat = statOrMissing(fs, file);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('素材文件包含符号链接或非普通文件，已停止导入');
  return file;
};
const fileChecksum = (fs, file) => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(handle); }
};

const copyMedia = (fs, assetRoot, source, originalRelative, checksum) => {
  let relative = originalRelative;
  let destination = safeMediaPath(fs, assetRoot, relative, true);
  if (statOrMissing(fs, destination)) {
    if (fileChecksum(fs, destination) === checksum) return relative;
    // Keep both originals. Use content identity for the imported variant so a
    // same-name local asset and any historical task referencing it stay intact.
    relative = `${path.posix.dirname(originalRelative)}/${checksum}${path.posix.extname(originalRelative)}`.replace(/^\.\//u, '');
    destination = safeMediaPath(fs, assetRoot, relative, true);
    if (statOrMissing(fs, destination)) {
      if (fileChecksum(fs, destination) === checksum) return relative;
      throw new Error('同名 SHA-256 素材文件内容不一致，未覆盖已有图片');
    }
  }
  let created = false;
  try {
    fs.copyFileSync(source, destination, nodeFs.constants.COPYFILE_EXCL);
    created = true;
    const handle = fs.openSync(destination, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    safeMediaPath(fs, assetRoot, relative);
    if (fileChecksum(fs, destination) !== checksum) throw new Error('素材写入后 SHA-256 校验失败');
    return relative;
  } catch (error) {
    // COPYFILE_EXCL can leave a partial destination when a disk fails. It never
    // replaces an existing file; clean up only the file this copy created.
    if (created) { try { fs.unlinkSync(destination); } catch { /* no state references this failed copy */ } }
    throw error;
  }
};

const remapMediaRecords = (state, replacements) => {
  const media = (value) => {
    if (!value || typeof value !== 'object') return;
    const relative = typeof value.relativePath === 'string' ? value.relativePath.replace(/\\/gu, '/') : '';
    const replacement = replacements.get(relative);
    if (!replacement || replacement === relative) return;
    value.relativePath = replacement;
    if (typeof value.url === 'string' && value.url.startsWith('lianhua-asset://local/')) {
      value.url = `lianhua-asset://local/${replacement.split('/').map(encodeURIComponent).join('/')}`;
    }
  };
  const imageSnapshot = (snapshot) => {
    if (Array.isArray(snapshot?.referenceAssetSnapshots)) snapshot.referenceAssetSnapshots.forEach(media);
  };
  const task = (value) => {
    if (value?.kind === 'image') imageSnapshot(value);
    if (Array.isArray(value?.videoJob?.snapshot?.images)) value.videoJob.snapshot.images.forEach(media);
    media(value?.videoJob?.tailPreparation?.selection?.frame);
    const preparation = value?.videoJob?.tailPreparation;
    if (typeof preparation?.sourceRelativePath === 'string') {
      preparation.sourceRelativePath = replacements.get(preparation.sourceRelativePath.replace(/\\/gu, '/')) || preparation.sourceRelativePath;
    }
  };
  for (const project of [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])]) {
    if (Array.isArray(project?.assets)) for (const asset of project.assets) {
      media(asset); imageSnapshot(asset?.imageRegenerationSnapshot); task(asset?.videoSourceTask);
    }
    if (Array.isArray(project?.generationTasks)) project.generationTasks.forEach(task);
  }
};

/** The main process must approve the selected file before calling this helper.
 * Legacy JSON remains byte-for-byte compatible. External library manifests
 * are returned only after their project blocks and referenced media succeed. */
const readProjectLibraryImport = (content, { filePath, dataRoot, assetRoot, fs = nodeFs, copyImportedAssetIntoStore }) => {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (!isProjectLibraryManifest(parsed)) return content;
  const selectedDirectory = path.dirname(path.resolve(filePath));
  const sourceRoot = path.basename(selectedDirectory).toLowerCase() === 'project-snapshots'
    ? path.dirname(selectedDirectory) : selectedDirectory;
  const state = readProjectLibrary(content, { root: sourceRoot, fs });
  const localRoot = path.resolve(dataRoot);
  if (pathKey(sourceRoot) === pathKey(localRoot)
    || fs.existsSync(localRoot) && pathKey(fs.realpathSync(sourceRoot)) === pathKey(fs.realpathSync(localRoot))) return JSON.stringify(state);
  const sourceAssets = path.join(sourceRoot, 'assets');
  const replacements = new Map();
  const copy = copyImportedAssetIntoStore || ((source, relative, checksum) => copyMedia(fs, assetRoot, source, relative, checksum));
  for (const asset of collectStateMediaFiles(state)) {
    try {
      const relative = safeRelative(asset.relativePath);
      const source = safeMediaPath(fs, sourceAssets, relative);
      if (!statOrMissing(fs, source)) throw new Error('备份中缺少此素材文件');
      const checksum = fileChecksum(fs, source);
      if (asset.checksum && asset.checksum.toLowerCase() !== checksum) throw new Error('备份素材 SHA-256 校验失败');
      // An injected copier is still checked at both boundaries and never gets
      // an unchecked path from the imported document.
      safeMediaPath(fs, assetRoot, relative, true);
      const imported = safeRelative(copy(source, relative, checksum));
      const destination = safeMediaPath(fs, assetRoot, imported);
      if (fileChecksum(fs, destination) !== checksum) throw new Error('素材写入后 SHA-256 校验失败');
      if (imported !== relative) replacements.set(relative, imported);
    } catch (error) {
      const reason = error?.code === 'ENOSPC' ? '磁盘空间不足' : error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`备份素材“${asset.relativePath}”恢复失败：${reason}。未导入项目；原备份和已有素材未覆盖。`),
        { ...(error?.code ? { code: error.code } : {}), cause: error });
    }
  }
  remapMediaRecords(state, replacements);
  return JSON.stringify(state);
};

module.exports = { readProjectLibraryImport };
