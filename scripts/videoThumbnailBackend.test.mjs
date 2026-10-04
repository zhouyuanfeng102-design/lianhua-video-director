import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createVideoThumbnailService, normalizeRequest, thumbnailPng } = require('../electron/videoThumbnail.cjs');
const { resolveMediaBinary } = require('../electron/videoWorkbench.cjs');
const root = path.resolve(import.meta.dirname, '..');
const ffmpegPath = resolveMediaBinary('ffmpeg', { projectRoot: root })?.path;
const singlePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const checksum = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture = (t, settings = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-thumbnail-test-'));
  const assetRoot = path.join(directory, 'assets');
  const cacheRoot = path.join(directory, 'cache');
  fs.mkdirSync(path.join(assetRoot, 'video'), { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const services = [];
  t.after(() => {
    for (const service of services) service.close();
    assert.ok(path.isAbsolute(directory) && path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('lianhua-thumbnail-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const makeService = (overrides = {}) => {
    const service = createVideoThumbnailService({ assetRoot, cacheRoot, ffmpegPath: ffmpegPath || process.execPath, ...settings, ...overrides });
    services.push(service);
    return service;
  };
  const makeSource = (name = 'source', projectId = 'project-a') => {
    const relativePath = `video/${name}.mp4`;
    fs.writeFileSync(path.join(assetRoot, relativePath), 'fixture-video');
    return { projectId, assetId: name, relativePath };
  };
  return { directory, assetRoot, cacheRoot, makeService, makeSource };
};
const controlledSpawn = () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const spawnMock = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    active += 1; maxActive = Math.max(maxActive, active);
    let closed = false;
    const finish = (bytes = singlePixel, code = 0) => {
      if (closed) return;
      closed = true; active -= 1;
      child.stdout.end(bytes); child.stderr.end(); child.emit('close', code);
    };
    const call = { binary, args, options, finish, killed: false };
    child.kill = () => { call.killed = true; setImmediate(() => finish(Buffer.alloc(0), 1)); return true; };
    calls.push(call);
    return child;
  };
  return { calls, spawnMock, get maxActive() { return maxActive; } };
};
const until = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for test worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let stderr = '';
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code ? reject(new Error(stderr)) : resolve(Buffer.concat(chunks)));
});

test('thumbnail requests reject remote / arbitrary / traversing paths and malformed identity', () => {
  const base = { projectId: 'p', assetId: 'a', relativePath: 'video/a.mp4' };
  for (const relativePath of ['../outside.mp4', 'video/../../a.mp4', 'https://host/a.mp4', 'file:///C:/a.mp4', 'C:/secret.mp4', '\\\\host\\share\\a.mp4', '/tmp/a.mp4', 'video//a.mp4', 'video/./a.mp4', 'video/a.mp4\0', 'video/playlist.m3u8', 'image/a.png']) {
    assert.throws(() => normalizeRequest({ ...base, relativePath }), undefined, relativePath);
  }
  for (const invalid of [{ projectId: '' }, { assetId: '\0' }, { expectedChecksum: 'bad' }, { expectedChecksum: true }, { expectedChecksum: false }, { expectedChecksum: 0 }]) assert.throws(() => normalizeRequest({ ...base, ...invalid }));
  assert.equal(normalizeRequest({ ...base, relativePath: 'video\\a.mp4' }).relativePath, 'video/a.mp4');
  assert.equal(thumbnailPng(singlePixel).width, 1);
  assert.throws(() => thumbnailPng(Buffer.from('not-an-image')), /格式无效/u);
  const corrupted = Buffer.from(singlePixel);
  corrupted[45] ^= 0xff;
  assert.throws(() => thumbnailPng(corrupted), /格式无效/u);
});

test('main/preload expose trusted thumbnail and owner-scoped cancellation with renderer lifecycle cleanup', () => {
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  for (const channel of ['get-video-thumbnail', 'cancel-video-thumbnails']) {
    assert.ok(main.includes(`handleTrustedIpc('lianhua:${channel}'`));
    assert.ok(preload.includes(`invoke('lianhua:${channel}'`));
  }
  assert.match(main, /getVideoThumbnails\(event\)\.get\(payload, event\.sender\.id\)/u);
  assert.match(main, /videoThumbnails\?\.cancelProject\(payload\?\.projectId, event\.sender\.id\)/u);
  assert.match(main, /sender\.once\('destroyed', \(\) => videoThumbnails\?\.cancelOwner\(ownerId\)\)/u);
  assert.match(main, /sender\.on\('render-process-gone', \(\) => videoThumbnails\?\.cancelOwner\(ownerId\)\)/u);
  assert.ok(main.includes('videoThumbnails?.close()'));
});

test('identical sources coalesce, queue is bounded, cancellation respects both renderer owner and project', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource } = fixture(t, { spawn: fake.spawnMock, maxPending: 2 });
  const service = makeService();
  const source = makeSource();
  const other = makeSource('other');
  const overflow = makeSource('overflow');
  const first = service.get(source, 7);
  const firstRejected = assert.rejects(first, /已取消/u);
  assert.equal(service.get(source, 7), first, 'same owner+project shares a promise');
  const sameSourceOtherProject = service.get({ ...source, projectId: 'project-b' }, 7);
  const otherProjectRejected = assert.rejects(sameSourceOtherProject, /已取消/u);
  const sameSourceOtherOwner = service.get(source, 8);
  const second = service.get(other, 8);
  await assert.rejects(service.get(overflow, 8), /队列已满/u);
  await until(() => fake.calls.length === 1);
  assert.equal(service.cancelProject('project-a', 99), 0);
  assert.equal(service.cancelProject('project-a', 7), 1);
  await firstRejected;
  assert.equal(fake.calls[0].killed, false, 'remaining subscribers keep a shared job alive');
  assert.equal(service.cancelOwner(7), 1);
  await otherProjectRejected;
  assert.equal(fake.calls[0].killed, false, 'another renderer still owns the source request');
  fake.calls[0].finish();
  assert.equal((await sameSourceOtherOwner).mimeType, 'image/png');
  await until(() => fake.calls.length === 2);
  fake.calls[1].finish();
  await second;
  assert.equal(fake.maxActive, 1);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal(fake.calls[0].options.shell, false);
  assert.ok(fake.calls[0].args.includes('file,pipe'));
  assert.ok(fake.calls[0].args.includes('-frames:v'));
  assert.ok(fake.calls[0].args.includes('image2pipe'));
});

test('cancelling the last subscriber stops its decoder, queued work continues, late result cannot escape', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource, cacheRoot } = fixture(t, { spawn: fake.spawnMock });
  const service = makeService();
  const source = makeSource();
  const cancelled = service.get(source, 1);
  const rejected = assert.rejects(cancelled, /已取消/u);
  const next = service.get(makeSource('next', 'other-project'), 2);
  await until(() => fake.calls.length === 1);
  assert.equal(service.cancelProject('project-a', 1), 1);
  await rejected;
  await until(() => fake.calls.length === 2);
  assert.equal(fake.calls[0].killed, true);
  fake.calls[0].finish();
  fake.calls[1].finish();
  await next;
  assert.equal(fs.readdirSync(path.join(cacheRoot, 'video-thumbnails')).filter((name) => name.endsWith('.png')).length, 1);
  assert.equal(fake.maxActive, 1);
  service.close();
  await assert.rejects(service.get(source, 1), /已取消/u);
});

test('missing tools, corrupt media output and changed checksums fail with no placeholder video/cache', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource, cacheRoot } = fixture(t, { spawn: fake.spawnMock });
  const source = makeSource();
  const missing = makeService({ ffmpegPath: undefined, env: { PATH: '' } });
  await assert.rejects(missing.get(source, 1), /FFmpeg/u);
  const service = makeService();
  await assert.rejects(service.get({ ...source, expectedChecksum: '0'.repeat(64) }, 1), /校验失败/u);
  assert.equal(fake.calls.length, 0);
  const corrupt = service.get(source, 1);
  const rejected = assert.rejects(corrupt, /格式无效/u);
  await until(() => fake.calls.length === 1);
  fake.calls[0].finish(Buffer.from('corrupt'));
  await rejected;
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, 'video-thumbnails')), []);
});

test('a stalled decoder times out and releases its only slot for the next thumbnail', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource } = fixture(t, { spawn: fake.spawnMock, timeoutMs: 100 });
  const service = makeService();
  const stalled = service.get(makeSource('stalled'), 1);
  const timedOut = assert.rejects(stalled, /超时/u);
  const next = service.get(makeSource('after-timeout'), 1);
  await timedOut;
  await until(() => fake.calls.length === 2);
  assert.equal(fake.calls[0].killed, true);
  fake.calls[1].finish();
  assert.equal((await next).mimeType, 'image/png');
  assert.equal(fake.maxActive, 1);
});

test('unconfirmed decoder exit disables the worker and rejects pending/new work without starting another decoder', async (t) => {
  const fake = controlledSpawn();
  const childHolder = {};
  const kills = [];
  const { makeService, makeSource, cacheRoot } = fixture(t, {
    timeoutMs: 30, killGraceMs: 10, closeGraceMs: 10,
    spawn: (...args) => {
      const child = fake.spawnMock(...args);
      childHolder.child = child;
      child.kill = (signal) => { kills.push(signal || 'SIGTERM'); return false; };
      return child;
    },
  });
  const service = makeService();
  let firstSettled = false; let nextSettled = false;
  const first = assert.rejects(service.get(makeSource('unkillable'), 1), /未能退出/u).then(() => { firstSettled = true; });
  const next = assert.rejects(service.get(makeSource('must-not-start'), 1), /未能退出/u).then(() => { nextSettled = true; });
  await until(() => firstSettled && nextSettled);
  await Promise.all([first, next]);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.calls.length, 1, 'never start a second decoder while the first may still be alive');
  assert.equal(service.canRestart(), false, 'main must retain a quarantined worker across window recreation');
  await assert.rejects(service.get(makeSource('later-request'), 1), /未能退出/u);
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, 'video-thumbnails')), []);
  service.close();
  assert.equal(kills.at(-1), 'SIGKILL', 'app close still tries to stop its own unconfirmed decoder');
  assert.equal(service.canRestart(), false);
  childHolder.child.emit('exit', 1);
  childHolder.child.emit('close', 1);
  assert.equal(service.canRestart(), true, 'recreation is only safe after a real exit confirmation');
  assert.equal(fake.calls.length, 1);
});

test('cache-hit read racing with source replacement rejects the stale thumbnail without spawning a decoder', async (t) => {
  const fake = controlledSpawn();
  const { assetRoot, cacheRoot, makeSource, makeService } = fixture(t, { spawn: fake.spawnMock });
  const source = makeSource();
  const priming = makeService();
  const first = priming.get(source, 1);
  await until(() => fake.calls.length === 1);
  fake.calls[0].finish();
  const result = await first;
  priming.close();
  const cacheFile = path.join(cacheRoot, 'video-thumbnails', `${result.cacheKey}.png`);
  let started = false; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fsStub = {
    ...fs,
    promises: {
      ...fs.promises,
      readFile: async (file, ...args) => {
        const bytes = await fs.promises.readFile(file, ...args);
        if (path.resolve(file) === cacheFile) { started = true; await gate; }
        return bytes;
      },
    },
  };
  const sandbox = {
    module: { exports: {} }, Buffer, process, setTimeout, clearTimeout,
    require: (name) => name === 'node:fs' ? fsStub : name === './videoWorkbench.cjs' ? require('../electron/videoWorkbench.cjs') : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/videoThumbnail.cjs'), 'utf8'), sandbox);
  const service = sandbox.module.exports.createVideoThumbnailService({ assetRoot, cacheRoot, spawn: fake.spawnMock, ffmpegPath: ffmpegPath || process.execPath });
  t.after(() => { release(); service.close(); });
  const stale = assert.rejects(service.get(source, 1), /发生变化/u);
  await until(() => started);
  fs.writeFileSync(path.join(assetRoot, source.relativePath), 'replacement-source-with-different-identity');
  release();
  await stale;
  assert.equal(fake.calls.length, 1, 'a cache-hit source race must not fall through into decoding old identity');
});

test('a symlink/junction escape cannot be decoded or used as a thumbnail cache', async (t) => {
  const fake = controlledSpawn();
  const { directory, assetRoot, cacheRoot, makeService, makeSource } = fixture(t, { spawn: fake.spawnMock });
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.mp4'), 'secret');
  fs.symlinkSync(outside, path.join(assetRoot, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  const service = makeService();
  await assert.rejects(service.get({ projectId: 'p', assetId: 'a', relativePath: 'escaped/secret.mp4' }, 1), /越界/u);
  fs.symlinkSync(outside, path.join(cacheRoot, 'video-thumbnails'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.get(makeSource(), 1), /缓存路径越界/u);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fs.readdirSync(outside), ['secret.mp4']);
});

test('real media: static first-frame PNG is small, persistent, invalidates changed source, and never rewrites the original', { skip: !ffmpegPath }, async (t) => {
  let decoderCount = 0;
  const { assetRoot, cacheRoot, makeService } = fixture(t, { spawn: (...args) => { decoderCount += 1; return spawn(...args); } });
  const relativePath = 'video/color-change.mp4';
  const file = path.join(assetRoot, relativePath);
  const generate = (firstColor, lastColor) => run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${firstColor}:s=960x540:r=4:d=0.5`, '-f', 'lavfi', '-i', `color=c=${lastColor}:s=960x540:r=4:d=0.5`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  await generate('red', 'blue');
  const original = fs.readFileSync(file);
  const request = { projectId: 'project-a', assetId: 'color', relativePath, expectedChecksum: checksum(file) };
  const service = makeService();
  const result = await service.get(request, 1);
  assert.equal(result.width, 480);
  assert.equal(result.height, 270);
  assert.ok(result.sizeBytes < 100 * 1024);
  assert.equal(decoderCount, 1);
  assert.deepEqual(await service.get(request, 1), result);
  assert.equal(decoderCount, 1);
  service.close();
  const restarted = makeService();
  assert.deepEqual(await restarted.get(request, 1), result, 'disk cache is reused after restart');
  assert.equal(decoderCount, 1);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(assetRoot), ['video']);
  const cacheFile = path.join(cacheRoot, 'video-thumbnails', `${result.cacheKey}.png`);
  const pixel = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', cacheFile, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.ok(pixel[0] > 220 && pixel[1] < 30 && pixel[2] < 30, `thumbnail must be the red FIRST frame, got ${[...pixel]}`);
  await generate('lime', 'blue');
  await assert.rejects(restarted.get(request, 1), /校验失败/u);
  const replacement = await restarted.get({ ...request, expectedChecksum: checksum(file) }, 1);
  assert.notEqual(replacement.cacheKey, result.cacheKey);
  assert.notEqual(replacement.dataUrl, result.dataUrl);
  assert.equal(decoderCount, 2);
  assert.equal(fs.readdirSync(path.join(assetRoot, 'video')).length, 1, 'thumbnails are not added to the asset library');
});

test('cached corruption is regenerated and cache cleanup only removes this worker’s own bounded files', async (t) => {
  const fake = controlledSpawn();
  const { makeService, makeSource, cacheRoot } = fixture(t, { spawn: fake.spawnMock, maxCacheEntries: 1 });
  const service = makeService();
  const firstSource = makeSource('first');
  const first = service.get(firstSource, 1);
  await until(() => fake.calls.length === 1);
  fake.calls[0].finish();
  const firstResult = await first;
  const directory = path.join(cacheRoot, 'video-thumbnails');
  fs.writeFileSync(path.join(directory, `${firstResult.cacheKey}.png`), 'corrupt');
  fs.writeFileSync(path.join(directory, 'user-file.png'), 'untouched');
  const regenerated = service.get(firstSource, 1);
  await until(() => fake.calls.length === 2);
  fake.calls[1].finish();
  assert.equal((await regenerated).dataUrl, firstResult.dataUrl);
  const second = service.get(makeSource('second'), 1);
  await until(() => fake.calls.length === 3);
  fake.calls[2].finish();
  await second;
  assert.equal(fs.readdirSync(directory).filter((name) => /^[a-f\d]{64}\.png$/u.test(name)).length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'user-file.png'), 'utf8'), 'untouched');
});
