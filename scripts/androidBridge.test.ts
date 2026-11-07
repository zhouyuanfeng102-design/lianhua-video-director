import assert from 'node:assert/strict';
import { createAndroidBridge, fileNativePayload, type LianhuaNativePlugin } from '../src/platform/androidBridge';

const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
const documents = new Map<string, unknown>();
const callbacks = new Map<string, (event: unknown) => void>();
let removed = 0;
let failSave = false;
const plugin: LianhuaNativePlugin = {
  async invoke(options) {
    calls.push(options);
    const payload = options.payload;
    switch (options.method) {
      case 'saveState':
        if (failSave) throw new Error('disk full');
        documents.set('state', payload?.content);
        return { value: { ok: true, checksum: 'a'.repeat(64), projectHashes: { project: 'b'.repeat(64) } } };
      case 'loadWorkspaceState': return { value: documents.get('state') ?? null };
      case 'saveVideoTaskCheckpoint': documents.set(String(payload?.id), payload); return { value: { persisted: true } };
      case 'getVideoTaskCheckpoint': return { value: documents.get(String(payload?.value)) ?? null };
      case 'setVideoTaskCredential': documents.set(`credential:${payload?.taskId}`, payload?.apiKey); return { value: { persisted: true } };
      case 'getVideoTaskCredential': return { value: documents.get(`credential:${payload?.value}`) ?? null };
      case 'request': case 'videoRequest': return { value: { status: 200, body: 'AAH/', bodyEncoding: 'base64', contentType: 'application/octet-stream' } };
      case 'cancelVideoRequest': return { value: true };
      default: return { value: null };
    }
  },
  async addListener(eventName, callback) {
    callbacks.set(eventName, callback);
    return { remove: async () => { callbacks.delete(eventName); removed += 1; } };
  },
};

const bridge = createAndroidBridge(plugin);
const serialized = JSON.stringify({ schemaVersion: 24, project: { id: 'project', name: '手机项目😀' }, projects: [{ id: 'other', __projectLibraryReference: { hash: 'c'.repeat(64) } }] });
const saved = await bridge.saveState(serialized);
assert.equal(saved.projectHashes?.project, 'b'.repeat(64));
assert.equal(await bridge.loadWorkspaceState!(), serialized, 'project-library references and Unicode must cross the native boundary intact');
const checkpoint = { id: 'task-1', runtime: { stage: 'running' }, snapshot: { remoteTaskId: 'already-submitted' } } as unknown as Parameters<typeof bridge.saveVideoTaskCheckpoint>[0];
assert.deepEqual(await bridge.saveVideoTaskCheckpoint(checkpoint), { persisted: true });
assert.deepEqual(await bridge.getVideoTaskCheckpoint('task-1'), checkpoint);
await bridge.setVideoTaskCredential({ taskId: 'task-1', apiKey: 'test-only-key' });
assert.equal(await bridge.getVideoTaskCredential('task-1'), 'test-only-key');

const binaryRequest = { requestId: 'upload-1', url: 'https://example.test/upload', method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'AAH/', bodyEncoding: 'base64' as const, responseType: 'base64' as const };
const before = calls.length;
assert.deepEqual(await bridge.videoRequest(binaryRequest), { status: 200, body: 'AAH/', bodyEncoding: 'base64', contentType: 'application/octet-stream' });
assert.equal(calls.length, before + 1, 'the adapter must not retry or issue extra submissions');
assert.deepEqual(calls.at(-1), { method: 'videoRequest', payload: binaryRequest });
const multipart = { requestId: 'image-1', url: 'https://example.test/images', method: 'POST', multipart: { fields: [{ name: 'prompt', value: '原文😀' }], files: [{ name: 'image', fileName: '人物.png', dataUrl: 'data:image/png;base64,AAH/' }] } };
await bridge.request(multipart);
assert.deepEqual(calls.at(-1), { method: 'request', payload: multipart });
assert.equal(await bridge.cancelVideoRequest('upload-1'), true);
assert.deepEqual(calls.at(-1), { method: 'cancelVideoRequest', payload: { value: 'upload-1' } });

failSave = true;
const saveCalls = calls.length;
await assert.rejects(bridge.saveState('new state'), /disk full/);
assert.equal(calls.length, saveCalls + 1, 'save failure must propagate without a fallback write or retry');
assert.equal(await bridge.loadWorkspaceState!(), serialized, 'failed save must not replace the prior state');
assert.deepEqual(await fileNativePayload(), {});

let observed: unknown;
const unsubscribe = bridge.onVideoProgress((event) => { observed = event; });
await Promise.resolve();
callbacks.get('videoProgress')?.({ watchId: 'watch-1', type: 'message', data: { progress: 73 } });
assert.deepEqual(observed, { watchId: 'watch-1', type: 'message', data: { progress: 73 } });
callbacks.get('downloadProgress')?.({ requestId: 'download-1', loaded: 524288, total: 1048576 });
assert.deepEqual(observed, { watchId: 'download-1', type: 'message', data: { type: 'download_progress', data: { receivedBytes: 524288, totalBytes: 1048576 } } });
unsubscribe();
await Promise.resolve();
assert.equal(removed, 2);

// Unmount can occur before Capacitor resolves addListener's registration.
bridge.onVideoProgress(() => assert.fail('unsubscribed listener fired'))();
await Promise.resolve();
assert.equal(removed, 4);
assert.equal(callbacks.has('videoProgress'), false);
assert.equal(callbacks.has('downloadProgress'), false);
console.log('Android bridge: persistence, task checkpoints, byte-preserving network and subscriptions passed');
