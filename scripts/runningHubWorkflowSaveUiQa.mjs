import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Exercise the real image-settings save adapter and manager with synthetic
// browser state. No desktop storage, upload or generation transport is attached.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-workflow-save-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
const fixturePath = '/__runninghub_workflow_save_fixture.html';
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';
const stages = []; const errors = []; const blocked = [];
let browser; let page; let failure;
const open = async () => {
  await page.getByRole('button', { name: '管理图片应用与节点映射', exact: true }).click();
  await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor();
};
const state = () => page.evaluate(() => structuredClone(window.__rhWorkflowSaveQa));
const name = () => page.getByLabel('RunningHub 工作流名称', { exact: true });
const saved = async () => {
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.locator('.vwm-state').filter({ hasText: /^已保存$/u }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存工作流', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('alert').count(), 0);
};
const close = async () => {
  await page.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'saved draft closes without a discard warning');
  await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor({ state: 'detached' });
};

try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1430, height: 870 } });
  page.setDefaultTimeout(10_000); page.on('pageerror', (cause) => errors.push(cause.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && (url.origin !== origin || /^\/(?:api|openapi)\//u.test(url.pathname)), async (route) => {
    blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`); await route.abort('blockedbyclient');
  });
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { RunningHubImageSettings } = await import('/src/components/RunningHubImageSettings.tsx');
    const image = await import('/src/runningHubImage.ts');
    const { IMAGE_V3_CURL } = await import('/scripts/fixtures/runningHubImageV3.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    const first = image.importRunningHubImageWorkflow(IMAGE_V3_CURL, '隔离保存原稿').workflow;
    first.id = 'isolated-save-first';
    first.mapping.images = ['181', '182', '183'].map((nodeId) => ({ nodeId, inputName: 'image', role: 'general' }));
    first.mapping.parameters = { resolution: { nodeId: '189', inputName: 'value' } };
    const other = structuredClone(first); other.id = 'isolated-save-other'; other.name = '其他工作流';
    const initial = { enabled: true, baseUrl: location.origin, apiKey: 'QA_SAVE_NOT_A_REAL_KEY',
      ...image.normalizeRunningHubImageConfig({ runningHubWorkflows: [first, other], activeRunningHubWorkflowId: first.id }) };
    const qa = window.__rhWorkflowSaveQa = { config: initial, saves: 0, history: [{ id: 'synthetic-history', snapshot: structuredClone(first) }] };
    function Harness() {
      const [config, setConfig] = React.useState(initial); qa.config = config;
      window.__rhWorkflowSaveExternal = (id, name) => {
        const next = { ...qa.config, runningHubWorkflows: qa.config.runningHubWorkflows.map((workflow) => workflow.id === id ? { ...workflow, name } : workflow) };
        qa.config = next; setConfig(next);
      };
      return React.createElement(RunningHubImageSettings, { config,
        onChange: (patch) => { const next = { ...qa.config, ...patch }; Object.assign(next, image.normalizeRunningHubImageConfig(next));
          qa.saves += 1; qa.config = next; setConfig(next); } });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  const before = await state();
  await open(); await name().fill('连续保存一');
  await page.getByRole('tab', { name: '生成参数', exact: true }).click();
  await page.getByLabel('RunningHub 画面比例节点字段', { exact: true }).selectOption('["194","aspect_ratio"]');
  await page.getByLabel('RunningHub 画面比例默认值', { exact: true }).selectOption('16:9');
  await saved();
  const ratioSaved = (await state()).config.runningHubWorkflows[0];
  assert.equal(JSON.parse(ratioSaved.requestTemplate).nodeInfoList.find((node) => node.nodeId === '194').fieldValue, '16:9');
  assert.equal(JSON.parse(ratioSaved.requestTemplate).nodeInfoList.find((node) => node.nodeId === '195').fieldValue, 'false');
  // Changing mappings to an empty parameter object exercises normalization that
  // removes editor-only empty data instead of echoing the submitted raw object.
  await page.getByLabel('RunningHub 分辨率节点字段', { exact: true }).selectOption('["",""]');
  await page.getByLabel('RunningHub 画面比例节点字段', { exact: true }).selectOption('["",""]');
  await saved();
  await page.getByRole('tab', { name: '基本信息', exact: true }).click();
  await name().fill('连续保存二'); await saved(); await close(); await open();
  assert.equal(await name().inputValue(), '连续保存二');
  const after = await state(); assert.equal(after.saves, 3);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.config.runningHubWorkflows[1], before.config.runningHubWorkflows[1]);
  assert.equal(after.config.runningHubWorkflows[0].mapping.parameters, undefined);
  stages.push('three consecutive saves use normalized accepted baseline; close and reopen without false dirty state');

  await name().fill('真正未保存的编辑');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  assert.equal((await state()).saves, 3); await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await name().inputValue(), '真正未保存的编辑');
  await page.evaluate(() => window.__rhWorkflowSaveExternal('isolated-save-other', '其他工作流外部修改'));
  await saved(); assert.equal((await state()).config.runningHubWorkflows[1].name, '其他工作流外部修改');
  stages.push('real unsaved draft still asks before close; saving preserves unrelated concurrent workflow changes');

  await name().fill('应被阻止的旧稿');
  await page.evaluate(() => window.__rhWorkflowSaveExternal('isolated-save-first', '同一工作流外部修改'));
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已在其他位置变化' }).waitFor();
  const conflict = await state(); assert.equal(conflict.saves, 4);
  assert.equal(conflict.config.runningHubWorkflows[0].name, '同一工作流外部修改');
  assert.equal(await name().inputValue(), '应被阻止的旧稿');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  stages.push('same-workflow external edits still block stale save and retain unsaved draft warning');
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
} catch (cause) {
  failure = { message: cause.message, stack: cause.stack };
} finally {
  if (page) await page.screenshot({ path: path.join(output, failure ? 'failure.png' : 'conflict-guard.png'), animations: 'disabled' }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, scope: 'real RunningHubImageSettings + workflow-manager save acknowledgement', stages, errors, blocked, failure }, null, 2));
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ passed: !failure, report: path.join(output, 'report.json'), stages: stages.length }));
if (failure) process.exitCode = 1;
