import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Isolated browser storage and local mock AI only; no desktop user data is read.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'story-reference-entry'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = 'http://127.0.0.1:' + port + '/';
const bootstrap = 'import {createServer} from "vite"; const server=await createServer({server:{host:"127.0.0.1",port:' + port + ',strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log("Story reference isolated UI ready");';
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused story reference entry QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let releaseSecond;
const requests = []; const stages = []; const errors = [];
const analysisFor = (index) => ({
  description: index === 1 ? '银发旅人站在石桥上，身旁放着旧铜灯。桥后山谷覆着薄雾。' : '黑发旅人坐在木桌旁，手里拿着一封信。窗外可见细雨。',
  characters: [{ id: 'character-1', label: index === 1 ? '银发旅人' : '黑发旅人', description: '人物外貌与衣着已完整识别。', fields: { 发色: index === 1 ? '银色' : '黑色', 服装: '蓝色旅行外套', 朝向: '面向画面左侧' } }],
  locations: [{ id: 'location-1', label: index === 1 ? '石桥' : '书房', description: '完整的空间布局与背景细节。', fields: { 材质: '木石材质' } }],
  props: [{ id: 'prop-1', label: index === 1 ? '铜灯' : '信封', description: '道具的形状、颜色与材质。', fields: { 状态: '完整' } }],
  events: ['人物正在等待'], relationships: ['人物位于前景，背景位于后方'], readableText: ['桥边标牌：归途'], uncertainties: ['无法仅凭图像确认人物真实姓名'],
  style: '水彩插画', composition: '单人中景', lighting: '柔和侧光', colors: '蓝绿色', extraDetail: { 保留完整信息: '边缘远处有第二座石桥' },
});
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 12_000, intervalMs: 80, check: async () => predicate(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey)) });

const run = async () => {
  await waitForCondition({ label: 'Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push('Unexpected remote request: ' + route.request().url()); await route.abort('blockedbyclient'); });
  await page.route('**/qa-story-reference/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON();
    const images = payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
    requests.push({ imageCount: images.length, model: payload.model });
    assert.equal(images.length, 1, 'each recognition must send exactly one actual image');
    assert.match(images[0].image_url.url, /^data:image\/png;base64,/u);
    const index = requests.length;
    if (index === 2) await new Promise((resolve) => { releaseSecond = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysisFor(index === 1 || index === 3 ? 1 : 2)) } }] }) });
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, api }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const sourceDocuments = ['a', 'b'].map((id) => ({ id: 'chapter-' + id, name: id === 'a' ? '第一章' : '第二章', content: id === 'a' ? '我和图1的人物相遇。' : '第二章正文。', createdAt: now, updatedAt: now }));
    const project = { ...state.project, id: 'story-reference-ui-qa', name: '参考图入口隔离测试', sourceDocuments, activeChapterId: 'chapter-a', chapterWorkspaces: {}, storyDraft: undefined, characters: [], locations: [], props: [], scenes: [], assets: [], storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.visionApi = { ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible', baseUrl: api, model: 'qa-whole-image', apiKey: '' };
    state.settings.activeVisionApiProfileId = null; state.settings.visionApiProfiles = [];
    state.settings.textApi.enabled = false; state.settings.imageApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, api: baseUrl + 'qa-story-reference/v1' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const mode = page.getByRole('group', { name: '本章视频创作方式' });
  assert.equal(await mode.getByRole('button', { name: '文生视频', exact: true }).getAttribute('aria-pressed'), 'true');
  const story = page.locator('.story-source-textarea');
  await mode.getByRole('button', { name: '图生视频', exact: true }).click();
  assert.equal(await story.inputValue(), '我和图1的人物相遇。');
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eabed7'; ctx.fillRect(0, 0, 128, 128); ctx.fillStyle = '#448b88'; ctx.fillRect(20, 20, 64, 88);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const upload = page.getByLabel('上传参考图片，一次一张');
  assert.equal(await upload.getAttribute('multiple'), null);
  await upload.setInputFiles({ name: '第一张.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
  await page.getByRole('article', { name: '图1参考图' }).waitFor();
  await upload.setInputFiles({ name: '第二张.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
  const first = page.getByRole('article', { name: '图1参考图' }); const second = page.getByRole('article', { name: '图2参考图' });
  await second.waitFor();
  await waitStored((project) => project.assets.length === 2 && project.chapterWorkspaces['chapter-a'].storyReferences.length === 2, 'uploads persisted in assets and chapter');
  await first.getByRole('button', { name: 'AI 识图', exact: true }).click();
  await first.getByText('已识别', { exact: true }).waitFor();
  await second.getByRole('button', { name: 'AI 识图', exact: true }).click();
  await second.getByRole('button', { name: '识别中…', exact: true }).waitFor();
  assert.ok(await first.getByRole('button', { name: '查看与修改', exact: true }).isEnabled());
  await first.getByRole('button', { name: '银发旅人', exact: true }).click();
  assert.match(await story.inputValue(), /图1·银发旅人/u);
  await page.getByRole('combobox', { name: '当前章节', exact: true }).selectOption('chapter-b');
  assert.equal(await story.inputValue(), '第二章正文。');
  assert.equal(await page.locator('.story-reference-panel').count(), 0);
  await waitForCondition({ label: 'held second vision request', timeoutMs: 10_000, intervalMs: 50, check: () => Boolean(releaseSecond) });
  releaseSecond(); releaseSecond = undefined;
  await waitStored((project) => project.chapterWorkspaces['chapter-a'].storyReferences[1].status === 'ready', 'background recognition writes to original chapter');
  await page.getByRole('combobox', { name: '当前章节', exact: true }).selectOption('chapter-a');
  await second.getByText('已识别', { exact: true }).waitFor();
  stages.push('single uploads enter asset library; single-image recognition keeps other cards usable and returns to its owning chapter');

  await first.getByRole('button', { name: '查看与修改', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '图1 · 参考资料', exact: true });
  await dialog.getByLabel('补充与纠正说明').fill('铜灯只参考外观，本章让它熄灭。');
  await dialog.getByLabel('修订完整画面描述').fill('银发旅人在石桥旁等待，外套为深蓝色。');
  await dialog.getByRole('button', { name: '主体与身份', exact: true }).click();
  await dialog.getByRole('textbox', { name: '银发旅人剧情名称', exact: true }).fill('小雨');
  await dialog.getByRole('button', { name: '保存资料与绑定', exact: true }).click();
  await waitStored((project) => project.chapterWorkspaces['chapter-a'].storyReferences[0].notes === '铜灯只参考外观，本章让它熄灭。', 'manual notes saved');
  await first.getByRole('button', { name: '小雨', exact: true }).waitFor();
  await second.getByRole('button', { name: '查看与修改', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '图2 · 参考资料', exact: true });
  await dialog.getByRole('button', { name: '主体与身份', exact: true }).click();
  await dialog.getByRole('combobox', { name: '黑发旅人关联资料', exact: true }).selectOption({ label: '图1·小雨' });
  await dialog.getByRole('button', { name: '保存资料与绑定', exact: true }).click();
  await second.getByRole('button', { name: '小雨', exact: true }).waitFor();
  await page.getByRole('button', { name: '设置“我”', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '剧情中的“我”', exact: true });
  await dialog.getByRole('combobox', { name: '我对应的角色', exact: true }).selectOption({ label: '图1·小雨' });
  await dialog.getByRole('button', { name: '保存“我”的设定', exact: true }).click();
  await waitStored((project) => project.chapterWorkspaces['chapter-a'].storyReferences[0].subjectBindings.some((binding) => binding.isNarrator), 'first person image binding saved');
  await first.getByRole('button', { name: '重新识别', exact: true }).click();
  await first.getByText('已识别', { exact: true }).waitFor();
  await waitStored((project) => project.chapterWorkspaces['chapter-a'].storyReferences[0].analysisHistory?.length > 0, 'recognition history saved');
  await first.getByRole('button', { name: '查看与修改', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '图1 · 参考资料', exact: true });
  assert.equal(await dialog.getByLabel('补充与纠正说明').inputValue(), '铜灯只参考外观，本章让它熄灭。');
  await dialog.getByRole('button', { name: '查看图片', exact: true }).click();
  await dialog.getByRole('button', { name: '放大图片', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(outputDirectory, 'image-preview.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('complete recognition, corrections, cross-image identity, first person binding, history and image preview remain accessible');

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(outputDirectory, 'entry-' + viewport.width + 'x' + viewport.height + '.png') });
    const metrics = await page.evaluate(() => {
      const story = document.querySelector('.story-source-textarea'); const footer = document.querySelector('.story-input-footer');
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, storyHeight: story.getBoundingClientRect().height, footerHeight: footer.getBoundingClientRect().height };
    });
    assert.ok(metrics.width <= metrics.viewport + 2, 'page must not overflow horizontally');
    assert.ok(metrics.storyHeight >= 64 && metrics.footerHeight > 0, 'story textarea and existing actions retain usable height');
  }
  await first.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('button', { name: '从资产库添加', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '从资产库选择参考图', exact: true });
  await picker.locator('.reference-image-picker-item').filter({ hasText: '第一张.png' }).click();
  await picker.getByRole('button', { name: '使用所选图片', exact: true }).click();
  await page.getByRole('article', { name: '图3参考图', exact: true }).waitFor();
  await waitStored((project) => project.assets.length === 2 && project.chapterWorkspaces['chapter-a'].storyReferences.map((reference) => reference.number).join(',') === '2,3', 'removal preserves assets and stable non-reused numbers');
  const originalDraft = await story.inputValue();
  await mode.getByRole('button', { name: '文生视频', exact: true }).click();
  assert.equal(await story.inputValue(), originalDraft);
  await mode.getByRole('button', { name: '图生视频', exact: true }).click();
  await waitStored((project) => project.chapterWorkspaces['chapter-a'].storyInputMode === 'image', 'image mode saved');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.getByRole('article', { name: '图3参考图', exact: true }).waitFor();
  assert.equal(await story.inputValue(), originalDraft);
  stages.push('compact layouts, asset reuse, stable image numbers, mode switching and reload preserve chapter state');
  assert.equal(requests.length, 3); assert.deepEqual(errors, []);
  const report = { mockOnly: true, noProductionDataRead: true, requests, stages, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), requests, stages, errors, body: await page?.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally {
  releaseSecond?.(); await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
