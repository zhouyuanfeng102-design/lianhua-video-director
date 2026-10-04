import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// This browser owns fresh in-memory storage. It never imports the desktop
// profile or generates an image; all external traffic and model POSTs fail.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `five-view-ui-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay under output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse a link');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'five-view isolated UI', runTimeoutMs: 210_000, closeTimeoutMs: 10_000 });
const storageKey = 'lianhua_video_director_state_v22';
const errors = []; const blockedRequests = []; const steps = []; const screenshots = []; const layoutChecks = [];
let browser; let context; let page;
const capture = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); return file;
};
const privateGroup = () => page.getByRole('group', { name: '选择私密生图部位', exact: true });
const sizeGroup = (lane) => page.getByRole('group', { name: `${lane}生图像素设置`, exact: true });
const categorySelect = () => page.getByRole('combobox', { name: '分类预设', exact: true });
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const protectedSettings = (state) => ({ imageApi: state.settings.imageApi, imageApiProfiles: state.settings.imageApiProfiles,
  activeImageApiProfileId: state.settings.activeImageApiProfileId, imageOutputSizes: state.settings.imageOutputSizes });
const openOrdinaryFiveView = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click();
  await page.locator('.image-entity-controls select').selectOption('five-view-qa-adult');
  await page.getByRole('button', { name: '五视图', exact: true }).click();
};
const assertNoHorizontalOverflow = async (label) => {
  await categorySelect().scrollIntoViewIfNeeded();
  const metrics = await page.evaluate(() => {
    const grid = document.querySelector('.image-prompt-selection-grid');
    const controls = [...grid.querySelectorAll('select')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      gridWidth: grid.clientWidth, gridScrollWidth: grid.scrollWidth, controls };
  });
  assert.ok(metrics.documentWidth <= metrics.width + 1, `${label}: document has horizontal overflow`);
  assert.ok(metrics.gridScrollWidth <= metrics.gridWidth + 1, `${label}: preset controls overflow their panel`);
  assert.ok(metrics.controls.every((item) => item.left >= -1 && item.right <= metrics.width + 1 && item.width > 40),
    `${label}: preset/rule selectors must remain reachable inside the window`);
  layoutChecks.push({ label, ...metrics });
};
const waitForSavedPreset = async (id) => page.waitForFunction(({ key, id }) =>
  JSON.parse(localStorage.getItem(key))?.settings.imagePromptPresetIdByAssetKind?.['character-sheet'] === id,
{ key: storageKey, id });

async function run() {
  await waitForCondition({ label: 'five-view Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(route.request().method()))) {
      blockedRequests.push({ url: url.pathname, method: route.request().method() });
      await route.abort('blockedbyclient');
    } else if (url.pathname === '/__five_view_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>五视图隔离验证</title><body>隔离UI测试</body></html>' });
    } else await route.continue();
  });
  await page.goto(`${origin}/__five_view_fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const character = {
      id: 'five-view-qa-adult', name: '成年展示人台', gender: '男', apparentAge: '30岁成年', actualAge: '30岁',
      height: '180cm', race: '人类', morphology: 'humanoid', bodyPlan: '成年展示人台的完整结构',
      appearance: '中性灰色展示人台，短发，固定面容', outfit: '蓝色外套与长裤', signatureProps: '',
      personality: '静态展示', motionHabits: '中性站姿', anchor: '同一成年展示人台', negativeContinuity: '', assetIds: [],
      nsfwProfile: { fullBody: 'ADULT_PRIVATE_PROFILE_SENTINEL_ONLY_FOR_UI', provenance: 'manual' },
    };
    const project = { ...state.project, id: 'five-view-isolated-qa', name: '五视图布局隔离验证', characters: [character],
      locations: [], props: [], assets: [], sourceDocuments: [], scenes: [], storyboards: [], sequencePlans: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    // Enabled fixture-only image connection makes the action label visible;
    // the test never presses it and the browser rejects every non-GET call.
    state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: `${origin}/__generation_forbidden`,
      apiKey: 'FIXTURE_ONLY_NOT_A_REAL_KEY', model: 'gpt-image-2.5-sunburst',
      size: '1536x1024', quality: 'FIXTURE_QUALITY_UNCHANGED', moderation: 'FIXTURE_MODERATION_UNCHANGED' };
    state.settings.textApi = { ...state.settings.textApi, enabled: false, baseUrl: '', apiKey: '', model: '' };
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.imageOutputSizes = {
      ordinary: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 },
      private: { mode: 'default', aspect: 'variant', width: 1024, height: 1024 },
    };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await openOrdinaryFiveView();
  assert.match(await page.getByRole('button', { name: '五视图', exact: true }).getAttribute('class'), /active/u);
  assert.equal(await page.getByRole('button', { name: '四视图', exact: true }).count(), 0);
  assert.match(await sizeGroup('普通').innerText(), /1536\s*×\s*1024/u);
  assert.match(await sizeGroup('普通').innerText(), /3:2/u);
  assert.equal(await page.getByRole('combobox', { name: '普通生图画面比例', exact: true }).isDisabled(), true);
  assert.match(await page.locator('.image-canvas-hint').innerText(), /左侧上下两张头像.*右侧正面、侧面、背面全身/u);
  await page.getByRole('button', { name: '生成五视图并保存', exact: true }).waitFor();
  await page.getByRole('button', { name: '五视图', exact: true }).scrollIntoViewIfNeeded();
  await capture('ordinary-five-view');
  steps.push('ordinary five-view selector, 3:2 canvas, two portrait/three body hint, no new four-view entry');

  const contracts = await page.evaluate(async () => {
    const rules = await import('/src/imagePromptRules.ts');
    const state = rules.migrateImagePromptRulesState(undefined);
    const presets = Object.entries(rules.FIVE_VIEW_IMAGE_PRESET_IDS).map(([key, id]) => {
      const preset = state.categoryPresets.find((item) => item.id === id);
      return { key, id, name: preset.name, assetKind: preset.assetKind };
    });
    const oldMicro = state.categoryPresets.find((item) => item.id === 'image-preset-gpt-image-2-5-micro-nsfw-character');
    const fiveMicro = state.categoryPresets.find((item) => item.id === rules.FIVE_VIEW_IMAGE_PRESET_IDS.micro);
    const resolve = (model, imageVariant, extra = {}) => {
      const selected = rules.resolveImagePromptSelection({ backend: 'openai', model, assetKind: 'character-sheet', imageVariant, state, ...extra });
      return { preset: selected.preset.id, source: selected.presetSource, rule: selected.ruleSet.id };
    };
    return { presets, catalogVersion: state.catalogVersion, expectedCatalogVersion: rules.IMAGE_PROMPT_RULE_CATALOG_VERSION,
      microVerbatim: ['systemPrompt', 'outputRules', 'negativePrompt'].every((key) => fiveMicro[key] === oldMicro[key]),
      microVersion: fiveMicro.version, originalMicroVersion: oldMicro.version,
      microScopedToFiveRegions: /左侧两个头像区域/u.test(fiveMicro.systemPrompt)
        && /右侧三个全身区域/u.test(fiveMicro.systemPrompt)
        && /五个区域共享同一湿身薄衣摄影条件/u.test(fiveMicro.systemPrompt),
      microKeepsClothingCoverage: /衣物仍作为主要遮挡层/u.test(fiveMicro.outputRules),
      gptFive: resolve('gpt-image-2.5-sunburst', 'five-view'), kreaFive: resolve('krea-2', 'five-view'),
      legacyFour: resolve('gpt-image-2.5-sunburst', 'turnaround'), noVariant: resolve('gpt-image-2.5-sunburst'),
      otherModel: resolve('other-image-model', 'five-view'),
      explicitOldPreset: resolve('gpt-image-2.5-sunburst', 'five-view', { manualPresetId: 'image-preset-character-sheet' }),
      manualMicro: resolve('gpt-image-2.5-sunburst', 'five-view', { manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw' }),
      staticDefaults: state.ruleSets.filter((item) => ['image-rule-openai-gpt-image', 'image-rule-krea-2'].includes(item.id))
        .map((item) => item.defaultPresetByAssetKind['character-sheet']) };
  });
  const ids = Object.fromEntries(contracts.presets.map((item) => [item.key, item.id]));
  assert.equal(contracts.catalogVersion, contracts.expectedCatalogVersion);
  assert.equal(contracts.microVersion, '1.1.0');
  assert.equal(contracts.originalMicroVersion, '1.0.0', 'the original full-body preset remains unchanged');
  assert.equal(contracts.microVerbatim, false, 'five-view uses its own per-region adaptation');
  assert.equal(contracts.microScopedToFiveRegions, true);
  assert.equal(contracts.microKeepsClothingCoverage, true);
  assert.equal(contracts.gptFive.preset, ids.gpt); assert.equal(contracts.gptFive.source, 'variant-recommendation');
  assert.equal(contracts.kreaFive.preset, ids.krea); assert.equal(contracts.kreaFive.source, 'variant-recommendation');
  assert.equal(contracts.manualMicro.preset, ids.micro);
  for (const key of ['legacyFour', 'noVariant', 'otherModel', 'explicitOldPreset']) {
    assert.equal(contracts[key].preset, 'image-preset-character-sheet', `${key}: do not replace previous defaults or manual choice`);
  }
  assert.deepEqual(contracts.staticDefaults, ['image-preset-character-sheet', 'image-preset-character-sheet']);
  assert.equal(await categorySelect().inputValue(), ids.gpt, 'actual GPT2.5 five-view UI uses the new recommended preset');
  for (const preset of contracts.presets) {
    assert.equal(preset.assetKind, 'character-sheet');
    assert.match(await categorySelect().locator(`option[value="${preset.id}"]`).innerText(), new RegExp(preset.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    if (preset.key === 'micro') assert.match(await categorySelect().locator(`option[value="${preset.id}"]`).innerText(), /v1\.1\.0/u);
  }
  const initialSettings = protectedSettings(await stored());
  assert.equal(initialSettings.imageApi.moderation, 'FIXTURE_MODERATION_UNCHANGED');
  assert.equal(initialSettings.imageApi.quality, 'FIXTURE_QUALITY_UNCHANGED');
  for (const preset of contracts.presets) {
    await categorySelect().selectOption(preset.id);
    await waitForSavedPreset(preset.id);
    assert.equal(await categorySelect().inputValue(), preset.id);
    assert.deepEqual(protectedSettings(await stored()), initialSettings, `${preset.name}: preset selection cannot change API/profile/size settings`);
    await assertNoHorizontalOverflow(preset.key);
    await capture(`ordinary-preset-${preset.key}`);
    await page.reload({ waitUntil: 'networkidle' }); await openOrdinaryFiveView();
    assert.equal(await categorySelect().inputValue(), preset.id, `${preset.name}: explicit choice survives app refresh`);
    assert.deepEqual(protectedSettings(await stored()), initialSettings);
  }
  steps.push('three ordinary five-view presets selectable and persisted through a real refresh; model/baseUrl/key/size/quality/moderation/output-size/profile unchanged');
  steps.push('micro five-view v1.1.0 scopes material state to five regions and preserves clothing coverage; original character preset and legacy/model/manual selection remain unchanged');

  await page.setViewportSize({ width: 1120, height: 760 });
  await assertNoHorizontalOverflow('small-window-ordinary'); await capture('ordinary-presets-small-window');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  await privateGroup().getByRole('button', { name: '私密五视图', exact: true }).click();
  assert.match(await privateGroup().getByRole('button', { name: '私密五视图', exact: true }).getAttribute('class'), /active/u);
  assert.equal(await privateGroup().getByRole('button', { name: '私密四视图', exact: true }).count(), 0);
  assert.equal(await privateGroup().getByRole('button', { name: '四合一', exact: true }).count(), 1);
  assert.match(await sizeGroup('私密').innerText(), /1536\s*×\s*1024/u);
  assert.match(await sizeGroup('私密').innerText(), /3:2/u);
  assert.equal(await page.getByRole('combobox', { name: '私密生图画面比例', exact: true }).isDisabled(), true);
  assert.match(await page.locator('.image-private-generation-note').innerText(), /左侧正面\/侧面头像.*右侧正面\/侧面\/背面全身/u);
  await page.getByRole('button', { name: '生成私密五视图并保存', exact: true }).waitFor();
  await privateGroup().getByRole('button', { name: '私密五视图', exact: true }).scrollIntoViewIfNeeded();
  for (const id of Object.values(ids)) assert.equal(await categorySelect().locator(`option[value="${id}"]`).count(), 0,
    'ordinary model presets must not leak into private-five-view choices');
  await assertNoHorizontalOverflow('small-window-private');
  await capture('private-five-view');
  steps.push('private five-view selector and layout/3:2 hint, retained independent four-in-one, corrected action label');
  await page.getByRole('tab', { name: '普通生图', exact: true }).click();
  assert.match(await page.getByRole('button', { name: '五视图', exact: true }).getAttribute('class'), /active/u);
  assert.equal(await categorySelect().inputValue(), ids.micro, 'private lane switching retains the ordinary manual preset');
  await page.getByRole('tab', { name: '私密生图', exact: true }).click();
  assert.match(await privateGroup().getByRole('button', { name: '私密五视图', exact: true }).getAttribute('class'), /active/u);
  const state = await stored();
  assert.equal(state.project.id, 'five-view-isolated-qa'); assert.equal(state.project.generationTasks.length, 0); assert.equal(state.project.assets.length, 0);
  assert.equal(state.project.characters[0].nsfwProfile.fullBody, 'ADULT_PRIVATE_PROFILE_SENTINEL_ONLY_FOR_UI');
  assert.deepEqual(protectedSettings(state), initialSettings);

  // Unmount the app before changing fixture storage, preventing its autosave
  // from racing this independent Krea/other-model recommendation check.
  for (const [model, expected] of [['krea-2', ids.krea], ['other-image-model', 'image-preset-character-sheet']]) {
    await page.goto(`${origin}/__five_view_fixture.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ key, model }) => {
      const state = JSON.parse(localStorage.getItem(key));
      state.settings.imageApi.model = model;
      state.settings.imagePromptRuleSetIdByBackend = {};
      state.settings.imagePromptPresetIdByAssetKind = {};
      localStorage.setItem(key, JSON.stringify(state));
    }, { key: storageKey, model });
    await page.goto(origin, { waitUntil: 'networkidle' }); await openOrdinaryFiveView();
    assert.equal(await categorySelect().inputValue(), expected, `${model}: correct five-view recommendation in real UI`);
    await assertNoHorizontalOverflow(`small-window-${model}`); await capture(`ordinary-default-${model}`);
  }
  steps.push('private-five-view excludes all ordinary three presets; lane switching preserves choices; Krea and other-model UI recommendations verified at 1120x760');
  assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, mockOnly: true, noProductionDataRead: true,
    imageRequests: 0, textRequests: 0, steps, contracts, layoutChecks, screenshots, errors, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), screenshots }));
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await capture('failure').catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, steps, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
