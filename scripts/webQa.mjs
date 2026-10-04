import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  createQaProcessHarness,
  findAvailableTcpPort,
  prepareQaOutputDirectory,
  waitForCondition,
} from './qaProcessHarness.mjs';
import {
  assertIsolatedBrowserIdentity,
  assertLoopbackPortAvailable,
  cleanupIsolatedBrowser,
  requestVerifiedBrowserClose,
} from './webQaIsolation.mjs';

const root = process.cwd();
const mode = process.argv[2] || 'all';
if (!['ui', 'workflow', 'all'].includes(mode)) throw new Error(`Unknown web QA mode: ${mode}`);

const parsePort = (value, label) => {
  if (value === undefined || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be a valid TCP port`);
  return port;
};
const positiveTimeout = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const configuredAppPort = parsePort(process.env.QA_APP_PORT, 'QA_APP_PORT');
const configuredCdpPort = parsePort(process.env.CDP_PORT, 'CDP_PORT');
const appPort = configuredAppPort || await findAvailableTcpPort();
let cdpPort = configuredCdpPort || await findAvailableTcpPort();
while (!configuredCdpPort && cdpPort === appPort) cdpPort = await findAvailableTcpPort();
if (cdpPort === appPort) throw new Error('QA_APP_PORT and CDP_PORT must be different');
await assertLoopbackPortAvailable(cdpPort);

const baseUrl = `http://127.0.0.1:${appPort}/`;
const runId = randomUUID();
const runToken = `lianhua-${process.pid}-${runId}`;
const browserTargetUrl = `${baseUrl}?qaRun=${encodeURIComponent(runToken)}`;
const browserData = path.join(os.tmpdir(), `lianhua-edge-qa-${process.pid}-${mode}-${runId}`);
const connectionTimeoutMs = positiveTimeout(process.env.CDP_CONNECTION_TIMEOUT_MS, 2_000);
const browserCommandTimeoutMs = positiveTimeout(process.env.CDP_COMMAND_TIMEOUT_MS, 5_000);
const startupTimeoutMs = positiveTimeout(process.env.QA_STARTUP_TIMEOUT_MS, 30_000);
const qaScriptTimeoutMs = positiveTimeout(process.env.QA_SCRIPT_TIMEOUT_MS, 120_000);
const runTimeoutMs = positiveTimeout(
  process.env.QA_RUN_TIMEOUT_MS,
  Math.max(300_000, qaScriptTimeoutMs * 3 + startupTimeoutMs * 2),
);

const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : '',
];
const edgeExecutable = edgeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
if (!edgeExecutable) throw new Error('Microsoft Edge was not found');
prepareQaOutputDirectory(browserData, { workspaceRoot: root });

let vite;
try {
  vite = spawn(
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
} catch (error) {
  fs.rmSync(browserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  throw error;
}

const {
  markElectronStopping,
  qaFailure,
  readElectronLog,
  stopAll,
  trackQaChild,
} = createQaProcessHarness({
  electron: vite,
  closeTimeoutMs: positiveTimeout(process.env.QA_CLOSE_TIMEOUT_MS, 10_000),
  qaLabel: 'web QA',
  runTimeoutMs,
});

const runScript = (script, environment) => {
  if (environment.QA_OUTPUT) {
    prepareQaOutputDirectory(environment.QA_OUTPUT, { workspaceRoot: root });
  }
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: 'inherit',
  });
  const closed = trackQaChild(child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`${script} timed out after ${qaScriptTimeoutMs}ms`)),
      qaScriptTimeoutMs,
    );
    child.once('error', finish);
    closed.then(({ code, signal }) => {
      if (code === 0) finish();
      else finish(new Error(`${script} exited with code=${code}, signal=${signal || 'none'}`));
    });
  });
};

const waitForVite = () => waitForCondition({
  label: 'Vite startup',
  timeoutMs: startupTimeoutMs,
  intervalMs: 150,
  check: async (remainingMs) => {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(connectionTimeoutMs, remainingMs))),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
});

const withBrowserCdp = async (webSocketDebuggerUrl, operation) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let commandId = 0;
  const failPending = (error, { disconnected = false } = {}) => {
    for (const handler of pending.values()) {
      clearTimeout(handler.timer);
      if (disconnected && handler.allowDisconnect) handler.resolve({});
      else handler.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      failPending(new Error('Isolated Edge returned malformed CDP data'));
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    failPending(new Error('Isolated Edge CDP socket closed'), { disconnected: true });
  });
  socket.addEventListener('error', () => {
    failPending(new Error('Isolated Edge CDP socket failed'));
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error('Isolated Edge CDP connection failed'));
    const onClose = () => finish(new Error('Isolated Edge CDP socket closed before opening'));
    const timer = setTimeout(
      () => finish(new Error('Isolated Edge CDP connection timed out')),
      connectionTimeoutMs,
    );
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  });

  const command = (method, params = {}, { allowDisconnect = false } = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Isolated Edge CDP socket is not open'));
      return;
    }
    const id = ++commandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Isolated Edge CDP command timed out: ${method}`));
    }, browserCommandTimeoutMs);
    pending.set(id, { allowDisconnect, reject, resolve, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  try {
    return await operation(command);
  } finally {
    failPending(new Error('Isolated Edge CDP session finished'));
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
};

const verifyIsolatedBrowserIdentity = (webSocketDebuggerUrl) => withBrowserCdp(
  webSocketDebuggerUrl,
  async (command) => {
    const commandLine = await command('Browser.getBrowserCommandLine');
    assertIsolatedBrowserIdentity(commandLine?.arguments, { browserData, cdpPort });
  },
);

let isolatedBrowserEndpoint;
const closeIsolatedBrowser = async () => {
  if (!isolatedBrowserEndpoint) return;
  await withBrowserCdp(
    isolatedBrowserEndpoint,
    (command) => requestVerifiedBrowserClose({
      browserData,
      browserCloseMethod: 'Browser.close',
      cdpPort,
      command,
    }),
  );
};

const stopIsolatedEdgeByProfile = () => {
  if (process.platform !== 'win32') return;
  const cleanupScript = String.raw`
$ErrorActionPreference = 'Stop'
$expectedExecutable = [IO.Path]::GetFullPath($env:LIANHUA_QA_EDGE_EXECUTABLE)
$expectedProfile = [IO.Path]::GetFullPath($env:LIANHUA_QA_EDGE_PROFILE)
$profilePattern = '(?i)(?:^|\s)"?--user-data-dir(?:=|\s+)"?' + [regex]::Escape($expectedProfile) + '"?(?:\s|$)'
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $browserProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $_.CommandLine -and
    [String]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match $profilePattern
  })
  if ($browserProcesses.Count -eq 0) { exit 0 }
  foreach ($browserProcess in $browserProcesses) {
    Stop-Process -Id $browserProcess.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 100
}
exit 2
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cleanupScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIANHUA_QA_EDGE_EXECUTABLE: edgeExecutable,
        LIANHUA_QA_EDGE_PROFILE: browserData,
      },
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status === 2) throw new Error('isolated Edge profile processes still running');
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`Failed to stop isolated Edge profile: ${detail}`);
  }
};

let edge;
let stopping = false;
let runError;
try {
  await Promise.race([waitForVite(), qaFailure]);

  edge = spawn(
    edgeExecutable,
    [
      '--headless=new',
      '--enable-automation',
      '--disable-gpu',
      '--no-first-run',
      '--disable-background-networking',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${browserData}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  const edgeClosed = trackQaChild(edge);
  const edgeSpawnFailure = new Promise((_, reject) => edge.once('error', reject));
  const edgeFailure = new Promise((_, reject) => {
    edgeClosed.then(({ code, signal }) => {
      if (!stopping && (code !== 0 || signal)) {
        reject(new Error(`Edge exited before web QA completed (code=${code}, signal=${signal || 'none'})`));
      }
    });
  });
  const guard = (promise) => Promise.race([promise, qaFailure, edgeSpawnFailure, edgeFailure]);

  let browserEndpoint;
  await guard(waitForCondition({
    label: 'Edge debugging service startup',
    timeoutMs: startupTimeoutMs,
    intervalMs: 150,
    check: async (remainingMs) => {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(connectionTimeoutMs, remainingMs))),
        });
        if (!response.ok) return false;
        const versionInfo = await response.json();
        if (!versionInfo?.webSocketDebuggerUrl) return false;
        browserEndpoint = versionInfo.webSocketDebuggerUrl;
        return true;
      } catch {
        return false;
      }
    },
  }));
  await guard(verifyIsolatedBrowserIdentity(browserEndpoint));
  isolatedBrowserEndpoint = browserEndpoint;

  let browserTarget;
  await guard(waitForCondition({
    label: 'isolated Edge target creation',
    timeoutMs: startupTimeoutMs,
    intervalMs: 150,
    check: async (remainingMs) => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(browserTargetUrl)}`,
          {
            method: 'PUT',
            signal: AbortSignal.timeout(Math.max(1, Math.min(connectionTimeoutMs, remainingMs))),
          },
        );
        if (!response.ok) return false;
        const createdTarget = await response.json();
        if (createdTarget?.type !== 'page' || !createdTarget.id) return false;
        browserTarget = createdTarget;
        return true;
      } catch {
        return false;
      }
    },
  }));

  await guard(waitForCondition({
    label: 'isolated Edge application target',
    timeoutMs: startupTimeoutMs,
    intervalMs: 150,
    check: async (remainingMs) => {
      try {
        const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(connectionTimeoutMs, remainingMs))),
        }).then((response) => response.json());
        const currentTarget = targets.find((item) => item.id === browserTarget.id);
        if (!currentTarget || currentTarget.url !== browserTargetUrl) return false;
        browserTarget = currentTarget;
        return Boolean(currentTarget.title);
      } catch {
        return false;
      }
    },
  }));

  const common = {
    APP_URL: baseUrl,
    CDP_PORT: String(cdpPort),
    QA_TARGET_ID: browserTarget.id,
    QA_TARGET_URL: browserTargetUrl,
  };
  if (mode === 'ui' || mode === 'all') {
    await guard(runScript('scripts/uiSmoke.mjs', {
      ...common,
      QA_OUTPUT: path.join(root, '.qa-ui-final'),
      VIEWPORT_HEIGHT: '800',
      VIEWPORT_WIDTH: '1280',
    }));
    await guard(runScript('scripts/uiSmoke.mjs', {
      ...common,
      QA_OUTPUT: path.join(root, '.qa-ui-1280x720-final'),
      VIEWPORT_HEIGHT: '720',
      VIEWPORT_WIDTH: '1280',
    }));
    await guard(runScript('scripts/uiSmoke.mjs', {
      ...common,
      QA_OUTPUT: path.join(root, '.qa-ui-1120-final'),
      VIEWPORT_HEIGHT: '720',
      VIEWPORT_WIDTH: '1120',
    }));
    await guard(runScript('scripts/uiSmoke.mjs', {
      ...common,
      QA_OUTPUT: path.join(root, '.qa-ui-high-dpi-final'),
      VIEWPORT_HEIGHT: '800',
      VIEWPORT_WIDTH: '1280',
      DEVICE_SCALE_FACTOR: '2.25',
    }));
  }
  if (mode === 'workflow' || mode === 'all') {
    if (mode === 'workflow') {
      await guard(runScript('scripts/uiSmoke.mjs', {
        ...common,
        QA_BOOTSTRAP_ONLY: '1',
        QA_OUTPUT: path.join(root, '.qa-workflow-final'),
        VIEWPORT_HEIGHT: '800',
        VIEWPORT_WIDTH: '1280',
      }));
    }
    await guard(runScript('scripts/workflowUiSmoke.mjs', {
      ...common,
      QA_OUTPUT: path.join(root, '.qa-workflow-final'),
    }));
  }
} catch (error) {
  runError = error;
}

stopping = true;
markElectronStopping();
let cleanupError;
try {
  await cleanupIsolatedBrowser({
    closeBrowser: closeIsolatedBrowser,
    stopBrowserByProfile: stopIsolatedEdgeByProfile,
  });
} catch (error) {
  cleanupError = error;
}
try {
  await stopAll();
} catch (error) {
  cleanupError = cleanupError
    ? new AggregateError([cleanupError, error], 'web QA process cleanup failed')
    : error;
}
try {
  fs.rmSync(browserData, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  fs.writeFileSync(path.join(root, `.qa-vite-${mode}.log`), readElectronLog());
} catch (error) {
  cleanupError = cleanupError
    ? new AggregateError([cleanupError, error], 'web QA cleanup failed')
    : error;
}

if (runError && cleanupError) {
  throw new AggregateError([runError, cleanupError], 'web QA run and cleanup failed');
}
if (runError) throw runError;
if (cleanupError) throw cleanupError;
