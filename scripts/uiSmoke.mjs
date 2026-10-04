import fs from 'node:fs';
import path from 'node:path';
import { runWithPersistentQaReport } from './qaArtifacts.mjs';
import { prepareQaOutputDirectory, waitForCondition } from './qaProcessHarness.mjs';
import { reloadAndWaitForAppShell } from './uiSmokeReadiness.mjs';
import { runStoryboardShotPickerRegression } from './storyboardShotPickerQa.mjs';

const port = Number(process.env.CDP_PORT || 9227);
const baseUrl = process.env.APP_URL || 'http://127.0.0.1:5197/';
const outputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-ui');
const expectedTargetId = process.env.QA_TARGET_ID;
const expectedTargetUrl = process.env.QA_TARGET_URL;
const bootstrapOnly = process.env.QA_BOOTSTRAP_ONLY === '1';
const viewportWidth = Number(process.env.VIEWPORT_WIDTH || 1280);
const viewportHeight = Number(process.env.VIEWPORT_HEIGHT || 800);
const deviceScaleFactor = Number(process.env.DEVICE_SCALE_FACTOR || 1);
const navigationUrl = new URL(baseUrl);
navigationUrl.searchParams.set('uiSmokeRun', `${process.pid}-${Date.now()}`);
if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
  throw new Error(`Invalid device scale factor: ${process.env.DEVICE_SCALE_FACTOR}`);
}
prepareQaOutputDirectory(outputDirectory, { workspaceRoot: process.cwd() });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);
const consoleErrors = [];
const report = { url: baseUrl, deviceScaleFactor, pages: [], consoleErrors };

const runUiSmoke = async () => {
let target;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(connectionTimeoutMs),
    }).then((response) => response.json());
    target = expectedTargetId
      ? targets.find((item) => item.type === 'page' && item.id === expectedTargetId)
      : expectedTargetUrl
        ? targets.find((item) => item.type === 'page' && item.url === expectedTargetUrl)
        : targets.find((item) => item.type === 'page' && item.url === 'about:blank')
          || targets.find((item) => item.type === 'page');
    if (target) break;
  } catch { /* Chrome may still be starting. */ }
  await delay(200);
}
if (!target) throw new Error('Chrome debugging target did not start');

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
const startupCommandTimeoutMs = Math.max(1, Number(globalThis.process?.env?.CDP_STARTUP_COMMAND_TIMEOUT_MS) || 60_000);
const appReadyTimeoutMs = Math.max(1, Number(globalThis.process?.env?.APP_READY_TIMEOUT_MS) || 60_000);
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    globalThis.clearTimeout?.(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text || 'Runtime exception');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((item) => item.value || item.description || '').join(' '));
  }
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
const command = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
  if (typeof WebSocket !== 'undefined' && socket.readyState !== WebSocket.OPEN) {
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

const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
  return result.result.value;
};

let reloadSequence = 0;
const reloadAndWaitForUiShell = async ({ expectedFontScale, label }) => {
  const markerAttribute = 'data-ui-smoke-reload-document';
  const markerValue = `${process.pid}-${Date.now()}-${reloadSequence += 1}`;
  await reloadAndWaitForAppShell({
    label,
    timeoutMs: appReadyTimeoutMs,
    markCurrentDocument: () => evaluate(`(() => {
      document.documentElement.setAttribute(
        ${JSON.stringify(markerAttribute)},
        ${JSON.stringify(markerValue)}
      );
      return true;
    })()`),
    reload: () => command('Page.reload', {}, startupCommandTimeoutMs),
    readStatus: async () => {
      const status = await evaluate(`(() => {
        const shell = document.querySelector('.app-shell');
        return {
          documentReady: document.readyState === 'complete',
          previousDocument: document.documentElement.getAttribute(
            ${JSON.stringify(markerAttribute)}
          ) === ${JSON.stringify(markerValue)},
          appShellFound: Boolean(shell),
          settingsTriggerFound: Boolean(
            document.querySelector('button[aria-label="界面与字体设置"]')
          ),
          fontScale: shell?.getAttribute('data-ui-font-scale') || '',
        };
      })()`);
      return {
        ...status,
        requiredStateReady: expectedFontScale === undefined
          || status.fontScale === String(expectedFontScale),
      };
    },
  });
};

try {
await command('Page.enable', {}, startupCommandTimeoutMs);
await command('Runtime.enable', {}, startupCommandTimeoutMs);
await command('Emulation.setDeviceMetricsOverride', {
  width: viewportWidth,
  height: viewportHeight,
  deviceScaleFactor,
  mobile: false,
});
await command('Page.navigate', { url: navigationUrl.href }, startupCommandTimeoutMs);
let appReady = false;
const appReadyDeadline = Date.now() + appReadyTimeoutMs;
while (Date.now() < appReadyDeadline) {
  if (await evaluate(`Boolean(
    document.readyState === 'complete'
    && location.href === ${JSON.stringify(navigationUrl.href)}
    && document.querySelector('.app-shell')
    && document.querySelector('button[aria-label="界面与字体设置"]')
  )`)) {
    appReady = true;
    break;
  }
  await delay(200);
}
if (!appReady) throw new Error('Web application did not initialize');

let installedReferenceFixture = false;
const referenceFixtureDeadline = Date.now() + appReadyTimeoutMs;
while (!installedReferenceFixture && Date.now() < referenceFixtureDeadline) {
  installedReferenceFixture = await evaluate(`(() => {
  const key = 'lianhua_video_director_state_v22';
  const raw = localStorage.getItem(key);
  if (!raw) return false;
  const state = JSON.parse(raw);
  const fixture = {
    id: 'qa-arbitrary-role-image',
    name: 'QA任意职责图片',
    type: 'reference',
    role: 'motion',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlW+ScAAAAASUVORK5CYII=',
    mediaType: 'image',
    referenceRole: 'general',
    source: 'upload',
    tags: ['QA', '任意职责'],
    createdAt: 1,
    updatedAt: 1,
  };
  const install = (project) => project && ({
    ...project,
    assets: [fixture, ...(project.assets || []).filter((asset) => asset.id !== fixture.id)],
  });
  state.project = install(state.project);
  state.projects = (state.projects || []).map((project) => (
    project.id === state.project?.id ? state.project : project
  ));
  localStorage.setItem(key, JSON.stringify(state));
  return true;
})()`);
  if (!installedReferenceFixture) await delay(100);
}
if (!installedReferenceFixture) throw new Error('Could not install the asset-library reference fixture');
await reloadAndWaitForUiShell({
  label: 'web application reload after installing the reference fixture',
});

if (!bootstrapOnly) {
  const readFontSettingsLayout = () => evaluate(`(() => {
    const shell = document.querySelector('.app-shell');
    const topbar = document.querySelector('.topbar');
    const crumb = document.querySelector('.crumb');
    const actions = document.querySelector('.top-actions');
    const dialog = document.querySelector('#ui-settings-dialog');
    const dialogHead = dialog?.querySelector('.ui-settings-head');
    const dialogTitleBlock = dialogHead?.firstElementChild;
    const dialogClose = dialogHead?.querySelector('button');
    const range = dialog?.querySelector('#ui-font-scale-range');
    const number = dialog?.querySelector('#ui-font-scale-number');
    const output = dialog?.querySelector('.ui-settings-value');
    const heading = document.querySelector('.crumb h1');
    const rect = (element) => element?.getBoundingClientRect();
    const topbarRect = rect(topbar);
    const crumbRect = rect(crumb);
    const actionsRect = rect(actions);
    const dialogRect = rect(dialog);
    const titleRect = rect(dialogTitleBlock);
    const closeRect = rect(dialogClose);
    const rectanglesOverlap = (left, right) => Boolean(
      left
      && right
      && left.left < right.right - 0.5
      && left.right > right.left + 0.5
      && left.top < right.bottom - 0.5
      && left.bottom > right.top + 0.5
    );
    const inside = (inner, outer) => Boolean(
      inner
      && outer
      && inner.left >= outer.left - 1
      && inner.right <= outer.right + 1
      && inner.top >= outer.top - 1
      && inner.bottom <= outer.bottom + 1
    );
    return {
      scalePercent: Number(shell?.getAttribute('data-ui-font-scale')),
      scaleMode: shell?.getAttribute('data-ui-font-size') || '',
      cssScale: Number.parseFloat(getComputedStyle(shell).getPropertyValue('--ui-font-scale')),
      rangeValue: Number(range?.value),
      numberValue: Number(number?.value),
      outputText: output?.textContent?.replace(/\s+/g, ' ').trim() || '',
      bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
      headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      shellOverflowX: Boolean(shell && shell.scrollWidth > shell.clientWidth + 1),
      topbarOverflowX: Boolean(topbar && topbar.scrollWidth > topbar.clientWidth + 1),
      topbarOverflowY: Boolean(topbar && topbar.scrollHeight > topbar.clientHeight + 1),
      topbarInsideViewport: Boolean(
        topbarRect
        && topbarRect.left >= -1
        && topbarRect.right <= innerWidth + 1
        && topbarRect.top >= -1
        && topbarRect.bottom <= innerHeight + 1
      ),
      crumbInsideTopbar: inside(crumbRect, topbarRect),
      actionsInsideTopbar: inside(actionsRect, topbarRect),
      topbarRegionsOverlap: rectanglesOverlap(crumbRect, actionsRect),
      dialogFound: Boolean(dialog),
      dialogInsideViewport: Boolean(
        dialogRect
        && dialogRect.left >= -1
        && dialogRect.right <= innerWidth + 1
        && dialogRect.top >= -1
        && dialogRect.bottom <= innerHeight + 1
      ),
      dialogOverflowX: Boolean(dialog && dialog.scrollWidth > dialog.clientWidth + 1),
      dialogHeaderOverlap: rectanglesOverlap(titleRect, closeRect),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    };
  })()`);
  const assertFontSettingsLayout = (metrics, expectedPercent, expectedMode) => {
    const expectedScale = expectedPercent / 100;
    if (
      metrics.scalePercent !== expectedPercent
      || metrics.scaleMode !== expectedMode
      || Math.abs(metrics.cssScale - expectedScale) > 0.001
      || metrics.rangeValue !== expectedPercent
      || metrics.numberValue !== expectedPercent
      || !metrics.outputText.startsWith(`${expectedPercent}%`)
      || metrics.bodyFontSize <= 0
      || metrics.headingFontSize <= 0
      || metrics.documentOverflowX
      || metrics.shellOverflowX
      || metrics.topbarOverflowX
      || metrics.topbarOverflowY
      || !metrics.topbarInsideViewport
      || !metrics.crumbInsideTopbar
      || !metrics.actionsInsideTopbar
      || metrics.topbarRegionsOverlap
      || !metrics.dialogFound
      || !metrics.dialogInsideViewport
      || metrics.dialogOverflowX
      || metrics.dialogHeaderOverlap
    ) {
      throw new Error(`Font settings ${expectedPercent}% layout check failed\n${JSON.stringify(metrics, null, 2)}`);
    }
  };
  const openFontSettings = () => evaluate(`(async () => {
    const trigger = document.querySelector('button[aria-label="界面与字体设置"]');
    if (!trigger) return { triggerFound: false };
    trigger.focus();
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const activeTrigger = document.querySelector('button[aria-label="界面与字体设置"]');
    const dialog = document.querySelector('#ui-settings-dialog[role="dialog"][aria-modal="true"]');
    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const firstFocusable = dialog?.querySelector(focusableSelector);
    const range = dialog?.querySelector('#ui-font-scale-range');
    const number = dialog?.querySelector('#ui-font-scale-number');
    const group = dialog?.querySelector('[role="group"][aria-label="界面字体大小"]');
    const buttonTexts = [...(dialog?.querySelectorAll('button') || [])]
      .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(Boolean);
    return {
      triggerFound: true,
      triggerTitle: activeTrigger?.getAttribute('title') || '',
      triggerControls: activeTrigger?.getAttribute('aria-controls') || '',
      triggerHasPopup: activeTrigger?.getAttribute('aria-haspopup') || '',
      triggerExpanded: activeTrigger?.getAttribute('aria-expanded') || '',
      dialogFound: Boolean(dialog),
      heading: dialog?.querySelector('#ui-settings-title')?.textContent?.trim() || '',
      describedBy: dialog?.getAttribute('aria-describedby') || '',
      groupFound: Boolean(group),
      range: range ? { min: range.min, max: range.max, step: range.step, value: range.value } : null,
      number: number ? { min: number.min, max: number.max, step: number.step, value: number.value } : null,
      buttonTexts,
      focusedInsideDialog: Boolean(dialog?.contains(document.activeElement)),
      focusedFirstControl: Boolean(firstFocusable && firstFocusable === document.activeElement),
    };
  })()`);

  const initialOpen = await openFontSettings();
  if (
    !initialOpen.triggerFound
    || initialOpen.triggerTitle !== '界面与字体设置'
    || initialOpen.triggerControls !== 'ui-settings-dialog'
    || initialOpen.triggerHasPopup !== 'dialog'
    || initialOpen.triggerExpanded !== 'true'
    || !initialOpen.dialogFound
    || initialOpen.heading !== '界面设置'
    || initialOpen.describedBy !== 'ui-settings-description'
    || !initialOpen.groupFound
    || initialOpen.range?.min !== '80'
    || initialOpen.range?.max !== '130'
    || initialOpen.range?.step !== '5'
    || initialOpen.number?.min !== '80'
    || initialOpen.number?.max !== '130'
    || initialOpen.number?.step !== '1'
    || !['减小字体', '增大字体', '恢复默认字体', '完成'].every((label) => initialOpen.buttonTexts.includes(label))
    || !initialOpen.focusedInsideDialog
    || !initialOpen.focusedFirstControl
  ) {
    throw new Error(`Font settings accessibility check failed\n${JSON.stringify(initialOpen, null, 2)}`);
  }

  const buttonAdjustment = await evaluate(`(async () => {
    const findButton = (text) => [...document.querySelectorAll('#ui-settings-dialog button')]
      .find((button) => button.textContent?.trim() === text);
    findButton('恢复默认字体')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shell = () => document.querySelector('.app-shell');
    const afterReset = Number(shell()?.getAttribute('data-ui-font-scale'));
    findButton('增大字体')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterIncrease = Number(shell()?.getAttribute('data-ui-font-scale'));
    findButton('减小字体')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterDecrease = Number(shell()?.getAttribute('data-ui-font-scale'));
    return { afterReset, afterIncrease, afterDecrease };
  })()`);
  if (
    buttonAdjustment.afterReset !== 100
    || buttonAdjustment.afterIncrease !== 105
    || buttonAdjustment.afterDecrease !== 100
  ) {
    throw new Error(`Font settings step buttons failed\n${JSON.stringify(buttonAdjustment, null, 2)}`);
  }
  const layout100BeforeReload = await readFontSettingsLayout();
  assertFontSettingsLayout(layout100BeforeReload, 100, 'default');

  const numberAdjustment = await evaluate(`(async () => {
    const input = document.querySelector('#ui-font-scale-number');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '130');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  if (!numberAdjustment) throw new Error('Font settings number input was not found');
  const layout130 = await readFontSettingsLayout();
  assertFontSettingsLayout(layout130, 130, 'large');
  if (!(layout130.headingFontSize > layout100BeforeReload.headingFontSize)) {
    throw new Error(`130% font size did not grow\n${JSON.stringify({ layout100BeforeReload, layout130 }, null, 2)}`);
  }

  const fontSettingsScreenshot = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const fontSettingsFileName = '00-界面设置-130%.png';
  fs.writeFileSync(
    path.join(outputDirectory, fontSettingsFileName),
    Buffer.from(fontSettingsScreenshot.data, 'base64'),
  );

  const completed = await evaluate(`(async () => {
    const completeButton = [...document.querySelectorAll('#ui-settings-dialog button')]
      .find((button) => button.textContent?.trim() === '完成');
    completeButton?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const trigger = document.querySelector('button[aria-label="界面与字体设置"]');
    return {
      completeFound: Boolean(completeButton),
      dialogClosed: !document.querySelector('#ui-settings-dialog'),
      triggerFocused: trigger === document.activeElement,
      triggerExpanded: trigger?.getAttribute('aria-expanded') || '',
    };
  })()`);
  if (!completed.completeFound || !completed.dialogClosed || !completed.triggerFocused || completed.triggerExpanded !== 'false') {
    throw new Error(`Font settings completion/focus restoration failed\n${JSON.stringify(completed, null, 2)}`);
  }

  await waitForCondition({
    label: 'font settings persistence before reload',
    timeoutMs: appReadyTimeoutMs,
    check: () => evaluate(`(() => {
      const raw = localStorage.getItem('lianhua_video_director_state_v22');
      if (!raw) return false;
      try {
        return JSON.parse(raw)?.settings?.uiFontScalePercent === 130;
      } catch {
        return false;
      }
    })()`),
  });
  await reloadAndWaitForUiShell({
    expectedFontScale: 130,
    label: 'persisted font settings hydration after reload',
  });

  const persistedOpen = await openFontSettings();
  if (!persistedOpen.dialogFound || persistedOpen.range?.value !== '130' || persistedOpen.number?.value !== '130') {
    throw new Error(`Persisted font settings did not hydrate the controls\n${JSON.stringify(persistedOpen, null, 2)}`);
  }
  const layout130AfterReload = await readFontSettingsLayout();
  assertFontSettingsLayout(layout130AfterReload, 130, 'large');

  const rangeAdjustment = await evaluate(`(async () => {
    const input = document.querySelector('#ui-font-scale-range');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '80');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  if (!rangeAdjustment) throw new Error('Font settings range input was not found');
  const layout80 = await readFontSettingsLayout();
  assertFontSettingsLayout(layout80, 80, 'small');
  if (!(layout80.headingFontSize < layout100BeforeReload.headingFontSize)) {
    throw new Error(`80% font size did not shrink\n${JSON.stringify({ layout80, layout100BeforeReload }, null, 2)}`);
  }

  const restoredDefault = await evaluate(`(async () => {
    const resetButton = [...document.querySelectorAll('#ui-settings-dialog button')]
      .find((button) => button.textContent?.trim() === '恢复默认字体');
    resetButton?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Boolean(resetButton);
  })()`);
  if (!restoredDefault) throw new Error('Restore-default-font button was not found');
  const layout100 = await readFontSettingsLayout();
  assertFontSettingsLayout(layout100, 100, 'default');

  const preparedTabTrap = await evaluate(`(() => {
    const dialog = document.querySelector('#ui-settings-dialog');
    const focusable = [...(dialog?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    const last = focusable.at(-1);
    last?.focus();
    return { count: focusable.length, lastFocused: last === document.activeElement };
  })()`);
  if (preparedTabTrap.count < 2 || !preparedTabTrap.lastFocused) {
    throw new Error(`Could not prepare font-settings focus trap\n${JSON.stringify(preparedTabTrap, null, 2)}`);
  }
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await delay(50);
  const tabWrapped = await evaluate(`(() => {
    const dialog = document.querySelector('#ui-settings-dialog');
    const first = dialog?.querySelector('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    return Boolean(first && first === document.activeElement);
  })()`);
  if (!tabWrapped) throw new Error('Font settings Tab focus did not wrap from the last control to the first');

  await command('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await delay(50);
  const escaped = await evaluate(`(() => {
    const trigger = document.querySelector('button[aria-label="界面与字体设置"]');
    return {
      dialogClosed: !document.querySelector('#ui-settings-dialog'),
      triggerFocused: trigger === document.activeElement,
      triggerExpanded: trigger?.getAttribute('aria-expanded') || '',
      scalePercent: Number(document.querySelector('.app-shell')?.getAttribute('data-ui-font-scale')),
    };
  })()`);
  if (!escaped.dialogClosed || !escaped.triggerFocused || escaped.triggerExpanded !== 'false' || escaped.scalePercent !== 100) {
    throw new Error(`Font settings Escape/focus/default restoration failed\n${JSON.stringify(escaped, null, 2)}`);
  }
  await delay(250);

  report.fontSettings = {
    initialOpen,
    buttonAdjustment,
    completed,
    persisted: true,
    layout80,
    layout100,
    layout130: layout130AfterReload,
    tabWrapped,
    escaped,
    fileName: fontSettingsFileName,
  };
}

const pages = bootstrapOnly
  ? []
  : [
      ['项目总览', '项目总览'],
      ['图像工作台', '图像工作台'],
      ['分镜时间线', '分镜时间线'],
      ['资产库', '资产库'],
      ['生成任务', '生成任务'],
      ['API 设置', 'API 设置'],
    ];

for (const [navigation, heading] of pages) {
  const clicked = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim().includes(${JSON.stringify(navigation)})); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) {
    const diagnostic = await evaluate(`({ title: document.title, readyState: document.readyState, buttons: [...document.querySelectorAll('button')].map((item) => item.textContent?.trim()).slice(0, 30), text: (document.body?.innerText || '').slice(0, 1000) })`);
    throw new Error(`Navigation button not found: ${navigation}\n${JSON.stringify(diagnostic, null, 2)}\nConsole: ${consoleErrors.join(' | ')}`);
  }
  await delay(250);
  const metrics = await evaluate(`(() => {
    const main = document.querySelector('.main');
    const workspace = document.querySelector('.workspace');
    return {
      heading: document.querySelector('.topbar h1')?.textContent?.trim() || '',
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      workspaceOverflowX: workspace ? workspace.scrollWidth > workspace.clientWidth + 1 : false,
      mainWidth: main?.getBoundingClientRect().width || 0,
      visibleButtons: [...document.querySelectorAll('button')].filter((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).length,
      text: (workspace?.innerText || '').slice(0, 500),
    };
  })()`);
  if (metrics.heading !== heading) throw new Error(`Expected heading ${heading}, received ${metrics.heading}`);
  let topActionCards = null;
  let imageWorkbench = null;
  if (navigation === '项目总览') {
    topActionCards = await evaluate(`(() => {
      const expectedNames = ['项目库', '导入项目', '导出项目'];
      const buttons = [...document.querySelectorAll('.top-actions .top-action-card')];
      const results = expectedNames.map((name) => {
        const element = buttons.find((candidate) => candidate.textContent?.trim().startsWith(name));
        if (!element) return { name, found: false };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          name,
          found: true,
          visible: rect.width > 0 && rect.height > 0,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderTopColor,
          color: style.color,
        };
      });
      const frameSignatures = results
        .filter((item) => item.found)
        .map((item) => [item.backgroundColor, item.borderColor].join('|'));
      return {
        results,
        allVisible: results.every((item) => item.found && item.visible),
        distinctFrames: new Set(frameSignatures).size === expectedNames.length,
      };
    })()`);
    if (!topActionCards.allVisible || !topActionCards.distinctFrames) {
      throw new Error(`Top action card color check failed\n${JSON.stringify(topActionCards, null, 2)}`);
    }
  }
  if (navigation === '图像工作台') {
    imageWorkbench = await evaluate(`(async () => {
      const clickAssetKind = async (label) => {
        const button = [...document.querySelectorAll('.view-image button')]
          .find((candidate) => candidate.textContent?.trim() === label);
        button?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
      const readVariantLabels = () => [...document.querySelectorAll('.image-variant-row button')]
        .map((button) => button.textContent?.trim() || '');
      const readEntityActionLabels = () => [...document.querySelectorAll('.image-entity-actions button')]
        .map((button) => button.textContent?.trim() || '');
      const assetKindLabels = [...document.querySelectorAll('.image-asset-kind-tabs button')]
        .map((button) => button.textContent?.trim() || '');
      const retiredGridCreationEntryPresent = assetKindLabels.includes('九宫格')
        || Boolean(document.querySelector('.grid-workbench-guide'))
        || [...document.querySelectorAll('.view-image button')].some((button) =>
          /去生成或上传九宫格|绑定并返回导演台|返回九宫格导演|生成 3×3 九宫格|转换九宫格提示词/u.test(button.textContent || ''));
      await clickAssetKind('人物角色');
      const characterLabels = readVariantLabels();
      const characterEntityActions = readEntityActionLabels();
      await clickAssetKind('场景');
      const locationLabels = readVariantLabels();
      const locationEntityActions = readEntityActionLabels();
      await clickAssetKind('物品');
      const propLabels = readVariantLabels();
      const propEntityActions = readEntityActionLabels();
      await clickAssetKind('人物角色');

      const setInputValue = (input, value) => {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const waitForRender = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const fieldInput = (label) => [...document.querySelectorAll('.image-fields-grid .field')]
        .find((field) => field.querySelector(':scope > label')?.textContent?.trim() === label)
        ?.querySelector('input');
      const entitySelect = document.querySelector('.image-entity-controls select');
      const customRequirement = document.querySelector('.image-autofill-requirement');
      const saveButton = [...document.querySelectorAll('.image-entity-actions button')]
        .find((button) => button.textContent?.trim() === '保存');
      const entityName = 'UI回归角色-${viewportWidth}x${viewportHeight}-DPR${deviceScaleFactor}';
      const initialOptionCount = entitySelect?.options.length || 0;
      const initialNameInput = fieldInput('角色名称');
      const initialGenderInput = fieldInput('性别');
      const initialHeightInput = fieldInput('身高 / 高度');
      const initialStyleInput = fieldInput('视觉风格');
      if (initialNameInput) setInputValue(initialNameInput, entityName);
      if (initialGenderInput) setInputValue(initialGenderInput, '雌性灵兽（可化人形）');
      if (initialHeightInput) setInputValue(initialHeightInput, '约168cm');
      if (initialStyleInput) setInputValue(initialStyleInput, 'UI回归水墨风格');
      if (customRequirement) setInputValue(customRequirement, '保持冷色服装，重点补齐面部辨识特征');
      saveButton?.click();
      await waitForRender();
      const styleAfterCreate = fieldInput('视觉风格')?.value || '';
      const selectedAfterCreate = document.querySelector('.image-entity-controls select');
      const createdEntityId = selectedAfterCreate?.value || '';
      const createdOptionCount = selectedAfterCreate?.options.length || 0;
      const updateNameInput = fieldInput('角色名称');
      if (updateNameInput) setInputValue(updateNameInput, entityName + '-已保存');
      [...document.querySelectorAll('.image-entity-actions button')]
        .find((button) => button.textContent?.trim() === '保存')
        ?.click();
      await waitForRender();
      const selectedAfterUpdate = document.querySelector('.image-entity-controls select');
      const updatedOptionCount = selectedAfterUpdate?.options.length || 0;
      const updatedOptionText = selectedAfterUpdate?.selectedOptions[0]?.textContent?.trim() || '';
      [...document.querySelectorAll('.image-entity-actions button')]
        .find((button) => button.textContent?.trim() === '新增')
        ?.click();
      await waitForRender();
      const selectedAfterNew = document.querySelector('.image-entity-controls select');
      const nameAfterNew = fieldInput('角色名称')?.value || '';
      const entityNewClearedForm = selectedAfterNew?.value === '' && nameAfterNew === '';
      if (selectedAfterNew && createdEntityId) {
        const selectValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        selectValueSetter?.call(selectedAfterNew, createdEntityId);
        selectedAfterNew.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForRender();
      }
      const reloadedName = fieldInput('角色名称')?.value || '';
      const reloadedGender = fieldInput('性别')?.value || '';
      const reloadedHeight = fieldInput('身高 / 高度')?.value || '';
      const libraryReferenceButton = document.querySelector('button.image-library-reference-button');
      libraryReferenceButton?.click();
      await waitForRender();
      const referenceModal = document.querySelector('.reference-image-picker-modal');
      const referenceModalRect = referenceModal?.getBoundingClientRect();
      const arbitraryReferenceOption = referenceModal
        ? [...referenceModal.querySelectorAll('button.reference-image-picker-item')]
          .find((button) => button.textContent?.includes('QA任意职责图片'))
        : null;
      arbitraryReferenceOption?.click();
      await waitForRender();
      const confirmReferenceButton = referenceModal
        ? [...referenceModal.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === '使用所选图片')
        : null;
      confirmReferenceButton?.click();
      await waitForRender();
      const moreSettings = document.querySelector('.image-setting-references details.image-panel-capability');
      const moreSettingsSummary = moreSettings?.querySelector(':scope > summary');
      const moreSettingsDefaultCollapsed = Boolean(moreSettings && !moreSettings.open);
      moreSettingsSummary?.click();
      await waitForRender();
      const extraSettingsPanel = moreSettings?.querySelector(':scope > .image-panel-extra-popover');
      const extraSettingsRect = extraSettingsPanel?.getBoundingClientRect();
      const negativeInput = extraSettingsPanel?.querySelector('.image-negative-field input');
      const negativeRect = negativeInput?.getBoundingClientRect();
      const moreSettingsExpandable = Boolean(moreSettings?.open && extraSettingsRect && extraSettingsRect.width > 0 && extraSettingsRect.height > 0);
      const moreSettingsControlsVisible = Boolean(extraSettingsRect && negativeRect
        && extraSettingsRect.left >= -1 && extraSettingsRect.right <= innerWidth + 1
        && extraSettingsRect.top >= -1 && extraSettingsRect.bottom <= innerHeight + 1
        && negativeRect.width > 0 && negativeRect.height > 0
        && negativeRect.left >= extraSettingsRect.left - 1 && negativeRect.right <= extraSettingsRect.right + 1
        && negativeRect.top >= extraSettingsRect.top - 1 && negativeRect.bottom <= extraSettingsRect.bottom + 1
        && document.elementFromPoint(negativeRect.left + negativeRect.width / 2, negativeRect.top + negativeRect.height / 2) === negativeInput);
      moreSettingsSummary?.click();
      await waitForRender();
      const moreSettingsClosedAfterCheck = Boolean(moreSettings && !moreSettings.open);
      const selectedReferenceName = document.querySelector('.image-selected-reference-name')?.textContent?.trim() || '';
      const selectedReferencePreview = document.querySelector('.image-selected-reference-preview img');
      const useReferenceCheckbox = document.querySelector('input[name="use-reference-image-ordinary"]')
        || document.querySelector('input[name^="use-reference-image-"]');
      const actionBar = document.querySelector('.image-generate-row');
      const variantRow = document.querySelector('.image-variant-row-wrap .image-variant-row')
        || actionBar?.querySelector(':scope > .image-variant-row');
      const requirementInput = actionBar?.querySelector(':scope > .image-requirement-field .image-autofill-requirement');
      const actionGroup = actionBar?.querySelector(':scope > .image-generate-actions');
      const barRect = actionBar?.getBoundingClientRect();
      const barStyle = actionBar ? getComputedStyle(actionBar) : null;
      const barContentRight = barRect && barStyle
        ? barRect.right - (Number.parseFloat(barStyle.paddingRight) || 0) - (Number.parseFloat(barStyle.borderRightWidth) || 0)
        : null;
      const variantRect = variantRow?.getBoundingClientRect();
      const requirementRect = requirementInput?.getBoundingClientRect();
      const actionsRect = actionGroup?.getBoundingClientRect();
      const overlaps = (first, second) => Boolean(
        first
        && second
        && first.left < second.right - 1
        && first.right > second.left + 1
        && first.top < second.bottom - 1
        && first.bottom > second.top + 1
      );
      const selectionGrid = document.querySelector('.image-prompt-selection-grid');
      const rulesSection = selectionGrid?.closest('.image-setting-rules');
      const settingSections = [...document.querySelectorAll('.image-output-refined .image-generation-controls > .image-setting-section')];
      const settingSectionRects = settingSections.map((element) => element.getBoundingClientRect());
      const settingSectionsFound = settingSections.length === 4
        && settingSections[0] === rulesSection
        && settingSections[1].classList.contains('image-setting-references')
        && settingSections[2].classList.contains('image-setting-spec')
        && settingSections[3] === actionBar;
      const settingSectionsVisible = settingSectionRects.every((rect) => rect.width > 0 && rect.height > 0
        && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1);
      const settingSectionsOverlap = settingSectionRects.some((rect, index) => settingSectionRects.slice(index + 1).some((other) => overlaps(rect, other)));
      const settingSectionsOverflow = settingSections.some((element) => element.scrollWidth > element.clientWidth + 1);
      const duplicateResultsAbsent = !document.querySelector('.image-results-container, .image-generation-output-tabs, .image-batch-result-strip');
      const generationFieldsPreserved = Boolean(
        document.querySelector('.image-output-head .image-rule-manager-button')
        && selectionGrid?.querySelectorAll(':scope > .field select').length === 2
        && settingSections[1]?.querySelector('.image-upload-field input[type="file"]')
        && settingSections[1]?.querySelector('.image-library-reference-button')
        && settingSections[1]?.querySelector('input[name="use-reference-image-ordinary"]')
        && settingSections[2]?.querySelector('.image-generation-quantity-row select')
        && settingSections[2]?.querySelector('.image-output-size-controls')
        && settingSections[2]?.contains(variantRow)
        && extraSettingsPanel?.querySelector('.image-negative-field input')
        && requirementInput
        && actionGroup
      );
      const findPromptSelectionSelect = (label) => [...(selectionGrid?.querySelectorAll(':scope > .field') || [])]
        .find((field) => field.querySelector(':scope > label')?.textContent?.trim() === label)
        ?.querySelector('select');
      const readPromptSelectionSelect = (element) => {
        if (!element) {
          return {
            found: false,
            visible: false,
            operable: false,
            optionCount: 0,
            optionValues: [],
            hasNonEmptyOption: false,
          };
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        const lineHeight = style.lineHeight === 'normal'
          ? fontSize * 1.2
          : Number.parseFloat(style.lineHeight) || fontSize * 1.2;
        const contentHeight = rect.height
          - (Number.parseFloat(style.paddingTop) || 0)
          - (Number.parseFloat(style.paddingBottom) || 0)
          - (Number.parseFloat(style.borderTopWidth) || 0)
          - (Number.parseFloat(style.borderBottomWidth) || 0);
        const hitTarget = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        const nonEmptyOptions = [...element.options].filter(
          (option) => option.value.trim() !== '' && Boolean(option.textContent?.trim()),
        );
        return {
          found: element?.tagName === 'SELECT',
          visible: rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) > 0
            && rect.left >= -1
            && rect.right <= innerWidth + 1
            && rect.top >= -1
            && rect.bottom <= innerHeight + 1,
          operable: !element.disabled
            && style.pointerEvents !== 'none'
            && element.tabIndex >= 0
            && Boolean(hitTarget && (hitTarget === element || element.contains(hitTarget))),
          optionCount: element.options.length,
          optionValues: [...element.options].map((option) => option.value.trim()),
          nonEmptyOptionCount: nonEmptyOptions.length,
          hasNonEmptyOption: nonEmptyOptions.length > 0,
          contentHeight,
          requiredLineHeight: lineHeight,
          textFitsContentBox: contentHeight + 0.5 >= lineHeight,
        };
      };
      const ruleSelectElement = findPromptSelectionSelect('生图规则集');
      const presetSelectElement = findPromptSelectionSelect('分类预设');
      const ruleSelect = readPromptSelectionSelect(ruleSelectElement);
      const presetSelect = readPromptSelectionSelect(presetSelectElement);
      const selectionGridRect = selectionGrid?.getBoundingClientRect();
      const selectionGridContainer = rulesSection;
      const selectionGridContainerRect = selectionGridContainer?.getBoundingClientRect();
      const selectionGridStyle = selectionGrid ? getComputedStyle(selectionGrid) : null;
      const followingControls = [];
      // The rule selects now live in a named section; check the following
      // sibling sections instead of mistaking the wrapper for missing controls.
      let followingCandidate = rulesSection?.nextElementSibling || null;
      while (followingCandidate) {
        const followingStyle = getComputedStyle(followingCandidate);
        const followingRect = followingCandidate.getBoundingClientRect();
        if (
          followingStyle.display !== 'none'
          && followingStyle.visibility !== 'hidden'
          && Number(followingStyle.opacity) > 0
          && followingRect.width > 0
          && followingRect.height > 0
        ) followingControls.push({ element: followingCandidate, rect: followingRect });
        followingCandidate = followingCandidate.nextElementSibling;
      }
      const selectionGridVisible = Boolean(
        selectionGridRect
        && selectionGridStyle
        && selectionGridRect.width > 0
        && selectionGridRect.height > 0
        && selectionGridStyle.display !== 'none'
        && selectionGridStyle.visibility !== 'hidden'
        && Number(selectionGridStyle.opacity) > 0
        && selectionGridRect.left >= -1
        && selectionGridRect.right <= innerWidth + 1
        && selectionGridRect.top >= -1
        && selectionGridRect.bottom <= innerHeight + 1
      );
      const selectionGridInsideContainer = Boolean(
        selectionGridRect
        && selectionGridContainerRect
        && selectionGridRect.left >= selectionGridContainerRect.left - 1
        && selectionGridRect.right <= selectionGridContainerRect.right + 1
        && selectionGridRect.top >= selectionGridContainerRect.top - 1
        && selectionGridRect.bottom <= selectionGridContainerRect.bottom + 1
      );
      const selectionGridHorizontalOverflow = Boolean(
        selectionGrid && selectionGrid.scrollWidth > selectionGrid.clientWidth + 1
      );
      const selectionGridVerticalOverflow = Boolean(
        selectionGrid && selectionGrid.scrollHeight > selectionGrid.clientHeight + 1
      );
      const overlappingFollowingControls = followingControls.filter(
        ({ rect }) => overlaps(selectionGridRect, rect),
      );
      const followingControlsStartAfterGrid = Boolean(
        selectionGridRect
        && followingControls.length
        && followingControls.every(({ rect }) => rect.top >= selectionGridRect.bottom - 1)
      );
      const selectionGridOverlapsFollowingControl = overlappingFollowingControls.length > 0;
      const rectanglesOverlap = overlaps(variantRect, requirementRect)
        || overlaps(variantRect, actionsRect)
        || overlaps(requirementRect, actionsRect);
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        ruleSelect,
        presetSelect,
        selectionGridFound: Boolean(selectionGrid),
        selectionGridVisible,
        followingControlFound: followingControls.length > 0,
        followingControlCount: followingControls.length,
        followingControlsStartAfterGrid,
        selectionGridInsideContainer,
        selectionGridHorizontalOverflow,
        selectionGridVerticalOverflow,
        selectionGridOverlapsFollowingControl,
        overlappingFollowingControlCount: overlappingFollowingControls.length,
        settingSectionsFound,
        settingSectionsVisible,
        settingSectionsOverlap,
        settingSectionsOverflow,
        duplicateResultsAbsent,
        generationFieldsPreserved,
        moreSettingsDefaultCollapsed,
        moreSettingsExpandable,
        moreSettingsControlsVisible,
        moreSettingsClosedAfterCheck,
        actionBarFound: Boolean(actionBar),
        variantControlFound: Boolean(variantRow),
        variantControlVisible: Boolean(
          variantRect
          && variantRect.width > 0
          && variantRect.height > 0
          && variantRect.left >= -1
          && variantRect.right <= innerWidth + 1
          && variantRect.top >= -1
          && variantRect.bottom <= innerHeight + 1
        ),
        requirementInsideBottomBar: Boolean(requirementInput),
        requirementVisible: Boolean(requirementRect && requirementRect.width > 0 && requirementRect.height > 0),
        requirementValuePreserved: requirementInput?.value === '保持冷色服装，重点补齐面部辨识特征',
        actionGroupFound: Boolean(actionGroup),
        variantBeforeActions: Boolean(
          variantRow
          && actionGroup
          && (variantRow.compareDocumentPosition(actionGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
        ),
        requirementBeforeActions: Boolean(
          requirementInput
          && actionGroup
          && (requirementInput.compareDocumentPosition(actionGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
        ),
        actionGroupRightAligned: Boolean(
          barContentRight !== null
          && actionsRect
          && Math.abs(actionsRect.right - barContentRight) <= 2
        ),
        horizontalOverflow: Boolean(actionBar && actionBar.scrollWidth > actionBar.clientWidth + 1),
        rectanglesOverlap,
        characterLabels,
        locationLabels,
        propLabels,
        characterEntityActions,
        locationEntityActions,
        propEntityActions,
        assetKindLabels,
        retiredGridCreationEntryPresent,
        entityCreateSelected: Boolean(createdEntityId),
        entityCreateAddedOne: createdOptionCount === initialOptionCount + 1,
        entitySavePreservedStyle: styleAfterCreate === 'UI回归水墨风格',
        entityUpdateDidNotDuplicate: updatedOptionCount === createdOptionCount,
        entityUpdateVisible: updatedOptionText.startsWith(entityName + '-已保存'),
        entityNewClearedForm,
        entityReloadedSavedData: reloadedName === entityName + '-已保存',
        genderFieldFound: Boolean(initialGenderInput),
        entityReloadedSavedGender: reloadedGender === '雌性灵兽（可化人形）',
        heightFieldFound: Boolean(initialHeightInput),
        entityReloadedSavedHeight: reloadedHeight === '约168cm',
        libraryReferenceButtonFound: Boolean(libraryReferenceButton),
        referenceModalFound: Boolean(referenceModal),
        referenceModalInsideViewport: Boolean(
          referenceModalRect
          && referenceModalRect.left >= 0
          && referenceModalRect.top >= 0
          && referenceModalRect.right <= innerWidth
          && referenceModalRect.bottom <= innerHeight
        ),
        arbitraryRoleImageSelectable: Boolean(arbitraryReferenceOption),
        selectedReferenceName,
        selectedReferencePreviewVisible: Boolean(
          selectedReferencePreview
          && selectedReferencePreview.getBoundingClientRect().width > 0
          && selectedReferencePreview.getBoundingClientRect().height > 0
        ),
        selectedReferenceEnabledForGeneration: Boolean(useReferenceCheckbox?.checked),
        referenceModalClosedAfterConfirm: !document.querySelector('.reference-image-picker-modal'),
      };
    })()`);
    const expectedCharacter = ['头像', '半身', '全身', '四视图'];
    const expectedLocation = ['风景场景', '故事快照', '分镜首帧'];
    const expectedProp = ['图标', '特写', '展示图'];
    if (
      !imageWorkbench.ruleSelect.found
      || !imageWorkbench.ruleSelect.visible
      || !imageWorkbench.ruleSelect.operable
      || !imageWorkbench.ruleSelect.hasNonEmptyOption
      || !imageWorkbench.ruleSelect.textFitsContentBox
      || !imageWorkbench.presetSelect.found
      || !imageWorkbench.presetSelect.visible
      || !imageWorkbench.presetSelect.operable
      || !imageWorkbench.presetSelect.hasNonEmptyOption
      || !imageWorkbench.presetSelect.textFitsContentBox
      || !imageWorkbench.selectionGridFound
      || !imageWorkbench.selectionGridVisible
      || !imageWorkbench.followingControlFound
      || !imageWorkbench.followingControlsStartAfterGrid
      || !imageWorkbench.selectionGridInsideContainer
      || imageWorkbench.selectionGridHorizontalOverflow
      || imageWorkbench.selectionGridVerticalOverflow
      || imageWorkbench.selectionGridOverlapsFollowingControl
      || !imageWorkbench.settingSectionsFound
      || !imageWorkbench.settingSectionsVisible
      || imageWorkbench.settingSectionsOverlap
      || imageWorkbench.settingSectionsOverflow
      || !imageWorkbench.duplicateResultsAbsent
      || !imageWorkbench.generationFieldsPreserved
      || !imageWorkbench.moreSettingsDefaultCollapsed
      || !imageWorkbench.moreSettingsExpandable
      || !imageWorkbench.moreSettingsControlsVisible
      || !imageWorkbench.moreSettingsClosedAfterCheck
      || !imageWorkbench.actionBarFound
      || !imageWorkbench.variantControlFound
      || !imageWorkbench.variantControlVisible
      || !imageWorkbench.requirementInsideBottomBar
      || !imageWorkbench.requirementVisible
      || !imageWorkbench.requirementValuePreserved
      || !imageWorkbench.actionGroupFound
      || !imageWorkbench.variantBeforeActions
      || !imageWorkbench.requirementBeforeActions
      || !imageWorkbench.actionGroupRightAligned
      || imageWorkbench.horizontalOverflow
      || imageWorkbench.rectanglesOverlap
      || JSON.stringify(imageWorkbench.characterLabels) !== JSON.stringify(expectedCharacter)
      || JSON.stringify(imageWorkbench.locationLabels) !== JSON.stringify(expectedLocation)
      || JSON.stringify(imageWorkbench.propLabels) !== JSON.stringify(expectedProp)
      || JSON.stringify(imageWorkbench.characterEntityActions) !== JSON.stringify(['新增', '保存'])
      || JSON.stringify(imageWorkbench.locationEntityActions) !== JSON.stringify(['新增', '保存'])
      || JSON.stringify(imageWorkbench.propEntityActions) !== JSON.stringify(['新增', '保存'])
      || JSON.stringify(imageWorkbench.assetKindLabels) !== JSON.stringify(['人物角色', '场景', '物品', '分镜图'])
      || imageWorkbench.retiredGridCreationEntryPresent
      || !imageWorkbench.entityCreateSelected
      || !imageWorkbench.entitySavePreservedStyle
      || !imageWorkbench.entityCreateAddedOne
      || !imageWorkbench.entityUpdateDidNotDuplicate
      || !imageWorkbench.entityUpdateVisible
      || !imageWorkbench.entityNewClearedForm
      || !imageWorkbench.entityReloadedSavedData
      || !imageWorkbench.genderFieldFound
      || !imageWorkbench.entityReloadedSavedGender
      || !imageWorkbench.heightFieldFound
      || !imageWorkbench.entityReloadedSavedHeight
      || !imageWorkbench.libraryReferenceButtonFound
      || !imageWorkbench.referenceModalFound
      || !imageWorkbench.referenceModalInsideViewport
      || !imageWorkbench.arbitraryRoleImageSelectable
      || imageWorkbench.selectedReferenceName !== 'QA任意职责图片'
      || !imageWorkbench.selectedReferencePreviewVisible
      || !imageWorkbench.selectedReferenceEnabledForGeneration
      || !imageWorkbench.referenceModalClosedAfterConfirm
    ) {
      throw new Error(`Image workbench selector or bottom layout check failed\n${JSON.stringify(imageWorkbench, null, 2)}`);
    }
  }
  let apiSettings = null;
  if (navigation === 'API 设置') {
    await evaluate(`(async () => {
      const stage = document.querySelector('.settings-panel-stage');
      const backendLabel = stage
        ? [...stage.querySelectorAll('label')].find((element) => element.textContent?.trim() === '后端')
        : null;
      const backendSelect = backendLabel?.closest('.field')?.querySelector('select');
      if (!backendSelect || backendSelect.value === 'openai') return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      valueSetter?.call(backendSelect, 'openai');
      backendSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    apiSettings = await evaluate(`(async () => {
      const panelIds = ['image', 'text', 'vision', 'video', 'credentials'];
      const expectedLabels = ['图片 API', '文本 API', '视觉 API', '视频生成', '密码本'];
      const imageFieldRequirements = [
        { label: '启用图像生成接口', controlSelector: 'input[type="checkbox"]' },
        { label: '后端', controlSelector: 'select' },
        { label: '模型 / 工作流', controlSelector: 'input' },
        { label: 'API 地址', controlSelector: 'input' },
        { label: 'API 密钥', controlSelector: 'input' },
      ];
      const workspace = document.querySelector('.workspace');
      const settingsView = document.querySelector('.settings-view');
      const stage = document.querySelector('.settings-panel-stage');
      const buttons = [...document.querySelectorAll('[data-settings-panel]')];
      if (!workspace || !settingsView || !stage) return { missingWorkspace: true, panelResults: [] };
      const workspaceRect = workspace.getBoundingClientRect();
      const settingsRect = settingsView.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const isElementFullyVisible = (element, containerRect) => {
        if (!element || !containerRect) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) > 0
          && rect.left >= Math.max(0, containerRect.left) - 1
          && rect.right <= Math.min(window.innerWidth, containerRect.right) + 1
          && rect.top >= Math.max(0, containerRect.top) - 1
          && rect.bottom <= Math.min(window.innerHeight, containerRect.bottom) + 1;
      };
      const tabLabels = buttons.map((button) => button.textContent?.trim() || '');
      const tabsVisible = buttons.length === panelIds.length
        && buttons.every((button) => isElementFullyVisible(button, workspaceRect));
      const imageButton = buttons.find((item) => item.getAttribute('data-settings-panel') === 'image');
      const defaultContent = stage.firstElementChild;
      const defaultImagePanelActive = stage?.getAttribute('data-active-panel') === 'image';
      const defaultImageTabSelected = imageButton?.getAttribute('aria-selected') === 'true';
      const defaultImagePanelVisible = isElementFullyVisible(defaultContent, stageRect);
      const panelResults = [];
      let imageFieldResults = [];
      let imageFieldsVisible = false;
      for (const panelId of panelIds) {
        const button = buttons.find((item) => item.getAttribute('data-settings-panel') === panelId);
        if (!button) {
          panelResults.push({ panelId, missingButton: true });
          continue;
        }
        workspace.scrollTop = 0;
        workspace.scrollLeft = 0;
        button.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stage = document.querySelector('.settings-panel-stage');
        const content = stage?.firstElementChild;
        const stageRect = stage?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        const documentRoot = document.documentElement;
        const videoSettings = panelId === 'video'
          && stage?.getAttribute('data-active-panel') === 'video'
          ? stage.querySelector(':scope > .video-generation-settings')
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
        const videoCommonCards = videoSettings ? [...videoSettings.querySelectorAll(':scope > .vgs-main > .vgs-card')] : [];
        const videoCommonCardsVisible = panelId !== 'video' || Boolean(
          videoSettings?.classList.contains('video-settings-redesign')
          && videoCommonCards.length >= 2
          && videoCommonCards.every((card) => isElementFullyVisible(card, stageRect))
        );
        const videoAdvancedEditorsDeferred = panelId !== 'video' || Boolean(
          videoSettings
          && !videoSettings.querySelector('textarea, .vgs-api-dialog, .vwm-dialog')
          && !document.querySelector('.vwm-dialog')
        );
        const renderedDescendants = stage
          ? [...stage.querySelectorAll('*')].filter((element) => {
              const closedDetails = element.closest('details:not([open])');
              const visibleSummary = closedDetails?.querySelector(':scope > summary');
              if (closedDetails && !visibleSummary?.contains(element)) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            })
          : [];
        const descendantClippedX = stageRect
          ? renderedDescendants.some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left < stageRect.left - 1
                || rect.right > stageRect.right + 1
                || rect.left < -1
                || rect.right > window.innerWidth + 1;
            })
          : true;
        const descendantClippedY = stageRect
          ? renderedDescendants.some((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.top < stageRect.top - 1
                || rect.bottom > stageRect.bottom + 1
                || rect.top < -1
                || rect.bottom > window.innerHeight + 1
              );
            })
          : true;
        const internalOverflowX = stage
          ? [...stage.querySelectorAll('*')].some((element) => {
              const style = getComputedStyle(element);
              return ['auto', 'scroll'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
            })
          : true;
        const internalOverflowY = stage
          ? [...stage.querySelectorAll('*')].some((element) => {
              const style = getComputedStyle(element);
              return ['auto', 'scroll'].includes(style.overflowY)
                && element.scrollHeight > element.clientHeight + 1;
            })
          : true;
        if (panelId === 'image') {
          const labelElements = stage ? [...stage.querySelectorAll('label')] : [];
          imageFieldResults = imageFieldRequirements.map((requirement) => {
            const labelElement = labelElements.find((element) => element.textContent?.trim() === requirement.label);
            const fieldContainer = labelElement?.closest('.field, .check-row');
            const controlElement = fieldContainer?.querySelector(requirement.controlSelector);
            return {
              label: requirement.label,
              labelFound: Boolean(labelElement),
              controlFound: Boolean(controlElement),
              labelVisible: isElementFullyVisible(labelElement, stageRect),
              controlVisible: isElementFullyVisible(controlElement, stageRect),
              controlTag: controlElement?.tagName?.toLowerCase() || '',
              controlType: controlElement?.getAttribute('type') || '',
            };
          });
          imageFieldsVisible = imageFieldResults.every((field) => field.labelVisible && field.controlVisible);
        }
        panelResults.push({
          panelId,
          active: stage?.getAttribute('data-active-panel') === panelId,
          contentVisible: Boolean(contentRect && contentRect.width > 0 && contentRect.height > 0),
          contentInsideStage: Boolean(
            stageRect
            && contentRect
            && contentRect.left >= stageRect.left - 1
            && contentRect.right <= stageRect.right + 1
            && contentRect.top >= stageRect.top - 1
            && contentRect.bottom <= stageRect.bottom + 1
          ),
          documentOverflowX: documentRoot.scrollWidth > documentRoot.clientWidth + 1,
          documentOverflowY: documentRoot.scrollHeight > documentRoot.clientHeight + 1,
          workspaceOverflowX: workspace.scrollWidth > workspace.clientWidth + 1,
          workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
          stageOverflowX: Boolean(stage && stage.scrollWidth > stage.clientWidth + 1),
          stageOverflowY: Boolean(stage && stage.scrollHeight > stage.clientHeight + 1),
          contentOverflowX: Boolean(content && content.scrollWidth > content.clientWidth + 1),
          contentOverflowY: Boolean(content && content.scrollHeight > content.clientHeight + 1),
          internalOverflowX,
          internalOverflowY,
          descendantClippedX,
          descendantClippedY,
          videoSettingsOverflowContained,
          videoSettingsInsideStage,
          videoSettingsFitsWithoutScroll,
          videoDetailsCollapsed,
          videoCommonCardsVisible,
          videoAdvancedEditorsDeferred,
          workspaceScrollTop: workspace.scrollTop,
          workspaceScrollLeft: workspace.scrollLeft,
        });
      }
      imageButton?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        missingWorkspace: false,
        tabLabels,
        labelsCorrect: expectedLabels.every((label, index) => tabLabels[index] === label),
        tabsVisible,
        defaultImagePanelActive,
        defaultImageTabSelected,
        defaultImagePanelVisible,
        imageFieldResults,
        imageFieldsVisible,
        settingsInsideWorkspace: settingsRect.left >= workspaceRect.left - 1
          && settingsRect.right <= workspaceRect.right + 1
          && settingsRect.top >= workspaceRect.top - 1
          && settingsRect.bottom <= workspaceRect.bottom + 1,
        settingsInsideViewport: settingsRect.left >= -1
          && settingsRect.right <= window.innerWidth + 1
          && settingsRect.top >= -1
          && settingsRect.bottom <= window.innerHeight + 1,
        workspaceOverflowX: workspace.scrollWidth > workspace.clientWidth + 1,
        workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
        panelResults,
      };
    })()`);
    const invalidPanel = apiSettings.panelResults.find((panel) =>
      panel.missingButton
      || !panel.active
      || !panel.contentVisible
      || !panel.contentInsideStage
      || panel.documentOverflowX
      || panel.documentOverflowY
      || panel.workspaceOverflowX
      || panel.workspaceOverflowY
      || panel.stageOverflowX
      || panel.stageOverflowY
      || panel.contentOverflowX
      || panel.contentOverflowY
      || panel.internalOverflowX
      || panel.internalOverflowY
      || panel.descendantClippedX
      || panel.descendantClippedY
      || !panel.videoSettingsOverflowContained
      || !panel.videoSettingsInsideStage
      || !panel.videoSettingsFitsWithoutScroll
      || !panel.videoDetailsCollapsed
      || !panel.videoCommonCardsVisible
      || !panel.videoAdvancedEditorsDeferred
      || panel.workspaceScrollTop !== 0
      || panel.workspaceScrollLeft !== 0
    );
    if (
      apiSettings.missingWorkspace
      || !apiSettings.labelsCorrect
      || !apiSettings.tabsVisible
      || !apiSettings.defaultImagePanelActive || !apiSettings.defaultImageTabSelected
      || !apiSettings.defaultImagePanelVisible
      || !apiSettings.imageFieldsVisible
      || !apiSettings.settingsInsideWorkspace
      || !apiSettings.settingsInsideViewport
      || apiSettings.workspaceOverflowX
      || apiSettings.workspaceOverflowY
      || invalidPanel
    ) {
      throw new Error(`API settings single-screen check failed\n${JSON.stringify(apiSettings, null, 2)}`);
    }
    const comfyUiSettings = await evaluate(`(async () => {
      const stage = document.querySelector('.settings-panel-stage');
      const workspace = document.querySelector('.workspace');
      const backendLabel = stage
        ? [...stage.querySelectorAll('label')].find((element) => element.textContent?.trim() === '后端')
        : null;
      const backendSelect = backendLabel?.closest('.field')?.querySelector('select');
      if (!stage || !workspace || !backendSelect) return { missingBackend: true };
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      valueSetter?.call(backendSelect, 'comfyui');
      backendSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const stageRect = stage.getBoundingClientRect();
      const card = stage.firstElementChild;
      const cardRect = card?.getBoundingClientRect();
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.left >= stageRect.left - 1
          && rect.right <= stageRect.right + 1
          && rect.top >= stageRect.top - 1
          && rect.bottom <= stageRect.bottom + 1;
      };
      const expectedLabels = [
        'ComfyUI API 根地址',
        'API 密钥（可选）',
        '接口路径模式',
        '提交路径',
        '当前 Workflow',
        'Workflow 操作',
        '允许访问本机与局域网模型端点',
      ];
      const labels = [...stage.querySelectorAll('label, .field > span')];
      const fieldResults = expectedLabels.map((label) => {
        const element = labels.find((candidate) => candidate.textContent?.trim() === label);
        return { label, found: Boolean(element), visible: visible(element) };
      });
      const modelFieldHidden = ![...stage.querySelectorAll('label')]
        .some((element) => element.textContent?.trim() === '模型 / 工作流');
      const promptPathVisible = [...stage.querySelectorAll('input')]
        .some((input) => input.value === '/prompt' && visible(input));
      const summaryVisible = [...stage.querySelectorAll('.hint-box')]
        .some((element) => element.textContent?.includes('当前实际生效') && visible(element));
      const managerButton = [...stage.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '管理 Workflow');
      managerButton?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const modal = document.querySelector('.comfyui-settings .modal-backdrop:not([hidden]) .modal');
      const modalRect = modal?.getBoundingClientRect();
      const textarea = modal?.querySelector('textarea');
      const modalInsideViewport = Boolean(
        modalRect
        && modalRect.left >= -1
        && modalRect.right <= window.innerWidth + 1
        && modalRect.top >= -1
        && modalRect.bottom <= window.innerHeight + 1
      );
      const modalHasWorkflowTools = Boolean(
        modal?.textContent?.includes('新增工作流')
        && modal.textContent.includes('删除当前')
        && modal.textContent.includes('__PROMPT__')
        && modal.textContent.includes('__NEGATIVE_PROMPT__')
        && modal.textContent.includes('__CFG__')
        && textarea
        && textarea.getBoundingClientRect().height > 0
      );
      return {
        missingBackend: false,
        fieldResults,
        modelFieldHidden,
        promptPathVisible,
        summaryVisible,
        cardInsideStage: Boolean(
          cardRect
          && cardRect.left >= stageRect.left - 1
          && cardRect.right <= stageRect.right + 1
          && cardRect.top >= stageRect.top - 1
          && cardRect.bottom <= stageRect.bottom + 1
        ),
        stageOverflowX: stage.scrollWidth > stage.clientWidth + 1,
        stageOverflowY: stage.scrollHeight > stage.clientHeight + 1,
        cardOverflowX: Boolean(card && card.scrollWidth > card.clientWidth + 1),
        cardOverflowY: Boolean(card && card.scrollHeight > card.clientHeight + 1),
        workspaceOverflowX: workspace.scrollWidth > workspace.clientWidth + 1,
        workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
        modalFound: Boolean(modal),
        modalInsideViewport,
        modalHasWorkflowTools,
      };
    })()`);
    apiSettings.comfyUi = comfyUiSettings;
    if (
      comfyUiSettings.missingBackend
      || !comfyUiSettings.fieldResults?.every((field) => field.found && field.visible)
      || !comfyUiSettings.modelFieldHidden
      || !comfyUiSettings.promptPathVisible
      || !comfyUiSettings.summaryVisible
      || !comfyUiSettings.cardInsideStage
      || comfyUiSettings.stageOverflowX
      || comfyUiSettings.stageOverflowY
      || comfyUiSettings.cardOverflowX
      || comfyUiSettings.cardOverflowY
      || comfyUiSettings.workspaceOverflowX
      || comfyUiSettings.workspaceOverflowY
      || !comfyUiSettings.modalFound
      || !comfyUiSettings.modalInsideViewport
      || !comfyUiSettings.modalHasWorkflowTools
    ) {
      throw new Error(`ComfyUI settings layout check failed\n${JSON.stringify(comfyUiSettings, null, 2)}`);
    }
    const managerScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const managerFileName = `${String(report.pages.length + 1).padStart(2, '0')}-ComfyUI-Workflow管理.png`;
    fs.writeFileSync(path.join(outputDirectory, managerFileName), Buffer.from(managerScreenshot.data, 'base64'));
    apiSettings.comfyUi.managerFileName = managerFileName;
    await evaluate(`(async () => {
      const modal = document.querySelector('.comfyui-settings .modal-backdrop:not([hidden]) .modal');
      const closeButton = modal
        ? [...modal.querySelectorAll('button')].find((button) => button.textContent?.trim() === '关闭')
        : null;
      closeButton?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  }
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const fileName = `${String(report.pages.length + 1).padStart(2, '0')}-${navigation}.png`;
  fs.writeFileSync(path.join(outputDirectory, fileName), Buffer.from(screenshot.data, 'base64'));
  report.pages.push({ navigation, fileName, ...metrics, topActionCards, imageWorkbench, apiSettings });
}

if (!bootstrapOnly) {
  report.storyboardShotPicker = await runStoryboardShotPickerRegression({
    evaluate,
    command,
    reload: reloadAndWaitForUiShell,
    capture: async (label) => {
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const fileName = `${label}-${viewportWidth}x${viewportHeight}.png`;
      fs.writeFileSync(path.join(outputDirectory, fileName), Buffer.from(screenshot.data, 'base64'));
      return fileName;
    },
  });
}

if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(' | ')}`);
if (report.pages.some((page) => page.bodyOverflowX || page.workspaceOverflowX)) throw new Error('Horizontal overflow detected');
} finally {
  failPending('UI smoke finished');
  socket.close();
}
};

await runWithPersistentQaReport(outputDirectory, report, runUiSmoke);
console.log(JSON.stringify(report, null, 2));
