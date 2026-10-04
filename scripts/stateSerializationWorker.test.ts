import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInitialState, CURRENT_SCHEMA_VERSION, isCoalescedAutoSaveCancellation, MAX_PERSISTED_STATE_BYTES, saveStateAsync, serializeStateForStorage, STORAGE_KEY } from '../src/storage';
import { encodeStateSnapshot, handleStateSerializationRequest, serializeStateSnapshot, stateUtf8ByteLength, type StateSerializationPolicy, type StateSerializationReply, type StateSerializationRequest } from '../src/stateSerialization';
import { createOrderedStateSaveQueue, createStateSerializationClient, type StateSerializationWorkerPort } from '../src/stateSerializationClient';
import type { AppState, Project } from '../src/types';

const policy: StateSerializationPolicy = { currentSchemaVersion: CURRENT_SCHEMA_VERSION, maxBytes: MAX_PERSISTED_STATE_BYTES, desktopBrowserCacheBytes: 2 * 1024 * 1024 };
const initial = createInitialState();
const fixture = (name: string): AppState => {
  const state = structuredClone(initial);
  state.project.name = name;
  state.project.description = `${name} 中文 🪷`;
  state.projects = [state.project];
  return state;
};
// Independent reference for the exact pre-worker persistence envelope.
const oldEnvelope = (state: AppState) => {
  let activeJson: string | undefined;
  const projects = state.projects?.map((project) => {
    if (project.id !== state.project.id) return project;
    if (project !== state.project) {
      activeJson ??= JSON.stringify(state.project);
      if (JSON.stringify(project) !== activeJson) return project;
    }
    return { id: project.id, __activeProjectReference: true };
  });
  return JSON.stringify({ ...state, ...(projects ? { projects } : {}), schemaVersion: typeof state.schemaVersion === 'number' && Number.isFinite(state.schemaVersion) ? Math.max(CURRENT_SCHEMA_VERSION, Math.floor(state.schemaVersion)) : CURRENT_SCHEMA_VERSION });
};
for (const version of [undefined, Number.NaN, 1, 23, 99.75]) {
  for (const activeCopy of ['same', 'equal', 'different'] as const) {
    const state = fixture(`${version}-${activeCopy}`);
    state.schemaVersion = version as number;
    const archive: Project = { ...structuredClone(state.project), id: 'archive', description: '归档内容' };
    state.projects = [archive, activeCopy === 'same' ? state.project : { ...structuredClone(state.project), ...(activeCopy === 'different' ? { description: 'stale copy must survive' } : {}) }];
    const encoded = encodeStateSnapshot(state, policy, true);
    assert.equal(encoded.serialized, oldEnvelope(state), 'worker envelope is byte-for-byte equivalent, including same-ID unequal copies and future schema');
    assert.equal(encoded.serialized, serializeStateForStorage(state).serialized);
    assert.equal(encoded.sizeBytes, Buffer.byteLength(encoded.serialized, 'utf8'));
    assert.equal('serializedState' in encoded, false, 'worker must never return another complete object graph');
  }
}
for (const text of ['', 'ASCII', '中文', '🪷', 'x\ud800y', '\udc00', '\ud800\ud800\udc00']) assert.equal(stateUtf8ByteLength(text), Buffer.byteLength(text));
const quotaFixture = fixture('quota');
const exactSize = serializeStateForStorage(quotaFixture).sizeBytes;
assert.equal(serializeStateSnapshot(quotaFixture, { ...policy, maxBytes: exactSize }).sizeBytes, exactSize);
assert.throws(() => encodeStateSnapshot(quotaFixture, { ...policy, maxBytes: exactSize - 1 }, true), /本地保存上限.*未被删除/u);
const oversizeReply = handleStateSerializationRequest({ id: 1, state: quotaFixture, policy: { ...policy, maxBytes: exactSize - 1 } });
assert.equal(oversizeReply.ok, false, 'quota failures return an error rather than truncated state');
const secretState = fixture('secrets');
secretState.settings.textApi.apiKey = 'text-secret';
secretState.settings.visionApi.apiKey = 'vision-secret';
secretState.settings.imageApi.apiKey = 'image-secret';
secretState.settings.videoTaskApi.apiKey = 'video-secret';
secretState.settings.runningHubVideo!.apiKey = 'runninghub-cloud-secret';
secretState.settings.apiCredentialBook = [{ id: 'secret-book', name: 'mock', baseUrl: 'https://example.test', apiKey: 'book-secret', createdAt: 1, updatedAt: 1 }];
secretState.settings.textApiProfiles = [{ ...secretState.settings.textApi, id: 'secret-profile', name: 'mock', apiKey: 'profile-secret', createdAt: 1, updatedAt: 1 }];
const secretSnapshot = encodeStateSnapshot(secretState, policy, true);
assert.ok(secretSnapshot.serialized.includes('text-secret'));
assert.ok(secretSnapshot.browserCache);
assert.doesNotMatch(secretSnapshot.browserCache!, /(?:text|vision|image|video|book|profile)-secret|runninghub-cloud-secret/u);
assert.ok(secretSnapshot.serialized.includes('runninghub-cloud-secret'), 'desktop IPC retains cloud credential for encrypted vault storage');
assert.equal(secretState.settings.textApi.apiKey, 'text-secret', 'redacting the cache does not mutate the call snapshot');
const large = fixture('large'); large.project.description = '中'.repeat(1024 * 1024);
const largeEncoded = encodeStateSnapshot(large, policy, true);
assert.ok(largeEncoded.sizeBytes > policy.desktopBrowserCacheBytes);
assert.equal(largeEncoded.browserCache, undefined, '>2MiB desktop snapshots skip all browser cache encoding');
assert.ok(encodeStateSnapshot(large, policy, false).browserCache, 'browser-only compatibility still attempts its own storage/quota boundary');

class FakeWorker implements StateSerializationWorkerPort {
  static instances: FakeWorker[] = [];
  requests: StateSerializationRequest[] = [];
  terminated = false;
  throwOnPost = false;
  onmessage: StateSerializationWorkerPort['onmessage'] = null;
  onerror: StateSerializationWorkerPort['onerror'] = null;
  onmessageerror: StateSerializationWorkerPort['onmessageerror'] = null;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: StateSerializationRequest) {
    if (this.throwOnPost) throw new Error('mock clone failure');
    this.requests.push(structuredClone(request));
  }
  complete(index: number) { this.onmessage?.({ data: handleStateSerializationRequest(this.requests[index]) }); }
  reply(message: StateSerializationReply) { this.onmessage?.({ data: message }); }
  terminate() { this.terminated = true; }
}
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

// A slow large encode cannot write after a later, fast small encode.
const port = new FakeWorker(); const client = createStateSerializationClient(() => port); const queue = createOrderedStateSaveQueue();
const a = fixture('A'); const b = fixture('B');
const frozenA = oldEnvelope(a); const frozenB = oldEnvelope(b);
const firstGate = deferred(); const writes: string[] = [];
const first = queue(client.encode(a, policy), async (encoded) => { writes.push(encoded.serialized); await firstGate.promise; return 'A'; });
const second = queue(client.encode(b, policy), async (encoded) => { writes.push(encoded.serialized); return 'B'; });
assert.equal(port.requests.length, 2, 'both snapshots are posted immediately, even while an older save is pending');
assert.equal(port.requests[0].state.project, port.requests[0].state.projects[0], 'native graph clone retains identity for active-project de-duplication');
a.project.name = 'later A mutation'; b.project.description = 'later B mutation'; a.settings.textApi.model = 'later API mutation';
port.complete(1); await tick(); assert.deepEqual(writes, []);
port.complete(0); await tick(); assert.deepEqual(writes, [frozenA]);
firstGate.resolve(); assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
assert.deepEqual(writes, [frozenA, frozenB], 'invocation snapshots and commit order both survive mutation and reversed completion');

// Failures release the following save, without replaying the failed IPC.
const failurePort = new FakeWorker(); const failureClient = createStateSerializationClient(() => failurePort); const failureQueue = createOrderedStateSaveQueue();
const attempts: string[] = [];
const failedWrite = failureQueue(failureClient.encode(fixture('fail-save'), policy), async () => { attempts.push('A'); throw new Error('mock disk failure'); });
const afterWriteFailure = failureQueue(failureClient.encode(fixture('after-fail'), policy), async () => { attempts.push('B'); return true; });
failurePort.complete(0); failurePort.complete(1);
await assert.rejects(failedWrite, /mock disk failure/u); assert.equal(await afterWriteFailure, true); assert.deepEqual(attempts, ['A', 'B']);
const failedEncode = failureQueue(failureClient.encode(fixture('bad-encode'), { ...policy, maxBytes: 1 }), async () => { throw new Error('must not write'); });
const afterEncodeFailure = failureQueue(failureClient.encode(fixture('good-encode'), policy), async () => true);
failurePort.complete(3); failurePort.complete(2);
await assert.rejects(failedEncode, /本地保存上限/u); assert.equal(await afterEncodeFailure, true);

// Worker construction failure falls back synchronously; asynchronous failures
// reject frozen jobs once rather than recapturing changed caller-owned data.
const fallbackClient = createStateSerializationClient(() => { throw new Error('CSP denied worker construction'); });
const fallbackState = fixture('fallback'); const fallbackExpected = oldEnvelope(fallbackState);
const fallbackEncoded = fallbackClient.encode(fallbackState, policy); fallbackState.project.name = 'changed';
assert.equal((await fallbackEncoded).serialized, fallbackExpected);
const crashPort = new FakeWorker(); const crashClient = createStateSerializationClient(() => crashPort);
const lostA = crashClient.encode(fixture('lost A'), policy); const lostB = crashClient.encode(fixture('lost B'), policy);
crashPort.onerror?.({ message: 'module failed to initialize' });
await assert.rejects(lostA, /本次未写入/u); await assert.rejects(lostB, /本次未写入/u);
assert.equal(crashPort.terminated, true);
assert.ok((await crashClient.encode(fixture('manual retry'), policy)).serialized.includes('manual retry'));
assert.equal(crashPort.requests.length, 2, 'failed jobs are never secretly reposted');
const postPort = new FakeWorker(); postPort.throwOnPost = true;
const postClient = createStateSerializationClient(() => postPort);
await assert.rejects(postClient.encode(fixture('uncloneable'), policy), /mock clone failure/u);
postPort.throwOnPost = false; const recoverPost = postClient.encode(fixture('valid again'), policy); postPort.complete(0); assert.ok((await recoverPost).serialized);

// Exercise the real saveStateAsync integration under a worker mock. A trap on
// the main realm's JSON.stringify proves both encoding and cache redaction
// stay out of this path; the returned cache is already fully encoded.
const originalWorker = globalThis.Worker;
const originalWindow = globalThis.window;
const nativeStringify = JSON.stringify;
const integrationWrites: string[] = []; const browserWrites: string[] = [];
const integrationState = fixture('integration call-time snapshot');
const integrationEncoded = encodeStateSnapshot(integrationState, policy, true);
const integrationA = fixture('integration ordered A'); const integrationB = fixture('integration ordered B');
const integrationEncodedA = encodeStateSnapshot(integrationA, policy, true); const integrationEncodedB = encodeStateSnapshot(integrationB, policy, true);
const integrationC = fixture('integration explicit C');
const integrationEncodedC = encodeStateSnapshot(integrationC, policy, true);
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { setItem: (storageKey: string, content: string) => { assert.equal(storageKey, STORAGE_KEY); browserWrites.push(content); } }, lianhuaDesktop: { saveState: async (content: string) => { integrationWrites.push(content); return { ok: true, checksum: 'mock' }; } } } });
try {
  JSON.stringify = (() => { throw new Error('main-thread JSON encoding was called'); }) as typeof JSON.stringify;
  const saved = saveStateAsync(integrationState);
  const integrationPort = FakeWorker.instances.at(-1)!;
  assert.equal(integrationPort.requests.length, 1);
  integrationState.project.name = 'mutation after call';
  integrationPort.reply({ id: integrationPort.requests[0].id, ok: true, result: integrationEncoded });
  assert.equal((await saved).ok, true);
  assert.deepEqual(integrationWrites, [integrationEncoded.serialized]);
  assert.deepEqual(browserWrites, [integrationEncoded.browserCache]);
  assert.equal(integrationPort.requests[0].state.project.name, 'integration call-time snapshot');
  const hugeSave = saveStateAsync(large);
  integrationPort.reply({ id: integrationPort.requests[1].id, ok: true, result: largeEncoded });
  await hugeSave;
  assert.equal(browserWrites.length, 1, 'desktop large state never touches the browser cache');
  const orderedA = saveStateAsync(integrationA); const orderedB = saveStateAsync(integrationB);
  assert.equal(integrationPort.requests.length, 4, 'saveStateAsync captures both states before either encode completes');
  integrationA.project.name = 'not the frozen A'; integrationB.project.name = 'not the frozen B';
  integrationPort.reply({ id: integrationPort.requests[3].id, ok: true, result: integrationEncodedB });
  await tick(); assert.equal(integrationWrites.length, 2, 'the small newer save cannot overtake an older encode');
  integrationPort.reply({ id: integrationPort.requests[2].id, ok: true, result: integrationEncodedA });
  await Promise.all([orderedA, orderedB]);
  assert.deepEqual(integrationWrites.slice(2), [integrationEncodedA.serialized, integrationEncodedB.serialized]);
  assert.deepEqual(browserWrites.slice(1), [integrationEncodedA.browserCache, integrationEncodedB.browserCache], 'optional browser mirror follows the same commit order');

  // Automatic saves coalesce before the second large structured clone is
  // posted.  The first caller completes normally; a newer pending state is
  // posted only after that save has finished.
  const autoA = saveStateAsync(integrationA, { coalesce: true });
  const autoB = saveStateAsync(integrationB, { coalesce: true });
  assert.equal(integrationPort.requests.length, 5, 'automatic saves keep only one encoder request in flight');
  integrationPort.reply({ id: integrationPort.requests[4].id, ok: true, result: integrationEncodedA });
  await tick();
  assert.equal(integrationPort.requests.length, 6, 'the newest pending automatic state starts after the first write');
  integrationPort.reply({ id: integrationPort.requests[5].id, ok: true, result: integrationEncodedB });
  await Promise.all([autoA, autoB]);
  assert.deepEqual(integrationWrites.slice(-2), [integrationEncodedA.serialized, integrationEncodedB.serialized]);

  // An explicit save (close/restore/manual checkpoint) supersedes a pending
  // automatic snapshot.  The active automatic write is allowed to finish in
  // FIFO order, but the older pending state must never be written after the
  // explicit state or roll the project back on the next launch.
  const autoBeforeExplicit = saveStateAsync(integrationA, { coalesce: true });
  const autoPendingBeforeExplicit = saveStateAsync(integrationB, { coalesce: true });
  assert.equal(integrationPort.requests.length, 7, 'the active automatic save posts exactly one request');
  const explicitC = saveStateAsync(integrationC);
  await assert.rejects(
    autoPendingBeforeExplicit,
    (error) => isCoalescedAutoSaveCancellation(error),
    'the pending automatic snapshot is settled as superseded rather than left hanging',
  );
  assert.equal(integrationPort.requests.length, 8, 'the explicit save is still posted behind the active automatic save');
  integrationPort.reply({ id: integrationPort.requests[7].id, ok: true, result: integrationEncodedC });
  await tick();
  assert.deepEqual(integrationWrites.slice(-2), [integrationEncodedA.serialized, integrationEncodedB.serialized], 'explicit write waits for active automatic encode');
  integrationPort.reply({ id: integrationPort.requests[6].id, ok: true, result: integrationEncodedA });
  await Promise.all([autoBeforeExplicit, explicitC]);
  assert.deepEqual(integrationWrites.slice(-2), [integrationEncodedA.serialized, integrationEncodedC.serialized], 'no superseded automatic snapshot writes after explicit state');
  assert.equal(integrationPort.requests.length, 8, 'cancelled pending automatic state is never re-encoded');
} finally {
  JSON.stringify = nativeStringify;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}

const quotaError = Object.assign(new Error('synthetic quota'), { name: 'QuotaExceededError' });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { setItem: () => { throw quotaError; } } } });
try {
  await assert.rejects(saveStateAsync(fixture('browser quota')), /浏览器本地存储空间不足.*原有浏览器存档未被覆盖/u);
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { setItem: () => undefined } } });
  assert.equal((await saveStateAsync(fixture('after browser quota'))).ok, true, 'a browser quota failure also releases the ordered save queue');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}

const workerSource = readFileSync(new URL('../src/stateSerialization.worker.ts', import.meta.url), 'utf8');
const leafSource = readFileSync(new URL('../src/stateSerialization.ts', import.meta.url), 'utf8');
assert.doesNotMatch(workerSource + leafSource, /from ['"].*(?:storage|catalog|visualStyles|promptRules)/u, 'worker must not import storage catalogs or normalization at runtime');
assert.match(leafSource, /^import type .*from '.\/types';/u);
assert.doesNotMatch(workerSource, /SharedArrayBuffer|node:|require\(/u);
console.log('State worker serialization checks passed: exact legacy bytes/schema, UTF-8/quota, graph snapshot freeze, reversed completion FIFO, failure release/no retries, redacted small cache, skipped large cache and no main-thread JSON.');
