import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createRendererCrashRecovery } = require('../electron/rendererCrashRecovery.cjs');
const { createStateCloseGuard } = require('../electron/stateCloseGuard.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const fixture = (options = {}) => {
  const window = new EventEmitter();
  const notices = [];
  const logs = [];
  const choice = deferred();
  let destroyed = false;
  let closing = false;
  let loads = 0;
  window.isDestroyed = () => destroyed;
  window.webContents = new EventEmitter();
  window.webContents.isDestroyed = () => destroyed;
  window.webContents.getURL = () => 'https://untrusted.invalid/last-url';
  const recovery = createRendererCrashRecovery({
    window, showMessage: (message) => { notices.push(message); return choice.promise; },
    loadRenderer: async () => { loads += 1; }, isClosing: () => closing, log: (line) => logs.push(line), ...options,
  });
  return { window, notices, logs, choice, recovery,
    crash: (reason = 'crashed') => window.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 }),
    destroy: () => { destroyed = true; window.emit('closed'); },
    closing: (value) => { closing = value; },
    get loads() { return loads; },
  };
};

test('OOM is visible in a main-process dialog and reopens only after an explicit choice', async () => {
  const h = fixture();
  h.crash('oom');
  await tick();
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].message, /内存不足/u);
  assert.match(h.notices[0].detail, /已保存的项目仍保留/u);
  assert.match(h.notices[0].detail, /不代表任务已取消/u);
  assert.deepEqual(h.notices[0].buttons, ['重新打开界面', '暂不恢复']);
  assert.equal(h.notices[0].cancelId, 1);
  assert.equal(h.loads, 0);
  h.choice.resolve({ response: 0 });
  await h.recovery.pending;
  assert.equal(h.loads, 1);
  assert.match(h.logs[0], /user requested trusted entry reload/u);
});

test('dismissal never reloads, clears data, or invokes another application action', async () => {
  const h = fixture();
  h.crash();
  h.choice.resolve({ response: 1 });
  await h.recovery.pending;
  assert.equal(h.loads, 0);
  assert.equal(h.logs.length, 0);
  assert.equal(h.recovery.pending, undefined);
});

test('normal-exit and killed events do not show crash recovery', async () => {
  const h = fixture();
  h.crash('normal-exit');
  h.crash('killed');
  await tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.loads, 0);
});

test('abnormal renderer reasons share the explicit recovery path', async () => {
  for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure']) {
    const h = fixture();
    h.crash(reason);
    h.choice.resolve({ response: 1 });
    await h.recovery.pending;
    assert.equal(h.notices.length, 1, reason);
    assert.match(h.notices[0].message, /界面进程意外停止/u);
  }
});

test('duplicate crash events cannot stack dialogs or trigger concurrent reloads', async () => {
  const loading = deferred();
  let loads = 0;
  const h = fixture({ loadRenderer: () => { loads += 1; return loading.promise; } });
  h.crash();
  h.crash('oom');
  await tick();
  assert.equal(h.notices.length, 1);
  h.choice.resolve({ response: 0 });
  await tick();
  h.crash();
  await tick();
  assert.equal(h.notices.length, 1);
  assert.equal(loads, 1);
  loading.resolve();
  await h.recovery.pending;
  assert.equal(loads, 1);
});

test('a later separate crash requires another user choice instead of automatic retry', async () => {
  const choices = [deferred(), deferred()];
  const notices = [];
  let calls = 0;
  const h = fixture({ showMessage: (message) => { notices.push(message); return choices[calls++].promise; } });
  h.crash();
  choices[0].resolve({ response: 0 });
  await h.recovery.pending;
  h.crash();
  await tick();
  assert.equal(notices.length, 2);
  assert.equal(h.loads, 1);
  choices[1].resolve({ response: 1 });
  await h.recovery.pending;
  assert.equal(h.loads, 1);
});

test('closing before or during the dialog prevents reopening', async () => {
  const h = fixture();
  h.closing(true);
  h.crash();
  await tick();
  assert.equal(h.notices.length, 0);
  h.closing(false);
  h.crash();
  await tick();
  assert.equal(h.notices.length, 1);
  h.closing(true);
  h.choice.resolve({ response: 0 });
  await h.recovery.pending;
  assert.equal(h.loads, 0);
});

test('closing in the event microtask gap also suppresses the dialog', async () => {
  const h = fixture();
  h.crash();
  h.closing(true);
  await h.recovery.pending;
  assert.equal(h.notices.length, 0);
});

test('window destruction removes listeners and a late response cannot reload', async () => {
  const h = fixture();
  h.crash();
  await tick();
  h.destroy();
  assert.equal(h.window.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(h.window.webContents.listenerCount('destroyed'), 0);
  h.choice.resolve({ response: 0 });
  await h.recovery.pending;
  assert.equal(h.loads, 0);
  h.crash();
  assert.equal(h.notices.length, 1);
});

test('webContents destruction and explicit disposal also stop recovery', async () => {
  const h = fixture();
  h.window.webContents.emit('destroyed');
  h.crash();
  await tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.window.listenerCount('closed'), 0);
  h.recovery.dispose();
});

test('failed reload is reported once without retry, and rejected dialogs are contained', async () => {
  const notices = [];
  let loads = 0;
  const h = fixture({
    showMessage: async (message) => {
      notices.push(message);
      if (notices.length === 1) return { response: 0 };
      throw new Error('native dialog unavailable');
    },
    loadRenderer: async () => { loads += 1; throw new Error('fixture load failure'); },
  });
  h.crash();
  await h.recovery.pending;
  assert.equal(loads, 1);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].title, '界面恢复未完成');
  assert.match(h.logs.join('\n'), /fixture load failure/u);
  assert.match(h.logs.join('\n'), /native dialog unavailable/u);
  assert.equal(h.recovery.pending, undefined);
});

test('an initial native dialog failure does not trigger a reload or unhandled rejection', async () => {
  const h = fixture({ showMessage: async () => { throw new Error('dialog failed'); } });
  h.crash();
  await h.recovery.pending;
  assert.equal(h.loads, 0);
  assert.match(h.logs[0], /dialog failed/u);
});

test('close guard exposes only live close status and cancellation releases the recovery suppression', async () => {
  const window = new EventEmitter();
  const requests = [];
  window.webContents = { send: (_channel, payload) => requests.push(payload) };
  window.close = () => window.emit('close', { preventDefault() {} });
  const guard = createStateCloseGuard({ window, flush: async () => {}, showMessage: async () => ({ response: 0 }) });
  assert.equal(guard.pending, false);
  window.close();
  assert.equal(guard.pending, true);
  guard.acknowledge({ requestId: requests[0].requestId, ok: false, error: 'fixture cancel' });
  await tick();
  assert.equal(guard.pending, false);
  assert.equal(guard.allowed, false);
});

test('desktop recovery uses the original trusted entry and attaches before the first load', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const createWindow = main.slice(main.indexOf('function createWindow()'), main.indexOf('\nlet videoWorkbench;'));
  assert.match(createWindow, /const loadRenderer = \(\) => isDev \? win\.loadURL\(devServerUrl\) : win\.loadFile\(rendererEntryPath\)/u);
  const recovery = createWindow.indexOf('createRendererCrashRecovery({');
  assert.ok(recovery > 0);
  assert.ok(createWindow.indexOf('void loadRenderer()') > recovery);
  assert.match(createWindow.slice(recovery), /stateCloseGuards\.get\(win\.webContents\)\?\.pending/u);
  assert.doesNotMatch(createWindow.slice(recovery), /webContents\.(?:reload|loadURL|getURL)\(/u);
});
