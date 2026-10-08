import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Focused release check: the real portable EXE, a new isolated profile, and
// startup/navigation and rule selection only. Never reset an existing directory
// or submit AI jobs.
const root = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'));
const configuredExecutable = String(process.env.APP_EXECUTABLE || '').trim();
assert.ok(configuredExecutable, 'APP_EXECUTABLE must point to the real portable EXE');
const executable = fs.realpathSync.native(path.resolve(configuredExecutable));
assert.ok(fs.statSync(executable).isFile() && /\.exe$/iu.test(executable), 'APP_EXECUTABLE must be an EXE');
assert.ok(!/(?:^|[\\/])(?:node_modules|win-unpacked)(?:[\\/]|$)/iu.test(executable)
  && path.basename(executable).toLowerCase() !== 'electron.exe', 'Use the portable EXE, not development Electron or win-unpacked');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const qaRoot = fs.mkdtempSync(path.join(root, `.qa-packaged-cold-start-${expectedVersion}-`));
const dataDirectory = path.join(qaRoot, 'profile');
const outputDirectory = path.join(qaRoot, 'output');
fs.mkdirSync(dataDirectory);
fs.mkdirSync(outputDirectory);
// A non-runtime entry prevents Electron's empty-profile legacy-data import.
fs.writeFileSync(path.join(dataDirectory, '.qa-isolated-profile'), 'Isolated packaged cold-start QA only\n', { flag: 'wx' });
const normalizePath = (value) => path.resolve(value).toLowerCase();
const port = await findAvailableTcpPort();
const cdpUrl = `http://127.0.0.1:${port}`;
const environment = { ...process.env, LIANHUA_DATA_DIR: dataDirectory };
for (const key of ['ELECTRON_START_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LIANHUA_QA_MODE']) delete environment[key];
const child = spawn(executable, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], {
  cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'packaged cold-start QA', runTimeoutMs: 150_000, closeTimeoutMs: 15_000 });
let browser;
let page;
let cdp;
let closedGracefully = false;
const errors = { runtime: [], page: [], console: [], rendererLog: [], externalRequests: [] };
const navigation = [];
const screenshots = [];
const imagePromptSelections = [];
const report = { executable, expectedVersion, dataDirectory, outputDirectory, launcherPid: child.pid, navigation, screenshots, imagePromptSelections, errors };
const rendererLogPath = path.join(dataDirectory, 'logs', 'renderer.log');
const collectRendererLog = () => {
  if (!fs.existsSync(rendererLogPath)) return;
  const content = fs.readFileSync(rendererLogPath, 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'renderer.log'), content);
  errors.rendererLog = content.split(/\r?\n/u).filter((line) => /console level=(?:error|3)\b|did-fail-load|render-process-gone|initial-load failed:/u.test(line));
};
const screenshot = async (name) => {
  await page.screenshot({ path: path.join(outputDirectory, name), fullPage: false });
  screenshots.push(name);
};

const run = async () => {
  await waitForCondition({ label: 'portable EXE debugging endpoint', timeoutMs: 90_000, intervalMs: 200, check: async () => {
    try { return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  const context = browser.contexts()[0];
  assert.ok(context, 'Portable EXE must expose its default renderer context');
  await waitForCondition({ label: 'portable renderer page', timeoutMs: 15_000, intervalMs: 100, check: () => {
    page = context.pages().find((candidate) => candidate.url().startsWith('file:')) || context.pages()[0];
    return Boolean(page);
  } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()); });
  await context.route(/^https?:\/\//u, async (route) => {
    errors.externalRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  cdp = await context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.runtime.push(exceptionDetails.exception?.description || exceptionDetails.text));
  await cdp.send('Runtime.enable');
  await page.locator('.app-shell .sidebar .nav-item').first().waitFor({ timeout: 30_000 });
  assert.match(page.url(), /^file:.*[\\/]resources[\\/]app\.asar[\\/]dist[\\/]index\.html$/iu,
    'The renderer must load bundled production files from app.asar');
  report.rendererUrl = page.url();
  const connectedDataRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
  assert.equal(normalizePath(connectedDataRoot), normalizePath(dataDirectory), 'The EXE must use only the fresh QA profile');
  report.isolatedProfileConfirmed = true;
  report.actualVersion = (await page.locator('.sidebar-version > span:last-child').innerText()).trim();
  assert.equal(report.actualVersion, `v${expectedVersion}`);
  await screenshot('01-startup.png');

  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.locator('.story-input-actions').getByRole('button', { name: /^AI\s*画面描述转化$/u }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: /^AI\s*剧情优化$/u }).count(), 0);
  navigation.push('剧情解析：AI画面描述转化按钮');
  await screenshot('02-story-visual-conversion.png');

  await page.locator('.sidebar').getByRole('button', { name: '规则中心', exact: true }).click();
  await page.locator('.rules-view').waitFor({ state: 'visible' });
  await page.locator('.rule-tabs').getByRole('button', { name: /剧情处理规则/u }).click();
  await page.locator('.rule-tab.active').getByText('剧情处理规则', { exact: true }).waitFor();
  assert.ok((await page.locator('.rules-view .rule-editor').innerText()).trim().length > 30, 'The story-processing rule editor must render');
  navigation.push('规则中心：剧情处理规则');
  await screenshot('03-story-rules.png');

  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  const workbench = page.locator('.image-view');
  await workbench.waitFor({ state: 'visible' });
  const ruleSelect = workbench.getByRole('combobox', { name: '生图规则集', exact: true });
  const presetSelect = workbench.getByRole('combobox', { name: '分类预设', exact: true });
  for (const [index, family] of ['google-nano-banana', 'grok-imagine'].entries()) {
    await workbench.locator('.image-asset-kind-tabs').getByRole('button', { name: '人物角色', exact: true }).click();
    await workbench.getByRole('tab', { name: '普通生图', exact: true }).click();
    await workbench.getByRole('group', { name: '选择普通生图画面规格', exact: true })
      .getByRole('button', { name: '头像', exact: true }).click();
    const ruleId = `image-rule-${family}`;
    const presetPrefix = `image-preset-${family}-`;
    await ruleSelect.selectOption(ruleId);
    assert.equal(await ruleSelect.inputValue(), ruleId, `${family}: ordinary rule selection must be retained`);
    const characterPresetIds = await presetSelect.locator('option').evaluateAll((options, prefix) =>
      options.map((option) => option.value).filter((value) => value.startsWith(prefix)).sort(), presetPrefix);
    assert.deepEqual(characterPresetIds, [`${presetPrefix}character`, `${presetPrefix}multi-person-character`],
      `${family}: both ordinary character presets must be available`);
    for (const presetId of characterPresetIds) {
      await presetSelect.selectOption(presetId);
      assert.equal(await presetSelect.inputValue(), presetId, `${family}: character preset selection must be retained`);
    }
    await workbench.getByRole('group', { name: '选择普通生图画面规格', exact: true })
      .getByRole('button', { name: '五视图', exact: true }).click();
    const fiveViewPresetId = `${presetPrefix}five-view`;
    await presetSelect.selectOption(fiveViewPresetId);
    assert.equal(await ruleSelect.inputValue(), ruleId, `${family}: changing the frame specification must retain the chosen rule`);
    assert.equal(await presetSelect.inputValue(), fiveViewPresetId, `${family}: its five-view preset must be selectable`);
    assert.equal(await workbench.getByRole('tab', { name: '普通生图', exact: true }).getAttribute('aria-selected'), 'true');
    imagePromptSelections.push({ ruleId, characterPresetIds, fiveViewPresetId });
    navigation.push(`图像工作台：${family} 普通人物与五视图预设`);
    await presetSelect.scrollIntoViewIfNeeded();
    await screenshot(`0${index + 4}-${family}-five-view.png`);
  }
  collectRendererLog();
  for (const [kind, entries] of Object.entries(errors)) assert.deepEqual(entries, [], `${kind} must contain no startup/navigation/selection errors`);
  harness.markElectronStopping();
  await page.evaluate(() => { setTimeout(() => window.close(), 0); });
  await harness.waitForElectronClose();
  assert.equal(child.exitCode, 0, 'Portable EXE must exit normally after closing its window');
  closedGracefully = true;
};

let failure;
// A failed renderer may disappear before CDP acknowledges detach. Keep the
// original failure/report observable instead of leaving top-level await hung.
const closeConnection = async (close) => {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(close).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 2500); }),
    ]);
  } finally { clearTimeout(timer); }
};
try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
} finally {
  harness.markElectronStopping();
  // Only the EXE process we spawned and its children are eligible for fallback
  // termination; no executable-name matching or existing app processes.
  try { await harness.stopAll(); } catch (error) { failure ||= error; }
  await closeConnection(() => cdp?.detach());
  await closeConnection(() => browser?.close());
  collectRendererLog();
  if (!failure && Object.values(errors).some((entries) => entries.length)) failure = new Error('Runtime or renderer errors were recorded during shutdown');
  fs.writeFileSync(path.join(outputDirectory, 'process.log'), harness.readElectronLog());
  Object.assign(report, { passed: !failure, closedGracefully, exitCode: child.exitCode, noGenerationSubmitted: true, ...(failure ? { failure: String(failure) } : {}) });
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
