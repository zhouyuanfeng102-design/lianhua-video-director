import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createQaProcessHarness,
  findAvailableTcpPort,
  prepareQaOutputDirectory,
} from './qaProcessHarness.mjs';
import { assertLoopbackPortAvailable } from './webQaIsolation.mjs';

const root = process.cwd();
const configuredDirectory = (environmentName, fallback) => path.resolve(
  String(process.env[environmentName] || '').trim() || fallback,
);
const dataDirectory = configuredDirectory('LIANHUA_DATA_DIR', path.join(root, '.qa-electron-data'));
const outputDirectory = configuredDirectory('QA_OUTPUT', path.join(root, '.qa-electron'));
const backupDirectory = configuredDirectory('LIANHUA_QA_BACKUP_DIR', path.join(root, '.qa-external-backup'));
const exportPath = path.join(outputDirectory, 'qa-roundtrip.lhvd');
const savedImagePath = path.join(outputDirectory, 'qa-saved-image.png');
const configuredPortText = process.env.CDP_PORT?.trim();
const configuredPort = configuredPortText ? Number(configuredPortText) : null;
if (configuredPort !== null && (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535)) {
  throw new Error(`Invalid CDP_PORT: ${process.env.CDP_PORT}`);
}
const port = configuredPort ?? await findAvailableTcpPort();
if (configuredPort !== null) await assertLoopbackPortAvailable(configuredPort);

for (const target of [dataDirectory, outputDirectory, backupDirectory]) {
  prepareQaOutputDirectory(target, { workspaceRoot: root });
}

const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const environment = {
  ...process.env,
  LIANHUA_DATA_DIR: dataDirectory,
  LIANHUA_QA_MODE: '1',
  LIANHUA_QA_EXPORT_PATH: exportPath,
  LIANHUA_QA_IMPORT_PATH: exportPath,
  LIANHUA_QA_BACKUP_DIR: backupDirectory,
  LIANHUA_QA_SAVE_MEDIA_PATH: savedImagePath,
  CDP_PORT: String(port),
  QA_OUTPUT: outputDirectory,
};

const electron = spawn(electronExecutable, ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const {
  markElectronStopping,
  qaFailure,
  readElectronLog,
  stopAll,
  trackQaChild,
} = createQaProcessHarness({ electron, qaLabel: 'desktop QA' });

const runScript = (script, extraEnvironment = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...environment, ...extraEnvironment },
    windowsHide: true,
    stdio: 'inherit',
  });
  const closed = trackQaChild(child);
  child.once('error', reject);
  closed.then(({ code }) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
});

try {
  const qaRun = (async () => {
    await runScript('scripts/electronSmoke.mjs');
    await runScript('scripts/videoTaskIpcSmoke.mjs', { QA_OUTPUT: path.join(outputDirectory, 'video-task') });
  })();
  await Promise.race([qaRun, qaFailure]);
} finally {
  markElectronStopping();
  try {
    await stopAll();
  } finally {
    fs.writeFileSync(path.join(outputDirectory, 'electron-process.log'), readElectronLog());
  }
}
