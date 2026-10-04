import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const require = createRequire(mainPath);
const { createVideoTransport, videoRequestOptions } = require('./videoTransport.cjs');
const { createVideoTaskCredentialVault } = require('./videoTaskCredentialVault.cjs');
const proxyHelpers = require('./systemProxyTransport.cjs');
const { WebSocketServer } = require('ws');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const encodeEbmlSize = (value) => {
  if (value >= 0 && value < 0x7f) return Buffer.from([0x80 | value]);
  if (value >= 0x7f && value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  throw new Error(`EBML test fixture is too large: ${value}`);
};
const ebmlMedia = (docType, payload = '', paddingBytes = 0) => {
  const padding = paddingBytes > 0
    ? Buffer.concat([Buffer.from([0xec]), encodeEbmlSize(paddingBytes), Buffer.alloc(paddingBytes)])
    : Buffer.alloc(0);
  const docTypeBytes = Buffer.from(docType, 'ascii');
  const docTypeElement = Buffer.concat([Buffer.from([0x42, 0x82]), encodeEbmlSize(docTypeBytes.length), docTypeBytes]);
  const headerBody = Buffer.concat([padding, docTypeElement]);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    encodeEbmlSize(headerBody.length),
    headerBody,
    Buffer.from(payload),
  ]);
};
const isoBmffMedia = (majorBrand, compatibleBrands = [], payload = '') => {
  const size = 16 + compatibleBrands.length * 4;
  const header = Buffer.alloc(size);
  header.writeUInt32BE(size, 0);
  header.write('ftyp', 4, 4, 'ascii');
  header.write(majorBrand, 8, 4, 'ascii');
  compatibleBrands.forEach((brand, index) => header.write(brand, 16 + index * 4, 4, 'ascii'));
  return Buffer.concat([header, Buffer.from(payload)]);
};

const registrationFixture = (t, resolveTarget) => {
  const sockets = [], resolutions = [], proxies = [];
  const renderer = Object.assign(owner(), { destroyed: false, isDestroyed() { return this.destroyed; } });
  const target = { url: 'http://comfy-fixture.invalid/ws', address: '127.0.0.1', family: 4 };
  class FakeSocket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.terminated = false; sockets.push(this); }
    terminate() { if (!this.terminated) { this.terminated = true; this.emit('close'); } }
  }
  const transport = createVideoTransport({
    assertRemoteResolution: async (url) => { resolutions.push(url); return resolveTarget(resolutions.length, target); },
    isPrivateIpAddress: () => true,
    resolveSystemProxy: async (_url, options) => { proxies.push(options); return undefined; },
    WebSocketClass: FakeSocket,
  });
  t.after(() => transport.close());
  return { transport, renderer, target, sockets, resolutions, proxies, payload: { watchId: 'registration', url: 'ws://comfy-fixture.invalid/ws' } };
};

const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-transport-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const owner = () => Object.assign(new EventEmitter(), { sent: [], isDestroyed: () => false, send(_channel, payload) { this.sent.push(payload); this.emit('progress', payload); } });
const httpFixture = async (t, handler) => {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const loadMain = (t) => {
  const dir = temporary(t);
  const timers = [];
  const controls = { forbidDownloadSync: false, failDownloadWrite: false, asyncWrites: 0 };
  const asyncFs = new Proxy(fs.promises, { get(target, property) {
    if (property === 'open') return async (...args) => {
      const handle = await fs.promises.open(...args);
      return new Proxy(handle, { get(opened, member) {
        if (member === 'writeFile') return async (...writeArgs) => {
          controls.asyncWrites += 1;
          if (controls.failDownloadWrite) {
            await opened.writeFile('partial fixture');
            throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
          }
          return opened.writeFile(...writeArgs);
        };
        const value = Reflect.get(opened, member);
        return typeof value === 'function' ? value.bind(opened) : value;
      } });
    };
    return Reflect.get(target, property);
  } });
  const guardedFs = new Proxy(fs, { get(target, property) {
    if (property === 'promises') return asyncFs;
    if (controls.forbidDownloadSync && typeof property === 'string' && property.endsWith('Sync')) return () => { throw new Error(`download blocked main thread with ${property}`); };
    return Reflect.get(target, property);
  } });
  const paths = { userData: path.join(dir, 'legacy') };
  const electron = {
    app: { getPath: (name) => paths[name] || path.join(dir, name), setPath: (name, value) => { paths[name] = value; }, setAppLogsPath() {} },
    BrowserWindow: class {}, dialog: {}, ipcMain: {}, net: {}, shell: {},
    protocol: { registerSchemesAsPrivileged() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(`test-encrypted:${v}`), decryptString: (v) => String(v).replace(/^test-encrypted:/u, '') },
  };
  const context = vm.createContext({
    AbortController, Buffer, URL, Response, console, clearTimeout,
    setTimeout: (callback, ms) => { timers.push(ms); return setTimeout(callback, ms); },
    process: { argv: ['node', mainPath], env: { ...process.env, LIANHUA_DATA_DIR: path.join(dir, 'data'), LIANHUA_ALLOW_PRIVATE_NETWORK: '1' }, execPath: process.execPath, platform: process.platform, pid: process.pid },
    require: (specifier) => specifier === 'electron' ? electron : specifier === 'fs' ? guardedFs : require(specifier),
    __dirname: path.dirname(mainPath), __filename: mainPath,
  });
  const source = fs.readFileSync(mainPath, 'utf8');
  vm.runInContext(`${source.slice(0, source.indexOf("if (process.platform === 'win32')"))}\n;globalThis.harness={getVideoTransport,fetchWithLimit,requestResolvedTarget,downloadIntoAssetStore,stripSecrets,collectSecrets,saveSecrets,hydrateSecrets,tempRoot,assetRoot};`, context);
  return { ...context.harness, timers, controls };
};

test('dedicated video requests wait beyond supplied legacy timeout without installing connection/deadline timers', async (t) => {
  const harness = loadMain(t);
  const fixture = await httpFixture(t, async (_req, res) => { await pause(40); res.setHeader('Content-Type', 'application/json'); res.end('{"status":"queued"}'); });
  const result = await harness.getVideoTransport().request({ requestId: 'video-1', url: fixture.url, method: 'POST', body: '{}', timeoutMs: 1 }, owner());
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { status: 'queued' });
  assert.deepEqual(harness.timers, [], 'no global request/connection timer may be installed for video');
  await harness.fetchWithLimit(fixture.url);
  assert.ok(harness.timers.includes(30_000), 'text/image transport still keeps its existing connection deadline');
});

test('video multipart uploads retain all files, safe names, exact binary bytes and explicit no-timeout semantics', () => {
  const samples = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'generatedImageSamples.json'), 'utf8'));
  const pngBytes = Buffer.from(samples.png, 'base64');
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
  const result = videoRequestOptions({ method: 'POST', headers: { 'content-type': 'incorrect' }, multipart: { fields: { type: 'input' }, files: Array.from({ length: 9 }, (_, i) => ({ fieldName: 'image', fileName: `ref-${i}\r\nX-Injected: bad.png`, dataUrl })) } });
  assert.equal(result.noTimeout, true);
  assert.equal(result.headers['content-type'], undefined);
  assert.match(result.headers['Content-Type'], /^multipart\/form-data; boundary=/u);
  assert.equal((result.body.toString('latin1').match(/name="image"/gu) || []).length, 9, 'transport does not silently drop images or impose the image editor eight-file rule');
  assert.ok(result.body.includes(pngBytes));
  assert.doesNotMatch(result.body.toString(), /\r\nX-Injected:/u);
});

test('cancel closes only the owner request and does not retry paid submissions', async (t) => {
  const harness = loadMain(t);
  let submissions = 0;
  let submitted;
  const started = new Promise((resolve) => { submitted = resolve; });
  const fixture = await httpFixture(t, () => { submissions += 1; submitted(); });
  const renderer = owner();
  const transport = harness.getVideoTransport();
  const pending = transport.request({ requestId: 'cancel-me', url: fixture.url, method: 'POST', body: '{}' }, renderer);
  await started;
  assert.equal(transport.cancel('cancel-me', owner()), false);
  assert.equal(transport.cancel('cancel-me', renderer), true);
  await assert.rejects(pending, /取消/u);
  await pause(25);
  assert.equal(submissions, 1);
  assert.deepEqual(harness.timers, []);
});

test('streamed video download has no deadline, reports bytes, and returns managed final media', async (t) => {
  const harness = loadMain(t);
  const fixture = await httpFixture(t, async (_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '10' }); res.write('first'); await pause(40); res.end('final'); });
  const renderer = owner();
  const result = await harness.getVideoTransport().download({ requestId: 'download-1', url: `${fixture.url}/view?filename=with-audio.mp4`, timeoutMs: 1 }, renderer);
  assert.equal(result.fileName, 'with-audio.mp4');
  assert.equal(result.mediaType, 'video');
  assert.equal(result.sizeBytes, 10);
  assert.equal(fs.readFileSync(path.join(harness.assetRoot, result.relativePath), 'utf8'), 'firstfinal');
  assert.equal(renderer.sent.at(-1).data.data.receivedBytes, 10);
  assert.equal(renderer.sent.at(-1).data.data.totalBytes, 10);
  assert.deepEqual(harness.timers, []);
});

test('many local-network chunks use async disk I/O and throttled progress with an exact final byte/checksum report', async (t) => {
  const harness = loadMain(t);
  const parts = Array.from({ length: 64 }, (_, index) => Buffer.alloc(8192, index));
  const payload = Buffer.concat(parts);
  const fixture = await httpFixture(t, async (_req, res) => {
    // Remote policy/config checks precede the response. Everything from body
    // streaming through collision-safe promotion must be nonblocking I/O.
    harness.controls.forbidDownloadSync = true;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(payload.length) });
    for (const part of parts) { res.write(part); await pause(2); }
    res.end();
  });
  const renderer = owner();
  const result = await harness.getVideoTransport().download({ requestId: 'many-chunk-fixture', url: `${fixture.url}/fixture.mp4`, fileName: '合成下载测试' }, renderer);
  harness.controls.forbidDownloadSync = false;
  assert.ok(harness.controls.asyncWrites >= 8);
  assert.ok(renderer.sent.length >= 2);
  assert.ok(renderer.sent.length < harness.controls.asyncWrites / 2, 'progress must not be sent once per chunk');
  assert.equal(renderer.sent.at(-1).data.data.receivedBytes, payload.length);
  assert.equal(renderer.sent.at(-1).data.data.totalBytes, payload.length);
  assert.equal(result.checksum, createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, result.relativePath)), payload);
  assert.equal(fs.readdirSync(harness.tempRoot).some((name) => name.startsWith('download-')), false);
  // Reusing an existing result must hash asynchronously too.
  const repeated = await harness.getVideoTransport().download({ requestId: 'many-chunk-repeat', url: `${fixture.url}/fixture.mp4`, fileName: '合成下载测试' }, owner());
  harness.controls.forbidDownloadSync = false;
  assert.equal(repeated.relativePath, result.relativePath);
});

test('async download disk failure removes only its partial temporary file and preserves existing managed video', async (t) => {
  const harness = loadMain(t);
  const videoDirectory = path.join(harness.assetRoot, 'video');
  fs.mkdirSync(videoDirectory, { recursive: true });
  const original = path.join(videoDirectory, 'keep-original.mp4');
  fs.writeFileSync(original, 'original synthetic video');
  const fixture = await httpFixture(t, (_req, res) => {
    harness.controls.forbidDownloadSync = true;
    harness.controls.failDownloadWrite = true;
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end('new synthetic payload');
  });
  await assert.rejects(harness.getVideoTransport().download({ requestId: 'disk-full-fixture', url: fixture.url }, owner()), /disk full|ENOSPC/u);
  harness.controls.forbidDownloadSync = false;
  assert.equal(fs.readFileSync(original, 'utf8'), 'original synthetic video');
  assert.deepEqual(fs.readdirSync(videoDirectory), ['keep-original.mp4']);
  assert.equal(fs.readdirSync(harness.tempRoot).some((name) => name.startsWith('download-')), false);
});

test('generated videos use readable image-style names, real extensions, and collision versions on disk', async (t) => {
  const harness = loadMain(t);
  let requestNumber = 0;
  const fixture = await httpFixture(t, (_req, res) => {
    requestNumber += 1;
    const bytes = ebmlMedia('webm', `webm-video-${requestNumber}`, 512);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const renderer = owner();
  const first = await harness.getVideoTransport().download({
    requestId: 'readable-download-1',
    url: `${fixture.url}/opaque-result.mp4`,
    fileName: ' 剧情：第 1.5 段? ',
  }, renderer);
  const second = await harness.getVideoTransport().download({
    requestId: 'readable-download-2',
    url: `${fixture.url}/another-opaque-result.mp4`,
    fileName: '剧情：第 1.5 段?.mp4',
  }, renderer);
  const reserved = await harness.getVideoTransport().download({
    requestId: 'readable-download-reserved',
    url: `${fixture.url}/reserved-name.mp4`,
    fileName: 'CON.txt',
  }, renderer);
  const historicalReserved = await harness.getVideoTransport().download({
    requestId: 'readable-download-historical-reserved',
    url: `${fixture.url}/historical-reserved-name.mp4`,
    fileName: 'CLOCK$.mp4',
  }, renderer);

  assert.equal(first.fileName, '剧情：第 1.5 段_.webm');
  assert.equal(first.relativePath, 'video/剧情：第 1.5 段_.webm');
  assert.equal(second.fileName, '剧情：第 1.5 段_ · 第 2 版.webm');
  assert.equal(second.relativePath, 'video/剧情：第 1.5 段_ · 第 2 版.webm');
  assert.equal(path.basename(first.relativePath), first.fileName);
  assert.equal(path.basename(second.relativePath), second.fileName);
  assert.equal(reserved.fileName, '_CON.txt.webm');
  assert.equal(reserved.relativePath, 'video/_CON.txt.webm');
  assert.equal(historicalReserved.fileName, '_CLOCK$.webm');
  assert.equal(historicalReserved.relativePath, 'video/_CLOCK$.webm');
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, first.relativePath)), ebmlMedia('webm', 'webm-video-1', 512));
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, second.relativePath)), ebmlMedia('webm', 'webm-video-2', 512));
});

test('parallel readable video downloads preserve both different payloads under collision versions', async (t) => {
  const harness = loadMain(t);
  const bothRequestsArrived = deferred();
  let requestCount = 0;
  const payloads = new Map([
    ['/parallel-a', ebmlMedia('webm', 'parallel-payload-a')],
    ['/parallel-b', ebmlMedia('webm', 'parallel-payload-b')],
  ]);
  const fixture = await httpFixture(t, async (req, res) => {
    const bytes = payloads.get(req.url);
    assert.ok(bytes, `unexpected fixture route: ${req.url}`);
    requestCount += 1;
    if (requestCount === payloads.size) bothRequestsArrived.resolve();
    await bothRequestsArrived.promise;
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const transport = harness.getVideoTransport();
  const [first, second] = await Promise.all([
    transport.download({ requestId: 'parallel-readable-a', url: `${fixture.url}/parallel-a`, fileName: '并发剧情' }, owner()),
    transport.download({ requestId: 'parallel-readable-b', url: `${fixture.url}/parallel-b`, fileName: '并发剧情' }, owner()),
  ]);

  assert.deepEqual(
    [first.fileName, second.fileName].sort(),
    ['并发剧情.webm', '并发剧情 · 第 2 版.webm'].sort(),
  );
  assert.notEqual(first.relativePath, second.relativePath);
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, first.relativePath)), payloads.get('/parallel-a'));
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, second.relativePath)), payloads.get('/parallel-b'));
  assert.deepEqual(
    fs.readdirSync(path.join(harness.assetRoot, 'video')).sort(),
    ['并发剧情.webm', '并发剧情 · 第 2 版.webm'].sort(),
  );
});

test('parallel readable video downloads reuse one managed path for identical bytes', async (t) => {
  const harness = loadMain(t);
  const bothRequestsArrived = deferred();
  let requestCount = 0;
  const bytes = ebmlMedia('webm', 'identical-parallel-payload');
  const fixture = await httpFixture(t, async (_req, res) => {
    requestCount += 1;
    if (requestCount === 2) bothRequestsArrived.resolve();
    await bothRequestsArrived.promise;
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const transport = harness.getVideoTransport();
  const [first, second] = await Promise.all([
    transport.download({ requestId: 'parallel-identical-a', url: `${fixture.url}/identical-a`, fileName: '重复内容' }, owner()),
    transport.download({ requestId: 'parallel-identical-b', url: `${fixture.url}/identical-b`, fileName: '重复内容' }, owner()),
  ]);

  assert.equal(first.relativePath, second.relativePath);
  assert.equal(first.fileName, '重复内容.webm');
  assert.equal(second.fileName, first.fileName);
  assert.deepEqual(fs.readFileSync(path.join(harness.assetRoot, first.relativePath)), bytes);
  assert.deepEqual(fs.readdirSync(path.join(harness.assetRoot, 'video')), ['重复内容.webm']);
});

test('readable video names safely normalize hostile, empty, and long emoji stems', async (t) => {
  const harness = loadMain(t);
  let requestNumber = 0;
  const fixture = await httpFixture(t, (_req, res) => {
    requestNumber += 1;
    const bytes = ebmlMedia('webm', `sanitized-name-${requestNumber}`);
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  const transport = harness.getVideoTransport();
  const hostile = await transport.download({
    requestId: 'sanitize-hostile-name',
    url: `${fixture.url}/hostile`,
    fileName: '父目录/镜头<>:"|?*\u0001  . ',
  }, owner());
  const empty = await transport.download({
    requestId: 'sanitize-empty-name',
    url: `${fixture.url}/empty`,
    fileName: '  ...   ',
  }, owner());
  const long = await transport.download({
    requestId: 'sanitize-long-emoji-name',
    url: `${fixture.url}/long`,
    fileName: '超长剧情😀'.repeat(80),
  }, owner());

  const hostileStem = path.basename(hostile.fileName, '.webm');
  assert.doesNotMatch(hostile.fileName, /[<>:"/\\|?*\u0000-\u001F]/u);
  assert.doesNotMatch(hostileStem, /[. ]$/u);
  assert.equal(empty.fileName, '生成视频.webm');
  const longStem = path.basename(long.fileName, '.webm');
  assert.ok(longStem.length <= 140);
  assert.equal(Buffer.from(longStem, 'utf8').toString('utf8'), longStem, 'clipping must not leave an unpaired emoji surrogate');
  for (const result of [hostile, empty, long]) {
    assert.equal(path.basename(result.relativePath), result.fileName);
    assert.equal(fs.existsSync(path.join(harness.assetRoot, result.relativePath)), true);
  }
});

test('container sniffing rejects MKV, video-disguised M4A, 3GP, unknown ftyp, and explicitly unsupported MIME', async (t) => {
  const harness = loadMain(t);
  const routes = new Map([
    ['/mkv', { contentType: 'video/webm', bytes: ebmlMedia('matroska', 'mkv-payload') }],
    ['/unknown-ebml', { contentType: 'video/webm', bytes: ebmlMedia('unknown', 'unknown-ebml-payload') }],
    ['/m4a-as-video', { contentType: 'video/mp4', bytes: isoBmffMedia('M4A ', ['isom'], 'audio-payload') }],
    ['/3gp', { contentType: 'video/mp4', bytes: isoBmffMedia('3gp6', ['isom'], '3gp-payload') }],
    ['/unknown-ftyp', { contentType: 'video/mp4', bytes: isoBmffMedia('zzzz', ['zz01'], 'unknown-payload') }],
    ['/unsupported-mime', { contentType: 'video/x-matroska', bytes: ebmlMedia('webm', 'valid-webm-payload') }],
    ['/m4a-audio', { contentType: 'audio/mp4', bytes: isoBmffMedia('M4A ', ['isom'], 'audio-payload') }],
    ['/mp4-video', { contentType: 'application/octet-stream', bytes: isoBmffMedia('isom', ['mp42'], 'mp4-payload') }],
    ['/mov-video', { contentType: 'application/octet-stream', bytes: isoBmffMedia('qt  ', [], 'mov-payload') }],
  ]);
  const fixture = await httpFixture(t, (req, res) => {
    const route = routes.get(req.url);
    assert.ok(route, `unexpected fixture route: ${req.url}`);
    res.writeHead(200, { 'Content-Type': route.contentType, 'Content-Length': String(route.bytes.length) });
    res.end(route.bytes);
  });
  const transport = harness.getVideoTransport();

  await assert.rejects(transport.download({ requestId: 'reject-mkv', url: `${fixture.url}/mkv`, fileName: '伪装 WebM' }, owner()), /MKV|Matroska/u);
  await assert.rejects(transport.download({ requestId: 'reject-unknown-ebml', url: `${fixture.url}/unknown-ebml`, fileName: '未知 EBML' }, owner()), /EBML DocType.*无法识别/u);
  await assert.rejects(transport.download({ requestId: 'reject-m4a-video', url: `${fixture.url}/m4a-as-video`, fileName: '伪装 MP4' }, owner()), /内容与声明格式不一致|音频/u);
  await assert.rejects(transport.download({ requestId: 'reject-3gp', url: `${fixture.url}/3gp`, fileName: '伪装 3GP' }, owner()), /3GP|3G2/u);
  await assert.rejects(transport.download({ requestId: 'reject-unknown-ftyp', url: `${fixture.url}/unknown-ftyp`, fileName: '未知品牌' }, owner()), /ftyp.*无法识别/u);
  await assert.rejects(transport.download({ requestId: 'reject-unsupported-mime', url: `${fixture.url}/unsupported-mime`, fileName: '不支持 MIME' }, owner()), /格式.*不支持|不支持.*格式/u);

  const audio = await transport.download({ requestId: 'accept-m4a-audio', url: `${fixture.url}/m4a-audio`, fileName: '配乐' }, owner());
  assert.equal(audio.fileName, '配乐.m4a');
  assert.equal(audio.relativePath, 'audio/配乐.m4a');
  assert.equal(audio.mediaType, 'audio');
  const mp4 = await transport.download({ requestId: 'accept-mp4-video', url: `${fixture.url}/mp4-video`, fileName: '正片' }, owner());
  const mov = await transport.download({ requestId: 'accept-mov-video', url: `${fixture.url}/mov-video`, fileName: '母版' }, owner());
  assert.equal(mp4.fileName, '正片.mp4');
  assert.equal(mp4.mediaType, 'video');
  assert.equal(mov.fileName, '母版.mov');
  assert.equal(mov.mediaType, 'video');
  assert.equal(fs.readdirSync(harness.tempRoot).filter((name) => name.startsWith('download-')).length, 0);
});

test('unknown or opaque media is rejected instead of being disguised as MP4', async (t) => {
  const harness = loadMain(t);
  const fixture = await httpFixture(t, (req, res) => {
    if (req.url === '/unknown') res.writeHead(200, { 'Content-Type': 'video/x-msvideo' });
    else res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('not-a-supported-media-container');
  });
  const transport = harness.getVideoTransport();
  await assert.rejects(transport.download({ requestId: 'unknown-media', url: `${fixture.url}/unknown`, fileName: '未知格式' }, owner()), /格式.*不支持|不支持.*格式/u);
  await assert.rejects(transport.download({ requestId: 'opaque-media', url: `${fixture.url}/opaque`, fileName: '不透明格式' }, owner()), /无法确认.*格式/u);
  assert.equal(fs.readdirSync(harness.tempRoot).filter((name) => name.startsWith('download-')).length, 0);
});

test('cancelled/failed downloads clean only their temporary file, without promoting incomplete media', async (t) => {
  const harness = loadMain(t);
  const fixture = await httpFixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write('partial'); });
  const renderer = owner();
  const progress = once(renderer, 'progress');
  const transport = harness.getVideoTransport();
  const pending = transport.download({ requestId: 'download-cancel', url: fixture.url }, renderer);
  await progress;
  assert.equal(transport.cancel('download-cancel', renderer), true);
  await assert.rejects(pending, /取消/u);
  await pause(25);
  assert.equal(fs.readdirSync(harness.tempRoot).filter((name) => name.startsWith('download-')).length, 0);
  assert.equal(fs.existsSync(path.join(harness.assetRoot, 'video')), false);
});

test('proxy lookup and CONNECT can explicitly omit all app deadlines while remaining cancelable', async (t) => {
  const resolved = await proxyHelpers.resolveSystemProxy('https://video.example', { noTimeout: true, timeoutMs: 1, resolveProxy: async () => { await pause(25); return 'DIRECT'; } });
  assert.equal(resolved, null);
  const fixture = await httpFixture(t);
  fixture.server.on('connect', async (_req, socket) => { await pause(25); if (!socket.destroyed) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
  const target = { url: 'https://video.example', address: '93.184.216.34', family: 4 };
  const agent = await proxyHelpers.createProxyTunnelAgent(target, { proxyUrl: fixture.url, noTimeout: true, connectTimeoutMs: 1 });
  agent.destroy();
  const controller = new AbortController();
  const pending = proxyHelpers.resolveSystemProxy(target.url, { noTimeout: true, signal: controller.signal, resolveProxy: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, /取消/u);
});

test('main-process Comfy WebSocket passes auth and validated IP, ignores previews, reconnects, and stops cleanly', async (t) => {
  const fixture = await httpFixture(t);
  const wss = new WebSocketServer({ server: fixture.server });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  const renderer = owner();
  let connections = 0;
  const seenHeaders = [];
  wss.on('connection', (socket, request) => {
    connections += 1;
    seenHeaders.push(request.headers);
    socket.send(Buffer.from('preview'), { binary: true });
    socket.send(JSON.stringify({ type: 'progress', data: { value: connections, max: 30, prompt_id: 'fixture-task' } }));
    if (connections === 1) socket.close();
  });
  const transport = createVideoTransport({
    assertRemoteResolution: async (url) => ({ url, address: '127.0.0.1', family: 4 }),
    isPrivateIpAddress: () => true, ...proxyHelpers,
  });
  t.after(() => transport.close());
  const twoProgress = new Promise((resolve) => renderer.on('progress', (event) => { if (event.type === 'message' && event.data.data.value === 2) resolve(); }));
  const url = `ws://comfy-fixture.invalid:${fixture.server.address().port}/ws?clientId=qa`;
  await transport.watch({ watchId: 'watch-1', url, headers: { Authorization: 'Bearer fixture-only', Host: 'must-not-use.invalid' } }, renderer);
  await twoProgress;
  assert.equal(seenHeaders.length, 2);
  assert.equal(seenHeaders[0].authorization, 'Bearer fixture-only');
  assert.equal(seenHeaders[0].host, `comfy-fixture.invalid:${fixture.server.address().port}`);
  assert.equal(renderer.sent.filter((event) => event.type === 'message').length, 2);
  assert.ok(renderer.sent.some((event) => event.type === 'disconnected'));
  assert.equal(transport.unwatch('watch-1', owner()), false);
  assert.equal(transport.unwatch('watch-1', renderer), true);
  await pause(30);
  assert.equal(connections, 2);
});

for (const stop of ['unwatch', 'owner-destroyed', 'transport-close']) {
  test(`pending Comfy DNS registration is cancelled by ${stop} without a late socket`, async (t) => {
    const first = deferred();
    const fixture = registrationFixture(t, (count, target) => count === 1 ? first.promise : target);
    const pendingWatch = fixture.transport.watch(fixture.payload, fixture.renderer);
    let settled = false;
    pendingWatch.then(() => { settled = true; });
    await turn();
    assert.equal(fixture.resolutions.length, 1);
    assert.equal(fixture.renderer.listenerCount('destroyed'), 1, 'owner cleanup is registered before the pending DNS check');
    if (stop === 'unwatch') assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), true);
    else if (stop === 'owner-destroyed') { fixture.renderer.destroyed = true; fixture.renderer.emit('destroyed'); }
    else fixture.transport.close();
    await turn();
    const cancelledBeforeDnsSettled = settled;
    first.resolve(fixture.target);
    await pendingWatch;
    await turn();
    assert.equal(cancelledBeforeDnsSettled, true, 'unabortable DNS must not hold the cancelled IPC registration open');
    assert.equal(fixture.resolutions.length, 1, 'cancelled preflight cannot begin the connection DNS check');
    assert.equal(fixture.sockets.length, 0);
    assert.equal(fixture.proxies.length, 0);
    assert.equal(fixture.renderer.listenerCount('destroyed'), 0);
    assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), false);
  });
}

for (const outcome of ['resolve', 'reject']) {
  test(`same-owner Comfy replacement survives the old DNS ${outcome}`, async (t) => {
    const first = deferred();
    const fixture = registrationFixture(t, (count, target) => count === 1 ? first.promise : target);
    const oldWatch = fixture.transport.watch(fixture.payload, fixture.renderer);
    await turn();
    await fixture.transport.watch({ ...fixture.payload, url: `${fixture.payload.url}?clientId=new` }, fixture.renderer);
    await turn();
    assert.equal(fixture.sockets.length, 1);
    assert.match(fixture.sockets[0].url, /clientId=new/u);
    if (outcome === 'resolve') first.resolve(fixture.target); else first.reject(new Error('obsolete DNS failure'));
    await oldWatch;
    await turn();
    assert.equal(fixture.sockets.length, 1, 'late old resolution cannot create or replace a socket');
    assert.equal(fixture.sockets[0].terminated, false, 'old cleanup must not stop the replacement');
    assert.equal(fixture.renderer.listenerCount('destroyed'), 1);
    assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), true);
    assert.equal(fixture.sockets[0].terminated, true);
    assert.equal(fixture.renderer.listenerCount('destroyed'), 0);
  });
}

test('pending Comfy reservation enforces owner identity before network resolution', async (t) => {
  const first = deferred();
  const fixture = registrationFixture(t, (count, target) => count === 1 ? first.promise : target);
  const pendingWatch = fixture.transport.watch(fixture.payload, fixture.renderer);
  await turn();
  const stranger = owner();
  await assert.rejects(fixture.transport.watch(fixture.payload, stranger), /订阅标识已被使用/u);
  assert.equal(fixture.transport.unwatch(fixture.payload.watchId, stranger), false);
  assert.equal(fixture.resolutions.length, 1);
  assert.equal(stranger.listenerCount('destroyed'), 0);
  first.resolve(fixture.target);
  await pendingWatch;
  await turn();
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), true);
});

test('rejected Comfy preflight leaves no reservation or listener and does not bypass private-network policy', async (t) => {
  const fixture = registrationFixture(t, (count, target) => {
    if (count === 1) throw new Error('private-network consent required');
    return target;
  });
  await assert.rejects(fixture.transport.watch(fixture.payload, fixture.renderer), /private-network consent required/u);
  assert.equal(fixture.sockets.length, 0);
  assert.equal(fixture.proxies.length, 0);
  assert.equal(fixture.renderer.listenerCount('destroyed'), 0);
  assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), false);
  const nextOwner = owner();
  await fixture.transport.watch(fixture.payload, nextOwner);
  await turn();
  assert.equal(fixture.sockets.length, 1, 'a failed registration does not reserve the ID forever');
  assert.equal(fixture.transport.unwatch(fixture.payload.watchId, nextOwner), true);
});

test('Comfy cancellation during the validated connection lookup does not proceed to proxy or socket setup', async (t) => {
  const second = deferred();
  const fixture = registrationFixture(t, (count, target) => count === 2 ? second.promise : target);
  await fixture.transport.watch(fixture.payload, fixture.renderer);
  assert.equal(fixture.resolutions.length, 2, 'the connection still performs the DNS rebinding check');
  assert.equal(fixture.transport.unwatch(fixture.payload.watchId, fixture.renderer), true);
  second.resolve(fixture.target);
  await turn();
  assert.equal(fixture.proxies.length, 0);
  assert.equal(fixture.sockets.length, 0);
  assert.equal(fixture.renderer.listenerCount('destroyed'), 0);
});

test('Comfy watch called with an already destroyed owner performs no network work', async (t) => {
  const fixture = registrationFixture(t, (_count, target) => target);
  fixture.renderer.destroyed = true;
  await fixture.transport.watch(fixture.payload, fixture.renderer);
  assert.equal(fixture.resolutions.length, 0);
  assert.equal(fixture.sockets.length, 0);
  assert.equal(fixture.renderer.listenerCount('destroyed'), 0);
});

test('video task vault encrypts separately and survives API profile changes/restart; no plaintext fallback', (t) => {
  const filePath = path.join(temporary(t), 'video-task-credentials.safe');
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  const options = { filePath, safeStorage, atomicWriteFile: fs.writeFileSync };
  const first = createVideoTaskCredentialVault(options);
  assert.equal(first.set({ taskId: 'task-before-profile-change', apiKey: 'secret-old-api-key' }).persisted, true);
  assert.ok(!fs.readFileSync(filePath).includes(Buffer.from('secret-old-api-key')));
  const restarted = createVideoTaskCredentialVault(options);
  assert.equal(restarted.get('task-before-profile-change'), 'secret-old-api-key');
  assert.equal(restarted.delete('task-before-profile-change'), true);
  assert.equal(createVideoTaskCredentialVault(options).get('task-before-profile-change'), null);
  const unavailablePath = path.join(path.dirname(filePath), 'must-not-write-plaintext.safe');
  const unavailable = createVideoTaskCredentialVault({ ...options, filePath: unavailablePath, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
  assert.equal(unavailable.set({ taskId: 'memory-only', apiKey: 'never-plaintext' }).persisted, false);
  assert.equal(unavailable.get('memory-only'), 'never-plaintext');
  assert.equal(fs.existsSync(unavailablePath), false);
});

test('settings secret stripping/hydration includes video API profiles and ComfyUI video credentials', (t) => {
  const harness = loadMain(t);
  const state = { settings: { comfyuiVideo: { apiKey: 'comfy-secret', baseUrl: 'http://localhost:8188' }, videoApiProfiles: [{ id: 'profile-1', apiKey: 'profile-secret' }] } };
  const stripped = harness.stripSecrets(state);
  assert.equal(stripped.settings.comfyuiVideo.apiKey, '');
  assert.equal(stripped.settings.videoApiProfiles[0].apiKey, '');
  harness.saveSecrets(harness.collectSecrets(state));
  const hydrated = harness.hydrateSecrets(stripped);
  assert.equal(hydrated.settings.comfyuiVideo.apiKey, 'comfy-secret');
  assert.equal(hydrated.settings.videoApiProfiles[0].apiKey, 'profile-secret');
  assert.equal(hydrated.settings.comfyuiVideo.baseUrl, state.settings.comfyuiVideo.baseUrl);
});
