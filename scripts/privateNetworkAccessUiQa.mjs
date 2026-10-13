import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Mount the real App in a fresh browser context. Every desktop bridge method is
// synthetic; full recovery starts pending and can deliver stale metadata. No user files,
// credentials, model endpoints, uploads or paid tasks are accessed.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `private-network-access-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output cannot traverse links'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(output, { recursive: true });

const fixturePath = '/__private_network_access_qa__.html';
const stateKey = 'lianhua_video_director_state_v22';
const recoveryKey = '__private_network_access_saved_recovery__';
const auditKey = '__private_network_access_audit__';
const phaseKey = '__private_network_access_phase__';
const errors = []; const blockedRequests = []; const stages = [];
const server = await createServer({ root, configFile: false, plugins: [react()], optimizeDeps: { entries: ['src/main.tsx'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
server.middlewares.use((request, response, next) => {
  if (request.url?.split('?')[0] !== fixturePath) return next();
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Private-network real App QA</title>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="root"></div><script type="module">
    import { createInitialState, STORAGE_KEY } from '/src/storage.ts';
    if (!localStorage.getItem(STORAGE_KEY)) {
      const state = createInitialState();
      state.project.name = '本机网络权限隔离验证';
      state.settings.uiFontScalePercent = 100;
      for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
      state.settings.textApiProfiles = []; state.settings.visionApiProfiles = []; state.settings.imageApiProfiles = []; state.settings.videoApiProfiles = []; state.settings.apiCredentialBook = [];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    await import('/src/main.tsx');
    </script></body></html>`);
});

let browser; let context; let page; let origin; let deadline;
const audit = () => page.evaluate(() => window.__privateNetworkQa.readAudit());
const permission = () => page.getByRole('checkbox', { name: '允许访问本机与局域网模型端点', exact: true });
const settingsTabs = () => page.getByRole('tablist', { name: 'API 设置分类', exact: true });
const selectPanel = async (name) => {
  await settingsTabs().getByRole('tab', { name, exact: true }).click();
  await permission().waitFor({ state: 'visible' });
};
const waitChecked = (checked) => page.waitForFunction(({ label, expected }) => {
  const matching = [...document.querySelectorAll('input[type="checkbox"]')].filter(input => [...(input.labels || [])].some(item => item.textContent.trim() === label));
  return matching.length === 1 && matching[0].checked === expected;
}, { label: '允许访问本机与局域网模型端点', expected: checked });
const waitNotice = async (text, error = false) => {
  const notice = page.locator('.sidebar-notice');
  await page.waitForFunction(({ expected, isError }) => {
    const node = document.querySelector('.sidebar-notice');
    return node?.textContent.includes(expected) && node.classList.contains('error') === isError;
  }, { expected: text, isError: error });
  assert.ok((await notice.innerText()).includes(text));
};
const toggle = async (expected, { fail = false, returned } = {}) => {
  const before = (await audit()).updates.length;
  if (fail) await page.evaluate(() => { window.__privateNetworkQa.failNextUpdate = true; });
  if (returned !== undefined) await page.evaluate(value => { window.__privateNetworkQa.nextReturnedValue = value; }, returned);
  await permission().click();
  await page.waitForFunction(count => window.__privateNetworkQa.readAudit().updates.length === count, before + 1);
  const accepted = returned ?? expected;
  await waitNotice(fail ? '隔离测试：本机网络权限保存失败' : accepted ? '已允许访问本机与局域网模型端点' : '已关闭本机与局域网模型端点访问', fail);
  await waitChecked(fail ? !expected : accepted);
  const update = (await audit()).updates.at(-1);
  assert.deepEqual(update.patch, { allowPrivateNetwork: expected });
  assert.equal(update.ok, !fail);
};

async function run() {
  await server.listen();
  const address = server.httpServer.address();
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(({ recoveryKey, auditKey, phaseKey }) => {
    const recoveryDefault = { allowPrivateNetwork: false, backupDirectory: '', backupOnSave: false, keepCount: 20 };
    if (!sessionStorage.getItem(recoveryKey)) sessionStorage.setItem(recoveryKey, JSON.stringify(recoveryDefault));
    if (!sessionStorage.getItem(auditKey)) sessionStorage.setItem(auditKey, JSON.stringify({ fullRecoveryRequests: 0, fullRecoveryCompleted: 0, storageRequests: 0, storageDelivered: 0, updates: [], modelRequests: [], projectReads: 0 }));
    const readAudit = () => JSON.parse(sessionStorage.getItem(auditKey));
    const changeAudit = (change) => { const current = readAudit(); change(current); sessionStorage.setItem(auditKey, JSON.stringify(current)); };
    const readRecovery = () => JSON.parse(sessionStorage.getItem(recoveryKey));
    const paths = (recovery) => ({ dataRoot: 'QA-only', sessionData: 'QA-only/session', cache: 'QA-only/cache', temp: 'QA-only/temp', logs: 'QA-only/logs', assets: 'QA-only/assets', snapshots: 'QA-only/snapshots', encryptionAvailable: true, recovery });
    const pendingPaths = []; const pendingRecovery = [];
    const qa = window.__privateNetworkQa = { readAudit, readRecovery, failNextUpdate: false, pendingPaths,
      pendingRecovery,
      resolveStoragePaths: () => { const pending = pendingPaths.splice(0); for (const resolve of pending) resolve(); return pending.length; },
      resolveFullRecovery: () => { const pending = pendingRecovery.splice(0); for (const resolve of pending) resolve(); return pending.length; } };
    window.lianhuaDesktop = {
      recoveryStatus: async () => {
        const captured = { ...readRecovery() };
        changeAudit(current => { current.fullRecoveryRequests += 1; });
        return new Promise(resolve => pendingRecovery.push(() => {
          changeAudit(current => { current.fullRecoveryCompleted += 1; });
          resolve({ dataRoot: 'QA-only', stateFile: 'QA-only/project.json', stateValid: true, stateChecksum: 'fixture', stateSize: 1, snapshots: [], recovery: captured, encryptionAvailable: true });
        }));
      },
      storagePaths: async () => {
        const captured = { ...readRecovery() };
        changeAudit(current => { current.storageRequests += 1; });
        const deliver = () => { changeAudit(current => { current.storageDelivered += 1; }); return paths(captured); };
        if (sessionStorage.getItem(phaseKey) === 'immediate') return deliver();
        return new Promise(resolve => pendingPaths.push(() => resolve(deliver())));
      },
      updateRecoveryConfig: async patch => {
        if (qa.failNextUpdate) {
          qa.failNextUpdate = false;
          changeAudit(current => { current.updates.push({ patch: { ...patch }, ok: false }); });
          throw new Error('隔离测试：本机网络权限保存失败');
        }
        const recovery = { ...readRecovery(), ...patch,
          ...(qa.nextReturnedValue !== undefined ? { allowPrivateNetwork: qa.nextReturnedValue } : {}) };
        delete qa.nextReturnedValue;
        sessionStorage.setItem(recoveryKey, JSON.stringify(recovery));
        changeAudit(current => { current.updates.push({ patch: { ...patch }, ok: true }); });
        return { ...recovery };
      },
      request: async payload => { changeAudit(current => { current.modelRequests.push(payload.url); }); throw new Error('Real model API is forbidden in this fixture'); },
      videoRequest: async payload => { changeAudit(current => { current.modelRequests.push(payload.url); }); throw new Error('Real video API is forbidden in this fixture'); },
      onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
    };
  }, { recoveryKey, auditKey, phaseKey });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push({ url: request.url(), method: request.method() }); await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await settingsTabs().getByRole('tab', { name: '图片 API', exact: true }).click();
  await page.getByLabel('后端', { exact: true }).selectOption('comfyui');
  await permission().waitFor({ state: 'visible' });
  await waitChecked(false);
  const started = await audit();
  assert.ok(started.fullRecoveryRequests >= 1);
  assert.equal(started.fullRecoveryCompleted, 0);
  assert.ok(await page.evaluate(() => window.__privateNetworkQa.pendingPaths.length >= 1));

  await toggle(true);
  assert.equal((await audit()).fullRecoveryRequests, started.fullRecoveryRequests, 'saving permission must not read the full project recovery catalogue');
  stages.push({ name: 'image-permission-persists-with-full-recovery-pending', passed: true });

  const delivered = await page.evaluate(() => window.__privateNetworkQa.resolveStoragePaths());
  assert.ok(delivered >= 1, 'release the lightweight initial responses captured before enabling access');
  await page.waitForFunction(() => window.__privateNetworkQa.readAudit().storageDelivered === window.__privateNetworkQa.readAudit().storageRequests);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await waitChecked(true);
  stages.push({ name: 'late-false-initialization-does-not-overwrite-new-true', passed: true });

  const fullDelivered = await page.evaluate(() => window.__privateNetworkQa.resolveFullRecovery());
  assert.ok(fullDelivered >= 1, 'the full-status responses also captured false before the successful update');
  await page.waitForFunction(count => window.__privateNetworkQa.readAudit().fullRecoveryCompleted === count, fullDelivered);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await waitChecked(true);
  stages.push({ name: 'late-full-recovery-status-does-not-overwrite-new-true', passed: true });

  await selectPanel('视频生成'); await waitChecked(true);
  await toggle(false);
  await selectPanel('图片 API'); await waitChecked(false);
  stages.push({ name: 'image-and-video-share-successful-enable-and-disable', passed: true });

  await toggle(true, { returned: false });
  assert.equal(await page.evaluate(() => window.__privateNetworkQa.readRecovery().allowPrivateNetwork), false);
  stages.push({ name: 'successful-write-displays-returned-value-instead-of-requested-value', passed: true });
  await toggle(true);
  await selectPanel('视频生成'); await waitChecked(true);
  await toggle(false, { fail: true });
  assert.equal(await page.evaluate(() => window.__privateNetworkQa.readRecovery().allowPrivateNetwork), true);
  await selectPanel('图片 API'); await waitChecked(true);
  stages.push({ name: 'failed-disable-retains-saved-state-and-shows-error', passed: true });

  const beforeReload = await audit();
  assert.equal(beforeReload.fullRecoveryRequests, started.fullRecoveryRequests);
  assert.equal(beforeReload.fullRecoveryCompleted, fullDelivered);
  assert.equal(beforeReload.projectReads, 0);
  await page.waitForFunction(storageKey => JSON.parse(localStorage.getItem(storageKey)).settings.imageApi.backend === 'comfyui', stateKey);
  await page.evaluate(key => sessionStorage.setItem(key, 'immediate'), phaseKey);
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await settingsTabs().getByRole('tab', { name: '图片 API', exact: true }).click();
  await permission().waitFor({ state: 'visible' }); await waitChecked(true);
  await selectPanel('视频生成'); await waitChecked(true);
  const reloaded = await audit();
  assert.equal(reloaded.updates.length, beforeReload.updates.length, 'reload restores permission without writing it again');
  assert.equal(reloaded.fullRecoveryCompleted, beforeReload.fullRecoveryCompleted, 'permission restoration does not await newly pending full recovery');
  assert.ok(await page.evaluate(() => window.__privateNetworkQa.pendingRecovery.length >= 1));
  assert.equal(reloaded.projectReads, 0);
  assert.deepEqual(reloaded.modelRequests, []);
  assert.deepEqual(blockedRequests, []);
  assert.deepEqual(errors, []);
  stages.push({ name: 'reload-restores-lightweight-permission-while-full-recovery-remains-pending', passed: true });
  await page.screenshot({ path: path.join(output, 'permission-restored.png'), fullPage: false });
  return reloaded;
}

try {
  const summary = await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Private-network UI QA exceeded 120 seconds')), 120_000); })]);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, scope: 'real App private-network permission with synthetic pending recovery and lightweight storage', stages, summary, errors, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, groups: stages.length, output, updates: summary.updates.length, fullRecoveryCompleted: summary.fullRecoveryCompleted }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, failure: String(error), stages, audit: page && !page.isClosed() ? await audit().catch(() => null) : null, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  await context?.close(); await browser?.close(); await server.close();
}
