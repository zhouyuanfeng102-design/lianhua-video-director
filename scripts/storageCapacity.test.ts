import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createInitialState, loadDesktopState, loadState, MAX_PERSISTED_STATE_BYTES,
  normalizeState, saveStateAsync, serializeStateForStorage, stateUtf8ByteLength, STORAGE_KEY,
} from '../src/storage';
import { formatUserFacingError } from '../src/userFacingError';
import type { AppState, Project } from '../src/types';

const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
assert.equal(MAX_PERSISTED_STATE_BYTES, Infinity);
assert.doesNotMatch(main, /const MAX_STATE_BYTES = 256 \* 1024 \* 1024;/u);
assert.match(main, /const MAX_IMAGE_EXPORT_BYTES = 64 \* 1024 \* 1024;/u);
for (const text of ['', 'ASCII', '中文', 'a\ud800b', '\udc00', '🪷你好\n\r\t', '\ud800\ud800\udc00']) {
  assert.equal(stateUtf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
}

const source = createInitialState();
const active: Project = { ...source.project, id: 'active', name: 'Active fixture', description: 'keep active detail' };
const archived: Project = { ...source.project, id: 'archived', name: 'Archived fixture', description: 'keep archived detail' };
const state: AppState = { ...source, project: active, projects: [archived, active], activeProjectId: active.id };
const original = JSON.stringify(state);
const compact = serializeStateForStorage(state);
assert.equal(JSON.stringify(state), original, 'serialization does not mutate runtime projects or assets');
assert.deepEqual(compact.serializedState.projects[1], { id: active.id, __activeProjectReference: true });
assert.equal(compact.serializedState.project, active);
assert.equal(compact.serializedState.projects[0], archived);
const reloaded = normalizeState(JSON.parse(compact.serialized));
assert.deepEqual(reloaded.projects.map((project) => project.id), ['archived', 'active'], 'library order survives compaction');
assert.equal(reloaded.project.description, active.description);
assert.equal(reloaded.projects[0].description, archived.description);
assert.deepEqual(reloaded.project.assets, normalizeState(state).project.assets);
const independentEqual = serializeStateForStorage({ ...state, projects: [archived, JSON.parse(JSON.stringify(active))] });
assert.deepEqual(independentEqual.serializedState.projects[1], { id: active.id, __activeProjectReference: true });
const differentCopy = { ...active, description: 'a distinct stale copy must not be discarded' };
assert.equal(serializeStateForStorage({ ...state, projects: [archived, differentCopy] }).serializedState.projects[1], differentCopy);
assert.deepEqual(normalizeState(state).projects.map((project) => project.id), ['archived', 'active'], 'legacy full envelopes remain readable');

const store = new Map<string, string>();
let desktopSaved = '';
let mirrorWrites = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { mirrorWrites += 1; store.set(key, value); },
  },
  lianhuaDesktop: {
    saveState: async (content: string) => { desktopSaved = content; return { ok: true, checksum: 'fixture' }; },
    loadState: async () => desktopSaved,
  },
} });
await saveStateAsync(state);
assert.equal(mirrorWrites, 1, 'small desktop state retains the secret-free browser fallback');
assert.deepEqual(loadState().projects.map((project) => project.id), ['archived', 'active']);
assert.deepEqual((await loadDesktopState())?.projects.map((project) => project.id), ['archived', 'active']);

// Real-sized but synthetic text: a complete library above the old 64 MiB cap
// remains supported, with no media, user fixture, network or disk writes.
const largeActive = { ...active, description: 'A'.repeat(33 * 1024 * 1024) };
const largeArchive = { ...archived, description: 'B'.repeat(32 * 1024 * 1024) };
const largeState = { ...state, project: largeActive, projects: [largeArchive, largeActive] };
await saveStateAsync(largeState);
assert.ok(Buffer.byteLength(desktopSaved) > 64 * 1024 * 1024);
assert.ok(Buffer.byteLength(desktopSaved) < 67 * 1024 * 1024, 'active data is stored once, not twice');
assert.equal(mirrorWrites, 1, 'large desktop saves do not clone into the browser quota');
const savedLarge = JSON.parse(desktopSaved) as { project: Project; projects: Array<Project | { id: string }> };
assert.equal(savedLarge.project.description.length, 33 * 1024 * 1024);
assert.equal((savedLarge.projects[0] as Project).description.length, 32 * 1024 * 1024);
assert.ok(store.has(STORAGE_KEY), 'existing browser fallback is not removed');

const oldLimit = '本地保存失败：项目状态超过 64 MB，请先整理内嵌图片资产';
assert.equal(formatUserFacingError(oldLimit), `${oldLimit}。`);
assert.equal(formatUserFacingError(`Error invoking remote method 'lianhua:save-state': Error: ${oldLimit}`), `${oldLimit}。`);
for (const quantity of ['64MB', '64 MB', '64MiB', '256 MiB', '1.5GiB', '1024 bytes']) {
  const message = `项目状态超过 ${quantity}，请先导出备份再整理；原文件未被删除`;
  assert.equal(formatUserFacingError(message), `${message}。`);
}
for (const [code, reason] of [
  ['ENOSPC', '磁盘空间不足'], ['EDQUOT', '配额'], ['EACCES', '权限'], ['EPERM', '系统拒绝'],
  ['EBUSY', '占用'], ['EROFS', '只读'], ['ENOENT', '不存在'], ['ENOTDIR', '目录无效'],
  ['EISDIR', '指向了目录'], ['EIO', '读写失败'], ['EMFILE', '文件过多'], ['ENFILE', '句柄不足'],
]) {
  for (const value of [
    `${code}: failed to write, open 'C:\\fixture\\project-state.json'`,
    { code, message: 'write failed' },
    `本地保存失败：Error invoking remote method 'lianhua:save-state': Error: ${code}: write failed`,
  ]) {
    const localized = formatUserFacingError(value);
    assert.ok(localized.includes(reason), `${code} must expose its filesystem reason: ${localized}`);
    assert.ok(localized.includes(code));
    assert.ok(!localized.includes('服务返回了未识别'));
  }
}
const nativeChinese = '保存本地文件失败：磁盘空间不足，请释放数据目录所在磁盘的空间后重试（ENOSPC）';
assert.equal(formatUserFacingError(nativeChinese), `${nativeChinese}。`);
assert.match(formatUserFacingError({ code: 'ENOSPC', message: '本地保存失败' }), /本地保存失败.*磁盘空间不足.*ENOSPC/u);
for (const remote of ['图像接口请求失败：ENOSPC: no space left on device', '上游服务返回：EACCES: permission denied']) {
  const localized = formatUserFacingError(remote);
  assert.ok(localized.includes('远端文件系统'));
  assert.ok(localized.includes('请联系服务提供方'));
  assert.ok(!localized.includes('请释放保存目录'));
  assert.ok(!localized.includes('请检查保存目录权限'));
}
assert.ok(!formatUserFacingError('本地保存失败：unrecognized operation').includes('服务返回'));
assert.match(formatUserFacingError({ status: 503, message: 'Service unavailable' }), /HTTP 503/u);
console.log('storage capacity: compact round-trip/order, >64 MiB desktop save, no oversized browser mirror, units and filesystem diagnostics passed');
