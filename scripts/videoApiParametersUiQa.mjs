import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One focused built-renderer pass with fresh Chromium storage and synthetic API
// schemas. All real APIs and every non-GET provider request are blocked.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `video-api-parameters-${version}-${Date.now()}`);
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not traverse symbolic links: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
assert.match(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), /assets\/index-[^"\s]+\.js/u);
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = 'http://127.0.0.1:49173';
const storageKey = 'lianhua_video_director_state_v22';
const document = { openapi: '3.0.3', servers: [{ url: fixtureOrigin }], paths: {
  '/v1/videos': { post: { requestBody: { content: { 'application/json': { schema: {
    type: 'object', properties: { model: { type: 'string', enum: ['unknown-model'] },
      duration: { type: 'integer', enum: [8, 12], default: 8 },
      aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] }, resolution: { type: 'string', enum: ['720p'] } },
  } } } } } },
} };
const report = { pass: false, version, productionDist: true, isolatedStorage: true, screenshots: [], layouts: [], requests: [], blocked: [], errors: [] };
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: child, qaLabel: 'video API output parameters', runTimeoutMs: 100_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;

async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); report.screenshots.push(file);
}

async function layout(panel, name) {
  await panel.scrollIntoViewIfNeeded();
  const value = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('input,select,button')].filter((control) => control.getClientRects().length).map((control) => {
      const box = control.getBoundingClientRect();
      return { label: control.getAttribute('aria-label') || control.textContent?.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const overlaps = [];
    for (let index = 0; index < controls.length; index += 1) for (let next = index + 1; next < controls.length; next += 1) {
      const first = controls[index]; const second = controls[next];
      if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > 2
        && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 2) overlaps.push([first.label, second.label]);
    }
    return { width: innerWidth, height: innerHeight, documentWidth: globalThis.document.documentElement.scrollWidth,
      overflow: element.scrollWidth > element.clientWidth + 1, left: rect.left, right: rect.right, controls, overlaps };
  });
  report.layouts.push({ name, ...value });
  assert.equal(value.overflow, false, `${name}: parameter panel horizontal overflow`);
  assert.ok(value.documentWidth <= value.width + 1, `${name}: page horizontal overflow`);
  assert.ok(value.controls.every((control) => control.left >= -1 && control.right <= value.width + 1), `${name}: a parameter control is outside the viewport`);
  assert.deepEqual(value.overlaps, [], `${name}: parameter controls overlap`);
  await screenshot(name);
}

async function installFixture() {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, fixtureOrigin }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const canonical = (address) => { const url = new URL(address); return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${url.search}`; };
    const scope = JSON.stringify([fixtureOrigin, canonical(`${fixtureOrigin}/v1/videos`), canonical(`${fixtureOrigin}/v1/videos/{id}`)]);
    const limits = { scope, source: 'mixed', fetchedAt: now, models: {
      'range-model': { controls: { duration: { kind: 'number', min: 4, max: 30, step: 1 },
        aspect_ratio: { kind: 'select', options: ['16:9', '9:16', '1:1'], restricted: true },
        resolution: { kind: 'select', options: ['720p', '1080p'], restricted: true } }, defaults: { duration: 6, aspect_ratio: '16:9', resolution: '720p' } },
      'enum-model': { controls: { duration: { kind: 'select', options: ['5', '10'], restricted: true },
        aspect_ratio: { kind: 'select', options: ['auto', '2:1'], restricted: false }, resolution: { kind: 'select', options: ['720p'], restricted: true } }, defaults: {} },
    } };
    const api = { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'range-model', baseUrl: fixtureOrigin,
      endpoint: '', statusEndpointTemplate: '', requestTemplate: '', apiKey: 'QA_SYNTHETIC_ONLY', authHeader: 'Authorization', authScheme: 'Bearer',
      fileIdPath: '', fileEndpointTemplate: '', fileUrlPath: '', parameterCapabilities: limits };
    state.settings.videoBackend = 'api'; state.settings.videoSource = 'api'; state.settings.activeVideoApiProfileId = null;
    state.settings.videoTaskApi = api;
    state.settings.videoApiProfiles = [
      { ...api, id: 'qa-enum', name: '枚举参数合成连接', model: 'enum-model', createdAt: now, updatedAt: now },
      { ...api, id: 'qa-unknown', name: '未知参数合成连接', model: 'unknown-model', parameterCapabilities: undefined, createdAt: now, updatedAt: now },
    ];
    state.settings.uiFontScalePercent = 100;
    for (const type of ['textApi', 'visionApi', 'imageApi']) { state.settings[type].enabled = false; state.settings[type].apiKey = ''; }
    const project = { ...state.project, id: 'qa-api-parameters', name: '视频参数隔离验证', activeChapterId: 'qa-story', sourceDocuments: [{ id: 'qa-story', name: '第 1 章', content: '角色走进空旷的房间，抬头望向窗外。', createdAt: now, updatedAt: now }], characters: [], locations: [], props: [], assets: [],
      storyboards: [], sequencePlans: [], generationTasks: [], scenes: [], updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    localStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, fixtureOrigin });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
}

async function checkScope(mode, size) {
  await page.setViewportSize(size);
  await page.getByRole('tab', { name: mode === 'single' ? '单段生成' : '长剧情批量', exact: true }).click();
  const prefix = mode === 'single' ? '本次' : '批量';
  const panel = page.getByRole('region', { name: `${prefix}视频生成参数`, exact: true });
  const connection = page.getByLabel(mode === 'single' ? '视频 API 配置' : '批量视频 API 配置', { exact: true });
  await connection.selectOption('');
  await panel.waitFor();
  const duration = panel.getByLabel(`${prefix}视频时长（秒）`, { exact: true });
  assert.equal(await duration.getAttribute('type'), 'number'); assert.equal(await duration.getAttribute('min'), '4');
  assert.equal(await duration.getAttribute('max'), '30'); assert.equal(await duration.getAttribute('step'), '1');
  assert.equal(await duration.inputValue(), '', 'service defaults must not create an override');
  assert.match(await panel.innerText(), /上游默认 6 秒/u);
  assert.equal(await panel.getByLabel(`${prefix}视频分辨率`, { exact: true }).count(), 0, 'restricted enums have no free-text editor');
  await panel.getByLabel(`${prefix}视频分辨率选项`, { exact: true }).selectOption('value:1080p');
  await layout(panel, `${mode}-range-${size.width}x${size.height}`);
  await connection.selectOption('qa-enum');
  assert.equal(await panel.getByLabel(`${prefix}视频时长（秒）`, { exact: true }).count(), 0);
  assert.ok((await panel.getByLabel(`${prefix}视频时长（秒）选项`, { exact: true }).locator('option').allTextContents()).includes('10'));
  assert.equal(await panel.getByLabel(`${prefix}视频画面比例`, { exact: true }).count(), 1, 'recommended values retain custom input');
  assert.match(await panel.innerText(), /推荐选项/u);
  await connection.selectOption('qa-unknown');
  assert.match(await panel.innerText(), /上游未提供参数限制/u);
  assert.equal(await panel.getByLabel(`${prefix}视频时长（秒）`, { exact: true }).getAttribute('type'), 'text');
  assert.equal(await panel.getByLabel(`${prefix}视频画面比例`, { exact: true }).count(), 1);
  assert.equal(await panel.getByLabel(`${prefix}视频分辨率`, { exact: true }).count(), 1);
  assert.match(await panel.innerText(), /常用选项，上游支持情况未读取/u);
  await panel.getByLabel(`${prefix}视频时长（秒）选项`, { exact: true }).selectOption('value:30');
  assert.equal(await panel.getByLabel(`${prefix}视频时长（秒）`, { exact: true }).inputValue(), '30');
  await panel.getByLabel(`${prefix}视频画面比例选项`, { exact: true }).selectOption('value:3:4');
  assert.equal(await panel.getByLabel(`${prefix}视频画面比例`, { exact: true }).inputValue(), '3:4');
  await panel.getByLabel(`${prefix}视频分辨率选项`, { exact: true }).selectOption('value:480p');
  assert.equal(await panel.getByLabel(`${prefix}视频分辨率`, { exact: true }).inputValue(), '480p');
  await panel.getByLabel(`${prefix}视频分辨率`, { exact: true }).fill('custom-size');
  assert.equal(await panel.getByLabel(`${prefix}视频分辨率选项`, { exact: true }).inputValue(), '__custom__');
  await layout(panel, `${mode}-unknown-${size.width}x${size.height}`);
  await connection.selectOption('');
  assert.equal(await panel.getByLabel(`${prefix}视频分辨率选项`, { exact: true }).inputValue(), 'value:1080p', 'a connection switch preserves its explicit overrides');
}

async function run() {
  await waitForCondition({ label: 'built video parameter preview', timeoutMs: 30_000, intervalMs: 100,
    check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === fixtureOrigin && request.method() === 'GET') {
      report.requests.push(url.pathname);
      const body = url.pathname === '/v1/models' ? { data: ['range-model', 'enum-model', 'unknown-model'].map((id) => ({ id })) }
        : url.pathname.endsWith('/openapi.json') ? document : {};
      await route.fulfill({ status: Object.keys(body).length ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    } else if (url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/__qa_')) await route.continue();
    else { report.blocked.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push(message.text()); });
  await installFixture();
  await checkScope('single', { width: 1280, height: 800 });
  await checkScope('batch', { width: 1120, height: 720 });
  await page.getByLabel('批量视频 API 配置', { exact: true }).selectOption('qa-unknown');
  await page.getByRole('button', { name: '读取模型参数', exact: true }).click();
  const selector = page.getByLabel('批量视频时长（秒）选项', { exact: true });
  await page.waitForFunction(() => Boolean(globalThis.document.querySelector('[aria-label="批量视频时长（秒）选项"] option[value="value:12"]')));
  assert.ok((await selector.locator('option').allTextContents()).includes('12'), 'explicit refresh reads the selected model schema');
  await page.waitForFunction((key) => Boolean(JSON.parse(localStorage.getItem(key)).settings.videoApiProfiles.find((entry) => entry.id === 'qa-unknown').parameterCapabilities), storageKey);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(saved.settings.videoApiProfiles.find((entry) => entry.id === 'qa-unknown').model, 'unknown-model');
  assert.deepEqual(saved.project.generationTasks, [], 'reading schemas never submits tasks');
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  const rules = page.locator('.director-rule-pane');
  await rules.waitFor();
  assert.equal(await rules.locator('select').count(), 4, 'prompt director retains its four other rule controls');
  assert.deepEqual(await rules.locator('.field > label').allTextContents(), ['节奏', '声音', '视频规则', '转换器']);
  assert.doesNotMatch(await rules.innerText(), /画幅|分辨率/u, 'prompt director has no removed video specification selectors');
  await layout(rules, 'prompt-rule-controls-1120x720');
  assert.deepEqual(report.blocked, []); assert.deepEqual(report.errors, []);
  report.pass = true;
}

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; if (page) await screenshot('failure').catch(() => {}); }
finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  harness.markElectronStopping(); await harness.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, layouts: report.layouts.length, failure: report.failure?.message, report: path.join(output, 'report.json') }, null, 2));
