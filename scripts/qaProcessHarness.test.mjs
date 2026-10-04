import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const harnessModule = await import('./qaProcessHarness.mjs').catch((loadError) => ({ loadError }));

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  close(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

test('QA process harness reports an early Electron exit with the caller-specific label and collected output', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(101);
  const harness = harnessModule.createQaProcessHarness({ electron, qaLabel: 'desktop QA', closeTimeoutMs: 20 });
  const failure = assert.rejects(
    harness.qaFailure,
    /Electron exited before desktop QA completed \(code=7, signal=none\)/
  );

  electron.stdout.emit('data', Buffer.from('renderer output\n'));
  electron.stderr.emit('data', Buffer.from('renderer warning\n'));
  electron.emit('exit', 7, null);
  electron.close(7);

  await failure;
  await harness.waitForElectronClose();
  assert.match(harness.readElectronLog(), /renderer output/);
  assert.match(harness.readElectronLog(), /renderer warning/);
  assert.match(harness.readElectronLog(), /Electron exited before desktop QA completed/);
  harness.markElectronStopping();
});

test('QA process harness kills and waits for every active QA child', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(102);
  const killed = [];
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'media QA',
    closeTimeoutMs: 20,
    killProcessTree: (child) => {
      killed.push(child.pid);
      queueMicrotask(() => child.close(null, 'SIGKILL'));
    },
  });
  const first = new FakeChild(201);
  const second = new FakeChild(202);
  const firstClosed = harness.trackQaChild(first);
  const secondClosed = harness.trackQaChild(second);

  await harness.stopQaChildren();

  assert.deepEqual(killed, [201, 202]);
  assert.deepEqual(await firstClosed, { code: null, signal: 'SIGKILL' });
  assert.deepEqual(await secondClosed, { code: null, signal: 'SIGKILL' });
  assert.equal(harness.activeQaChildren.size, 0);
  harness.markElectronStopping();
});

test('QA process harness rejects cleanup when a killed child never closes', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(103);
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'desktop QA',
    closeTimeoutMs: 10,
    killProcessTree: () => ({ status: 0 }),
  });
  const stuckChild = new FakeChild(203);
  harness.trackQaChild(stuckChild);

  await assert.rejects(harness.stopQaChildren(), /did not close|timed out|cleanup/i);
  assert.equal(harness.activeQaChildren.size, 1);
  harness.markElectronStopping();
});

test('QA process harness falls back to ChildProcess.kill when taskkill fails', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(104);
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'media QA',
    closeTimeoutMs: 20,
    killProcessTree: () => ({ status: 1, error: new Error('taskkill unavailable') }),
  });
  const child = new FakeChild(204);
  const fallbackSignals = [];
  child.kill = (signal) => {
    fallbackSignals.push(signal);
    queueMicrotask(() => child.close(null, signal));
    return true;
  };
  harness.trackQaChild(child);

  await harness.stopQaChildren();
  assert.deepEqual(fallbackSignals, ['SIGKILL']);
  assert.equal(harness.activeQaChildren.size, 0);
  harness.markElectronStopping();
});

test('QA process harness applies verified process-tree cleanup to Electron', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(105);
  const killed = [];
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'desktop QA',
    closeTimeoutMs: 20,
    killProcessTree: (child) => {
      killed.push(child.pid);
      queueMicrotask(() => child.close(null, 'SIGKILL'));
      return { status: 0 };
    },
  });
  harness.markElectronStopping();

  assert.equal(typeof harness.stopElectron, 'function', 'harness must expose verified Electron cleanup');
  await harness.stopElectron();
  assert.deepEqual(killed, [105]);
});

test('QA process harness still stops Electron when a QA child cleanup fails', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(106);
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'desktop QA',
    closeTimeoutMs: 10,
    killProcessTree: (child) => {
      if (child === electron) queueMicrotask(() => electron.close(null, 'SIGKILL'));
      return { status: 0 };
    },
  });
  harness.trackQaChild(new FakeChild(206));
  harness.markElectronStopping();

  assert.equal(typeof harness.stopAll, 'function', 'harness must expose best-effort aggregate cleanup');
  await assert.rejects(harness.stopAll(), /QA child 206.*did not close|cleanup/i);
  await harness.waitForElectronClose();
});

test('QA process harness rejects the run when its overall deadline expires', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(107);
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'desktop QA',
    runTimeoutMs: 10,
  });

  assert.equal(typeof harness.qaFailure?.then, 'function', 'harness must expose an overall QA failure promise');
  await assert.rejects(harness.qaFailure, /desktop QA timed out.*10ms/i);
  harness.markElectronStopping();
});

test('QA process harness turns SIGINT into a cancellable run failure and removes signal listeners', async () => {
  assert.equal(typeof harnessModule.createQaProcessHarness, 'function', harnessModule.loadError?.message);
  const electron = new FakeChild(108);
  const signalSource = new EventEmitter();
  const harness = harnessModule.createQaProcessHarness({
    electron,
    qaLabel: 'desktop QA',
    runTimeoutMs: 20,
    signalSource,
  });
  const interrupted = assert.rejects(
    harness.qaFailure,
    (error) => error?.signal === 'SIGINT' && error?.exitCode === 130,
  );

  signalSource.emit('SIGINT');
  await interrupted;
  harness.markElectronStopping();
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
