import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Production dist only; no build, desktop profile, credentials, model requests,
// or existing project files. Each scenario has fresh browser storage.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')), 'Build dist before this targeted UI QA.');
const output = path.join(root, 'output', 'playwright', `text-api-cache-${version}`);
fs.mkdirSync(output, { recursive: true });
const fixtureRun = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
  import { createInitialState, normalizeState } from './src/storage.ts';
  const state = createInitialState();
  state.project.id = 'cache-qa-current'; state.project.name = '缓存测试项目';
  state.project.generationTasks = []; state.project.storyboards = []; state.project.sequencePlans = [];
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi'])
    state.settings[key] = { ...state.settings[key], enabled: false, apiKey: '' };
  process.stdout.write(JSON.stringify(normalizeState(state)));
`], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(fixtureRun.status, 0, fixtureRun.stderr);
const fixture = JSON.parse(fixtureRun.stdout);
const stateKey = 'lianhua_video_director_state_v22';
const usageKey = 'lianhua_text_api_usage_v1';
const now = Date.now();
const common = { projectId: fixture.project.id, projectName: fixture.project.name, chapterId: 'chapter-qa', chapterName: '合成章节',
  provider: 'deepseek', connectionName: '合成文字接口', status: 'succeeded', durationMs: 1234, outputTokens: 25 };
const records = [
  { ...common, id: 'qa-unknown', startedAt: now - 2000, finishedAt: now - 766, stage: 'deliver', segmentIndex: 3,
    model: 'other-text', inputTokens: 500, usageSource: '接口未返回缓存统计' },
  { ...common, id: 'qa-zero', startedAt: now - 3000, finishedAt: now - 1766, stage: 'translate', segmentIndex: 2,
    model: 'deepseek-qa', inputTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100 },
  { ...common, id: 'qa-hit', startedAt: now - 4000, finishedAt: now - 2766, stage: 'convert', segmentIndex: 1,
    model: 'deepseek-qa', inputTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 },
  { ...common, id: 'qa-other-project', projectId: 'cache-qa-other', projectName: '另一个合成项目', startedAt: now - 1000,
    finishedAt: now + 234, stage: 'convert', segmentIndex: 1, model: 'other-text', inputTokens: 900, cacheHitTokens: 450, cacheMissTokens: 450 },
];
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--input-type=module', '-e',
  `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true,open:false}});`],
{ cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'text API cache production UI QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
const errors = [], blockedRequests = [], checks = [], measurements = [];
let browser, context, page, failure;
const dialog = () => page.getByRole('dialog', { name: '缓存命中分析', exact: true });
const trigger = () => page.locator('.sidebar .cache-analysis-trigger');
const filter = (label) => dialog().locator('.cache-analysis-filters').getByRole('combobox', { name: new RegExp(`^${label}`, 'u') });
const metric = (label) => dialog().locator('.cache-analysis-summary > div').filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
const rows = () => dialog().locator('tbody > tr');
const waitMetric = (label, value) => waitForCondition({ label: `${label}=${value}`, timeoutMs: 8000, intervalMs: 50,
  check: async () => (await metric(label).innerText()).replace(/\s+/gu, '') === value });
const assertDialogBounds = async () => {
  const box = await dialog().boundingBox(); const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    'the modal fits inside the window');
  assert.equal(await dialog().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + 25, box.top + 25));
  }), true, 'the dialog is visible above app panels');
};

async function run() {
  await waitForCondition({ label: 'built production preview ready', timeoutMs: 30000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  for (const scenario of [{ width: 1440, height: 1000, theme: 'light' }, { width: 1120, height: 720, theme: 'dark' }]) {
    const tag = `${scenario.width}x${scenario.height}-${scenario.theme}`;
    context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', (error) => errors.push({ scenario: tag, error: error.message }));
    page.on('console', (message) => { if (message.type() === 'error') errors.push({ scenario: tag, error: message.text() }); });
    await page.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
        blockedRequests.push({ scenario: tag, method: request.method(), url: request.url() });
        await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    const state = structuredClone(fixture); state.settings.theme = scenario.theme;
    await page.addInitScript(({ state, records, stateKey, usageKey }) => {
      if (sessionStorage.getItem('__cache_qa_initialized')) return;
      localStorage.setItem(stateKey, JSON.stringify(state));
      localStorage.setItem(usageKey, JSON.stringify(records));
      sessionStorage.setItem('__cache_qa_initialized', '1');
    }, { state, records, stateKey, usageKey });
    await page.goto(origin, { waitUntil: 'networkidle' }); await trigger().waitFor();
    await waitForCondition({ label: `${scenario.theme} theme applied`, timeoutMs: 8000, intervalMs: 50,
      check: () => page.evaluate((theme) => document.documentElement.dataset.colorMode === theme, scenario.theme) });
    const updateEntry = page.locator('.sidebar').getByRole('button', { name: /更新日志及项目地址/u });
    const cacheBox = await trigger().boundingBox(); const updateBox = await updateEntry.boundingBox();
    const projectBox = await page.locator('.sidebar .status-card-switcher').boundingBox();
    assert.ok(cacheBox && updateBox && projectBox);
    assert.ok(cacheBox.y + cacheBox.height <= updateBox.y + 1, 'cache entry appears before the update-log entry');
    assert.ok(Math.abs(cacheBox.height - updateBox.height) <= 1, 'cache and update-log entries have equal heights');
    assert.ok(Math.abs(cacheBox.width - updateBox.width) <= 1, 'cache and update-log entries have equal widths');
    assert.ok(projectBox.height <= 76, 'the current-project box stays compact');
    assert.equal(await page.locator('.sidebar-project-name').evaluate((element) => {
      const style = getComputedStyle(element); return element.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1;
    }), true, 'the project name occupies a single compact line');
    measurements.push({ scenario: tag, cacheBox, updateBox, projectBox });
    await page.screenshot({ path: path.join(output, `sidebar-${tag}.png`) });

    await trigger().click(); await dialog().waitFor(); await assertDialogBounds();
    assert.equal(await filter('项目').inputValue(), `project:${fixture.project.id}`);
    await waitMetric('请求总数', '3'); await waitMetric('有命中率数据', '2/3'); await waitMetric('累计命中率', '81.8%');
    assert.equal(await rows().count(), 3);
    assert.equal(await rows().filter({ hasText: '第 2 段' }).getByRole('cell').nth(6).innerText(), '0.0%');
    assert.equal(await rows().filter({ hasText: '第 3 段' }).getByRole('cell').nth(6).innerText(), '未返回');
    assert.match(await dialog().locator('.cache-analysis-note').innerText(), /输入 1,100 · 命中 900 · 未命中 200/u);
    await page.screenshot({ path: path.join(output, `current-project-${tag}.png`) });

    await filter('项目').selectOption('all');
    await waitMetric('请求总数', '4'); await waitMetric('累计命中率', '67.5%');
    assert.equal(await rows().count(), 4);
    await filter('模型').selectOption('deepseek-qa');
    await waitMetric('请求总数', '2'); await waitMetric('累计命中率', '81.8%');
    await filter('任务阶段').selectOption('translate');
    await waitMetric('请求总数', '1'); await waitMetric('累计命中率', '0.0%');
    await filter('模型').selectOption('other-text');
    await waitMetric('请求总数', '0');
    assert.equal(await dialog().getByText('当前筛选范围暂无请求记录。', { exact: true }).isVisible(), true);
    await filter('模型').selectOption('');
    await filter('任务阶段').selectOption('');
    await waitMetric('累计命中率', '67.5%');
    await page.screenshot({ path: path.join(output, `all-projects-${tag}.png`) });
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
    assert.equal(await trigger().evaluate((element) => document.activeElement === element), true, 'Escape restores the entry focus');

    const beforeReload = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), usageKey);
    assert.equal(beforeReload.length, 4);
    await page.reload({ waitUntil: 'networkidle' }); await trigger().click();
    await waitMetric('请求总数', '3'); await waitMetric('累计命中率', '81.8%');
    assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), usageKey), beforeReload,
      'opening and reloading the analysis preserves recorded history');
    assert.equal(await page.evaluate(() => Boolean(window.lianhuaDesktop)), false, 'the browser has no desktop access');
    checks.push(`${tag}: compact sidebar, distinct zero/unknown, token-weighted totals, project/model/stage filters, empty filter, Escape focus, reload history`);
    await context.close(); context = undefined; page = undefined;
  }
  assert.deepEqual(blockedRequests, [], 'statistics navigation never attempts external or model requests');
  assert.deepEqual(errors, [], 'production UI has no browser errors');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, version, productionPreview: true,
    isolatedBrowserStorage: true, modelRequests: 0, checks, measurements, blockedRequests, errors }, null, 2));
  console.log(`Text API cache UI checks passed: ${path.join(output, 'report.json')}`);
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  failure = error; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks, measurements, blockedRequests, errors }, null, 2));
} finally {
  harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
}
if (failure) throw failure;
