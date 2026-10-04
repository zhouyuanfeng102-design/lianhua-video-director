import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const scriptNames = ['electronSmoke.mjs', 'mediaUiSmoke.mjs', 'packagedSmoke.mjs', 'uiSmoke.mjs', 'videoTaskIpcSmoke.mjs'];
const sources = new Map(scriptNames.map((name) => [name, fs.readFileSync(path.join(root, 'scripts', name), 'utf8')]));

const createSocket = (readyState = 1) => {
  const listeners = new Map();
  return {
    readyState,
    closeCalls: 0,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener));
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener({ type, ...event });
    },
    send() {},
    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    },
  };
};

const loadCdpHarness = (scriptName, { commandTimeoutMs = 10, connectionTimeoutMs = 10, readyState = 1 } = {}) => {
  const source = sources.get(scriptName);
  const start = source.indexOf('let id = 0;');
  const end = source.indexOf('const evaluate', start);
  const waitForOpenSource = source.slice(source.indexOf('const waitForSocketOpen')).match(/^const waitForSocketOpen[\s\S]*?\n\s*\}\);/u)?.[0];
  assert.ok(start >= 0 && end > start && waitForOpenSource, `${scriptName} must define bounded CDP connection and command sections`);

  const socket = createSocket(readyState);
  const context = vm.createContext({
    clearTimeout,
    connectionTimeoutMs,
    Error,
    JSON,
    Map,
    process: { env: { CDP_COMMAND_TIMEOUT_MS: String(commandTimeoutMs) } },
    setTimeout,
    socket,
    String,
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
  });
  vm.runInContext(
    `${waitForOpenSource}\n${source.slice(start, end)}\n;globalThis.__qa = { command, failPending, pending, waitForSocketOpen };`,
    context,
    { filename: scriptName },
  );
  return { socket, ...context.__qa };
};

const within = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} remained pending`)), 150); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

for (const scriptName of scriptNames) {
  test(`${scriptName} bounds target discovery fetch and WebSocket open`, async () => {
    const source = sources.get(scriptName);
    assert.match(source, /fetch\(\s*`http:\/\/127\.0\.0\.1:\$\{(?:port|cdpPort)\}\/json\/list`\s*,\s*\{\s*signal:\s*AbortSignal\.timeout\(connectionTimeoutMs\),?\s*\}/u);
    assert.match(source, /const waitForSocketOpen\s*=\s*\(\)\s*=>/u);

    const harness = loadCdpHarness(scriptName, { connectionTimeoutMs: 5, readyState: 0 });
    await assert.rejects(within(harness.waitForSocketOpen(), `${scriptName} WebSocket open`), /timed out|超时/i);
  });

  test(`${scriptName} bounds every command and clears pending work`, async () => {
    const timeoutHarness = loadCdpHarness(scriptName, { commandTimeoutMs: 5 });
    await assert.rejects(within(timeoutHarness.command('Runtime.evaluate'), `${scriptName} command`), /timed out|超时/i);
    assert.equal(timeoutHarness.pending.size, 0);

    for (const eventType of ['close', 'error']) {
      const disconnectHarness = loadCdpHarness(scriptName, { commandTimeoutMs: 1000 });
      const first = disconnectHarness.command('Runtime.evaluate');
      const second = disconnectHarness.command('Page.captureScreenshot');
      disconnectHarness.socket.dispatch(eventType, eventType === 'close' ? { reason: 'lost' } : { message: 'failed' });
      await Promise.all([
        assert.rejects(within(first, `${scriptName} first disconnected command`), /CDP|socket|WebSocket/i),
        assert.rejects(within(second, `${scriptName} second disconnected command`), /CDP|socket|WebSocket/i),
      ]);
      assert.equal(disconnectHarness.pending.size, 0);
    }

    const unopenedHarness = loadCdpHarness(scriptName, { readyState: 0 });
    await assert.rejects(unopenedHarness.command('Runtime.evaluate'), /not open/i);
    assert.equal(unopenedHarness.pending.size, 0);
  });

  test(`${scriptName} closes its CDP socket from finally`, () => {
    assert.match(
      sources.get(scriptName),
      /finally\s*\{[\s\S]*?failPending\([^)]*\);\s*socket(?:\?\.|\.)close\(\);/u,
    );
  });
}

test('media smoke target selection tolerates a page target without a title', () => {
  const source = sources.get('mediaUiSmoke.mjs');
  const assignment = source.match(/target\s*=\s*(targets\.find\(\(item\).*?\)\s*\|\|\s*targets\.find\(\(item\).*?\));/);
  assert.ok(assignment, 'Media target selection expression must remain discoverable');
  const selectTarget = vm.runInNewContext(`(targets) => ${assignment[1]}`);
  const untitledPage = { type: 'page' };

  assert.doesNotThrow(() => selectTarget([untitledPage]));
  assert.equal(selectTarget([untitledPage]), untitledPage);
});

test('video task smoke always closes its mock HTTP server', () => {
  const source = sources.get('videoTaskIpcSmoke.mjs');
  const outerCleanup = source.slice(source.lastIndexOf('} finally {'));
  assert.match(
    outerCleanup,
    /finally\s*\{[\s\S]*await new Promise\(\(resolve\)\s*=>\s*server\.close\(resolve\)\);\s*\}\s*$/u,
  );
});

test('electron smoke gives its aggregate state and package transaction the long command budget', () => {
  assert.match(
    sources.get('electronSmoke.mjs'),
    /const result = await evaluate\(`\(async \(\) => \{[\s\S]*?\}\)\(\)`,\s*startupCommandTimeoutMs\s*\);/u,
    'the aggregate save, restore, backup, export, import, media and security transaction must not use the 10-second single-command budget',
  );
});
