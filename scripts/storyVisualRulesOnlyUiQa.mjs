import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A single focused portable pass for AI-owned conversion rules: tolerant
// display/persistence, absent local warnings, and no HTTP compatibility retry.
// Both source data and the HTTP model are synthetic; production data is unused.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const electronOption = process.argv.indexOf('--electron');
assert.ok(electronOption !== -1 && process.argv[electronOption + 1], '--electron requires a packaged executable path');
const executable = path.resolve(process.argv[electronOption + 1]);
await fs.access(executable);
const output = path.join(root, 'output', 'playwright', `story-visual-rules-only-${version}`);
for (const directory of [path.join(root, 'output'), path.join(root, 'output', 'playwright'), output]) {
  const stat = await fs.lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output must not follow symbolic links: ${directory}`);
}
await fs.mkdir(output, { recursive: true });
const report = {
  pass: false, version, packagedElectron: true, model: 'local deterministic rules-only fixture',
  realModelQualityEvaluated: false, noProductionDataRead: true, stages: [], requests: [], screenshots: [],
  pageErrors: [], consoleErrors: [], blockedRequests: [], fixtureErrors: [],
};
const chapterId = 'qa-story-rules-only-chapter';
const source = '少女拾起地上的铜灯，把它放到窗台上，再松开灯柄。';
const punctuationEvidence = source.replaceAll('，', ',');
const inventedEvidence = '模型引用未逐字出现在原文中的句子。';
const firstParagraph = '少女俯身握住铜灯的灯柄，提灯离开地面。她把铜灯移到窗台上，待灯底贴稳台面后松开灯柄。';
const secondParagraph = '铜灯停在窗台上，少女的手离开灯柄。';
const visualBody = `${firstParagraph}\n\n${secondParagraph}`;
const understanding = {
  version: '1', summary: '少女拾起铜灯，放稳在窗台上后松手。',
  events: [
    { id: 'e1', sourceParagraphIds: ['p1'], evidence: punctuationEvidence, actor: '少女', target: '铜灯',
      action: '拾灯并放在窗台上', phases: ['提灯离地', '放稳灯底'], result: '铜灯留在窗台上', uncertainties: [] },
    { id: 'e1', sourceParagraphIds: ['unknown-source'], evidence: inventedEvidence, actor: '少女', target: '灯柄',
      action: '松开灯柄', result: '手离开灯柄', uncertainties: [] },
  ],
};
const generated = {
  paragraphs: [
    { eventIds: ['missing-event', 'e1'], text: firstParagraph,
      stagingAdditions: ['俯身握住灯柄是模型声明的编排补充。'] },
    { id: 'v2', sourceParagraphIds: ['unknown-body-source'], eventIds: ['e1'], text: secondParagraph },
  ],
};
let harness;
let browser;
let page;
let expectedSource = source;
const screenshot = async (name) => {
  const destination = path.join(output, `${name}.png`);
  await page.screenshot({ path: destination, scale: 'css' });
  report.screenshots.push(destination);
};
const mock = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/qa-story-rules-only/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const user = payload.messages.filter((message) => message.role === 'user')
      .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
    const match = user.match(/<story_visual_data>\s*([\s\S]*?)\s*<\/story_visual_data>/u);
    assert.ok(match, 'conversion request retains its structured source envelope');
    const data = JSON.parse(match[1]);
    assert.equal(data.sourceTextOrRequirement, expectedSource, 'each stage receives the full current source');
    report.requests.push({ stage: data.stage, sourceCharacters: expectedSource.length,
      maxTokens: payload.max_tokens ?? payload.max_completion_tokens });
    const requestIndex = report.requests.length;
    if (requestIndex >= 3) {
      assert.equal(data.stage, 'understanding', 'new user operation starts at understanding');
      assert.ok((payload.max_tokens ?? payload.max_completion_tokens) > 8192,
        'the rejection would have triggered the removed smaller-token retry');
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'max_tokens exceeds maximum output token limit 8192; valid range is 1-8192',
        type: 'invalid_request_error', code: 'max_tokens_limit', param: 'max_tokens' } }));
      return;
    }
    assert.equal(data.stage, requestIndex === 1 ? 'understanding' : 'visualizing');
    if (requestIndex === 2) assert.equal(data.actionPlan.events.length, 2, 'metadata differences do not block the body stage');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(requestIndex === 1 ? understanding : generated) } }] }));
  } catch (error) {
    report.fixtureErrors.push(error.stack || error.message);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic rules-only fixture failed' } }));
  }
});
const storedProject = async () => page.evaluate(async () => JSON.parse(await window.lianhuaDesktop.loadState()).project);
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 80,
  check: async () => predicate(await storedProject()) });
const assertNoLocalWarnings = async (review) => {
  if (review) {
    assert.equal(await review.locator('[data-review-tab="warnings"]').count(), 0, 'local warning tab is absent');
    assert.equal(await review.getByRole('tab', { name: /核对|检查|警告/u }).count(), 0, 'no warning tab is relabelled');
    assert.equal(await review.locator('.sr-review-warnings').count(), 0, 'no local warning panel is rendered');
  }
  assert.doesNotMatch(await page.locator('.story-input-card').innerText(), /核对提示|核验提示|\d+\s*项.*(?:核对|核验)/u,
    'main story card has no local warning count');
};
try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const { createInitialState, normalizeState } = await tsImport('../src/storage.ts', import.meta.url);
  const initial = createInitialState();
  const now = Date.now();
  const project = { ...initial.project, id: 'qa-story-rules-only', name: '画面转化源头规则隔离测试', activeChapterId: chapterId,
    sourceDocuments: [{ id: chapterId, name: '铜灯动作', content: source, createdAt: now, updatedAt: now }], chapterWorkspaces: {},
    storyDraft: undefined, storyVisualConversions: [], characters: [], locations: [], props: [], scenes: [], assets: [],
    storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
  const state = normalizeState({ ...initial, project, projects: [project], activeProjectId: project.id,
    settings: { ...initial.settings, textApi: { ...initial.settings.textApi, enabled: true, provider: 'openai_compatible',
      baseUrl: `${mockOrigin}/qa-story-rules-only/v1`, model: 'qa-rules-only-fixture', apiKey: '', maxTokens: 16384 },
      activeTextApiProfileId: null, textApiProfiles: [], apiCredentialBook: [],
      visionApi: { ...initial.settings.visionApi, enabled: false, apiKey: '' },
      imageApi: { ...initial.settings.imageApi, enabled: false, apiKey: '' },
      videoTaskApi: { ...initial.settings.videoTaskApi, enabled: false, apiKey: '' } } });
  const dataRoot = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
  await fs.writeFile(path.join(dataRoot, '.qa-isolated-profile'), 'Synthetic rules-only profile; no production data imported.\n');
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
  harness = createQaProcessHarness({ electron: child, qaLabel: 'story visual rules only', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
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
    assert.equal(path.resolve(actualRoot).toLowerCase(), dataRoot.toLowerCase(), 'desktop loads only the isolated fixture profile');
    await page.reload({ waitUntil: 'networkidle' }); await page.locator('.app-shell').waitFor();
    assert.ok((await page.locator('body').innerText()).includes(`v${version}`), 'packaged version matches current source');
    await page.setViewportSize({ width: 1280, height: 800 });
    const navStory = () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
    await navStory();
    const input = page.locator('.story-source-textarea');
    const convert = page.locator('.story-input-actions').getByRole('button', { name: 'AI画面描述转化', exact: true });
    const review = page.getByRole('dialog', { name: 'AI 画面描述转化 · 结果审阅', exact: true });
    assert.equal(await input.inputValue(), source);
    await convert.click(); await review.waitFor();
    assert.equal(report.requests.length, 2, 'understanding plus body have no repair calls');
    await assertNoLocalWarnings(review);
    await review.locator('[data-review-tab="comparison"]').click();
    assert.equal(await review.getByLabel('处理前原文', { exact: true }).inputValue(), source);
    assert.equal(await review.getByLabel('AI 返回结果', { exact: true }).inputValue(), visualBody, 'readable body survives inconsistent metadata');
    assert.equal(await input.inputValue(), source, 'original draft stays unchanged before adoption');
    await screenshot('returned-body-1280x800');
    await review.getByRole('button', { name: '稍后查看', exact: true }).click(); await review.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '查看转化结果', exact: true }).waitFor();
    await assertNoLocalWarnings();
    await page.getByRole('button', { name: '查看转化结果', exact: true }).click(); await review.waitFor();
    await review.getByRole('button', { name: '采用到编辑区', exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, visualBody);
    await waitStored((current) => current.storyVisualConversions?.length === 1, 'adopted AI metadata persists');
    const adopted = (await storedProject()).storyVisualConversions[0];
    assert.equal(adopted.sourceText, source); assert.equal(adopted.resultText, visualBody);
    assert.equal(adopted.actionPlan.events.length, 2, 'neither imperfect evidence event is discarded');
    assert.deepEqual(adopted.actionPlan.events.map((event) => event.evidence), [punctuationEvidence, inventedEvidence]);
    assert.deepEqual(adopted.actionPlan.events[1].sourceParagraphIds, ['unknown-source']);
    assert.equal(adopted.paragraphs.length, 2, 'body paragraphs remain available despite missing metadata');
    assert.deepEqual(adopted.paragraphs[0].eventIds, ['missing-event', 'e1']);
    assert.deepEqual(adopted.paragraphs[1].sourceParagraphIds, ['unknown-body-source']);
    assert.equal((await storedProject()).sourceDocuments[0].content, source, 'saved source document is preserved');
    await page.reload({ waitUntil: 'networkidle' }); await navStory();
    assert.equal(await input.inputValue(), visualBody, 'adopted body survives desktop reload');
    assert.deepEqual((await storedProject()).storyVisualConversions[0], adopted, 'AI metadata survives actual desktop save/reload');
    await page.getByRole('button', { name: '查看转化来源', exact: true }).click();
    const provenance = page.getByRole('dialog', { name: '画面描述 · 转化来源', exact: true }); await provenance.waitFor();
    assert.equal(await provenance.getByLabel('处理前原文', { exact: true }).inputValue(), source);
    assert.equal(await provenance.getByLabel('AI 返回结果', { exact: true }).inputValue(), visualBody);
    await assertNoLocalWarnings(provenance);
    await provenance.getByRole('button', { name: '关闭', exact: true }).click();
    report.stages.push('metadata differences accepted; no local warning UI; adopted body and AI metadata survive desktop save/reload and source review');

    expectedSource = visualBody;
    await convert.click();
    await waitForCondition({ label: 'one failed user conversion request', timeoutMs: 15_000, intervalMs: 40,
      check: () => report.requests.length >= 3 });
    await convert.waitFor();
    await waitForCondition({ label: 'failed conversion ends without retry', timeoutMs: 15_000, intervalMs: 60,
      check: () => convert.isEnabled() });
    assert.equal(await input.inputValue(), visualBody, 'failed conversion leaves the current draft unchanged');
    assert.equal(await review.count(), 0, 'failed operation creates no result review');
    await page.locator('.runtime-error-log-slot').getByRole('button', { name: /报错日志/u }).click();
    const errorDialog = page.getByRole('dialog', { name: '报错日志', exact: true }); await errorDialog.waitFor();
    const errors = await errorDialog.innerText();
    assert.match(errors, /max_tokens|max_completion_tokens|unsupported_parameter/u, 'actual service error is directly reported');
    assert.doesNotMatch(errors, /未返回可靠的动作事实|逐字原文依据/u, 'service error is not labelled as local fact validation');
    // Observe one quiet window after completion so delayed compatibility retry
    // cannot pass merely because the first error is already visible.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(report.requests.length, 3, 'HTTP400 caused exactly one request and no compatibility/repair retry');
    assert.deepEqual(report.requests.map((request) => request.stage), ['understanding', 'visualizing', 'understanding']);
    assert.deepEqual((await storedProject()).storyVisualConversions[0], adopted, 'failed conversion preserves existing provenance');
    report.stages.push('new user conversion receives HTTP400 max_tokens rejection once; error reported directly and existing draft/provenance preserved');
    assert.deepEqual(report.fixtureErrors, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blockedRequests, []);
    report.expectedErrorConsole = report.consoleErrors.filter((message) => /400|unsupported_parameter|max_tokens|max_completion_tokens/u.test(message));
    assert.deepEqual(report.consoleErrors.filter((message) => !report.expectedErrorConsole.includes(message)), [], 'no unexpected renderer console errors');
    report.pass = true;
  }
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {});
} finally {
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
