import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One targeted production pass. The browser has no desktop bridge or existing
// profile; every non-loopback request and every POST is blocked. All prompts
// are pre-saved synthetic artifacts, so no AI or video call is necessary.
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'playwright', `prompt-result-more-${version}`);
fs.mkdirSync(output, { recursive: true });
const fixtureRun = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/promptResultMoreFixture.ts', '--emit'], {
  cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
assert.equal(fixtureRun.status, 0, fixtureRun.stderr);
const fixture = JSON.parse(fixtureRun.stdout);
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const bootstrap = `import {preview} from 'vite'; await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true}});`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'prompt More and selected TXT production UI QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
const errors = []; const blockedRequests = []; const checks = [];
let browser; let context; let page; let failure;
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-side-panel').waitFor();
};
const install = async (state) => {
  await page.evaluate(({ storageKey, state }) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(storageKey, JSON.stringify(state)); }, { storageKey, state });
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
};
const choose = async (format, language) => {
  await page.getByRole('button', { name: format === 'h3' ? 'MiniMax H3' : format === 'seedance' ? 'Seedance 2.5' : '普通原稿', exact: true }).click();
  await page.getByRole('button', { name: language === 'en' ? 'English' : '中文', exact: true }).click();
  const body = fixture.texts[format][language][0];
  assert.equal(await page.locator('.director-result-copy pre').innerText(), body);
  return body;
};
const more = () => page.getByRole('button', { name: '更多', exact: true });
const menu = () => page.getByRole('menu', { name: '提示词更多操作', exact: true });
const exportTxt = async (tag) => {
  await more().click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu().getByRole('menuitem', { name: '导出全部分段提示词', exact: true }).click(),
  ]);
  assert.ok(download.suggestedFilename().endsWith('.txt'));
  const file = path.join(output, `${tag}.txt`); await download.saveAs(file);
  await menu().waitFor({ state: 'hidden' });
  return fs.readFileSync(file, 'utf8');
};
const auditMenuBounds = async () => {
  const box = await menu().boundingBox(); const viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    'More overlay must fit inside the window');
  const hit = await menu().evaluate((element) => {
    const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + 12, rect.top + 12);
    return Boolean(hit && element.contains(hit));
  });
  assert.equal(hit, true, 'the overlay remains above its parent card and is not clipped');
};

const run = async () => {
  await waitForCondition({ label: 'production preview startup', timeoutMs: 30_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(35_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push({ method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('.sidebar').waitFor();
  await install(fixture.state);
  await page.locator('.director-result-copy pre').waitFor();
  assert.equal(await page.getByRole('button', { name: '导出分段 JSON', exact: true, includeHidden: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '修复对白与排时', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '导出全部分段提示词', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '送到视频导演台', exact: true }).isVisible(), true);
  assert.equal(await more().getAttribute('aria-expanded'), 'false');
  await more().click(); await auditMenuBounds();
  assert.deepEqual(await menu().getByRole('menuitem').allTextContents(), ['修复对白与排时', '导出全部分段提示词']);
  await page.screenshot({ path: path.join(output, 'sequence-more-1280x720.png') });
  await page.keyboard.press('Escape'); await menu().waitFor({ state: 'hidden' });
  assert.equal(await more().evaluate((element) => element === document.activeElement), true, 'ESC restores trigger focus');
  await more().press('ArrowDown');
  await menu().getByRole('menuitem', { name: '修复对白与排时', exact: true }).waitFor();
  assert.equal(await menu().getByRole('menuitem', { name: '修复对白与排时', exact: true }).evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu().getByRole('menuitem', { name: '导出全部分段提示词', exact: true }).evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Home'); await page.keyboard.press('End');
  assert.equal(await menu().getByRole('menuitem', { name: '导出全部分段提示词', exact: true }).evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Tab'); await menu().waitFor({ state: 'hidden' });
  await more().click(); await page.locator('.director-result-head h2').click(); await menu().waitFor({ state: 'hidden' });
  checks.push('JSON export is absent; repair/TXT are in More; persistent Send remains visible; pointer, keyboard, ESC, Tab and outside-click behavior pass at 1280x720');

  for (const format of ['h3', 'seedance', 'ordinary']) for (const language of ['zh', 'en']) {
    const body = await choose(format, language);
    const content = await exportTxt(`${format}-${language}`);
    for (const expected of fixture.texts[format][language]) assert.ok(content.includes(expected), 'TXT preserves the exact selected saved language and format');
    for (const otherFormat of ['h3', 'seedance', 'ordinary']) for (const otherLanguage of ['zh', 'en']) {
      if (otherFormat === format && otherLanguage === language) continue;
      for (const wrong of fixture.texts[otherFormat][otherLanguage]) assert.ok(!content.includes(wrong), 'TXT cannot include another selected format or language');
    }
    await page.getByRole('button', { name: '送到视频导演台', exact: true }).click();
    assert.equal(await page.getByLabel('本次生成使用的完整提示词', { exact: true }).inputValue(), body);
    assert.equal(await page.getByLabel('本次提示词格式', { exact: true }).inputValue(), format);
    assert.equal(await page.getByLabel('本次稿件语言', { exact: true }).inputValue(), language);
    await enterDirector();
  }
  checks.push('all six format/language combinations export exact TXT bodies and Send retains the current selection in the actual video editor');
  const persistedAfterSelections = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), storageKey);
  for (const saved of fixture.state.project.storyboards.filter((board) => board.segmentId)) {
    const current = persistedAfterSelections.project.storyboards.find((board) => board.id === saved.id);
    for (const field of ['finalPrompt', 'englishPrompt', 'officialPromptZh', 'officialPromptEn', 'officialPromptSource', 'seedance25Output'])
      assert.deepEqual(current[field], saved[field], `UI navigation/export preserves saved ${field}`);
  }

  const missing = structuredClone(fixture.state);
  delete missing.project.storyboards[1].seedance25Output.promptEn; delete missing.project.storyboards[1].seedance25Output.englishSourceFingerprint;
  missing.projects = [missing.project]; await install(missing); await choose('seedance', 'en');
  const missingText = await exportTxt('seedance-en-missing-second');
  assert.ok(missingText.includes(fixture.texts.seedance.en[0]));
  assert.ok(missingText.includes('可用 1 段 · 待生成／待更新 1 段'));
  assert.ok(missingText.includes('=== 第 2 段：山道第2段 ==='));
  for (const format of ['h3', 'seedance', 'ordinary']) for (const language of ['zh', 'en'])
    assert.ok(!missingText.includes(fixture.texts[format][language][1]), 'a missing English artifact cannot borrow another body');
  checks.push('missing second Seedance English remains in the downloaded list as pending, with no fallback or model call');

  const single = structuredClone(fixture.state); single.project.sequencePlans = [];
  single.project.storyboards = [single.project.storyboards[0]];
  for (const field of ['sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount']) delete single.project.storyboards[0][field];
  single.project.scenes[0].storyboardIds = [single.project.storyboards[0].id]; single.projects = [single.project];
  await install(single); await more().click(); await auditMenuBounds();
  assert.deepEqual(await menu().getByRole('menuitem').allTextContents(), ['修复对白与排时'], 'single results keep repair without a whole-plan export action');
  await page.screenshot({ path: path.join(output, 'single-more-1280x720.png') });
  await page.keyboard.press('Escape');
  const persisted = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), storageKey);
  assert.equal(persisted.project.generationTasks.length, 0, 'the QA never creates a generation task');
  assert.deepEqual(blockedRequests, [], 'menu/export/source navigation do not attempt model or external requests');
  assert.deepEqual(errors, [], `production browser errors: ${errors.join('; ')}`);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, version, productionPreview: true, isolatedBrowserStorage: true,
    textCalls: 0, realVideoRequests: 0, createdTasks: 0, checks, blockedRequests, errors }, null, 2));
  console.log(`Prompt More production UI checks passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks, blockedRequests, errors }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); }
if (failure) throw failure;
