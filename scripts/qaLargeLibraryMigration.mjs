// Opt-in, read-only-source migration check. All writes stay in a new isolated
// workspace directory. The report contains counts and hashes, never user text.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createStateStore } = require('../electron/statePersistenceStore.cjs');
const { stripSecrets, stateChecksum, secretCount, collectSecrets } = require('../electron/stateSerialization.cjs');
const { readProjectLibrary } = require('../electron/projectLibraryStore.cjs');
const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = process.argv[2];
if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('An explicit absolute source state path is required');
const outputRoot = path.join(workspace, `.qa-large-library-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
if (path.dirname(path.resolve(outputRoot)) !== workspace || !path.basename(outputRoot).startsWith('.qa-large-library-')) throw new Error('Invalid isolated output path');
fs.mkdirSync(outputRoot, { recursive: false });
const dataRoot = path.join(outputRoot, 'profile');
fs.mkdirSync(dataRoot);
const stateFile = path.join(dataRoot, 'project-state.json');
const reportFile = path.join(outputRoot, 'report.json');
const report = { schema: 'large-library-migration-qa-v1', createdAt: new Date().toISOString(), sourceReadOnly: true,
  isolatedProfile: dataRoot, credentialsFileRead: false, paidApiCalls: 0, complete: false,
  scope: 'Existing managed external assets are not copied or revalidated. Every converted inline image is byte-checked. No production state directory is written.' };
let stage = 'read-source';
const begin = performance.now();
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => {
  const digest = createHash('sha256');
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, bytes, 0, bytes.length, null))) digest.update(bytes.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
};
const ensure = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { qaCode: code }); };
const decode = (url) => {
  const index = url.indexOf(',');
  ensure(index > 0, 'INLINE_URL_INVALID');
  return /;base64$/iu.test(url.slice(0, index)) ? Buffer.from(url.slice(index + 1).replace(/\s+/gu, ''), 'base64')
    : Buffer.from(decodeURIComponent(url.slice(index + 1)), 'utf8');
};
const inlineUrl = (value) => typeof value?.dataUrl === 'string' && /^data:image\//iu.test(value.dataUrl.trim()) ? value.dataUrl
  : typeof value?.url === 'string' && /^data:image\//iu.test(value.url.trim()) ? value.url : undefined;
const countInline = (value) => {
  if (!value || typeof value !== 'object') return 0;
  let count = !Array.isArray(value) && inlineUrl(value) ? 1 : 0;
  for (const item of Object.values(value)) if (item && typeof item === 'object') count += countInline(item);
  return count;
};
const stableFields = new Set(['dataUrl', 'relativePath', 'checksum', 'sizeBytes', 'mimeType', 'mediaType', 'managed', 'missing', 'url']);
const convertedImages = [];
let comparedNodes = 0;
let comparedStrings = 0;
const compare = (before, after) => {
  comparedNodes += 1;
  if (typeof before === 'string') comparedStrings += 1;
  if (before === after) return;
  ensure(typeof before === typeof after && before !== null && after !== null, 'STATE_VALUE_CHANGED');
  if (typeof before !== 'object') ensure(false, 'STATE_PRIMITIVE_CHANGED');
  ensure(Array.isArray(before) === Array.isArray(after), 'STATE_CONTAINER_CHANGED');
  if (Array.isArray(before)) {
    ensure(before.length === after.length, 'STATE_ARRAY_LENGTH_CHANGED');
    before.forEach((value, index) => compare(value, after[index]));
    return;
  }
  const url = inlineUrl(before);
  if (url && !inlineUrl(after)) {
    const bytes = decode(url);
    const digest = hashBytes(bytes);
    ensure(after.checksum === digest && after.sizeBytes === bytes.length, 'INLINE_METADATA_CHANGED_BYTES');
    ensure(typeof after.relativePath === 'string' && after.relativePath.startsWith(`image/${digest}.`), 'INLINE_PATH_MISMATCH');
    const destination = path.resolve(dataRoot, 'assets', after.relativePath);
    ensure(path.dirname(destination) === path.join(dataRoot, 'assets', 'image'), 'INLINE_PATH_OUTSIDE_FIXTURE');
    ensure(fs.statSync(destination).size === bytes.length && fileHash(destination) === digest, 'INLINE_FILE_BYTES_CHANGED');
    ensure(after.url === `lianhua-asset://local/${after.relativePath}` && after.managed === true && after.missing === false
      && after.mediaType === 'image' && !Object.hasOwn(after, 'dataUrl'), 'INLINE_LOCATOR_INVALID');
    const beforeKeys = Object.keys(before).filter((key) => !stableFields.has(key));
    const afterKeys = Object.keys(after).filter((key) => !stableFields.has(key));
    ensure(beforeKeys.length === afterKeys.length && beforeKeys.every((key) => Object.hasOwn(after, key)), 'NON_MEDIA_KEYS_CHANGED');
    for (const key of beforeKeys) compare(before[key], after[key]);
    convertedImages.push({ checksum: digest, bytes: bytes.length });
    return;
  }
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  ensure(beforeKeys.length === afterKeys.length && beforeKeys.every((key) => Object.hasOwn(after, key)), 'STATE_KEYS_CHANGED');
  for (const key of beforeKeys) compare(before[key], after[key]);
};

try {
  const sourceStat = fs.statSync(sourcePath);
  const sourceHash = fileHash(sourcePath);
  let sourceText = fs.readFileSync(sourcePath, 'utf8');
  const source = stripSecrets(JSON.parse(sourceText));
  sourceText = '';
  delete source.integrity;
  ensure(secretCount(collectSecrets(source)) === 0, 'ISOLATED_COPY_CONTAINS_CREDENTIALS');
  let isolatedLegacy = JSON.stringify(source);
  fs.writeFileSync(stateFile, isolatedLegacy, { flag: 'wx' });
  const isolatedLegacyHash = stateChecksum(isolatedLegacy);
  const beforeInlineCount = countInline(source);
  const projectRecords = [source.project, ...(source.projects || [])].filter((item) => item && item.__activeProjectReference !== true);
  report.input = { sourceBytes: sourceStat.size, sourceSha256: sourceHash, sourceMtimeMs: sourceStat.mtimeMs,
    isolatedLegacyBytes: Buffer.byteLength(isolatedLegacy), uniqueProjectIds: new Set(projectRecords.map((item) => item.id)).size,
    projectRecords: projectRecords.length, inlineImageRecords: beforeInlineCount,
    assetRecords: projectRecords.reduce((sum, item) => sum + (item.assets?.length || 0), 0),
    characterRecords: projectRecords.reduce((sum, item) => sum + (item.characters?.length || 0), 0),
    generationTaskRecords: projectRecords.reduce((sum, item) => sum + (item.generationTasks?.length || 0), 0) };
  stage = 'isolated-save';
  const store = createStateStore({ dataRoot });
  const saveStarted = performance.now();
  const result = await store.save(isolatedLegacy, async () => ({ mode: 'keep' }));
  const firstSaveMs = Math.round(performance.now() - saveStarted);
  ensure(result.ok && !result.backupError && !result.snapshotError, 'ISOLATED_SAVE_WARNING');
  ensure(fileHash(path.join(dataRoot, 'project-state.legacy-original.json')) === isolatedLegacyHash, 'LEGACY_COPY_CHANGED');
  isolatedLegacy = '';
  stage = 'reload-and-compare';
  let loadedText = createStateStore({ dataRoot }).load(null).content;
  const loaded = JSON.parse(loadedText);
  loadedText = '';
  compare(source, loaded);
  const afterInlineCount = countInline(loaded);
  ensure(beforeInlineCount - afterInlineCount === convertedImages.length, 'INLINE_RECORD_COUNT_MISMATCH');
  const blockDirectory = path.join(dataRoot, 'project-library');
  const beforeFiles = fs.readdirSync(blockDirectory).sort();
  const beforeStats = Object.fromEntries(beforeFiles.map((name) => [name, { size: fs.statSync(path.join(blockDirectory, name)).size, mtimeMs: fs.statSync(path.join(blockDirectory, name)).mtimeMs }]));
  const manifestBytes = fs.statSync(stateFile).size;
  const parsedManifest = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const resolvedAgain = readProjectLibrary(fs.readFileSync(stateFile, 'utf8'), { root: dataRoot });
  ensure(stateChecksum(JSON.stringify(resolvedAgain)) === stateChecksum(JSON.stringify(loaded)), 'MANIFEST_RESOLUTION_CHANGED');
  const uniqueImages = new Map(convertedImages.map((image) => [image.checksum, image.bytes]));
  report.firstSave = { elapsedMs: firstSaveMs, manifestBytes, projectBlockCount: beforeFiles.length,
    projectBlockBytes: Object.values(beforeStats).reduce((sum, item) => sum + item.size, 0),
    convertedInlineImageRecords: convertedImages.length, uniqueExternalizedImages: uniqueImages.size,
    uniqueExternalizedImageBytes: [...uniqueImages.values()].reduce((sum, bytes) => sum + bytes, 0),
    remainingInlineImageRecords: afterInlineCount, everyConvertedImageByteIdentical: true,
    onlyMediaLocatorMetadataChanged: true, comparedNodes, comparedStrings,
    originalPromptCharacterBindingTaskDataPreserved: true, legacyOriginalRetained: true,
    activeProjectReferenceReusesBlock: (parsedManifest.projects || []).filter((item) => item.__activeProjectReference).every((item) => item.hash === parsedManifest.project.hash) };
  stage = 'second-save';
  const secondStarted = performance.now();
  const second = await store.save(JSON.stringify(loaded), async () => ({ mode: 'keep' }));
  ensure(second.ok && !second.backupError && !second.snapshotError, 'SECOND_SAVE_WARNING');
  const afterFiles = fs.readdirSync(blockDirectory).sort();
  ensure(JSON.stringify(beforeFiles) === JSON.stringify(afterFiles), 'UNCHANGED_PROJECT_BLOCK_COUNT_CHANGED');
  for (const name of beforeFiles) {
    const stat = fs.statSync(path.join(blockDirectory, name));
    ensure(stat.size === beforeStats[name].size && stat.mtimeMs === beforeStats[name].mtimeMs, 'UNCHANGED_PROJECT_BLOCK_REWRITTEN');
  }
  ensure(fileHash(path.join(dataRoot, 'project-state.legacy-original.json')) === isolatedLegacyHash, 'SECOND_SAVE_LEGACY_COPY_CHANGED');
  const finalStat = fs.statSync(sourcePath);
  ensure(finalStat.size === sourceStat.size && finalStat.mtimeMs === sourceStat.mtimeMs && fileHash(sourcePath) === sourceHash, 'READ_ONLY_SOURCE_CHANGED');
  report.secondSave = { elapsedMs: Math.round(performance.now() - secondStarted), projectBlockCount: afterFiles.length,
    newProjectBlocks: 0, unchangedProjectBlocksRewritten: 0, legacyOriginalStillUnchanged: true };
  report.sourceStillByteIdentical = true;
  report.complete = true;
  report.elapsedMs = Math.round(performance.now() - begin);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, ...report }, null, 2));
} catch (error) {
  report.failure = { stage, code: error?.qaCode || error?.code || 'MIGRATION_FAILED', name: error?.name || 'Error',
    detailSha256: hashBytes(Buffer.from(String(error?.message || 'unknown'))) };
  report.elapsedMs = Math.round(performance.now() - begin);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ reportFile, ...report }, null, 2));
  process.exitCode = 1;
}
