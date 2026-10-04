import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Synthetic browser storage and loopback Vite only. Never reads desktop state,
// starts generation, or permits a non-loopback network request.
const root = path.resolve(import.meta.dirname, '..');
const baselineMode = process.argv.includes('--baseline');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `video-batch-compact-${baselineMode ? 'before' : 'after'}-${Date.now()}`));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Compact QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Compact QA output must not traverse directory links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const baseline = !baselineMode && process.env.QA_BASELINE ? JSON.parse(fs.readFileSync(process.env.QA_BASELINE, 'utf8')) : undefined;
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const viteBootstrap = `import {createServer} from 'vite'; const server = await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated compact batch QA Vite ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', viteBootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'compact batch UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const stages = [];
const measurements = [];
const screenshots = [];
const scenarios = [
  { width: 1430, height: 870, font: 100 },
  { width: 1430, height: 870, font: 130 },
  { width: 1996, height: 1248, font: 100 },
  { width: 1120, height: 720, font: 150 },
  { width: 1280, height: 800, font: 150 },
];

const layout = async () => page.evaluate(() => {
  const scope = document.querySelector('.video-director-view');
  const boxOf = (selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, width: box.width } : undefined;
  };
  const identify = (element) => element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) || element.tagName;
  const clipped = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const closed = element.closest('details:not([open])');
    if (style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height || (closed && !closed.querySelector(':scope > summary')?.contains(element))) return undefined;
    let left = Math.max(0, rect.left); let right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top); let bottom = Math.min(innerHeight, rect.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const parentStyle = getComputedStyle(ancestor); const parent = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/u.test(parentStyle.overflowX)) { left = Math.max(left, parent.left); right = Math.min(right, parent.right); }
      if (/(auto|scroll|hidden|clip)/u.test(parentStyle.overflowY)) { top = Math.max(top, parent.top); bottom = Math.min(bottom, parent.bottom); }
    }
    return right - left > 2 && bottom - top > 2 ? { left, right, top, bottom, width: rect.width, height: rect.height } : undefined;
  };
  const elements = [...scope.querySelectorAll('button,input,select,textarea,summary')];
  const controls = elements.map((element) => ({ element, box: clipped(element) })).filter(({ box }) => box);
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i]; const b = controls[j];
    if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
    if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 2 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 2) overlaps.push([identify(a.element), identify(b.element)]);
  }
  const occluded = controls.flatMap(({ element, box }) => {
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return hit && (hit === element || element.contains(hit) || hit.contains(element)) ? [] : [{ control: identify(element), hit: hit ? identify(hit) : null }];
  });
  const smallControls = controls.filter(({ element, box }) => element.matches('.btn,select,input:not([type="checkbox"])') && box.height < 23.5).map(({ element, box }) => ({ control: identify(element), height: box.height }));
  const overflow = [...scope.querySelectorAll('*')].filter((element) => clipped(element)).flatMap((element) => {
    const box = element.getBoundingClientRect();
    return box.left < -1 || box.right > innerWidth + 1 ? [{ element: identify(element), left: box.left, right: box.right }] : [];
  }).slice(0, 12);
  const director = boxOf('.video-director-view'); const output = boxOf('.vop-batch');
  const columns = boxOf('.vd-batch-columns'); const footer = boxOf('.vd-batch-footer');
  const executionElement = scope.querySelector(':scope > .video-execution-controls');
  const executionBox = boxOf('.video-director-view > .video-execution-controls');
  const executionStyle = executionElement && getComputedStyle(executionElement);
  const px = (value) => Number.parseFloat(value) || 0;
  // The execution strip was added after the compact-settings baseline. Count
  // its own box, margins and one additional flex gap separately, rather than
  // loosening the original settings budget or hiding its real viewport cost.
  const execution = executionBox && {
    ...executionBox,
    marginTop: px(executionStyle.marginTop), marginBottom: px(executionStyle.marginBottom),
    addedGap: px(getComputedStyle(scope).rowGap),
    occupiedHeight: executionBox.height + px(executionStyle.marginTop) + px(executionStyle.marginBottom) + px(getComputedStyle(scope).rowGap),
    visibleBox: clipped(executionElement),
    controls: [...executionElement.querySelectorAll('select,input')].map((element) => {
      const box = element.getBoundingClientRect(); const visible = clipped(element);
      return { control: identify(element), fullyVisible: Boolean(visible && visible.left <= box.left + 1 && visible.right >= box.right - 1
        && visible.top <= box.top + 1 && visible.bottom >= box.bottom - 1) };
    }),
  };
  const redRegionHeight = output.bottom - director.top;
  return {
    viewport: { width: innerWidth, height: innerHeight },
    appliedFontScale: Number(getComputedStyle(scope).getPropertyValue('--ui-font-scale').trim()),
    documentScrollWidth: document.documentElement.scrollWidth,
    director, output, columns, footer, execution,
    redRegionHeight,
    compactSettingsHeight: redRegionHeight - (execution?.occupiedHeight || 0),
    listOffset: columns.top - director.top,
    overflow, overlaps, occluded, smallControls,
  };
});

const checkLayout = (value, label) => {
  assert.ok(value.documentScrollWidth <= value.viewport.width + 1, `${label}: document overflows horizontally`);
  assert.deepEqual(value.overflow, [], `${label}: visible elements overflow`);
  assert.deepEqual(value.overlaps, [], `${label}: interactive controls overlap`);
  assert.deepEqual(value.occluded, [], `${label}: interactive controls are covered`);
  assert.deepEqual(value.smallControls, [], `${label}: primary controls retain 24px minimum height`);
  assert.ok(value.columns.height >= 118, `${label}: segment pane retains its reserved height`);
  assert.ok(value.footer.bottom <= value.viewport.height + 1, `${label}: submit footer remains visible`);
  assert.ok(value.columns.bottom <= value.footer.top + 1, `${label}: list does not cover footer`);
  assert.ok(value.execution?.height > 0, `${label}: execution strip is present`);
  assert.ok(value.execution.top >= value.director.top && value.execution.bottom <= value.columns.top,
    `${label}: execution strip retains its own place above the segment list`);
  assert.ok(value.execution.visibleBox && value.execution.visibleBox.top <= value.execution.top + 1
    && value.execution.visibleBox.bottom >= value.execution.bottom - 1
    && value.execution.visibleBox.left <= value.execution.left + 1 && value.execution.visibleBox.right >= value.execution.right - 1,
  `${label}: execution strip remains fully visible`);
  assert.ok(value.execution.controls.length >= 2 && value.execution.controls.every((control) => control.fullyVisible),
    `${label}: execution controls remain fully visible`);
};

const openBatch = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.locator('.vd-batch-row').first().waitFor();
  assert.equal(await page.locator('.vd-batch-row').count(), 6);
};

const capture = async (name) => {
  const value = await layout();
  if (!baselineMode) checkLayout(value, name);
  measurements.push({ name, ...value });
  const screenshot = `${name}.png`;
  await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
  screenshots.push(screenshot);
  console.log(JSON.stringify({ name, redRegionHeight: value.redRegionHeight, compactSettingsHeight: value.compactSettingsHeight,
    executionOccupiedHeight: value.execution?.occupiedHeight || 0, listOffset: value.listOffset, listHeight: value.columns.height }));
  return value;
};

const run = async () => {
  await waitForCondition({ label: 'compact batch Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1430, height: 870 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__compact_batch_fixture__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__compact_batch_fixture__', '1'); }
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push(`Unexpected external request: ${route.request().url()}`); await route.abort('blockedbyclient');
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(async ({ key, base }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { createRunningHubTutorialVideoWorkflow, defaultRunningHubVideoConfig } = await import('/src/runningHubVideo.ts');
    const workflows = [2, 3, 4].map((count) => {
      const item = createRunningHubTutorialVideoWorkflow();
      item.id = `compact-workflow-${count}`; item.name = count === 2 ? '导入的云端工作流 (2)' : `${count} 个输出字段测试工作流`;
      const request = JSON.parse(item.requestTemplate);
      const keys = count === 2 ? [] : count === 3 ? ['width', 'height'] : ['resolution', 'width', 'height'];
      for (const name of keys) { request.nodeInfoList.push({ nodeId: '900', fieldName: name, fieldValue: name === 'resolution' ? '1080P' : '1080' }); item.mapping.parameters[name] = { nodeId: '900', inputName: name }; }
      item.requestTemplate = JSON.stringify(request); return item;
    });
    state.settings.runningHubVideo = { ...defaultRunningHubVideoConfig, enabled: true, apiKey: '', baseUrl: base, workflows, activeWorkflowId: workflows[0].id };
    state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
    const segments = Array.from({ length: 6 }, (_, offset) => ({
      id: `compact-segment-${offset + 1}`, index: offset + 1, title: ['晨雾演武场：准备与起手', '第一轮攻防与小师妹连续抢攻', '决定性反击与切磋结束', '竹林转场与人物对白', '归途回望与环境镜头', '终场定格与剧情衔接'][offset],
      globalStartSec: offset * 15, globalEndSec: (offset + 1) * 15, durationSec: 15, content: `第 ${offset + 1} 段隔离剧情`, summary: '', sourceSceneIds: ['compact-scene'], sourceBeatIds: [], narrativePurpose: '推进剧情', entryState: '', exitState: '', transitionHint: '', storyboardId: `compact-board-${offset + 1}`, status: 'ready',
    }));
    const plan = { id: 'compact-plan', title: '剧情原文', sourceStoryTitle: '剧情原文', sourceStoryContent: '仅在隔离浏览器中使用的六段剧情', durationMode: 'ai-estimated', totalDurationSec: 90, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const storyboards = segments.map((segment) => {
      const zh = `第 ${segment.index} 段：人物在晨光中完成连续动作，镜头跟随。`; const en = `Segment ${segment.index}: A character completes a continuous action in morning light. The camera follows.`;
      return { id: segment.storyboardId, sceneId: 'compact-scene', sourceStoryTitle: '剧情原文', workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [], finalPrompt: zh, englishPrompt: en, englishPromptSource: zh, officialPromptZh: zh, officialPromptEn: en, officialPromptSource: zh, officialPromptEnSource: zh, promptMigrationPending: false, promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', stylePresetId: state.settings.defaultStylePresetId, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete' }, shots: [], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 6, createdAt: now, updatedAt: now };
    });
    const project = { ...state.project, id: 'compact-isolated-project', name: '隔离六段布局验证', sourceDocuments: [], characters: [], locations: [], props: [], assets: [], generationTasks: [], scenes: [{ id: 'compact-scene', title: '布局验证', content: plan.sourceStoryContent, summary: '', characterIds: [], propIds: [], storyboardIds: storyboards.map((item) => item.id), createdAt: now, updatedAt: now }], sequencePlans: [plan], storyboards, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.ui = { ...state.ui, activeView: 'video' };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, base: new URL(baseUrl).origin });
  for (const scenario of scenarios) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.evaluate(({ key, font }) => { const state = JSON.parse(localStorage.getItem(key)); state.settings.uiFontScalePercent = font; localStorage.setItem(key, JSON.stringify(state)); }, { key: storageKey, font: scenario.font });
    await page.reload({ waitUntil: 'networkidle' }); await openBatch();
    // Stored preferences currently clamp at 130%. Explicitly apply the extra
    // 150% stress setting so the test cannot silently exercise only 130%.
    await page.locator('[data-ui-font-scale]').evaluate((element, font) => element.style.setProperty('--ui-font-scale', String(font / 100)), scenario.font);
    await page.getByRole('button', { name: '全选英文', exact: true }).click();
    const name = `${scenario.width}x${scenario.height}-font${scenario.font}`;
    const value = await capture(name);
    assert.equal(value.appliedFontScale, scenario.font / 100, `${name}: requested font scale was actually applied`);
    if (!baselineMode && scenario.width >= 1430) {
      const maxHeight = scenario.font === 100 ? 225 : 252;
      assert.ok(value.compactSettingsHeight <= maxHeight, `${name}: expanded settings must stay compact (${value.compactSettingsHeight}px > ${maxHeight}px; independent execution strip ${value.execution.occupiedHeight}px)`);
    }
    const previous = baseline?.measurements.find((item) => item.name === name);
    if (previous && scenario.width >= 1430) {
      const previousCompactHeight = previous.compactSettingsHeight ?? (previous.redRegionHeight - (previous.execution?.occupiedHeight || 0));
      const ratio = value.compactSettingsHeight / previousCompactHeight;
      assert.ok(ratio <= Number(process.env.QA_MAX_HEIGHT_RATIO || .55), `${name}: compact settings region remains ${(ratio * 100).toFixed(1)}% of baseline, expected at most ${Number(process.env.QA_MAX_HEIGHT_RATIO || .55) * 100}%`);
    }
  }
  stages.push('five viewport/font combinations measured with six synthetic bilingual segments');
  if (!baselineMode) {
    const panel = page.locator('.vd-batch-panel');
    const selectedCount = await panel.getByRole('checkbox', { name: /^选择第/u }).evaluateAll((nodes) => nodes.filter((node) => node.checked).length);
    const duration = panel.getByRole('textbox', { name: '批量视频时长（秒）', exact: true });
    await duration.fill('8');
    await panel.getByRole('button', { name: '收起批量设置', exact: true }).click();
    assert.equal(await page.locator('#vd-batch-settings-content').isVisible(), false);
    assert.equal(await panel.getByRole('checkbox', { name: /^选择第/u }).evaluateAll((nodes) => nodes.filter((node) => node.checked).length), selectedCount);
    await panel.getByRole('button', { name: '展开批量设置', exact: true }).click();
    assert.equal(await duration.inputValue(), '8');
    await duration.fill('');
    for (const count of [2, 3, 4]) {
      await panel.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption(`compact-workflow-${count}`);
      assert.equal(await panel.locator('.vop-fields input').count(), count);
      await capture(`output-${count}-fields-1280x800-font150`);
    }
    const advanced = panel.locator('.vd-batch-advanced');
    await advanced.locator('summary').click();
    await advanced.getByLabel('批量公共参数 JSON', { exact: true }).fill('{"duration":8,"width":1920,"height":1080,"resolution":"1080P"}');
    const help = panel.locator('.vop-help-details');
    await help.locator('summary').click();
    await capture('expanded-help-and-json-1280x800-font150');
    await page.setViewportSize({ width: 1120, height: 720 });
    await capture('expanded-help-and-json-1120x720-font150');
    await advanced.getByLabel('批量公共参数 JSON', { exact: true }).fill('{"duration":');
    assert.ok((await panel.innerText()).includes('原文本已保留'));
    assert.equal(await duration.isDisabled(), true);
    await capture('invalid-json-1120x720-font150');
    stages.push('fold/unfold preserves selection and overrides; 2/3/4 output fields, expanded help/JSON and error state remain accessible');
  }
  assert.deepEqual(errors, []);
  const report = { mockOnly: true, noProductionDataRead: true, baselineMode, outputDirectory, comparedTo: process.env.QA_BASELINE || null, fixture: { segments: 6, bilingualPairs: 6, generatedTasks: 0 }, measurements, screenshots, stages, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Compact batch UI QA passed. Report: ${path.join(outputDirectory, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ measurements, screenshots, stages, errors, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
