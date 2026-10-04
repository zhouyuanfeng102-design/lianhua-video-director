import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const phase = 'after';
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `director-entries-${Date.now()}`, phase));
const relative = path.relative(outputBase, outputDirectory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Director entry QA artifacts must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Director QA path cannot traverse links');
fs.mkdirSync(outputDirectory, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Director entry isolated fixture ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'director entry visibility QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const records = [];
const steps = [];
const apiRequests = [];

const measure = (label) => page.evaluate((name) => {
  const rect = (element) => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }; };
  const card = document.querySelector('.source-settings-card');
  const source = rect(card); const style = getComputedStyle(card);
  const buttons = [...card.querySelectorAll('.director-production-mode button')].map((button) => {
    const bounds = rect(button); const center = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return { text: button.textContent.trim(), rect: bounds, disabled: button.disabled, withinCard: bounds.y >= source.y - 1 && bounds.bottom <= source.bottom + 1, hit: center === button || button.contains(center) };
  });
  const link = document.querySelector('.prompt-video-links');
  return { label: name, viewport: { width: innerWidth, height: innerHeight }, fontScale: Number(document.querySelector('.app-shell').dataset.uiFontScale), source, overflow: style.overflow, sourceScrollHeight: card.scrollHeight, sourceClientHeight: card.clientHeight, gridRows: getComputedStyle(document.querySelector('.director-view')).gridTemplateRows, promptLinks: link ? rect(link) : null, resultCharacters: document.querySelector('.director-result-copy')?.textContent.length || 0, redundantModeRows: card.querySelectorAll('.director-mode-row,.workflow-mode-card').length, sourceHint: card.querySelector('.whole-story-source')?.textContent.trim(), buttons };
}, label);

const installFixture = async (hasPrompt, fontScale) => {
  await page.evaluate(async ({ key, withPrompt, scale }) => {
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const source = '林澜推开木门，望向廊桥。她说：“先在这里等我。”';
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 72; const drawing = canvas.getContext('2d'); drawing.fillStyle = '#80a7b6'; drawing.fillRect(0, 0, 96, 72);
    const image = { id: 'entry-reference', name: '入口测试构图图', type: 'reference', role: 'composition', referenceRole: 'composition', mediaType: 'image', dataUrl: canvas.toDataURL('image/png'), width: 96, height: 72, tags: ['隔离SFW测试'], createdAt: now, updatedAt: now };
    const scene = { id: 'entry-scene', title: '廊桥门口', content: source, summary: '推门后望向廊桥', characterIds: [], propIds: [], locationIds: [], storyboardIds: withPrompt ? ['entry-board'] : [], createdAt: now, updatedAt: now };
    const prompt = '【0s-5s】 主体：@林澜（平静）[朝向：廊桥] 正在 [推开木门→望向廊桥]（发出提醒）；空间：林澜站在门口；光影：自然侧光；镜头：中景固定；台词：第1s @林澜：“先在这里等我。”；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]';
    const board = { id: 'entry-board', sceneId: scene.id, sourceStoryTitle: '廊桥入口测试', sourceStoryContent: source, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '', shots: [{ id: 'entry-shot', index: 1, startSec: 0, endSec: 5, subject: '林澜', action: '推开木门后望向廊桥', purpose: '发出提醒', camera: '中景固定', transition: '自然承接', lighting: '自然侧光', sound: '', result: '停在门口', referenceAssetIds: [], prompt, locked: false }], finalPrompt: prompt, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now };
    const actions = ['沿着廊桥缓步走向木门', '抬起右手推开木门', '转过肩膀看向留在身后的同伴', '抬手示意同伴在安全位置等候', '将信放进外套内袋并停在门边'];
    board.durationSec = 15; board.durationPreset = '15s'; board.shotCount = 5;
    board.shots = actions.map((action, index) => {
      const detail = `${action}，身体重心随脚步自然移动，衣摆只随动作轻轻摆动，视线始终沿着当前动作的目标移动，没有突然改变人物朝向；动作结束后保留短暂停顿，让同伴的回应能够在画面中被看清`;
      const line = `【${index * 3}s-${(index + 1) * 3}s】 主体：@林澜（平静专注）[朝向：廊桥门口] 正在 [${detail}]（推进廊桥来信事件）；空间：前景是整齐的木质扶栏，中景是林澜及同伴，背景是廊桥通向岸边的小路；木门与扶栏的位置在各镜中保持连续，信封和外套始终属于林澜；光影：门外自然侧光照在人物脸颊与木纹上，桥内亮度稍低但仍能看清衣服和手部，光线随位置自然变化而不闪烁；镜头：中景稳定跟随人物，保持当前视线轴，画面构图给动作前方留出适当空间；台词：${index === 0 ? '第1s @林澜：“先在这里等我。”' : '无'}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
      return { ...board.shots[0], id: `entry-shot-${index}`, index: index + 1, startSec: index * 3, endSec: (index + 1) * 3, action: detail, prompt: line };
    });
    board.finalPrompt = board.shots.map((shot) => shot.prompt).join('\n');
    const official = applyOfficialH3Prompt(board, { assets: [image], characters: [], locations: [], props: [], sceneContent: source });
    state.project = { ...state.project, id: 'director-entry-project', name: '导演入口隔离验收', sourceDocuments: [{ id: 'entry-source', name: '廊桥入口测试', content: source, createdAt: now, updatedAt: now }], scenes: [scene], storyboards: withPrompt ? [official] : [], sequencePlans: [], assets: [image], characters: [], locations: [], props: [], generationTasks: [], updatedAt: now };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    state.settings.uiFontScalePercent = scale;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[name].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, withPrompt: hasPrompt, scale: fontScale });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.source-settings-card').waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
};

const run = async () => {
  await waitForCondition({ label: 'director-entry Vite ready', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { if (!sessionStorage.getItem('__director_entries_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__director_entries_qa__', '1'); } });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push(`Unexpected external request: ${route.request().url()}`); await route.abort('blockedbyclient'); });
  await page.route((url) => url.origin === new URL(baseUrl).origin, async (route) => {
    if (!['GET', 'HEAD'].includes(route.request().method())) { apiRequests.push({ url: route.request().url(), method: route.request().method() }); await route.abort('blockedbyclient'); }
    else await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await installFixture(true, 100);
  const first = await measure('existing-prompt-1280x800-100'); records.push(first);
  await page.screenshot({ path: path.join(outputDirectory, `${phase}-existing-prompt.png`), fullPage: false });
  {
    const cases = [
      { width: 1280, height: 800, fontScale: 100, hasPrompt: true },
      { width: 1280, height: 800, fontScale: 100, hasPrompt: false },
      { width: 1366, height: 768, fontScale: 125, hasPrompt: true },
      { width: 1366, height: 768, fontScale: 125, hasPrompt: false },
      { width: 1120, height: 720, fontScale: 130, hasPrompt: true },
      { width: 1120, height: 720, fontScale: 130, hasPrompt: false },
    ];
    const assertControls = (data) => {
      assert.deepEqual(data.buttons.map((button) => button.text), ['单段直出', '长剧情拆段'], `${data.label}: both production controls remain`);
      assert.equal(data.redundantModeRows, 0, `${data.label}: the redundant smart-director banner is removed`);
      assert.match(data.sourceHint || '', /已载入完整剧情原文/u, `${data.label}: the source-loaded hint remains`);
      assert.ok(data.buttons.every((button) => button.withinCard && button.hit && !button.disabled), `${data.label}: some source controls are clipped or blocked`);
    };
    const assertNoGridCreation = async (label) => {
      assert.equal(await page.getByRole('button', { name: '九宫格', exact: true }).count(), 0, `${label}: retired grid mode must not be a new-entry button`);
      assert.equal(await page.locator('.grid-director-readiness, .grid-workbench-guide').count(), 0, `${label}: retired grid creation/binding guide must not appear`);
      const actions = await page.locator('button, a, [role="button"]').allTextContents();
      assert.ok(!actions.some((text) => /(?:先创建并绑定九宫格|去生成或上传九宫格|返回九宫格导演|绑定并返回导演台|绑定.*九宫格母版|生成\s*3×3\s*九宫格|转换九宫格提示词)/u.test(text)), `${label}: retired grid creation/binding action must not appear`);
      assert.equal(await page.getByLabel('九宫格故事线', { exact: true }).count(), 0, `${label}: retired grid story input must not appear`);
      assert.equal(await page.getByLabel('已有九宫格母版', { exact: true }).count(), 0, `${label}: retired grid upload input must not appear`);
    };
    const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
    for (const [index, spec] of cases.entries()) {
      if (index > 0) { await page.setViewportSize({ width: spec.width, height: spec.height }); await installFixture(spec.hasPrompt, spec.fontScale); }
      const label = `${spec.hasPrompt ? 'saved-long' : 'no-prompt'}-${spec.width}x${spec.height}-font${spec.fontScale}`;
      const initial = index === 0 ? first : await measure(label);
      if (index > 0) records.push(initial);
      assertControls(initial);
      assert.equal(Boolean(initial.promptLinks), spec.hasPrompt);
      if (spec.hasPrompt) assert.ok(initial.resultCharacters >= 1000 && initial.resultCharacters <= 4000, 'fixture must show an actual representative long H3 result, not an empty pane');
      if (spec.hasPrompt && index > 0) await page.screenshot({ path: path.join(outputDirectory, `${label}.png`), fullPage: false });
      // Re-enter after an existing generated prompt, using the unchanged asset library.
      await nav('资产库');
      await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
      assert.equal(await page.locator('.asset-card').filter({ hasText: '入口测试构图图' }).count(), 1);
      await nav('提示词导演台');
      assertControls(await measure(`${label}-returned`));
      const production = page.locator('.director-production-mode');
      await production.getByRole('button', { name: '长剧情拆段', exact: true }).click();
      assert.equal(await production.getByRole('button', { name: '长剧情拆段', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.director-mode-row,.workflow-mode-card').count(), 0, 'the banner stays removed in long-story mode');
      assert.equal(await page.getByRole('tablist', { name: '长剧情工作阶段' }).count(), 1, 'long-story stage navigation is preserved');
      assertControls(await measure(`${label}-sequence-settings`));
      await production.getByRole('button', { name: '单段直出', exact: true }).click();
      assert.equal(await production.getByRole('button', { name: '单段直出', exact: true }).getAttribute('aria-pressed'), 'true');
      assertControls(await measure(`${label}-production-returned`));
      assert.equal(await page.getByRole('button', { name: '智能导演', exact: true }).count(), 0, `${label}: no one-option mode switch remains`);
      await assertNoGridCreation(`${label}-director`);
      // New work starts from the ordinary categories; legacy grid coverage lives in gridRetirementUiQa.
      await nav('图像工作台');
      await page.locator('.section-heading').getByRole('heading', { name: '图像工作台', exact: true }).waitFor();
      assert.deepEqual((await page.locator('.image-asset-kind-tabs button').allTextContents()).map((text) => text.trim()), ['人物角色', '场景', '物品', '分镜图'], `${label}: ordinary asset categories remain while new grid creation is retired`);
      await assertNoGridCreation(`${label}-image-workbench`);
      if (index === 0) {
        await page.screenshot({ path: path.join(outputDirectory, 'image-workbench-retired-grid-entry.png'), fullPage: false });
      }
      await nav('提示词导演台');
      assertControls(await measure(`${label}-workbench-returned`));
      assert.equal(await page.locator('.input-mode-card,.director-local-reference-upload').count(), 0, 'retired video-input controls do not return');
      await page.locator('.reference-result-tabs').getByRole('button', { name: /^参考图(?:（\d+）)?$/u }).click();
      if (spec.hasPrompt) {
        const panel = page.getByRole('region', { name: '本段分镜参考图', exact: true });
        await panel.waitFor();
        const chosen = panel.getByRole('checkbox', { name: '选择参考图：入口测试构图图', exact: true });
        await chosen.check(); assert.equal(await chosen.isChecked(), true);
        const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.storyboards[0].finalPrompt, storageKey);
        await chosen.uncheck();
        const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.storyboards[0].finalPrompt, storageKey);
        assert.equal(after, before, 'reference selection preserves the H3 prompt');
      } else {
        await page.getByText('暂无可用分镜', { exact: true }).waitFor();
      }
      assertControls(await measure(`${label}-reference`));
      await page.locator('.reference-result-tabs').getByRole('button', { name: '提示词结果', exact: true }).click();
      assertControls(await measure(`${label}-text-returned`));
      await page.screenshot({ path: path.join(outputDirectory, `${label}.png`), fullPage: false });
      steps.push({ ...spec, productionModesClickable: true, redundantDirectorModeRemoved: true, sequenceStageNavigationPreserved: true, retiredGridEntriesAbsent: true, ordinaryWorkbenchCategoriesPreserved: true, returnedFromImageWorkbench: true, returnedFromAssetLibrary: true, referencePanelPreserved: true });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, [], 'no model generation or remote upload is authorized in this UI fixture');
  const report = { phase, mockOnly: true, noProductionDataRead: true, records, steps, apiRequests, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), records, steps, errors }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog()); }
