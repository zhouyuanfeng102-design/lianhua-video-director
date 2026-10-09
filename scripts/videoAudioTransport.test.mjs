import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { decodeReferenceAudioDataUrl, readManagedAudioDataUrl } = require('../electron/audioReferenceTransport.cjs');
const { videoRequestOptions } = require('../electron/videoTransport.cjs');
const { createVideoTaskCheckpointJournal, collectVideoFrozenAssets } = require('../electron/videoTaskCheckpoint.cjs');
const wav = () => {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(200, 44);
  return bytes;
};
const data = (bytes, type = 'wav') => `data:audio/${type};base64,${bytes.toString('base64')}`;
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-audio-mock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('audio container validation preserves exact WAV/MP3/FLAC bytes and rejects truncation, disguised image and oversized payloads', () => {
  const mp3 = Buffer.alloc(417); mp3.set([255, 251, 144, 0]);
  const flac = Buffer.alloc(48); flac.write('fLaC'); flac[4] = 128; flac[7] = 34; flac.set([255, 248], 42);
  for (const [bytes, extension] of [[wav(), '.wav'], [mp3, '.mp3'], [flac, '.flac']]) {
    const decoded = decodeReferenceAudioDataUrl(data(bytes, 'mpeg'));
    assert.equal(decoded.extension, extension, 'actual bytes determine the upload extension');
    assert.deepEqual(decoded.bytes, bytes);
  }
  for (const bytes of [wav().subarray(0, 46), mp3.subarray(0, 416), Buffer.from('ID3 only metadata'), Buffer.from('not audio')]) {
    assert.throws(() => decodeReferenceAudioDataUrl(data(bytes)), /截断|有效/u);
  }
  assert.throws(() => decodeReferenceAudioDataUrl('data:image/png;base64,AAAA'), /audio/u);
  assert.throws(() => decodeReferenceAudioDataUrl(data(wav()).slice(0, -1) + '!'), /Base64/u);
  assert.throws(() => decodeReferenceAudioDataUrl(data(wav()), 48), /上传限制/u);
});

test('managed reads enforce immutable checksums, audio containers and asset-root paths', (t) => {
  const directory = temporary(t), bytes = wav();
  fs.mkdirSync(path.join(directory, 'audio')); fs.writeFileSync(path.join(directory, 'audio', 'sample.wav'), bytes);
  const payload = { assetRoot: directory, relativePath: 'audio/sample.wav', expectedChecksum: checksum(bytes) };
  assert.equal(readManagedAudioDataUrl(payload).dataUrl, data(bytes));
  assert.throws(() => readManagedAudioDataUrl({ ...payload, expectedChecksum: 'a'.repeat(64) }), /校验失败/u);
  assert.throws(() => readManagedAudioDataUrl({ ...payload, relativePath: '../outside.wav' }), /越界/u);
  assert.throws(() => readManagedAudioDataUrl({ ...payload, relativePath: 'C:/outside.wav' }), /相对路径|越界/u);
  fs.writeFileSync(path.join(directory, 'audio', 'sample.wav'), bytes.subarray(0, 44));
  assert.throws(() => readManagedAudioDataUrl(payload), /有效|截断/u);
});

test('desktop multipart uploads use file, real MIME/extension, exact bytes and safe names', () => {
  const bytes = wav();
  const request = videoRequestOptions({ method: 'POST', multipart: { files: [{ fieldName: 'file', fileName: '声线\r\nX-Injected: bad.mp3', dataUrl: data(bytes, 'mpeg') }] } });
  assert.equal(request.noTimeout, true);
  assert.match(request.body.toString(), /name="file"; filename="[^"\r\n]*\.wav"/u);
  assert.match(request.body.toString(), /Content-Type: audio\/wav/u);
  assert.ok(request.body.includes(bytes));
  assert.doesNotMatch(request.body.toString(), /\r\nX-Injected:/u);
});

test('desktop audio freezing creates content-addressed audio assets without exposing an image result', async (t) => {
  const directory = temporary(t);
  const mainPath = path.resolve(import.meta.dirname, '../electron/main.cjs'), mainRequire = createRequire(mainPath);
  const paths = { userData: path.join(directory, 'legacy') };
  const electron = { app: { getPath: (name) => paths[name] || path.join(directory, name), setPath: (name, value) => { paths[name] = value; }, setAppLogsPath() {} },
    BrowserWindow: class {}, dialog: {}, ipcMain: {}, net: {}, shell: {}, protocol: { registerSchemesAsPrivileged() {} },
    safeStorage: { isEncryptionAvailable: () => false } };
  const context = vm.createContext({ AbortController, Buffer, URL, Response, console, setTimeout, clearTimeout,
    process: { argv: ['node', mainPath], env: { ...process.env, LIANHUA_DATA_DIR: path.join(directory, 'data') }, execPath: process.execPath, platform: process.platform, pid: process.pid },
    require: (specifier) => specifier === 'electron' ? electron : mainRequire(specifier), __dirname: path.dirname(mainPath), __filename: mainPath });
  const source = fs.readFileSync(mainPath, 'utf8');
  vm.runInContext(`${source.slice(0, source.indexOf("if (process.platform === 'win32')"))}\n;globalThis.harness={storeGeneratedAudioInAssetStore,readManagedAudioDataUrlForRenderer,assetRoot};`, context);
  const h = context.harness, bytes = wav();
  const asset = await h.storeGeneratedAudioInAssetStore({ dataUrl: data(bytes), fileName: '人物声线.mp3' });
  assert.equal(asset.mediaType, 'audio'); assert.equal(asset.mimeType, 'audio/wav'); assert.equal(asset.checksum, checksum(bytes));
  assert.equal(asset.relativePath, `audio/${checksum(bytes)}.wav`); assert.equal(asset.fileName, '人物声线.wav');
  assert.deepEqual(fs.readFileSync(path.join(h.assetRoot, asset.relativePath)), bytes);
  assert.equal(h.readManagedAudioDataUrlForRenderer({ relativePath: asset.relativePath, expectedChecksum: asset.checksum }).dataUrl, data(bytes));
  assert.equal((await h.storeGeneratedAudioInAssetStore({ dataUrl: data(bytes), fileName: '旁白.wav' })).relativePath, asset.relativePath);
  await assert.rejects(() => h.storeGeneratedAudioInAssetStore({ dataUrl: 'data:audio/wav;base64,AAAA' }), /有效|截断/u);
});

const audioTask = () => {
  const reference = { bindingId: '["144","audio"]', assetId: 'audio-A', slotIndex: 0, target: { kind: 'voiceover' }, retainMode: 'weak_reference' };
  return { id: 'video_audio_fixed', kind: 'video', createdAt: 12, status: 'submitting', requestBody: {},
    videoJob: { stage: 'preparing', preparation: { version: 1, phase: 'preparing', uploadedImages: [], uploadedAudios: [] },
      snapshot: { projectId: 'project-A', connection: { backend: 'api', api: { provider: 'runninghub', endpoint: 'https://mock.invalid/run' } },
        draft: { audioReferences: [reference] }, images: [], audios: [{ ...reference, name: '旁白', relativePath: 'audio/frozen.wav', checksum: checksum(wav()), freezeState: 'frozen', frozenAt: 1 }] } } };
};

test('audio journal locks source identity and per-file receipts and preserves irreversible POST boundary', (t) => {
  const directory = temporary(t), journal = createVideoTaskCheckpointJournal({ directory, atomicWriteFile: fs.writeFileSync });
  const task = audioTask(); journal.save(task);
  task.videoJob.preparation.uploadedAudios = ['openapi/frozen.wav']; journal.save(task);
  for (const mutate of [
    (next) => { next.videoJob.snapshot.audios[0].checksum = 'a'.repeat(64); },
    (next) => { next.videoJob.snapshot.audios[0].relativePath = 'audio/replaced.wav'; },
    (next) => { next.videoJob.snapshot.audios[0].target.kind = 'ambience'; next.videoJob.snapshot.draft.audioReferences[0].target.kind = 'ambience'; },
    (next) => { next.videoJob.preparation.uploadedAudios = []; },
    (next) => { next.videoJob.preparation.uploadedAudios = ['https://cdn.invalid/frozen.wav']; },
  ]) { const next = structuredClone(task); mutate(next); assert.throws(() => journal.save(next), /参考音频/u); }
  const posted = structuredClone(task); posted.videoJob.preparation.phase = 'post-started'; journal.save(posted);
  const stale = audioTask(); journal.save(stale);
  assert.equal(journal.get(task.id).videoJob.preparation.phase, 'post-started');
  assert.deepEqual(journal.get(task.id).videoJob.preparation.uploadedAudios, ['openapi/frozen.wav']);
  const legacy = audioTask(); legacy.id = 'video_legacy'; delete legacy.videoJob.snapshot.audios; delete legacy.videoJob.snapshot.draft.audioReferences; delete legacy.videoJob.preparation.uploadedAudios;
  journal.save(legacy); assert.equal(journal.get(legacy.id).videoJob.snapshot.audios, undefined);
});

test('project export collects frozen audio from live tasks and retained asset provenance only within the project', () => {
  const task = audioTask();
  const provenance = structuredClone(task); provenance.id = 'retained-task'; provenance.videoJob.snapshot.audios[0].relativePath = 'audio/retained.wav';
  const other = structuredClone(task); other.id = 'other-task'; other.videoJob.snapshot.projectId = 'other-project'; other.videoJob.snapshot.audios[0].relativePath = 'audio/other.wav';
  const assets = collectVideoFrozenAssets({ id: 'project-A', generationTasks: [task, other], assets: [{ id: 'finished-video', videoSourceTask: provenance }] });
  assert.deepEqual(assets.map((asset) => asset.relativePath).sort(), ['audio/frozen.wav', 'audio/retained.wav']);
  assert.ok(assets.every((asset) => asset.id.startsWith('video-audio-input:') && asset.checksum === checksum(wav())));
});
