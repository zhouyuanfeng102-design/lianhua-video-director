import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const normalizedPath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const isPathInside = (parent, target) => {
  const relative = path.relative(parent, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const isSamePath = (left, right) => normalizedPath(left) === normalizedPath(right);

const isSameOrInside = (parent, target) => isSamePath(parent, target) || isPathInside(parent, target);

const tryLstat = (value) => {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const tryRealpath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const pathComponentsFrom = (ancestor, target) => {
  const relative = path.relative(ancestor, target);
  if (!relative) return [ancestor];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const components = [ancestor];
  let current = ancestor;
  for (const name of relative.split(path.sep)) {
    current = path.join(current, name);
    components.push(current);
  }
  return components;
};

const assertUnlinkedManagedPath = ({ allowedBase, allowedRoot, target }) => {
  const canonicalBase = tryRealpath(allowedBase);
  const components = pathComponentsFrom(allowedRoot, target);
  if (!canonicalBase || components.length === 0) throw new Error(`Unsafe QA output directory: ${target}`);

  const canonicalAllowedRoot = path.resolve(
    canonicalBase,
    path.relative(allowedBase, allowedRoot),
  );
  if (!isSameOrInside(canonicalBase, canonicalAllowedRoot)) {
    throw new Error(`Unsafe QA output directory: ${target}`);
  }

  for (const component of components) {
    const stats = tryLstat(component);
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new Error(`Unsafe QA output directory: ${target}`);

    const canonicalComponent = tryRealpath(component);
    const expectedComponent = path.resolve(
      canonicalBase,
      path.relative(allowedBase, component),
    );
    if (
      !canonicalComponent
      || !isSamePath(canonicalComponent, expectedComponent)
      || !isSameOrInside(canonicalAllowedRoot, canonicalComponent)
    ) {
      throw new Error(`Unsafe QA output directory: ${target}`);
    }
  }
};

export const prepareQaOutputDirectory = (
  requestedPath,
  {
    homeDirectory = os.homedir(),
    tempRoot = os.tmpdir(),
    workspaceRoot = process.cwd(),
  } = {},
) => {
  const target = path.resolve(String(requestedPath || ''));
  const workspace = path.resolve(workspaceRoot);
  const temporary = path.resolve(tempRoot);
  const forbidden = [path.parse(target).root, homeDirectory, workspace].map(normalizedPath);
  const normalizedTarget = normalizedPath(target);
  const workspaceRelative = path.relative(workspace, target);
  const temporaryRelative = path.relative(temporary, target);
  const temporaryName = temporaryRelative.split(path.sep)[0] || '';
  const workspaceQaDirectory = isPathInside(workspace, target)
    && workspaceRelative.split(path.sep)[0]?.startsWith('.qa-');
  const temporaryQaDirectory = !isPathInside(workspace, target)
    && isPathInside(temporary, target)
    && /^(?:lianhua-(?:edge-qa|qa|ui-smoke-output))-/.test(temporaryName);
  const targetContainsWorkspace = isSameOrInside(target, workspace);
  const allowedBase = workspaceQaDirectory ? workspace : temporary;
  const allowedRoot = workspaceQaDirectory
    ? path.join(workspace, workspaceRelative.split(path.sep)[0])
    : path.join(temporary, temporaryName);

  if (
    forbidden.includes(normalizedTarget)
    || (!workspaceQaDirectory && !temporaryQaDirectory)
    || targetContainsWorkspace
  ) {
    throw new Error(`Unsafe QA output directory: ${target}`);
  }

  assertUnlinkedManagedPath({ allowedBase, allowedRoot, target });
  const canonicalWorkspace = tryRealpath(workspace);
  const canonicalTarget = tryRealpath(target);
  if (canonicalWorkspace && canonicalTarget && isSameOrInside(canonicalTarget, canonicalWorkspace)) {
    throw new Error(`Unsafe QA output directory: ${target}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  assertUnlinkedManagedPath({ allowedBase, allowedRoot, target });
  return target;
};

export const waitForCondition = async ({
  check,
  intervalMs = 100,
  label = 'condition',
  timeoutMs,
}) => {
  const numericTimeout = Number(timeoutMs);
  const normalizedTimeoutMs = Number.isFinite(numericTimeout) && numericTimeout > 0
    ? numericTimeout
    : 1;
  const numericInterval = Number(intervalMs);
  const normalizedIntervalMs = Number.isFinite(numericInterval) && numericInterval >= 0
    ? numericInterval
    : 100;
  const deadline = Date.now() + normalizedTimeoutMs;
  const timeoutError = () => new Error(`${label} timed out after ${normalizedTimeoutMs}ms`);

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    let timer;
    try {
      const matched = await Promise.race([
        Promise.resolve().then(() => check(remainingMs)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remainingMs);
        }),
      ]);
      if (matched) return true;
    } finally {
      clearTimeout(timer);
    }

    const pauseMs = Math.min(normalizedIntervalMs, deadline - Date.now());
    if (pauseMs <= 0) throw timeoutError();
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
};

export const findAvailableTcpPort = (host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => {
      if (error) reject(error);
      else if (!port) reject(new Error('Failed to allocate a QA TCP port'));
      else resolve(port);
    });
  });
});

const killWindowsProcessTree = (child) => {
  return spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
};

const waitWithTimeout = (promise, timeoutMilliseconds, label) => new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error(`${label} did not close within ${timeoutMilliseconds}ms`)),
    timeoutMilliseconds,
  );
  promise.then((value) => {
    clearTimeout(timeout);
    resolve(value);
  }, (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

const requestProcessStop = (child, killProcessTree) => {
  let result;
  try {
    result = killProcessTree(child);
  } catch {
    result = null;
  }
  if (result?.status === 0 && !result.error) return;
  try { child.kill?.('SIGKILL'); } catch { /* close timeout reports the failed cleanup */ }
};

export const createQaProcessHarness = ({
  electron,
  qaLabel,
  closeTimeoutMs = 3000,
  runTimeoutMs = Number(process.env.QA_RUN_TIMEOUT_MS) || 300_000,
  killProcessTree = killWindowsProcessTree,
  signalSource = process,
}) => {
  let electronLog = '';
  let stoppingElectron = false;
  let rejectQaFailure;
  let runTimer;
  let qaFailureSettled = false;
  const qaFailure = new Promise((_, reject) => { rejectQaFailure = reject; });
  const failQa = (error) => {
    if (qaFailureSettled) return;
    qaFailureSettled = true;
    clearTimeout(runTimer);
    rejectQaFailure(error);
  };
  const normalizedRunTimeoutMs = Math.max(1, Number(runTimeoutMs) || 300_000);
  runTimer = setTimeout(
    () => failQa(new Error(`${qaLabel} timed out after ${normalizedRunTimeoutMs}ms`)),
    normalizedRunTimeoutMs,
  );
  runTimer.unref?.();
  const signalHandlers = new Map();
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      const error = new Error(`${qaLabel} interrupted by ${signal}`);
      error.signal = signal;
      error.exitCode = exitCode;
      failQa(error);
    };
    signalHandlers.set(signal, handler);
    signalSource.once(signal, handler);
  }
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) signalSource.removeListener(signal, handler);
    signalHandlers.clear();
  };
  let electronDidClose = false;
  const electronClosed = new Promise((resolve) => {
    electron.once('close', (...args) => {
      electronDidClose = true;
      resolve(args);
    });
  });

  electron.once('error', (error) => {
    electronLog += `[electron spawn error] ${error.stack || error.message || String(error)}\n`;
    failQa(error);
  });
  electron.once('exit', (code, signal) => {
    if (stoppingElectron) return;
    const error = new Error(`Electron exited before ${qaLabel} completed (code=${code}, signal=${signal || 'none'})`);
    electronLog += `[electron exit] ${error.message}\n`;
    failQa(error);
  });
  electron.stdout?.on('data', (chunk) => { electronLog += chunk; });
  electron.stderr?.on('data', (chunk) => { electronLog += chunk; });

  const waitForElectronClose = () => electronDidClose
    ? Promise.resolve()
    : waitWithTimeout(electronClosed, closeTimeoutMs, 'Electron');
  const stopElectron = async () => {
    if (electron.pid && electron.exitCode === null && electron.signalCode === null) {
      requestProcessStop(electron, killProcessTree);
    }
    await waitForElectronClose();
  };

  const activeQaChildren = new Map();
  const trackQaChild = (child) => {
    const closed = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    activeQaChildren.set(child, closed);
    closed.then(() => activeQaChildren.delete(child));
    return closed;
  };

  const stopQaChildren = async () => {
    const children = [...activeQaChildren.entries()];
    for (const [child] of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) requestProcessStop(child, killProcessTree);
    }
    await Promise.all(children.map(([child, closed]) => waitWithTimeout(closed, closeTimeoutMs, `QA child ${child.pid || 'unknown'}`)));
  };

  const stopAll = async () => {
    const errors = [];
    for (const stop of [stopQaChildren, stopElectron]) {
      try { await stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'QA process cleanup failed');
  };

  return {
    activeQaChildren,
    markElectronStopping: () => {
      stoppingElectron = true;
      clearTimeout(runTimer);
      removeSignalHandlers();
    },
    qaFailure,
    readElectronLog: () => electronLog,
    stopAll,
    stopElectron,
    stopQaChildren,
    trackQaChild,
    waitForElectronClose,
  };
};
