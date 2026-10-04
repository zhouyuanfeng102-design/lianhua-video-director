import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createVideoWorkbench, resolveManagedSource, parseProbe, chooseFrames, buildRenderPlan } = require('../electron/videoWorkbench.cjs');
const root = path.resolve(import.meta.dirname, '..');
const bundled = path.join(root, 'build', 'media-tools', `${process.platform}-${process.arch}`);
const diagnostics = path.join(root, 'output', 'diagnostics', 'h3-video-analysis', 'tools', 'runtime', 'node_modules');
const executable = (name) => process.platform === 'win32' ? `${name}.exe` : name;
const findBinary = (name) => {
  const candidates = [
    process.env[`LIANHUA_${name.toUpperCase()}_PATH`],
    path.join(bundled, executable(name)),
    name === 'ffmpeg' ? path.join(diagnostics, 'ffmpeg-static', executable(name)) : path.join(diagnostics, 'ffprobe-static', 'bin', process.platform, process.arch, executable(name)),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable(name))),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
};
const ffmpegPath = findBinary('ffmpeg');
const ffprobePath = findBinary('ffprobe');
const withFixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-workbench-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assetRoot = path.join(directory, 'assets');
  const tempRoot = path.join(directory, 'temp');
  fs.mkdirSync(path.join(assetRoot, 'video'), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'audio'), { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const service = createVideoWorkbench({ assetRoot, tempRoot, ffmpegPath, ffprobePath });
  t.after(() => service.close());
  return { directory, assetRoot, tempRoot, service };
};
const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true, shell: false });
  let errorText = '';
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errorText += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code ? reject(new Error(errorText)) : resolve(output));
});
const runBytes = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true, shell: false });
  const chunks = []; let errorText = '';
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => { errorText += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code ? reject(new Error(errorText)) : resolve(Buffer.concat(chunks)));
});
const frequencyAmplitude = (samples, frequency, rate = 48000) => {
  let real = 0; let imaginary = 0;
  const count = samples.length / 4;
  for (let i = 0; i < count; i += 1) {
    const value = samples.readFloatLE(i * 4);
    real += value * Math.cos(2 * Math.PI * frequency * i / rate);
    imaginary += value * Math.sin(2 * Math.PI * frequency * i / rate);
  }
  return Math.sqrt(real * real + imaginary * imaginary) * 2 / count;
};
const videoFixture = async (assetRoot, name, color, audio = true, duration = 1.2, dimensions = '160x96', fps = 10) => {
  const filePath = path.join(assetRoot, 'video', `${name}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${dimensions}:r=${fps}:d=${duration}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${duration}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1');
  if (audio) args.push('-c:a', 'aac');
  args.push('-t', String(duration), filePath);
  await run(ffmpegPath, args);
  return { assetId: name, relativePath: `video/${name}.mp4`, expectedChecksum: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') };
};

test('managed source resolver rejects traversal, remote inputs and changed originals', async (t) => {
  const { assetRoot } = withFixture(t);
  fs.writeFileSync(path.join(assetRoot, 'video', 'source.mp4'), 'video');
  for (const relativePath of ['../secret.mp4', 'video/../../secret.mp4', 'C:/secret.mp4', '//host/secret.mp4', 'video//source.mp4', 'video/source.mp4\0']) {
    await assert.rejects(resolveManagedSource(assetRoot, { assetId: 'x', relativePath }));
  }
  await assert.rejects(resolveManagedSource(assetRoot, { assetId: 'x', relativePath: 'video/source.mp4', expectedChecksum: '0'.repeat(64) }), /校验失败/u);
  const valid = await resolveManagedSource(assetRoot, { assetId: 'x', relativePath: 'video/source.mp4' });
  assert.equal(valid.format, 'mov');
});

test('probe handles rotated videos and refuses files without a video stream', () => {
  const details = parseProbe({ streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: '2', avg_frame_rate: '30000/1001', codec_name: 'h264', side_data_list: [{ rotation: 90 }] }] });
  assert.equal(details.probe.width, 1080);
  assert.equal(details.probe.height, 1920);
  assert.ok(Math.abs(details.probe.fps - 29.97) < 0.01);
  assert.throws(() => parseProbe({ streams: [{ codec_type: 'audio' }], format: { duration: 2 } }), /没有可解码/u);
});

test('frame selection uses real timestamps and zero-based decoded indices, including VFR', () => {
  const probe = { durationSec: 1, fps: 10 };
  const frames = [0, 0.04, 0.16, 0.7, 0.95].map((timeSec, frameIndex) => ({ timeSec, frameIndex }));
  assert.deepEqual(chooseFrames({ mode: 'frame', frameIndex: 2 }, probe, frames), [{ timeSec: 0.16, frameIndex: 2, role: 'custom-frame' }]);
  assert.equal(chooseFrames({ mode: 'time', timeSec: 0.4 }, probe, frames)[0].timeSec, 0.7);
  assert.equal(chooseFrames({ mode: 'last' }, probe, frames)[0].timeSec, 0.95);
  assert.equal(chooseFrames({ mode: 'last', inSec: 0.1, outSec: 0.7 }, probe, frames)[0].timeSec, 0.16);
  assert.equal(chooseFrames({ mode: 'uniform', count: 120 }, probe, frames).length, 5);
  assert.throws(() => chooseFrames({ mode: 'frame', frameIndex: 5 }, probe, frames), /超出/u);
  assert.throws(() => chooseFrames({ mode: 'time', timeSec: 1 }, probe, frames), /早于出点/u);
});

test('render plan quantizes frame ranges and bounds transitions / music volume', () => {
  const source = { path: 'video.mp4', probe: { width: 640, height: 360, durationSec: 4, fps: 25, hasAudio: true } };
  const clip = { source: { assetId: 'a', relativePath: 'video/a.mp4' }, inSec: 0, outSec: 2, transitionAfter: { type: 'crossfade', durationSec: 0.4 } };
  const plan = buildRenderPlan({ clips: [clip, clip, clip] }, [source, source, source]);
  assert.ok(Math.abs(plan.durationSec - 5.2) < 0.00001);
  assert.equal(plan.pieces.length, 5);
  assert.equal(plan.bgmVolume, 0.16);
  assert.equal(plan.ducking, true);
  assert.throws(() => buildRenderPlan({ clips: [clip, clip], audio: { bgmVolume: 0.9 } }, [source, source]), /背景音乐音量/u);
  assert.throws(() => buildRenderPlan({ clips: [{ ...clip, outSec: 0.2 }, clip] }, [source, source]), /转场过长/u);
  assert.throws(() => buildRenderPlan({ clips: [{ ...clip, inSec: 2, outSec: 1 }] }, [source]), /不足一帧/u);
});

test('missing media tools report a usable error without silent success', async (t) => {
  const { assetRoot, tempRoot } = withFixture(t);
  const service = createVideoWorkbench({ assetRoot, tempRoot, env: { PATH: '' } });
  const status = await service.status();
  assert.equal(status.available, false);
  await assert.rejects(service.probe({ assetId: 'x', relativePath: 'video/x.mp4' }), /FFmpeg/u);
});

test('desktop bridge exposes only trusted managed-media operations and removable progress listeners', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
  for (const channel of ['video-workbench-status', 'probe-workbench-video', 'extract-workbench-frames', 'render-workbench-timeline', 'cancel-workbench-job']) {
    assert.ok(main.includes(`handleTrustedIpc('lianhua:${channel}'`));
    assert.ok(preload.includes(`invoke('lianhua:${channel}'`));
  }
  assert.ok(preload.includes("removeListener('lianhua:workbench-progress'"));
  assert.ok(main.includes('videoWorkbench?.close()'));
});

test('real media: first/last/custom/uniform frame extraction persists real PNGs without changing source', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, tempRoot, service } = withFixture(t);
  const source = await videoFixture(assetRoot, 'red', 'red');
  const before = fs.readFileSync(path.join(assetRoot, source.relativePath));
  const probe = await service.probe(source);
  assert.equal(probe.width, 160);
  assert.equal(probe.fps, 10);
  const progress = [];
  const boundaries = await service.extractFrames({ projectId: 'p', jobId: 'boundary', source, mode: 'boundaries', fileName: '第3段参考' }, 1, (event) => progress.push(event));
  assert.equal(boundaries.frames.length, 2);
  assert.equal(boundaries.frames[0].timeSec, 0);
  assert.equal(boundaries.frames[1].frameIndex, 11);
  assert.ok(Math.abs(boundaries.frames[1].timeSec - 1.1) < 0.00001);
  assert.equal(boundaries.frames[0].fileName, '第3段参考·首帧·000001(0.000s).png');
  assert.equal(boundaries.frames[1].fileName, '第3段参考·尾帧·000012(1.100s).png');
  for (const frame of boundaries.frames) {
    assert.equal(frame.width, 160); assert.equal(frame.height, 96);
    assert.equal(fs.readFileSync(path.join(assetRoot, frame.relativePath)).subarray(1, 4).toString('ascii'), 'PNG');
  }
  assert.equal(progress.at(-1).stage, 'completed');
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).projectId, 'p');
  const exact = await service.extractFrames({ projectId: 'p', jobId: 'exact', source, mode: 'frame', frameIndex: 4 }, 1);
  assert.equal(exact.frames[0].timeSec, 0.4);
  const uniform = await service.extractFrames({ projectId: 'p', jobId: 'uniform', source, mode: 'uniform', count: 3, fileName: '统一前缀.png' }, 1);
  assert.equal(uniform.frames.length, 3);
  assert.equal(new Set(uniform.frames.map((frame) => frame.fileName)).size, 3);
  const custom = await service.extractFrames({ projectId: 'p', jobId: 'custom', source, mode: 'time', timeSec: 0.42 }, 1);
  assert.equal(custom.frames[0].timeSec, 0.5);
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, source.relativePath)), before);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('real media: 3 mismatched clips render with hard cuts, silence fallback and intact sources', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, tempRoot, service } = withFixture(t);
  const red = await videoFixture(assetRoot, 'red', 'red', true);
  const blue = await videoFixture(assetRoot, 'blue', 'blue', false, 1.5, '96x160', 12);
  const green = await videoFixture(assetRoot, 'green', 'green', true, 1.2, '128x96', 15);
  const result = await service.renderTimeline({ projectId: 'p', jobId: 'cuts', clips: [red, blue, green].map((source) => ({ source, inSec: 0.2, outSec: 1.2 })), output: { width: 160, height: 96, fps: 10, fileName: '剧情成片.mp4' } }, 1);
  assert.equal(result.fileName, '剧情成片.mp4');
  assert.equal(result.probe.videoCodec, 'h264');
  assert.equal(result.probe.audioCodec, 'aac');
  assert.equal(result.probe.audioSampleRate, 48000);
  assert.ok(Math.abs(result.probe.durationSec - 3) < 0.15, `rendered duration: ${result.probe.durationSec}`);
  assert.equal(result.probe.width, 160);
  for (const source of [red, blue, green]) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assetRoot, source.relativePath))).digest('hex'), source.expectedChecksum);
  const decode = await run(ffmpegPath, ['-v', 'error', '-i', path.join(assetRoot, result.relativePath), '-f', 'null', '-']);
  assert.equal(decode, '');
  const colors = [];
  for (const time of [0.5, 1.5, 2.5]) {
    const pixel = await runBytes(ffmpegPath, ['-v', 'error', '-ss', String(time), '-i', path.join(assetRoot, result.relativePath), '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    colors.push([...pixel]);
  }
  assert.ok(colors[0][0] > colors[0][1] * 3, 'the first clip must stay red');
  assert.ok(colors[1][2] > colors[1][0] * 3, 'the second clip must stay blue, not reordered');
  assert.ok(colors[2][1] > colors[2][2] * 3, 'the third clip must stay green');
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('real media: variable-frame-rate extraction reports decoded frame timestamps, not index divided by average fps', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, service } = withFixture(t);
  const filePath = path.join(assetRoot, 'video', 'variable.mp4');
  await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=10:d=0.5', '-vf', "setpts='if(eq(N,0),0,if(eq(N,1),1,if(eq(N,2),3,if(eq(N,3),6,10))))/(10*TB)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', filePath]);
  const source = { assetId: 'variable', relativePath: 'video/variable.mp4' };
  const exact = await service.extractFrames({ projectId: 'p', jobId: 'vfr', source, mode: 'frame', frameIndex: 3 }, 1);
  assert.ok(Math.abs(exact.frames[0].timeSec - 0.6) < 0.00001);
  assert.equal(exact.frames[0].frameIndex, 3);
  assert.equal(exact.probe.frameCount, 5);
  const last = await service.extractFrames({ projectId: 'p', jobId: 'vfr-last', source, mode: 'last' }, 1);
  assert.ok(Math.abs(last.frames[0].timeSec - 1) < 0.00001, JSON.stringify(last));
});

test('real media: dissolve, video/audio fades, looping BGM and ducking produce an intact synchronized output', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, service } = withFixture(t);
  const red = await videoFixture(assetRoot, 'red', 'red', true, 2);
  const blue = await videoFixture(assetRoot, 'blue', 'blue', false, 2);
  const musicPath = path.join(assetRoot, 'audio', 'music.wav');
  await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.8', musicPath]);
  const result = await service.renderTimeline({ projectId: 'p', jobId: 'dissolve', clips: [
    { source: red, inSec: 0, outSec: 2, transitionAfter: { type: 'crossfade', durationSec: 0.4 }, volume: 0.8 },
    { source: blue, inSec: 0, outSec: 2 },
  ], output: { width: 160, height: 96, fps: 10, fadeInSec: 0.2, fadeOutSec: 0.2 }, audio: { bgm: { assetId: 'music', relativePath: 'audio/music.wav' }, ducking: true, bgmVolume: 0.16, fadeInSec: 0.2, fadeOutSec: 0.2 } }, 1);
  assert.ok(Math.abs(result.probe.durationSec - 3.6) < 0.15);
  assert.equal(result.probe.hasAudio, true);
  assert.equal(result.probe.audioCodec, 'aac');
  await run(ffmpegPath, ['-v', 'error', '-i', path.join(assetRoot, result.relativePath), '-f', 'null', '-']);
  const sample = (time) => runBytes(ffmpegPath, ['-v', 'error', '-ss', String(time), '-i', path.join(assetRoot, result.relativePath), '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const underDialogue = await sample(0.7);
  const duringSilence = await sample(2.7);
  const dialogue = frequencyAmplitude(underDialogue, 440);
  const musicUnderDialogue = frequencyAmplitude(underDialogue, 880);
  const musicDuringSilence = frequencyAmplitude(duringSilence, 880);
  assert.ok(musicUnderDialogue < dialogue * 0.4, 'BGM must remain below original dialogue');
  assert.ok(musicUnderDialogue < musicDuringSilence * 0.85, 'sidechain ducking must attenuate music while original dialogue plays');
});

test('real media: repeated short edits do not accumulate audio/video timestamp drift', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, service } = withFixture(t);
  const source = await videoFixture(assetRoot, 'short', 'red', true, 1, '160x96', 25);
  const result = await service.renderTimeline({ projectId: 'p', jobId: 'many-cuts', clips: Array.from({ length: 12 }, () => ({ source, inSec: 0.15, outSec: 0.38 })), output: { width: 160, height: 96, fps: 30 } }, 1);
  const output = JSON.parse(await run(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', path.join(assetRoot, result.relativePath)]));
  const video = output.streams.find((stream) => stream.codec_type === 'video');
  const audio = output.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(Math.abs(Number(video.duration) - 2.4) < 0.05, `video duration drifted: ${video.duration}`);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.05, `audio duration ${audio.duration} differs from video ${video.duration}`);
  assert.equal(Number(video.nb_frames), 72);
});

test('real media: cancellation is owner-scoped and leaves no half-export or temp directory', { skip: !ffmpegPath || !ffprobePath }, async (t) => {
  const { assetRoot, tempRoot, service } = withFixture(t);
  const source = await videoFixture(assetRoot, 'cancel-source', 'red', true, 3);
  let cancelled = false;
  const progress = [];
  const promise = service.renderTimeline({ projectId: 'p', jobId: 'cancel', clips: [{ source, inSec: 0, outSec: 3 }], output: { width: 160, height: 96, fps: 10 } }, 7, (event) => {
    progress.push(event);
    if (!cancelled && event.stage === 'processing' && event.percent > 2) {
      assert.equal(service.cancel('cancel', 8), false);
      cancelled = true;
      assert.equal(service.cancel('cancel', 7), true);
    }
  });
  await assert.rejects(promise, /已取消/u);
  assert.equal(progress.at(-1).stage, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(assetRoot, 'video')), ['cancel-source.mp4']);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  assert.equal(service.cancel('cancel', 7), false);
});
