import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App with synthetic projects and desktop persistence. All model results are mocked.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `character-dossier-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite';const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});await s.listen();`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'character dossier UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser, context, page;
const errors = [], blocked = [], checks = [];
const savedProject = () => page.evaluate(() => { const state = window.__dossierQa.saved; return state?.project?.characters ? state.project : state?.projects.find((entry) => entry.id === state.activeProjectId); });
const waitSaved = async (predicate, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 100, check: async () => predicate(await savedProject()) });
const openWorkbench = async () => { await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click(); await page.getByLabel('调用项目实体', { exact: true }).waitFor(); };
const selectSource = async () => { await page.getByLabel('调用项目实体', { exact: true }).selectOption('custom-character'); };
const dialog = () => page.getByRole('dialog', { name: '应用到剧情人物', exact: true });

async function run() {
  await waitForCondition({ label: 'Vite ready', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { blocked.push(route.request().url()); await route.abort('blockedbyclient'); });
  await page.addInitScript(({ origin }) => {
    const raw = sessionStorage.getItem('__dossier_qa_state__');
    const qa = window.__dossierQa = { saved: raw ? JSON.parse(raw) : null, input: raw, loads: [], requests: [], pending: [], hold: false };
    const result = () => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ gender: '女性', height: '170cm', appearance: 'QA补齐外观', outfit: 'QA补齐服装', personality: 'QA补齐性格', motionHabits: 'QA补齐动作', anchor: 'QA补齐锚点', negativeContinuity: 'QA补齐限制', signatureProps: 'QA补齐道具', race: '人类', bodyPlan: '常规人类结构', apparentAge: '成年三十岁', actualAge: '三十岁' }) } }] }) });
    window.lianhuaDesktop = {
      loadState: async () => qa.input || new Promise((resolve) => qa.loads.push(resolve)),
      saveState: async (serialized) => { qa.saved = JSON.parse(serialized); sessionStorage.setItem('__dossier_qa_state__', serialized); return { ok: true, checksum: 'synthetic' }; },
      request: async (request) => { if (!request.url.startsWith(origin)) throw new Error('QA prohibits external API'); qa.requests.push(request); return qa.hold ? new Promise((resolve) => qa.pending.push(() => resolve(result()))) : result(); },
      assetStatus: async () => ({ exists: true }), getVideoTaskCheckpoint: async () => null, getVideoTaskCredential: async () => null,
    };
  }, { origin: new URL(baseUrl).origin });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(async (base) => {
    const { createInitialState, normalizeState } = await import('/src/storage.ts');
    const state = createInitialState(); const project = state.project;
    project.id = 'dossier-ui-project'; project.name = '资料应用测试'; project.description = 'MAIN_STORY_SECRET_DESCRIPTION';
    project.sourceDocuments[0].content = 'MAIN_STORY_SECRET_CONTENT';
    const target = { ...project.characters[0], id: 'story-character', name: '剧情人物·原始形态', formLabel: '原始形态', appearance: 'MAIN_STORY_SECRET_APPEARANCE', outfit: '原剧情服装', assetIds: [] };
    const source = { ...target, id: 'custom-character', name: '自建资料', baseName: undefined, formLabel: undefined, appearance: '自建短发外观', outfit: '自建蓝色外套', personality: '', motionHabits: '', anchor: '', assetIds: [], dossier: { useStory: true, confirmedFields: ['name', 'appearance', 'outfit', 'apparentAge', 'actualAge'], fieldSources: { name: 'manual', appearance: 'manual', outfit: 'manual', apparentAge: 'manual', actualAge: 'manual' } } };
    const other = { ...target, id: 'other-form', name: '剧情人物·另一形态', formLabel: '另一形态', appearance: '另一形态专属外观' };
    project.characters = [target, source, other]; project.scenes[0].characterIds = [target.id]; project.scenes[0].content = 'MAIN_STORY_SECRET_SCENE'; project.scenes[0].summary = 'MAIN_STORY_SECRET_SUMMARY';
    project.storyboards = [{ id: 'dossier-board', sceneId: project.scenes[0].id, sourceSceneIds: [project.scenes[0].id], workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: '历史分镜正文', englishPrompt: 'Historical storyboard text.', shots: [], createdAt: 1, updatedAt: 1 }];
    project.scenes[0].storyboardIds = ['dossier-board'];
    project.generationTasks = [{ id: 'historical-image-task', kind: 'image', name: '历史图片任务', status: 'failed', assetKind: 'character', imageVariant: 'portrait', sourceEntityId: target.id, form: { appearance: 'HISTORICAL_TASK_KEEP' }, prompt: 'HISTORICAL_PROMPT_KEEP', error: 'synthetic previous failure', createdAt: 1, updatedAt: 1 }];
    project.assets = [{ id: 'historical-image', name: '历史图片', type: 'character', role: 'character', sourceEntityId: target.id, sourceEntityKind: 'character', source: 'generated', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', tags: ['HISTORICAL_ASSET_KEEP'], createdAt: 1, updatedAt: 1 }];
    target.assetIds = ['historical-image'];
    state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: `${base}mock/v1`, apiKey: '', model: 'qa-text-model' };
    const normalized = normalizeState(state);
    const qa = window.__dossierQa; qa.input = JSON.stringify(normalized); qa.saved = JSON.parse(qa.input); qa.loads.splice(0).forEach((resolve) => resolve(qa.input));
  }, baseUrl);
  await openWorkbench(); await selectSource();
  const before = await savedProject();
  const history = JSON.stringify({ tasks: before.generationTasks, assets: before.assets });
  await page.getByLabel('详细外观', { exact: true }).fill('自建短发外观，手工修改');
  await page.getByRole('button', { name: '保存当前实体资料', exact: true }).click();
  await waitSaved((project) => project?.characters.find((item) => item.id === 'custom-character')?.appearance.includes('手工修改'), 'source save');
  const sourceGroup = page.getByRole('group', { name: '是否参考剧情补齐资料' });
  await sourceGroup.getByRole('button', { name: '否', exact: true }).click();
  await waitSaved((project) => project?.characters.find((item) => item.id === 'custom-character')?.dossier?.useStory === false, 'source option save');
  await page.getByLabel('调用项目实体', { exact: true }).selectOption('story-character');
  assert.equal(await sourceGroup.getByRole('button', { name: '是', exact: true }).getAttribute('aria-pressed'), 'true');
  await selectSource(); assert.equal(await sourceGroup.getByRole('button', { name: '否', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('Manual source save and per-character story-source setting remain independent');

  await page.getByRole('button', { name: '应用到剧情人物', exact: true }).click();
  await dialog().waitFor();
  assert.equal(await dialog().getByRole('button', { name: '确认覆盖所选资料' }).isEnabled(), false);
  await dialog().getByLabel('目标剧情人物').selectOption('story-character');
  assert.match(await dialog().locator('[data-dossier-field="appearance"]').innerText(), /MAIN_STORY_SECRET_APPEARANCE.*自建短发外观，手工修改/s);
  assert.match(await dialog().locator('[data-dossier-field="personality"]').innerText(), /自建资料为空，保留原值/);
  await page.screenshot({ path: path.join(output, 'copy-preview.png') });
  await dialog().getByRole('button', { name: '确认覆盖所选资料' }).click();
  await waitSaved((project) => project?.characters.find((item) => item.id === 'story-character')?.appearance.includes('手工修改'), 'copy saved');
  let copied = await savedProject();
  assert.equal(copied.scenes[0].characterIds[0], 'story-character');
  assert.equal(copied.characters.find((item) => item.id === 'other-form').appearance, '另一形态专属外观');
  assert.equal(JSON.stringify({ tasks: copied.generationTasks, assets: copied.assets }), history);
  await page.getByText('人物资料已更新 · 1 组提示词待刷新', { exact: true }).click();
  await page.getByRole('button', { name: '按新资料更新提示词', exact: true }).waitFor();
  const pendingRow = page.getByRole('button', { name: '按新资料更新提示词', exact: true }).locator('..');
  assert.match(await pendingRow.innerText(), /雨夜客栈的染血来信/);
  await page.screenshot({ path: path.join(output, 'pending-prompt-list.png') });
  checks.push('Copy applies selected ordinary fields and preserves identity, other forms, historical assets and tasks');

  await page.getByRole('button', { name: '撤销（Ctrl+Z）', exact: true }).click();
  await waitSaved((project) => project?.characters.find((item) => item.id === 'story-character')?.appearance === 'MAIN_STORY_SECRET_APPEARANCE', 'copy undo');
  await selectSource();
  await page.getByRole('button', { name: '应用到剧情人物', exact: true }).click();
  await dialog().getByLabel('目标剧情人物').selectOption('story-character');
  await dialog().getByRole('radio', { name: /将剧情绑定转给自建人物/ }).check();
  await dialog().getByRole('button', { name: '确认转移绑定' }).click();
  await waitSaved((project) => project?.scenes[0].characterIds[0] === 'custom-character', 'transfer saved');
  const transferred = await savedProject();
  assert.equal(transferred.characters.find((item) => item.id === 'custom-character').name, '剧情人物·原始形态');
  assert.equal(transferred.characters.find((item) => item.id === 'story-character').dossier.archivedIntoCharacterId, 'custom-character');
  assert.deepEqual(transferred.generationTasks, before.generationTasks);
  assert.deepEqual(transferred.assets.find((item) => item.id === 'historical-image'), before.assets[0]);
  await page.reload({ waitUntil: 'networkidle' }); await openWorkbench(); await selectSource();
  assert.equal(await sourceGroup.getByRole('button', { name: '否', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('调用项目实体', { exact: true }).locator('option[value="story-character"]').count(), 0);
  checks.push('Transfer uses custom ID with story name and form, archives prior identity, and survives complete reload');

  await page.getByLabel('普通生图自定义要求').fill('仅依据用户设定：成年角色，朴素蓝色外套，补齐动作习惯。');
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click();
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).waitFor();
  const requests = await page.evaluate(() => window.__dossierQa.requests);
  assert.ok(requests.length > 0, 'mock model receives no-story completion');
  assert.equal(JSON.stringify(requests).includes('MAIN_STORY_SECRET'), false);
  assert.match(JSON.stringify(requests), /仅依据用户设定/);
  assert.equal(await page.getByLabel('详细外观', { exact: true }).inputValue(), '自建短发外观，手工修改');
  checks.push('No-story completion sends custom requirements without story content/cached appearance and retains manual fields');
  await page.getByRole('button', { name: '保存当前实体资料', exact: true }).click();
  // A fresh synthetic character keeps fields missing for a delayed-response test.
  await page.getByRole('button', { name: '新增一条空白实体资料', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('迟到结果测试');
  await page.getByLabel('普通生图自定义要求').fill('成年旅行者，普通外套。');
  await sourceGroup.getByRole('button', { name: '否', exact: true }).click();
  await page.evaluate(() => { window.__dossierQa.hold = true; });
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click();
  await waitForCondition({ label: 'held request', timeoutMs: 10_000, intervalMs: 100, check: () => page.evaluate(() => window.__dossierQa.pending.length > 0) });
  await sourceGroup.getByRole('button', { name: '是', exact: true }).click();
  await page.evaluate(() => { const qa = window.__dossierQa; qa.hold = false; qa.pending.splice(0).forEach((resolve) => resolve()); });
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).waitFor();
  assert.equal(await page.getByLabel('详细外观', { exact: true }).inputValue(), '');
  checks.push('Switching source during an in-flight completion invalidates the delayed result');
  await sourceGroup.getByRole('button', { name: '否', exact: true }).click();
  await page.evaluate(() => { window.__dossierQa.hold = true; });
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click();
  await waitForCondition({ label: 'second held request', timeoutMs: 10_000, intervalMs: 100, check: () => page.evaluate(() => window.__dossierQa.pending.length > 0) });
  await page.getByLabel('调用项目实体', { exact: true }).selectOption('other-form');
  await page.evaluate(() => { const qa = window.__dossierQa; qa.hold = false; qa.pending.splice(0).forEach((resolve) => resolve()); });
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).waitFor();
  assert.equal(await page.getByLabel('详细外观', { exact: true }).inputValue(), '另一形态专属外观');
  checks.push('Switching to another entity during a request never fills that entity with the old response');
  await sourceGroup.getByRole('button', { name: '否', exact: true }).click();
  await page.getByRole('button', { name: '确认采用当前填写资料', exact: true }).click();
  await page.getByRole('button', { name: '保存当前实体资料', exact: true }).click();
  await waitSaved((project) => project?.characters.find((item) => item.id === 'other-form')?.dossier?.confirmedFields?.includes('appearance'), 'adopt legacy field');
  checks.push('Pending prompt row identifies the affected scene, and explicit adoption can confirm a legacy field');
  await selectSource();
  await page.getByRole('button', { name: '应用到剧情人物', exact: true }).click();
  await dialog().getByLabel('目标剧情人物').selectOption('other-form');
  await page.setViewportSize({ width: 680, height: 800 });
  const bounds = await dialog().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 680 && bounds.y + bounds.height <= 800);
  await dialog().getByRole('button', { name: '确认覆盖所选资料' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: '关闭人物资料应用' }).evaluate((element) => document.activeElement === element), true);
  await page.screenshot({ path: path.join(output, 'narrow-dialog.png') });
  await page.keyboard.press('Escape');
  assert.equal(await dialog().count(), 0);
  await page.setViewportSize({ width: 1440, height: 960 });
  checks.push('Narrow viewport retains visible actions, keyboard focus stays inside the dialog, and Escape closes it');
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'workbench-source-option.png') });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, requests: requests.length, errors, blocked }, null, 2));
  console.log(`Character dossier UI QA passed: ${path.join(output, 'report.json')}`);
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blocked, error: String(error), stack: error?.stack }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
