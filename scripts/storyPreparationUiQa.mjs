import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'video-ready-story-0.5.79'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error('Story preparation QA output must be a child of output/playwright');
}
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse a directory link');
}
fs.mkdirSync(outputDirectory, { recursive: true });

const source = '雨夜，韩竹的代号是K-17，林岚的代号是R-9。韩竹握着封好的信，缓缓地走到旧廊桥的木门前。林岚打开木门。林岚：“先看信，再进去。”韩竹：“我会等你。”两人先读信，再走入廊桥，最后一起关上木门。';
const originalDraft = `\n  ${source}\n`;
const optimized = [
  '【场景1：旧廊桥木门外·雨夜】',
  '出场人物：韩竹（代号K-17）、林岚（代号R-9）',
  '剧情：韩竹握着封好的信，缓步走到旧廊桥木门前。林岚打开木门。两人在门口先读信，再走入廊桥，最后一起关上木门。',
  '对白：',
  '林岚：“先看信，再进去。”',
  '韩竹：“我会等你。”',
].join('\n');
const expanded = [
  '雨夜，韩竹的代号是K-17，林岚的代号是R-9。雨水顺着廊桥外侧的木檐落下，门前的地面覆着一层湿亮的水迹。韩竹握着封好的信，缓缓地走到旧廊桥的木门前。他将信封往掌心内侧收了收，用手臂挡住斜飘过来的雨水，直到停在门槛外才重新看向紧闭的门板。信口仍然封着，没有被沿途的水滴浸开。',
  '林岚打开木门。门扇向内退开，她先扶稳门边，确认韩竹站在外侧，再向旁边让出可以进入的空隙。廊桥内外的明暗交界落在门槛上，两人隔着这道边界短暂停住。韩竹没有急着迈步，只把仍然完好的信封举到两人都能看清的位置。',
  '林岚：“先看信，再进去。”韩竹：“我会等你。”他依旧站在原处，将信封放稳后与林岚一起展开信纸。两人的目光依照文字的顺序移动，读过一行才继续看下一行，手指始终压住纸边，免得门口的风把信纸吹动。林岚读完后抬眼看向韩竹，韩竹点头，把信纸按原来的折痕收好。',
  '两人先读信，再走入廊桥，最后一起关上木门。',
].join('\n\n');
assert.notEqual(optimized, source);
assert.ok(expanded.length > source.length + 80);

const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused story preparation UI QA', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const requests = [];
const errors = [];

const run = async () => {
  await waitForCondition({ label: 'focused story preparation Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => {
      try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__story_preparation_focused_qa__')) {
      localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__story_preparation_focused_qa__', '1');
    }
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push('Unexpected non-local request'); await route.abort('blockedbyclient');
  });
  await page.route('**/qa-story-preparation/v1/chat/completions', async (route) => {
    try {
      const payload = route.request().postDataJSON();
      const textFor = (role) => payload.messages.filter((message) => message.role === role).map((message) => message.content).join('\n');
      const system = textFor('system');
      const user = textFor('user');
      const match = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u);
      assert.ok(match, 'request must use the existing story input envelope');
      const data = JSON.parse(match[1]);
      assert.ok(['optimize', 'expand'].includes(data.mode));
      assert.equal(data.sourceTextOrRequirement, source);
      assert.match(system, /story_preparation_mode_contract/u);
      assert.ok(system.includes(data.mode === 'optimize' ? '当前模式：视频化整理（optimize）' : '当前模式：扩写补全（expand）'));
      assert.deepEqual(data.existingDialogue, ['先看信，再进去。', '我会等你。']);
      requests.push({ mode: data.mode, sourceCharacters: data.sourceTextOrRequirement.length, dialogueCount: data.existingDialogue.length });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: data.mode === 'optimize' ? optimized : expanded } }] }) });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      await route.fulfill({ status: 500, body: 'Focused story preparation mock rejected its input' });
    }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, apiBase }) => {
    const state = JSON.parse(localStorage.getItem(key));
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBase, apiKey: '', model: 'qa-story-preparation' };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    for (const kind of ['visionApi', 'imageApi', 'videoTaskApi']) state.settings[kind].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, apiBase: `${baseUrl}qa-story-preparation/v1` });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  await page.getByRole('button', { name: '剧情解析', exact: true }).click();
  const input = page.locator('.story-source-textarea');
  const mode = page.getByRole('combobox', { name: 'AI 剧情处理方式', exact: true });
  const processButton = page.getByRole('button', { name: 'AI 剧情优化', exact: true });
  assert.equal(await mode.inputValue(), 'optimize');
  assert.deepEqual(await mode.locator('option').allTextContents(), ['视频化整理', '扩写补全']);
  assert.equal(await page.getByRole('button', { name: 'AI 扩写', exact: true }).count(), 0);
  const savedProject = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
  const unchanged = async (stage) => {
    await page.waitForTimeout(350);
    const actual = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
    assert.deepEqual(actual, savedProject, `${stage} must not save or parse the project automatically`);
  };

  await input.fill(originalDraft);
  await processButton.click();
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, optimized);
  const optimizedDraft = await input.inputValue();
  assert.notEqual(optimizedDraft, source, 'optimization must convert the novel into a scene draft, not return prose unchanged');
  assert.match(optimizedDraft, /^【场景1：旧廊桥木门外·雨夜】\n出场人物：韩竹（代号K-17）、林岚（代号R-9）\n剧情：[^\n]+\n对白：\n林岚：“先看信，再进去。”\n韩竹：“我会等你。”$/u);
  await unchanged('optimization');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  const screenshot = 'video-ready-story-focused-1280x800.png';
  await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
  await page.getByRole('button', { name: '还原处理前文本', exact: true }).click();
  assert.equal(await input.inputValue(), originalDraft, 'restore must preserve the exact draft including boundary whitespace');
  await unchanged('restore');

  await mode.selectOption('expand');
  await processButton.click();
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea')?.value === expected, expanded);
  await unchanged('expansion');
  assert.deepEqual(requests.map((request) => request.mode), ['optimize', 'expand']);
  assert.ok(await page.getByRole('button', { name: '还原处理前文本', exact: true }).isVisible());
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  const report = { viewport: { width: 1280, height: 800 }, requests, defaultMode: 'optimize', optimizedCharacters: optimized.length,
    originalCharacters: source.length, expandedCharacters: expanded.length, structuredSceneDraftAccepted: true,
    resultDifferentFromNovel: true, originalCharactersCodesAndDialoguePreserved: true,
    exactDraftRestored: true, savedProjectUnchanged: true, mockOnly: true, errors, screenshot };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  const notice = page ? await page.locator('.sidebar-notice').textContent().catch(() => '') : '';
  throw new Error(`Focused story preparation UI failed: ${JSON.stringify({ requests, errors, notice })}`, { cause: error });
} finally {
  await context?.close();
  await browser?.close();
  harness.markElectronStopping();
  await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
