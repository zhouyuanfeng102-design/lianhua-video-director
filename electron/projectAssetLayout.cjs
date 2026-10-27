const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
const RESERVED_FOLDER = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const MAX_FOLDER_LENGTH = 80;
const MAX_READABLE_MEDIA_STEM_LENGTH = 140;

const normalizeRelative = (value) => String(value || '').replace(/\\/gu, '/').replace(/^\/+/u, '');
const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const isInside = (root, candidate) => {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const clipCodePoints = (value, length) => [...String(value || '')].slice(0, Math.max(0, length)).join('').replace(/[. ]+$/gu, '');
const clipFileStem = (value, length) => String(value || '').slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
const readableMediaNameKey = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
  .replace(/[. ]+$/gu, '')
  .toUpperCase();

/** Windows folder name taken from the project title the user already sees. */
const sanitizeProjectFolderName = (name) => {
  const stem = clipCodePoints(String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '')
    .replace(/^ +/u, '')
    .replace(/[. ]+$/gu, '')
    .trim(), MAX_FOLDER_LENGTH);
  if (!stem || RESERVED_FOLDER.test(stem)) return '未命名项目';
  return stem;
};

const idToken = (id) => String(id || '').replace(/[^a-z0-9]/giu, '');
const rosterFrom = (projects) => {
  const byId = new Map();
  for (const project of projects || []) {
    if (!project || typeof project.id !== 'string' || !project.id) continue;
    const name = typeof project.name === 'string' ? project.name : undefined;
    const current = byId.get(project.id);
    if (!current) byId.set(project.id, { id: project.id, ...(name !== undefined ? { name } : {}) });
    else if (current.name === undefined && name !== undefined) current.name = name;
  }
  return [...byId.values()];
};

/** The first project id keeps the plain title. Later collisions append a stable id slice. */
const projectFolderNames = (projects) => {
  const groups = new Map();
  for (const project of rosterFrom(projects)) {
    if (typeof project.name !== 'string') continue;
    const stem = sanitizeProjectFolderName(project.name);
    const list = groups.get(stem) || [];
    list.push(project);
    groups.set(stem, list);
  }
  const names = new Map();
  const used = new Set();
  for (const [stem, list] of groups) {
    const ordered = [...list].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    ordered.forEach((project, index) => {
      if (index === 0 && !used.has(stem)) {
        names.set(project.id, stem);
        used.add(stem);
        return;
      }
      const token = idToken(project.id);
      const lengths = [];
      for (let length = 6; length <= Math.max(6, token.length); length += 1) lengths.push(length);
      if (!lengths.length) lengths.push(0);
      let chosen = '';
      for (const length of lengths) {
        const suffix = token ? token.slice(-length) : 'id';
        const base = clipCodePoints(stem, MAX_FOLDER_LENGTH - suffix.length - 1) || '未命名项目';
        const candidate = `${base}-${suffix}`;
        if (!used.has(candidate)) { chosen = candidate; break; }
      }
      if (!chosen) {
        const suffix = token || 'id';
        chosen = `${clipCodePoints(stem, 40) || '未命名项目'}-${suffix}`.slice(0, MAX_FOLDER_LENGTH);
      }
      names.set(project.id, chosen);
      used.add(chosen);
    });
  }
  return names;
};

const projectFolderName = (project, projects) => {
  if (!project || typeof project.id !== 'string' || typeof project.name !== 'string') return '';
  const list = (projects || []).some((item) => item && item.id === project.id) ? projects : [...(projects || []), project];
  return projectFolderNames(list).get(project.id) || '';
};

const kindDirectory = (kind, project, projects) => {
  if (!MEDIA_KINDS.has(kind)) return kind;
  const folder = projectFolderName(project, projects);
  return folder ? `projects/${folder}/${kind}` : kind;
};

const isLegacyAssetRelative = (value) => {
  const parts = normalizeRelative(value).split('/');
  return parts.length >= 2 && MEDIA_KINDS.has(parts[0]);
};

const relocatedRelative = (value, folder) => {
  const normalized = normalizeRelative(value);
  if (!folder || !normalized) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  if (parts[0] === 'projects' && parts.length >= 4 && MEDIA_KINDS.has(parts[2])) {
    if (parts[1] === folder) return normalized;
    return ['projects', folder, ...parts.slice(2)].join('/');
  }
  if (MEDIA_KINDS.has(parts[0])) return ['projects', folder, ...parts].join('/');
  return '';
};

const assetUrl = (relative) => `lianhua-asset://local/${relative.split('/').map(encodeURIComponent).join('/')}`;
const decodeAssetUrl = (value) => {
  const url = String(value || '');
  if (!url.startsWith('lianhua-asset://local/')) return '';
  try {
    return new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch { return ''; }
};

const visitMedia = (project, visit) => {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value.relativePath === 'string') visit(value, 'relativePath');
    if (typeof value.sourceRelativePath === 'string') visit(value, 'sourceRelativePath');
    for (const child of Object.values(value)) walk(child);
  };
  walk(project);
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

const regularFile = (fs, file) => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};

const resolveInside = (root, relative) => {
  const normalized = normalizeRelative(relative);
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..')) return '';
  const resolved = path.resolve(root, ...parts);
  return isInside(root, resolved) ? resolved : '';
};

const diskOwners = (dataRoot, fs) => {
  const owners = new Map();
  const directory = path.join(dataRoot, 'project-library');
  let names = [];
  try { names = fs.readdirSync(directory); } catch { return owners; }
  for (const name of names) {
    if (!String(name).endsWith('.json')) continue;
    let project;
    try { project = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
    const id = typeof project?.id === 'string' ? project.id : '';
    if (!id) continue;
    visitMedia(project, (object, key) => {
      const relative = normalizeRelative(object[key]);
      if (!relative) return;
      let ids = owners.get(relative);
      if (!ids) owners.set(relative, ids = new Set());
      ids.add(id);
    });
  }
  return owners;
};

const projectsOf = (state) => {
  const list = [];
  const seen = new Set();
  for (const project of [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])]) {
    if (!project || typeof project !== 'object' || seen.has(project)) continue;
    seen.add(project);
    list.push(project);
  }
  return list;
};

/**
 * Move files only this project references into projects/{name}/{image|video|audio}.
 * A file another project still references is copied. A missing or locked file keeps its old path.
 * Unreferenced files outside this walk are left where they are.
 */
const placeProjectAssets = (state, { assetRoot, dataRoot = '', fs = nodeFs, deferDeletes = false } = {}) => {
  const moves = [];
  const deletes = [];
  if (!state || typeof state !== 'object' || typeof assetRoot !== 'string' || !assetRoot.trim()) {
    return { state, moves, deletes };
  }
  const root = path.resolve(assetRoot);
  const projects = projectsOf(state);
  const names = projectFolderNames(projects);
  const fullProjects = projects.filter((project) => !project.__projectLibraryReference && names.get(project.id));
  const pending = [];
  for (const project of fullProjects) {
    const folder = names.get(project.id);
    const groups = new Map();
    const reservedNames = new Map();
    visitMedia(project, (object, key) => {
      const current = normalizeRelative(object[key]);
      let destination = relocatedRelative(current, folder);
      const checksumImage = isChecksumImageRelative(current);
      if (!destination || (destination === current && !checksumImage)) return;
      let group = groups.get(current);
      if (!group) {
        if (checksumImage) {
          const directory = destination.split('/').slice(0, -1).join('/');
          const extension = path.extname(current.split('/').pop() || '') || '.png';
          const folderAbs = path.join(root, ...directory.split('/'));
          let names = [];
          try {
            names = fs.readdirSync(folderAbs).filter((name) => regularFile(fs, path.join(folderAbs, name)));
          } catch { names = []; }
          const reserved = reservedNames.get(directory) || [];
          const digest = typeof object.checksum === 'string' ? object.checksum.toLowerCase() : '';
          const readable = allocateReadableName([...names, ...reserved], `${imageDisplayStem(object)}${extension}`, digest, (name) => fileChecksum(fs, path.join(folderAbs, name)), { numbered: true });
          reserved.push(readable);
          reservedNames.set(directory, reserved);
          destination = `${directory}/${readable}`;
        }
        if (destination === current) return;
        groups.set(current, group = { current, destination, checksum: '', conflict: false });
      }
      const checksum = typeof object.checksum === 'string' ? object.checksum.toLowerCase() : '';
      if (checksum) {
        if (group.checksum && group.checksum !== checksum) group.conflict = true;
        else group.checksum = checksum;
      }
    });
    for (const group of groups.values()) if (!group.conflict) pending.push({ project, ...group });
  }
  if (!pending.length) return { state, moves, deletes };

  const owners = dataRoot ? diskOwners(dataRoot, fs) : new Map();
  const payloadPaths = new Map();
  for (const project of fullProjects) {
    const paths = new Set();
    visitMedia(project, (object, key) => {
      const relative = normalizeRelative(object[key]);
      if (relative) paths.add(relative);
    });
    payloadPaths.set(project.id, paths);
  }
  const shared = (relative, projectId) => {
    const ids = new Set(owners.get(relative) || []);
    for (const [id, paths] of payloadPaths) {
      if (paths.has(relative)) ids.add(id);
      else ids.delete(id);
    }
    ids.delete(projectId);
    return ids.size > 0;
  };

  const placed = new Map();
  for (const item of pending) {
    const key = `${item.project.id}\0${item.current}`;
    if (placed.has(key)) continue;
    let outcome = '';
    try {
      const source = resolveInside(root, item.current);
      const destination = resolveInside(root, item.destination);
      if (!source || !destination || pathKey(source) === pathKey(destination)) { placed.set(key, ''); continue; }
      const sourceStat = regularFile(fs, source);
      const destinationStat = regularFile(fs, destination);
      const sameContent = (file) => item.checksum
        ? fileChecksum(fs, file) === item.checksum
        : Boolean(sourceStat) && fileChecksum(fs, source) === fileChecksum(fs, file);
      if (!sourceStat && !destinationStat) { placed.set(key, ''); continue; }
      if (!sourceStat && destinationStat) {
        placed.set(key, item.checksum && sameContent(destination) ? item.destination : '');
        continue;
      }
      if (destinationStat) {
        if (!sameContent(destination)) { placed.set(key, ''); continue; }
        outcome = item.destination;
        if (!shared(item.current, item.project.id)) deletes.push(source);
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try { fs.copyFileSync(source, destination, nodeFs.constants.COPYFILE_EXCL); }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        if (!sameContent(destination)) {
          if (!destinationStat) { try { fs.unlinkSync(destination); } catch { /* old path stays in the project */ } }
          placed.set(key, '');
          continue;
        }
        outcome = item.destination;
        if (!shared(item.current, item.project.id)) deletes.push(source);
      }
      placed.set(key, outcome);
    } catch {
      // A locked or unreadable file stays on its original path. The save continues.
      placed.set(key, '');
    }
  }

  for (const project of fullProjects) {
    const folder = names.get(project.id);
    visitMedia(project, (object, key) => {
      const current = normalizeRelative(object[key]);
      const destination = placed.get(`${project.id}\0${current}`);
      if (!destination || destination === current) return;
      object[key] = destination;
      if (key === 'relativePath') {
        if (isChecksumImageRelative(current)) object.fileName = destination.split('/').pop();
        if (typeof object.url === 'string' && decodeAssetUrl(object.url) === current) object.url = assetUrl(destination);
      }
      moves.push({ projectId: project.id, from: current, to: destination });
    });
  }

  const uniqueDeletes = [];
  const seenDeletes = new Set();
  for (const file of deletes) {
    const key = pathKey(file);
    if (seenDeletes.has(key) || !isInside(root, file)) continue;
    seenDeletes.add(key);
    if (deferDeletes) uniqueDeletes.push(file);
    else {
      try { if (regularFile(fs, file)) fs.unlinkSync(file); } catch { /* leftover stays */ }
    }
  }
  return { state, moves, deletes: uniqueDeletes };
};

const VERSION_SUFFIX = /(?:\s*·\s*)?第\s*\d+\s*版$/u;
const stemWithoutVersion = (stem) => String(stem || '').replace(VERSION_SUFFIX, '').trim() || String(stem || '');

/** Version numbers are chosen from one directory listing, so each project folder counts on its own.
 * Images pass numbered:true so the first file is already 「名称 · 第 1 版」. Videos keep the first file unsuffixed. */
const allocateReadableName = (existingNames, fileName, checksum, checksumOf, options = {}) => {
  const numbered = options.numbered === true;
  const entries = new Map();
  for (const name of existingNames || []) {
    if (name) entries.set(readableMediaNameKey(name), name);
  }
  if (numbered && checksum) {
    for (const name of entries.values()) {
      if (CHECKSUM_IMAGE_NAME.test(name)) continue;
      try { if (checksumOf(name) === checksum) return name; } catch { /* An unreadable file stays occupied. */ }
    }
  }
  const extension = path.extname(String(fileName || ''));
  const originalStem = stemWithoutVersion(extension ? String(fileName).slice(0, -extension.length) : String(fileName || ''));
  for (let version = 1; version < 100_000; version += 1) {
    const suffix = numbered || version > 1 ? ` · 第 ${version} 版` : '';
    const stem = clipFileStem(originalStem, MAX_READABLE_MEDIA_STEM_LENGTH - suffix.length).trimEnd();
    const candidate = `${stem}${suffix}${extension}`;
    const existing = entries.get(readableMediaNameKey(candidate));
    if (!existing) return candidate;
    try {
      if (checksumOf(existing) === checksum) return existing;
    } catch { /* An unreadable collision stays occupied. */ }
  }
  throw new Error('同名文件版本过多，无法分配安全文件名');
};

const CHECKSUM_IMAGE_NAME = /^[a-f0-9]{64}\.(?:png|jpe?g|webp)$/iu;
const isChecksumImageRelative = (relative) => CHECKSUM_IMAGE_NAME.test(String(relative || '').split('/').pop() || '');
const imageDisplayStem = (object) => {
  const raw = String(object?.name || object?.fileName || '').trim();
  const stem = raw.replace(/\.[a-z0-9]{2,5}$/iu, '').trim();
  if (!stem || /^[a-f0-9]{64}$/iu.test(stem)) return '未命名图片';
  return stem;
};

module.exports = {
  sanitizeProjectFolderName,
  projectFolderName,
  projectFolderNames,
  kindDirectory,
  isLegacyAssetRelative,
  relocatedRelative,
  placeProjectAssets,
  allocateReadableName,
  assetUrl,
};
