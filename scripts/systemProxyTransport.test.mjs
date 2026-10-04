import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const moduleUrl = new URL('../electron/systemProxyTransport.cjs', import.meta.url);
const helpers = fs.existsSync(moduleUrl) ? require(fileURLToPath(moduleUrl)) : {};
const helper = (name) => {
  assert.equal(typeof helpers[name], 'function', `${name} must support the system proxy instead of bypassing it`);
  return helpers[name];
};

test('system proxy route respects DIRECT and selects HTTP/HTTPS without silently falling back', async () => {
  const resolve = helper('resolveSystemProxy');
  assert.equal(await resolve('https://api.example.test', { resolveProxy: async () => 'DIRECT' }), null);
  assert.equal(await resolve('https://api.example.test', { resolveProxy: async () => 'PROXY 127.0.0.1:10808; DIRECT' }), 'http://127.0.0.1:10808/');
  assert.equal(await resolve('https://api.example.test', { resolveProxy: async () => 'HTTPS proxy.example.test:8443' }), 'https://proxy.example.test:8443/');
  await assert.rejects(resolve('https://api.example.test', { resolveProxy: async () => 'SOCKS5 127.0.0.1:10808; DIRECT' }), /代理.*类型|不支持/u);
  await assert.rejects(resolve('https://api.example.test', { resolveProxy: async () => { throw new Error('PAC unavailable'); } }), /代理/u);
});

test('proxy lookup stops promptly on cancellation or its own resolution deadline', async () => {
  const resolve = helper('resolveSystemProxy');
  const controller = new AbortController();
  const pending = resolve('https://api.example.test', { resolveProxy: () => new Promise(() => {}), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort|取消/iu);
  await assert.rejects(resolve('https://api.example.test', { resolveProxy: () => new Promise(() => {}), timeoutMs: 20 }), /代理.*超时/u);
});

const makeProxy = async (t, handler) => {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/`;
};

test('a real CONNECT tunnel forwards one POST to the pinned IP while keeping origin Host/auth inside it', async (t) => {
  const connect = helper('createProxyTunnelAgent');
  const seen = [];
  let originRequest;
  const proxyUrl = await makeProxy(t, (request, socket) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (!received.includes('{"prompt":"local fixture"}')) return;
      originRequest = received;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
    });
  });
  const agent = await connect({ url: 'http://api.example.test/v1/images/generations', address: '93.184.216.34', family: 4 }, { proxyUrl, connectTimeoutMs: 500 });
  t.after(() => agent.destroy());
  const result = await new Promise((resolve, reject) => {
    const request = http.request('http://api.example.test/v1/images/generations', { method: 'POST', agent, headers: { Authorization: 'Bearer qa-only', 'Content-Type': 'application/json' } }, async (response) => {
      try { const parts = []; for await (const chunk of response) parts.push(chunk); resolve(Buffer.concat(parts).toString()); } catch (error) { reject(error); }
    });
    request.once('error', reject);
    request.end('{"prompt":"local fixture"}');
  });
  assert.equal(result, 'OK');
  assert.equal(seen.length, 1, 'generation POST must not be retried');
  assert.equal(seen[0].method, 'CONNECT');
  assert.equal(seen[0].url, '93.184.216.34:80', 'the proxy must not re-resolve the origin hostname');
  assert.equal(seen[0].headers.authorization, undefined, 'origin API secrets must never be sent to the CONNECT endpoint');
  assert.match(originRequest, /^POST \/v1\/images\/generations HTTP\/1\.1\r\n/u);
  assert.match(originRequest, /Host: api\.example\.test\r\n/iu);
  assert.match(originRequest, /Authorization: Bearer qa-only\r\n/u);
});

test('proxy refusal is actionable and never opens an origin request', async (t) => {
  const connect = helper('createProxyTunnelAgent');
  let attempts = 0;
  const proxyUrl = await makeProxy(t, (_request, socket) => { attempts += 1; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  await assert.rejects(connect({ url: 'https://api.example.test', address: '93.184.216.34', family: 4 }, { proxyUrl, connectTimeoutMs: 500 }), /代理.*407/u);
  assert.equal(attempts, 1);
});

test('stalled CONNECT is bounded and cancellation closes the pending socket', async (t) => {
  const connect = helper('createProxyTunnelAgent');
  const proxyUrl = await makeProxy(t, () => {});
  const target = { url: 'https://api.example.test', address: '93.184.216.34', family: 4 };
  await assert.rejects(connect(target, { proxyUrl, connectTimeoutMs: 25 }), /代理.*连接.*超时/u);
  const controller = new AbortController();
  const pending = connect(target, { proxyUrl, signal: controller.signal, connectTimeoutMs: 500 });
  controller.abort();
  await assert.rejects(pending, /abort|取消/iu);
});
