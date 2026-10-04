import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const webQaSource = fs.readFileSync(path.join(root, 'scripts', 'webQa.mjs'), 'utf8');
const uiSmokeSource = fs.readFileSync(path.join(root, 'scripts', 'uiSmoke.mjs'), 'utf8');
const electronSmokeSource = fs.readFileSync(path.join(root, 'scripts', 'electronSmoke.mjs'), 'utf8');
const qaHarness = await import('./qaProcessHarness.mjs');
const uiSmokeReadiness = await import('./uiSmokeReadiness.mjs')
  .catch((loadError) => ({ loadError }));

test('QA output cleanup rejects dangerous paths and only resets managed directories', (t) => {
  assert.equal(
    typeof qaHarness.prepareQaOutputDirectory,
    'function',
    'the process harness must expose the shared QA output boundary',
  );

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-output-boundary-'));
  const workspace = path.join(sandbox, 'workspace');
  fs.mkdirSync(workspace);
  const workspaceSentinel = path.join(workspace, 'keep.txt');
  fs.writeFileSync(workspaceSentinel, 'keep');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  for (const unsafePath of [
    path.parse(workspace).root,
    os.homedir(),
    workspace,
    path.join(workspace, 'ordinary-output'),
    path.join(os.tmpdir(), 'lianhua-secret-output'),
  ]) {
    assert.throws(
      () => qaHarness.prepareQaOutputDirectory(unsafePath, { workspaceRoot: workspace }),
      /unsafe QA output directory/i,
    );
  }
  assert.equal(fs.readFileSync(workspaceSentinel, 'utf8'), 'keep');

  const safeOutput = path.join(workspace, '.qa-ui-test');
  fs.mkdirSync(safeOutput);
  const staleArtifact = path.join(safeOutput, 'stale.json');
  fs.writeFileSync(staleArtifact, '{}');
  assert.equal(
    qaHarness.prepareQaOutputDirectory(safeOutput, { workspaceRoot: workspace }),
    safeOutput,
  );
  assert.equal(fs.existsSync(staleArtifact), false);
  assert.equal(fs.existsSync(safeOutput), true);
});

test('QA output cleanup rejects a linked ancestor without deleting files outside the managed root', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-linked-boundary-'));
  const tempRoot = path.join(sandbox, 'temp');
  const workspace = path.join(sandbox, 'workspace');
  const managedRoot = path.join(tempRoot, 'lianhua-qa-linked-output');
  const outsideRoot = path.join(sandbox, 'outside');
  const outsideChild = path.join(outsideRoot, 'child');
  const linkedAncestor = path.join(managedRoot, 'linked');
  const outsideSentinel = path.join(outsideChild, 'keep.txt');
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(outsideChild, { recursive: true });
  fs.writeFileSync(outsideSentinel, 'keep');
  fs.symlinkSync(
    outsideRoot,
    linkedAncestor,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  let rejection;
  try {
    qaHarness.prepareQaOutputDirectory(path.join(linkedAncestor, 'child'), {
      tempRoot,
      workspaceRoot: workspace,
    });
  } catch (error) {
    rejection = error;
  }

  assert.deepEqual(
    {
      rejected: /unsafe QA output directory/i.test(rejection?.message || ''),
      sentinelPreserved: fs.existsSync(outsideSentinel)
        && fs.readFileSync(outsideSentinel, 'utf8') === 'keep',
    },
    { rejected: true, sentinelPreserved: true },
  );
});

test('QA output cleanup rejects a managed-looking ancestor that contains the workspace', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-workspace-boundary-'));
  const tempRoot = path.join(sandbox, 'temp');
  const target = path.join(tempRoot, 'lianhua-qa-containing-workspace');
  const workspace = path.join(target, 'workspace');
  const workspaceSentinel = path.join(workspace, 'keep.txt');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(workspaceSentinel, 'keep');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  let rejection;
  try {
    qaHarness.prepareQaOutputDirectory(target, { tempRoot, workspaceRoot: workspace });
  } catch (error) {
    rejection = error;
  }

  assert.deepEqual(
    {
      rejected: /unsafe QA output directory/i.test(rejection?.message || ''),
      sentinelPreserved: fs.existsSync(workspaceSentinel)
        && fs.readFileSync(workspaceSentinel, 'utf8') === 'keep',
    },
    { rejected: true, sentinelPreserved: true },
  );
});

test('condition polling enforces one absolute deadline even when a check never settles', async () => {
  assert.equal(
    typeof qaHarness.waitForCondition,
    'function',
    'the process harness must expose deadline-based polling',
  );
  const startedAt = Date.now();
  await assert.rejects(
    qaHarness.waitForCondition({
      check: () => new Promise(() => {}),
      intervalMs: 1,
      label: 'renderer readiness',
      timeoutMs: 30,
    }),
    /renderer readiness timed out after 30ms/i,
  );
  assert.ok(Date.now() - startedAt < 500, 'a 30ms deadline must not multiply across attempts');
});

test('UI smoke waits past the stale reload document until the fresh shell and settings trigger are ready', async () => {
  assert.equal(
    typeof uiSmokeReadiness.reloadAndWaitForAppShell,
    'function',
    uiSmokeReadiness.loadError?.message,
  );
  const statuses = [
    {
      documentReady: true,
      previousDocument: true,
      appShellFound: true,
      settingsTriggerFound: true,
      requiredStateReady: true,
    },
    {
      documentReady: true,
      previousDocument: false,
      appShellFound: true,
      settingsTriggerFound: false,
      requiredStateReady: true,
    },
    {
      documentReady: true,
      previousDocument: false,
      appShellFound: true,
      settingsTriggerFound: true,
      requiredStateReady: true,
    },
  ];
  const operations = [];
  let statusIndex = 0;

  await uiSmokeReadiness.reloadAndWaitForAppShell({
    intervalMs: 1,
    markCurrentDocument: async () => { operations.push('mark'); },
    readStatus: async () => {
      operations.push('read');
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return status;
    },
    reload: async () => { operations.push('reload'); },
    timeoutMs: 100,
  });

  assert.deepEqual(operations, ['mark', 'reload', 'read', 'read', 'read']);
});

test('dynamic QA ports are released before child processes bind them', async () => {
  assert.equal(
    typeof qaHarness.findAvailableTcpPort,
    'function',
    'the process harness must expose dynamic loopback port allocation',
  );
  const port = await qaHarness.findAvailableTcpPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('configured CDP port guard rejects an occupied listener without contacting it', async (t) => {
  const { assertLoopbackPortAvailable } = await import('./webQaIsolation.mjs');
  let acceptedConnections = 0;
  const server = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, 'object');

  await assert.rejects(
    assertLoopbackPortAvailable(address.port),
    /CDP_PORT .* already in use/i,
  );
  assert.equal(acceptedConnections, 0, 'availability checks must bind, never probe the existing service');
});

test('isolated Edge close verifies the exact profile and port before Browser.close', async () => {
  const { requestVerifiedBrowserClose } = await import('./webQaIsolation.mjs');
  const expectedProfile = path.join(os.tmpdir(), 'lianhua-edge-qa-owned-profile');
  const alienProfile = path.join(os.tmpdir(), 'ordinary-edge-profile');
  const methods = [];

  await assert.rejects(
    requestVerifiedBrowserClose({
      browserData: expectedProfile,
      cdpPort: 45_321,
      command: async (method) => {
        methods.push(method);
        if (method === 'Browser.getBrowserCommandLine') {
          return {
            arguments: [
              `--user-data-dir=${alienProfile}`,
              '--remote-debugging-port=45321',
            ],
          };
        }
        return {};
      },
    }),
    /does not belong to the expected QA profile/i,
  );
  assert.deepEqual(
    methods,
    ['Browser.getBrowserCommandLine'],
    'an unrelated debugger must never receive Browser.close',
  );
});

test('isolated Edge cleanup always runs the profile fallback after primary close failure', async () => {
  const { cleanupIsolatedBrowser } = await import('./webQaIsolation.mjs');
  let fallbackCalls = 0;

  await assert.rejects(
    cleanupIsolatedBrowser({
      closeBrowser: async () => {
        throw new Error('/json/version unavailable');
      },
      stopBrowserByProfile: async () => {
        fallbackCalls += 1;
      },
    }),
    /json\/version unavailable/i,
  );
  assert.equal(fallbackCalls, 1, 'profile-scoped cleanup must run even when CDP discovery/close fails');
});

test('Vite scopes dependency discovery and ignores generated artifacts outside the renderer source', async () => {
  const viteConfig = (await import('../vite.config.ts')).default;
  const ignored = viteConfig.server?.watch?.ignored;

  assert.deepEqual(
    viteConfig.optimizeDeps?.entries,
    ['index.html'],
    'Vite dependency discovery must start from the app entry instead of crawling generated HTML files',
  );
  assert.ok(
    Array.isArray(ignored) && ignored.includes('**/.qa-*/**'),
    'Vite must ignore generated .qa-* trees so locked browser files cannot crash its watcher',
  );
  for (const pattern of [
    '**/.edge-qa-profile*/**',
    '**/.chrome-visual-test*/**',
    '**/.runtime-temp*/**',
    '**/.pack-temp*/**',
    '**/.temp/**',
    '**/release/**',
    '**/output/**',
    '**/交付/**',
  ]) {
    assert.ok(ignored.includes(pattern), `Vite must ignore ${pattern} artifacts`);
  }
  assert.match(webQaSource, /import os from 'node:os'/u);
  assert.match(webQaSource, /path\.join\(os\.tmpdir\(\),\s*`lianhua-edge-qa-/u);
});

test('UI smoke replaces stale output with a current-run report before attempting CDP discovery', async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-ui-smoke-output-'));
  const staleReport = path.join(outputDirectory, 'report.json');
  const staleScreenshot = path.join(outputDirectory, 'old.png');
  fs.writeFileSync(staleReport, '{"stale":true}');
  fs.writeFileSync(staleScreenshot, 'stale');

  const child = spawn(process.execPath, [path.join(root, 'scripts', 'uiSmoke.mjs')], {
    cwd: root,
    env: { ...process.env, CDP_PORT: '1', QA_OUTPUT: outputDirectory },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null
      ? resolve()
      : child.once('close', resolve));
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  });

  let currentReport = null;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(staleScreenshot) && fs.existsSync(staleReport)) {
      try {
        const candidate = JSON.parse(fs.readFileSync(staleReport, 'utf8'));
        if (candidate.stale !== true) {
          currentReport = candidate;
          break;
        }
      } catch { /* The report may be between writes. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(fs.existsSync(staleScreenshot), false, 'stale screenshots must disappear before CDP work starts');
  assert.equal(fs.existsSync(outputDirectory), true, 'the clean output directory must be recreated for this run');
  assert.ok(currentReport, 'the stale report must be replaced by evidence for the current run');
  assert.deepEqual(currentReport.pages, []);
  assert.deepEqual(currentReport.consoleErrors, []);
  assert.equal(currentReport.passed, false);
  assert.ok(['running', 'failed'].includes(currentReport.status), `unexpected report status: ${currentReport.status}`);
  assert.equal(currentReport.error === null || typeof currentReport.error === 'string', true);
});

test('web QA uses the verified process harness, bounded startup polling, and an isolated target', () => {
  assert.match(webQaSource, /const qaScriptTimeoutMs\s*=/u);
  assert.match(webQaSource, /createQaProcessHarness/u);
  assert.match(webQaSource, /findAvailableTcpPort/u);
  assert.match(webQaSource, /waitForCondition/u);
  assert.match(webQaSource, /AbortSignal\.timeout/u);
  assert.match(webQaSource, /QA_TARGET_URL/u);
  assert.match(webQaSource, /QA_BOOTSTRAP_ONLY/u);
  assert.match(webQaSource, /await stopAll\(\)/u);
  assert.doesNotMatch(webQaSource, /spawnSync\('taskkill\.exe'/u);
});

test('web QA tolerates a clean Edge launcher handoff and closes the detached browser', () => {
  assert.match(
    webQaSource,
    /code !== 0 \|\| signal/u,
    'a clean Edge launcher handoff must not be reported as an early QA failure',
  );
  assert.match(
    webQaSource,
    /const edgeFailure = new Promise\(\(_, reject\) =>/u,
    'a clean launcher handoff must leave the Edge failure guard pending instead of winning Promise.race',
  );
  assert.match(webQaSource, /Promise\.race\(\[promise, qaFailure, edgeSpawnFailure, edgeFailure\]\)/u);
  assert.match(
    webQaSource,
    /Browser\.close/u,
    'web QA must close the verified isolated browser when the launcher detaches',
  );
});

test('web QA binds target creation and cleanup to the verified isolated Edge profile', () => {
  assert.match(webQaSource, /assertLoopbackPortAvailable/u);
  assert.match(webQaSource, /--enable-automation/u);
  const identityIndex = webQaSource.indexOf('verifyIsolatedBrowserIdentity');
  const targetCreationIndex = webQaSource.indexOf("label: 'isolated Edge target creation'");
  assert.ok(identityIndex >= 0, 'web QA must verify the browser command line identity');
  assert.ok(
    targetCreationIndex > identityIndex,
    'profile identity must be verified before a target is created in the debugger',
  );

  const closeStart = webQaSource.indexOf('const closeIsolatedBrowser =');
  const runStart = webQaSource.indexOf('let edge;', closeStart);
  assert.ok(closeStart >= 0 && runStart > closeStart, 'web QA must declare isolated browser cleanup');
  const closeSource = webQaSource.slice(closeStart, runStart);
  assert.doesNotMatch(
    closeSource,
    /\/json\/version/u,
    'cleanup must reuse the verified browser endpoint instead of rediscovering an unrelated debugger',
  );
  assert.match(webQaSource, /cleanupIsolatedBrowser\(\{/u);
  assert.match(webQaSource, /stopIsolatedEdgeByProfile/u);
});

test('web QA waits for every isolated Edge profile process to exit before removing its profile', () => {
  const cleanupStart = webQaSource.indexOf('const stopIsolatedEdgeByProfile');
  const cleanupEnd = webQaSource.indexOf('\n};', cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'profile cleanup function must exist');
  const cleanupSource = webQaSource.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupSource, /for\s*\(\$attempt\s*=\s*0;/u);
  assert.match(cleanupSource, /Start-Sleep\s+-Milliseconds/u);
  assert.match(cleanupSource, /throw\s+new\s+Error\([^)]*still running/u);
});

test('UI smoke validates output cleanup and selects the target created for this run', () => {
  assert.match(uiSmokeSource, /prepareQaOutputDirectory\(outputDirectory/u);
  assert.match(uiSmokeSource, /process\.env\.QA_TARGET_ID/u);
  assert.match(uiSmokeSource, /process\.env\.QA_TARGET_URL/u);
  assert.match(uiSmokeSource, /QA_BOOTSTRAP_ONLY/u);
  assert.doesNotMatch(uiSmokeSource, /fs\.rmSync\(outputDirectory/u);
});

test('UI smoke gives the initial page navigation the cold-start timeout', () => {
  assert.match(
    uiSmokeSource,
    /await command\('Page\.navigate',\s*\{\s*url:\s*navigationUrl\.href\s*\},\s*startupCommandTimeoutMs\)/u,
  );
  assert.match(uiSmokeSource, /navigationUrl\.searchParams\.set\('uiSmokeRun'/u);
});

test('UI smoke waits for the app shell and fails explicitly when startup never completes', () => {
  assert.match(uiSmokeSource, /const appReadyTimeoutMs\s*=\s*Math\.max\([^\n]+\|\|\s*60_000\)/u);
  assert.match(uiSmokeSource, /let appReady\s*=\s*false/u);
  assert.match(uiSmokeSource, /if \(!appReady\) throw new Error\('Web application did not initialize'\)/u);
});

test('Electron smoke gives Runtime.enable a dedicated cold-start timeout', () => {
  const timeoutMatch = electronSmokeSource.match(/const startupCommandTimeoutMs\s*=\s*Math\.max\([^\n]+\|\|\s*([\d_]+)/u);
  assert.ok(timeoutMatch, 'Electron smoke must define a dedicated startup command timeout');
  assert.ok(Number(timeoutMatch[1].replaceAll('_', '')) >= 60_000, 'cold-start command timeout must be at least 60 seconds');
  assert.match(
    electronSmokeSource,
    /await command\('Runtime\.enable',\s*\{\},\s*startupCommandTimeoutMs\)/u,
    'Runtime.enable must use the cold-start timeout instead of the ordinary 10-second command timeout',
  );
});

test('Electron smoke waits for the renderer through one absolute deadline', () => {
  assert.match(electronSmokeSource, /waitForCondition\(\{[\s\S]*?label:\s*'Electron renderer'/u);
  assert.doesNotMatch(
    electronSmokeSource,
    /for \(let attempt = 0; attempt < 60; attempt \+= 1\) \{\s*if \(await rendererReady\(\)\)/u,
  );
});

test('Electron smoke verifies the connected renderer belongs to this QA data root before mutation', () => {
  const guardIndex = electronSmokeSource.indexOf('connectedRendererDataRoot');
  const mutationIndex = electronSmokeSource.indexOf('const result = await evaluate');
  assert.ok(guardIndex >= 0, 'Electron smoke must inspect the connected renderer data root');
  assert.ok(mutationIndex > guardIndex, 'renderer identity must be checked before the state mutation flow');
});
