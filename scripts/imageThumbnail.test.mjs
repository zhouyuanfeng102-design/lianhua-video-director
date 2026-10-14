import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createImageThumbnailService, normalizeRequest, thumbnailResult } = require('../electron/imageThumbnail.cjs');
const singlePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

const fixture = (t, defaults = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-image-thumbnail-test-'));
  const assetRoot = path.join(directory, 'assets');
  const cacheRoot = path.join(directory, 'cache');
  fs.mkdirSync(path.join(assetRoot, 'image'), { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const services = [];
  t.after(() => {
    for (const service of services) service.close();
    assert.ok(path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('lianhua-image-thumbnail-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const makeService = (overrides = {}) => {
    const service = createImageThumbnailService({ assetRoot, cacheRoot, ffmpegPath: process.execPath, ...defaults, ...overrides });
    services.push(service);
    return service;
  };
  const makeSource = (name = 'source') => {
    const relativePath = `image/${name}.png`;
    fs.writeFileSync(path.join(assetRoot, relativePath), singlePixel);
    return { relativePath };
  };
  return { directory, assetRoot, cacheRoot, makeSource, makeService };
};
const until = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for thumbnail worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const controlledSpawn = ({ stuck = false } = {}) => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const spawnMock = (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = calls.length + 100;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    active += 1; maxActive = Math.max(maxActive, active);
    let closed = false;
    const finish = (bytes = singlePixel, code = 0) => {
      if (closed) return;
      closed = true; active -= 1;
      child.stdout.end(bytes); child.stderr.end();
      child.emit('exit', code); child.emit('close', code);
    };
    const call = { binary, args, options, finish, kills: [] };
    child.kill = (signal) => {
      call.kills.push(signal || 'SIGTERM');
      if (!stuck) setImmediate(() => finish(Buffer.alloc(0), 1));
      return true;
    };
    calls.push(call);
    return child;
  };
  return { calls, spawnMock, get maxActive() { return maxActive; } };
};

test('requests reject remote paths, traversal, invalid identity and corrupt or oversized PNGs', () => {
  for (const relativePath of ['../a.png', 'image/../../a.png', 'https://host/a.png', 'file:///C:/a.png', 'C:/a.png', '\\\\host\\a.png', '/tmp/a.png', 'image//a.png', 'image/./a.png', 'image/a.png\0', 'video/a.mp4']) {
    assert.throws(() => normalizeRequest({ relativePath }), undefined, relativePath);
  }
  for (const expectedChecksum of ['bad', false, 0]) assert.throws(() => normalizeRequest({ relativePath: 'image/a.png', expectedChecksum }));
  assert.equal(normalizeRequest({ relativePath: 'image\\a.png' }).relativePath, 'image/a.png');
  assert.equal(thumbnailResult(singlePixel).width, 1);
  const corrupt = Buffer.from(singlePixel);
  corrupt[45] ^= 255;
  assert.throws(() => thumbnailResult(corrupt), /格式无效/u);
  const oversized = Buffer.from(singlePixel);
  oversized.writeUInt32BE(4000, 16);
  assert.throws(() => thumbnailResult(oversized), /尺寸无效/u);
});

test('shared requests use two hidden decoders, a bounded queue and cancellation scoped to each owner', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource } = fixture(t, { spawn: fake.spawnMock, maxPending: 3 });
  const service = makeService();
  const source = makeSource('shared');
  const first = service.get(source, 1);
  const firstRejected = assert.rejects(first, /已取消/u);
  assert.equal(service.get(source, 1), first);
  const surviving = service.get(source, 2);
  const second = service.get(makeSource('second'), 2);
  const queued = service.get(makeSource('queued'), 1);
  const queuedRejected = assert.rejects(queued, /已取消/u);
  const overflow = makeSource('overflow');
  await assert.rejects(service.get(overflow, 3), /队列已满/u);
  await until(() => fake.calls.length === 2);
  assert.equal(service.cancelOwner(1), 2);
  await Promise.all([firstRejected, queuedRejected]);
  assert.equal(fake.calls[0].kills.length, 0, 'the other owner keeps the shared decoder alive');
  const replacement = service.get(overflow, 3);
  fake.calls[0].finish(); fake.calls[1].finish();
  await Promise.all([surviving, second]);
  await until(() => fake.calls.length === 3);
  fake.calls[2].finish();
  await replacement;
  assert.equal(fake.maxActive, 2);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal(fake.calls[0].options.shell, false);
  assert.ok(fake.calls[0].args.includes('file,pipe'));
  assert.match(fake.calls[0].args[fake.calls[0].args.indexOf('-vf') + 1], /min\(160,iw\).*min\(160,ih\)/u);
});

test('cancelling the last owner and closing the service stop active children and reject queued work', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource, cacheRoot } = fixture(t, { spawn: fake.spawnMock, concurrency: 1 });
  const service = makeService();
  const cancelled = service.get(makeSource('cancelled'), 1);
  const cancelledRejected = assert.rejects(cancelled, /已取消/u);
  const next = service.get(makeSource('next'), 2);
  const nextRejected = assert.rejects(next, /已取消/u);
  await until(() => fake.calls.length === 1);
  assert.equal(service.cancelOwner(1), 1);
  await cancelledRejected;
  await until(() => fake.calls.length === 2);
  assert.equal(fake.calls[0].kills.length, 1);
  const queued = service.get(makeSource('queued'), 3);
  const queuedRejected = assert.rejects(queued, /已取消/u);
  service.close();
  await Promise.all([nextRejected, queuedRejected]);
  await until(() => fake.calls[1].kills.length === 1);
  await assert.rejects(service.get(makeSource('closed'), 4), /已取消/u);
  assert.equal(fake.calls.length, 2, 'closing does not start queued work');
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, 'image-thumbnails')), []);
});

test('small memory and disk caches reuse PNGs, evict within bounds and invalidate changed sources without changing originals', async (t) => {
  let generated = 0;
  const { makeService, makeSource, assetRoot, cacheRoot } = fixture(t, {
    maxMemoryEntries: 1, maxCacheEntries: 2, maxCacheBytes: singlePixel.length * 2,
    generateThumbnail: async () => { generated += 1; return singlePixel; },
  });
  const service = makeService();
  const first = makeSource('first');
  const second = makeSource('second');
  await service.get(first, 1); await service.get(second, 1); await service.get(first, 1);
  assert.equal(generated, 2, 'memory eviction still reuses the disk thumbnail');
  const original = path.join(assetRoot, first.relativePath);
  assert.deepEqual(fs.readFileSync(original), singlePixel);
  fs.appendFileSync(original, Buffer.from('\n'));
  await service.get(first, 1);
  assert.equal(generated, 3, 'source stat changes invalidate the prior identity');
  await service.get({ ...first, expectedChecksum: 'a'.repeat(64) }, 1);
  assert.equal(generated, 4, 'preview checksum participates in the key without reading/hash-checking the original');
  assert.deepEqual(fs.readFileSync(original), Buffer.concat([singlePixel, Buffer.from('\n')]));
  const entries = fs.readdirSync(path.join(cacheRoot, 'image-thumbnails'));
  assert.ok(entries.length <= 2);
  assert.ok(entries.reduce((sum, name) => sum + fs.statSync(path.join(cacheRoot, 'image-thumbnails', name)).size, 0) <= singlePixel.length * 2);
  service.close();
  const restarted = makeService();
  await restarted.get({ ...first, expectedChecksum: 'a'.repeat(64) }, 2);
  assert.equal(generated, 4, 'disk cache survives a service restart');
});

test('corrupt cached PNGs regenerate and sources changed during decoding do not publish stale previews', async (t) => {
  let generated = 0;
  const { makeService, makeSource, assetRoot, cacheRoot } = fixture(t, {
    generateThumbnail: async () => { generated += 1; return singlePixel; },
  });
  const source = makeSource();
  const first = makeService();
  await first.get(source, 1); first.close();
  const cacheDirectory = path.join(cacheRoot, 'image-thumbnails');
  fs.writeFileSync(path.join(cacheDirectory, fs.readdirSync(cacheDirectory)[0]), 'corrupt');
  await makeService().get(source, 2);
  assert.equal(generated, 2);
  const changed = makeSource('changed');
  const stale = makeService({ generateThumbnail: async (filePath) => { fs.appendFileSync(filePath, '\n'); return singlePixel; } });
  await assert.rejects(stale.get(changed, 3), /发生变化/u);
  assert.equal(fs.readdirSync(cacheDirectory).length, 1, 'no stale PNG was cached');
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, source.relativePath)), singlePixel);
});

test('realpath checks reject source junction escapes and unsafe cache junctions never receive files', async (t) => {
  let generated = 0;
  const { directory, makeService, makeSource, assetRoot, cacheRoot } = fixture(t, {
    generateThumbnail: async () => { generated += 1; return singlePixel; },
  });
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escaped.png'), singlePixel);
  fs.symlinkSync(outside, path.join(assetRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const service = makeService();
  await assert.rejects(service.get({ relativePath: 'linked/escaped.png' }, 1), /路径越界/u);
  assert.equal(generated, 0);
  fs.symlinkSync(outside, path.join(cacheRoot, 'image-thumbnails'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await service.get(makeSource('safe'), 1);
  assert.equal(result.mimeType, 'image/png', 'cache failure still permits a memory-only preview');
  assert.deepEqual(fs.readdirSync(outside), ['escaped.png']);
});

test('decoder timeout and oversized output fail locally, and confirmed exits allow the next queued image', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource, assetRoot } = fixture(t, { spawn: fake.spawnMock, concurrency: 1, timeoutMs: 30 });
  const service = makeService();
  const source = makeSource('timeout');
  const timed = service.get(source, 1);
  const timedRejected = assert.rejects(timed, /超时/u);
  const large = service.get(makeSource('large'), 1);
  const largeRejected = assert.rejects(large, /输出过大/u);
  await until(() => fake.calls.length === 2);
  await timedRejected;
  fake.calls[1].finish(Buffer.alloc(256 * 1024 + 1));
  await largeRejected;
  const good = service.get(makeSource('good'), 1);
  await until(() => fake.calls.length === 3);
  fake.calls[2].finish();
  assert.equal((await good).mimeType, 'image/png');
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, source.relativePath)), singlePixel);
});

test('an unconfirmed child exit suspends generation without releasing capacity into another live process', async (t) => {
  const fake = controlledSpawn({ stuck: true });
  const { makeService, makeSource } = fixture(t, { spawn: fake.spawnMock, concurrency: 1, timeoutMs: 15, killGraceMs: 5, closeGraceMs: 5 });
  const keepAlive = setInterval(() => {}, 10);
  t.after(() => clearInterval(keepAlive));
  const service = makeService();
  const first = service.get(makeSource('stuck'), 1);
  const second = service.get(makeSource('queued'), 2);
  await Promise.all([assert.rejects(first, /未能退出/u), assert.rejects(second, /未能退出/u)]);
  assert.deepEqual(fake.calls[0].kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.calls.length, 1);
  await assert.rejects(service.get(makeSource('later'), 3), /已取消/u);
});
