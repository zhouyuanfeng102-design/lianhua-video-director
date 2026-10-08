const nodeFs = require('node:fs');
const path = require('node:path');
const { stateChecksum, validateStateText } = require('./stateSerialization.cjs');

const PROJECT_LIBRARY_FORMAT = 'lianhua-project-library-v1';
const PROJECT_LIBRARY_DIRECTORY = 'project-library';
const digestPattern = /^[a-f0-9]{64}$/u;
const isProjectLibraryManifest = (value) => value?.storageFormat === PROJECT_LIBRARY_FORMAT;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Blocks are immutable and never garbage-collected here: old snapshots and
// external backups may still point to any previously committed project hash.
const blockPath = (root, hash) => {
  if (!digestPattern.test(hash || '')) throw new Error('项目存储索引包含无效校验值');
  return path.join(root, PROJECT_LIBRARY_DIRECTORY, `${hash}.json`);
};
const checkBlockDirectory = (root, fs, create = false) => {
  const directory = path.join(root, PROJECT_LIBRARY_DIRECTORY);
  if (create) fs.mkdirSync(directory, { recursive: true });
  const actualRoot = fs.realpathSync(root);
  const actualDirectory = fs.realpathSync(directory);
  if (!inside(actualRoot, actualDirectory) || !samePath(path.dirname(actualDirectory), actualRoot)) {
    throw new Error('项目存储目录真实路径越界，现有存档未修改');
  }
  return directory;
};
const readBlock = (root, pointer, fs) => {
  if (!pointer || typeof pointer !== 'object' || typeof pointer.id !== 'string') throw new Error('项目存储索引结构无效');
  const file = blockPath(root, pointer.hash);
  const realDirectory = fs.realpathSync(path.join(root, PROJECT_LIBRARY_DIRECTORY));
  if (!samePath(path.dirname(fs.realpathSync(file)), realDirectory)) throw new Error('项目存储文件真实路径越界');
  const content = fs.readFileSync(file, 'utf8');
  if (stateChecksum(content) !== pointer.hash) throw new Error(`项目 ${pointer.id} 存储文件完整性校验失败`);
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`项目 ${pointer.id} 存储文件 JSON 无效`); }
  if (!value || typeof value !== 'object' || value.id !== pointer.id) throw new Error(`项目 ${pointer.id} 存储文件与索引不匹配`);
  return value;
};

const readProjectLibrary = (content, { root, fs = nodeFs }) => {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return validateStateText(content); }
  if (!isProjectLibraryManifest(parsed)) return validateStateText(content);
  // Manifest checksum protects pointer order, active project and settings.
  validateStateText(content, { allowLibraryManifest: true });
  if (parsed.integrity?.algorithm !== 'sha256' || !digestPattern.test(parsed.integrity?.checksum || '')) {
    throw new Error('项目库索引缺少完整性校验');
  }
  checkBlockDirectory(path.resolve(root), fs);
  const { storageFormat, integrity, ...state } = parsed;
  const cache = new Map();
  const resolve = (pointer) => {
    const key = `${pointer?.id}:${pointer?.hash}`;
    if (!cache.has(key)) cache.set(key, readBlock(path.resolve(root), pointer, fs));
    return cache.get(key);
  };
  state.project = resolve(state.project);
  if (state.projects !== undefined) {
    if (!Array.isArray(state.projects)) throw new Error('项目库索引项目列表无效');
    state.projects = state.projects.map((pointer) => {
      const project = resolve(pointer);
      return pointer.__activeProjectReference === true ? { id: project.id, __activeProjectReference: true } : project;
    });
  }
  return state;
};

const writeProjectLibrary = (state, { root, fs = nodeFs, writeFile, savedAt = Date.now() }) => {
  if (typeof writeFile !== 'function') throw new Error('项目库原子写入器缺失');
  const resolvedRoot = path.resolve(root);
  checkBlockDirectory(resolvedRoot, fs, true);
  const files = new Map();
  const writeProject = (project) => {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') throw new Error('项目缺少有效 ID，存档未修改');
    if (project !== state.project && project.__activeProjectReference === true && project.id === state.project.id
      && Object.keys(project).every((key) => key === 'id' || key === '__activeProjectReference')) {
      return { ...writeProject(state.project), __activeProjectReference: true };
    }
    const content = JSON.stringify(project);
    const hash = stateChecksum(content);
    const pointer = { id: project.id, hash };
    if (!files.has(hash)) {
      const file = blockPath(resolvedRoot, hash);
      if (fs.existsSync(file)) readBlock(resolvedRoot, pointer, fs);
      else {
        writeFile(file, content, fs);
        readBlock(resolvedRoot, pointer, fs);
      }
      files.set(hash, { ...pointer, relativePath: `${PROJECT_LIBRARY_DIRECTORY}/${hash}.json`, sizeBytes: Buffer.byteLength(content, 'utf8') });
    }
    return pointer;
  };
  const { integrity: oldIntegrity, storageFormat: oldFormat, ...metadata } = state;
  const manifest = { ...metadata, storageFormat: PROJECT_LIBRARY_FORMAT, project: writeProject(state.project) };
  if (state.projects !== undefined) {
    if (!Array.isArray(state.projects)) throw new Error('项目列表格式无效，存档未修改');
    manifest.projects = state.projects.map(writeProject);
  }
  const serialized = JSON.stringify(manifest);
  const integrity = { algorithm: 'sha256', checksum: stateChecksum(serialized), savedAt };
  const payload = `${serialized.slice(0, -1)},"integrity":${JSON.stringify(integrity)}}`;
  return { payload, checksum: stateChecksum(payload), projectFiles: [...files.values()] };
};

const projectLibrarySize = (content, { root, fs = nodeFs }) => {
  const indexSize = Buffer.byteLength(content, 'utf8');
  const parsed = JSON.parse(content);
  if (!isProjectLibraryManifest(parsed)) return { stateSize: indexSize, indexSize, storageFormat: 'legacy-json' };
  const hashes = new Set([parsed.project, ...(parsed.projects || [])].map((item) => item.hash));
  const stateSize = indexSize + [...hashes].reduce((sum, hash) => sum + fs.statSync(blockPath(root, hash)).size, 0);
  return { stateSize, indexSize, storageFormat: PROJECT_LIBRARY_FORMAT };
};

module.exports = { PROJECT_LIBRARY_FORMAT, PROJECT_LIBRARY_DIRECTORY, isProjectLibraryManifest,
  readProjectLibrary, writeProjectLibrary, projectLibrarySize };
