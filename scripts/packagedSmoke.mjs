import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  findAvailableTcpPort,
  prepareQaOutputDirectory,
  waitForCondition,
} from './qaProcessHarness.mjs';
import {
  CURRENT_UNIFIED_VIDEO_CONVERTER_CONTRACT_MARKERS,
  collectPackagedSmokeFailures,
  resolveExpectedSchemaVersion,
} from './packagedSmokeExpectations.mjs';
import { assertLoopbackPortAvailable } from './webQaIsolation.mjs';

const root = process.cwd();
const executable = String(process.env.APP_EXECUTABLE || '').trim();
const configuredDataDirectory = String(process.env.LIANHUA_DATA_DIR || '').trim();
const expectedDataDirectory = String(process.env.EXPECTED_DATA_DIR || '').trim();
const requestedOutputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-packaged');
const configuredPortText = process.env.CDP_PORT?.trim();
const configuredPort = configuredPortText ? Number(configuredPortText) : null;
const packageInfo = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const expectedVersion = String(packageInfo.version || '').trim();
const expectedSchemaVersion = resolveExpectedSchemaVersion({
  configuredValue: process.env.EXPECTED_SCHEMA_VERSION,
  storageSource: fs.readFileSync(path.join(root, 'src', 'storage.ts'), 'utf8'),
});
const normalizeFsPath = (value) => {
  const normalized = path.resolve(String(value || '')).replace(/[\\/]+/gu, path.sep);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const pathsOverlap = (left, right) => {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  const leftToRight = path.relative(leftPath, rightPath);
  const rightToLeft = path.relative(rightPath, leftPath);
  const isSameOrInside = (relative) => relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  return isSameOrInside(leftToRight) || isSameOrInside(rightToLeft);
};

if (!executable || !fs.existsSync(executable)) {
  throw new Error('APP_EXECUTABLE must point to a packaged executable');
}
if (!configuredDataDirectory || !expectedDataDirectory) {
  throw new Error('LIANHUA_DATA_DIR and EXPECTED_DATA_DIR are both required');
}
if (normalizeFsPath(configuredDataDirectory) !== normalizeFsPath(expectedDataDirectory)) {
  throw new Error('LIANHUA_DATA_DIR and EXPECTED_DATA_DIR must match');
}
if (configuredPort !== null && (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535)) {
  throw new Error(`Invalid CDP_PORT: ${process.env.CDP_PORT}`);
}
if (configuredPort !== null) await assertLoopbackPortAvailable(configuredPort);

const requestedDataDirectory = path.resolve(expectedDataDirectory);
const resolvedOutputDirectory = path.resolve(requestedOutputDirectory);
if (pathsOverlap(requestedDataDirectory, resolvedOutputDirectory)) {
  throw new Error('QA data and output directories must be separate');
}
const dataDirectory = prepareQaOutputDirectory(requestedDataDirectory, { workspaceRoot: root });
const outputDirectory = prepareQaOutputDirectory(resolvedOutputDirectory, { workspaceRoot: root });
// The desktop app migrates its legacy profile into an otherwise empty root.
// Seed only this freshly reset QA root so tests never import real projects,
// credentials, or external-backup settings before the renderer identity check.
fs.writeFileSync(path.join(dataDirectory, '.qa-isolated-profile'), 'packaged smoke only\n', {
  encoding: 'utf8',
  flag: 'wx',
});
const port = configuredPort ?? await findAvailableTcpPort();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);

const childEnvironment = {
  ...process.env,
  LIANHUA_DATA_DIR: dataDirectory,
};
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  cwd: path.dirname(executable),
  env: childEnvironment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let processLog = '';
let childSpawnError;
child.stdout?.on('data', (chunk) => { processLog += chunk; });
child.stderr?.on('data', (chunk) => { processLog += chunk; });
child.once('error', (error) => {
  childSpawnError = error;
  processLog += `[spawn error] ${error.stack || error.message || String(error)}\n`;
});

let socket;
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
let id = 0;
const commandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_COMMAND_TIMEOUT_MS) || 10_000);
const startupCommandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_STARTUP_COMMAND_TIMEOUT_MS) || 120_000);
const pending = new Map();
const consoleErrors = [];
const handleSocketMessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    globalThis.clearTimeout?.(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails.text || 'Runtime exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((item) => item.value || item.description || '').join(' '));
  }
};
const failPending = (reason) => {
  const error = reason instanceof Error ? reason : new Error(`CDP socket ${String(reason || 'closed')}`);
  for (const handler of pending.values()) {
    globalThis.clearTimeout?.(handler.timer);
    handler.reject(error);
  }
  pending.clear();
};
const attachSocketListeners = () => {
  socket.addEventListener('message', handleSocketMessage);
  socket.addEventListener('close', (event) => failPending(event.reason || 'closed'));
  socket.addEventListener('error', (event) => failPending(event.message || 'error'));
};
if (socket) attachSocketListeners();
const command = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
  if (typeof WebSocket !== 'undefined' && socket?.readyState !== WebSocket.OPEN) {
    reject(new Error('CDP socket is not open'));
    return;
  }
  const commandId = ++id;
  const timer = globalThis.setTimeout?.(() => {
    pending.delete(commandId);
    reject(new Error(`CDP command timed out: ${method}`));
  }, timeoutMs);
  pending.set(commandId, { resolve, reject, timer });
  try {
    socket.send(JSON.stringify({ id: commandId, method, params }));
  } catch (error) {
    globalThis.clearTimeout?.(timer);
    pending.delete(commandId);
    reject(error);
  }
});
const evaluate = async (expression, timeoutMs = commandTimeoutMs) => {
  const response = await command(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Evaluation failed');
  }
  return response.result.value;
};

try {
  let target;
  await waitForCondition({
    label: 'packaged app debugging target',
    timeoutMs: startupCommandTimeoutMs,
    intervalMs: 250,
    check: async () => {
      if (childSpawnError) throw childSpawnError;
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(connectionTimeoutMs),
        }).then((response) => response.json());
        target = targets.find((item) => item.type === 'page' && item.title?.includes('莲华'))
          || targets.find((item) => item.type === 'page');
        return Boolean(target?.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    },
  });

  socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await waitForSocketOpen();
  } catch (error) {
    socket.close();
    throw error;
  }
  attachSocketListeners();

  await command('Runtime.enable', {}, startupCommandTimeoutMs);
  await command('Page.enable', {}, startupCommandTimeoutMs);
  await waitForCondition({
    label: 'packaged renderer',
    timeoutMs: startupCommandTimeoutMs,
    intervalMs: 200,
    check: (remainingMs) => evaluate(
      `Boolean(document.querySelector('.app-shell') && window.lianhuaDesktop)`,
      Math.min(commandTimeoutMs, remainingMs),
    ),
  });

  const connectedRendererDataRoot = await evaluate(
    `(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot)()`,
    startupCommandTimeoutMs,
  );
  if (normalizeFsPath(connectedRendererDataRoot) !== normalizeFsPath(dataDirectory)) {
    throw new Error(`Packaged smoke connected to the wrong data root: ${connectedRendererDataRoot}`);
  }
  const packagedMediaTools = await evaluate(`(async () => window.lianhuaDesktop.videoWorkbenchStatus ? await window.lianhuaDesktop.videoWorkbenchStatus() : null)()`, startupCommandTimeoutMs);
  if (packageInfo.build?.extraResources?.some((entry) => entry.to === 'media-tools')
    && (!packagedMediaTools?.available || packagedMediaTools.source !== 'bundled')) {
    throw new Error(`Packaged video workbench tools are missing or unusable: ${JSON.stringify(packagedMediaTools)}`);
  }

  // Opt-in read-only connectivity check through the actual renderer -> IPC ->
  // main transport. Never load credentials or call an image-generation route.
  let connectivityProbe;
  if (process.env.QA_CONNECTIVITY_URL) {
    const probeUrl = new URL(process.env.QA_CONNECTIVITY_URL);
    if (probeUrl.protocol !== 'https:' || probeUrl.username || probeUrl.password || probeUrl.search || probeUrl.hash
      || !['/', '/v1/models'].includes(probeUrl.pathname)) {
      throw new Error('QA_CONNECTIVITY_URL must be a credential-free HTTPS root or /v1/models URL');
    }
    connectivityProbe = await evaluate(`(async () => {
      const started = Date.now();
      const result = await window.lianhuaDesktop.request({
        url: ${JSON.stringify(probeUrl.href)}, method: 'GET', headers: {}, timeoutMs: 15000,
      });
      return { status: result.status, elapsedMs: Date.now() - started, credentialFree: true };
    })()`, 20000);
    if (!(connectivityProbe.status >= 100 && connectivityProbe.status <= 599)) {
      throw new Error('Packaged model transport did not receive an HTTP response');
    }
  }

  await waitForCondition({
    label: 'packaged initial state',
    timeoutMs: startupCommandTimeoutMs,
    intervalMs: 150,
    check: (remainingMs) => evaluate(
      `Boolean(localStorage.getItem('lianhua_video_director_state_v22'))`,
      Math.min(commandTimeoutMs, remainingMs),
    ),
  });
  const smokeProjectName = `${expectedVersion} packaged smoke`;
  const persistence = await evaluate(`(async () => {
    const key = 'lianhua_video_director_state_v22';
    const state = JSON.parse(localStorage.getItem(key));
    if (!state?.project || !state?.settings) throw new Error('Initial application state was not persisted');
    const unifiedVideoConverter = state.converterPresets?.find(
      (preset) => preset?.id === 'converter_unified_video',
    );
    const unifiedVideoRules = [
      unifiedVideoConverter?.systemPrompt || '',
      unifiedVideoConverter?.outputRules || '',
    ].join('\\n');
    const unifiedVideoContractMarkers = ${JSON.stringify(CURRENT_UNIFIED_VIDEO_CONVERTER_CONTRACT_MARKERS)};
    state.project.name = ${JSON.stringify(smokeProjectName)};
    const saved = await window.lianhuaDesktop.saveState(JSON.stringify(state));
    const loaded = JSON.parse(await window.lianhuaDesktop.loadState());
    const restore = await window.lianhuaDesktop.createRestorePoint(JSON.stringify(loaded));
    const status = await window.lianhuaDesktop.recoveryStatus();
    const paths = await window.lianhuaDesktop.storagePaths();
    return {
      title: document.title,
      version: document.querySelector('.sidebar-version > span:last-child')?.textContent?.trim()
        || document.querySelector('.sidebar-footer .row > span:last-child')?.textContent?.trim() || '',
      saved: Boolean(saved?.ok),
      reloaded: loaded.project.name === ${JSON.stringify(smokeProjectName)},
      restoreCreated: Boolean(restore?.ok),
      stateValid: status.stateValid,
      encryptionAvailable: status.encryptionAvailable,
      dataRoot: paths.dataRoot,
      schemaVersion: state.schemaVersion,
      unifiedVideoConverterVersion: unifiedVideoConverter?.version || '',
      unifiedVideoConverterHasHighDetailContract:
        unifiedVideoContractMarkers.every((marker) => unifiedVideoRules.includes(marker)),
    };
  })()`, startupCommandTimeoutMs);

  const requiredViewports = [
    { width: 1120, height: 720 },
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
  ];
  const viewportResults = [];
  for (const viewport of requiredViewports) {
    await command('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const apiSettings = await evaluate(`(async () => {
      const nextFrame = () => new Promise((resolve) => {
        let fallback;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          resolve();
        };
        fallback = setTimeout(finish, 250);
        requestAnimationFrame(() => requestAnimationFrame(finish));
      });
      const panelIds = ['image', 'text', 'vision', 'video', 'credentials'];
      const expectedLabels = ['图片 API', '文本 API', '视觉 API', '视频生成', '密码本'];
      const apiNavigation = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'API 设置');
      const navigationRect = apiNavigation?.getBoundingClientRect();
      apiNavigation?.click();
      await nextFrame();

      const workspace = document.querySelector('.workspace');
      const settingsView = document.querySelector('.settings-view');
      const stage = document.querySelector('.settings-panel-stage');
      const buttons = [...document.querySelectorAll('[data-settings-panel]')];
      if (!workspace || !settingsView || !stage) {
        return { missingWorkspace: true, panelResults: [] };
      }
      const workspaceRect = workspace.getBoundingClientRect();
      const settingsRect = settingsView.getBoundingClientRect();
      const defaultPanelIsImage = stage.getAttribute('data-active-panel') === 'image'
        && buttons.find((button) => button.getAttribute('data-settings-panel') === 'image')
          ?.getAttribute('aria-selected') === 'true';
      const isVisibleInside = (element, bounds) => {
        if (!element || !bounds) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && rect.left >= bounds.left - 1
          && rect.right <= bounds.right + 1
          && rect.top >= bounds.top - 1
          && rect.bottom <= bounds.bottom + 1
          && rect.left >= -1
          && rect.right <= window.innerWidth + 1
          && rect.top >= -1
          && rect.bottom <= window.innerHeight + 1;
      };
      const findField = (label) => [...stage.querySelectorAll('.field')]
        .find((field) => field.querySelector(':scope > label')?.textContent?.trim() === label);
      const toggleLabel = [...stage.querySelectorAll('label.check-row')]
        .find((label) => label.textContent?.trim() === '启用图像生成接口');
      const imageFields = [
        { label: toggleLabel, control: toggleLabel?.querySelector('input[type="checkbox"]') },
        ...[
          ['后端', 'select'],
          ['模型 / 工作流', 'input'],
          ['API 地址', 'input'],
          ['API 密钥', 'input'],
        ].map(([label, selector]) => {
          const field = findField(label);
          return { label: field?.querySelector(':scope > label'), control: field?.querySelector(selector) };
        }),
      ];
      const initialStageRect = stage.getBoundingClientRect();
      const imageFieldControlsVisible = defaultPanelIsImage
        && imageFields.every(({ label, control }) =>
          isVisibleInside(label, initialStageRect) && isVisibleInside(control, initialStageRect));
      const tabLabels = buttons.map((button) => button.textContent?.trim() || '');
      const tabsVisible = buttons.length === panelIds.length
        && buttons.every((button) => isVisibleInside(button, workspaceRect));

      const panelResults = [];
      for (const panelId of panelIds) {
        const button = buttons.find((item) => item.getAttribute('data-settings-panel') === panelId);
        if (!button) {
          panelResults.push({ panelId, missingButton: true });
          continue;
        }
        workspace.scrollTop = 0;
        workspace.scrollLeft = 0;
        button.click();
        await nextFrame();
        const activeStage = document.querySelector('.settings-panel-stage');
        const content = activeStage?.firstElementChild;
        const stageRect = activeStage?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        const videoSettings = panelId === 'video'
          && activeStage?.getAttribute('data-active-panel') === 'video'
          ? activeStage.querySelector(':scope > .video-generation-settings')
          : null;
        const videoSettingsRect = videoSettings?.getBoundingClientRect();
        const videoSettingsOverflowContained = panelId !== 'video' || Boolean(
          videoSettings
          && ['hidden', 'clip'].includes(getComputedStyle(videoSettings).overflowY)
        );
        const videoSettingsInsideStage = panelId !== 'video' || Boolean(
          stageRect
          && videoSettingsRect
          && videoSettingsRect.width > 0
          && videoSettingsRect.height > 0
          && videoSettingsRect.left >= stageRect.left - 1
          && videoSettingsRect.right <= stageRect.right + 1
          && videoSettingsRect.top >= stageRect.top - 1
          && videoSettingsRect.bottom <= stageRect.bottom + 1
          && videoSettingsRect.left >= -1
          && videoSettingsRect.right <= window.innerWidth + 1
          && videoSettingsRect.top >= -1
          && videoSettingsRect.bottom <= window.innerHeight + 1
        );
        const videoSettingsFitsWithoutScroll = panelId !== 'video' || Boolean(
          videoSettings
          && videoSettings.scrollHeight <= videoSettings.clientHeight + 1
          && videoSettings.scrollWidth <= videoSettings.clientWidth + 1
          && videoSettings.scrollTop === 0
          && videoSettings.scrollLeft === 0
        );
        const videoDetailsCollapsed = panelId !== 'video' || Boolean(
          videoSettings
          && [...videoSettings.querySelectorAll('details')].every((details) => !details.open)
        );
        const internalOverflowY = activeStage
          ? [...activeStage.querySelectorAll('*')].some((element) => {
              const style = getComputedStyle(element);
              return ['auto', 'scroll'].includes(style.overflowY)
                && element.scrollHeight > element.clientHeight + 1;
            })
          : true;
        const internalOverflowX = activeStage
          ? [...activeStage.querySelectorAll('*')].some((element) => {
              const style = getComputedStyle(element);
              return ['auto', 'scroll'].includes(style.overflowX)
                && element.scrollWidth > element.clientWidth + 1;
            })
          : true;
        const descendantClipped = stageRect
          ? [...activeStage.querySelectorAll('button, input, select, label, h2, p, .field-hint, .hint-box')]
            .filter((element) => {
              const closedDetails = element.closest('details:not([open])');
              const visibleSummary = closedDetails?.querySelector(':scope > summary');
              return !closedDetails || Boolean(visibleSummary?.contains(element));
            })
            .some((element) => {
              const rect = element.getBoundingClientRect();
              const clippedHorizontally = rect.left < stageRect.left - 1
                || rect.right > stageRect.right + 1;
              const clippedVertically = rect.top < stageRect.top - 1
                || rect.bottom > stageRect.bottom + 1;
              return rect.width > 0 && rect.height > 0
                  && (clippedHorizontally || clippedVertically);
            })
          : true;
        panelResults.push({
          panelId,
          active: activeStage?.getAttribute('data-active-panel') === panelId,
          contentVisible: Boolean(contentRect && contentRect.width > 0 && contentRect.height > 0),
          contentInsideStage: Boolean(stageRect && contentRect
            && contentRect.left >= stageRect.left - 1
            && contentRect.right <= stageRect.right + 1
            && contentRect.top >= stageRect.top - 1
            && contentRect.bottom <= stageRect.bottom + 1),
          contentOverflowX: Boolean(content && content.scrollWidth > content.clientWidth + 1),
          contentOverflowY: Boolean(content && content.scrollHeight > content.clientHeight + 1),
          descendantClipped,
          internalOverflowX,
          internalOverflowY,
          videoSettingsOverflowContained,
          videoSettingsInsideStage,
          videoSettingsFitsWithoutScroll,
          videoDetailsCollapsed,
          workspaceScrollLeft: workspace.scrollLeft,
          workspaceScrollTop: workspace.scrollTop,
          workspaceOverflowX: workspace.scrollWidth > workspace.clientWidth + 1,
          workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
          bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          bodyOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        });
      }
      buttons.find((button) => button.getAttribute('data-settings-panel') === 'image')?.click();
      await nextFrame();
      return {
        missingWorkspace: false,
        navigationVisible: Boolean(navigationRect && navigationRect.width > 0 && navigationRect.height > 0),
        defaultPanelIsImage,
        tabLabels,
        labelsCorrect: expectedLabels.every((label, index) => tabLabels[index] === label),
        tabsVisible,
        imageFieldControlsVisible,
        settingsInsideWorkspace: settingsRect.left >= workspaceRect.left - 1
          && settingsRect.right <= workspaceRect.right + 1
          && settingsRect.top >= workspaceRect.top - 1
          && settingsRect.bottom <= workspaceRect.bottom + 1,
        workspaceOverflowX: workspace.scrollWidth > workspace.clientWidth + 1,
        workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bodyOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        panelResults,
      };
    })()`, startupCommandTimeoutMs);
    const fileName = `packaged-${viewport.width}x${viewport.height}.png`;
    const screenshot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    fs.writeFileSync(path.join(outputDirectory, fileName), Buffer.from(screenshot.data, 'base64'));
    viewportResults.push({ ...viewport, fileName, apiSettings });
  }

  const report = {
    executable: path.resolve(executable),
    ...persistence,
    connectedRendererDataRoot,
    packagedMediaTools,
    ...(connectivityProbe ? { connectivityProbe } : {}),
    dataRootIsolated: normalizeFsPath(persistence.dataRoot) === normalizeFsPath(dataDirectory),
    stateFileExists: fs.existsSync(path.join(dataDirectory, 'project-state.json')),
    snapshotExists: fs.existsSync(path.join(dataDirectory, 'project-snapshots'))
      && fs.readdirSync(path.join(dataDirectory, 'project-snapshots')).length > 0,
    viewports: viewportResults,
    consoleErrors,
  };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  const apiViewportsPass = report.viewports.every(({ apiSettings }) =>
    !apiSettings.missingWorkspace
    && apiSettings.navigationVisible
    && apiSettings.defaultPanelIsImage
    && apiSettings.labelsCorrect
    && apiSettings.tabsVisible
    && apiSettings.imageFieldControlsVisible
    && apiSettings.settingsInsideWorkspace
    && !apiSettings.workspaceOverflowX
    && !apiSettings.workspaceOverflowY
    && !apiSettings.bodyOverflowX
    && !apiSettings.bodyOverflowY
    && apiSettings.panelResults.every((panel) =>
      !panel.missingButton
      && panel.active
      && panel.contentVisible
      && panel.contentInsideStage
      && !panel.contentOverflowX
      && !panel.contentOverflowY
      && !panel.descendantClipped
      && !panel.internalOverflowX
      && !panel.internalOverflowY
      && panel.videoSettingsOverflowContained
      && panel.videoSettingsInsideStage
      && panel.videoSettingsFitsWithoutScroll
      && panel.videoDetailsCollapsed
      && panel.workspaceScrollLeft === 0
      && panel.workspaceScrollTop === 0
      && !panel.workspaceOverflowX
      && !panel.workspaceOverflowY
      && !panel.bodyOverflowX
      && !panel.bodyOverflowY
    ));
  const failed = collectPackagedSmokeFailures({
    report,
    expectedVersion,
    expectedSchemaVersion,
    requiredViewportCount: requiredViewports.length,
    apiViewportsPass,
    consoleErrors,
  });
  if (failed.length) {
    throw new Error(`Packaged smoke failed: ${failed.join(', ')}\n${JSON.stringify(report, null, 2)}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  failPending('packaged smoke finished');
  socket?.close();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  fs.writeFileSync(path.join(outputDirectory, 'process.log'), processLog);
}
