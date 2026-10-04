import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Direct-button UI only. This fresh browser contains two synthetic projects;
// text generation is locally mocked and never reaches a real service.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'story-buttons-0.5.86'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Story button QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Story button QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const source = '雨夜，韩竹的代号是K-17，林岚的代号是R-9。韩竹握着封好的信，缓缓地走到旧廊桥的木门前。林岚打开木门。林岚：“先看信，再进去。”韩竹：“我会等你。”两人先读信，再走入廊桥，最后一起关上木门。';
const originalDraft = `\n  ${source}\n`;
const otherSource = '河边，信使站在灯塔下，抬头望向远处亮起的灯。';
const optimized = [
  '【场景1：旧廊桥木门外·雨夜】', '出场人物：韩竹（代号K-17）、林岚（代号R-9）',
  '剧情：韩竹握着封好的信，缓步走到旧廊桥木门前。林岚打开木门。两人在门口先读信，再走入廊桥，最后一起关上木门。',
  '对白：', '林岚：“先看信，再进去。”', '韩竹：“我会等你。”',
].join('\n');
const expanded = [
  '雨夜，韩竹的代号是K-17，林岚的代号是R-9。雨水顺着廊桥外侧的木檐落下，门前的地面覆着一层湿亮的水迹。韩竹握着封好的信，缓缓地走到旧廊桥的木门前。他将信封往掌心内侧收了收，用手臂挡住斜飘过来的雨水，直到停在门槛外才重新看向紧闭的门板。信口仍然封着，没有被沿途的水滴浸开。',
  '林岚打开木门。门扇向内退开，她先扶稳门边，确认韩竹站在外侧，再向旁边让出可以进入的空隙。廊桥内外的明暗交界落在门槛上，两人隔着这道边界短暂停住。韩竹没有急着迈步，只把仍然完好的信封举到两人都能看清的位置。',
  '林岚：“先看信，再进去。”韩竹：“我会等你。”他依旧站在原处，将信封放稳后与林岚一起展开信纸。两人的目光依照文字的顺序移动，读过一行才继续看下一行，手指始终压住纸边，免得门口的风把信纸吹动。林岚读完后抬眼看向韩竹，韩竹点头，把信纸按原来的折痕收好。',
  '两人先读信，再走入廊桥，最后一起关上木门。',
].join('\n\n');
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Story buttons isolated UI ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused story preparation buttons QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
let holdNext = '';
let failNext = false;
const pending = new Map();
const requests = [];
const errors = [];
const stages = [];
const screenshots = [];
const waitForRequestCount = (count) => waitForCondition({ label: `mock request ${count}`, timeoutMs: 12_000, intervalMs: 25, check: () => requests.length === count });
const release = async (tag) => {
  const request = pending.get(tag);
  assert.ok(request, `expected held ${tag} request`);
  request.resolve();
  await waitForCondition({ label: `${tag} response released`, timeoutMs: 12_000, intervalMs: 25, check: () => request.finished });
};

const run = async () => {
  await waitForCondition({ label: 'story buttons Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__story_buttons_focused_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__story_buttons_focused_qa__', '1'); }
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push(`Unexpected non-local request: ${route.request().url()}`); await route.abort('blockedbyclient');
  });
  await page.route('**/qa-story-buttons/v1/chat/completions', async (route) => {
    const tag = holdNext; holdNext = '';
    let held;
    try {
      const payload = route.request().postDataJSON();
      const textFor = (role) => payload.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
      const system = textFor('system'); const user = textFor('user');
      const match = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u);
      assert.ok(match, 'direct buttons must retain the existing data envelope');
      const data = JSON.parse(match[1]);
      assert.ok(['optimize', 'expand'].includes(data.mode));
      assert.equal(data.sourceTextOrRequirement, data.mode === 'expand' ? source : originalDraft,
        'optimization keeps the complete editor text while expansion trims only its transport boundary');
      if (data.mode === 'expand') {
        assert.deepEqual(data.existingDialogue, ['先看信，再进去。', '我会等你。']);
      } else {
        assert.equal(Object.prototype.hasOwnProperty.call(data, 'existingDialogue'), false,
          'optimization sends the full source without a local dialogue checklist');
      }
      assert.match(system, /story_preparation_mode_contract/u);
      assert.ok(system.includes(data.mode === 'expand' ? '扩写补全（expand）' : '视频化整理（optimize）'));
      requests.push({ mode: data.mode, hold: tag, sourceCharacters: source.length, targetLength: data.targetLength });
      if (failNext) {
        failNext = false;
        await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA 上游暂时不可用' } }) });
        return;
      }
      if (tag) {
        await new Promise((resolve) => { held = { resolve, finished: false }; pending.set(tag, held); });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: data.mode === 'expand' ? expanded : optimized } }] }) });
    } catch (error) {
      const expectedAbort = tag.startsWith('stale-') && held && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error));
      if (!expectedAbort) errors.push(error instanceof Error ? error.message : String(error));
      if (!expectedAbort) await route.fulfill({ status: 500, body: 'Story button mock rejected its input' }).catch(() => {});
    } finally { if (held) held.finished = true; }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, apiBase, original, other }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const make = (id, name, content) => ({ ...state.project, id, name, sourceDocuments: [{ id: `source-${id}`, name: '隔离测试剧情', content, createdAt: now, updatedAt: now }], scenes: [], storyboards: [], sequencePlans: [], assets: [], characters: [], locations: [], props: [], generationTasks: [], updatedAt: now });
    const a = make('story-buttons-a', '剧情按钮测试A', original); const b = make('story-buttons-b', '剧情按钮测试B', other);
    state.project = a; state.projects = [a, b]; state.activeProjectId = a.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBase, apiKey: '', model: 'qa-story-buttons' };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    for (const name of ['visionApi', 'imageApi', 'videoTaskApi']) state.settings[name].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, apiBase: `${baseUrl}qa-story-buttons/v1`, original: source, other: otherSource });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  const navStory = () => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const optimizeButton = () => page.locator('.story-input-actions').getByRole('button', { name: /^AI\s*剧情优化$/u });
  const expandButton = () => page.locator('.story-input-actions').getByRole('button', { name: /^AI\s*扩写$/u });
  const expansionTarget = () => page.getByRole('spinbutton', { name: 'AI扩写目标字数', exact: true });
  const input = page.locator('.story-source-textarea');
  const storedProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
  const switchProject = async (name) => {
    await page.locator('.top-actions .top-action-library').click();
    await page.getByRole('dialog', { name: '项目库', exact: true }).locator('.project-library-select').filter({ hasText: name }).click();
  };
  await navStory();
  assert.equal(await optimizeButton().count(), 1); assert.equal(await expandButton().count(), 1);
  assert.equal(await expansionTarget().inputValue(), '600', 'AI expansion target defaults to approximately 600 characters');
  assert.equal(await page.getByRole('combobox', { name: 'AI 剧情处理方式', exact: true }).count(), 0);
  assert.equal(await page.locator('.story-input-actions select').count(), 0);
  fs.writeFileSync(path.join(outputDirectory, 'direct-buttons-snapshot.yml'), await page.locator('.story-input-actions').ariaSnapshot());
  await input.fill(originalDraft);
  await page.waitForFunction(({ key, expected }) => JSON.parse(localStorage.getItem(key)).project.storyDraft?.content === expected,
    { key: storageKey, expected: originalDraft });
  const originalProject = await storedProject();
  const optimizeHandle = await optimizeButton().elementHandle(); const expandHandle = await expandButton().elementHandle();
  holdNext = 'busy';
  await optimizeHandle.click(); await waitForRequestCount(1);
  assert.equal(requests[0].mode, 'optimize');
  assert.equal(await optimizeHandle.isDisabled(), true); assert.equal(await expandHandle.isDisabled(), true);
  await expandHandle.evaluate((button) => button.click()); await optimizeHandle.evaluate((button) => { button.click(); button.click(); });
  assert.equal(requests.length, 1, 'busy direct buttons cannot double-submit or switch the running mode');
  await release('busy');
  const optimizationReview = page.getByRole('dialog', { name: 'AI 剧情优化 · 结果审阅', exact: true });
  await optimizationReview.waitFor();
  await optimizationReview.getByRole('button', { name: '采用到编辑区', exact: true }).click();
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, optimized);
  assert.deepEqual(await storedProject(), originalProject, 'optimization remains a reviewable draft, not an automatic save or parse');
  assert.ok(await optimizeButton().isEnabled()); assert.ok(await expandButton().isEnabled());
  await page.locator('.story-input-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'direct-story-buttons-result.png'), fullPage: false }); screenshots.push('direct-story-buttons-result.png');
  await page.getByRole('button', { name: '还原处理前文本', exact: true }).click();
  assert.equal(await input.inputValue(), originalDraft, 'restore includes the exact original boundary whitespace');
  assert.deepEqual(await storedProject(), originalProject);
  stages.push('optimize direct button sends optimize; both buttons disable while pending, no duplicate request; preview and exact restore preserve saved source');
  await expansionTarget().fill('720');
  await expandButton().click(); await waitForRequestCount(2);
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, expanded);
  assert.equal(requests[1].mode, 'expand');
  assert.match(requests[1].targetLength, /约 720 个中文字符/u, 'custom expansion target is sent as an approximate AI hint');
  assert.deepEqual(await storedProject(), originalProject, 'expansion does not adopt or parse its own result');
  assert.ok(await page.getByRole('button', { name: '还原处理前文本', exact: true }).isVisible());
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await page.waitForFunction(({ key, expected }) => JSON.parse(localStorage.getItem(key)).project.sourceDocuments[0].content === expected, { key: storageKey, expected: expanded });
  assert.equal(requests.length, 2, 'explicit saving does not start analysis or generation');
  stages.push('expand direct button sends expand; result is adopted only when the user explicitly saves');

  await input.fill(originalDraft); holdNext = 'stale-text';
  await optimizeButton().click(); await waitForRequestCount(3);
  const edited = `${source}\n手动补充：韩竹整理好信纸后停在门边。`;
  await input.fill(edited); await release('stale-text');
  await optimizeButton().waitFor();
  assert.equal(await input.inputValue(), edited, 'editing source while pending makes the old optimization result stale');
  assert.equal((await storedProject()).sourceDocuments[0].content, expanded, 'a stale response cannot overwrite the last explicitly saved source');
  stages.push('editing source during an in-flight request keeps the newer manual text and discards the stale result');

  await input.fill(originalDraft); holdNext = 'stale-project';
  const pendingExpandHandle = await expandButton().elementHandle(); const optimizeDuringExpandHandle = await optimizeButton().elementHandle();
  await pendingExpandHandle.click(); await waitForRequestCount(4);
  assert.equal(await pendingExpandHandle.isDisabled(), true); assert.equal(await optimizeDuringExpandHandle.isDisabled(), true);
  await optimizeDuringExpandHandle.evaluate((button) => button.click());
  assert.equal(requests.length, 4, 'an active expansion also disables the optimization button without a second request');
  await switchProject('剧情按钮测试B');
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.id === 'story-buttons-b', storageKey);
  await release('stale-project'); await navStory();
  assert.equal(await input.inputValue(), otherSource);
  assert.equal((await storedProject()).sourceDocuments[0].content, otherSource);
  await switchProject('剧情按钮测试A'); await navStory();
  assert.equal(await input.inputValue(), originalDraft, 'switching retains A’s unfinished text, never the late API result');
  assert.ok(await optimizeButton().isEnabled()); assert.ok(await expandButton().isEnabled());
  assert.equal(await page.locator('.story-input-actions select').count(), 0);

  failNext = true;
  await optimizeButton().click();
  await waitForRequestCount(5);
  await page.waitForFunction(() => document.querySelector('.runtime-error-log-count')?.textContent?.trim() === '1');
  assert.equal(await input.inputValue(), originalDraft, 'a failed optimization must preserve the review draft');
  assert.ok(await optimizeButton().isEnabled()); assert.ok(await expandButton().isEnabled());
  await page.locator('.runtime-error-log-trigger').click();
  const errorDialog = page.getByRole('dialog', { name: '报错日志', exact: true });
  await errorDialog.getByText('AI 剧情优化/扩写', { exact: true }).waitFor();
  await errorDialog.getByText(/文本模型请求失败：服务返回了未识别的错误/u).waitFor();
  await errorDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const expectedNetworkErrors = errors.filter((message) => /Failed to load resource.*502/iu.test(message));
  assert.equal(expectedNetworkErrors.length, 1, 'the mocked HTTP 502 should be the only expected browser-console failure');
  errors.splice(0, errors.length, ...errors.filter((message) => !/Failed to load resource.*502/iu.test(message)));
  stages.push('a real optimization failure preserves the draft, re-enables both buttons and stays visible in the runtime error log');

  assert.deepEqual(requests.map((request) => request.mode), ['optimize', 'expand', 'optimize', 'expand', 'optimize']);
  assert.deepEqual(errors, []);
  stages.push('project switch discards old expansion without contaminating B or A; both direct buttons remain usable');
  const report = { mockOnly: true, noProductionDataRead: true, requests, stages, screenshots, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  const notice = page ? await page.locator('.sidebar-notice').textContent().catch(() => '') : '';
  const body = page ? (await page.locator('body').innerText().catch(() => '')).slice(-6500) : '';
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), cause: error?.cause ? String(error.cause) : undefined, requests, stages, notice, body, errors }, null, 2));
  throw error;
} finally {
  for (const item of pending.values()) item.resolve();
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
