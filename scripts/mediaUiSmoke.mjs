import fs from 'node:fs';
import path from 'node:path';
import { captureOptionalQaArtifact } from './qaArtifacts.mjs';
import { waitForCondition } from './qaProcessHarness.mjs';

const port = Number(process.env.CDP_PORT || 9231);
const outputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-media');
fs.mkdirSync(outputDirectory, { recursive: true });
const videoPath = path.join(outputDirectory, 'probe.webm');
const audioPath = path.join(outputDirectory, 'probe.wav');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);

const writeWav = (filePath) => {
  const sampleRate = 8000;
  const durationSec = 0.5;
  const samples = Math.floor(sampleRate * durationSec);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.35 * 32767);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
};
writeWav(audioPath);

let target;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(connectionTimeoutMs),
    }).then((response) => response.json());
    target = targets.find((item) => item.type === 'page' && item.title?.includes('莲华')) || targets.find((item) => item.type === 'page');
    if (target) break;
  } catch { /* Electron may still be starting. */ }
  await delay(250);
}
if (!target) throw new Error('No Electron target');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const waitForSocketOpen = () => new Promise((resolve, reject) => {
  if (socket.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('error', onError);
    socket.removeEventListener('close', onClose);
  };
  const onOpen = () => { cleanup(); resolve(); };
  const onError = () => { cleanup(); reject(new Error('CDP socket connection failed')); };
  const onClose = () => { cleanup(); reject(new Error('CDP socket closed before opening')); };
  const timer = setTimeout(() => { cleanup(); reject(new Error('CDP socket connection timed out')); }, connectionTimeoutMs);
  socket.addEventListener('open', onOpen, { once: true });
  socket.addEventListener('error', onError, { once: true });
  socket.addEventListener('close', onClose, { once: true });
});
try {
  await waitForSocketOpen();
} catch (error) {
  socket.close();
  throw error;
}
let id = 0;
const commandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_COMMAND_TIMEOUT_MS) || 10_000);
const pending = new Map();
const consoleErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id); pending.delete(message.id);
    globalThis.clearTimeout?.(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text || 'Runtime exception');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((item) => item.value ?? item.description ?? '').join(' '));
});
const failPending = (reason) => {
  const error = reason instanceof Error ? reason : new Error(`CDP socket ${String(reason || 'closed')}`);
  for (const handler of pending.values()) {
    globalThis.clearTimeout?.(handler.timer);
    handler.reject(error);
  }
  pending.clear();
};
socket.addEventListener('close', (event) => failPending(event.reason || 'closed'));
socket.addEventListener('error', (event) => failPending(event.message || 'error'));
const command = (method, params = {}) => new Promise((resolve, reject) => {
  if (typeof WebSocket !== 'undefined' && socket.readyState !== WebSocket.OPEN) {
    reject(new Error('CDP socket is not open'));
    return;
  }
  const commandId = ++id;
  const timer = globalThis.setTimeout?.(() => {
    pending.delete(commandId);
    reject(new Error(`CDP command timed out: ${method}`));
  }, commandTimeoutMs);
  pending.set(commandId, { resolve, reject, timer });
  try {
    socket.send(JSON.stringify({ id: commandId, method, params }));
  } catch (error) {
    globalThis.clearTimeout?.(timer);
    pending.delete(commandId);
    reject(error);
  }
});
const evaluate = async (expression, returnByValue = true) => {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Evaluation failed');
  return returnByValue ? response.result.value : response.result;
};
const waitForMediaRenderer = () => waitForCondition({
  label: 'media renderer',
  timeoutMs: Math.max(1, Number(process.env.MEDIA_APP_READY_TIMEOUT_MS) || 30_000),
  intervalMs: 100,
  check: async () => {
    try {
      return await evaluate(`Boolean(document.querySelector('.app-shell') && window.lianhuaDesktop)`);
    } catch (error) {
      if (/Execution context was destroyed|Cannot find context with specified id/iu.test(String(error?.message || error))) {
        return false;
      }
      throw error;
    }
  },
});
await command('Runtime.enable').catch((error) => {
  failPending(error);
  socket.close();
  throw error;
});
try {
await command('DOM.enable'); await command('Page.enable');
await waitForMediaRenderer();

const videoBase64 = await evaluate(`(async () => {
  const createProbe = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track || typeof track.requestFrame !== 'function') throw new Error('Canvas frame requests are unavailable');
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder failed'));
    });
    try {
      recorder.start(100);
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (let frame = 0; frame < 12; frame += 1) {
        context.fillStyle = frame % 2 ? '#cc3f77' : '#18899a'; context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#ffffff'; context.font = '32px sans-serif'; context.fillText('Lianhua ' + frame, 70, 100);
        track.requestFrame();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      recorder.requestData();
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorder.stop();
      await stopped;
      return new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    } finally {
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((item) => item.stop());
    }
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const bytes = await createProbe();
    if (bytes.length < 1_024) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }
  throw new Error('Generated WebM fixture remained empty after 3 attempts');
})()`);
fs.writeFileSync(videoPath, Buffer.from(videoBase64, 'base64'));

const clickNavigation = async (label) => {
  const clicked = await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(label)}); if(!button)return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Navigation not found: ${label}`);
  await delay(150);
};
const chooseKind = async (value) => {
  const selected = await evaluate(`(() => { const select=document.querySelector('select[aria-label="上传资产类型"]'); if(!select)return false; select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  if (!selected) throw new Error('Asset type select not found');
  await delay(100);
};
const uploadFile = async (filePath, expectedMediaCount) => {
  const fileInput = await evaluate(`document.querySelector('.assets-view input.file-input[type=file]')`, false);
  if (!fileInput.objectId) throw new Error('Asset file input not found');
  const guarded = await evaluate(`(() => {
    const input = document.querySelector('.assets-view input.file-input[type=file]');
    if (!input) return false;
    const stop = (event) => event.stopImmediatePropagation();
    window.__lianhuaMediaQaFileEventGuard = { stop };
    window.addEventListener('input', stop, true);
    window.addEventListener('change', stop, true);
    return true;
  })()`);
  if (!guarded) throw new Error('Asset file input disappeared before file selection');
  await command('DOM.setFileInputFiles', { files: [filePath], objectId: fileInput.objectId });
  const dispatched = await evaluate(`(() => {
    const guard = window.__lianhuaMediaQaFileEventGuard;
    if (guard) {
      window.removeEventListener('input', guard.stop, true);
      window.removeEventListener('change', guard.stop, true);
      delete window.__lianhuaMediaQaFileEventGuard;
    }
    const input = document.querySelector('.assets-view input.file-input[type=file]');
    if (!input) return false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!dispatched) throw new Error('Asset file input disappeared before upload events were dispatched');
  await waitForCondition({
    label: `asset upload ${path.basename(filePath)}`,
    timeoutMs: Math.max(1, Number(process.env.MEDIA_UPLOAD_TIMEOUT_MS) || 36_000),
    intervalMs: 150,
    check: async () => {
      const count = await evaluate(`document.querySelectorAll('.asset-card').length`);
      return count >= expectedMediaCount;
    },
  });
};

await clickNavigation('资产库');
await chooseKind('video');
await uploadFile(videoPath, 3);
await uploadFile(videoPath, 6);
await chooseKind('audio');
await uploadFile(audioPath, 7);
let state;
for (let attempt = 0; attempt < 100; attempt += 1) {
  state = await evaluate(`(async () => JSON.parse(await window.lianhuaDesktop.loadState()))()`);
  const persistedAssets = state?.project?.assets || [];
  const persistedVideos = persistedAssets.filter((asset) => asset.mediaType === 'video');
  const persistedAudio = persistedAssets.find((asset) => asset.mediaType === 'audio');
  const persistedFrames = persistedAssets.filter((asset) => asset.source === 'derived' && ['first-frame', 'last-frame'].includes(asset.referenceRole));
  if (persistedVideos.length === 2 && persistedFrames.length >= 4 && persistedAudio?.durationSec > 0 && persistedAudio?.waveform?.length === 96) break;
  await delay(150);
}
const videos = state.project.assets.filter((asset) => asset.mediaType === 'video');
const audio = state.project.assets.find((asset) => asset.mediaType === 'audio');
const derived = state.project.assets.filter((asset) => asset.source === 'derived');
const screenshotError = await captureOptionalQaArtifact('Media screenshot', async () => {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(outputDirectory, 'assets.png'), Buffer.from(screenshot.data, 'base64'));
});
const report = {
  videoFileBytes: fs.statSync(videoPath).size,
  audioFileBytes: fs.statSync(audioPath).size,
  videoCount: videos.length,
  sameChecksum: videos.length === 2 && videos[0].checksum === videos[1].checksum,
  videosManaged: videos.every((asset) => asset.managed && asset.relativePath && asset.durationSec > 0 && asset.width === 320 && asset.height === 180),
  boundaryFrames: derived.filter((asset) => ['first-frame', 'last-frame'].includes(asset.referenceRole)).length,
  audioAnalyzed: Boolean(audio?.managed && audio?.relativePath && audio.durationSec > 0 && audio.sampleRate === 8000 && audio.channelCount === 1 && audio.waveform?.length === 96),
  videoElements: await evaluate(`document.querySelectorAll('.asset-card video').length`),
  videoThumbnails: await evaluate(`document.querySelectorAll('.asset-card .asset-video-thumbnail').length`),
  audioElements: await evaluate(`document.querySelectorAll('.asset-card audio').length`),
  duplicateLabels: await evaluate(`[...document.querySelectorAll('.asset-card small')].filter((item)=>item.textContent.includes('重复内容')).length`),
  remoteImageLabels: await evaluate(`[...document.querySelectorAll('.asset-card small')].filter((item)=>item.textContent.includes('远程图片地址已记录')).length`),
  overflowX: await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`),
  consoleErrors,
  screenshotError,
};
fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
const failed = Object.entries({ sameChecksum: report.sameChecksum, videosManaged: report.videosManaged, enoughBoundaryFrames: report.boundaryFrames >= 4, audioAnalyzed: report.audioAnalyzed, videoPreview: report.videoElements === 0 && report.videoThumbnails >= 2, audioPreview: report.audioElements >= 1, duplicateDetected: report.duplicateLabels >= 1, managedMediaNotRemote: report.remoteImageLabels === 0, noOverflow: !report.overflowX, noConsoleErrors: consoleErrors.length === 0 }).filter(([, value]) => !value).map(([key]) => key);
if (failed.length) throw new Error(`Media smoke failed: ${failed.join(', ')}\n${JSON.stringify(report, null, 2)}`);
console.log(JSON.stringify(report, null, 2));
} finally {
  failPending('media smoke finished');
  socket.close();
}
