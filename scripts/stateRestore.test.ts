import assert from 'node:assert/strict';
import { createInitialState, saveStateAsync, withStateRestore } from '../src/storage';
import { handleStateSerializationRequest, type StateSerializationRequest } from '../src/stateSerialization';
import type { StateSerializationWorkerPort } from '../src/stateSerializationClient';
import type { AppState } from '../src/types';

class RestoreWorker implements StateSerializationWorkerPort {
  static current: RestoreWorker;
  requests: StateSerializationRequest[] = [];
  onmessage: StateSerializationWorkerPort['onmessage'] = null;
  onerror: StateSerializationWorkerPort['onerror'] = null;
  onmessageerror: StateSerializationWorkerPort['onmessageerror'] = null;
  constructor() { RestoreWorker.current = this; }
  postMessage(request: StateSerializationRequest) { this.requests.push(structuredClone(request)); }
  terminate() { /* isolated mock, no native resources */ }
  finish(index = this.requests.length - 1) { this.onmessage?.({ data: handleStateSerializationRequest(this.requests[index]) }); }
  fail(index: number, error: string) { this.onmessage?.({ data: { id: this.requests[index].id, ok: false, error } }); }
}
const source = createInitialState();
const state = (name: string): AppState => {
  const result = structuredClone(source);
  result.project.name = name; result.projects = [result.project];
  return result;
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 14; i += 1) await Promise.resolve(); };
const originalWorker = globalThis.Worker; const originalWindow = globalThis.window;
const events: string[] = []; const writes: string[] = []; const mirrors: string[] = [];
const oldTailDiskGate = deferred(); const restoreGate = deferred();
let rejectWriteName = '';
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: RestoreWorker });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  localStorage: { setItem: (_key: string, content: string) => mirrors.push(JSON.parse(content).project.name) },
  lianhuaDesktop: { saveState: async (content: string) => {
    const name = JSON.parse(content).project.name as string;
    writes.push(name); events.push(`save:${name}`);
    if (name === rejectWriteName) throw new Error('mock desktop save failure');
    if (name === 'C-latest-old') await oldTailDiskGate.promise;
    return { ok: true, checksum: name };
  } },
} });

try {
  const oldA = state('A-old-encode'); const oldC = state('C-latest-old'); const restoredB = state('B-restored');
  const savingA = saveStateAsync(oldA);
  let applied: AppState | undefined;
  let applySave: Promise<unknown> | undefined;
  const restoring = withStateRestore(oldC, async () => {
    events.push('restore:start');
    await restoreGate.promise;
    return restoredB;
  }, (next) => {
    events.push('apply:B'); applied = next;
    applySave = saveStateAsync(state('must-still-block-inside-apply'));
    void applySave.catch(() => undefined);
  });
  const worker = RestoreWorker.current;
  assert.equal(worker.requests.length, 2, 'restore synchronously posts the latest old state behind all earlier encoder jobs');
  oldC.project.name = 'changed after restore was requested';
  await assert.rejects(saveStateAsync(state('D-during-restore')), /正在恢复.*未保存旧状态/u);
  await assert.rejects(withStateRestore(state('nested'), async () => { throw new Error('nested restore must not start'); }, () => undefined), /正在恢复/u);
  assert.equal(worker.requests.length, 2, 'neither normal saves nor nested restore may send an encoder job while locked');
  worker.finish(1); await tick(); assert.equal(events.length, 0, 'a completed latest encoding cannot bypass slow earlier A');
  worker.finish(0); await savingA; await tick();
  assert.deepEqual(events, ['save:A-old-encode', 'save:C-latest-old']);
  assert.equal(applied, undefined);
  assert.equal(events.includes('restore:start'), false, 'restore must wait for the final desktop acknowledgement, not just encoding');
  oldTailDiskGate.resolve(); await tick();
  assert.deepEqual(events, ['save:A-old-encode', 'save:C-latest-old', 'restore:start']);
  assert.deepEqual(mirrors, ['A-old-encode', 'C-latest-old'], 'all old browser mirror writes also finish before restore');
  await assert.rejects(saveStateAsync(state('D-while-operation-awaits')), /正在恢复.*未保存旧状态/u);
  assert.equal(worker.requests.length, 2);
  restoreGate.resolve(); assert.equal(await restoring, restoredB);
  assert.equal(applied, restoredB);
  await assert.rejects(applySave!, /正在恢复/u);
  const savingB = saveStateAsync(applied!); assert.equal(worker.requests.length, 3); worker.finish(); await savingB;
  assert.deepEqual(events, ['save:A-old-encode', 'save:C-latest-old', 'restore:start', 'apply:B', 'save:B-restored']);
  assert.deepEqual(writes, ['A-old-encode', 'C-latest-old', 'B-restored'], 'no old snapshot can land after restore');

  // Encoder failure: the restore operation is never entered, no hidden retry,
  // and subsequent explicit persistence is available again.
  let restoreCalls = 0; let applyCalls = 0;
  const beforeEncodeFailure = worker.requests.length;
  const encodeFailed = withStateRestore(state('bad-encoder'), async () => { restoreCalls++; return 1; }, () => { applyCalls++; });
  worker.fail(beforeEncodeFailure, 'mock encoder failure');
  await assert.rejects(encodeFailed, /mock encoder failure/u);
  assert.equal(restoreCalls, 0); assert.equal(applyCalls, 0);
  assert.equal(worker.requests.length, beforeEncodeFailure + 1, 'failed freeze/save must not be retried implicitly');
  const afterEncodeFailure = saveStateAsync(state('after-encode-failure')); worker.finish(); await afterEncodeFailure;

  // Main write failure similarly must not execute a destructive restore.
  rejectWriteName = 'bad-desktop-write';
  const writeFailed = withStateRestore(state(rejectWriteName), async () => { restoreCalls++; return 1; }, () => { applyCalls++; });
  worker.finish(); await assert.rejects(writeFailed, /mock desktop save failure/u);
  rejectWriteName = '';
  assert.equal(restoreCalls, 0); assert.equal(applyCalls, 0);
  const afterWriteFailure = saveStateAsync(state('after-write-failure')); worker.finish(); await afterWriteFailure;

  // Operation/apply exceptions always release the guard, but never retry the
  // operation or invoke apply after an operation failure.
  const operationFailed = withStateRestore(state('before-restore-failure'), () => { restoreCalls++; throw new Error('mock restore failure'); }, () => { applyCalls++; });
  worker.finish(); await assert.rejects(operationFailed, /mock restore failure/u);
  assert.equal(restoreCalls, 1); assert.equal(applyCalls, 0);
  const afterOperationFailure = saveStateAsync(state('after-operation-failure')); worker.finish(); await afterOperationFailure;
  const applyFailed = withStateRestore(state('before-apply-failure'), () => { restoreCalls++; return restoredB; }, () => { applyCalls++; throw new Error('mock apply failure'); });
  worker.finish(); await assert.rejects(applyFailed, /mock apply failure/u);
  assert.equal(restoreCalls, 2); assert.equal(applyCalls, 1);
  const afterApplyFailure = saveStateAsync(state('after-apply-failure')); worker.finish(); await afterApplyFailure;
  assert.equal(writes.at(-1), 'after-apply-failure');
} finally {
  oldTailDiskGate.resolve(); restoreGate.resolve();
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log('State restore barrier checks passed: pending encoder drain, call-time tail freeze, restore lock before worker/IPC, apply-before-unlock, nested rejection and every failure path releases without retry.');
