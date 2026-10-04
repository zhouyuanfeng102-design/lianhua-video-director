import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { API_GRAPH, EMPTY_CURL, METADATA_RESPONSE, assertSelectedRequest, inspectFit } from './runningHubNodesUiQa.mjs';
import { GRAPH, SIX_IMAGE_GRAPH, inspectFieldChoicesFit } from './runningHubFieldChoicesUiQa.mjs';

// Only the workflow-manager component is mounted. Configurations and the key
// below are synthetic, kept in this fresh browser's sessionStorage. The sole
// permitted provider-shaped request is intercepted loopback node discovery;
// no App, desktop bridge, project file, upload or generation engine is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `runninghub-image-slots-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output cannot traverse a link'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });
const fixtureKey = '__runninghub_image_slots_isolated_fixture__';
const fixtureCredential = 'QA_RUNNINGHUB_NO_REAL_CREDENTIAL';
const fixturePath = '/__runninghub_image_slots_fixture.html';
const providerPrefix = '/__runninghub_image_slots_mock__';
const errors = []; const blockedRequests = []; const reads = []; const stages = []; const screenshots = []; const layouts = [];
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser; let page; let origin; let discoveryStatus = 200;
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';

async function mountFixture() {
  await page.evaluate(async ({ fixtureKey, fixtureCredential, providerPrefix, emptyCurl, sixGraph, ordinaryGraph }) => {
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const { importRunningHubVideoWorkflow } = await import('/src/runningHubVideo.ts');
    const { parseRunningHubVideoNodes } = await import('/src/runningHubVideoNodes.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    document.documentElement.style.setProperty('--ui-font-scale', '1');
    const makeConfig = (kind = 'empty') => {
      const workflow = importRunningHubVideoWorkflow(emptyCurl, '隔离图片槽设置验证').workflow;
      workflow.id = `image-slots-fixture-${kind}`;
      if (kind !== 'empty') {
        const graph = kind === 'no-images' ? { '11': ordinaryGraph['11'] } : sixGraph;
        workflow.nodeCatalog = parseRunningHubVideoNodes(JSON.stringify(graph)).nodes;
        workflow.mapping.prompt = [{ nodeId: '11', inputName: 'text' }];
        workflow.requestTemplate = JSON.stringify({ nodeInfoList: [{ nodeId: '11', fieldName: 'text', fieldValue: 'saved prompt unchanged' }], addMetadata: true, instanceType: 'default', usePersonalQueue: false });
        if (kind !== 'no-images') {
          // Existing slot order is intentionally different from node order.
          // Auto-listing must append discovered slots, not reorder saved ones.
          workflow.mapping.images = [{ nodeId: '22', inputName: 'reference_image', role: 'character' }, { nodeId: '21', inputName: 'image', role: 'first-frame' }];
          if (kind === 'missing-binding') workflow.mapping.images.push({ nodeId: '999', inputName: 'image', role: 'subject' });
        }
      }
      return { enabled: true, baseUrl: `${location.origin}${providerPrefix}`, apiKey: fixtureCredential, activeWorkflowId: workflow.id, workflows: [workflow] };
    };
    const qa = window.__rhImageSlotsQa = { saves: 0, closes: 0, kind: 'empty', initial: '' };
    function Harness() {
      const [config, setConfig] = React.useState(() => {
        const saved = sessionStorage.getItem(fixtureKey);
        return saved ? JSON.parse(saved) : makeConfig();
      });
      const [epoch, setEpoch] = React.useState(0); const [open, setOpen] = React.useState(true);
      qa.config = config;
      qa.reset = (kind) => {
        const next = makeConfig(kind); qa.saves = 0; qa.kind = kind; qa.initial = JSON.stringify(next);
        sessionStorage.setItem(fixtureKey, JSON.stringify(next));
        setConfig(next); setOpen(true); setEpoch((value) => value + 1);
      };
      qa.reopen = () => setOpen(true);
      return open ? React.createElement(RunningHubWorkflowManager, {
        key: epoch, config, getCurrentConfig: () => qa.config,
        onChange: (next) => { qa.saves += 1; qa.config = next; sessionStorage.setItem(fixtureKey, JSON.stringify(next)); setConfig(next); },
        onClose: () => { qa.closes += 1; setOpen(false); },
      }) : React.createElement('p', {}, '隔离设置已关闭');
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  }, { fixtureKey, fixtureCredential, providerPrefix, emptyCurl: EMPTY_CURL, sixGraph: SIX_IMAGE_GRAPH, ordinaryGraph: GRAPH });
  await page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true }).waitFor();
}

const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
const openImages = async () => {
  await page.getByRole('tab', { name: '提示词与图片', exact: true }).click();
  await page.getByRole('tab', { name: /^参考图片槽 \d+$/u }).click();
};
const slots = () => page.locator('.rhv-image-slot-card');
const savedWorkflow = () => page.evaluate(() => structuredClone(window.__rhImageSlotsQa.config.workflows[0]));
const reset = async (kind) => { await page.evaluate((value) => window.__rhImageSlotsQa.reset(value), kind); await openImages(); };
const save = async () => {
  const before = await page.evaluate(() => window.__rhImageSlotsQa.saves);
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction((value) => window.__rhImageSlotsQa.saves === value, before + 1);
  assert.equal(await page.locator('.vwm-state').innerText(), '已保存');
};
async function assertReadOnlySlots(expectedFields, _expectedRoles = [], recoverySlots = []) {
  assert.equal(await slots().count(), expectedFields.length);
  assert.equal(await page.getByRole('button', { name: '添加云端图片槽', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('云端输入映射分页', { exact: true }).count(), 0, 'image slots are not hidden behind pagination');
  assert.equal(await page.getByLabel('云端映射字段范围', { exact: true }).count(), 0, 'image slots are not hidden behind filtering');
  for (const [offset, expected] of expectedFields.entries()) {
    const field = page.getByLabel(`云端图片槽 ${offset + 1} 节点字段`, { exact: true });
    assert.equal(await field.evaluate((element) => element.tagName), 'CODE', 'the node binding is read-only text, not a select/input');
    assert.equal(await field.innerText(), expected);
    assert.equal(await page.getByLabel(`云端图片槽 ${offset + 1} 用途`, { exact: true }).count(), 0, 'slot purpose is configured per video segment, not in API settings');
    assert.equal(await slots().nth(offset).locator('button').count(), recoverySlots.includes(offset + 1) ? 1 : 0, 'only an invalid legacy binding may expose its explicit recovery control');
  }
  assert.equal(await slots().locator('input,textarea').count(), 0, 'auto-listed node/field bindings are not editable controls');
}

async function assertSixSlotLayout(width, height, fontScale) {
  await page.setViewportSize({ width, height });
  await page.evaluate((scale) => document.documentElement.style.setProperty('--ui-font-scale', String(scale)), fontScale);
  await page.waitForFunction((scale) => document.querySelector('.rhv-backdrop')?.style.getPropertyValue('--ui-font-scale') === String(scale), fontScale);
  const [general, fieldChoices, cardLayout] = await Promise.all([
    inspectFit(page), inspectFieldChoicesFit(page), page.evaluate(() => {
      const panel = document.querySelector('.vwm-tab-panel');
      const cards = [...document.querySelectorAll('.rhv-image-slot-card')];
      const rect = (element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
      const boxes = cards.map(rect);
      const overlap = boxes.some((a, index) => boxes.slice(index + 1).some((b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1));
      const controls = cards.flatMap((card) => [...card.querySelectorAll('select,code')]).map((control) => {
        const box = control.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { ...rect(control), hit: Boolean(hit && (hit === control || control.contains(hit))), textFits: control.scrollWidth <= control.clientWidth + 1 };
      });
      return { cards: boxes, overlap, controls, panel: { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth } };
    }),
  ]);
  layouts.push({ width, height, fontScale, ...cardLayout });
  assert.equal(general.pageOverflow, false); assert.equal(fieldChoices.pageOverflowX, false);
  assert.ok(general.checks.every((check) => check.inViewport), `${width}×${height}/${fontScale}: every manager control fits the viewport`);
  assert.ok(fieldChoices.regions.every((region) => region.inside), `${width}×${height}/${fontScale}: no clipped control ${JSON.stringify(fieldChoices.regions.filter((region) => !region.inside))}`);
  assert.equal(cardLayout.cards.length, 6); assert.equal(cardLayout.overlap, false);
  assert.ok(cardLayout.controls.every((control) => control.hit && control.textFits), 'all six read-only slot labels are visible and unobscured');
  assert.ok(cardLayout.panel.scrollHeight <= cardLayout.panel.clientHeight + 1, `${width}×${height}/${fontScale}: all six slots and their help fit without scrolling the large panel ${JSON.stringify(cardLayout.panel)}`);
  assert.ok(cardLayout.panel.scrollWidth <= cardLayout.panel.clientWidth + 1);
  await capture(`six-image-slots-${width}x${height}-${Math.round(fontScale * 100)}percent`);
}

try {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.setDefaultTimeout(15_000);
  page.on('pageerror', (cause) => errors.push(cause.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => { blockedRequests.push(route.request().url()); await route.abort('blockedbyclient'); });
  await page.route(`${origin}${providerPrefix}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== 'POST' || url.pathname !== `${providerPrefix}/api/openapi/getJsonApiFormat`) {
      blockedRequests.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient'); return;
    }
    const body = request.postDataJSON();
    assert.equal(body.apiKey, fixtureCredential); assert.equal(body.workflowId, '2093983063180054529');
    reads.push({ method: request.method(), pathname: url.pathname, status: discoveryStatus });
    await route.fulfill({ status: discoveryStatus, contentType: 'application/json', body: JSON.stringify(discoveryStatus === 200 ? METADATA_RESPONSE : { code: 401, msg: 'fixture-only unauthorized' }) });
  });
  await page.route(`${origin}${fixturePath}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' }); await mountFixture();

  await reset('empty');
  await assertReadOnlySlots([], []);
  assert.match(await page.locator('.vwm-tab-panel').innerText(), /尚未找到图片输入槽[\s\S]*读取云端节点[\s\S]*导入节点 JSON/u);
  assert.equal(await page.evaluate(() => window.__rhImageSlotsQa.saves), 0);
  await capture('empty-catalog-read-real-nodes-guidance');
  discoveryStatus = 401;
  await page.getByRole('button', { name: '读取云端节点', exact: true }).click();
  await page.getByRole('button', { name: '读取节点中…', exact: true }).waitFor({ state: 'hidden' });
  assert.match(await page.locator('.vwm-notice').innerText(), /无访问权限或密钥无效/u); await assertReadOnlySlots([], []);
  discoveryStatus = 200;
  await page.getByRole('button', { name: '读取云端节点', exact: true }).click();
  await page.getByRole('tab', { name: '参考图片槽 1', exact: true }).waitFor();
  await assertReadOnlySlots(['22.image'], ['general']);
  assert.equal(await page.evaluate(() => window.__rhImageSlotsQa.saves), 0, 'read results are drafts until explicitly saved');
  stages.push('empty-directory-shows-real-node-guidance-and-read-retry-auto-lists-only-the-one-real-image');

  await page.getByRole('tab', { name: '提示词输入 0', exact: true }).click();
  await page.getByRole('button', { name: '添加云端提示词输入', exact: true }).click();
  await page.getByLabel('云端提示词 1 节点字段', { exact: true }).selectOption(JSON.stringify(['21', 'text']));
  await page.getByRole('tab', { name: '节点参数', exact: true }).click();
  await page.getByLabel('搜索云端节点字段', { exact: true }).fill('23.steps');
  await page.getByLabel('云端字段 23.steps 默认值', { exact: true }).fill('32');
  await save(); assertSelectedRequest((await savedWorkflow()).requestTemplate);
  assert.equal((await savedWorkflow()).nodeCatalog.some((node) => node.fieldName === 'api_key'), false);
  stages.push('nodes-fixture-preserves-selected-prompt-auto-image-edited-parameter-and-unrelated-runtime-options');

  await reset('six');
  const expectedFields = ['22.reference_image', '21.image', '23.image', '24.image', '25.image', '26.image'];
  const initialRoles = ['character', 'first-frame', 'general', 'general', 'general', 'general'];
  await assertReadOnlySlots(expectedFields, initialRoles);
  assert.equal((await savedWorkflow()).mapping.images.length, 2, 'merely opening the manager does not persist newly discovered slots');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__rhImageSlotsQa.config) === window.__rhImageSlotsQa.initial), true);
  const readsBeforeExistingCatalog = reads.length;
  stages.push('six-real-slots-auto-list-readonly-bindings-original-order-and-new-general-roles-without-persistence');

  await save();
  const savedSix = await savedWorkflow();
  assert.deepEqual(savedSix.mapping.images.map((binding) => `${binding.nodeId}.${binding.inputName}`), expectedFields);
  const savedRoles = initialRoles;
  assert.deepEqual(savedSix.mapping.images.map((binding) => binding.role), savedRoles);
  const savedRequest = JSON.parse(savedSix.requestTemplate);
  assert.equal(savedRequest.nodeInfoList.length, 7, 'only the prompt and six real image fields are mapped');
  assert.equal(savedRequest.addMetadata, true); assert.equal(savedRequest.usePersonalQueue, false);
  assert.equal(savedRequest.nodeInfoList.find((node) => node.nodeId === '11').fieldValue, 'saved prompt unchanged');
  assert.equal(savedRequest.nodeInfoList.some((node) => node.nodeId === '90'), false, 'internal fields do not become image inputs');
  assert.equal(savedRequest.nodeInfoList.some((node) => node.fieldName === 'upload'), false);
  await page.reload({ waitUntil: 'networkidle' }); await mountFixture(); await openImages();
  await assertReadOnlySlots(expectedFields, savedRoles); assert.deepEqual(await savedWorkflow(), savedSix);
  assert.equal(reads.length, readsBeforeExistingCatalog, 'a saved real directory does not need to be fetched again');
  stages.push('slot-purpose-controls-are-not-in-api-settings-and-legacy-role-data-stays-compatible');

  await page.getByRole('tab', { name: '提示词输入 1', exact: true }).click();
  const promptSelect = page.getByLabel('云端提示词 1 节点字段', { exact: true });
  const commonValues = await promptSelect.locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(commonValues.includes('["11","text"]')); assert.ok(commonValues.includes('["13","value"]'));
  assert.equal(commonValues.some((value) => /21|22|90|12/u.test(value)), false, 'ordinary prompt candidates exclude image, negative and internal fields');
  await page.getByLabel('云端映射字段范围', { exact: true }).selectOption('all');
  await page.getByLabel('搜索云端映射字段', { exact: true }).fill('90.custom_input');
  const advancedValues = await promptSelect.locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(advancedValues.includes('["90","custom_input"]')); assert.ok(advancedValues.includes('["11","text"]'), 'current binding remains visible across search');
  assert.equal(await page.locator('.vwm-state').innerText(), '已保存'); assert.deepEqual(await savedWorkflow(), savedSix);
  stages.push('field-choice-fixture-keeps-prompt-advanced-search-and-current-binding-without-dirtying-saved-settings');

  await reset('missing-binding');
  await assertReadOnlySlots(['22.reference_image', '21.image', '999.image', '23.image', '24.image', '25.image', '26.image'], ['character', 'first-frame', 'subject', 'general', 'general', 'general', 'general'], [3]);
  assert.match(await slots().nth(2).innerText(), /节点目录中缺失[\s\S]*重新读取/u);
  assert.equal(await page.evaluate(() => window.__rhImageSlotsQa.saves), 0);
  await page.getByRole('button', { name: '移除失效云端图片槽 3', exact: true }).click();
  await assertReadOnlySlots(expectedFields, initialRoles);
  assert.equal((await savedWorkflow()).mapping.images.some((binding) => binding.nodeId === '999'), true, 'recovery is a draft until saved');
  await save(); assert.equal((await savedWorkflow()).mapping.images.some((binding) => binding.nodeId === '999'), false);
  stages.push('missing-legacy-binding-and-uncommon-role-stay-visible-with-a-specific-warning-and-explicit-saved-recovery');

  await reset('no-images'); await assertReadOnlySlots([], []);
  assert.match(await page.locator('.vwm-tab-panel').innerText(), /文生视频可不选图/u);
  await page.getByRole('button', { name: '导入节点 JSON', exact: true }).click();
  await page.getByLabel('RunningHub 节点 JSON', { exact: true }).fill(API_GRAPH);
  await page.getByRole('button', { name: '加入节点目录', exact: true }).click();
  await page.getByRole('dialog', { name: '导入 RunningHub 节点 JSON', exact: true }).waitFor({ state: 'hidden' });
  await assertReadOnlySlots(['22.image'], ['general']);
  assert.equal(await page.evaluate(() => window.__rhImageSlotsQa.saves), 0);
  stages.push('no-image-workflow-stays-zero-until-real-node-json-is-imported-then-auto-lists-new-image-input');

  await reset('six');
  for (const [width, height] of [[1366, 768], [1280, 800], [1120, 720]]) {
    for (const scale of [1, 1.3]) await assertSixSlotLayout(width, height, scale);
  }
  stages.push('six-real-slots-all-visible-without-pagination-or-overlap-at-three-viewports-and-two-font-scales');

  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no non-mock provider/upload/generation request was attempted');
  const report = { passed: true, output, stages, reads, errors, blockedRequests, layouts, screenshots };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), stages, errors, blockedRequests,
    layouts: layouts.map(({ width, height, fontScale, panel }) => ({ width, height, fontScale, panel })), screenshots }, null, 2));
} catch (cause) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stack: cause.stack, errors, blockedRequests, reads, stages, layouts, screenshots }, null, 2));
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    await fs.writeFile(path.join(output, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`).catch(() => undefined);
  }
  console.error(cause); console.error(`QA output: ${output}`); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
