import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8');

const createResponse = (status, headers, chunks = []) => {
  const body = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  body.statusCode = status;
  body.headers = headers;
  return body;
};

const loadMainInternals = ({ dnsLookup, failPreferredDataRoot = false, fetchImpl, platform = process.platform, transportRequest, proxyResolver, proxyAgentFactory } = {}) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-electron-review-'));
  const dataRoot = path.join(temporaryRoot, 'data');
  const controls = { failNextWrite: false, failPreferredDataRoot, forbidReadFilePath: '', forbidSyncIo: false };
  controls.rejectImageDecode = false;
  const isPreferredDataPath = (candidate) => {
    const relative = path.relative(dataRoot, path.resolve(candidate));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const forbiddenSyncMethods = new Set([
    'closeSync', 'copyFileSync', 'existsSync', 'fsyncSync', 'mkdirSync', 'openSync',
    'readFileSync', 'readdirSync', 'renameSync', 'statSync', 'unlinkSync',
  ]);
  const fsModule = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'mkdirSync') {
        return (directory, ...args) => {
          if (controls.failPreferredDataRoot && isPreferredDataPath(directory)) {
            const error = new Error('simulated preferred data-root failure');
            error.code = 'EACCES';
            throw error;
          }
          if (controls.forbidSyncIo) throw new Error('synchronous mkdirSync used during backup');
          return fs.mkdirSync(directory, ...args);
        };
      }
      if (property === 'readFileSync') {
        return (file, ...args) => {
          if (controls.forbidReadFilePath && path.resolve(file) === path.resolve(controls.forbidReadFilePath)) {
            throw new Error('whole-file read used while hashing');
          }
          if (controls.forbidSyncIo) throw new Error('synchronous readFileSync used during backup');
          return fs.readFileSync(file, ...args);
        };
      }
      if (property === 'writeFileSync') {
        return (file, content, ...args) => {
          if (controls.failNextWrite) {
            controls.failNextWrite = false;
            fs.writeFileSync(file, Buffer.from('partial-write'));
            throw new Error('simulated interrupted write');
          }
          if (controls.forbidSyncIo) throw new Error('synchronous writeFileSync used during backup');
          return fs.writeFileSync(file, content, ...args);
        };
      }
      if (controls.forbidSyncIo && forbiddenSyncMethods.has(property)) {
        return () => { throw new Error(`synchronous ${String(property)} used during backup`); };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const appPaths = { userData: path.join(temporaryRoot, 'legacy') };
  const electron = {
    app: {
      getPath: (name) => appPaths[name] || path.join(temporaryRoot, name),
      setPath: (name, value) => { appPaths[name] = value; },
      setAppLogsPath: (value) => { appPaths.logs = value; },
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: {},
    // This unit harness exercises IPC/storage, not codec internals. The real
    // native PNG/JPEG decoder is tested by generatedImageNativeDecode.cjs.
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => controls.rejectImageDecode }) },
    net: {},
    session: proxyResolver ? { defaultSession: { resolveProxy: proxyResolver } } : undefined,
    protocol: { registerSchemesAsPrivileged() {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
      decryptString: (value) => String(value).replace(/^encrypted:/, ''),
    },
    shell: {},
  };
  const defaultLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const request = transportRequest || (() => { throw new Error('unexpected transport request'); });
  const processMock = {
    argv: ['node', mainPath],
    env: { ...process.env, LIANHUA_DATA_DIR: dataRoot },
    execPath: process.execPath,
    pid: process.pid,
    platform,
  };
  const context = vm.createContext({
    AbortController,
    Buffer,
    Response,
    URL,
    clearTimeout,
    console,
    fetch: fetchImpl || globalThis.fetch,
    globalThis: null,
    process: processMock,
    require: (specifier) => {
      if (specifier === 'electron') return electron;
      if (specifier === 'fs') return fsModule;
      if (specifier === 'dns') return { promises: { lookup: dnsLookup || defaultLookup } };
      if (specifier === 'http' || specifier === 'https') return { request };
      if (specifier === './imageReferenceTransport.cjs') {
        return require(path.join(root, 'electron', 'imageReferenceTransport.cjs'));
      }
      if (specifier === './systemProxyTransport.cjs') {
        const helpers = require(path.join(root, 'electron', 'systemProxyTransport.cjs'));
        return proxyAgentFactory ? { ...helpers, createProxyTunnelAgent: proxyAgentFactory } : helpers;
      }
      return require(specifier);
    },
    setTimeout,
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
  });
  context.globalThis = context;
  const cutoff = mainSource.indexOf("if (process.platform === 'win32')");
  assert.ok(cutoff > 0, 'main-process test cutoff marker must exist');
  vm.runInContext(`${mainSource.slice(0, cutoff)}\n;globalThis.__review = {
    approveReadPath: typeof approveReadPath === 'function' ? approveReadPath : undefined,
    abortAllModelRequests: typeof abortAllModelRequests === 'function' ? abortAllModelRequests : undefined,
    abortModelRequestsForSender: typeof abortModelRequestsForSender === 'function' ? abortModelRequestsForSender : undefined,
    assetRoot,
    assertRemoteResolution,
    copyImportedAssetIntoStore: typeof copyImportedAssetIntoStore === 'function' ? copyImportedAssetIntoStore : undefined,
    createModelHttpRequestOptions: typeof createModelHttpRequestOptions === 'function' ? createModelHttpRequestOptions : undefined,
    encodeModelHttpResponse: typeof encodeModelHttpResponse === 'function' ? encodeModelHttpResponse : undefined,
    dataRoot,
    downloadIntoAssetStore,
    exportMediaToPath: typeof exportMediaToPath === 'function' ? exportMediaToPath : undefined,
    fetchWithLimit,
    fileSha256,
    formatConsoleMessageForLog: typeof formatConsoleMessageForLog === 'function' ? formatConsoleMessageForLog : undefined,
    isApprovedReadPath: typeof isApprovedReadPath === 'function' ? isApprovedReadPath : undefined,
    isPathInside: typeof isPathInside === 'function' ? isPathInside : undefined,
    isPrivateHostname,
    isSamePath,
    isTrustedRendererUrl: typeof isTrustedRendererUrl === 'function' ? isTrustedRendererUrl : undefined,
    lastRecoveryNotice,
    legacyUserData,
    powershellArchive,
    powershellExpand,
    readManagedImageDataUrlForRenderer: typeof readManagedImageDataUrlForRenderer === 'function' ? readManagedImageDataUrlForRenderer : undefined,
    registerModelRequest: typeof registerModelRequest === 'function' ? registerModelRequest : undefined,
    remapImportedManagedPaths: typeof remapImportedManagedPaths === 'function' ? remapImportedManagedPaths : undefined,
    requestResolvedTarget,
    saveSecrets,
    storeGeneratedImageInAssetStore: typeof storeGeneratedImageInAssetStore === 'function' ? storeGeneratedImageInAssetStore : undefined,
    finishModelRequest: typeof finishModelRequest === 'function' ? finishModelRequest : undefined,
    cancelModelRequest: typeof cancelModelRequest === 'function' ? cancelModelRequest : undefined,
    syncImportedGeneratedVideoNames: typeof syncImportedGeneratedVideoNames === 'function' ? syncImportedGeneratedVideoNames : undefined,
    withTrustedIpcSender: typeof withTrustedIpcSender === 'function' ? withTrustedIpcSender : undefined,
    writeExternalBackup
  };`, context, { filename: mainPath });
  return {
    ...context.__review,
    configuredDataRoot: dataRoot,
    controls,
    dispose: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    temporaryRoot,
  };
};

test('desktop renderer trust rejects remote start pages while preserving packaged and loopback pages', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.isTrustedRendererUrl, 'function', 'main process must expose one renderer trust boundary');

  const packagedEntry = path.join(root, 'dist', 'index.html');
  assert.equal(harness.isTrustedRendererUrl(`file:///${packagedEntry.replace(/\\/gu, '/')}`, {
    dev: false,
    rendererEntryPath: packagedEntry,
  }), true);
  assert.equal(harness.isTrustedRendererUrl('file:///C:/Users/Public/remote.html', {
    dev: false,
    rendererEntryPath: packagedEntry,
  }), false);
  assert.equal(harness.isTrustedRendererUrl('http://127.0.0.1:5173/director', {
    dev: true,
    devServerUrl: 'http://127.0.0.1:5173',
    rendererEntryPath: packagedEntry,
  }), true);
  assert.equal(harness.isTrustedRendererUrl('http://localhost:5173/director', {
    dev: true,
    devServerUrl: 'http://localhost:5173',
    rendererEntryPath: packagedEntry,
  }), true);
  for (const untrusted of [
    'https://attacker.example/',
    'http://127.0.0.1.attacker.example:5173/',
    'http://127.0.0.1:5174/',
    'blob:http://127.0.0.1:5173/opaque-id',
    'data:text/html,<script>steal()</script>',
  ]) {
    assert.equal(harness.isTrustedRendererUrl(untrusted, {
      dev: true,
      devServerUrl: 'http://127.0.0.1:5173',
      rendererEntryPath: packagedEntry,
    }), false, untrusted);
  }
  assert.equal(harness.isTrustedRendererUrl('https://attacker.example/app', {
    dev: true,
    devServerUrl: 'https://attacker.example',
    rendererEntryPath: packagedEntry,
  }), false, 'an untrusted configured start URL must not authorize itself');
});

test('desktop IPC rejects an untrusted sender before invoking a sensitive handler', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.withTrustedIpcSender, 'function', 'sensitive IPC must share one sender guard');

  let invocationCount = 0;
  const protectedHandler = harness.withTrustedIpcSender(async (_event, value) => {
    invocationCount += 1;
    return value;
  });
  await assert.rejects(
    protectedHandler({ senderFrame: { url: 'https://attacker.example/' } }, 'secret'),
    /不受信任|renderer|来源/iu,
  );
  await assert.rejects(protectedHandler({}, 'secret'), /不受信任|renderer|来源/iu);
  const nestedFrame = { url: 'file:///trusted/index.html', top: {} };
  await assert.rejects(protectedHandler({ senderFrame: nestedFrame }, 'secret'), /不受信任|renderer|来源/iu);
  assert.equal(invocationCount, 0, 'untrusted senders must be rejected before handler side effects');

  const packagedEntry = path.join(root, 'dist', 'index.html');
  const packagedUrl = `file:///${packagedEntry.replace(/\\/gu, '/')}`;
  const mainFrame = { url: packagedUrl };
  mainFrame.top = mainFrame;
  assert.equal(await protectedHandler({ senderFrame: mainFrame }, 'allowed'), 'allowed');
  assert.equal(invocationCount, 1);
});

const loadCdpHarness = (scriptName) => {
  const source = fs.readFileSync(path.join(root, 'scripts', scriptName), 'utf8');
  const start = source.indexOf('let id = 0;');
  const end = source.indexOf("await command('Runtime.enable'", start);
  assert.ok(start > 0 && end > start, `${scriptName} CDP harness markers must exist`);
  const listeners = new Map();
  const socket = {
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener({ type, ...event });
    },
    send() {},
  };
  const context = vm.createContext({ console, globalThis: null, JSON, socket, String });
  context.globalThis = context;
  vm.runInContext(`${source.slice(start, end)}\n;globalThis.__review = { command, consoleErrors, pending };`, context, { filename: scriptName });
  return { socket, ...context.__review };
};

test('remote requests connect through the validated address on every redirect while preserving Host and SNI', async (t) => {
  const lookupCounts = new Map();
  const publicAddresses = new Map([
    ['first.example', '93.184.216.34'],
    ['second.example', '151.101.1.69'],
  ]);
  const dnsLookup = async (hostname) => {
    const count = (lookupCounts.get(hostname) || 0) + 1;
    lookupCounts.set(hostname, count);
    return [{ address: count === 1 ? publicAddresses.get(hostname) : '127.0.0.1', family: 4 }];
  };
  const connections = [];
  const responses = [];
  const responseFor = (hostname) => {
    const response = hostname === 'first.example'
      ? Object.assign(new Readable({ read() {} }), { statusCode: 302, headers: { location: 'https://second.example/final', 'content-length': '0' } })
      : createResponse(200, { 'content-length': '2' }, ['ok']);
    responses.push(response);
    return response;
  };
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    const [{ address }] = await dnsLookup(url.hostname);
    connections.push({ address, host: url.host, servername: url.hostname });
    const response = responseFor(url.hostname);
    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      headers: { get: (name) => response.headers[name.toLowerCase()] || null },
      body: response,
    };
  };
  const transportRequest = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(url.hostname, { all: false }, (error, address, family) => {
        if (error) return request.emit('error', error);
        connections.push({ address, family, host: options.headers.host, servername: options.servername, agent: options.agent });
        queueMicrotask(() => onResponse(responseFor(url.hostname)));
      });
    };
    request.write = () => {};
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  const harness = loadMainInternals({ dnsLookup, fetchImpl, transportRequest });
  t.after(harness.dispose);

  const result = await harness.fetchWithLimit('https://first.example/start');

  assert.equal(result.bytes.toString('utf8'), 'ok');
  assert.deepEqual(connections, [
    { address: '93.184.216.34', family: 4, host: 'first.example', servername: 'first.example', agent: false },
    { address: '151.101.1.69', family: 4, host: 'second.example', servername: 'second.example', agent: false },
  ]);
  assert.deepEqual(Object.fromEntries(lookupCounts), { 'first.example': 1, 'second.example': 1 });
  assert.equal(responses[0].destroyed, true, 'redirect response body must be destroyed before following Location');
});

test('model HTTP requests use the system proxy tunnel and dispose it after reading the response', async (t) => {
  const routes = [];
  const tunnels = [];
  const agent = { destroyed: false, destroy() { this.destroyed = true; } };
  let transportAgent;
  const harness = loadMainInternals({
    proxyResolver: async (url) => { routes.push(url); return 'PROXY 127.0.0.1:10808'; },
    proxyAgentFactory: async (target, options) => { tunnels.push({ target, options }); return agent; },
    transportRequest: (_url, options, callback) => {
      transportAgent = options.agent;
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => callback(createResponse(200, {}, ['proxy-result'])));
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  const result = await harness.fetchWithLimit('https://api.example.test/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer qa-only' }, body: '{}' });
  assert.equal(result.bytes.toString(), 'proxy-result');
  assert.deepEqual(routes, ['https://api.example.test/v1/images/generations']);
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].target.address, '93.184.216.34');
  assert.equal(tunnels[0].options.proxyUrl, 'http://127.0.0.1:10808/');
  assert.equal(transportAgent, agent);
  assert.equal(agent.destroyed, true);
});

test('a failed system proxy never falls back to a direct paid POST', async (t) => {
  let originCalls = 0;
  const harness = loadMainInternals({
    proxyResolver: async () => 'PROXY 127.0.0.1:10808; DIRECT',
    proxyAgentFactory: async () => { throw new Error('系统代理连接失败：ECONNREFUSED'); },
    transportRequest: (_url, _options, callback) => {
      originCalls += 1;
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => callback(createResponse(200, {}, ['unexpected'])));
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  await assert.rejects(harness.fetchWithLimit('https://api.example.test/image', { method: 'POST', body: '{}' }), /系统代理连接失败/u);
  assert.equal(originCalls, 0);
});

test('TLS handshake failure retains its real code, endpoint and phase across message-only IPC without replaying POST', async (t) => {
  let attempts = 0;
  const harness = loadMainInternals({
    proxyResolver: async () => 'DIRECT',
    transportRequest: (_url, _options, _callback) => {
      attempts += 1;
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => request.emit('error', Object.assign(
        new Error('Client network socket disconnected before secure TLS connection was established'),
        { code: 'ECONNRESET' },
      )));
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  await assert.rejects(harness.fetchWithLimit('https://api.example.test/private-token/v1/images/generations?api_key=never-show-this', {
    method: 'POST', headers: { Authorization: 'Bearer never-show-this' }, body: '{"prompt":"do not replay"}',
  }), (error) => {
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(error.networkStage, 'tls-handshake');
    assert.match(error.message, /before secure TLS connection was established/u);
    assert.match(error.message, /错误码：ECONNRESET/u);
    assert.match(error.message, /阶段：TLS 握手/u);
    assert.match(error.message, /接口：https:\/\/api\.example\.test/u);
    assert.match(error.message, /路由：直连/u);
    assert.match(error.message, /未取得 HTTP 响应/u);
    assert.doesNotMatch(error.message, /private-token|never-show-this|do not replay/u);
    return true;
  });
  assert.equal(attempts, 1, 'diagnostic enrichment must not retry a generation POST');
});

test('a reset after secureConnect is waiting-response failure, not an unsent TLS-handshake failure', async (t) => {
  let attempts = 0;
  const agent = { destroyed: false, destroy() { this.destroyed = true; } };
  const harness = loadMainInternals({
    proxyResolver: async () => 'PROXY 127.0.0.1:10808',
    proxyAgentFactory: async () => agent,
    transportRequest: () => {
      attempts += 1;
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const socket = Object.assign(new EventEmitter(), { connecting: true, authorized: false });
        request.emit('socket', socket);
        socket.emit('connect');
        socket.emit('secureConnect');
        request.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      });
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  await assert.rejects(harness.fetchWithLimit('https://api.example.test/v1/images/generations', { method: 'POST', body: '{}' }), (error) => {
    assert.equal(error.networkStage, 'response');
    assert.match(error.message, /阶段：等待接口响应/u);
    assert.match(error.message, /路由：系统代理/u);
    assert.doesNotMatch(error.message, /TLS 握手|未提交|未发送/u);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(agent.destroyed, true);
});

test('DNS and proxy connection failures carry different safe diagnostics without opening an origin POST', async (t) => {
  let attempts = 0;
  const dnsHarness = loadMainInternals({
    dnsLookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND' }); },
    transportRequest: () => { attempts += 1; },
  });
  const proxyHarness = loadMainInternals({
    proxyResolver: async () => 'PROXY 127.0.0.1:10808',
    proxyAgentFactory: async () => { throw Object.assign(new Error('系统代理连接失败：ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    transportRequest: () => { attempts += 1; },
  });
  t.after(dnsHarness.dispose);
  t.after(proxyHarness.dispose);
  await assert.rejects(dnsHarness.fetchWithLimit('https://api.example.test/private?token=secret', { method: 'POST', body: '{}' }), (error) => {
    assert.equal(error.code, 'ENOTFOUND');
    assert.equal(error.networkStage, 'dns');
    assert.match(error.message, /阶段：域名解析/u);
    assert.doesNotMatch(error.message, /token=secret|\/private/u);
    return true;
  });
  await assert.rejects(proxyHarness.fetchWithLimit('https://api.example.test/v1/images/generations', { method: 'POST', body: '{}' }), (error) => {
    assert.equal(error.code, 'ECONNREFUSED');
    assert.equal(error.networkStage, 'proxy-connect');
    assert.match(error.message, /阶段：建立系统代理隧道/u);
    return true;
  });
  assert.equal(attempts, 0);
});

test('response stream failure is explicitly after HTTP response and leaves cancellation unchanged', async (t) => {
  const harness = loadMainInternals({
    transportRequest: (_url, _options, callback) => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => callback(Object.assign(new Readable({
        read() { this.destroy(Object.assign(new Error('response closed early'), { code: 'ECONNRESET' })); },
      }), { statusCode: 200, headers: {} })));
      request.destroy = () => {};
      return request;
    },
  });
  const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
  const cancelledHarness = loadMainInternals({
    transportRequest: () => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => request.emit('error', cancelled));
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  t.after(cancelledHarness.dispose);
  await assert.rejects(harness.fetchWithLimit('https://api.example.test/image', { method: 'POST', body: '{}' }), (error) => {
    assert.equal(error.networkStage, 'response-body');
    assert.match(error.message, /已取得 HTTP 响应，响应读取未完成/u);
    assert.doesNotMatch(error.message, /未取得 HTTP 响应/u);
    return true;
  });
  await assert.rejects(cancelledHarness.fetchWithLimit('https://api.example.test/image'), (error) => error === cancelled);
});

test('private redirects are rejected before a second proxy tunnel opens', async (t) => {
  let tunnels = 0;
  const harness = loadMainInternals({
    proxyResolver: async () => 'PROXY 127.0.0.1:10808',
    proxyAgentFactory: async () => { tunnels += 1; return { destroy() {} }; },
    transportRequest: (_url, _options, callback) => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => callback(createResponse(302, { location: 'http://127.0.0.1/private' })));
      request.destroy = () => {};
      return request;
    },
  });
  t.after(harness.dispose);
  await assert.rejects(harness.fetchWithLimit('https://api.example.test/image', { method: 'POST', body: '{}' }), /已阻止/u);
  assert.equal(tunnels, 1);
});

test('connection timeout bounds a stalled socket without shortening processing after TLS connects', async (t) => {
  let connectSocket = false;
  const harness = loadMainInternals({
    transportRequest: (_url, _options, callback) => {
      const request = new EventEmitter();
      request.destroy = (error) => { if (error) request.emit('error', error); };
      request.end = () => {
        if (!connectSocket) return;
        queueMicrotask(() => {
          const socket = new EventEmitter();
          socket.connecting = true;
          socket.authorized = false;
          request.emit('socket', socket);
          socket.authorized = true;
          socket.emit('secureConnect');
        });
        setTimeout(() => callback(createResponse(200, {}, ['processed'])), 45);
      };
      return request;
    },
  });
  t.after(harness.dispose);
  const target = { url: 'https://api.example.test', address: '93.184.216.34', family: 4 };
  const stalled = await Promise.race([
    harness.requestResolvedTarget(target, { connectTimeoutMs: 15 }).then(() => null, (error) => error),
    new Promise((resolve) => setTimeout(() => resolve(new Error('still waiting for connection')), 100)),
  ]);
  assert.match(stalled.message, /连接超时/u);
  connectSocket = true;
  const connected = await harness.requestResolvedTarget(target, { connectTimeoutMs: 15 });
  assert.equal(connected.status, 200);
});

test('IPv6 private prefixes do not classify ordinary DNS hostnames as private', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(harness.isPrivateHostname('fda.example'), false);
  assert.equal(harness.isPrivateHostname('fc-api.example'), false);
  assert.equal(harness.isPrivateHostname('fd00::1'), true);
});

test('private IP literals are classified before the DNS-resolution guard', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(harness.isPrivateHostname('100.64.0.1'), true);
  assert.equal(harness.isPrivateHostname('::ffff:127.0.0.1'), true);
});

test('IPv4-mapped IPv6 loopback addresses are rejected as private resolution targets', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  await assert.rejects(
    harness.assertRemoteResolution('http://[::ffff:127.0.0.1]/metadata'),
    /本机|局域网/
  );
});

test('carrier-grade NAT addresses are rejected because they are not public targets', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  await assert.rejects(harness.assertRemoteResolution('http://100.64.0.1/service'), /本机|局域网/);
});

test('an oversized declared response is destroyed before fetchWithLimit rejects it', async (t) => {
  let response;
  const transportRequest = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(url.hostname, { all: false }, (error) => {
        if (error) return request.emit('error', error);
        response = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: { 'content-length': '11' } });
        queueMicrotask(() => onResponse(response));
      });
    };
    request.destroy = () => {};
    return request;
  };
  const harness = loadMainInternals({ transportRequest });
  t.after(harness.dispose);

  await assert.rejects(harness.fetchWithLimit('https://oversized.example/', {}, 10), /响应超过/);
  assert.equal(response.destroyed, true);
});

const runRedirectRequest = async ({ body, headers = {}, method = 'GET', redirectOrigin = 'https://second.example', status }) => {
  const requests = [];
  const dnsLookup = async (hostname) => [{ address: hostname === 'first.example' ? '93.184.216.34' : '151.101.1.69', family: 4 }];
  const transportRequest = (url, options, onResponse) => {
    const request = new EventEmitter();
    const record = { body: undefined, headers: { ...options.headers }, method: options.method, url: url.toString() };
    requests.push(record);
    request.end = (requestBody) => {
      record.body = requestBody;
      options.lookup(url.hostname, { all: false }, (error) => {
        if (error) return request.emit('error', error);
        const response = requests.length === 1
          ? createResponse(status, { location: `${redirectOrigin}/final`, 'content-length': '0' })
          : createResponse(200, { 'content-length': '2' }, ['ok']);
        queueMicrotask(() => onResponse(response));
      });
    };
    request.destroy = () => {};
    return request;
  };
  const harness = loadMainInternals({ dnsLookup, transportRequest });
  try {
    const result = await harness.fetchWithLimit('https://first.example/start', { body, headers, method });
    return { requests, result };
  } finally {
    harness.dispose();
  }
};

test('301, 302, and 303 redirects drop POST bodies and cross-origin credentials', async () => {
  for (const status of [301, 302, 303]) {
    const { requests, result } = await runRedirectRequest({
      status,
      method: 'POST',
      body: 'secret prompt',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'X-Api-Key': 'api-secret',
        'X-Custom-Token': 'token-secret',
        'Content-Type': 'application/json',
        'X-Trace-Id': 'trace-safe',
      },
    });
    assert.equal(result.bytes.toString('utf8'), 'ok');
    assert.equal(requests[1].method, 'GET', `HTTP ${status}`);
    assert.equal(requests[1].body, undefined, `HTTP ${status}`);
    const redirectedHeaders = Object.fromEntries(Object.entries(requests[1].headers).map(([name, value]) => [name.toLowerCase(), value]));
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-custom-token', 'content-type']) assert.equal(redirectedHeaders[name], undefined, `HTTP ${status} leaked ${name}`);
    assert.equal(redirectedHeaders['x-trace-id'], 'trace-safe');
  }
});

test('read-only metadata requests can opt out of every redirect, including same-origin POST replay', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const requests = []; const responses = [];
    const harness = loadMainInternals({
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transportRequest: (url, options, onResponse) => {
        requests.push(url.toString());
        const request = new EventEmitter();
        request.end = () => {
          const response = createResponse(status, { location: 'https://cloud.example/openapi/v2/run/workflow/123', 'content-length': '0' });
          responses.push(response); queueMicrotask(() => onResponse(response));
        };
        request.destroy = () => {};
        return request;
      },
    });
    try {
      const options = harness.createModelHttpRequestOptions({ method: 'POST', body: '{"apiKey":"fake-test-key"}', redirect: 'error' });
      assert.equal(options.redirect, 'error');
      assert.equal(harness.createModelHttpRequestOptions({ method: 'POST', body: '{}' }).redirect, undefined, 'existing requests retain their original redirect policy');
      await assert.rejects(harness.fetchWithLimit('https://cloud.example/api/openapi/getJsonApiFormat', options), /不允许接口重定向/u);
      assert.equal(requests.length, 1, `HTTP ${status} must never call the redirected generation endpoint`);
      assert.equal(responses[0].destroyed, true);
    } finally { harness.dispose(); }
  }
});

test('307 and 308 preserve same-origin method/body but reject cross-origin POST body forwarding', async () => {
  for (const status of [307, 308]) {
    const sameOrigin = await runRedirectRequest({ status, redirectOrigin: 'https://first.example', method: 'POST', body: 'same-origin-body', headers: { Authorization: 'Bearer same-origin' } });
    assert.equal(sameOrigin.requests[1].method, 'POST', `HTTP ${status}`);
    assert.equal(sameOrigin.requests[1].body, 'same-origin-body', `HTTP ${status}`);
    assert.equal(sameOrigin.requests[1].headers.Authorization, 'Bearer same-origin', `HTTP ${status}`);

    await assert.rejects(
      runRedirectRequest({ status, method: 'POST', body: 'must-not-leak', headers: { Authorization: 'Bearer secret' } }),
      /跨站重定向.*正文/
    );
  }
});

test('307 cross-origin GET strips credentials while preserving the GET method', async () => {
  const { requests } = await runRedirectRequest({
    status: 307,
    method: 'GET',
    headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'api-secret', 'X-Safe': 'keep' },
  });
  const redirectedHeaders = Object.fromEntries(Object.entries(requests[1].headers).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(requests[1].method, 'GET');
  assert.equal(redirectedHeaders.authorization, undefined);
  assert.equal(redirectedHeaders['x-api-key'], undefined);
  assert.equal(redirectedHeaders['x-safe'], 'keep');
});

test('non-redirect 3xx statuses are returned instead of following Location', async () => {
  for (const status of [300, 304, 305, 306]) {
    const { requests, result } = await runRedirectRequest({ status });
    assert.equal(result.response.status, status);
    assert.equal(requests.length, 1, `HTTP ${status} must not follow Location`);
  }
});

test('generated-media download aborts a stalled connection after its timeout', async (t) => {
  let requestDestroyed = false;
  const transportRequest = (_url, options) => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => { requestDestroyed = true; };
    options.signal?.addEventListener('abort', () => {
      requestDestroyed = true;
      request.emit('error', options.signal.reason || new Error('aborted'));
    }, { once: true });
    return request;
  };
  const harness = loadMainInternals({ transportRequest });
  t.after(harness.dispose);

  await Promise.race([
    assert.rejects(harness.downloadIntoAssetStore('https://slow.example/video.mp4', {}, 20), /超时|abort/i),
    new Promise((_, reject) => setTimeout(() => reject(new Error('generated-media download did not time out')), 150)),
  ]);
  assert.equal(requestDestroyed, true);
});

test('rhTV public-only download rejects private hosts, HTTP and unsafe redirects before fetching them', async (t) => {
  for (const [url, redirect] of [
    ['http://cdn.example/video.mp4', ''], ['https://127.0.0.1/video.mp4', ''],
    ['https://cdn.example/video.mp4', 'https://127.0.0.1/video.mp4'],
    ['https://cdn.example/video.mp4', 'http://cdn.example/video.mp4'],
  ]) {
    let requests = 0;
    const harness = loadMainInternals({ transportRequest: (_url, _options, callback) => {
      requests += 1;
      const request = new EventEmitter();
      request.end = () => callback(createResponse(302, { location: redirect }));
      request.destroy = () => {};
      return request;
    } });
    t.after(harness.dispose);
    await assert.rejects(harness.downloadIntoAssetStore(url, {}, { publicOnly: true }), /公网 HTTPS|私有|本机|内网|loopback|private|不允许/i);
    assert.equal(requests, redirect ? 1 : 0);
  }
});

test('rhTV download enforces size limits for both declared and streamed bodies without leaving partial files', async (t) => {
  for (const declared of [true, false]) {
    const harness = loadMainInternals({ transportRequest: (_url, _options, callback) => {
      const request = new EventEmitter();
      request.end = () => callback(createResponse(200, { 'content-type': 'video/mp4', ...(declared ? { 'content-length': '20' } : {}) }, ['0123456789', '0123456789']));
      request.destroy = () => {};
      return request;
    } });
    t.after(harness.dispose);
    await assert.rejects(harness.downloadIntoAssetStore('https://cdn.example/video.mp4', {}, { publicOnly: true, maxBytes: 12 }), /大小限制/);
    const files = fs.readdirSync(harness.dataRoot, { recursive: true });
    assert.equal(files.some((name) => String(name).endsWith('.part')), false);
  }
});

test('model request options explicitly disable elapsed and connection timeouts', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  const signal = new AbortController().signal;
  const options = harness.createModelHttpRequestOptions({ method: 'POST', body: '{}', timeoutMs: 1 }, signal);
  assert.equal(options.signal, signal, 'explicit caller cancellation must remain connected');
  assert.equal(options.noTimeout, true, 'model transport must wait until the upstream responds');
  assert.equal('timeoutMs' in options, false, 'legacy timeout values must not reach the transport');
});

test('model request cancellation is isolated by sender and cleaned on completion or destruction', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.registerModelRequest, 'function');
  assert.equal(typeof harness.cancelModelRequest, 'function');

  const senderA = new EventEmitter();
  const senderB = new EventEmitter();
  const requestA = harness.registerModelRequest(senderA, 'shared-request-id');
  const requestB = harness.registerModelRequest(senderB, 'shared-request-id');

  assert.equal(harness.cancelModelRequest(senderA, 'shared-request-id'), true);
  assert.equal(requestA.signal.aborted, true, 'the matching sender request must abort');
  assert.equal(requestB.signal.aborted, false, 'the same ID from another sender must remain active');
  assert.equal(harness.cancelModelRequest(senderA, 'shared-request-id'), false, 'cancelling twice must be harmless');
  assert.equal(harness.finishModelRequest(senderA, 'shared-request-id', requestA), true);
  assert.equal(harness.finishModelRequest(senderA, 'shared-request-id', requestA), false, 'completed requests must be removed');

  senderB.emit('destroyed');
  assert.equal(requestB.signal.aborted, true, 'destroying a renderer must abort all requests owned by it');
  assert.equal(harness.cancelModelRequest(senderB, 'shared-request-id'), false);

  const senderC = new EventEmitter();
  const requestC = harness.registerModelRequest(senderC, 'close-request-id');
  assert.equal(harness.abortAllModelRequests(), 1, 'application shutdown must abort remaining model requests');
  assert.equal(requestC.signal.aborted, true);
});

test('media export decodes an embedded image and copies a managed asset', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.exportMediaToPath, 'function', 'main process must expose the media export writer');

  const embeddedTarget = path.join(harness.temporaryRoot, 'embedded.png');
  const embeddedBytes = Buffer.from('generated-image-bytes');
  await harness.exportMediaToPath({
    dataUrl: `data:image/png;base64,${embeddedBytes.toString('base64')}`,
  }, embeddedTarget);
  assert.deepEqual(fs.readFileSync(embeddedTarget), embeddedBytes);

  const relativePath = path.join('image', 'managed.png');
  const managedSource = path.join(harness.dataRoot, 'assets', relativePath);
  fs.mkdirSync(path.dirname(managedSource), { recursive: true });
  fs.writeFileSync(managedSource, 'managed-image-bytes');
  const managedTarget = path.join(harness.temporaryRoot, 'managed-copy.png');
  await harness.exportMediaToPath({ relativePath }, managedTarget);
  assert.equal(fs.readFileSync(managedTarget, 'utf8'), 'managed-image-bytes');
});

test('remote generated-image export does not install a transport timeout', async (t) => {
  let socketTimeout;
  const transportRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      const socket = new EventEmitter();
      socket.authorized = true;
      socket.setTimeout = (value) => { socketTimeout = value; };
      request.emit('socket', socket);
      queueMicrotask(() => callback(createResponse(200, { 'content-type': 'image/png' }, ['remote-image-bytes'])));
    };
    request.destroy = () => {};
    return request;
  };
  const harness = loadMainInternals({ transportRequest });
  t.after(harness.dispose);
  const target = path.join(harness.temporaryRoot, 'remote.png');

  await harness.exportMediaToPath({ url: 'https://images.example.test/generated.png' }, target);

  assert.equal(socketTimeout, 0, 'remote generated-image export must keep the socket unbounded');
  assert.equal(fs.readFileSync(target, 'utf8'), 'remote-image-bytes');
});

test('media export rejects malformed, oversized, and path-traversal sources', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.exportMediaToPath, 'function', 'main process must expose the media export writer');
  const target = path.join(harness.temporaryRoot, 'rejected.png');

  await assert.rejects(
    harness.exportMediaToPath({ dataUrl: 'data:text/plain;base64,bm90LWltYWdl' }, target),
    /图片|媒体|格式/u,
  );
  await assert.rejects(
    harness.exportMediaToPath({ relativePath: '../outside.png' }, target),
    /越界/u,
  );
  assert.equal(fs.existsSync(target), false);
});

test('project import preserves both same-named videos and remaps managed metadata', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.copyImportedAssetIntoStore, 'function');
  assert.equal(typeof harness.remapImportedManagedPaths, 'function');

  const originalRelativePath = 'video/同名视频.mp4';
  const existingPath = path.join(harness.assetRoot, originalRelativePath);
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  fs.writeFileSync(existingPath, 'existing-project-video');
  const incomingPath = path.join(harness.temporaryRoot, 'incoming-video.mp4');
  const incomingBytes = Buffer.from('different-imported-project-video');
  fs.writeFileSync(incomingPath, incomingBytes);
  const checksum = createHash('sha256').update(incomingBytes).digest('hex');

  const importedRelativePath = harness.copyImportedAssetIntoStore(incomingPath, originalRelativePath, checksum);
  assert.equal(importedRelativePath, 'video/同名视频 · 第 2 版.mp4');
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'existing-project-video', 'the local same-name file must never be overwritten');
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, importedRelativePath)), incomingBytes);

  const importedState = { project: { assets: [{
    name: '同名视频', fileName: '同名视频.mp4', relativePath: originalRelativePath,
    sourceVideoTaskId: 'generated-task',
    url: 'lianhua-asset://local/video/%E5%90%8C%E5%90%8D%E8%A7%86%E9%A2%91.mp4',
  }], generationTasks: [{ id: 'generated-task', videoJob: { snapshot: { draft: { name: '同名视频' } } } }] } };
  harness.remapImportedManagedPaths(importedState, new Map([[originalRelativePath, importedRelativePath]]));
  harness.syncImportedGeneratedVideoNames(importedState);
  const asset = importedState.project.assets[0];
  assert.equal(asset.name, '同名视频 · 第 2 版');
  assert.equal(asset.fileName, '同名视频 · 第 2 版.mp4');
  assert.equal(asset.relativePath, importedRelativePath);
  assert.equal(asset.url, 'lianhua-asset://local/video/%E5%90%8C%E5%90%8D%E8%A7%86%E9%A2%91%20%C2%B7%20%E7%AC%AC%202%20%E7%89%88.mp4');
  assert.equal(importedState.project.generationTasks[0].videoJob.snapshot.draft.name, '同名视频 · 第 2 版');
});

test('generated image data URLs are content-addressed in the managed image store', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(
    typeof harness.storeGeneratedImageInAssetStore,
    'function',
    'main process must expose a generated-image asset-store writer',
  );

  const pngBytes = Buffer.from(require('./fixtures/generatedImageSamples.json').png, 'base64');
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
  const expectedChecksum = createHash('sha256').update(pngBytes).digest('hex');

  const first = await harness.storeGeneratedImageInAssetStore({
    dataUrl,
    fileName: '第 1 镜.png',
  });
  const second = await harness.storeGeneratedImageInAssetStore({
    dataUrl,
    fileName: '重复图片.png',
  });

  assert.equal(first.checksum, expectedChecksum);
  assert.equal(first.relativePath, `image/${expectedChecksum}.png`);
  assert.equal(first.relativePath, second.relativePath, 'identical image bytes must deduplicate');
  assert.equal(first.sizeBytes, pngBytes.length);
  assert.equal(first.mediaType, 'image');
  assert.equal(first.mimeType, 'image/png');
  assert.equal(first.managed, true);
  assert.equal(first.missing, false);
  assert.match(first.url, /^lianhua-asset:\/\/local\/image\//u);
  assert.deepEqual(
    fs.readFileSync(path.join(harness.dataRoot, 'assets', first.relativePath)),
    pngBytes,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(harness.dataRoot, 'assets', 'image')),
    [`${expectedChecksum}.png`],
    'deduplication must leave only one managed file',
  );
  assert.doesNotMatch(JSON.stringify(first), /base64|data:image/u, 'metadata must not retain embedded image data');
});

test('generated image storage accepts JPEG and WebP but rejects unsafe or oversized payloads', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.storeGeneratedImageInAssetStore, 'function');

  const samples = require('./fixtures/generatedImageSamples.json');
  const jpegBytes = Buffer.from(samples.jpeg, 'base64');
  const webpBytes = Buffer.from(samples.webp, 'base64');
  const jpeg = await harness.storeGeneratedImageInAssetStore({
    dataUrl: `data:image/jpeg;base64,${jpegBytes.toString('base64')}`,
  });
  const webp = await harness.storeGeneratedImageInAssetStore({
    dataUrl: `data:image/webp;base64,${webpBytes.toString('base64')}`,
  });
  assert.match(jpeg.relativePath, /^image\/[a-f0-9]{64}\.jpg$/u);
  assert.match(webp.relativePath, /^image\/[a-f0-9]{64}\.webp$/u);
  const mislabeled = await harness.storeGeneratedImageInAssetStore({ dataUrl: `data:image/png;base64,${samples.jpeg}`, fileName: 'upstream-wrong-name.png' });
  assert.equal(mislabeled.mimeType, 'image/jpeg');
  assert.equal(mislabeled.fileName, 'upstream-wrong-name.jpg');
  assert.equal(mislabeled.checksum, createHash('sha256').update(jpegBytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(harness.dataRoot, 'assets', mislabeled.relativePath)), jpegBytes);
  harness.controls.rejectImageDecode = true;
  await assert.rejects(harness.storeGeneratedImageInAssetStore({ dataUrl: `data:image/png;base64,${samples.png}` }), /损坏|截断|解码/u, 'a supported signature does not bypass a failed PNG/JPEG decode');
  harness.controls.rejectImageDecode = false;

  await assert.rejects(
    harness.storeGeneratedImageInAssetStore({ dataUrl: 'data:image/gif;base64,R0lGODlh' }),
    /PNG|JPEG|WebP|格式/u,
  );
  await assert.rejects(
    harness.storeGeneratedImageInAssetStore({
      dataUrl: `data:image/png;base64,${Buffer.from('not-a-png').toString('base64')}`,
    }),
    /PNG|签名|格式/u,
  );
  await assert.rejects(
    harness.storeGeneratedImageInAssetStore({ dataUrl: 'data:image/png;base64,%%%%' }),
    /Base64|格式/u,
  );
  const oversized = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32 * 1024 * 1024, 0x61),
  ]);
  await assert.rejects(
    harness.storeGeneratedImageInAssetStore({
      dataUrl: `data:image/png;base64,${oversized.toString('base64')}`,
    }),
    /32 MB|过大|超过/u,
  );
});

test('managed reference images are read from the asset root with signature and checksum validation', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(
    typeof harness.readManagedImageDataUrlForRenderer,
    'function',
    'main process must expose the managed-reference reader used by its IPC handler',
  );

  const pngBytes = Buffer.from(require('./fixtures/generatedImageSamples.json').png, 'base64');
  const checksum = createHash('sha256').update(pngBytes).digest('hex');
  const relativePath = `image/${checksum}.png`;
  const managedPath = path.join(harness.dataRoot, 'assets', relativePath);
  fs.mkdirSync(path.dirname(managedPath), { recursive: true });
  fs.writeFileSync(managedPath, pngBytes);

  const result = harness.readManagedImageDataUrlForRenderer({ relativePath, expectedChecksum: checksum });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    mimeType: 'image/png',
    sizeBytes: pngBytes.length,
    checksum,
  });
  assert.throws(
    () => harness.readManagedImageDataUrlForRenderer({ relativePath, expectedChecksum: '0'.repeat(64) }),
    /校验失败|内容已变化/u,
  );
  assert.throws(
    () => harness.readManagedImageDataUrlForRenderer({ relativePath: '../outside.png' }),
    /越界|相对路径/u,
  );
});

test('structured multipart image requests travel through the hardened Buffer transport', async (t) => {
  const requests = [];
  const transportRequest = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = (body) => {
      requests.push({ url: url.toString(), options, body });
      onResponse(createResponse(200, { 'content-length': '2' }, ['ok']));
    };
    request.destroy = () => {};
    return request;
  };
  const harness = loadMainInternals({ transportRequest });
  t.after(harness.dispose);
  assert.equal(
    typeof harness.createModelHttpRequestOptions,
    'function',
    'main process must expose the request-option builder used by lianhua:http-request',
  );

  const samples = require('./fixtures/generatedImageSamples.json');
  const firstBytes = Buffer.from(samples.png, 'base64');
  const secondBytes = Buffer.from(samples.jpeg, 'base64');
  const options = harness.createModelHttpRequestOptions({
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
    },
    multipart: {
      fields: [
        { name: 'model', value: 'gpt-image-2' },
        { name: 'prompt', value: 'keep both references' },
      ],
      files: [
        { name: 'image[]', fileName: 'first.png', dataUrl: `data:image/png;base64,${firstBytes.toString('base64')}` },
        { name: 'image[]', fileName: 'second.jpg', dataUrl: `data:image/jpeg;base64,${secondBytes.toString('base64')}` },
      ],
    },
  });
  await harness.fetchWithLimit('https://images.example.test/v1/images/edits', options);

  assert.equal(requests.length, 1);
  assert.ok(Buffer.isBuffer(requests[0].body), 'multipart request body must reach node:http as a Buffer');
  const headers = Object.fromEntries(
    Object.entries(requests[0].options.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  assert.match(String(headers['content-type']), /^multipart\/form-data; boundary=----lianhua-/u);
  assert.equal(Number(headers['content-length']), requests[0].body.length);
  assert.equal(headers.authorization, 'Bearer test-secret');
  const bodyText = requests[0].body.toString('latin1');
  assert.equal((bodyText.match(/name="image\[\]"/gu) || []).length, 2);
  assert.ok(requests[0].body.indexOf(firstBytes) >= 0, 'complete first image bytes must be retained');
  assert.ok(requests[0].body.indexOf(secondBytes) > requests[0].body.indexOf(firstBytes), 'complete images must retain reference order');
  assert.match(bodyText, /name="model"\r\n\r\ngpt-image-2/u);

  assert.throws(
    () => harness.createModelHttpRequestOptions({
      method: 'POST',
      body: '{}',
      multipart: { files: [{ name: 'image[]', dataUrl: `data:image/png;base64,${firstBytes.toString('base64')}` }] },
    }),
    /不能同时|multipart.*body/iu,
  );
});

test('model HTTP responses preserve binary image archives as base64', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(
    typeof harness.encodeModelHttpResponse,
    'function',
    'main process must expose a binary-safe response encoder for NovelAI archives',
  );
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x89, 0x50]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.encodeModelHttpResponse(bytes, 'base64', 'application/zip'))),
    {
      body: bytes.toString('base64'),
      bodyEncoding: 'base64',
      contentType: 'application/zip',
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.encodeModelHttpResponse(Buffer.from('ok'), 'text', 'application/json'))),
    {
      body: 'ok',
      bodyEncoding: 'text',
      contentType: 'application/json',
    },
  );
  assert.throws(
    () => harness.encodeModelHttpResponse(bytes, 'arraybuffer', 'application/zip'),
    /responseType|响应类型/u,
  );
});

test('saving encrypted secrets leaves the previous vault intact when the replacement write is interrupted', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  const first = { current: { text: 'first' }, credentials: {}, textProfiles: {}, visionProfiles: {}, imageProfiles: {} };
  const second = { current: { text: 'second' }, credentials: {}, textProfiles: {}, visionProfiles: {}, imageProfiles: {} };
  harness.saveSecrets(first);
  const vaultPath = path.join(harness.dataRoot, 'credentials.safe');
  const original = fs.readFileSync(vaultPath);
  harness.controls.failNextWrite = true;

  assert.throws(() => harness.saveSecrets(second), /simulated interrupted write/);
  assert.deepEqual(fs.readFileSync(vaultPath), original);
});

test('fileSha256 hashes large files without reading the whole file into memory', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  const filePath = path.join(harness.temporaryRoot, 'large-media.bin');
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  fs.writeFileSync(filePath, payload);
  const expected = createHash('sha256').update(payload).digest('hex');
  harness.controls.forbidReadFilePath = filePath;

  assert.equal(harness.fileSha256(filePath), expected);
});

test('startup falls back to Electron userData when the preferred data root cannot be initialized', (t) => {
  const harness = loadMainInternals({ failPreferredDataRoot: true });
  t.after(harness.dispose);

  assert.equal(path.resolve(harness.dataRoot), path.resolve(harness.legacyUserData));
  assert.notEqual(path.resolve(harness.dataRoot), path.resolve(harness.configuredDataRoot));
  assert.match(harness.lastRecoveryNotice, /数据目录.*回退|回退.*数据目录/);
  assert.equal(fs.existsSync(path.join(harness.dataRoot, 'assets')), true);
});

test('filesystem path checks preserve case off Windows and use relative containment', (t) => {
  const harness = loadMainInternals({ platform: 'linux' });
  t.after(harness.dispose);
  const selected = path.join(harness.temporaryRoot, 'CaseSensitive', 'project.json');
  const differentCase = path.join(harness.temporaryRoot, 'casesensitive', 'project.json');

  assert.equal(harness.isSamePath(selected, differentCase), false);
  assert.equal(typeof harness.approveReadPath, 'function');
  assert.equal(typeof harness.isApprovedReadPath, 'function');
  harness.approveReadPath(selected);
  assert.equal(harness.isApprovedReadPath(differentCase), false);
  assert.equal(typeof harness.isPathInside, 'function');
  assert.equal(harness.isPathInside(path.dirname(selected), selected), true);
  assert.equal(harness.isPathInside(path.dirname(selected), path.dirname(selected)), false);
  assert.doesNotMatch(mainSource, /\b(?:destination|resolved|source)\.toLowerCase\(\)\.startsWith/);
});

test('project archives work without the Microsoft.PowerShell.Archive module', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  const source = path.join(harness.temporaryRoot, 'archive-source');
  const archive = path.join(harness.temporaryRoot, 'project.lhvd');
  const expanded = path.join(harness.temporaryRoot, 'archive-expanded');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(source, 'project.json'), '{"project":"roundtrip"}');
  fs.writeFileSync(path.join(source, 'assets', 'probe.txt'), 'archive payload');

  await harness.powershellArchive(source, archive);
  fs.mkdirSync(expanded, { recursive: true });
  await harness.powershellExpand(archive, expanded);

  assert.equal(fs.readFileSync(path.join(expanded, 'project.json'), 'utf8'), '{"project":"roundtrip"}');
  assert.equal(fs.readFileSync(path.join(expanded, 'assets', 'probe.txt'), 'utf8'), 'archive payload');
});

test('external backup uses asynchronous filesystem I/O and preserves manifest, boundary and retention behavior', async (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  const backupDirectory = path.join(harness.temporaryRoot, 'external');
  fs.writeFileSync(path.join(harness.dataRoot, 'recovery-config.json'), JSON.stringify({ backupDirectory, backupOnSave: true, keepCount: 3 }));
  const relativePath = 'video/probe.mp4';
  const assetPath = path.join(harness.dataRoot, 'assets', relativePath);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, 'managed-media');
  const targetRoot = path.join(backupDirectory, '莲华视频导演台备份');
  fs.mkdirSync(targetRoot, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    const oldBackup = path.join(targetRoot, `project-latest-old-${index}.json`);
    fs.writeFileSync(oldBackup, '{}');
    fs.utimesSync(oldBackup, new Date(1000 + index * 1000), new Date(1000 + index * 1000));
  }
  const serialized = JSON.stringify({
    project: { assets: [
      { id: 'valid', relativePath },
      { id: 'escape', relativePath: '../outside.mp4' },
    ] },
    settings: {},
  });
  harness.controls.forbidSyncIo = true;

  let backupPromise;
  assert.doesNotThrow(() => { backupPromise = harness.writeExternalBackup(serialized); });
  assert.equal(typeof backupPromise?.then, 'function');
  const target = await backupPromise;
  harness.controls.forbidSyncIo = false;

  assert.ok(target && fs.existsSync(target));
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', relativePath), 'utf8'), 'managed-media');
  const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, 'backup-integrity.json'), 'utf8'));
  assert.equal(manifest.assets.find((asset) => asset.id === 'valid').missing, false);
  assert.match(manifest.assets.find((asset) => asset.id === 'valid').checksum, /^[a-f0-9]{64}$/);
  assert.equal(manifest.assets.find((asset) => asset.id === 'escape').missing, true);
  assert.equal(fs.readdirSync(targetRoot).filter((entry) => /^project-latest-.*\.json$/i.test(entry)).length, 3);
});

test('save-state awaits external backup so its result or error is returned to the renderer', () => {
  assert.match(mainSource, /return getStatePersistence\(\)\.run\('save', \{ content:/u);
  const storeSource = fs.readFileSync(path.join(root, 'electron', 'statePersistenceStore.cjs'), 'utf8');
  assert.match(storeSource, /try\s*\{\s*external\s*=\s*externalBackup\(prepared\.payload, prepared\.state, prepared\.checksum\);\s*\}\s*catch/u);
  assert.ok(storeSource.indexOf('external = externalBackup(') < storeSource.indexOf('return { ok: true, checksum: prepared.checksum'));
});

test('renderer console logging uses Electron 41 details and keeps legacy test-stub compatibility', (t) => {
  const harness = loadMainInternals();
  t.after(harness.dispose);
  assert.equal(typeof harness.formatConsoleMessageForLog, 'function');

  assert.equal(
    harness.formatConsoleMessageForLog({
      level: 'warning',
      message: 'renderer warning',
      lineNumber: 42,
      sourceId: 'app.js',
    }),
    'console level=warning app.js:42 renderer warning',
  );
  assert.equal(
    harness.formatConsoleMessageForLog({
      level: 'error',
      message: 'renderer failure',
      lineNumber: 73,
      sourceId: 'app.js',
    }),
    'console level=error app.js:73 renderer failure',
  );
  assert.equal(
    harness.formatConsoleMessageForLog({
      level: 'info',
      message: 'ordinary renderer info',
      lineNumber: 1,
      sourceId: 'app.js',
    }),
    null,
  );
  assert.equal(
    harness.formatConsoleMessageForLog({}, [2, 'legacy warning', 9, 'legacy.js']),
    'console level=2 legacy.js:9 legacy warning',
  );
  assert.equal(harness.formatConsoleMessageForLog({}, [1, 'legacy info', 10, 'legacy.js']), null);

  assert.match(
    mainSource,
    /on\('console-message',\s*\([^,()]+,\s*\.\.\.[^()]+\)\s*=>/u,
    'the listener may capture legacy stub arguments through a rest parameter without declaring deprecated Electron arguments',
  );
  assert.doesNotMatch(mainSource, /on\('console-message',\s*\([^)]*,\s*level\s*,\s*message\s*,/u);
});

test('preload media bridges forward import and generated-image storage safely', async () => {
  let exposed;
  const invocations = [];
  const context = vm.createContext({
    require: (specifier) => {
      assert.equal(specifier, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: async (...args) => { invocations.push(args); return null; } },
        webUtils: { getPathForFile: () => { throw new Error('getPathForFile must not receive undefined'); } },
      };
    },
  });
  vm.runInContext(fs.readFileSync(preloadPath, 'utf8'), context, { filename: preloadPath });

  await exposed.importMedia();
  await exposed.storeGeneratedImage({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  await exposed.readManagedImageDataUrl({ relativePath: 'image/ref.png', expectedChecksum: 'abc123' });
  await exposed.cancelModelRequest('model-request-1');

  assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
    ['lianhua:import-media', { path: '' }],
    ['lianhua:store-generated-image', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    ['lianhua:read-managed-image-data-url', { relativePath: 'image/ref.png', expectedChecksum: 'abc123' }],
    ['lianhua:cancel-model-request', 'model-request-1'],
  ]);
  assert.match(mainSource, /handleTrustedIpc\('lianhua:store-generated-image'/u);
  assert.match(mainSource, /handleTrustedIpc\('lianhua:cancel-model-request'/u);
});

test('electron CDP commands all reject and clear when the socket closes or errors', async () => {
  for (const eventType of ['close', 'error']) {
    const harness = loadCdpHarness('electronSmoke.mjs');
    const first = harness.command('Runtime.evaluate');
    const second = harness.command('Page.captureScreenshot');
    harness.socket.dispatch(eventType, eventType === 'close' ? { code: 1006, reason: 'lost' } : { message: 'socket failed' });
    await Promise.race([
      Promise.all([assert.rejects(first, /CDP|WebSocket|socket/i), assert.rejects(second, /CDP|WebSocket|socket/i)]),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${eventType} left CDP promises pending`)), 50)),
    ]);
    assert.equal(harness.pending.size, 0);
  }
});

test('media smoke records console.error calls as failures', () => {
  const harness = loadCdpHarness('mediaUiSmoke.mjs');
  harness.socket.dispatch('message', {
    data: JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ value: 'media console failure' }] },
    }),
  });
  assert.deepEqual([...harness.consoleErrors], ['media console failure']);
});

const runQaWithoutElectron = (scriptName) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-runner-review-'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', scriptName)], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: { ...process.env, CDP_PORT: '1' },
    timeout: 5000,
  });
  return { result, temporaryRoot };
};

const runQaWithExternalDirectories = (scriptName, environment) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-runner-review-'));
  const workingDirectory = path.join(temporaryRoot, 'workspace');
  fs.mkdirSync(workingDirectory);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', scriptName)], {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: { ...process.env, CDP_PORT: '1', ...environment(temporaryRoot) },
    timeout: 5000,
  });
  return { result, temporaryRoot, workingDirectory };
};

const runDesktopQaWithFakeChildren = () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-runner-review-'));
  const workingDirectory = path.join(temporaryRoot, 'workspace');
  const scriptsDirectory = path.join(workingDirectory, 'scripts');
  const electronExecutable = path.join(workingDirectory, 'node_modules', 'electron', 'dist', 'electron.exe');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
  try {
    fs.linkSync(process.execPath, electronExecutable);
  } catch {
    fs.copyFileSync(process.execPath, electronExecutable);
  }
  fs.writeFileSync(path.join(workingDirectory, 'package.json'), JSON.stringify({
    main: 'fakeElectron.mjs',
    type: 'module',
  }));
  fs.writeFileSync(path.join(workingDirectory, 'fakeElectron.mjs'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(scriptsDirectory, 'electronSmoke.mjs'), 'process.exitCode = 0;\n');
  fs.writeFileSync(path.join(scriptsDirectory, 'videoTaskIpcSmoke.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const outputDirectory = path.resolve(process.env.QA_OUTPUT);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'observed.json'), JSON.stringify({ qaOutput: outputDirectory }));
  `);
  const configured = {
    backup: path.join(temporaryRoot, 'isolated-backup'),
    data: path.join(temporaryRoot, 'isolated-data'),
    output: path.join(temporaryRoot, 'isolated-output'),
  };
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'desktopQa.mjs')], {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      CDP_PORT: '1',
      LIANHUA_DATA_DIR: configured.data,
      LIANHUA_QA_BACKUP_DIR: configured.backup,
      QA_OUTPUT: configured.output,
      QA_RUN_TIMEOUT_MS: '5000',
    },
    timeout: 10_000,
  });
  return { configured, result, temporaryRoot, workingDirectory };
};

test('desktop QA honors externally configured managed directories without resetting repository defaults', (t) => {
  let configured;
  const { result, temporaryRoot, workingDirectory } = runQaWithExternalDirectories('desktopQa.mjs', (sandbox) => {
    configured = {
      backup: path.join(sandbox, 'isolated-backup'),
      data: path.join(sandbox, 'isolated-data'),
      output: path.join(sandbox, 'isolated-output'),
    };
    for (const directory of Object.values(configured)) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'stale.txt'), 'stale');
    }
    return {
      LIANHUA_DATA_DIR: configured.data,
      LIANHUA_QA_BACKUP_DIR: configured.backup,
      QA_OUTPUT: configured.output,
    };
  });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const name of ['.qa-electron-data', '.qa-electron', '.qa-external-backup']) {
    const defaultDirectory = path.join(workingDirectory, name);
    assert.equal(fs.existsSync(defaultDirectory), false, `${name} must not be created when an external path is configured`);
  }
  assert.notEqual(result.status, 0, 'the test fixture intentionally has no Electron executable');
  assert.ok(fs.existsSync(path.join(configured.output, 'electron-process.log')));
  for (const directory of Object.values(configured)) {
    assert.equal(fs.existsSync(path.join(directory, 'stale.txt')), false, `${directory} must be reset for this QA run`);
  }
});

test('desktop QA confines video-task smoke artifacts to the configured output directory', (t) => {
  const { configured, result, temporaryRoot, workingDirectory } = runDesktopQaWithFakeChildren();
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const expectedDirectory = path.join(configured.output, 'video-task');
  const reportPath = path.join(expectedDirectory, 'observed.json');
  assert.ok(fs.existsSync(reportPath), 'the video-task smoke must receive a child directory of QA_OUTPUT');
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).qaOutput, path.resolve(expectedDirectory));
  assert.equal(
    fs.existsSync(path.join(workingDirectory, '.qa-video-task')),
    false,
    'the video-task smoke must not create a separate repository artifact directory',
  );
});

test('media QA honors externally configured data and output directories', (t) => {
  let configured;
  const { result, temporaryRoot, workingDirectory } = runQaWithExternalDirectories('mediaQa.mjs', (sandbox) => {
    configured = {
      data: path.join(sandbox, 'isolated-media-data'),
      output: path.join(sandbox, 'isolated-media-output'),
    };
    for (const directory of Object.values(configured)) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'stale.txt'), 'stale');
    }
    return { LIANHUA_DATA_DIR: configured.data, QA_OUTPUT: configured.output };
  });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  assert.equal(fs.existsSync(path.join(workingDirectory, '.qa-media-data-final')), false);
  assert.equal(fs.existsSync(path.join(workingDirectory, '.qa-media-final')), false);
  assert.notEqual(result.status, 0, 'the test fixture intentionally has no Electron executable');
  assert.ok(fs.existsSync(path.join(configured.output, 'electron-process.log')));
  for (const directory of Object.values(configured)) {
    assert.equal(fs.existsSync(path.join(directory, 'stale.txt')), false, `${directory} must be reset for this QA run`);
  }
});

for (const scriptName of ['desktopQa.mjs', 'mediaQa.mjs']) {
  test(`${scriptName} rejects an unsafe configured data directory before deleting it`, (t) => {
    let unsafeDirectory;
    const { result, temporaryRoot } = runQaWithExternalDirectories(scriptName, (sandbox) => {
      unsafeDirectory = path.join(sandbox, 'workspace', 'ordinary-user-data');
      fs.mkdirSync(unsafeDirectory);
      fs.writeFileSync(path.join(unsafeDirectory, 'keep.txt'), 'user data');
      return {
        LIANHUA_DATA_DIR: unsafeDirectory,
        QA_OUTPUT: path.join(sandbox, `isolated-${scriptName}-output`),
      };
    });
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe QA output directory/i);
    assert.equal(fs.readFileSync(path.join(unsafeDirectory, 'keep.txt'), 'utf8'), 'user data');
  });
}

test('desktop QA handles an Electron spawn error and persists it in the process log', (t) => {
  const { result, temporaryRoot } = runQaWithoutElectron('desktopQa.mjs');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unhandled 'error' event/);
  const logPath = path.join(temporaryRoot, '.qa-electron', 'electron-process.log');
  assert.ok(fs.existsSync(logPath), 'Electron process log must survive spawn failure');
  assert.match(fs.readFileSync(logPath, 'utf8'), /spawn|ENOENT|electron/i);
});

test('media QA handles an Electron spawn error, drains output, and persists its process log', (t) => {
  const { result, temporaryRoot } = runQaWithoutElectron('mediaQa.mjs');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unhandled 'error' event/);
  const logPath = path.join(temporaryRoot, '.qa-media-final', 'electron-process.log');
  assert.ok(fs.existsSync(logPath), 'Electron process log must survive spawn failure');
  assert.match(fs.readFileSync(logPath, 'utf8'), /spawn|ENOENT|electron/i);
});

test('video task smoke validates LIANHUA_DATA_DIR before starting its server and reuses the resolved value', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'videoTaskIpcSmoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LIANHUA_DATA_DIR: '', MOCK_API_PORT: 'not-a-port' },
    timeout: 3000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIANHUA_DATA_DIR is required/);
  assert.doesNotMatch(result.stderr, /ERR_SOCKET_BAD_PORT/);
  const source = fs.readFileSync(path.join(root, 'scripts', 'videoTaskIpcSmoke.mjs'), 'utf8');
  assert.match(source, /path\.join\(dataDirectory, 'assets', result\.downloaded\.relativePath\)/);
});
