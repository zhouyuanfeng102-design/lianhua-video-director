import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// Opt-in real-file QA. Both sample arguments are read-only inputs. All downloads,
// extracted assets, and application state are confined to one fresh temp folder.
// No sample bytes or paths are retained in the repository or in a test fixture.
const root = path.resolve(import.meta.dirname, '..');
const [archiveArgument, videoArgument, sourceArgument] = process.argv.slice(2);
if (!archiveArgument || !videoArgument) {
  throw new Error('Usage: node scripts/videoArchiveSampleQa.mjs <sample.zip> <extracted-video> [source-directory]');
}
const archivePath = fs.realpathSync(archiveArgument);
const videoPath = fs.realpathSync(videoArgument);
const sourceRoot = sourceArgument ? fs.realpathSync(sourceArgument) : root;
const mainPath = path.join(sourceRoot, 'electron', 'main.cjs');
const require = createRequire(mainPath);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-video-archive-sample-'));
const directoryReal = fs.realpathSync(directory);
const hashFile = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const originalHashes = { archive: hashFile(archivePath), video: hashFile(videoPath) };
const ffprobePath = path.join(root, 'build', 'media-tools', 'win32-x64', 'ffprobe.exe');
const probeFile = (filePath) => JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
const compactProbe = (probe) => ({
  duration: Number(probe.format?.duration),
  streams: probe.streams.map(({ codec_type, codec_name, width, height }) => ({ codec_type, codec_name, width, height })),
});
const report = {
  runtime: { node: process.versions.node, electron: process.versions.electron },
  sourceVersion: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version,
  sourceHashes: { main: hashFile(mainPath), archive: hashFile(path.join(sourceRoot, 'electron', 'videoArchive.cjs')) },
  originalHashes,
  originalVideoProbe: compactProbe(probeFile(videoPath)),
  attempts: [],
};
const paths = {};
const electron = {
  app: {
    getPath: (name) => paths[name] || path.join(directory, name),
    setPath: (name, value) => { paths[name] = value; },
    setAppLogsPath() {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: {}, net: {}, shell: {},
  protocol: { registerSchemesAsPrivileged() {} },
  safeStorage: { isEncryptionAvailable: () => false },
};
const context = vm.createContext({
  AbortController, Buffer, URL, Response, console, setTimeout, clearTimeout,
  process: {
    argv: ['node', mainPath],
    env: { ...process.env, LIANHUA_DATA_DIR: path.join(directory, 'data'), LIANHUA_ALLOW_PRIVATE_NETWORK: '1' },
    execPath: process.execPath, platform: process.platform, pid: process.pid,
  },
  require: (specifier) => specifier === 'electron' ? electron : require(specifier),
  __dirname: path.dirname(mainPath), __filename: mainPath,
});
const source = fs.readFileSync(mainPath, 'utf8');
const bootstrapIndex = source.indexOf("if (process.platform === 'win32')");
assert.ok(bootstrapIndex > 0, 'Production main harness must stop before desktop bootstrap');
vm.runInContext(`${source.slice(0, bootstrapIndex)}\n;globalThis.harness={downloadIntoAssetStore,sniffDownloadedMediaExtension,tempRoot,assetRoot};`, context);
const harness = context.harness;
let requestCount = 0;
const server = http.createServer((request, response) => {
  requestCount += 1;
  const selectedPath = request.url === '/source.mp4' ? videoPath : archivePath;
  response.writeHead(200, {
    'Content-Type': request.url === '/source.mp4' ? 'video/mp4' : 'application/zip',
    'Content-Length': String(fs.statSync(selectedPath).size),
  });
  fs.createReadStream(selectedPath).pipe(response);
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  for (const attempt of [
    { name: 'ZIP with explicit provider hint', suffix: '/result.zip', archiveHint: true },
    { name: 'ZIP detected by signature', suffix: '/result.zip', archiveHint: false },
    { name: 'Already-extracted direct MP4 control', suffix: '/source.mp4', archiveHint: false },
  ]) {
    const progress = [];
    try {
      const result = await harness.downloadIntoAssetStore(address + attempt.suffix, {}, {
        noTimeout: true, allowVideoArchive: true, archiveHint: attempt.archiveHint,
        fileName: 'sample-verification', onProgress: (value) => progress.push(value.phase),
      });
      const savedPath = path.join(harness.assetRoot, result.relativePath);
      const savedHash = hashFile(savedPath);
      assert.equal(savedHash, originalHashes.video, 'Imported bytes must equal the manually extracted source exactly');
      assert.equal(result.checksum, originalHashes.video);
      assert.equal(result.mediaType, 'video');
      assert.equal(result.mimeType, 'video/mp4');
      const savedProbe = compactProbe(probeFile(savedPath));
      assert.deepEqual(savedProbe, report.originalVideoProbe);
      report.attempts.push({ name: attempt.name, success: true, checksum: savedHash, result, savedProbe, phases: [...new Set(progress.filter(Boolean))] });
    } catch (error) {
      report.attempts.push({ name: attempt.name, success: false, error: { name: error.name, message: error.message, stack: error.stack }, phases: [...new Set(progress.filter(Boolean))] });
      process.exitCode = 1;
    }
  }
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  report.requestCount = requestCount;
  report.finalHashes = { archive: hashFile(archivePath), video: hashFile(videoPath) };
  assert.deepEqual(report.finalHashes, originalHashes, 'Original files must remain unchanged');
  report.originalFilesUnchanged = true;
  // Never remove an input or a broad directory; only this mkdtemp result.
  assert.equal(fs.realpathSync(directory), directoryReal);
  assert.equal(path.dirname(directoryReal), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(directoryReal).startsWith('lianhua-video-archive-sample-'));
  fs.rmSync(directoryReal, { recursive: true, force: true });
  report.isolatedTemporaryFilesRemoved = true;
  console.log(JSON.stringify(report, null, 2));
}
