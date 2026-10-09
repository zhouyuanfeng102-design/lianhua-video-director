import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A fresh browser profile and synthetic project only. No
// generation, discovery, upload, external account or user project is contacted.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sourcePreview = process.env.RUNNINGHUB_SAMPLING_QA_SOURCE === '1';
const output = path.join(root, 'output', 'playwright', `runninghub-sampling-${version}${sourcePreview ? '-source' : ''}`);
fs.mkdirSync(output, { recursive: true });
const curl = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'runningHubOrbitH3Curl.txt'), 'utf8');
const body = curl.match(/--data-raw\s+'([\s\S]*)'\s*$/u)?.[1];
assert.ok(body); const requestTemplate = JSON.parse(body.replace(/'\\''/gu, "'"));
requestTemplate.usePersonalQueue = false;
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = sourcePreview
  ? `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true}}); await server.listen();`
  : `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'RunningHub sampling production controls and fit', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure;
const errors = []; const externalRequests = []; const attemptedMutations = []; const checks = []; const layouts = [];
const saved = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const savedWorkflow = async () => (await saved()).settings.runningHubVideo.workflows.find((workflow) => workflow.id === 'sampling-ui-workflow');
const valueAt = (workflow, id, name) => JSON.parse(workflow.requestTemplate).nodeInfoList.find((node) => node.nodeId === id && node.fieldName === name)?.fieldValue;
const seed = async () => page.evaluate(({ key, origin, requestTemplate }) => {
  const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
  const workflow = {
    id: 'sampling-ui-workflow', name: '星轨 H3 采样隔离配置', runKind: 'ai-app', remoteId: '2092524412225826817', createdAt: now, updatedAt: now,
    requestTemplate: JSON.stringify(requestTemplate),
    nodeCatalog: requestTemplate.nodeInfoList.filter((node) => typeof node.fieldValue === 'string').map((node) => ({
      nodeId: node.nodeId, fieldName: node.fieldName, fieldValue: node.fieldValue,
      ...(node.nodeId === '179' ? { description: '时长/秒' } : node.nodeId === '147' ? { description: '像素/百万' } : node.nodeId === '124' ? { description: '采样步数' } : {}),
      ...(node.nodeId === '115' ? { control: { kind: 'select', options: ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'] } } : {}),
    })),
    mapping: { prompt: [{ nodeId: '192', inputName: 'text' }], images: [], parameters: {
      duration: { nodeId: '179', inputName: 'value' }, aspect_ratio: { nodeId: '115', inputName: 'aspect_ratio' }, resolution: { nodeId: '147', inputName: 'value' },
    } },
  };
  state.settings.runningHubVideo = { enabled: false, apiKey: '', baseUrl: `${origin}/mock`, activeWorkflowId: workflow.id, workflows: [workflow] };
  state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
  for (const name of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi']) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
  const segments = [1, 2].map((index) => ({
    id: `sampling-ui-segment-${index}`, index, title: `中性训练 ${index}`, globalStartSec: (index - 1) * 10, globalEndSec: index * 10, durationSec: 10,
    content: `训练者整理第${index}根训练棍。`, summary: '中性训练', sourceSceneIds: ['sampling-ui-scene'], sourceBeatIds: [], narrativePurpose: '整理训练器材',
    entryState: '器材待整理', exitState: '器材整齐', transitionHint: '自然接续', storyboardId: `sampling-ui-board-${index}`, status: 'ready',
  }));
  const plan = { id: 'sampling-ui-plan', title: '采样隔离两段计划', sourceStoryTitle: '采样隔离两段计划', sourceStoryContent: '工作人员依次整理两根训练棍。',
    durationMode: 'fixed', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
  const boards = segments.map((segment) => ({
    id: segment.storyboardId, sceneId: 'sampling-ui-scene', workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: 'custom', shotMode: 'auto',
    pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId,
    converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', finalPrompt: segment.content, promptMigrationPending: false, shots: [],
    sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 2, createdAt: now, updatedAt: now,
  }));
  const project = { ...state.project, id: 'sampling-ui-project', name: '采样步骤隔离验收', sourceDocuments: [], chapterWorkspaces: {}, activeChapterId: undefined,
    characters: [], locations: [], props: [], assets: [], scenes: [{ id: 'sampling-ui-scene', title: '训练场', content: plan.sourceStoryContent, summary: '整理器材',
      characterIds: [], propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }],
    storyboards: boards, sequencePlans: [plan], generationTasks: [], updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
}, { key: storageKey, origin, requestTemplate });

const checkManagerFit = async (label) => {
  const layout = await page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true }).evaluate((dialog) => {
    const pane = dialog.querySelector('.vwm-tab-panel'); const cards = [...pane.querySelectorAll('.rhv-output-field')];
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
  });
  layouts.push({ label, ...layout });
  assert.equal(layout.cards.length, 4, `${label}: all four common parameter cards are present`);
  assert.ok(layout.pane.scrollHeight <= layout.pane.clientHeight + 1, `${label}: output pane must not need vertical scrolling: ${JSON.stringify(layout.pane)}`);
  assert.ok(layout.pane.scrollWidth <= layout.pane.clientWidth + 1, `${label}: output pane must not need horizontal scrolling`);
  assert.ok(layout.pageScrollWidth <= layout.viewport.width + 1, `${label}: no page horizontal overflow`);
  for (const box of [...layout.cards, ...layout.controls, layout.save]) {
    assert.ok(box.left >= -1 && box.right <= layout.viewport.width + 1 && box.top >= -1 && box.bottom <= layout.viewport.height + 1,
      `${label}: card, editor or save button is outside the viewport: ${JSON.stringify(box)}`);
  }
  assert.deepEqual(layout.clipped, [], `${label}: cards' editable controls are never hidden by overflow`);
  assert.ok(layout.cards[3].left > layout.cards[2].left && Math.abs(layout.cards[3].top - layout.cards[2].top) < 2,
    `${label}: sampling card sits in the bottom right of the four-card grid`);
};

const run = async () => {
  await waitForCondition({ label: 'production preview startup', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
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
  checks.push(`${sourcePreview ? 'source modules' : 'production chunks'} cold-start without runtime errors`); await seed(); await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('tab', { name: '视频生成', exact: true }).click();
  await page.getByRole('tab', { name: 'RunningHub 云端', exact: true }).click();
  await page.getByRole('button', { name: '管理云端工作流', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true });
  await manager.getByRole('tab', { name: '生成参数', exact: true }).click();
  assert.equal(await manager.getByRole('tab', { name: '高级：指定宽高', exact: true }).count(), 0);
  assert.deepEqual(await manager.getByLabel('生成参数配置类别', { exact: true }).getByRole('tab').allTextContents(), ['常用参数', 'LoRA', '其它']);
  const binding = manager.getByLabel('RunningHub 采样步数节点字段', { exact: true });
  const stepsKey = JSON.stringify(['124', 'steps']);
  assert.ok((await binding.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value))).includes(stepsKey));
  assert.equal((await savedWorkflow()).mapping.parameters.steps, undefined, 'viewing a candidate never saves a mapping');
  await binding.selectOption(stepsKey);
  assert.equal(await manager.getByLabel('RunningHub 采样步数默认值', { exact: true }).inputValue(), '10');
  const boundDefaults = ['视频时长', '画面比例', '分辨率', '采样步数'];
  for (const label of boundDefaults) assert.equal(await manager.getByLabel(`RunningHub ${label}节点字段`, { exact: true }).isVisible(), true);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport); await checkManagerFit(`common-${viewport.width}x${viewport.height}`);
    await page.screenshot({ path: path.join(output, `four-cards-${viewport.width}x${viewport.height}.png`) });
  }
  checks.push('common tab displays all four cards and editors with no internal scrolling at 1280×720, 1440×900 and 1920×1080');
  await page.setViewportSize({ width: 1280, height: 720 });
  const stepsCard = manager.locator('.rhv-output-field').filter({ has: page.getByLabel('RunningHub 采样步数节点字段', { exact: true }) });
  await stepsCard.getByRole('button', { name: 'RunningHub 采样步数输入选项设置', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'RunningHub 采样步数输入选项设置', exact: true }); await options.waitFor();
  assert.equal(await options.getByLabel('RunningHub 采样步数输入方式', { exact: true }).isVisible(), true);
  const originalPaneScroll = await manager.locator('.vwm-tab-panel').evaluate((pane) => ({ scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight }));
  assert.ok(originalPaneScroll.scrollHeight <= originalPaneScroll.clientHeight + 1, 'opening an options dialog cannot grow the common page');
  await page.keyboard.press('Escape'); await options.waitFor({ state: 'hidden' });
  checks.push('input option editor remains reachable without growing or clipping the common parameter page');
  await manager.getByRole('button', { name: '保存工作流', exact: true }).click();
  await waitForCondition({ label: 'explicit sampling mapping persisted', timeoutMs: 10_000, intervalMs: 100, check: async () => (await savedWorkflow()).mapping.parameters.steps?.nodeId === '124' });
  const workflow = await savedWorkflow(); assert.equal(valueAt(workflow, '124', 'steps'), '10');
  const normalizedOriginal = JSON.parse(JSON.stringify(requestTemplate));
  assert.deepEqual(JSON.parse(workflow.requestTemplate), normalizedOriginal, 'mapping preserves all workflow default nodes');
  await manager.getByRole('button', { name: '完成', exact: true }).click();
  checks.push('binding and saving retains the original string 10 and every unrelated cURL field');

  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  const single = page.getByLabel('本次采样步数（步）', { exact: true }); await single.waitFor();
  assert.equal(await single.isEnabled(), true); assert.equal(await single.inputValue(), '');
  assert.equal(await single.getAttribute('placeholder'), '使用默认值（10）');
  assert.equal(await single.getAttribute('min'), null); assert.equal(await single.getAttribute('max'), null);
  await single.fill('22');
  const singleJson = page.getByLabel('本次额外参数 JSON', { exact: true });
  assert.equal(JSON.parse(await singleJson.inputValue()).steps, 22);
  await single.fill(''); assert.equal(Object.hasOwn(JSON.parse(await singleJson.inputValue()), 'steps'), false);
  assert.equal(valueAt(await savedWorkflow(), '124', 'steps'), '10');
  checks.push('single quick control shows workflow default; typing and clearing adds/removes only the explicit steps override');
  await single.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'single-sampling-default.png') });

  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const batch = page.getByRole('region', { name: '长剧情批量视频' });
  const expand = batch.getByRole('button', { name: '展开批量设置', exact: true }); if (await expand.isVisible()) await expand.click();
  const batchSteps = batch.getByLabel('批量采样步数（步）', { exact: true });
  assert.equal(await batchSteps.isEnabled(), true); assert.equal(await batchSteps.inputValue(), '');
  assert.equal(await batchSteps.getAttribute('placeholder'), '使用默认值（10）');
  await batchSteps.fill('24');
  const batchJson = batch.getByLabel('批量公共参数 JSON', { exact: true });
  assert.equal(JSON.parse(await batchJson.inputValue()).steps, 24);
  await batch.getByRole('button', { name: '收起批量设置', exact: true }).click();
  assert.ok((await batch.getByLabel('当前批量设置摘要', { exact: true }).innerText()).includes('请求采样步数 24 步'));
  await batch.getByRole('button', { name: '展开批量设置', exact: true }).click();
  await batchSteps.fill(''); assert.equal(Object.hasOwn(JSON.parse(await batchJson.inputValue()), 'steps'), false);
  assert.equal(valueAt(await savedWorkflow(), '124', 'steps'), '10');
  checks.push('batch quick control writes the shared steps override, displays the correct summary and clearing keeps default 10');
  await batchSteps.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'batch-sampling-default.png') });
  assert.deepEqual(externalRequests, []); assert.deepEqual(attemptedMutations, []); assert.deepEqual(errors, []);
  const state = await saved(); assert.equal(state.project.generationTasks.length, 0);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, version, productionPreview: !sourcePreview, sourcePreview, isolatedBrowserStorage: true,
    realVideoRequests: 0, createdTasks: 0, checks, layouts, externalRequests, attemptedMutations, errors }, null, 2));
  console.log(`RunningHub sampling ${sourcePreview ? 'source' : 'production'} UI checks passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks, layouts, externalRequests, attemptedMutations, errors }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); }
if (failure) throw failure;
