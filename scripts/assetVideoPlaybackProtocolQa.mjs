import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const { resolveMediaBinary } = require('../electron/videoWorkbench.cjs');
const { createAssetProtocolHandler } = require('../electron/assetProtocol.cjs');
const root = path.resolve(import.meta.dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'output', 'asset-video-playback-'));
const assetRoot = path.join(output, 'assets'); fs.mkdirSync(path.join(assetRoot, 'video'), { recursive: true });
const ffmpeg = resolveMediaBinary('ffmpeg', { projectRoot: root })?.path;
assert.ok(ffmpeg, 'A real media tool is required for the playback fixtures');
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  child.stderr.on('data', (data) => { error += data; }); child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fixture generation failed ${code}: ${error}`)));
});
const checksum = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = process.env.QA_VIDEO;
const retryOnly = process.env.QA_CASE === 'retry';
const tokenOnly = process.env.QA_CASE === 'local-token';
const originalHash = original ? checksum(original) : undefined;
const files = ['MP4 中文 & %.mp4', 'MP4命名为mov.mov', 'WebM视频.webm'];
for (const file of files) await run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', file.endsWith('.webm') ? 'libvpx' : 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', file.endsWith('.webm') ? 'libvorbis' : 'aac', '-f', file.endsWith('.webm') ? 'webm' : 'mp4', path.join(assetRoot, 'video', file)]);
const bytes = fs.readFileSync(path.join(assetRoot, 'video', files[0]));
const handler = createAssetProtocolHandler({ assetPathFromRelative: (relative) => {
  const resolved = path.resolve(assetRoot, relative); const escaped = path.relative(assetRoot, resolved);
  if (!escaped || escaped.startsWith('..') || path.isAbsolute(escaped)) throw new Error('Invalid test asset path'); return resolved;
} });
const url = `lianhua-asset://local/video/${encodeURIComponent(files[0])}`;
if (!retryOnly && !tokenOnly) {
const ranged = await handler(new Request(url, { headers: { Range: 'bytes=100-199' } }));
assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('Content-Range'), `bytes 100-199/${bytes.length}`);
assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(100, 200));
const suffix = await handler(new Request(url, { headers: { Range: 'bytes=-20' } }));
assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-20));
const head = await handler(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=100-199' } }));
assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
for (const range of [`bytes=${bytes.length}-`, 'bytes=100-20', 'bytes=-0', 'bytes=0-1,4-5']) {
  const response = await handler(new Request(url, { headers: { Range: range } })); assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), `bytes */${bytes.length}`);
}
assert.equal((await handler(new Request('lianhua-asset://other/video/file.mp4'))).status, 400);
assert.equal((await handler(new Request('lianhua-asset://local/video/%2e%2e%2f%2e%2e%2foutside.mp4'))).status, 400);
assert.equal((await handler(new Request('lianhua-asset://local/video/missing.mp4'))).status, 404);
assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405);
const controller = new AbortController();
const cancelled = await handler(new Request(url, { signal: controller.signal })); const reader = cancelled.body.getReader();
controller.abort();
await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /cancelled|aborted|closed/i);
console.log('Local asset protocol: byte boundaries, suffix, HEAD, 416, safe paths, missing files and cancellation passed.');
}

let app;
const records = [];
try {
  app = await electron.launch({ executablePath: require('electron'), args: [path.join(root, 'scripts/fixtures/assetVideoPlaybackElectron.cjs')], cwd: root,
    env: { ...process.env, LIANHUA_PLAYBACK_QA_ROOT: output, ...(original ? { LIANHUA_PLAYBACK_QA_VIDEO: path.resolve(original) } : {}) } });
  const page = await app.firstWindow(); await page.waitForFunction(() => typeof window.qaOpenVideo === 'function');
  if (!retryOnly && !tokenOnly) {
  const nativeRange = await app.evaluate(async (_, source) => global.qaFetch(source, { headers: { Range: 'bytes=100-199' } }), url);
  assert.equal(nativeRange.status, 206); assert.deepEqual(Buffer.from(nativeRange.bytes), bytes.subarray(100, 200));
  const nativeHead = await app.evaluate(async (_, source) => global.qaFetch(source, { method: 'HEAD' }), url);
  assert.equal(nativeHead.headers['content-length'], String(bytes.length)); assert.equal(nativeHead.bytes.length, 0);
  }
  if (!retryOnly) {
  const sources = [...(tokenOnly ? [files[1]] : files), ...(original ? ['user.mov'] : [])];
  for (const source of sources) for (let open = 0; open < 2; open++) {
    await page.evaluate((file) => window.qaOpenVideo(file), source);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, undefined, { timeout: 15000 });
    const sourceBeforeMetadataRender = await page.locator('video').getAttribute('src');
    const playing = await page.evaluate(async () => {
      const video = document.querySelector('video'); video.muted = true; await video.play();
      await new Promise((resolve) => setTimeout(resolve, 150)); video.pause();
      return { time: video.currentTime, duration: video.duration, width: video.videoWidth, error: video.error?.message };
    });
    assert.ok(playing.time > 0 && playing.width > 0 && playing.duration > 0 && !playing.error, `actual playback ${source}`);
    const seeks = await page.evaluate(async () => {
      const video = document.querySelector('video'); const values = [];
      for (const target of [video.duration / 2, Math.max(0, video.duration - 1)]) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('seek timed out')), 10000);
          video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true }); video.currentTime = target;
        });
        await new Promise((resolve) => setTimeout(resolve, 60)); values.push({ target, time: video.currentTime, ready: video.readyState });
      }
      return values;
    });
    for (const result of seeks) assert.ok(Math.abs(result.target - result.time) < .05 && result.ready >= 2, `seek stable after seeked ${source}: ${JSON.stringify(result)}`);
    assert.equal(await page.locator('video').getAttribute('src'), sourceBeforeMetadataRender, 'metadata rerenders must keep the current decoder source stable');
    assert.equal(await page.locator('.asset-video-error').count(), 0);
    await page.evaluate(() => { window.qaReleasedVideo = document.querySelector('video'); });
    if (open === 0) await page.getByRole('button', { name: '关闭视频播放', exact: true }).click(); else await page.keyboard.press('Escape');
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.evaluate(() => window.qaReleasedVideo.paused && !window.qaReleasedVideo.getAttribute('src')), true);
    records.push({ source, open, ...playing, seeks });
  }
  console.log(`Electron actual dialog: ${records.length} repeated opens, playback, middle/end seeks and close release passed.`);
  fs.writeFileSync(path.join(output, 'playback-report.json'), JSON.stringify({ records, originalUnchanged: original ? checksum(original) === originalHash : undefined }, null, 2));
  }
  if (!tokenOnly) {
  // A failed decode can be retried in-place; successful metadata clears old errors.
  fs.writeFileSync(path.join(assetRoot, 'video', 'retry.mp4'), 'incomplete media');
  await page.evaluate(() => window.qaOpenVideo('retry.mp4'));
  await page.getByRole('button', { name: '重新加载视频', exact: true }).waitFor();
  fs.copyFileSync(path.join(assetRoot, 'video', files[0]), path.join(assetRoot, 'video', 'retry.mp4'));
  await page.getByRole('button', { name: '重新加载视频', exact: true }).click();
  try { await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, undefined, { timeout: 15000 }); }
  catch(error) { console.log('retry-state', await page.evaluate(() => ({ video: { src: document.querySelector('video')?.src, error: document.querySelector('video')?.error?.message, code: document.querySelector('video')?.error?.code, ready: document.querySelector('video')?.readyState }, alert: document.querySelector('.asset-video-error')?.textContent })), await app.evaluate(() => global.qaProtocolRequests)); throw error; }
  assert.equal(await page.locator('.asset-video-error').count(), 0);
  await page.getByRole('button', { name: '关闭视频播放', exact: true }).click();
  }
  const requests = await app.evaluate(() => global.qaProtocolRequests);
  assert.ok(requests.some((item) => item.range && item.status === 206 && item.contentRange));
  if (!retryOnly) assert.ok(requests.some((item) => new URL(item.url).pathname.endsWith('MP4%E5%91%BD%E5%90%8D%E4%B8%BAmov.mov') && item.type === 'video/mp4'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ records, requests, originalUnchanged: original ? checksum(original) === originalHash : undefined }, null, 2));
  console.log(tokenOnly ? `Electron fresh local sources: ${records.length} repeated opens, actual playback, middle/end seeks, stable metadata rerender and close release passed.`
    : `Electron actual dialog: ${records.length} repeated opens, playback, middle/end seeks, close releases, StrictMode and error reload passed.`);
} finally { if (app) await app.close(); }
if (original) assert.equal(checksum(original), originalHash, 'the original video is read-only and unchanged');
console.log(`Playback evidence: ${output}`);
