import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Focused manager callbacks only. Synthetic browser state, no App or desktop
// bridge; every non-module provider/submit/upload request is blocked.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-image-slot-delete-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const fixturePath = '/__runninghub_slot_delete_fixture.html';
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
const stages = []; const screenshots = []; const errors = []; const blocked = [];
let browser; let page; let origin; let failure;
const capture = async (name) => { const file = path.join(output, `${screenshots.length + 1}-${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
const snapshot = () => page.evaluate(() => JSON.stringify(window.__rhSlotDeleteQa.config));
const savedWorkflow = () => page.evaluate(() => structuredClone(window.__rhSlotDeleteQa.config.workflows[0]));
const openImages = async () => { await page.getByRole('tab', { name: '输入映射', exact: true }).click(); await page.getByRole('tab', { name: /^参考图片槽 \d+$/u }).click(); };
async function assertSlots(fields) {
  await page.waitForFunction((expected) => [...document.querySelectorAll('.rhv-image-slot-card code')].map((element) => element.textContent).join(',') === expected, fields.join(','));
  assert.equal(await page.locator('.rhv-image-slot-card').count(), fields.length);
  for (const [index, field] of fields.entries()) {
    assert.equal(await page.getByLabel(`云端图片槽 ${index + 1} 节点字段`, { exact: true }).innerText(), field);
    assert.ok(await page.getByRole('button', { name: `删除云端图片槽 ${index + 1}`, exact: true }).isVisible());
  }
}
async function manualAdd(id, field) {
  await page.getByRole('button', { name: '手动添加字段', exact: true }).click();
  await page.getByLabel('手动节点 ID', { exact: true }).fill(id);
  await page.getByLabel('手动节点字段名', { exact: true }).fill(field);
  await page.getByLabel('手动节点字段类型', { exact: true }).selectOption('image');
  await page.getByLabel('手动节点默认值', { exact: true }).fill(`fixture-${id}.png`);
  await page.getByRole('button', { name: '添加字段', exact: true }).click();
  await page.getByRole('dialog', { name: '手动添加 RunningHub 字段', exact: true }).waitFor({ state: 'detached' });
}
async function deleteSlot(index) { await page.getByRole('button', { name: `删除云端图片槽 ${index}`, exact: true }).click(); }
async function close(discard = false) {
  await page.getByRole('button', { name: '关闭 RunningHub 工作流管理', exact: true }).click();
  if (discard) await page.getByRole('button', { name: '放弃编辑并继续', exact: true }).click();
  await page.getByText('隔离删除检查已关闭', { exact: true }).waitFor();
}
async function reopen(mode) {
  await page.evaluate(() => window.__rhSlotDeleteQa.reopen());
  await page.getByRole('dialog', { name: `RunningHub 云端${mode === 'image' ? '图片' : '视频'}工作流管理`, exact: true }).waitFor();
  await openImages();
}

try {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1430, height: 870 } }); page.setDefaultTimeout(15_000);
  page.on('pageerror', (cause) => errors.push(cause.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && (url.origin !== origin || /^\/(?:api|openapi)\//u.test(url.pathname)), async (route) => {
    const url = new URL(route.request().url()); blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`); await route.abort('blockedbyclient');
  });
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const video = await import('/src/runningHubVideo.ts');
    const image = await import('/src/runningHubImage.ts');
    const { parseRunningHubVideoNodes } = await import('/src/runningHubVideoNodes.ts');
    const { IMAGE_V3_BODY, IMAGE_V3_CURL } = await import('/scripts/fixtures/runningHubImageV3.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css'); document.documentElement.style.setProperty('--ui-font-scale', '1');
    const makeConfig = (mode) => {
      const workflow = image.importRunningHubImageWorkflow(IMAGE_V3_CURL, `隔离删除-${mode}`).workflow;
      const body = { ...IMAGE_V3_BODY, usePersonalQueue: false, nodeInfoList: [
        { nodeId: '901', fieldName: 'image', fieldValue: 'old-manual-image.png' },
        { nodeId: '902', fieldName: 'legacy_asset_token', fieldValue: 'old-custom-upload.png' },
        ...IMAGE_V3_BODY.nodeInfoList.filter((node) => node.nodeId !== '183'),
      ], untouchedOption: { amount: 0.000001, text: '保持不动' } };
      workflow.id = `isolated-slot-delete-${mode}`; workflow.requestTemplate = JSON.stringify(body, null, 2);
      workflow.nodeCatalog = parseRunningHubVideoNodes(workflow.requestTemplate).nodes;
      workflow.mapping.images = [
        { nodeId: '901', inputName: 'image', role: 'general' },
        { nodeId: '902', inputName: 'legacy_asset_token', role: 'subject' },
        { nodeId: '182', inputName: 'image', role: 'first-frame' },
        { nodeId: '181', inputName: 'image', role: 'character' },
      ];
      workflow.mapping.parameters = { resolution: { nodeId: '189', inputName: 'value' } };
      workflow.fieldControls = { '["902","legacy_asset_token"]': { kind: 'text' }, '["189","value"]': { kind: 'number' } };
      return { enabled: true, baseUrl: location.origin, apiKey: 'QA_SLOT_DELETE_NOT_REAL_KEY', activeWorkflowId: workflow.id, workflows: [workflow] };
    };
    const qa = window.__rhSlotDeleteQa = { saves: 0, mode: 'image', modules: { video, image } };
    function Harness() {
      const [config, setConfig] = React.useState(() => makeConfig('image'));
      const [mode, setMode] = React.useState('image'); const [epoch, setEpoch] = React.useState(0); const [open, setOpen] = React.useState(true);
      qa.config = config;
      qa.reset = (nextMode) => { const next = makeConfig(nextMode); qa.mode = nextMode; qa.saves = 0; setConfig(next); setMode(nextMode); setOpen(true); setEpoch((value) => value + 1); };
      qa.reopen = () => setOpen(true);
      return open ? React.createElement(RunningHubWorkflowManager, {
        key: epoch, config, mediaKind: mode, getCurrentConfig: () => qa.config,
        ...(mode === 'image' ? { importWorkflow: image.importRunningHubImageWorkflow, validateWorkflow: image.validateRunningHubImageWorkflow, isWorkflowReady: image.isRunningHubImageWorkflowReady } : {}),
        onChange: (next) => { qa.saves += 1; qa.config = next; setConfig(next); },
        onClose: () => setOpen(false),
      }) : React.createElement('p', {}, '隔离删除检查已关闭');
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  for (const mode of ['image', 'video']) {
    await page.evaluate((value) => window.__rhSlotDeleteQa.reset(value), mode);
    await page.getByRole('dialog', { name: `RunningHub 云端${mode === 'image' ? '图片' : '视频'}工作流管理`, exact: true }).waitFor();
    await page.waitForFunction((value) => document.querySelector('.vwm-editor-heading strong')?.textContent === `隔离删除-${value}`, mode);
    await openImages(); await assertSlots(['901.image', '902.legacy_asset_token', '182.image', '181.image']);
    assert.equal(await page.locator('.vwm-state').innerText(), '已保存');
    const original = await savedWorkflow(); const before = await snapshot();
    await capture(`${mode}-old-saved-manual-slots-with-delete-buttons`);

    await manualAdd('903', 'image'); await assertSlots(['901.image', '902.legacy_asset_token', '182.image', '181.image', '903.image']);
    await manualAdd('904', 'custom_upload_token'); await assertSlots(['901.image', '902.legacy_asset_token', '182.image', '181.image', '903.image', '904.custom_upload_token']);
    assert.equal(await snapshot(), before, 'manual additions stay draft-only');
    await deleteSlot(5); await assertSlots(['901.image', '902.legacy_asset_token', '182.image', '181.image', '904.custom_upload_token']);
    await deleteSlot(5); await assertSlots(['901.image', '902.legacy_asset_token', '182.image', '181.image']);
    await deleteSlot(1); await assertSlots(['902.legacy_asset_token', '182.image', '181.image']);
    await deleteSlot(1); await assertSlots(['182.image', '181.image']);
    assert.equal(await snapshot(), before, 'all deletes stay draft-only until Save');
    await page.getByRole('button', { name: '保存工作流', exact: true }).click();
    await page.waitForFunction(() => window.__rhSlotDeleteQa.saves === 1 && document.querySelector('.vwm-state')?.textContent === '已保存');
    const saved = await savedWorkflow(); const deleted = new Set(['901', '902', '903', '904']);
    assert.deepEqual(saved.mapping.images, original.mapping.images.slice(2), 'remaining slot order and roles do not change');
    assert.deepEqual(saved.mapping.parameters, original.mapping.parameters);
    assert.ok(!saved.nodeCatalog.some((node) => deleted.has(node.nodeId)));
    assert.equal(saved.fieldControls['["902","legacy_asset_token"]'], undefined);
    assert.deepEqual(saved.fieldControls['["189","value"]'], original.fieldControls['["189","value"]']);
    const actualBody = JSON.parse(saved.requestTemplate); const originalBody = JSON.parse(original.requestTemplate);
    assert.deepEqual(actualBody, { ...originalBody, nodeInfoList: originalBody.nodeInfoList.filter((node) => !deleted.has(node.nodeId)) }, 'other request nodes, values and their order remain intact');
    // Compile/bind snapshots in memory only; no transport is attached or called.
    const submission = await page.evaluate(() => {
      const qa = window.__rhSlotDeleteQa; const compiled = qa.modules.video.compileRunningHubVideoApi(qa.config);
      return qa.modules.video.bindRunningHubVideoRequest(compiled.requestTemplate, compiled.runningHubMappedFields,
        { prompt: '隔离检查正文', parameters: {} }, ['synthetic-first.png', 'synthetic-second.png']);
    });
    assert.ok(!submission.nodeInfoList.some((node) => deleted.has(node.nodeId)), 'compiled submission excludes deleted manual fields');
    assert.equal(submission.nodeInfoList.find((node) => node.nodeId === '107').fieldValue, '隔离检查正文');
    assert.equal(submission.nodeInfoList.find((node) => node.nodeId === '189').fieldValue, '2048');
    await close(); await reopen(mode); await assertSlots(['182.image', '181.image']);
    assert.equal(await page.locator('.vwm-state').innerText(), '已保存');
    await capture(`${mode}-deleted-saved-reopened-two-remaining-slots`);
    stages.push({ mode, name: 'manual-image-custom-and-old-adjacent-slots-delete-save-reopen', remaining: ['182.image', '181.image'], passed: true });

    const savedBeforeCancel = await snapshot();
    await deleteSlot(1); await assertSlots(['181.image']); assert.equal(await snapshot(), savedBeforeCancel);
    await close(true); assert.equal(await snapshot(), savedBeforeCancel); await reopen(mode); await assertSlots(['182.image', '181.image']);
    assert.equal(await page.evaluate(() => window.__rhSlotDeleteQa.saves), 1, 'Cancel does not call the save callback');
    stages.push({ mode, name: 'cancel-deletion-preserves-saved-config', passed: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
} catch (cause) {
  failure = { message: cause.message, stack: cause.stack }; if (page) { try { await capture('failure'); } catch {} }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, scope: 'image/video deletion UI callbacks only', viewport: { width: 1430, height: 870 }, stages, screenshots, errors, blocked, failure }, null, 2));
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ passed: !failure, report: path.join(output, 'report.json'), stages: stages.length }));
if (failure) process.exitCode = 1;
