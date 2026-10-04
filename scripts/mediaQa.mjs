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
const dataDirectory = configuredDirectory('LIANHUA_DATA_DIR', path.join(root, '.qa-media-data-final'));
const outputDirectory = configuredDirectory('QA_OUTPUT', path.join(root, '.qa-media-final'));
const configuredPortText = process.env.CDP_PORT?.trim();
const configuredPort = configuredPortText ? Number(configuredPortText) : null;
if (configuredPort !== null && (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535)) {
  throw new Error(`Invalid CDP_PORT: ${process.env.CDP_PORT}`);
}
const port = configuredPort ?? await findAvailableTcpPort();
if (configuredPort !== null) await assertLoopbackPortAvailable(configuredPort);
for (const target of [dataDirectory, outputDirectory]) {
  prepareQaOutputDirectory(target, { workspaceRoot: root });
}

const environment = {
  ...process.env,
  LIANHUA_DATA_DIR: dataDirectory,
  CDP_PORT: String(port),
  QA_OUTPUT: outputDirectory,
};
const electron = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${port}`], {
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
} = createQaProcessHarness({ electron, qaLabel: 'media QA' });

try {
  const smoke = spawn(process.execPath, ['scripts/mediaUiSmoke.mjs'], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: 'inherit',
  });
  const smokeClosed = trackQaChild(smoke);
  const smokeRun = new Promise((resolve, reject) => {
    smoke.once('error', reject);
    smokeClosed.then(({ code }) => code === 0 ? resolve() : reject(new Error(`mediaUiSmoke exited with ${code}`)));
  });
  await Promise.race([smokeRun, qaFailure]);
} finally {
  markElectronStopping();
  try {
    await stopAll();
  } finally {
    fs.writeFileSync(path.join(outputDirectory, 'electron-process.log'), readElectronLog());
  }
}
