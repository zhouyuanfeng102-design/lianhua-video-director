import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// One isolated image-mode manager. No application, desktop bridge, user project,
// credential, upload, generation, or real provider request is used.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-image-manager-v3-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const fixturePath = '/__runninghub_image_manager_v3_fixture.html';
const providerPrefix = '/__runninghub_image_manager_v3_mock__';
const credential = 'QA_IMAGE_MANAGER_NOT_A_REAL_KEY';
const sessionKey = '__runninghub_image_manager_v3_isolated__';
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';
const screenshots = []; const stages = []; const reads = []; const errors = []; const blockedRequests = [];
const remainingOnly = process.argv.includes('--remaining');
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser; let page; let origin; let discoveryBody; let appId;

async function mount() {
  await page.evaluate(async ({ credential, providerPrefix, sessionKey }) => {
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const image = await import('/src/runningHubImage.ts');
    const { parseRunningHubVideoNodes } = await import('/src/runningHubVideoNodes.ts');
    const fixture = await import('/scripts/fixtures/runningHubImageV3.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    document.documentElement.style.setProperty('--ui-font-scale', '1');
    const makeConfig = (kind) => {
      let workflows = [];
      if (kind !== 'blank') {
        const workflow = image.importRunningHubImageWorkflow(fixture.IMAGE_V3_CURL, `隔离图片管理-${kind}`).workflow;
        workflow.id = `image-manager-v3-${kind}`;
        const ids = kind === 'ordered' ? ['183', '181', '107'] : ['107'];
        const body = { ...fixture.IMAGE_V3_BODY, nodeInfoList: ids.map((id) => fixture.IMAGE_V3_BODY.nodeInfoList.find((node) => node.nodeId === id)) };
        workflow.requestTemplate = JSON.stringify(body);
        workflow.nodeCatalog = parseRunningHubVideoNodes(JSON.stringify(body)).nodes;
        workflow.mapping.images = kind === 'ordered'
          ? [{ nodeId: '183', inputName: 'image', role: 'subject', label: '已有第一槽' }, { nodeId: '181', inputName: 'image', role: 'character', label: '已有第二槽' }]
          : [];
        workflows = [workflow];
      }
      return { enabled: true, baseUrl: `${location.origin}${providerPrefix}`, apiKey: credential,
        activeWorkflowId: workflows[0]?.id || null, workflows };
    };
    const qa = window.__rhImageManagerV3Qa = { saves: 0, closes: 0, kind: 'blank', fixture: structuredClone(fixture.IMAGE_V3_BODY), curl: fixture.IMAGE_V3_CURL, appId: fixture.IMAGE_V3_APP_ID };
    function Harness() {
      const [config, setConfig] = React.useState(() => makeConfig('blank'));
      const [epoch, setEpoch] = React.useState(0); const [open, setOpen] = React.useState(true);
      qa.config = config;
      qa.reset = (kind) => {
        const next = makeConfig(kind); qa.kind = kind; qa.saves = 0; qa.initial = JSON.stringify(next);
        sessionStorage.setItem(sessionKey, JSON.stringify(next)); setConfig(next); setOpen(true); setEpoch((value) => value + 1);
      };
      qa.reopen = () => setOpen(true);
      return open ? React.createElement(RunningHubWorkflowManager, {
        key: epoch, config, getCurrentConfig: () => qa.config, mediaKind: 'image',
        importWorkflow: image.importRunningHubImageWorkflow,
        isWorkflowReady: image.isRunningHubImageWorkflowReady,
        validateWorkflow: image.validateRunningHubImageWorkflow,
        onChange: (next) => { qa.saves += 1; qa.config = next; sessionStorage.setItem(sessionKey, JSON.stringify(next)); setConfig(next); },
        onClose: () => { qa.closes += 1; setOpen(false); },
      }) : React.createElement('p', {}, '隔离管理已关闭');
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  }, { credential, providerPrefix, sessionKey });
  await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor();
  ({ fixture: discoveryBody, appId } = await page.evaluate(() => window.__rhImageManagerV3Qa));
}

const configSnapshot = () => page.evaluate(() => JSON.stringify(window.__rhImageManagerV3Qa.config));
const workflowSnapshot = () => page.evaluate(() => structuredClone(window.__rhImageManagerV3Qa.config.workflows.at(-1)));
const capture = async (name) => { const file = path.join(output, `${screenshots.length + 1}-${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
const reset = async (kind) => {
  await page.evaluate((value) => window.__rhImageManagerV3Qa.reset(value), kind);
  await page.waitForFunction((value) => value === 'blank' ? !document.querySelector('.vwm-editor-heading strong')
    : document.querySelector('.vwm-editor-heading strong')?.textContent === `隔离图片管理-${value}`, kind);
};
const openMapping = () => page.getByRole('tab', { name: '输入映射', exact: true }).click();
const openImages = async () => { await openMapping(); await page.getByRole('tab', { name: /^参考图片槽 \d+$/u }).click(); };
const close = async (discard = false) => {
  await page.getByRole('button', { name: '关闭 RunningHub 工作流管理', exact: true }).click();
  if (discard) await page.getByRole('button', { name: '放弃编辑并继续', exact: true }).click();
  await page.getByText('隔离管理已关闭', { exact: true }).waitFor();
};
const reopen = async () => { await page.evaluate(() => window.__rhImageManagerV3Qa.reopen()); await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor(); };
const save = async () => {
  const before = await page.evaluate(() => window.__rhImageManagerV3Qa.saves);
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction((count) => window.__rhImageManagerV3Qa.saves === count, before + 1);
  assert.equal(await page.locator('.vwm-state').innerText(), '已保存');
};
const readNodes = async () => {
  await page.getByRole('button', { name: '读取云端节点', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.vwm-notice')?.textContent.includes('已读取 9 个节点字段'));
  const message = await page.locator('.vwm-notice').innerText();
  assert.ok(!/音频|生成视频|分段设置/u.test(message), 'image-mode node message must describe image slots');
};
async function assertSlots(ids) {
  await page.waitForFunction((expected) => [...document.querySelectorAll('.rhv-image-slot-card code')].map((node) => node.textContent).join(',') === expected,
    ids.map((id) => `${id}.image`).join(','));
  assert.equal(await page.getByRole('tab', { name: /^参考音频槽/u }).count(), 0);
  for (const [index, id] of ids.entries()) {
    const field = page.getByLabel(`云端图片槽 ${index + 1} 节点字段`, { exact: true });
    assert.equal(await field.innerText(), `${id}.image`);
    assert.ok(await field.isVisible());
    assert.equal(await field.evaluate((element) => {
      const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.width > 0 && box.height > 0 && Boolean(hit && (hit === element || element.contains(hit)));
    }), true, 'each image node label is fully visible and unobscured');
  }
}
async function assertPromptChoices() {
  await openMapping(); await page.getByRole('tab', { name: /^提示词输入 \d+$/u }).click();
  const binding = page.getByLabel('云端提示词 1 节点字段', { exact: true });
  assert.equal(await binding.inputValue(), '["107","text"]');
  const options = await binding.locator('option').allTextContents();
  assert.ok(options.some((option) => /^107\.text/u.test(option)), 'actual Prompt-labelled text is a common candidate');
  assert.ok(!options.some((option) => /^195\.value/u.test(option)), 'the Text-to-image switch is not a common prompt candidate');
  await capture('prompt-107-common-without-switch-195');
}
function assertImageOnly(workflow, parameters = {}) {
  assert.deepEqual(workflow.mapping.prompt, [{ nodeId: '107', inputName: 'text' }]);
  assert.equal(workflow.mapping.audios?.length || 0, 0, 'image mode must not append audio slots');
  assert.deepEqual(workflow.mapping.parameters || {}, parameters, 'image mode must not auto-bind video output parameters');
}

let failure;
try {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1430, height: 870 } }); page.setDefaultTimeout(15_000);
  page.on('pageerror', (cause) => errors.push(cause.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    const url = new URL(route.request().url()); blockedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`); await route.abort('blockedbyclient');
  });
  await page.route(`${origin}${providerPrefix}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== `${providerPrefix}/api/webapp/apiCallDemo`) {
      blockedRequests.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient'); return;
    }
    assert.equal(url.searchParams.get('webappId'), appId); assert.equal(url.searchParams.get('apiKey'), credential);
    reads.push({ method: request.method(), pathname: url.pathname, fields: discoveryBody.nodeInfoList.length });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { nodeInfoList: discoveryBody.nodeInfoList } }) });
  });
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' }); await mount();
  const curl = await page.evaluate(() => window.__rhImageManagerV3Qa.curl);
  let before; let saved;

  if (!remainingOnly) {
  // Cancelling unaccepted cURL text writes nothing. Import itself is the existing
  // explicit append/save operation; image-slot discovery stays draft-only.
  await reset('blank'); before = await configSnapshot();
  await page.locator('.vwm-library-tools').getByRole('button', { name: '导入 cURL / JSON', exact: true }).click();
  await page.getByLabel('RunningHub 导入文本', { exact: true }).fill(curl);
  assert.equal(await configSnapshot(), before);
  await page.getByRole('button', { name: '关闭导入', exact: true }).click();
  await page.getByRole('button', { name: '放弃导入文本', exact: true }).click();
  assert.equal(await configSnapshot(), before); assert.equal(await page.evaluate(() => window.__rhImageManagerV3Qa.saves), 0);
  stages.push({ name: 'cancel-curl-import', passed: true });

  await page.locator('.vwm-library-tools').getByRole('button', { name: '导入 cURL / JSON', exact: true }).click();
  await page.getByLabel('RunningHub 导入文本', { exact: true }).fill(curl);
  await page.getByLabel('导入的 RunningHub 工作流名称', { exact: true }).fill('脱敏九字段图片应用');
  await page.getByRole('button', { name: '导入为新工作流', exact: true }).click();
  await page.waitForFunction(() => window.__rhImageManagerV3Qa.saves === 1 && !document.querySelector('.rhv-import-dialog'));
  const imported = await workflowSnapshot(); assertImageOnly(imported);
  assert.equal(imported.mapping.images.length, 3, 'new image imports persist declared image slots for immediate reference submission');
  before = await configSnapshot(); await openImages(); await assertSlots(['181', '182', '183']);
  assert.equal(await configSnapshot(), before, 'viewing discovered slots does not save them');
  await capture('curl-import-three-draft-image-slots'); await assertPromptChoices();
  await save(); saved = await workflowSnapshot(); assertImageOnly(saved);
  assert.deepEqual(saved.mapping.images.map((slot) => slot.nodeId), ['181', '182', '183']);
  assert.deepEqual(JSON.parse(saved.requestTemplate).nodeInfoList, discoveryBody.nodeInfoList, 'all original API defaults remain unchanged');
  assert.equal(JSON.parse(saved.requestTemplate).usePersonalQueue, JSON.parse(imported.requestTemplate).usePersonalQueue);
  await close(); await reopen(); await openImages(); await assertSlots(['181', '182', '183']);
  assert.equal(await page.locator('.vwm-state').innerText(), '已保存'); await capture('curl-saved-reopened-three-slots');
  stages.push({ name: 'curl-import-draft-save-reopen', slots: ['181.image', '182.image', '183.image'], passed: true });
  }

  // Read the nine provider fields on loopback. Config stays byte-for-byte equal
  // until the user explicitly saves, and reopening retains the three slots.
  await reset('cloud'); await openImages(); await assertSlots([]); before = await configSnapshot();
  await readNodes(); await assertSlots(['181', '182', '183']); assert.equal(await configSnapshot(), before);
  await capture('mock-cloud-nine-fields-three-draft-slots'); await assertPromptChoices(); await save();
  saved = await workflowSnapshot(); assertImageOnly(saved); assert.deepEqual(saved.mapping.images.map((slot) => slot.nodeId), ['181', '182', '183']);
  await close(); await reopen(); await openImages(); await assertSlots(['181', '182', '183']);
  assert.equal(await page.locator('.vwm-state').innerText(), '已保存');
  stages.push({ name: 'mock-cloud-draft-save-reopen', passed: true });

  // The same nine fields through node-directory JSON stay an unsaved draft;
  // cancelling the manager must retain the original zero-slot configuration.
  await reset('cancel'); await openImages(); before = await configSnapshot();
  await page.getByRole('button', { name: '导入节点 JSON', exact: true }).click();
  const nodeDialog = page.getByRole('dialog', { name: '导入 RunningHub 节点 JSON', exact: true });
  assert.ok(!/音频|生成视频/u.test(await nodeDialog.locator('.rhv-import-feedback').innerText()));
  await page.getByLabel('RunningHub 节点 JSON', { exact: true }).fill(JSON.stringify(discoveryBody));
  await page.getByRole('button', { name: '加入节点目录', exact: true }).click();
  await assertSlots(['181', '182', '183']); assert.equal(await configSnapshot(), before);
  assert.ok(!/音频|生成视频|分段设置/u.test(await page.locator('.vwm-notice').innerText()));
  await capture('node-import-three-slots-cancel-without-save'); await close(true);
  assert.equal(await configSnapshot(), before); assert.equal(await page.evaluate(() => window.__rhImageManagerV3Qa.saves), 0);
  await reopen(); await openImages(); await assertSlots([]);
  stages.push({ name: 'node-json-import-cancel-no-save', passed: true });

  // Existing deliberately reordered slots keep their bindings and metadata.
  await reset('ordered'); await openImages(); await assertSlots(['183', '181']);
  const ordered = await workflowSnapshot(); before = await configSnapshot();
  await readNodes(); await assertSlots(['183', '181', '182']); assert.equal(await configSnapshot(), before);
  await save(); saved = await workflowSnapshot(); assertImageOnly(saved);
  assert.deepEqual(saved.mapping.images.slice(0, 2), ordered.mapping.images);
  assert.deepEqual(saved.mapping.images.map((slot) => slot.nodeId), ['183', '181', '182']);
  await close(); await reopen(); await openImages(); await assertSlots(['183', '181', '182']);
  await capture('existing-slot-order-preserved-after-save-reopen');
  stages.push({ name: 'existing-order-and-slot-metadata-preserved', passed: true });
  assert.equal(reads.length, 2); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
} catch (cause) {
  failure = cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : { message: String(cause) };
  if (page) { try { await capture('failure'); } catch {} }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, scope: remainingOnly ? 'remaining mock-cloud, node JSON cancel, order persistence paths; cURL import/save already verified in preceding report' : 'all focused image-manager paths', viewport: { width: 1430, height: 870, fontScale: 1 }, fixture: 'sanitized nine-field IMAGE_V3_BODY', stages, reads, errors, blockedRequests, screenshots, failure }, null, 2));
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ passed: !failure, report: path.join(output, 'report.json'), stages: stages.length }));
if (failure) process.exitCode = 1;
