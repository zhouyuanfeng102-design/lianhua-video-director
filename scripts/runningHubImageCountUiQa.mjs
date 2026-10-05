import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-image-count-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const originPath = '/__runninghub_image_count_fixture.html';
const fixtureId = 'runninghub-image-count-ui-fixture';
const sixImages = ['438', '435', '437', '439', '431', '429'];
const body = {
  nodeInfoList: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: 'saved prompt' },
    ...sixImages.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: `default-${nodeId}.png` })),
    { nodeId: '827', fieldName: 'value', fieldValue: '1' },
  ],
  instanceType: 'default', usePersonalQueue: false, addMetadata: true,
};
const makeWorkflow = () => ({
  id: fixtureId, name: '图片数量 UI 隔离验证', runKind: 'ai-app', remoteId: '2104753059472990209',
  requestTemplate: JSON.stringify(body),
  nodeCatalog: [
    { nodeId: 'prompt', fieldName: 'text', fieldValue: 'saved prompt', description: '提示词' },
    ...sixImages.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: `default-${nodeId}.png`, description: '参考图' })),
    { nodeId: '827', fieldName: 'value', fieldValue: '1', description: '使用几张图' },
  ],
  mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: sixImages.map((nodeId) => ({ nodeId, inputName: 'image', role: 'general' })) },
  createdAt: 1, updatedAt: 1,
});
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser;
let page;
const screenshots = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(15_000);
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, (route) => route.abort('blockedbyclient'));
  await page.route(`${origin}${originPath}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}${originPath}`, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ fixtureId, initial }) => {
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    const qa = window.__runningHubImageCountQa = { config: { enabled: true, baseUrl: '', apiKey: '', activeWorkflowId: fixtureId, workflows: [initial] }, saves: 0 };
    function Harness() {
      const [config, setConfig] = React.useState(qa.config);
      qa.config = config;
      return React.createElement(RunningHubWorkflowManager, { config, getCurrentConfig: () => qa.config, onChange: (next) => { qa.saves += 1; qa.config = next; setConfig(next); }, onClose: () => {} });
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  }, { fixtureId, initial: makeWorkflow() });
  await page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true }).waitFor();
  await page.getByRole('tab', { name: '提示词与图片', exact: true }).click();
  await page.getByRole('tab', { name: '参考图片槽 6', exact: true }).click();

  const countSelect = page.getByLabel('RunningHub 图片数量字段', { exact: true });
  assert.equal(await countSelect.inputValue(), 'auto');
  assert.equal(await page.evaluate(() => Object.prototype.hasOwnProperty.call(window.__runningHubImageCountQa.config.workflows[0].mapping, 'imageCount')), false, '自动模式不写入隐式绑定');
  assert.match(await page.locator('.vwm-tab-panel').innerText(), /每段按实际选图数量自动填写/u);
  await page.getByRole('tab', { name: '节点参数', exact: true }).click();
  await page.getByLabel('搜索云端节点字段', { exact: true }).fill('827.value');
  const countValue = page.getByLabel('云端字段 827.value 默认值', { exact: true });
  assert.equal(await countValue.isDisabled(), true, '自动数量字段不能作为静态默认值编辑');
  const parameterBinding = page.getByLabel('云端字段 827.value 参数名', { exact: true });
  assert.equal(await parameterBinding.isDisabled(), true, '自动数量字段不能重复绑定普通参数');
  const screen = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
  await screen('auto-six-slots');

  await page.getByRole('tab', { name: '提示词与图片', exact: true }).click();
  await page.getByRole('tab', { name: '参考图片槽 6', exact: true }).click();
  await countSelect.selectOption('none');
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.getByText('已保存云端工作流', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__runningHubImageCountQa.config.workflows[0].mapping.imageCount), null);
  assert.equal(await countSelect.inputValue(), 'none');

  await countSelect.selectOption('["827","value"]');
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.getByText('已保存云端工作流', { exact: false }).waitFor();
  const saved = await page.evaluate(() => structuredClone(window.__runningHubImageCountQa.config.workflows[0]));
  assert.deepEqual(saved.mapping.imageCount, { nodeId: '827', inputName: 'value' });
  assert.equal(await countSelect.inputValue(), '["827","value"]');

  // The host app's desktop canvas has a 1040px minimum width. Check that
  // minimum and a nearby narrow viewport; the manager itself must add no
  // horizontal overflow within that canvas.
  for (const [width, height] of [[1100, 700], [1040, 700]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(50);
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('.vwm-dialog');
      const panel = document.querySelector('.vwm-tab-panel');
      return { dialogScrollWidth: dialog?.scrollWidth || 0, dialogClientWidth: dialog?.clientWidth || 0,
        panelScrollWidth: panel?.scrollWidth || 0, panelClientWidth: panel?.clientWidth || 0 };
    });
    assert.ok(layout.dialogScrollWidth <= layout.dialogClientWidth + 1, `${width}: dialog horizontal overflow`);
    assert.ok(layout.panelScrollWidth <= layout.panelClientWidth + 1, `${width}: panel horizontal overflow`);
    await screen(`explicit-count-${width}x${height}`);
  }
  console.log(JSON.stringify({ ok: true, screenshots, saves: await page.evaluate(() => window.__runningHubImageCountQa.saves) }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
