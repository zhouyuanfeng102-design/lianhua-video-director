import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One focused pass over the built renderer with empty browser storage and a
// synthetic model/OpenAPI responses. External requests and video submissions are blocked.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `generic-video-settings-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow a symbolic link: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
assert.match(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), /assets\/index-[^"\s]+\.js/u);
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = 'http://127.0.0.1:49173';
const fixtureModels = ['sora-fixture', 'Sora Fixture Alias', 'image-fixture'];
const fixtureDocument = { openapi: '3.0.3', servers: [{ url: fixtureOrigin }], security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
    VideoTask: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, progress: { type: 'number' },
      output: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } } },
  } }, paths: {
    '/v1/videos': { post: { operationId: 'createVideo', responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/VideoTask' } } } } } } },
    '/v1/videos/{id}': { get: { operationId: 'getVideo', responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/VideoTask' } } } } } } },
  } };
const report = { pass: false, version, isolatedStorage: true, modelRequests: [], documentRequests: [], blockedRequests: [], layouts: [], screenshots: [], pageErrors: [], consoleErrors: [] };
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: child, qaLabel: 'generic video settings', runTimeoutMs: 90_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;

async function run() {
  await waitForCondition({ label: 'built generic video settings startup', timeoutMs: 30_000, intervalMs: 100,
    check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === fixtureOrigin && url.pathname === '/v1/models' && request.method() === 'GET') {
      assert.equal(request.headers().authorization, 'Bearer qa-synthetic-video-key');
      report.modelRequests.push({ method: request.method(), pathname: url.pathname });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ object: 'list', data: fixtureModels.map((id, index) => ({ id, object: 'model', supported_endpoint_types: index === 2 ? ['openai-image'] : ['openai-video'] })) }) });
      return;
    }
    if (url.origin === fixtureOrigin && request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET' } });
      return;
    }
    if (url.origin === fixtureOrigin && request.method() === 'GET' && ['/openapi.json', '/v1/openapi.json', '/docs/video-api/openapi.json'].includes(url.pathname)) {
      assert.equal(request.headers().authorization, 'Bearer qa-synthetic-video-key');
      report.documentRequests.push({ method: request.method(), pathname: url.pathname });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixtureDocument) });
      return;
    }
    const allowed = url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/src/');
    if (/^https?:$/u.test(url.protocol) && !allowed) {
      report.blockedRequests.push({ method: request.method(), pathname: url.pathname });
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.locator('.settings-api-tabs').getByRole('tab', { name: '视频生成', exact: true }).click();
  const panel = page.locator('.video-settings-redesign');
  await panel.getByRole('tab', { name: '视频 API', exact: true }).click();
  await panel.getByLabel('视频接口协议', { exact: true }).selectOption('generic');
  assert.equal(await panel.getByRole('button', { name: '填入老李视频地址', exact: true }).count(), 0);
  assert.ok(!(await panel.innerText()).includes('老李'));
  await panel.getByLabel('视频 API 地址', { exact: true }).fill(fixtureOrigin);
  await panel.getByLabel('API 密钥', { exact: true }).fill('qa-synthetic-video-key');
  await panel.getByLabel('视频模型 ID', { exact: true }).fill('manually-entered-model');
  await panel.getByRole('button', { name: '获取模型', exact: true }).click();
  const picker = panel.getByLabel('选择视频模型', { exact: true });
  await picker.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="选择视频模型"]').disabled);
  const choices = await picker.locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(choices.slice(1).sort(), [...fixtureModels].sort(), 'complete model list retains aliases and image IDs');
  assert.equal(await panel.getByLabel('视频模型 ID', { exact: true }).inputValue(), 'manually-entered-model', 'fetching does not change the model');
  await picker.selectOption('image-fixture');
  assert.equal(await panel.getByLabel('视频模型 ID', { exact: true }).inputValue(), 'image-fixture');
  await panel.getByLabel('视频模型 ID', { exact: true }).fill('final-manual-model');

  await panel.getByRole('button', { name: '高级协议与请求模板', exact: true }).click();
  const beforeAuto = page.getByRole('dialog', { name: '视频 API 高级设置', exact: true });
  await beforeAuto.getByLabel('提交端点', { exact: true }).fill('https://previous.example.invalid/create');
  await beforeAuto.getByLabel('任务查询端点', { exact: true }).fill('https://previous.example.invalid/tasks/{id}');
  await beforeAuto.getByRole('tab', { name: '认证与结果映射', exact: true }).click();
  await beforeAuto.getByLabel('文件 ID 字段路径', { exact: true }).fill('file_id');
  await beforeAuto.getByLabel('根据文件 ID 取下载 URL', { exact: true }).fill('https://api.minimaxi.com/v1/files/retrieve?file_id={id}');
  await beforeAuto.getByLabel('文件下载 URL 字段路径', { exact: true }).fill('file.download_url');
  await beforeAuto.getByRole('button', { name: '关闭', exact: true }).click();
  await panel.getByRole('button', { name: '自动获取并补齐', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.vgs-feedback')?.textContent?.includes('OpenAPI 文档补齐'));
  assert.equal(await panel.getByLabel('视频 API 地址', { exact: true }).inputValue(), fixtureOrigin);
  assert.equal(await panel.getByLabel('API 密钥', { exact: true }).inputValue(), 'qa-synthetic-video-key');
  assert.equal(await panel.getByLabel('视频模型 ID', { exact: true }).inputValue(), 'final-manual-model');
  assert.deepEqual((await picker.locator('option').evaluateAll((options) => options.map((option) => option.value))).slice(1).sort(), [...fixtureModels].sort());
  assert.equal(await picker.isDisabled(), false, 'the model list survives automatically updated task/authentication fields');
  await panel.getByRole('button', { name: '高级协议与请求模板', exact: true }).click();
  const completed = page.getByRole('dialog', { name: '视频 API 高级设置', exact: true });
  assert.equal(await completed.getByLabel('提交端点', { exact: true }).inputValue(), `${fixtureOrigin}/v1/videos`);
  assert.equal(await completed.getByLabel('任务查询端点', { exact: true }).inputValue(), `${fixtureOrigin}/v1/videos/{id}`);
  await completed.getByRole('tab', { name: '认证与结果映射', exact: true }).click();
  assert.equal(await completed.getByLabel('任务 ID 字段路径', { exact: true }).inputValue(), 'id');
  assert.equal(await completed.getByLabel('视频下载 URL 字段路径', { exact: true }).inputValue(), 'output.url');
  for (const name of ['文件 ID 字段路径', '根据文件 ID 取下载 URL', '文件下载 URL 字段路径']) assert.equal(await completed.getByLabel(name, { exact: true }).inputValue(), '', 'the former service mapping is cleared by explicit automatic completion');
  await completed.getByRole('button', { name: '关闭', exact: true }).click();

  for (const size of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const rect = (item) => { const value = item.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }; };
      const controls = [...element.querySelectorAll('.vgs-main input:not([type="checkbox"]),.vgs-main select,.vgs-main button')]
        .filter((item) => item.getClientRects().length && !item.closest('[hidden]'))
        .map((item) => ({ label: item.getAttribute('aria-label') || item.textContent?.trim(), ...rect(item) }));
      return { viewport: { width: innerWidth, height: innerHeight }, panel: rect(element),
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        verticalOverflow: element.scrollHeight > element.clientHeight + 1,
        hiddenControls: controls.filter((item) => item.left < bounds.left - 1 || item.right > bounds.right + 1 || item.top < bounds.top - 1 || item.bottom > bounds.bottom + 1),
        controls, cards: element.querySelectorAll(':scope > .vgs-main > .vgs-card').length };
    });
    report.layouts.push(layout);
    assert.equal(layout.cards, 3, 'connection library, address/auth and model remain in separate cards');
    assert.equal(layout.horizontalOverflow, false, `${size.width}: no horizontal overflow`);
    assert.equal(layout.verticalOverflow, false, `${size.width}: no vertical overflow`);
    assert.deepEqual(layout.hiddenControls, [], `${size.width}: every common control stays in the visible panel`);
    assert.ok(layout.panel.left >= -1 && layout.panel.top >= -1 && layout.panel.right <= size.width + 1 && layout.panel.bottom <= size.height + 1, 'panel stays in viewport');
    assert.equal(await panel.getByLabel('提交端点', { exact: true }).count(), 0, 'custom task URLs stay in advanced settings');
    const screenshot = path.join(output, `generic-video-${size.width}x${size.height}.png`);
    await page.screenshot({ path: screenshot, scale: 'css' }); report.screenshots.push(screenshot);
  }
  await panel.getByRole('button', { name: '高级协议与请求模板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '视频 API 高级设置', exact: true });
  await dialog.getByLabel('提交端点', { exact: true }).fill('https://custom.example.invalid/create');
  await dialog.getByLabel('任务查询端点', { exact: true }).fill('https://custom.example.invalid/jobs/{id}');
  await dialog.getByRole('button', { name: '使用地址自动生成端点', exact: true }).click();
  assert.equal(await dialog.getByLabel('提交端点', { exact: true }).inputValue(), '');
  assert.equal(await dialog.getByLabel('任务查询端点', { exact: true }).inputValue(), '');
  assert.ok((await dialog.innerText()).includes(`${fixtureOrigin}/v1/videos`));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await panel.getByLabel('视频模型 ID', { exact: true }).inputValue(), 'final-manual-model');
  assert.deepEqual(report.modelRequests, [{ method: 'GET', pathname: '/v1/models' }, { method: 'GET', pathname: '/v1/models' }]);
  assert.deepEqual(report.documentRequests.map((entry) => entry.pathname).sort(), ['/openapi.json', '/v1/openapi.json', '/docs/video-api/openapi.json'].sort());
  assert.deepEqual(report.blockedRequests, [], 'settings QA does not submit video tasks or use external APIs');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  report.pass = true;
}

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) {
    const screenshot = path.join(output, 'generic-video-failure.png');
    await page.screenshot({ path: screenshot, scale: 'css' }).then(() => report.screenshots.push(screenshot)).catch(() => {});
  }
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  harness.markElectronStopping();
  await harness.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, layouts: report.layouts.length, modelRequests: report.modelRequests.length, documentRequests: report.documentRequests.length,
  failure: report.failure?.message, report: path.join(output, 'report.json') }, null, 2));
