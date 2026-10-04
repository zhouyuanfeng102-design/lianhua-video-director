import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createQaProcessHarness,
  findAvailableTcpPort,
  waitForCondition,
} from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const externalUrl = process.env.QA_URL?.trim();
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(root, 'output', 'playwright', 'sequence-ui'));
const positiveTimeout = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};
const parsePort = (value) => {
  if (value === undefined || value.trim() === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('QA_APP_PORT must be a valid TCP port');
  }
  return port;
};
const runQaScript = (environment, trackQaChild) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'sequenceUiQa.mjs')], {
    cwd: root,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: 'inherit',
  });
  const closed = trackQaChild(child);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    closed.then(({ code, signal }) => {
      if (code === 0) resolve();
      else reject(new Error(`sequenceUiQa.mjs exited with code=${code}, signal=${signal || 'none'}`));
    });
  });
};

if (externalUrl) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'sequenceUiQa.mjs')], {
    cwd: root,
    env: { ...process.env, QA_URL: externalUrl },
    windowsHide: true,
    stdio: 'inherit',
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (closedCode, closedSignal) => resolve({ code: closedCode, signal: closedSignal }));
  });
  if (code !== 0) throw new Error(`sequenceUiQa.mjs exited with code=${code}, signal=${signal || 'none'}`);
} else {
  const appPort = parsePort(process.env.QA_APP_PORT) ?? await findAvailableTcpPort();
  const baseUrl = `http://127.0.0.1:${appPort}/`;
  const startupTimeoutMs = positiveTimeout(process.env.QA_STARTUP_TIMEOUT_MS, 30_000);
  const runTimeoutMs = positiveTimeout(process.env.QA_RUN_TIMEOUT_MS, 300_000);
  const vite = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(appPort),
      '--strictPort',
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const {
    markElectronStopping,
    qaFailure,
    readElectronLog,
    stopAll,
    trackQaChild,
  } = createQaProcessHarness({
    electron: vite,
    closeTimeoutMs: positiveTimeout(process.env.QA_CLOSE_TIMEOUT_MS, 10_000),
    qaLabel: 'sequence UI QA',
    runTimeoutMs,
  });

  let runError;
  try {
    await Promise.race([
      waitForCondition({
        label: 'sequence UI Vite startup',
        timeoutMs: startupTimeoutMs,
        intervalMs: 100,
        check: async (remainingMs) => {
          try {
            const response = await fetch(baseUrl, {
              signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remainingMs))),
            });
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      qaFailure,
    ]);
    await Promise.race([
      runQaScript({ QA_URL: baseUrl }, trackQaChild),
      qaFailure,
    ]);
  } catch (error) {
    runError = error;
  }

  markElectronStopping();
  let cleanupError;
  try {
    await stopAll();
  } catch (error) {
    cleanupError = error;
  }
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), readElectronLog());
  } catch (error) {
    cleanupError = cleanupError
      ? new AggregateError([cleanupError, error], 'sequence UI QA cleanup failed')
      : error;
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], 'sequence UI QA run and cleanup failed');
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
}
