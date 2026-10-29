const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  isManagedDataRoot,
  migrateStorageDirectory,
  normalizeStorageLocationConfig,
  pathsOverlap,
  readStorageLocationConfig,
  writeStorageLocationConfig,
} = require('../electron/storageLocation.cjs');

const withTemporaryRoot = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-storage-location-'));
  try { run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('storage location config keeps only supported mode and path fields', () => {
  assert.deepEqual(normalizeStorageLocationConfig({ mode: 'custom', directory: 'D:/Lianhua', migrationFrom: 'C:/old', migrationId: 'id' }), {
    mode: 'custom', directory: 'D:/Lianhua', migrationFrom: 'C:/old', migrationId: 'id',
  });
  assert.deepEqual(normalizeStorageLocationConfig({ mode: 'unexpected', directory: 'ignored' }), {
    mode: 'default', directory: '', migrationFrom: '', migrationId: '',
  });
});

test('storage location config writes atomically and can be read back', () => withTemporaryRoot((root) => {
  const file = path.join(root, 'settings', 'storage-location.json');
  writeStorageLocationConfig(file, { mode: 'custom', directory: path.join(root, 'custom') });
  assert.deepEqual(readStorageLocationConfig(file), {
    mode: 'custom', directory: path.join(root, 'custom'), migrationFrom: '', migrationId: '',
  });
  assert.equal(fs.existsSync(`${file}.previous`), false);
}));

test('migration copies nested files, replaces an earlier managed root, and leaves the source unchanged', () => withTemporaryRoot((root) => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'assets', 'image'), { recursive: true });
  fs.writeFileSync(path.join(source, 'project-state.json'), 'current project state');
  fs.writeFileSync(path.join(source, 'assets', 'image', 'reference.png'), Buffer.from([1, 2, 3, 4]));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'project-state.json'), 'older project state');

  const result = migrateStorageDirectory({ source, target, migrationId: 'move-1' });
  assert.equal(fs.readFileSync(path.join(target, 'project-state.json'), 'utf8'), 'current project state');
  assert.deepEqual(fs.readFileSync(path.join(target, 'assets', 'image', 'reference.png')), Buffer.from([1, 2, 3, 4]));
  assert.equal(fs.readFileSync(path.join(source, 'project-state.json'), 'utf8'), 'current project state');
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(path.join(result.backupPath, 'project-state.json'), 'utf8'), 'older project state');
  assert.equal(fs.existsSync(path.join(target, '.lianhua-migration-move-1.json')), false);
  assert.equal(isManagedDataRoot(target), true);
}));

test('migration rejects overlapping paths and unrelated non-empty destinations without changing either', () => withTemporaryRoot((root) => {
  const source = path.join(root, 'source');
  const child = path.join(source, 'child');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'project-state.json'), 'state');
  assert.equal(pathsOverlap(source, child), true);
  assert.throws(() => migrateStorageDirectory({ source, target: child, migrationId: 'bad-child' }), /互相包含/u);

  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'unrelated');
  assert.throws(() => migrateStorageDirectory({ source, target: destination, migrationId: 'bad-target' }), /并非空目录/u);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(path.join(source, 'project-state.json'), 'utf8'), 'state');
}));

test('migration rebuilds an interrupted stage from the live source without restoring deleted files', () => withTemporaryRoot((root) => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(source, 'project-state.json'), 'state');
  const staging = `${target}.lianhua-migration-stage`;
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, '.lianhua-migration-previous-id.json'), JSON.stringify({ source, target, migrationId: 'previous-id' }));
  fs.writeFileSync(path.join(staging, 'partial.txt'), 'partial');
  fs.mkdirSync(path.join(staging, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'assets', 'deleted-after-failure.png'), 'stale');

  const result = migrateStorageDirectory({ source, target, migrationId: 'retry-1' });
  assert.equal(result.alreadyCompleted, false);
  assert.equal(fs.readFileSync(path.join(target, 'project-state.json'), 'utf8'), 'state');
  assert.equal(fs.existsSync(path.join(target, 'partial.txt')), false);
  assert.equal(fs.existsSync(path.join(target, 'assets', 'deleted-after-failure.png')), false);
}));

test('migration recovers when interrupted immediately after creating an empty stage directory', () => withTemporaryRoot((root) => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'project-state.json'), 'state');
  fs.mkdirSync(`${target}.lianhua-migration-stage`);

  migrateStorageDirectory({ source, target, migrationId: 'after-mkdir' });
  assert.equal(fs.readFileSync(path.join(target, 'project-state.json'), 'utf8'), 'state');
}));

test('migration refuses to replace an unmarked unrelated staging directory', () => withTemporaryRoot((root) => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const staging = `${target}.lianhua-migration-stage`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'project-state.json'), 'state');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'keep.txt'), 'unrelated');

  assert.throws(() => migrateStorageDirectory({ source, target, migrationId: 'unrelated-stage' }), /不属于本次迁移/u);
  assert.equal(fs.readFileSync(path.join(staging, 'keep.txt'), 'utf8'), 'unrelated');
}));
