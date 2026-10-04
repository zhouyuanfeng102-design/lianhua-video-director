import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createStateCloseGuard } = require('../electron/stateCloseGuard.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

const fixture = (options = {}) => {
  const window = new EventEmitter();
  const sent = [];
  const notices = [];
  let closed = false;
  window.webContents = { send: (channel, payload) => { sent.push({ channel, payload }); } };
  window.close = () => {
    let prevented = false;
    window.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) { closed = true; window.emit('closed'); }
  };
  const guard = createStateCloseGuard({ window, flush: async () => {},
    showMessage: async (message) => { notices.push(message); return { response: 0 }; }, ...options });
  return { window, guard, sent, notices, get closed() { return closed; },
    get requests() { return sent.filter((message) => message.channel === 'lianhua:before-close'); },
    get cancelled() { return sent.filter((message) => message.channel === 'lianhua:close-cancelled'); },
  };
};

test('close asks renderer for one latest-state save, rejects stale ack, and waits for durable worker flush', async () => {
  const durable = deferred();
  let flushCalls = 0;
  const h = fixture({ flush: () => { flushCalls += 1; return durable.promise; } });
  h.window.close();
  h.window.close();
  assert.equal(h.closed, false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].channel, 'lianhua:before-close');
  assert.equal(h.guard.acknowledge({ requestId: 'foreign-window-or-stale', ok: true }), false);
  assert.equal(h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: 'true' }), false);
  assert.equal(h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true }), true);
  assert.equal(h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true }), false);
  await tick();
  assert.equal(flushCalls, 1);
  assert.equal(h.closed, false);
  assert.equal(h.cancelled.length, 0, 'successful ACK is not a cancellation or permission to unlock while flush is pending');
  durable.resolve();
  await tick();
  assert.equal(h.closed, true);
  assert.equal(h.notices.length, 0);
  assert.equal(h.cancelled.length, 0);
});

test('renderer save failure preserves the window and allows an explicit fresh close attempt', async () => {
  const h = fixture();
  h.window.close();
  const oldId = h.sent[0].payload.requestId;
  h.guard.acknowledge({ requestId: oldId, ok: false, error: 'fixture disk full' });
  await tick();
  assert.equal(h.closed, false);
  assert.match(h.notices[0].detail, /disk full/u);
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId: oldId }]);
  h.window.close();
  assert.equal(h.requests.length, 2);
  assert.equal(h.guard.acknowledge({ requestId: oldId, ok: true }), false);
  h.guard.acknowledge({ requestId: h.requests[1].payload.requestId, ok: true });
  await tick();
  assert.equal(h.closed, true);
});

test('worker flush failure never closes the already-acknowledged renderer', async () => {
  const h = fixture({ flush: async () => { throw new Error('uncertain state write'); } });
  h.window.close();
  h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true });
  await tick();
  assert.equal(h.closed, false);
  assert.match(h.notices[0].detail, /uncertain state write/u);
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId: h.requests[0].payload.requestId }]);
});

test('unresponsive renderer produces a bounded wait prompt and cancel keeps unsaved content open', async () => {
  const prompted = deferred();
  const h = fixture({ timeoutMs: 5, showMessage: async (message) => { prompted.resolve(message); return { response: 0 }; } });
  h.window.close();
  const firstId = h.sent[0].payload.requestId;
  const notice = await prompted.promise;
  assert.match(notice.title, /等待/u);
  await tick();
  assert.equal(h.closed, false);
  assert.equal(h.guard.acknowledge({ requestId: firstId, ok: true }), false, 'late ack cannot close a cancelled attempt');
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId: firstId }]);
  h.window.close();
  assert.equal(h.requests.length, 2);
  h.guard.acknowledge({ requestId: h.requests[1].payload.requestId, ok: true });
  await tick();
  assert.equal(h.closed, true);
});

test('continue waiting does not send another save or duplicate the final close', async () => {
  const prompted = deferred();
  const choice = deferred();
  const h = fixture({ timeoutMs: 5, showMessage: async () => { prompted.resolve(); await choice.promise; return { response: 1 }; } });
  h.window.close();
  await prompted.promise;
  h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true });
  choice.resolve();
  await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.closed, true);
  assert.equal(h.cancelled.length, 0);
});

test('destroyed/crashed window cleanup releases its pending acknowledgement', async () => {
  const h = fixture();
  h.window.close();
  h.window.emit('closed');
  await tick();
  assert.equal(h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true }), false);
  assert.equal(h.notices.length, 0);
});

test('window destruction also releases an unresolved worker flush without a late warning dialog', async () => {
  const h = fixture({ flush: () => new Promise(() => {}), timeoutMs: 5 });
  h.window.close();
  h.guard.acknowledge({ requestId: h.sent[0].payload.requestId, ok: true });
  await tick();
  h.window.emit('closed');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.notices.length, 0);
  assert.equal(h.guard.allowed, false);
  assert.equal(h.cancelled.length, 0);
});

test('returning during a slow flush unlocks only that attempt and its late completion cannot close a later attempt', async () => {
  const firstFlush = deferred();
  const prompted = deferred();
  const choice = deferred();
  let calls = 0;
  const h = fixture({
    flush: () => ++calls === 1 ? firstFlush.promise : Promise.resolve(), timeoutMs: 10,
    showMessage: async () => { prompted.resolve(); await choice.promise; return { response: 0 }; },
  });
  h.window.close();
  const firstId = h.requests[0].payload.requestId;
  assert.equal(h.guard.acknowledge({ requestId: firstId, ok: true }), true);
  await prompted.promise;
  assert.equal(h.cancelled.length, 0);
  choice.resolve();
  await tick();
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId: firstId }]);
  h.window.close();
  const secondId = h.requests[1].payload.requestId;
  assert.notEqual(secondId, firstId);
  firstFlush.resolve();
  await tick();
  assert.equal(h.closed, false);
  assert.equal(h.guard.acknowledge({ requestId: firstId, ok: true }), false);
  assert.equal(h.guard.acknowledge({ requestId: secondId, ok: true }), true);
  await tick();
  assert.equal(h.closed, true);
  assert.equal(h.cancelled.length, 1);
});

test('a native close exception sends a matching cancellation instead of leaving the renderer locked', async () => {
  const h = fixture();
  h.window.close();
  const requestId = h.requests[0].payload.requestId;
  h.window.close = () => { throw new Error('native close fixture error'); };
  h.guard.acknowledge({ requestId, ok: true });
  await tick();
  assert.equal(h.guard.allowed, false);
  assert.equal(h.closed, false);
  assert.match(h.notices[0].detail, /native close/u);
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId }]);
});

test('a rejected native error dialog still emits cancellation and does not leak a rejected close attempt', async () => {
  const h = fixture({ showMessage: async () => { throw new Error('native dialog unavailable'); } });
  h.window.close();
  const requestId = h.requests[0].payload.requestId;
  h.guard.acknowledge({ requestId, ok: false, error: 'save failed' });
  await tick();
  assert.equal(h.closed, false);
  assert.deepEqual(h.cancelled.map((message) => message.payload), [{ requestId }]);
});

test('preload close-cancelled listener forwards only the payload and supports exact cleanup', () => {
  const source = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const events = new EventEmitter();
  let bridge;
  vm.runInNewContext(source, { require: (specifier) => {
    assert.equal(specifier, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: events, webUtils: {} };
  } });
  const received = [];
  const unsubscribe = bridge.onCloseCancelled((payload) => received.push(payload));
  const payload = { requestId: 'only-matching-attempt' };
  events.emit('lianhua:close-cancelled', { unsafeIpcEvent: true }, payload);
  assert.deepEqual(received, [payload]);
  assert.equal(events.listenerCount('lianhua:close-cancelled'), 1);
  unsubscribe();
  assert.equal(events.listenerCount('lianhua:close-cancelled'), 0);
  events.emit('lianhua:close-cancelled', {}, { requestId: 'after-unmount' });
  assert.equal(received.length, 1);
});
