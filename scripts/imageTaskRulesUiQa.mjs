import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Focused full-App visual QA. Fresh browser, synthetic neutral data, no desktop
// bridge and no provider requests. It never clicks a generation action.
const root = path.resolve(import.meta.dirname, '..');
const runId = Date.now();
const output = path.join(root, 'output', 'playwright', `image-task-rules-${runId}`);
const cacheDir = path.join(root, `.qa-image-task-rules-${runId}`, 'vite');
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({cacheDir:${JSON.stringify(cacheDir)},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Image task rules QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'image task rule labels', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let page; let storageKey;
const checks = []; const errors = []; const blockedRequests = []; const screenshots = []; const layout = [];
const mark = (label) => { checks.push(label); console.log(label); };
const card = (id) => page.locator(`#image-task-${id}`);
const labels = (id) => card(id).locator('.image-task-prompt-config > span');
const capture = async (name, locator) => {
  const file = path.join(output, `${name}.png`);
  if (locator) await locator.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, animations: 'disabled', fullPage: false });
  screenshots.push(file);
};
const expected = [
  ['qa-queued', '生图规则：任务创建时保存的自然静物柔光与空间一致性完整规则名称与完整物体轮廓、统一镜头视角和材质连续性 · v1.2.3', '分类预设：任务创建时保存的自然静物摄影分类预设完整名称 · v2.3.4'],
  ['qa-running', '生图规则：旧记录精确匹配规则 · v3.4.5（名称按记录匹配）', '分类预设：旧记录精确匹配预设 · v4.5.6（名称按记录匹配）'],
  ['qa-succeeded', '生图规则：结果资产保存的历史规则 · v5.6.7', '分类预设：结果资产保存的历史预设 · v6.7.8'],
  ['qa-upgraded', '生图规则：ID：qa-upgraded-rule-history-with-long-unbroken-identity · v1.0.0', '分类预设：ID：qa-upgraded-preset-history-with-long-unbroken-identity · v1.0.0'],
  ['qa-unknown', '生图规则：未记录', '分类预设：未记录'],
];

async function checkLabels(viewport) {
  for (const [id, rule, preset] of expected) {
    assert.deepEqual(await labels(id).allTextContents(), [rule, preset]);
    await card(id).scrollIntoViewIfNeeded();
    const geometry = await card(id).locator('.image-task-prompt-config').evaluate((element) => {
      const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return { flexWrap: style.flexWrap, width: box.width, spans: [...element.children].map((span) => {
        const rect = span.getBoundingClientRect(); const css = getComputedStyle(span);
        const range = document.createRange(); range.selectNodeContents(span);
        const textRects = [...range.getClientRects()];
        return { text: span.textContent, title: span.title, width: rect.width, height: rect.height, top: rect.top,
          lines: new Set(textRects.map((item) => Math.round(item.top))).size,
          clipped: span.scrollWidth > span.clientWidth + 1 || span.scrollHeight > span.clientHeight + 1,
          fits: rect.left >= box.left - 1 && rect.right <= box.right + 1,
          whiteSpace: css.whiteSpace, overflow: css.overflow, textOverflow: css.textOverflow,
          textFits: textRects.every((item) => item.left >= rect.left - 1 && item.right <= rect.right + 1),
        };
      }) };
    });
    assert.equal(geometry.flexWrap, 'wrap', `${id}: metadata wraps`);
    for (const span of geometry.spans) {
      assert.equal(span.clipped, false, `${id}: label must not be clipped`);
      assert.equal(span.fits && span.textFits, true, `${id}: label text must stay inside its card`);
      assert.notEqual(span.whiteSpace, 'nowrap'); assert.notEqual(span.textOverflow, 'ellipsis');
      assert.ok(span.title);
    }
    layout.push({ viewport, id, ...geometry });
  }
}

const run = async () => {
  assert.match(fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8'), /\.image-task-prompt-config\s*\{[^}]*flex-wrap:\s*wrap/u, 'Wait for metadata wrap styling before this focused run');
  await waitForCondition({ label: 'image rules App Vite', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.hostname === '127.0.0.1' && url.port === String(port) && url.pathname === '/') { socket.connectToServer(); return; }
    blockedRequests.push(`WEBSOCKET ${socket.url()}`); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== base || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__image_rules_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Neutral image rule fixture</title><body>Only synthetic task metadata</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${base}/__image_rules_fixture.html`);
  storageKey = await page.evaluate(async () => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const { createImageGenerationTask } = await import('/src/generationTasks.ts');
    const state = createInitialState(); const now = 1791129000000;
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#a9c5cc'; paint.fillRect(0, 0, 80, 80);
    paint.fillStyle = '#e8e3d2'; paint.fillRect(20, 25, 40, 35);
    const resultAsset = { id: 'qa-result', name: '中性静物色块结果', type: 'reference', role: 'prop', mediaType: 'image', source: 'generated', dataUrl: canvas.toDataURL(), tags: [],
      imagePromptRuleSetId: 'qa-asset-rule', imagePromptRuleSetName: '结果资产保存的历史规则', imagePromptRuleSetVersion: '5.6.7',
      imagePromptPresetId: 'qa-asset-preset', imagePromptPresetName: '结果资产保存的历史预设', imagePromptPresetVersion: '6.7.8', createdAt: now, updatedAt: now };
    const task = (id, name, status, extra = {}) => ({ ...createImageGenerationTask({ id, name, assetKind: 'prop', imageVariant: 'reference', prompt: 'A neutral ceramic cube on a clean studio table in soft daylight.', backend: 'openai', model: 'isolated-no-api', width: 1024, height: 1024 }, now, status), ...extra });
    const tasks = [
      task('qa-queued', '排队 · 本次任务名称快照', 'failed', { imagePromptRuleSetId: 'qa-snapshot-rule', imagePromptRuleSetName: '任务创建时保存的自然静物柔光与空间一致性完整规则名称与完整物体轮廓、统一镜头视角和材质连续性', imagePromptRuleSetVersion: '1.2.3', imagePromptPresetId: 'qa-snapshot-preset', imagePromptPresetName: '任务创建时保存的自然静物摄影分类预设完整名称', imagePromptPresetVersion: '2.3.4' }),
      task('qa-running', '生成中 · 旧记录精确匹配', 'failed', { imagePromptRuleSetId: 'qa-legacy-rule', imagePromptRuleSetVersion: '3.4.5', imagePromptPresetId: 'qa-legacy-preset', imagePromptPresetVersion: '4.5.6' }),
      task('qa-succeeded', '已完成 · 结果资产历史快照', 'succeeded', { resultAssetId: resultAsset.id }),
      task('qa-upgraded', '失败 · 原规则库已经改名升级', 'failed', { imagePromptRuleSetId: 'qa-upgraded-rule-history-with-long-unbroken-identity', imagePromptRuleSetVersion: '1.0.0', imagePromptPresetId: 'qa-upgraded-preset-history-with-long-unbroken-identity', imagePromptPresetVersion: '1.0.0', error: '纯合成历史失败任务，无请求。' }),
      task('qa-unknown', '失败 · 未保存配置的旧记录', 'failed', { error: '纯合成历史失败任务，无请求。' }),
    ];
    const preset = (id, name, version) => ({ ...state.imagePromptRules.categoryPresets[0], id, name, version, assetKind: 'prop', systemPrompt: 'Neutral static object.', outputRules: 'Only static object.', updatedAt: now });
    const rule = (id, name, version) => ({ ...state.imagePromptRules.ruleSets[0], id, name, version, systemPrompt: 'Neutral static object.', outputRules: 'Only static object.', updatedAt: now });
    state.imagePromptRules.categoryPresets.push(
      preset('qa-snapshot-preset', '当前库已升级预设不应覆盖历史', '9.9.9'),
      preset('qa-legacy-preset', '旧记录精确匹配预设', '4.5.6'),
      preset('qa-upgraded-preset-history-with-long-unbroken-identity', '当前升级预设不应冒充历史', '9.0.0'),
    );
    state.imagePromptRules.ruleSets.push(
      rule('qa-snapshot-rule', '当前库已升级规则不应覆盖历史', '9.9.9'),
      rule('qa-legacy-rule', '旧记录精确匹配规则', '3.4.5'),
      rule('qa-upgraded-rule-history-with-long-unbroken-identity', '当前升级规则不应冒充历史', '9.0.0'),
    );
    const project = { ...state.project, id: 'qa-image-task-rules-project', name: '图片规则元数据隔离检查', description: '纯合成中性数据', sourceDocuments: [], scenes: [], characters: [], locations: [], props: [], storyboards: [], sequencePlans: [], assets: [resultAsset], generationTasks: tasks, createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name] = { ...state.settings[name], enabled: false, apiKey: '' };
    for (const kind of ['Text', 'Vision', 'Image', 'Video']) { state.settings[`${kind.toLowerCase()}ApiProfiles`] = []; state.settings[`active${kind}ApiProfileId`] = null; }
    state.settings.apiCredentialBook = []; state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return STORAGE_KEY;
  });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 50000 });
  assert.equal(await page.evaluate(() => typeof window.lianhuaDesktop), 'undefined');
  await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
  await page.locator('.jobs-view').waitFor();
  // Storage correctly marks old in-flight tasks interrupted on reload. Model
  // fresh live statuses through the mounted view's real existing state setter;
  // no test hook, source rewrite, task submission or provider worker is used.
  await page.locator('.jobs-view').evaluate((element) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let component = key && element[key];
    while (component && !(typeof component.memoizedProps?.setBackgroundState === 'function' && component.memoizedProps?.state)) component = component.return;
    if (!component) throw new Error('Cannot locate real generation task context');
    component.memoizedProps.setBackgroundState((current) => {
      if (current.project.id !== 'qa-image-task-rules-project') throw new Error('Only the synthetic fixture may be changed');
      const project = { ...current.project, generationTasks: current.project.generationTasks.map((task) => task.id === 'qa-queued' || task.id === 'qa-running' ? { ...task, status: task.id === 'qa-queued' ? 'queued' : 'running', error: undefined } : task) };
      return { ...current, project, projects: current.projects.map((item) => item.id === project.id ? project : item) };
    });
  });
  await card('qa-queued').locator('button').filter({ hasText: /^取消排队$/u }).waitFor();
  await card('qa-running').locator('button').filter({ hasText: /^不可删除$/u }).waitFor();
  assert.equal(await page.locator('.image-task-prompt-config').count(), 5);
  await checkLabels('1480x1100');
  mark('queued/running/succeeded/failed cards show both exact expected labels');
  mark('task snapshots survive current catalog rename/version upgrade; legacy ID+version matches are explicit');
  mark('matching result asset supplies historical snapshot; unknown history stays unrecorded and changed revision shows stored ID/version');
  await card('qa-queued').scrollIntoViewIfNeeded(); await capture('desktop-labels');
  await page.setViewportSize({ width: 1040, height: 1100 });
  await checkLabels('1040x1100');
  assert.ok(layout.filter((entry) => entry.viewport === '1040x1100').some((entry) => entry.spans.some((span) => span.lines > 1) || new Set(entry.spans.map((span) => Math.round(span.top))).size > 1), 'Long metadata must wrap within or between labels at the supported narrow desktop width');
  await card('qa-queued').scrollIntoViewIfNeeded(); await capture('narrow-labels');
  await capture('narrow-long-snapshot-card', card('qa-queued'));
  await capture('narrow-upgraded-history-card', card('qa-upgraded'));
  mark('1040px supported narrow desktop: long names and long IDs wrap without clipping or ellipsis');
  const tasks = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.generationTasks, storageKey);
  assert.deepEqual(tasks.map(({ id, status }) => [id, status]), [['qa-queued', 'queued'], ['qa-running', 'running'], ['qa-succeeded', 'succeeded'], ['qa-upgraded', 'failed'], ['qa-unknown', 'failed']]);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  mark('zero page/console errors, zero provider requests, no task actions triggered');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, errors, blockedRequests, layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks, screenshots }));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
    await page.locator('body').innerText({ timeout: 3000 }).then((body) => fs.writeFileSync(path.join(output, 'failure.txt'), body)).catch(() => {});
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: String(error), checks, errors, blockedRequests, layout, screenshots, productionDataRead: false, paidRequests: 0, generationActions: 0 }, null, 2));
  console.error(JSON.stringify({ output, error: String(error), errors })); throw error;
}
finally { await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
