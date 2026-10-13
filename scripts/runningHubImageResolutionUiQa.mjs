import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Actual size controls and image manager, with synthetic V3 config only.
// Prepare request bodies in memory; no generation service or desktop App.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `runninghub-image-resolution-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const fixturePath = '/__runninghub_image_resolution_fixture.html';
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>';
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
const stages = []; const screenshots = []; const errors = []; const blocked = [];
const remainingOnly = process.argv.includes('--remaining');
let browser; let page; let origin; let failure;
const capture = async (name) => { const file = path.join(output, `${screenshots.length + 1}-${name}.png`); await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file); };
const current = () => page.evaluate(() => ({ value: window.__rhImageSizeQa.value, resolved: window.__rhImageSizeQa.resolved, api: window.__rhImageSizeQa.api }));
const ordinaryGroup = () => page.getByRole('group', { name: '普通生图分辨率设置', exact: true });
const ordinaryMode = () => page.getByLabel('普通生图分辨率', { exact: true });
async function prepareAndAssert(resolution) {
  const before = await page.evaluate(() => window.__rhImageSizeQa.prepared);
  await page.getByRole('button', { name: '准备请求（隔离）', exact: true }).click();
  await page.waitForFunction((count) => window.__rhImageSizeQa.prepared === count, before + 1);
  const body = await page.evaluate(() => window.__rhImageSizeQa.body);
  const value = (id) => body.nodeInfoList.find((node) => node.nodeId === id).fieldValue;
  assert.equal(value('189'), resolution);
  assert.equal(value('194'), '3:4'); assert.equal(value('195'), 'false'); assert.equal(value('191'), '1'); assert.equal(value('186'), 'false');
  assert.equal(value('107'), '隔离图片正文');
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
    const { ImageOutputSizeControls } = await import('/src/components/ImageOutputSizeControls.tsx');
    const { StoryboardImageOutputSizeControls } = await import('/src/components/StoryboardImageOutputSizeControls.tsx');
    const { RunningHubWorkflowManager } = await import('/src/components/RunningHubWorkflowManager.tsx');
    const image = await import('/src/runningHubImage.ts');
    const { syncRunningHubImageSlots } = await import('/src/runningHubImageSlots.ts');
    const { resolveImageOutputSize } = await import('/src/imageOutputSize.ts');
    const { resolveStoryboardImageOutputSize } = await import('/src/storyboardImageOutputSize.ts');
    const { IMAGE_V3_CURL } = await import('/scripts/fixtures/runningHubImageV3.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css'); document.documentElement.style.setProperty('--ui-font-scale', '1');
    const imported = syncRunningHubImageSlots(image.importRunningHubImageWorkflow(IMAGE_V3_CURL, '隔离分辨率V3').workflow);
    imported.id = 'isolated-image-resolution-v3'; imported.mapping.parameters = { resolution: { nodeId: '189', inputName: 'value' } };
    const qa = window.__rhImageSizeQa = { prepared: 0, saves: 0 };
    function Harness() {
      const [api, setApi] = React.useState({ backend: 'runninghub', enabled: true, model: 'fixture', baseUrl: location.origin,
        apiKey: 'QA_IMAGE_RESOLUTION_NOT_REAL', runningHubWorkflows: [imported], activeRunningHubWorkflowId: imported.id });
      const [value, setValue] = React.useState({ mode: '2k', aspect: 'variant', width: 1024, height: 1024, resolutionVersion: 1 });
      const [storyValue, setStoryValue] = React.useState({ mode: '2k', width: 1024, height: 1024, resolutionVersion: 1 });
      const [manager, setManager] = React.useState(false);
      const resolved = resolveImageOutputSize(value, { width: 1024, height: 1024 }, api, 'reference');
      const storyResolved = resolveStoryboardImageOutputSize(storyValue, '16:9', api);
      qa.api = api; qa.value = value; qa.resolved = resolved; qa.storyResolved = storyResolved; qa.manager = manager;
      qa.restoreOldAspect = () => setValue((current) => ({ ...current, mode: '2k', aspect: '16:9' }));
      qa.useMappedRatio = () => setApi((current) => ({ ...current, runningHubWorkflows: current.runningHubWorkflows.map((workflow) => ({
        ...workflow, mapping: { ...workflow.mapping, parameters: { ...workflow.mapping.parameters, aspect_ratio: { nodeId: '194', inputName: 'aspect_ratio' } } },
      })) }));
      const managerConfig = () => ({ enabled: api.enabled, baseUrl: api.baseUrl, apiKey: api.apiKey, workflows: api.runningHubWorkflows, activeWorkflowId: api.activeRunningHubWorkflowId });
      return React.createElement('main', { style: { maxWidth: 1100, margin: '40px auto', padding: 20, background: 'white' } },
        React.createElement('h2', {}, 'RunningHub 图片尺寸隔离验证'),
        React.createElement(ImageOutputSizeControls, { lane: 'ordinary', value, resolved, variant: 'reference', disabled: false, capabilityNote: '', onChange: setValue }),
        React.createElement('button', { type: 'button', disabled: Boolean(resolved.issue), onClick: () => {
          const request = image.buildRunningHubImageRequest(api, { prompt: '隔离图片正文', width: resolved.width, height: resolved.height,
            sizeOverride: resolved.sizeOverride, resolutionPlan: resolved.resolutionPlan, referenceCount: 0, uploadedImages: [] });
          qa.body = request.body; qa.prepared += 1;
        } }, '准备请求（隔离）'),
        React.createElement('h3', {}, '分镜生图'),
        React.createElement(StoryboardImageOutputSizeControls, { value: storyValue, resolved: storyResolved, aspectRatio: '16:9', disabled: false, onChange: setStoryValue }),
        React.createElement('button', { type: 'button', onClick: () => setManager(true) }, '打开图片工作流管理'),
        manager && React.createElement(RunningHubWorkflowManager, { config: managerConfig(), getCurrentConfig: managerConfig, mediaKind: 'image',
          importWorkflow: image.importRunningHubImageWorkflow, isWorkflowReady: image.isRunningHubImageWorkflowReady, validateWorkflow: image.validateRunningHubImageWorkflow,
          onChange: (next) => { qa.saves += 1; setApi((current) => ({ ...current, runningHubWorkflows: next.workflows, activeRunningHubWorkflowId: next.activeWorkflowId })); },
          onClose: () => setManager(false),
        }),
      );
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  await ordinaryMode().waitFor(); let state = await current();
  if (!remainingOnly) {
  assert.equal(state.value.mode, '2k'); assert.equal(state.resolved.issue, '');
  assert.equal(state.resolved.workflowSizeMode, 'tier'); assert.equal(state.resolved.workflowAspect, true);
  assert.match(await ordinaryGroup().locator('.image-output-size-summary').innerText(), /档位估算（以返回为准）/u);
  assert.match(await ordinaryGroup().innerText(), /比例由云端工作流决定/u);
  assert.equal(await page.getByLabel('普通生图画面比例', { exact: true }).locator('option').first().innerText(), '工作流比例');
  assert.equal(await ordinaryMode().locator('option[value="default"]').innerText(), '工作流默认尺寸');
  assert.equal(await page.getByLabel('分镜图分辨率', { exact: true }).locator('option[value="default"]').innerText(), '工作流默认尺寸');
  await prepareAndAssert('2048'); await capture('resolution-only-2k-workflow-ratio');
  for (const [mode, resolution] of [['1k', '1024'], ['4k', '4096']]) {
    await ordinaryMode().selectOption(mode); await page.waitForFunction((value) => window.__rhImageSizeQa.value.mode === value, mode);
    assert.equal((await current()).resolved.issue, ''); await prepareAndAssert(resolution);
  }
  stages.push({ name: 'resolution-only-1k-2k-4k-real-field-values', passed: true });

  await ordinaryMode().selectOption('custom'); await page.waitForFunction(() => window.__rhImageSizeQa.value.mode === 'custom');
  assert.ok((await current()).resolved.issue); assert.equal(await page.getByRole('button', { name: '准备请求（隔离）', exact: true }).isDisabled(), true);
  await ordinaryMode().selectOption('default'); await page.waitForFunction(() => window.__rhImageSizeQa.value.mode === 'default');
  assert.equal((await current()).resolved.issue, ''); assert.equal((await current()).resolved.sizeOverride, false);
  assert.ok(!(await ordinaryMode().locator('option:checked').innerText()).includes('旧规格')); await prepareAndAssert('2048');
  assert.match(await ordinaryGroup().locator('.image-output-size-summary > span').innerText(), /^工作流默认尺寸/u);
  await page.getByLabel('分镜图分辨率', { exact: true }).selectOption('default');
  await page.waitForFunction(() => window.__rhImageSizeQa.storyResolved.sizeOverride === false);
  assert.equal(await page.getByLabel('分镜图分辨率', { exact: true }).inputValue(), 'default');
  assert.ok(!(await page.getByRole('group', { name: '分镜生图分辨率', exact: true }).innerText()).includes('旧规格'));
  assert.match(await page.getByRole('group', { name: '分镜生图分辨率', exact: true }).locator('.image-output-size-summary > span').innerText(), /^工作流默认尺寸/u);
  stages.push({ name: 'custom-pixels-blocked-and-workflow-default-always-available', passed: true });
  } else {
    await page.getByLabel('分镜图分辨率', { exact: true }).selectOption('default');
  }

  await page.evaluate(() => window.__rhImageSizeQa.restoreOldAspect());
  await page.waitForFunction(() => window.__rhImageSizeQa.value.aspect === '16:9');
  assert.ok((await current()).resolved.issue, 'an unmapped explicit old aspect is rejected, not dropped');
  const aspect = page.getByLabel('普通生图画面比例', { exact: true });
  assert.equal(await aspect.inputValue(), '16:9'); assert.equal(await aspect.locator('option[value="16:9"]').evaluate((element) => element.disabled), true);
  await capture('old-explicit-aspect-preserved-with-visible-issue');
  await aspect.selectOption('variant'); await page.waitForFunction(() => window.__rhImageSizeQa.value.aspect === 'variant');
  assert.equal((await current()).resolved.issue, '');
  stages.push({ name: 'old-unmapped-aspect-preserved-and-user-can-return-to-workflow-ratio', passed: true });

  const before = JSON.stringify((await current()).api);
  await page.getByRole('button', { name: '打开图片工作流管理', exact: true }).click();
  await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor();
  await page.getByRole('tab', { name: '生成参数', exact: true }).click();
  const ratioBinding = page.getByLabel('RunningHub 画面比例节点字段', { exact: true });
  assert.equal(await ratioBinding.inputValue(), '["",""]', 'opening the editor does not guess a ratio binding');
  await ratioBinding.selectOption('["194","aspect_ratio"]');
  const ratioDefault = page.getByLabel('RunningHub 画面比例默认值', { exact: true });
  assert.equal(await ratioDefault.evaluate((element) => element.tagName), 'SELECT');
  await ratioDefault.selectOption('16:9');
  assert.equal(await ratioBinding.inputValue(), '["194","aspect_ratio"]');
  assert.equal(await ratioDefault.inputValue(), '16:9');
  assert.equal(JSON.stringify((await current()).api), before, 'ratio edits are not saved early');
  await capture('explicit-optional-ratio-binding-complete-option');
  await page.getByRole('tab', { name: '请求 JSON', exact: true }).click();
  const nodes = JSON.parse(await page.getByLabel('RunningHub 请求 JSON 编辑稿', { exact: true }).inputValue()).nodeInfoList;
  assert.equal(nodes.find((node) => node.nodeId === '194').fieldValue, '16:9', 'draft retains the full colon-separated option');
  assert.equal(nodes.find((node) => node.nodeId === '195').fieldValue, 'false', 'conditional switch is never opened automatically');
  assert.equal(nodes.find((node) => node.nodeId === '191').fieldValue, '1');
  await page.getByRole('button', { name: '关闭 RunningHub 工作流管理', exact: true }).click();
  await page.getByRole('button', { name: '放弃编辑并继续', exact: true }).click();
  await page.getByRole('dialog', { name: 'RunningHub 云端图片工作流管理', exact: true }).waitFor({ state: 'detached' });
  assert.equal(JSON.stringify((await current()).api), before);
  assert.equal(await page.evaluate(() => window.__rhImageSizeQa.saves), 0, 'manager save callback belongs to the separate baseline check');
  stages.push({ name: 'optional-ratio-mapping-full-default-value-draft-without-switch-changes', passed: true });

  await ordinaryMode().selectOption('default');
  await page.evaluate(() => window.__rhImageSizeQa.useMappedRatio());
  await page.waitForFunction(() => window.__rhImageSizeQa.value.mode === 'default' && window.__rhImageSizeQa.resolved.workflowAspect === false);
  assert.match(await ordinaryGroup().locator('.image-output-size-summary > span').innerText(), /^工作流默认尺寸/u);
  assert.equal(await aspect.locator('option:checked').innerText(), '工作流比例');
  const storyGroup = page.getByRole('group', { name: '分镜生图分辨率', exact: true });
  assert.match(await storyGroup.locator('.image-output-size-summary > span').innerText(), /^工作流默认尺寸/u);
  assert.match(await storyGroup.locator('.storyboard-image-output-size-aspect').innerText(), /工作流比例/u);
  assert.match(await ordinaryGroup().innerText(), /条件开关/u); assert.match(await storyGroup.innerText(), /条件开关/u);
  await prepareAndAssert('2048'); await capture('default-with-tier-capability-and-mapped-ratio');
  stages.push({ name: 'default-summary-and-ratio-with-existing-tier-and-ratio-bindings', passed: true });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
} catch (cause) {
  failure = { message: cause.message, stack: cause.stack }; if (page) { try { await capture('failure'); } catch {} }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, scope: remainingOnly ? 'Remaining old-aspect recovery, optional ratio draft, default mapped-ratio UI; earlier tier/custom checks already passed' : 'RunningHub V3 resolution-only size controls and optional image ratio mapping', viewport: { width: 1430, height: 870 }, stages, screenshots, errors, blocked, failure }, null, 2));
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ passed: !failure, report: path.join(output, 'report.json'), stages: stages.length }));
if (failure) process.exitCode = 1;
