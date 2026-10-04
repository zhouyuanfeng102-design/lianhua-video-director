import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the real analysis -> dossier -> scene binding -> reload UI with
// synthetic model responses. No production data, credentials or paid API.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `character-variants-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__character_variant_fixture.html';
const apiPath = '/__character_variant_mock__/v1/chat/completions';
const storageKey = 'lianhua_video_director_state_v22';
const paragraphs = [
  '成年男子泰罗和成年友人林岚进入石室，泰罗仍保持原本的短黑发男性人类外貌。',
  '泰罗触碰符文后变成成年女性，银色长发垂落，林岚认出她仍是泰罗。落石擦伤林岚肩部，伤口流血，衣服沾灰，她仍是原来的人物。',
  '泰罗继续触碰第二枚符文，身体暂时化为银狼，四足站立。林岚肩伤仍在，疲惫地跪地后起身，保持原来的身体形态。',
];
const story = paragraphs.join('\n');
const forms = [
  { formLabel: '原始形态', gender: '男', race: '人类', morphology: 'human-like', bodyPlan: '人类头部躯干，双臂双腿', appearance: '短黑发成年男性，方形脸', outfit: '深蓝长袍', transformationType: 'gender' },
  { formLabel: '女性形态', gender: '女', race: '人类', morphology: 'human-like', bodyPlan: '人类头部躯干，双臂双腿', appearance: '银色长发成年女性，柔和椭圆脸', outfit: '紫色长袍', transformationType: 'gender' },
  { formLabel: '银狼形态', gender: '雌性', race: '银狼', morphology: 'animal', bodyPlan: '狼头狼躯，四足，一条尾巴，银色皮毛', appearance: '银色皮毛的成年狼，尖耳与琥珀色眼睛', outfit: '无服装，银色皮毛覆盖全身', transformationType: 'species' },
];
const detail = (name, fields = {}) => ({ name, gender: '女', apparentAge: '约二十五岁', actualAge: '约二十五岁', height: '约一米七', race: '人类', morphology: 'human-like', bodyPlan: '人类头部躯干，双臂双腿', appearance: '黑发成年女性', outfit: '白色长袍', signatureProps: '布袋', personality: '冷静', motionHabits: '自然行走', anchor: '保持本形态外貌与身体结构', negativeContinuity: '不混用其他形态外貌', ...fields });
const characters = [...forms.map((form) => detail('泰罗', { baseName: '泰罗', variantOf: '泰罗', ...form })), detail('林岚')];
const names = [...forms.map((form) => `泰罗·${form.formLabel}`), '林岚'];
const analysis = {
  characters, locations: [], props: [],
  scenes: forms.map((form, index) => ({ title: `形态场景${index + 1}`, content: paragraphs[index], summary: `展示${form.formLabel}`, characters: [names[index], '林岚'], props: [] })),
};
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'character variant UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const requests = []; const errors = []; const blockedRequests = []; const screenshots = [];
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false }); screenshots.push(`${name}.png`); };
const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const navStory = () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();

const run = async () => {
  await waitForCondition({ label: 'variant Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host && url.pathname === '/') return;
    blockedRequests.push(socket.url()); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push(request.url()); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><title>Isolated variant QA</title><body>Synthetic state only</body></html>' }); return; }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      const payload = request.postDataJSON();
      const message = (role) => payload.messages.filter((item) => item.role === role).map((item) => item.content).join('\n');
      const system = message('system'); const user = message('user');
      assert.ok(system.includes('baseName') && system.includes('formLabel'), 'both model passes receive identity-variant rules');
      let content;
      if (user.includes('<story_analysis_data>')) {
        assert.equal(JSON.parse(user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u)[1]).sourceStory, story);
        assert.ok(system.includes('普通状态变化绝不能拆分') && system.includes('误拆'), 'analysis asks AI to reject state-only variants and repair its own over-splitting');
        content = JSON.stringify(analysis); requests.push({ kind: 'analysis' });
      } else {
        const match = user.match(/^需要补全的人物名称：([^\n]+)/u);
        assert.ok(match, 'only one character enrichment request is expected');
        assert.deepEqual(JSON.parse(match[1]), names, 'each transformed asset is enriched independently');
        assert.ok(user.includes(story), 'complete source accompanies names');
        content = JSON.stringify({ items: characters.map((item, index) => ({ ...item, name: names[index] })) });
        requests.push({ kind: 'enrichment', names: JSON.parse(match[1]) });
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
    } catch (error) {
      errors.push(String(error)); await route.fulfill({ status: 500, body: 'Isolated variant mock rejected input' });
    }
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, origin, story }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const project = { ...state.project, id: 'qa-variant-project', name: '人物形态拆分回归', sourceDocuments: [{ id: 'qa-source', name: '形态转换', content: story, createdAt: now, updatedAt: now }], scenes: [], storyboards: [], sequencePlans: [], assets: [], characters: [], locations: [], props: [], generationTasks: [], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__character_variant_mock__/v1`, apiKey: '', model: 'qa-character-variants' };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    for (const name of ['visionApi', 'imageApi', 'videoTaskApi', 'runningHubVideo']) if (state.settings[name]) state.settings[name].enabled = false;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin, story });
  await page.goto(origin, { waitUntil: 'networkidle' }); await navStory();
  await page.locator('.story-input-actions').getByRole('button', { name: '解析并补全', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key))?.project.characters.length === 4, storageKey);
  await page.locator('.story-input-actions').getByRole('button', { name: '解析并补全', exact: true }).waitFor();
  const project = await readProject();
  assert.deepEqual(project.characters.map((item) => item.name), names);
  assert.equal(new Set(project.characters.map((item) => item.id)).size, 4);
  assert.deepEqual(project.characters.map((item) => item.gender), ['男', '女', '雌性', '女']);
  assert.equal(project.characters[3].name, '林岚');
  for (const field of ['baseName', 'formLabel', 'variantOf', 'transformationType']) {
    assert.ok(!project.characters[3][field], `injury-only character must not acquire ${field} from UI or enrichment`);
  }
  assert.ok(project.scenes[1].content.includes('伤口流血') && project.scenes[2].content.includes('林岚肩伤仍在'),
    'not creating a separate asset must not erase injury continuity from scenes');
  forms.forEach((form, index) => {
    assert.equal(project.characters[index].formLabel, form.formLabel);
    assert.equal(project.characters[index].baseName, '泰罗');
    assert.equal(project.characters[index].appearance, form.appearance);
    assert.deepEqual(project.scenes[index].characterIds, [project.characters[index].id, project.characters[3].id]);
  });
  assert.deepEqual(requests.map((entry) => entry.kind), ['analysis', 'enrichment'], 'ordinary characters do not require variant-metadata repair');
  for (const name of names) await page.locator('.entity-chip-list button').filter({ hasText: name }).waitFor();
  await capture('01-form-names-in-bible');
  await page.getByRole('button', { name: /^实体资料/u }).click();
  assert.deepEqual(await page.locator('.entity-detail-card strong').allTextContents(), names);
  await capture('02-separate-form-dossiers');
  await page.locator('.entity-detail-card').filter({ hasText: '泰罗·女性形态' }).click();
  await page.locator('.entity-editor-modal h3').filter({ hasText: '泰罗·女性形态' }).waitFor();
  assert.ok((await page.locator('.entity-editor-grid textarea').evaluateAll((fields) => fields.map((field) => field.value))).includes(forms[1].appearance));
  await capture('03-specific-form-editor');
  await page.locator('.entity-editor-modal').getByRole('button', { name: '关闭', exact: true }).first().click();
  await page.reload({ waitUntil: 'networkidle' }); await navStory();
  const reloaded = await readProject();
  assert.deepEqual(reloaded.characters, project.characters, 'reload preserves form metadata, separate IDs and dossiers');
  assert.deepEqual(reloaded.scenes.map((scene) => scene.characterIds), project.scenes.map((scene) => scene.characterIds));
  assert.deepEqual(reloaded.scenes.map((scene) => scene.content), project.scenes.map((scene) => scene.content));
  await page.getByRole('button', { name: /^实体资料/u }).click();
  assert.deepEqual(await page.locator('.entity-detail-card strong').allTextContents(), names);
  await page.setViewportSize({ width: 1120, height: 720 });
  await capture('04-reloaded-form-names-small');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const report = { passed: true, names, distinctAssets: project.characters.length, injuryStatesRemainInScenes: true, perSceneForms: project.scenes.map((scene) => scene.characterIds.map((id) => project.characters.find((item) => item.id === id).name)), requests, screenshots, errors, blockedRequests, productionDataRead: false, paidApiCalls: 0 };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, requests, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
