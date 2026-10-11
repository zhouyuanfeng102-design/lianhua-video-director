import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A focused packaged-renderer layout pass. Requests use a deterministic loopback
// fixture and storage uses a newly created profile; no production data is loaded.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
assert.ok(electronOption !== -1 && process.argv[electronOption + 1], '--electron requires a packaged executable path');
const executable = path.resolve(process.argv[electronOption + 1]);
await fs.access(executable);
const output = path.join(root, 'output', 'playwright', `story-input-layout-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow symbolic links: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = { pass: false, version, packagedElectron: true, model: 'local deterministic layout fixture',
  realModelQualityEvaluated: false, noProductionDataRead: true, stages: [], requests: [], layouts: [], screenshots: [],
  pageErrors: [], consoleErrors: [], blockedRequests: [], fixtureErrors: [] };
const source = '少女拾起地上的铜灯，把它放到窗台上，再松开灯柄。';
const chapterId = 'qa-story-layout-chapter';
let understandingCount = 0;
let generationCount = 0;
const releases = new Map();
const holdUnderstanding = (count) => new Promise((resolve) => releases.set(count, resolve));
const mock = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/qa-story-layout/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const user = payload.messages.filter((message) => message.role === 'user')
      .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
    const match = user.match(/<story_visual_data>\s*([\s\S]*?)\s*<\/story_visual_data>/u);
    assert.ok(match, 'conversion request includes structured source data');
    const data = JSON.parse(match[1]);
    assert.equal(data.sourceTextOrRequirement, source);
    assert.ok(['understanding', 'visualizing'].includes(data.stage));
    report.requests.push({ stage: data.stage, sourceCharacters: data.sourceTextOrRequirement.length });
    let result;
    if (data.stage === 'understanding') {
      understandingCount++;
      await holdUnderstanding(understandingCount);
      result = { version: 1, summary: '少女拾起铜灯并放在窗台上。', events: [
        { id: 'e1', sourceParagraphIds: ['p1'], evidence: source, actor: '少女', target: '铜灯',
          action: '拾起铜灯并放到窗台', phases: ['提灯离地', '灯底贴稳窗台', '松开灯柄'], result: '铜灯留在窗台上', uncertainties: [] },
      ] };
    } else {
      generationCount++;
      result = { paragraphs: [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['e1'],
        text: '少女俯身握住铜灯的灯柄，提灯离开地面。她把铜灯移到窗台上，待灯底贴稳台面后松开灯柄，铜灯停在窗台上。',
        stagingAdditions: ['俯身握住灯柄是对原文拾灯动作的编排补充。'] }] };
    }
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    report.fixtureErrors.push(error.stack || error.message);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic layout fixture failed' } }));
  }
});
let harness;
let browser;
let page;
const sizes = [{ width: 1280, height: 800 }, { width: 1120, height: 720 }, { width: 1920, height: 1200 }];
const idleLayouts = new Map();
const waitCount = (stage, count) => waitForCondition({ label: `${stage} request ${count}`, timeoutMs: 15_000, intervalMs: 40,
  check: () => report.requests.filter((request) => request.stage === stage).length === count });
const settleLayout = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const screenshot = async (name) => {
  const destination = path.join(output, `${name}.png`);
  await page.screenshot({ path: destination, scale: 'css' }); report.screenshots.push(destination);
};
async function checkInputLayout(name, imageMode = false) {
  await settleLayout();
  const layout = await page.locator('.story-input-card').evaluate((card) => {
    const rect = (element) => {
      if (!element) throw new Error('Expected layout element missing');
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const titleField = [...card.querySelectorAll('.field')].find((field) => field.querySelector('label')?.textContent.trim() === '章节名称');
    if (!titleField) throw new Error('Chapter name field missing');
    const sourceField = card.querySelector('.story-source-field');
    const textarea = sourceField?.querySelector('textarea');
    const footer = card.querySelector('.story-input-footer');
    const reference = card.querySelector('.story-reference-panel');
    return { viewport: { width: innerWidth, height: innerHeight }, card: rect(card), header: rect(card.querySelector('.story-input-header')), titleField: rect(titleField),
      titleLabel: rect(titleField.querySelector('label')), titleInput: rect(titleField.querySelector('input')),
      sourceField: rect(sourceField), textarea: rect(textarea), footer: rect(footer), reference: reference && rect(reference),
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1, verticalOverflow: card.scrollHeight > card.clientHeight + 1 };
  });
  report.layouts.push({ name, imageMode, ...layout });
  const within = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
    && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  assert.ok(layout.titleInput.height >= 24 && layout.titleInput.height <= 44, `${name}: chapter input keeps normal control height`);
  assert.ok(layout.titleField.height <= 72, `${name}: chapter name field cannot consume the flexible editor area`);
  const labelGap = layout.titleInput.top - layout.titleLabel.bottom;
  assert.ok(labelGap >= -1 && labelGap <= 8, `${name}: chapter label remains adjacent to its input`);
  assert.ok(layout.sourceField.top >= layout.titleField.bottom - 1, `${name}: story remains below the chapter name`);
  assert.ok(layout.textarea.height >= 160 && layout.textarea.height >= layout.titleInput.height * 4, `${name}: story remains the main editable area`);
  const editorShare = layout.textarea.height / layout.card.height;
  assert.ok(editorShare >= (imageMode ? 0.30 : 0.48), `${name}: story occupies the major remaining card space`);
  assert.ok(within(layout.card, layout.titleInput) && within(layout.card, layout.sourceField)
    && within(layout.card, layout.textarea) && within(layout.card, layout.footer), `${name}: controls remain inside the input card`);
  assert.ok(layout.footer.top >= 0 && layout.footer.bottom <= layout.viewport.height + 1, `${name}: footer controls remain visible`);
  assert.ok(layout.card.left >= -1 && layout.card.right <= layout.viewport.width + 1
    && layout.card.top >= -1 && layout.card.bottom <= layout.viewport.height + 1, `${name}: card stays inside viewport`);
  assert.equal(layout.horizontalOverflow, false, `${name}: no horizontal card overflow`);
  assert.equal(layout.verticalOverflow, false, `${name}: no vertical card overflow`);
  assert.equal(Boolean(layout.reference), imageMode, `${name}: expected input mode is rendered`);
  const viewportKey = `${layout.viewport.width}x${layout.viewport.height}`;
  if (name.startsWith('idle-')) idleLayouts.set(viewportKey, layout);
  else if (!imageMode) {
    const idle = idleLayouts.get(viewportKey);
    assert.ok(idle, `${name}: an idle layout exists for comparison`);
    assert.ok(Math.abs(layout.titleInput.height - idle.titleInput.height) <= 1, `${name}: status notices do not stretch the chapter input`);
    assert.ok(Math.abs(layout.titleField.height - idle.titleField.height) <= 1, `${name}: status notices do not stretch the chapter field`);
    const addedHeaderHeight = layout.header.height - idle.header.height;
    assert.ok(addedHeaderHeight >= -1, `${name}: notices add only normal header height`);
    assert.ok(Math.abs((layout.titleField.top - idle.titleField.top) - addedHeaderHeight) <= 2,
      `${name}: chapter field moves only by the notice height`);
    assert.ok(Math.abs((idle.textarea.height - layout.textarea.height) - addedHeaderHeight) <= 2,
      `${name}: story editor gives up only the space occupied by notices`);
    assert.ok(Math.abs(layout.footer.bottom - idle.footer.bottom) <= 1, `${name}: footer stays in its original position`);
  }
}
async function checkAtSizes(stage, { capture = false, imageMode = false } = {}) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    const name = `${stage}-${size.width}x${size.height}`;
    await checkInputLayout(name, imageMode);
    if (capture && size.width !== 1120) await screenshot(name);
  }
  report.stages.push(`${stage} at 1280x800, 1120x720 and 1920x1200`);
}
try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const { createInitialState, normalizeState } = await tsImport('../src/storage.ts', import.meta.url);
  const initial = createInitialState();
  const now = Date.now();
  const project = { ...initial.project, id: 'qa-story-input-layout', name: '剧情输入布局隔离测试', activeChapterId: chapterId,
    sourceDocuments: [{ id: chapterId, name: '第 1 章', content: source, createdAt: now, updatedAt: now }], chapterWorkspaces: {},
    storyDraft: undefined, storyVisualConversions: [], characters: [], locations: [], props: [], scenes: [], assets: [],
    storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
  const state = normalizeState({ ...initial, project, projects: [project], activeProjectId: project.id,
    settings: { ...initial.settings, textApi: { ...initial.settings.textApi, enabled: true, provider: 'openai_compatible',
      baseUrl: `${mockOrigin}/qa-story-layout/v1`, model: 'qa-layout-fixture', apiKey: '' },
      activeTextApiProfileId: null, textApiProfiles: [], apiCredentialBook: [],
      visionApi: { ...initial.settings.visionApi, enabled: false, apiKey: '' },
      imageApi: { ...initial.settings.imageApi, enabled: false, apiKey: '' },
      videoTaskApi: { ...initial.settings.videoTaskApi, enabled: false, apiKey: '' } } });
  const dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
  await fs.writeFile(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic story input layout profile; no production state imported.\n');
  await fs.writeFile(path.join(dataRoot, 'project-state.json'), JSON.stringify(state));
  const bootstrapTemp = path.join(dataRoot, 'portable-bootstrap');
  await fs.mkdir(bootstrapTemp);
  const port = await findAvailableTcpPort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, LIANHUA_DATA_DIR: dataRoot, LIANHUA_QA_MODE: '1', LIANHUA_ALLOW_PRIVATE_NETWORK: '1',
    TEMP: bootstrapTemp, TMP: bootstrapTemp, TMPDIR: bootstrapTemp };
  delete env.ELECTRON_START_URL; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--no-first-run'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  harness = createQaProcessHarness({ electron: child, qaLabel: 'story input layout', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
  async function run() {
    await waitForCondition({ label: 'packaged renderer startup', timeoutMs: 90_000, intervalMs: 100,
      check: async () => { try { return (await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
    browser = await chromium.connectOverCDP(origin);
    const context = browser.contexts()[0];
    assert.ok(context, 'isolated renderer context exists');
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && url.origin !== mockOrigin) {
        report.blockedRequests.push({ method: request.method(), pathname: url.pathname });
        await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = context.pages().find((entry) => entry.url().startsWith('file:'));
    assert.ok(page, 'packaged renderer page exists'); page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.stack || error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const actualRoot = await page.evaluate(async () => (await window.lianhuaDesktop.storagePaths()).dataRoot);
    assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase(), 'desktop reads only the synthetic isolated profile');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.app-shell').waitFor();
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`), 'packaged version matches source version');
    await page.setViewportSize(sizes[0]);
    await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
    const sourceInput = page.locator('.story-source-textarea');
    assert.equal(await sourceInput.inputValue(), source);
    await checkAtSizes('idle');
    const mode = page.getByRole('group', { name: '本章视频创作方式', exact: true });
    await mode.getByRole('button', { name: '图生视频', exact: true }).click();
    await page.locator('.story-reference-panel').waitFor();
    await checkAtSizes('image-idle', { imageMode: true });
    await mode.getByRole('button', { name: '文生视频', exact: true }).click();
    await page.locator('.story-reference-panel').waitFor({ state: 'detached' });
    await page.locator('.story-input-actions').getByRole('button', { name: 'AI画面描述转化', exact: true }).click();
    await waitCount('understanding', 1);
    await page.locator('.story-review-pending').filter({ hasText: '正在理解剧情与动作' }).waitFor();
    await checkAtSizes('busy', { capture: true });
    releases.get(1)();
    const review = page.getByRole('dialog', { name: 'AI 画面描述转化 · 结果审阅', exact: true });
    await review.waitFor(); await waitCount('visualizing', 1);
    await review.getByRole('button', { name: '稍后查看', exact: true }).click();
    await review.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '查看转化结果', exact: true }).waitFor();
    await checkAtSizes('pending');
    // A second held request only checks that both notices coexist in the main
    // input layout. It does not exercise adoption, storage, or rewrite behavior.
    await page.getByRole('button', { name: '查看转化结果', exact: true }).click();
    await review.waitFor(); await review.locator('[data-review-regenerate]').click();
    await waitCount('understanding', 2);
    await review.getByRole('button', { name: '稍后查看', exact: true }).click();
    await review.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.story-input-card .story-review-pending').count(), 2);
    await checkAtSizes('pending-and-busy');
    releases.get(2)(); await waitCount('visualizing', 2);
    await review.waitFor();
    assert.equal(await sourceInput.inputValue(), source, 'layout requests preserve the original draft');
    assert.equal(understandingCount, 2); assert.equal(generationCount, 2);
    assert.deepEqual(report.fixtureErrors, []); assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.blockedRequests, []);
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {});
} finally {
  for (const release of releases.values()) release();
  harness?.markElectronStopping();
  await browser?.close().catch(() => {});
  await harness?.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  if (harness) await fs.writeFile(path.join(output, 'process.log'), harness.readElectronLog());
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ pass: report.pass, version, packagedElectron: true, stages: report.stages,
  requestStages: report.requests.map((request) => request.stage), failure: report.failure?.message,
  report: path.join(output, 'report.json') }, null, 2));
