import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const baseOutput = path.join(root, 'output', 'playwright');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.resolve(process.env.QA_OUTPUT || path.join(baseOutput, `production-cold-start-${version}-${Date.now()}`));
const relative = path.relative(baseOutput, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Production smoke output must remain below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Production smoke output cannot traverse links');
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Build dist before production cold-start QA');
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort(); const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}}); console.log('Static production dist preview ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'production dist cold-start QA', runTimeoutMs: 90_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; const errors = []; const resources = new Set(); const navigation = [];
const run = async () => {
  await waitForCondition({ label: 'production static server ready', timeoutMs: 30_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (['script', 'stylesheet'].includes(response.request().resourceType())) { resources.add(response.url()); if (response.status() >= 400) errors.push(`Asset HTTP ${response.status()}: ${response.url()}`); } });
  page.on('requestfailed', (request) => { if (['script', 'stylesheet'].includes(request.resourceType())) errors.push(`Asset request failed: ${request.url()}`); });
  await page.route('**/*', async (route) => { const request = route.request(); const url = new URL(request.url()); if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) { errors.push(`Unexpected external/API request: ${request.url()}`); await route.abort('blockedbyclient'); } else await route.continue(); });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('.app-shell .sidebar .nav-item').first().waitFor();
  const key = 'lianhua_video_director_state_v22'; await page.waitForFunction((storageKey) => Boolean(localStorage.getItem(storageKey)), key);
  await page.evaluate((storageKey) => {
    const state = JSON.parse(localStorage.getItem(storageKey)); const now = Date.now(); const source = '林澜站在廊桥门口，推开木门后回头看向同伴。';
    state.project = { ...state.project, id: 'production-smoke-project', name: '生产冷启动隔离验收', sourceDocuments: [{ id: 'smoke-source', name: '合成廊桥剧情', content: source, createdAt: now, updatedAt: now }], scenes: [{ id: 'smoke-scene', title: '廊桥门口', content: source, summary: '推门与回望', characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now }], characters: [], locations: [], props: [], assets: [], storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) { state.settings[key].enabled = false; state.settings[key].apiKey = ''; }
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, key);
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  for (const [label, selector] of [['项目总览', '.dashboard-view'], ['提示词导演台', '.director-view'], ['视频导演台', '.video-director-view'], ['规则中心', '.rules-view'], ['资产库', '.assets-view'], ['API 设置', '.settings-view']]) {
    await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
    if (label === '项目总览') await page.locator('.crumb h1').getByText(label, { exact: true }).waitFor(); else await page.locator(selector).waitFor();
    assert.ok((await page.locator('.main').innerText()).trim().length > 30, `${label} rendered blank`);
    if (label === '提示词导演台') {
      assert.equal(await page.locator('.director-mode-row, .workflow-mode-card').count(), 0, 'the removed director status banner must not remain in the production build');
      assert.equal(await page.getByRole('button', { name: '智能导演', exact: true }).count(), 0);
      await page.locator('.whole-story-source').waitFor({ state: 'visible' });
      await page.locator('.director-production-mode').getByRole('button', { name: '单段直出', exact: true }).waitFor({ state: 'visible' });
      await page.locator('.director-production-mode').getByRole('button', { name: '长剧情拆段', exact: true }).waitFor({ state: 'visible' });
    }
    if (label === '资产库') {
      await page.getByRole('heading', { name: '图片资产库', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '资产库首页', exact: true }).count(), 0);
      assert.equal(await page.locator('.asset-library-entry').count(), 0);
      assert.deepEqual(await page.locator('.asset-library-tabs button').allTextContents(), ['图片资产库', '视频资产库', '音频参考']);
    }
    navigation.push(label);
  }
  assert.ok([...resources].some((url) => /\/assets\/prompt-foundation-[^/]+\.js/u.test(url)), 'the new production prompt-foundation chunk must actually load');
  assert.ok([...resources].some((url) => /\/assets\/generation-contracts-[^/]+\.js/u.test(url)), 'the shared generation-contracts leaf chunk must actually load');
  assert.ok([...resources].every((url) => !/\/@vite\/|\/src\//u.test(url)), 'this must test production chunks, not Vite source modules');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'production-settings-loaded.png'), fullPage: false });
  const report = { passed: true, version, productionDist: true, isolatedStorage: true, noProductionDataRead: true, navigation, resources: [...resources].map((url) => new URL(url).pathname), errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), navigation, errors, resources: [...resources] }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'server.log'), harness.readElectronLog()); }
