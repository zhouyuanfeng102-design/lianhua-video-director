const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');

const normalizeStorageLocationConfig = (value) => ({
  mode: value?.mode === 'custom' ? 'custom' : 'default',
  directory: value?.mode === 'custom' && typeof value.directory === 'string' ? value.directory.trim() : '',
  migrationFrom: typeof value?.migrationFrom === 'string' ? value.migrationFrom.trim() : '',
  migrationId: typeof value?.migrationId === 'string' ? value.migrationId.trim() : '',
});

const readStorageLocationConfig = (filePath, fs = nodeFs) => {
  try { return normalizeStorageLocationConfig(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { return normalizeStorageLocationConfig(undefined); }
};

const writeStorageLocationConfig = (filePath, value, fs = nodeFs) => {
  const config = normalizeStorageLocationConfig(value);
  const directory = nodePath.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${filePath}.previous`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', flag: 'wx' });
  let movedPrevious = false;
  try {
    if (fs.existsSync(filePath)) {
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(filePath, previous);
      movedPrevious = true;
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { if (!fs.existsSync(filePath) && movedPrevious && fs.existsSync(previous)) fs.renameSync(previous, filePath); } catch { /* Keep the previous config for recovery. */ }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Preserve the write failure. */ }
    throw error;
  }
  try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch { /* The new config is already active. */ }
  return config;
};

const isSamePath = (left, right, platform = process.platform) => {
  const a = nodePath.resolve(left);
  const b = nodePath.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const isPathInside = (root, candidate, platform = process.platform) => {
  const resolvedRoot = nodePath.resolve(root);
  const resolvedCandidate = nodePath.resolve(candidate);
  const normalizedRoot = platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const normalizedCandidate = platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const relative = nodePath.relative(normalizedRoot, normalizedCandidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
};

const pathsOverlap = (left, right, platform = process.platform) => (
  isSamePath(left, right, platform) || isPathInside(left, right, platform) || isPathInside(right, left, platform)
);

const directoryHasEntries = (directory, fs = nodeFs) => {
  try { return fs.readdirSync(directory).length > 0; }
  catch { return false; }
};

const isManagedDataRoot = (directory, fs = nodeFs, path = nodePath) => (
  ['project-state.json', 'project-library', 'project-library-index', 'assets', 'session', 'project-snapshots']
    .some((entry) => fs.existsSync(path.join(directory, entry)))
);

const markerName = (migrationId) => `.lianhua-migration-${migrationId}.json`;
const readMarker = (root, migrationId, fs = nodeFs, path = nodePath) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, markerName(migrationId)), 'utf8')); }
  catch { return null; }
};

const copyDirectoryContents = (source, destination, fs, path, migrationId) => {
  let copiedFiles = 0;
  let copiedBytes = 0;
  const copyDirectory = (fromDirectory, toDirectory) => {
    fs.mkdirSync(toDirectory, { recursive: true });
    for (const entry of fs.readdirSync(fromDirectory, { withFileTypes: true })) {
      if (fromDirectory === source && entry.name.startsWith('.lianhua-migration-') && entry.name.endsWith('.json')) continue;
      const from = path.join(fromDirectory, entry.name);
      const to = path.join(toDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`数据目录包含符号链接，无法安全迁移：${from}`);
      if (entry.isDirectory()) {
        copyDirectory(from, to);
        continue;
      }
      if (!entry.isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const temporary = `${to}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.copyFileSync(from, temporary);
        const sourceStat = fs.statSync(from);
        const copiedStat = fs.statSync(temporary);
        if (sourceStat.size !== copiedStat.size) throw new Error(`文件复制后大小不一致：${from}`);
        if (fs.existsSync(to)) fs.unlinkSync(to);
        fs.renameSync(temporary, to);
        copiedFiles += 1;
        copiedBytes += copiedStat.size;
      } catch (error) {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Preserve the copy failure. */ }
        throw error;
      }
    }
  };
  copyDirectory(source, destination);
  return { copiedFiles, copiedBytes };
};

const hasOwnedStagingMarker = (stagingRoot, source, target, fs, path) => {
  for (const name of fs.readdirSync(stagingRoot)) {
    if (!name.startsWith('.lianhua-migration-') || !name.endsWith('.json')) continue;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(stagingRoot, name), 'utf8'));
      if (marker.source === source && marker.target === target && markerName(marker.migrationId) === name) return true;
    } catch { /* Ignore malformed marker files. */ }
  }
  return false;
};

const removeStaleEntries = (source, destination, fs, path) => {
  if (!fs.existsSync(destination)) return;
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (entry.name.startsWith('.lianhua-migration-') && entry.name.endsWith('.json')) continue;
    const destinationEntry = path.join(destination, entry.name);
    const sourceEntry = path.join(source, entry.name);
    if (!fs.existsSync(sourceEntry)) {
      fs.rmSync(destinationEntry, { recursive: true, force: true });
      continue;
    }
    const sourceStat = fs.lstatSync(sourceEntry);
    const destinationStat = fs.lstatSync(destinationEntry);
    if (sourceStat.isDirectory() !== destinationStat.isDirectory()) {
      fs.rmSync(destinationEntry, { recursive: true, force: true });
      continue;
    }
    if (sourceStat.isDirectory()) removeStaleEntries(sourceEntry, destinationEntry, fs, path);
  }
};

const migrateStorageDirectory = ({ source, target, migrationId, fs = nodeFs, path = nodePath }) => {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  if (!sourceRoot || !targetRoot || !migrationId) throw new Error('储存目录迁移参数不完整');
  if (pathsOverlap(sourceRoot, targetRoot)) throw new Error('新旧储存位置不能互相包含');
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error('原储存目录不可用，未切换文件位置');

  const completedMarker = readMarker(targetRoot, migrationId, fs, path);
  if (completedMarker?.source === sourceRoot && completedMarker?.target === targetRoot) {
    try { fs.unlinkSync(path.join(targetRoot, markerName(migrationId))); } catch { /* Completed data remains usable. */ }
    return { copiedFiles: 0, copiedBytes: 0, backupPath: '', alreadyCompleted: true };
  }

  const targetParent = path.dirname(targetRoot);
  fs.mkdirSync(targetParent, { recursive: true });
  const stagingRoot = `${targetRoot}.lianhua-migration-stage`;
  let stagingExists = fs.existsSync(stagingRoot);
  if (stagingExists) {
    const stagingStat = fs.lstatSync(stagingRoot);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw new Error(`迁移暂存路径不是安全文件夹：${stagingRoot}`);
    }
    const entries = fs.readdirSync(stagingRoot);
    const markerPath = path.join(stagingRoot, markerName(migrationId));
    const currentMarker = readMarker(stagingRoot, migrationId, fs, path);
    const partialCurrentMarkerOnly = entries.length === 1 && entries[0] === markerName(migrationId) && !currentMarker;
    if (entries.length > 0 && !partialCurrentMarkerOnly) {
      if (!hasOwnedStagingMarker(stagingRoot, sourceRoot, targetRoot, fs, path)) {
        throw new Error(`迁移暂存目录已存在且不属于本次迁移：${stagingRoot}`);
      }
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      stagingExists = false;
    } else if (partialCurrentMarkerOnly) {
      fs.unlinkSync(markerPath);
    }
  }
  if (!stagingExists) {
    fs.mkdirSync(stagingRoot, { recursive: true });
    const stagedMarker = { source: sourceRoot, target: targetRoot, migrationId };
    fs.writeFileSync(path.join(stagingRoot, markerName(migrationId)), JSON.stringify(stagedMarker), { encoding: 'utf8', flag: 'wx' });
  } else if (fs.readdirSync(stagingRoot).length === 0) {
    const stagedMarker = { source: sourceRoot, target: targetRoot, migrationId };
    fs.writeFileSync(path.join(stagingRoot, markerName(migrationId)), JSON.stringify(stagedMarker), { encoding: 'utf8', flag: 'wx' });
  }

  removeStaleEntries(sourceRoot, stagingRoot, fs, path);
  const copyResult = copyDirectoryContents(sourceRoot, stagingRoot, fs, path, migrationId);
  const markerPath = path.join(stagingRoot, markerName(migrationId));
  fs.writeFileSync(markerPath, JSON.stringify({ source: sourceRoot, target: targetRoot, migrationId }), 'utf8');

  let backupPath = '';
  if (fs.existsSync(targetRoot)) {
    if (directoryHasEntries(targetRoot, fs) && !isManagedDataRoot(targetRoot, fs, path)) {
      throw new Error(`目标目录并非空目录或莲华数据目录：${targetRoot}`);
    }
    if (directoryHasEntries(targetRoot, fs)) {
      backupPath = `${targetRoot}.lianhua-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
      fs.renameSync(targetRoot, backupPath);
    } else {
      fs.rmdirSync(targetRoot);
    }
  }

  try {
    fs.renameSync(stagingRoot, targetRoot);
  } catch (error) {
    if (backupPath && !fs.existsSync(targetRoot) && fs.existsSync(backupPath)) {
      try { fs.renameSync(backupPath, targetRoot); } catch { /* Keep the backup path for manual recovery. */ }
    }
    throw error;
  }
  try { fs.unlinkSync(path.join(targetRoot, markerName(migrationId))); } catch { /* Startup can finish marker cleanup. */ }
  return { ...copyResult, backupPath, alreadyCompleted: false };
};

module.exports = {
  directoryHasEntries,
  isManagedDataRoot,
  isPathInside,
  isSamePath,
  migrateStorageDirectory,
  normalizeStorageLocationConfig,
  pathsOverlap,
  readStorageLocationConfig,
  writeStorageLocationConfig,
};
