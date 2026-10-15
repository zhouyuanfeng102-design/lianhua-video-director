const nodeFs = require('node:fs');
const path = require('node:path');
const { stateChecksum, validateStateText } = require('./stateSerialization.cjs');

const PROJECT_LIBRARY_FORMAT = 'lianhua-project-library-v1';
const PROJECT_LIBRARY_DIRECTORY = 'project-library';
const PROJECT_SUMMARY_DIRECTORY = 'project-library-index';
const SUMMARY_FORMAT = 'lianhua-project-summary-v2';
const digestPattern = /^[a-f0-9]{64}$/u;
const summaryKeys = ['id', 'name', 'description', 'createdAt', 'updatedAt', 'backgroundSuspended'];
const schemaOf = (value, fallback = 0) => Number.isInteger(value) && value >= 0 ? value : fallback;
const isProjectReference = (project) => Boolean(project?.__projectLibraryReference);
const cleanProject = (project) => {
  const { __persistedProjectHash, __projectSchemaVersion, ...clean } = project;
  return clean;
};
// Directory metadata follows the renderer's placeholder normalization. Legacy
// blocks remain byte-for-byte intact even when their metadata is incomplete.
const projectSummary = (project) => ({
  id: project.id,
  name: typeof project.name === 'string' ? project.name : '',
  description: typeof project.description === 'string' ? project.description : '',
  createdAt: typeof project.createdAt === 'number' && Number.isFinite(project.createdAt) ? project.createdAt : 0,
  updatedAt: typeof project.updatedAt === 'number' && Number.isFinite(project.updatedAt) ? project.updatedAt : 0,
  ...(project.backgroundSuspended === undefined ? {} : { backgroundSuspended: project.backgroundSuspended === true }),
});
const projectCounts = (project) => Object.fromEntries(['sourceDocuments', 'scenes', 'storyboards', 'assets'].map((key) => [key, Array.isArray(project[key]) ? project[key].length : 0]));
// Keep unfinished work hydrated before the renderer starts recovery engines.
// This is deliberately conservative around ambiguous remote outcomes.
const hasPendingWork = (project) => Boolean(project.backgroundSuspended === true
  || project.videoWorkbench?.jobs?.some((job) => job.status === 'running')
  || (project.generationTasks || []).some((task) => {
    if (task.historyOnly) return false;
    const job = task.videoJob;
    return ['draft', 'preparing', 'submitting', 'submitted', 'queued', 'running', 'unknown', 'reconnecting', 'downloading', 'submission-unknown'].includes(task.status)
      || task.customImageSavePending
      || job && (['preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading', 'submission-unknown'].includes(job.stage)
        || ['waiting', 'ready', 'active'].includes(job.batchQueueState) || job.batchContinuation || job.resultSelectionRequired
        || job.resultAssetIds?.length > 1 && !job.trackingStopped || job.cancellationPending)
      || Boolean(task.resultUrl && !task.resultAssetId && !job?.resultAssetIds?.length);
  }));
const createProjectLibraryContext = () => ({ known: new Map() });
const contextKey = (root, pointer) => `${path.resolve(root)}:${pointer.id}:${pointer.hash}`;
const fileSignature = (root, pointer, fs) => {
  const stat = fs.statSync(blockPath(root, pointer.hash));
  if (!stat.isFile()) throw new Error('项目存储正文不是普通文件');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
};
const remember = (context, root, pointer, record, fs) => {
  context?.known.set(contextKey(root, pointer), { ...record, signature: fileSignature(root, pointer, fs) });
};
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
const readBlock = (root, pointer, fs, cache) => {
  if (!pointer || typeof pointer !== 'object' || typeof pointer.id !== 'string') throw new Error('项目存储索引结构无效');
  const file = blockPath(root, pointer.hash);
  const realDirectory = fs.realpathSync(path.join(root, PROJECT_LIBRARY_DIRECTORY));
  if (!samePath(path.dirname(fs.realpathSync(file)), realDirectory)) throw new Error('项目存储文件真实路径越界');
  const key = contextKey(root, pointer);
  if (cache?.has(key)) return cache.get(key);
  const content = fs.readFileSync(file, 'utf8');
  if (stateChecksum(content) !== pointer.hash) throw new Error(`项目 ${pointer.id} 存储文件完整性校验失败`);
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`项目 ${pointer.id} 存储文件 JSON 无效`); }
  if (!value || typeof value !== 'object' || value.id !== pointer.id) throw new Error(`项目 ${pointer.id} 存储文件与索引不匹配`);
  if (isProjectReference(value)) throw new Error('项目正文不能包含未展开的项目引用');
  cache?.set(key, value);
  return value;
};

const readManifest = (content) => {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!isProjectLibraryManifest(parsed)) return null;
  validateStateText(content, { allowLibraryManifest: true });
  if (parsed.integrity?.algorithm !== 'sha256' || !digestPattern.test(parsed.integrity?.checksum || '')) throw new Error('项目库索引缺少完整性校验');
  return parsed;
};
const summaryPath = (root, pointer) => path.join(root, PROJECT_SUMMARY_DIRECTORY, `${pointer.hash}.${schemaOf(pointer.schemaVersion)}.json`);
const summaryRecord = (project, pointer, schemaVersion) => ({ storageFormat: SUMMARY_FORMAT, id: pointer.id, hash: pointer.hash,
  schemaVersion, summary: projectSummary(project), counts: projectCounts(project), pendingWork: hasPendingWork(project) });
const persistSummary = (record, { root, fs, writeFile }) => {
  if (!writeFile) return;
  const file = summaryPath(root, record);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  if (!inside(fs.realpathSync(root), fs.realpathSync(directory))) throw new Error('项目摘要目录真实路径越界');
  if (fs.existsSync(file) && !samePath(path.dirname(fs.realpathSync(file)), fs.realpathSync(directory))) throw new Error('项目摘要文件真实路径越界');
  const serialized = JSON.stringify(record);
  writeFile(file, JSON.stringify({ ...record, checksum: stateChecksum(serialized) }), fs);
};
const loadSummary = (pointer, schemaVersion, options) => {
  const { root, fs, context, writeFile } = options;
  let record;
  try {
    const file = summaryPath(root, { ...pointer, schemaVersion });
    const directory = fs.realpathSync(path.join(root, PROJECT_SUMMARY_DIRECTORY));
    if (!inside(fs.realpathSync(root), directory) || !samePath(path.dirname(fs.realpathSync(file)), directory)) throw new Error('项目摘要路径越界');
    const { checksum, ...value } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.storageFormat !== SUMMARY_FORMAT || value.id !== pointer.id || value.hash !== pointer.hash
      || value.schemaVersion !== schemaVersion || stateChecksum(JSON.stringify(value)) !== checksum) throw new Error('项目摘要校验失败');
    record = value;
  } catch {
    const project = readBlock(root, pointer, fs);
    record = summaryRecord(project, pointer, schemaVersion);
    // The summary is a rebuildable cache. An unavailable cache must never
    // prevent opening an otherwise intact project library.
    try { persistSummary(record, { root, fs, writeFile }); } catch { /* rebuild on a later launch */ }
  }
  remember(context, root, pointer, record, fs);
  return record;
};
const referenceFor = (record) => ({ ...record.summary,
  __projectLibraryReference: { hash: record.hash, schemaVersion: record.schemaVersion, counts: record.counts } });
const hydratedProject = (project, pointer, schemaVersion) => ({ ...project, __persistedProjectHash: pointer.hash, __projectSchemaVersion: schemaVersion });

const readProjectLibrary = (content, { root, fs = nodeFs, blockCache, annotateProjects = false }) => {
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
    if (!cache.has(key)) {
      const project = readBlock(path.resolve(root), pointer, fs, blockCache);
      const schemaVersion = schemaOf(pointer.schemaVersion, schemaOf(parsed.schemaVersion));
      cache.set(key, annotateProjects ? hydratedProject(project, pointer, schemaVersion)
        : schemaVersion !== schemaOf(parsed.schemaVersion) ? { ...project, __projectSchemaVersion: schemaVersion } : project);
    }
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

const readWorkspaceLibrary = (content, { root, fs = nodeFs, writeFile, context = createProjectLibraryContext() }) => {
  const manifest = readManifest(content);
  if (!manifest) return validateStateText(content);
  root = path.resolve(root);
  checkBlockDirectory(root, fs);
  const { storageFormat, integrity, ...state } = manifest;
  const pointers = [manifest.project, ...(manifest.projects || [])];
  const records = new Map();
  for (const pointer of pointers) {
    blockPath(root, pointer?.hash);
    const schemaVersion = schemaOf(pointer.schemaVersion, schemaOf(manifest.schemaVersion));
    if (!records.has(pointer.hash)) records.set(pointer.hash, loadSummary(pointer, schemaVersion, { root, fs, writeFile, context }));
  }
  const full = new Map();
  const resolve = (pointer) => {
    const record = records.get(pointer.hash);
    if (pointer.id === manifest.project.id || record.pendingWork) {
      if (!full.has(pointer.hash)) full.set(pointer.hash, hydratedProject(readBlock(root, pointer, fs), pointer, record.schemaVersion));
      return full.get(pointer.hash);
    }
    return referenceFor(record);
  };
  state.project = resolve(manifest.project);
  if (manifest.projects !== undefined) state.projects = manifest.projects.map((pointer) => pointer.__activeProjectReference
    ? { id: pointer.id, __activeProjectReference: true } : resolve(pointer));
  return state;
};

const readLibraryProject = (content, projectId, requestedHash, { root, fs = nodeFs, writeFile, context = createProjectLibraryContext() }) => {
  if (typeof projectId !== 'string' || !projectId) throw new Error('项目 ID 无效');
  const manifest = readManifest(content);
  if (!manifest) {
    const state = validateStateText(content);
    const project = [state.project, ...(state.projects || [])].find((item) => item.id === projectId && !item.__activeProjectReference);
    if (!project) throw new Error('项目已不存在，请重新打开项目库');
    const hash = stateChecksum(JSON.stringify(project));
    if (requestedHash && requestedHash !== hash) throw new Error('项目版本已变化，请重新打开项目库');
    return { project, schemaVersion: schemaOf(state.schemaVersion), hash };
  }
  checkBlockDirectory(path.resolve(root), fs);
  const pointer = [manifest.project, ...(manifest.projects || [])].find((item) => item.id === projectId && (!requestedHash || item.hash === requestedHash));
  if (!pointer) throw new Error('项目已删除或版本已变化，请重新打开项目库');
  const schemaVersion = schemaOf(pointer.schemaVersion, schemaOf(manifest.schemaVersion));
  const project = readBlock(root, pointer, fs);
  const record = summaryRecord(project, pointer, schemaVersion);
  remember(context, root, pointer, record, fs);
  try { persistSummary(record, { root, fs, writeFile }); } catch { /* optional cache */ }
  return { project: hydratedProject(project, pointer, schemaVersion), schemaVersion, hash: pointer.hash };
};

const writeProjectLibrary = (state, { root, fs = nodeFs, writeFile, savedAt = Date.now(), context = createProjectLibraryContext() }) => {
  if (typeof writeFile !== 'function') throw new Error('项目库原子写入器缺失');
  const resolvedRoot = path.resolve(root);
  checkBlockDirectory(resolvedRoot, fs, true);
  const files = new Map();
  const hashes = {};
  const reuseReference = (project) => {
    const ref = project.__projectLibraryReference;
    const pointer = { id: project.id, hash: ref?.hash, schemaVersion: schemaOf(ref?.schemaVersion) };
    const file = blockPath(resolvedRoot, pointer.hash);
    let record = context.known.get(contextKey(resolvedRoot, pointer));
    if (!record) {
      let committed;
      try {
        const manifest = readManifest(fs.readFileSync(path.join(resolvedRoot, 'project-state.json'), 'utf8'));
        const match = [manifest?.project, ...(manifest?.projects || [])].find((item) => item?.id === pointer.id && item.hash === pointer.hash);
        if (match) committed = { ...match, schemaVersion: schemaOf(match.schemaVersion, schemaOf(manifest.schemaVersion)) };
      } catch { /* unknown references fail closed below */ }
      if (!committed || committed.schemaVersion !== pointer.schemaVersion) throw new Error('项目引用未在已保存项目库中确认，项目未保存');
      const verified = readBlock(resolvedRoot, pointer, fs);
      record = summaryRecord(verified, pointer, pointer.schemaVersion);
      remember(context, resolvedRoot, pointer, record, fs);
    }
    if (record.signature && record.signature !== fileSignature(resolvedRoot, pointer, fs)) readBlock(resolvedRoot, pointer, fs);
    const incomingSummary = projectSummary(project);
    const mismatches = [
      ...(record.schemaVersion !== pointer.schemaVersion ? ['schemaVersion'] : []),
      ...Object.keys(record.counts).filter((key) => ref.counts?.[key] !== record.counts[key]).map((key) => `counts.${key}`),
      ...summaryKeys.filter((key) => incomingSummary[key] !== record.summary[key]),
    ];
    if (mismatches.length) throw new Error(`未加载项目引用与已保存正文不一致，项目未保存（项目 ID：${String(project.id).slice(0, 120)}；字段：${mismatches.join('、')}）`);
    const metadata = new Set([...summaryKeys, '__projectLibraryReference', '__persistedProjectHash', '__projectSchemaVersion']);
    for (const [key, value] of Object.entries(project)) {
      if (metadata.has(key) || value === undefined || value === null || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
      throw new Error(`未加载项目引用包含正文修改（${key}），请先载入项目后重试保存`);
    }
    // Retain path checks even for a known immutable block. No body is read for
    // a pointer already issued from a checked manifest in this worker session.
    if (!samePath(path.dirname(fs.realpathSync(file)), fs.realpathSync(path.join(resolvedRoot, PROJECT_LIBRARY_DIRECTORY)))) throw new Error('项目存储文件真实路径越界');
    const sizeBytes = fs.statSync(file).size;
    files.set(pointer.hash, { ...pointer, relativePath: `${PROJECT_LIBRARY_DIRECTORY}/${pointer.hash}.json`, sizeBytes });
    hashes[project.id] = pointer.hash;
    return pointer;
  };
  const writeProject = (project) => {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') throw new Error('项目缺少有效 ID，存档未修改');
    if (project !== state.project && project.__activeProjectReference === true && project.id === state.project.id
      && Object.keys(project).every((key) => key === 'id' || key === '__activeProjectReference')) {
      return { ...writeProject(state.project), __activeProjectReference: true };
    }
    if (isProjectReference(project)) return reuseReference(project);
    const schemaVersion = schemaOf(project.__projectSchemaVersion, schemaOf(state.schemaVersion));
    const canonical = cleanProject(project);
    const content = JSON.stringify(canonical);
    const hash = stateChecksum(content);
    const pointer = { id: project.id, hash, schemaVersion };
    if (!files.has(hash)) {
      const file = blockPath(resolvedRoot, hash);
      if (fs.existsSync(file)) {
        const known = context.known.get(contextKey(resolvedRoot, pointer));
        if (!known || known.signature !== fileSignature(resolvedRoot, pointer, fs)) readBlock(resolvedRoot, pointer, fs);
      }
      else {
        writeFile(file, content, fs);
        readBlock(resolvedRoot, pointer, fs);
      }
      const record = summaryRecord(canonical, pointer, schemaVersion);
      if (!context.known.has(contextKey(resolvedRoot, pointer))) {
        try { persistSummary(record, { root: resolvedRoot, fs, writeFile }); } catch { /* rebuildable cache */ }
      }
      remember(context, resolvedRoot, pointer, record, fs);
      files.set(hash, { ...pointer, relativePath: `${PROJECT_LIBRARY_DIRECTORY}/${hash}.json`, sizeBytes: Buffer.byteLength(content, 'utf8') });
    }
    hashes[project.id] = hash;
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
  return { payload, checksum: stateChecksum(payload), projectFiles: [...files.values()], projectHashes: hashes };
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
  readProjectLibrary, readWorkspaceLibrary, readLibraryProject, createProjectLibraryContext, writeProjectLibrary, projectLibrarySize };
