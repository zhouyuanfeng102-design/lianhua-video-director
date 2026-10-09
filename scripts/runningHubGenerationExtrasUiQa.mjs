import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Source-only UI verification in fresh browser storage. Model options below are
// synthetic QA choices, not a discovered cloud inventory. Never submit a task.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `runninghub-generation-extras-${version}-source`);
fs.mkdirSync(output, { recursive: true });
const curl = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'runningHubOrbitH3Curl.txt'), 'utf8');
const body = curl.match(/--data-raw\s+'([\s\S]*)'\s*$/u)?.[1];
assert.ok(body, 'the sanitized fixture has an inspectable request body');
const requestTemplate = JSON.parse(body.replace(/'\\''/gu, "'"));
requestTemplate.usePersonalQueue = false;
for (const node of requestTemplate.nodeInfoList) {
  if (node.fieldName === 'image') node.fieldValue = 'None';
  if (node.fieldName === 'video') node.fieldValue = 'None';
  if (node.nodeId === '192' && node.fieldName === 'text') node.fieldValue = '工作人员在训练场整理器材。';
}
const fixtureValue = (nodeId, fieldName) => requestTemplate.nodeInfoList.find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;
const original159 = fixtureValue('159', 'lora_name');
const original199 = fixtureValue('199', 'lora_name');
const originalUnet = fixtureValue('165', 'unet_name');
const synthetic159 = 'qa-isolated-lora-selection.safetensors';
const synthetic199 = 'qa-isolated-camera-lora.safetensors';
const syntheticUnet = 'qa-isolated-main-model.safetensors';
const manualModel = 'qa-isolated-manual-lora.safetensors';
const custom159 = 'qa-isolated-custom-lora.safetensors';
const precise199 = '0.12500000000000003';
const preciseManual = '0.35000000000000003';
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const workflowId = 'generation-extras-ui-workflow';
const bootstrap = `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true}}); await server.listen();`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'RunningHub generation extras source UI', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let manager; let failure;
const errors = []; const externalRequests = []; const attemptedMutations = []; const checks = []; const layouts = [];
const keyOf = (nodeId, fieldName) => JSON.stringify([nodeId, fieldName]);
const saved = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const savedWorkflow = async () => (await saved()).settings.runningHubVideo.workflows.find((workflow) => workflow.id === workflowId);
const valueAt = (workflow, nodeId, fieldName) => JSON.parse(workflow.requestTemplate).nodeInfoList.find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;
const seed = async () => page.evaluate(({ key, origin, workflowId, requestTemplate, synthetic159, original159, manualModel }) => {
  const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
  const nodeCatalog = requestTemplate.nodeInfoList.filter((node) => ['string', 'number', 'boolean'].includes(typeof node.fieldValue)).map((node) => ({
    nodeId: node.nodeId, fieldName: node.fieldName, fieldValue: node.fieldValue,
    ...(node.nodeId === '179' ? { description: '视频时长/秒' } : node.nodeId === '147' ? { description: '像素/百万' } : node.nodeId === '124' ? { description: '采样步数' } : {}),
    ...(node.nodeId === '115' && node.fieldName === 'aspect_ratio' ? { control: { kind: 'select', options: ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'] } } : {}),
    ...(node.nodeId === '159' && node.fieldName === 'lora_name' ? { control: { kind: 'select', options: [original159, synthetic159] } } : {}),
    ...(node.fieldName === 'strength_model' ? { control: { kind: 'number' } } : {}),
  }));
  nodeCatalog.push(
    { nodeId: 'qa-manual', fieldName: 'model_file', fieldValue: manualModel, description: '隔离测试手动 LoRA 模型' },
    { nodeId: 'qa-manual', fieldName: 'weight', fieldValue: '0.2500000000000001', description: '隔离测试手动 LoRA 强度', control: { kind: 'number' } },
    { nodeId: 'qa-other', fieldName: 'flag', fieldValue: false, description: '隔离测试布尔参数' },
    { nodeId: 'qa-other', fieldName: 'count', fieldValue: 2, description: '隔离测试数值参数', control: { kind: 'number' } },
  );
  const workflow = {
    id: workflowId, name: 'LoRA 与其它参数隔离验收', runKind: 'ai-app', remoteId: '2092524412225826817', createdAt: now, updatedAt: now,
    requestTemplate: JSON.stringify(requestTemplate), nodeCatalog,
    mapping: { prompt: [{ nodeId: '192', inputName: 'text' }], images: [], parameters: {
      duration: { nodeId: '179', inputName: 'value' }, aspect_ratio: { nodeId: '115', inputName: 'aspect_ratio' }, resolution: { nodeId: '147', inputName: 'value' }, steps: { nodeId: '124', inputName: 'steps' },
    } },
  };
  state.settings.runningHubVideo = { enabled: false, apiKey: '', baseUrl: `${origin}/mock`, activeWorkflowId: workflowId, workflows: [workflow] };
  state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
  for (const name of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
  const project = { ...state.project, id: 'generation-extras-ui-project', name: '生成参数隔离验收', sourceDocuments: [], chapterWorkspaces: {}, activeChapterId: undefined,
    characters: [], locations: [], props: [], assets: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
}, { key: storageKey, origin, workflowId, requestTemplate, synthetic159, original159, manualModel });

const openManager = async () => {
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('tab', { name: '视频生成', exact: true }).click();
  await page.getByRole('tab', { name: 'RunningHub 云端', exact: true }).click();
  await page.getByRole('button', { name: '管理云端工作流', exact: true }).click();
  manager = page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true });
  await manager.getByRole('tab', { name: '生成参数', exact: true }).click();
};
const section = async (name) => manager.getByRole('tab', { name, exact: true }).click();
const childDialog = (name) => page.getByRole('dialog', { name, exact: true });
const visibleLoraEditor = async (label) => {
  const editor = manager.getByLabel(label, { exact: true });
  if (await editor.isVisible()) return editor;
  const previous = manager.getByRole('button', { name: 'LoRA上一页', exact: true });
  if (await previous.isEnabled()) {
    await previous.click();
    if (await editor.isVisible()) return editor;
  }
  const next = manager.getByRole('button', { name: 'LoRA下一页', exact: true });
  if (await next.isEnabled()) await next.click();
  assert.equal(await editor.isVisible(), true, `${label}: editor is reachable on one of the fixture's two pages`);
  return editor;
};
const configureChoices = async (buttonLabel, dialogTitle, values) => {
  await manager.getByRole('button', { name: buttonLabel, exact: true }).click();
  const child = childDialog(dialogTitle); await child.waitFor();
  await child.getByLabel('其它参数控件类型', { exact: true }).selectOption('select');
  await child.getByLabel('节点实际候选值', { exact: true }).fill(values.join('\n'));
  await child.getByRole('button', { name: '应用', exact: true }).click();
  await child.waitFor({ state: 'hidden' });
};
const addOther = async (nodeId, fieldName) => {
  await manager.getByRole('button', { name: '添加其它参数', exact: true }).click();
  const child = childDialog('添加其它参数'); await child.waitFor();
  const candidate = child.getByLabel('其它参数位置', { exact: true });
  const choices = await candidate.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  assert.ok(!choices.includes(keyOf('159', 'lora_name')), 'LoRA model cannot also become an other parameter');
  assert.ok(!choices.includes(keyOf('159', 'strength_model')), 'LoRA strength cannot also become an other parameter');
  assert.ok(!choices.includes(keyOf('124', 'steps')), 'a common binding cannot also become an other parameter');
  assert.ok(choices.includes(keyOf('232', 'text')), 'an unbound custom text field remains selectable');
  assert.ok(!choices.includes(keyOf('192', 'text')), 'the actual mapped prompt stays reserved');
  await candidate.selectOption(keyOf(nodeId, fieldName));
  await child.getByRole('button', { name: '应用', exact: true }).click();
  await child.waitFor({ state: 'hidden' });
};

const checkFit = async (label, selector, expectedCards) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const layout = await manager.evaluate((dialog, selector) => {
    const pane = dialog.querySelector('.vwm-tab-panel');
    const cards = [...pane.querySelectorAll(selector)].filter((node) => node.getClientRects().length);
    const rect = (node) => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
    const controls = cards.flatMap((card) => [...card.querySelectorAll('input,select,button')].filter((control) => control.getClientRects().length && !control.closest('[hidden]')));
    const clipped = controls.flatMap((control) => {
      const box = control.getBoundingClientRect();
      for (let ancestor = control.parentElement; ancestor && ancestor !== dialog.parentElement; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); const bounds = ancestor.getBoundingClientRect();
        if (/(?:auto|scroll|hidden|clip)/u.test(style.overflowY) && (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1)
          || /(?:auto|scroll|hidden|clip)/u.test(style.overflowX) && (box.left < bounds.left - 1 || box.right > bounds.right + 1)) {
          return [{ label: control.getAttribute('aria-label') || control.textContent, ancestor: ancestor.className }];
        }
      }
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return target && (target === control || control.contains(target) || target.contains(control)) ? [] : [{ label: control.getAttribute('aria-label') || control.textContent, occluded: true }];
    });
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存工作流');
    return { viewport: { width: innerWidth, height: innerHeight }, pane: { ...rect(pane), scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight, scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth },
      cards: cards.map(rect), controls: controls.map(rect), save: rect(save), clipped, pageScrollWidth: document.documentElement.scrollWidth };
  }, selector);
  layouts.push({ label, ...layout });
  assert.equal(layout.cards.length, expectedCards, `${label}: all expected cards appear on this page`);
  assert.ok(layout.pane.scrollHeight <= layout.pane.clientHeight + 1, `${label}: no internal vertical scrollbar: ${JSON.stringify(layout.pane)}`);
  assert.ok(layout.pane.scrollWidth <= layout.pane.clientWidth + 1, `${label}: no internal horizontal scrollbar`);
  assert.ok(layout.pageScrollWidth <= layout.viewport.width + 1, `${label}: no horizontal page overflow`);
  for (const box of [...layout.cards, ...layout.controls, layout.save]) assert.ok(box.left >= -1 && box.right <= layout.viewport.width + 1 && box.top >= -1 && box.bottom <= layout.viewport.height + 1,
    `${label}: card, editor or save button lies outside viewport: ${JSON.stringify(box)}`);
  assert.deepEqual(layout.clipped, [], `${label}: editable controls are visible and never clipped`);
};

// The interaction body uses exact accessible names shared with the UI editor.
const run = async () => {
  await waitForCondition({ label: 'source Vite startup', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) { externalRequests.push(request.url()); await route.abort('blockedbyclient'); return; }
    if (request.method() !== 'GET' && request.method() !== 'HEAD') { attemptedMutations.push(request.url()); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('.sidebar').waitFor();
  await waitForCondition({ label: 'fresh browser persistence', timeoutMs: 10_000, intervalMs: 100, check: () => page.evaluate((key) => Boolean(localStorage.getItem(key)), storageKey) });
  checks.push('source modules cold-start without runtime errors'); await seed(); await page.reload({ waitUntil: 'networkidle' });
  await openManager();
  assert.equal(await manager.getByRole('tab', { name: '高级：指定宽高', exact: true }).count(), 0);
  for (const name of ['常用参数', 'LoRA', '其它']) assert.equal(await manager.getByRole('tab', { name, exact: true }).isVisible(), true);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport); await section('常用参数'); await checkFit(`common-${viewport.width}x${viewport.height}`, '.rhv-output-field', 4);
    await page.screenshot({ path: path.join(output, `common-${viewport.width}x${viewport.height}.png`) });
    await section('LoRA'); await checkFit(`lora-${viewport.width}x${viewport.height}`, '.rhv-extras-lora-card', 4);
    await page.screenshot({ path: path.join(output, `lora-${viewport.width}x${viewport.height}.png`) });
  }
  checks.push('all four common and four detected LoRA cards fit without internal scrolling in three viewports');
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.ok((await manager.locator('.rhv-extras-heading').innerText()).includes('已展示 4 个 LoRA 槽位 · 自动识别 4 个'));
  assert.equal(await manager.getByLabel('LoRA 模型 165.unet_name', { exact: true }).count(), 0, 'a main model is never classified as a LoRA');
  assert.equal(valueAt(await savedWorkflow(), 'qa-manual', 'model_file'), undefined, 'catalogue positions stay out of the request until explicitly added');
  const model159 = manager.getByLabel('LoRA 模型 159.lora_name', { exact: true });
  const discoveredChoices = await model159.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  assert.ok(discoveredChoices.includes(original159) && discoveredChoices.includes(synthetic159), 'exact catalogue choices appear as a select');
  await model159.selectOption(synthetic159);
  await model159.selectOption('__rhv_custom_value__');
  await manager.getByLabel('LoRA 模型自定义值 159.lora_name', { exact: true }).fill(custom159);
  await configureChoices('配置LoRA候选 199.lora_name', 'LoRA 模型 · 显示设置', [original199, synthetic199]);
  await manager.getByLabel('LoRA 模型 199.lora_name', { exact: true }).selectOption(synthetic199);
  await manager.getByLabel('模型强度 199.strength_model', { exact: true }).fill(precise199);
  await manager.getByLabel('模型强度 224.strength_model', { exact: true }).fill('0');
  await manager.getByRole('button', { name: '配置LoRA候选 159.lora_name', exact: true }).click();
  const escapeChild = childDialog('LoRA 模型 · 显示设置'); await escapeChild.waitFor();
  await page.keyboard.press('Escape'); await escapeChild.waitFor({ state: 'hidden' });
  assert.equal(await manager.isVisible(), true, 'Escape closes only the child editor');
  assert.equal(await manager.getByRole('tab', { name: 'LoRA', exact: true }).getAttribute('aria-selected'), 'true');
  checks.push('four actual LoRA slots are detected; real field choices, custom filenames, model defaults and exact strength strings can be edited');
  checks.push('Escape closes the nested display editor while preserving the parent manager and its LoRA section');

  await manager.getByRole('button', { name: '添加 LoRA 位置', exact: true }).click();
  const loraPosition = childDialog('添加 / 修改 LoRA 位置'); await loraPosition.waitFor();
  await loraPosition.getByLabel('LoRA 模型位置', { exact: true }).selectOption(keyOf('qa-manual', 'model_file'));
  await loraPosition.getByLabel('LoRA 模型强度位置（可选）', { exact: true }).selectOption(keyOf('qa-manual', 'weight'));
  await loraPosition.getByLabel('LoRA位置名称', { exact: true }).fill('QA 手动 LoRA');
  await loraPosition.getByRole('button', { name: '应用', exact: true }).click(); await loraPosition.waitFor({ state: 'hidden' });
  assert.ok((await manager.locator('.rhv-extras-heading').innerText()).includes('已展示 5 个 LoRA 槽位'));
  await checkFit('five-loras-first-page-1440x900', '.rhv-extras-lora-card', 4);
  await manager.getByRole('button', { name: 'LoRA下一页', exact: true }).click();
  await checkFit('five-loras-second-page-1440x900', '.rhv-extras-lora-card', 1);
  await page.screenshot({ path: path.join(output, 'five-loras-second-page.png') });
  assert.equal(await manager.getByRole('button', { name: 'LoRA下一页', exact: true }).isDisabled(), true);
  await (await visibleLoraEditor('模型强度 qa-manual.weight')).fill(preciseManual);
  const previousLoraPage = manager.getByRole('button', { name: 'LoRA上一页', exact: true });
  if (await previousLoraPage.isEnabled()) await previousLoraPage.click();
  checks.push('an explicit manual model/strength position adds a fifth LoRA; pagination keeps all editors and the save button visible');

  await section('其它');
  await addOther('165', 'unet_name');
  await configureChoices('配置其它参数 165.unet_name', 'unet_name · 显示设置', [originalUnet, syntheticUnet]);
  await manager.getByLabel('工作流默认值 165.unet_name', { exact: true }).selectOption(syntheticUnet);
  await addOther('qa-other', 'flag');
  await manager.getByLabel('工作流默认值 qa-other.flag', { exact: true }).selectOption('true');
  await addOther('qa-other', 'count');
  await manager.getByLabel('工作流默认值 qa-other.count', { exact: true }).fill('9');
  await checkFit('three-other-fields-1440x900', '.rhv-extras-card', 3);
  await page.screenshot({ path: path.join(output, 'other-parameters.png') });
  await manager.getByRole('button', { name: '保存工作流', exact: true }).click();
  await waitForCondition({ label: 'generation extras and defaults persisted', timeoutMs: 10_000, intervalMs: 100, check: async () => {
    const workflow = await savedWorkflow();
    return workflow.generationExtras?.loraSlots?.length === 1 && workflow.generationExtras?.otherFields?.length === 3
      && valueAt(workflow, 'qa-other', 'flag') === true && valueAt(workflow, '199', 'strength_model') === precise199;
  } });
  const workflow = await savedWorkflow();
  assert.equal(valueAt(workflow, '159', 'lora_name'), custom159);
  assert.equal(valueAt(workflow, '199', 'lora_name'), synthetic199);
  assert.equal(valueAt(workflow, '159', 'strength_model'), '0.5000000000000001', 'unmodified precision remains exact');
  assert.equal(valueAt(workflow, '199', 'strength_model'), precise199, 'editing string strength preserves its full decimal text');
  assert.equal(valueAt(workflow, '224', 'strength_model'), '0', 'zero remains a string value');
  assert.equal(valueAt(workflow, '153', 'strength_model'), '1.0000000000000002', 'another unmodified precision remains exact');
  assert.equal(valueAt(workflow, 'qa-manual', 'model_file'), manualModel);
  assert.equal(valueAt(workflow, 'qa-manual', 'weight'), preciseManual);
  assert.equal(valueAt(workflow, '165', 'unet_name'), syntheticUnet);
  assert.equal(valueAt(workflow, 'qa-other', 'flag'), true, 'boolean input retains boolean type');
  assert.equal(valueAt(workflow, 'qa-other', 'count'), 9, 'number input retains numeric type');
  assert.deepEqual(workflow.generationExtras.loraSlots[0], { model: { nodeId: 'qa-manual', inputName: 'model_file' }, strength: { nodeId: 'qa-manual', inputName: 'weight' }, label: 'QA 手动 LoRA' });
  assert.deepEqual(workflow.generationExtras.otherFields, [{ nodeId: '165', inputName: 'unet_name' }, { nodeId: 'qa-other', inputName: 'flag' }, { nodeId: 'qa-other', inputName: 'count' }]);
  assert.deepEqual(workflow.fieldControls[keyOf('199', 'lora_name')].options, [original199, synthetic199]);
  assert.deepEqual(workflow.fieldControls[keyOf('165', 'unet_name')].options, [originalUnet, syntheticUnet]);
  const submitted = JSON.parse(workflow.requestTemplate);
  assert.equal(submitted.nodeInfoList.length, requestTemplate.nodeInfoList.length + 4, 'only the explicitly selected catalogue fields are added');
  for (const metadata of ['generationExtras', 'nodeCatalog', 'fieldControls']) assert.equal(Object.hasOwn(submitted, metadata), false, `${metadata} stays local and never enters the wire template`);
  const changed = new Map([[keyOf('159', 'lora_name'), custom159], [keyOf('199', 'lora_name'), synthetic199], [keyOf('199', 'strength_model'), precise199], [keyOf('165', 'unet_name'), syntheticUnet]]);
  for (const original of requestTemplate.nodeInfoList) {
    const node = submitted.nodeInfoList.find((item) => item.nodeId === original.nodeId && item.fieldName === original.fieldName);
    assert.deepEqual(node, { ...original, ...(changed.has(keyOf(original.nodeId, original.fieldName)) ? { fieldValue: changed.get(keyOf(original.nodeId, original.fieldName)) } : {}) }, `unrelated request metadata and defaults for ${original.nodeId}.${original.fieldName} survive`);
  }
  checks.push('other fields support a main-model selector, boolean and numeric defaults; saving preserves original scalar types, zero, full strength precision and unrelated request fields');

  await page.reload({ waitUntil: 'networkidle' }); await openManager(); await section('LoRA');
  assert.ok((await manager.locator('.rhv-extras-heading').innerText()).includes('已展示 5 个 LoRA 槽位'));
  assert.equal(await manager.getByLabel('LoRA 模型 159.lora_name', { exact: true }).inputValue(), custom159);
  assert.equal(await manager.getByLabel('LoRA 模型 199.lora_name', { exact: true }).inputValue(), synthetic199);
  assert.equal(await manager.getByLabel('模型强度 199.strength_model', { exact: true }).inputValue(), precise199);
  assert.equal(await manager.getByRole('button', { name: 'LoRA下一页', exact: true }).isEnabled(), true);
  assert.equal(await (await visibleLoraEditor('模型强度 qa-manual.weight')).inputValue(), preciseManual);
  await section('其它');
  assert.equal(await manager.getByLabel('工作流默认值 165.unet_name', { exact: true }).inputValue(), syntheticUnet);
  assert.equal(await manager.getByLabel('工作流默认值 qa-other.flag', { exact: true }).inputValue(), 'true');
  assert.equal(await manager.getByLabel('工作流默认值 qa-other.count', { exact: true }).inputValue(), '9');
  checks.push('reload restores manual LoRA positions, model option controls, custom filename, exact decimal strength and all three other-field values');
  assert.deepEqual(externalRequests, []); assert.deepEqual(attemptedMutations, []); assert.deepEqual(errors, []);
  const state = await saved(); assert.equal(state.project.generationTasks.length, 0);
  assert.ok(state.projects.every((project) => (project.generationTasks || []).length === 0));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, version, productionPreview: false, sourcePreview: true, isolatedBrowserStorage: true,
    fixtureModelChoices: 'synthetic QA choices only; no cloud inventory was queried', realVideoRequests: 0, createdTasks: 0, checks, layouts, externalRequests, attemptedMutations, errors }, null, 2));
  console.log(`RunningHub generation extras source UI checks passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks, layouts, externalRequests, attemptedMutations, errors }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); }
if (failure) throw failure;
