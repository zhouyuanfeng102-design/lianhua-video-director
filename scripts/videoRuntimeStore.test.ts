import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createVideoRuntimeStore, pickVideoRuntime, videoRuntimeEqual, VIDEO_RUNTIME_FIELDS,
  useVideoRuntimes, useVideoTaskRuntime,
} from '../src/videoRuntimeStore';
import type { VideoGenerationRuntime } from '../src/videoGenerationTypes';

const clock = () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    options: {
      schedule: (callback: () => void, delayMs: number) => {
        const id = ++nextId; timers.set(id, { at: now + delayMs, callback }); return id;
      },
      cancelScheduled: (id: unknown) => { timers.delete(id as number); },
    },
    get pending() { return timers.size; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = end;
    },
  };
};
let passed = 0;
const test = (name: string, check: () => void) => { check(); passed += 1; console.log(`ok ${passed} - ${name}`); };

test('projection retains runtime primitives and explicit clears, never a job/snapshot', () => {
  const job = { stage: 'running' as const, progress: 15, downloadError: undefined,
    snapshot: { draft: { prompt: 'large'.repeat(20000) }, images: [{ dataUrl: 'data:image/png;base64,large' }] },
    connection: { apiKey: 'never-retained' }, response: { data: 'large' }, tailPreparation: { phase: 'waiting' } };
  const value = pickVideoRuntime(job);
  assert.deepEqual(Object.keys(value), ['stage', 'progress', 'downloadError']);
  assert.equal(Object.hasOwn(value, 'downloadError'), true);
  assert.equal(Object.hasOwn(value, 'message'), false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.keys(value).every((key) => VIDEO_RUNTIME_FIELDS.includes(key as keyof VideoGenerationRuntime)), true);
  assert.equal(JSON.stringify(value).includes('large'), false);
  assert.equal(videoRuntimeEqual(value, { ...value }), true);
  assert.equal(videoRuntimeEqual(value, { stage: 'running', progress: 15 }), false, 'explicit undefined differs from an absent override');
});

test('progress bursts publish at most once per interval and preserve unrelated task identity', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  store.update('a', { stage: 'running', progress: 0 });
  store.update('b', { stage: 'queued' });
  const originalA = store.getTaskSnapshot('a'); const originalB = store.getTaskSnapshot('b');
  let aRenders = 0; let bRenders = 0; let listRenders = 0;
  store.subscribeTask('a', () => { aRenders++; }); store.subscribeTask('b', () => { bRenders++; });
  store.subscribe(() => { listRenders++; });
  for (let step = 1; step <= 1000; step++) store.update('a', { stage: 'running', progress: step / 10, step, totalSteps: 1000 });
  assert.equal(time.pending, 1);
  assert.equal(store.getTaskSnapshot('a'), originalA);
  assert.equal(aRenders, 0); assert.equal(listRenders, 0);
  time.advance(199); assert.equal(aRenders, 0);
  time.advance(1);
  assert.equal(aRenders, 1); assert.equal(listRenders, 1); assert.equal(bRenders, 0);
  assert.equal(store.getTaskSnapshot('a')?.step, 1000);
  assert.equal(store.getTaskSnapshot('b'), originalB);
  assert.equal(time.pending, 0);
  const published = store.getSnapshot();
  for (let repeat = 0; repeat < 1000; repeat++) store.update('a', { stage: 'running', progress: 100, step: 1000, totalSteps: 1000 });
  assert.equal(store.getSnapshot(), published); assert.equal(time.pending, 0); assert.equal(aRenders, 1);
  store.dispose();
});

test('a one-second event stream yields five coalesced paints, not one per sample', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  store.update('task', { stage: 'running', step: 0 });
  let updates = 0; store.subscribeTask('task', () => { updates++; });
  for (let step = 1; step <= 100; step++) { store.update('task', { stage: 'running', step }); time.advance(10); }
  assert.equal(updates, 5); assert.equal(store.getTaskSnapshot('task')?.step, 100);
  store.dispose();
});

test('stage transitions, terminal results, cancellations and errors flush immediately', () => {
  for (const next of [
    { stage: 'succeeded', completedAt: 5 }, { stage: 'failed', message: 'failed' }, { stage: 'stopped', trackingStopped: true },
    { stage: 'submission-unknown', message: 'confirm original request' }, { stage: 'downloading', generatedAt: 4 },
    { stage: 'running', cancellationPending: true }, { stage: 'running', cancellationConfirmed: true },
    { stage: 'running', downloadError: 'save failed' },
  ] satisfies VideoGenerationRuntime[]) {
    const time = clock(); const store = createVideoRuntimeStore(time.options);
    store.update('task', { stage: 'running', step: 0 });
    store.update('task', { stage: 'running', step: 2 });
    assert.equal(time.pending, 1);
    store.update('task', next);
    assert.deepEqual(store.getTaskSnapshot('task'), next);
    assert.equal(time.pending, 0);
    time.advance(1000);
    assert.deepEqual(store.getTaskSnapshot('task'), next, 'an old pending progress event cannot overwrite a terminal/cancel state');
    store.dispose();
  }
});

test('clearing a visible error/stop flag is immediate and explicit undefined stays visible', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  store.update('task', { stage: 'downloading', downloadError: 'old error', cancellationPending: true });
  store.update('task', { stage: 'downloading', downloadError: undefined, cancellationPending: false });
  assert.equal(store.getTaskSnapshot('task')?.downloadError, undefined);
  assert.equal(Object.hasOwn(store.getTaskSnapshot('task')!, 'downloadError'), true);
  assert.equal(store.getTaskSnapshot('task')?.cancellationPending, false);
  assert.equal(time.pending, 0);
  store.dispose();
});

test('terminal flushes for one task leave the other task at its own scheduled cadence', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  store.update('a', { stage: 'running', step: 0 }); store.update('b', { stage: 'running', step: 0 });
  store.update('a', { stage: 'running', step: 2 }); store.update('b', { stage: 'running', step: 3 });
  store.update('a', { stage: 'failed' });
  assert.equal(store.getTaskSnapshot('b')?.step, 0); assert.equal(time.pending, 1);
  time.advance(200); assert.equal(store.getTaskSnapshot('b')?.step, 3);
  store.dispose();
});

test('a burst that returns to the visible value produces no redundant notification', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  store.update('a', { stage: 'running', progress: 10 });
  let notifications = 0; store.subscribe(() => { notifications++; });
  store.update('a', { stage: 'running', progress: 11 }); store.update('a', { stage: 'running', progress: 10 });
  assert.equal(time.pending, 0); time.advance(200); assert.equal(notifications, 0);
  store.dispose();
});

test('remove/clear/unsubscribe/dispose release pending work and do not resurrect stale entries', () => {
  const time = clock(); const store = createVideoRuntimeStore(time.options);
  let notifications = 0;
  const unsubscribe = store.subscribeTask('task', () => { notifications++; });
  store.update('task', { stage: 'running', step: 0 }); store.update('task', { stage: 'running', step: 1 });
  store.remove('task'); assert.equal(time.pending, 0); time.advance(1000); assert.equal(store.getTaskSnapshot('task'), undefined);
  const removedCount = notifications;
  store.update('task', { stage: 'running', step: 0 }); store.update('task', { stage: 'running', step: 1 });
  store.clear(); assert.equal(time.pending, 0); assert.equal(Object.keys(store.getSnapshot()).length, 0);
  store.update('task', { stage: 'queued' });
  assert.equal(notifications, removedCount + 3, 'clear retains the hook subscription for StrictMode effect replay');
  unsubscribe(); const beforeDispose = notifications;
  store.update('task', { stage: 'running' }); store.update('task', { stage: 'running', step: 2 });
  store.dispose(); assert.equal(time.pending, 0);
  store.update('task', { stage: 'succeeded' }); time.advance(1000);
  assert.equal(notifications, beforeDispose); assert.equal(Object.keys(store.getSnapshot()).length, 0);
});

test('unusual task ids remain isolated keys instead of object-prototype fields', () => {
  const store = createVideoRuntimeStore();
  assert.equal(store.getTaskSnapshot('toString'), undefined);
  for (const id of ['__proto__', 'constructor', 'toString']) store.update(id, { stage: 'queued', message: id });
  for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(store.getTaskSnapshot(id)?.message, id);
  store.remove('__proto__'); assert.equal(store.getTaskSnapshot('__proto__'), undefined);
  store.dispose();
});

test('subscriber exceptions cannot interrupt generation callbacks or other task/list views', () => {
  const store = createVideoRuntimeStore(); let healthy = 0;
  store.subscribeTask('task', () => { throw new Error('bad view'); });
  store.subscribeTask('task', () => { healthy++; }); store.subscribe(() => { healthy++; });
  assert.doesNotThrow(() => store.update('task', { stage: 'failed' }));
  assert.equal(healthy, 2); store.dispose();
});

test('public React hooks support store-backed snapshots and old controllers without a store', () => {
  const store = createVideoRuntimeStore(); store.update('a', { stage: 'running', progress: 20 });
  const fallback = { a: { stage: 'queued' as const, progress: 5 } };
  const View = ({ useStore }: { useStore: boolean }) => {
    const active = useVideoTaskRuntime('a', useStore ? store : undefined, fallback.a);
    const missing = useVideoTaskRuntime('absent', useStore ? store : undefined, fallback.a);
    const all = useVideoRuntimes(useStore ? store : undefined, fallback);
    return React.createElement('span', { 'data-stage': active?.stage, 'data-progress': all.a.progress, 'data-missing': missing?.stage || 'absent' });
  };
  const live = renderToStaticMarkup(React.createElement(View, { useStore: true }));
  assert.match(live, /data-stage="running"/u); assert.match(live, /data-progress="20"/u); assert.match(live, /data-missing="absent"/u);
  const legacy = renderToStaticMarkup(React.createElement(View, { useStore: false }));
  assert.match(legacy, /data-stage="queued"/u); assert.match(legacy, /data-progress="5"/u);
  store.dispose();
});

console.log(`videoRuntimeStore: ${passed} isolated store/hook checks passed`);
