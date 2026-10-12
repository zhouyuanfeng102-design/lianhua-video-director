import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Fresh browser storage, generated image fixtures and one successful mock model
// response. The second request is held only to exercise cancellation.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'comic-story'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'comic-chapter';
const port = await findAvailableTcpPort();
const baseUrl = 'http://127.0.0.1:' + port + '/';
const bootstrap = 'import {createServer} from "vite"; const server=await createServer({server:{host:"127.0.0.1",port:' + port + ',strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log("Comic story isolated UI ready");';
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused comic story QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let releaseHeld;
const requests = []; const stages = []; const errors = [];
const originalStory = '阿林将铜灯递向北辰，说：“请拿好。”北辰接住铜灯，回答：“谢谢。”铜灯稳稳握在北辰手中。';
const editedStory = originalStory + '\n北辰抬头看向石桥对岸。';
const subjects = [
  { id: 'character-alin', label: '阿林', description: '银发旅人，蓝色外套。', fields: { 发色: '银色' } },
  { id: 'character-north', label: '北辰', description: '黑发旅人，棕色披肩。', fields: { 发色: '黑色' } },
];
const panel = (id, order, { speakerId, text, chineseText, phase, action, result, type = 'dialogue' }) => ({
  id, order, bounds: { x: 0, y: 0, width: 0.5, height: 0.25 },
  description: '两位旅人在石桥上交接铜灯。', characterIds: subjects.map((subject) => subject.id),
  texts: [{ id: id + '-text', type, text, language: 'ja', ...(speakerId ? { speakerId } : {}), ...(chineseText ? { chineseText } : {}) }],
  actions: [{ id: id + '-action', eventId: 'event-lamp-handoff', actorId: 'character-alin', targetId: 'character-north', phase, action, result }],
  entryState: '阿林握着灯柄，北辰伸手。', exitState: '铜灯朝北辰手中移动。', uncertainties: order === 2 ? ['背景招牌文字无法确认'] : [],
});
const analysisFor = (number) => ({
  description: '阿林和北辰在石桥上交接铜灯，分格保留同一事件的连续阶段。',
  characters: subjects, locations: [{ id: 'location-bridge', label: '石桥', description: '横跨山溪的石桥。', fields: {} }],
  props: [{ id: 'prop-lamp', label: '铜灯', description: '古铜提灯。', fields: {} }],
  events: ['铜灯交接'], relationships: ['阿林位于左侧，北辰位于右侧'], readableText: ['どうぞ', 'ありがとう'], uncertainties: [],
  style: '彩色漫画', composition: '分格画面', lighting: '阴天漫射光', colors: '蓝绿与铜色',
  comic: { panels: number === 1 ? [
    panel('page-1-panel-1', 1, { speakerId: 'character-alin', text: 'どうぞ', chineseText: '请拿好。', phase: '递出', action: '阿林递出铜灯', result: '北辰伸手接灯' }),
    panel('page-1-panel-2', 2, { type: 'sfx', text: 'カチャ', phase: '接触', action: '北辰的手接触灯柄', result: '灯柄发出轻响' }),
  ] : [panel('page-2-panel-1', 1, { speakerId: 'character-north', text: 'ありがとう', chineseText: '谢谢。', phase: '完成', action: '北辰接稳铜灯', result: '铜灯转到北辰手中' })], uncertainties: [] },
});
const storedProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 80, check: async () => predicate(await storedProject()) });

const run = async () => {
  await waitForCondition({ label: 'Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push('Unexpected remote request: ' + route.request().url()); await route.abort('blockedbyclient'); });
  await page.route('**/qa-comic/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON();
    const user = payload.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
    const match = user.match(/<comic_source_data>\s*([\s\S]*?)\s*<\/comic_source_data>/u);
    assert.ok(match, 'the one recognition call contains the joint comic mapping');
    const data = JSON.parse(match[1]);
    const pages = data.images.filter((image) => image.role === 'comic');
    const images = payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
    assert.equal(images.length, 2, 'both original pages travel in one model call');
    assert.deepEqual(pages.map((item) => item.number), [2, 1], 'page order is independent of permanent image numbers');
    assert.equal(data.comicSettings.dialogueMode, 'chinese');
    requests.push({ imageCount: images.length, numbers: pages.map((item) => item.number), settings: data.comicSettings });
    const ordinal = requests.length;
    if (ordinal === 2) await new Promise((resolve) => { releaseHeld = resolve; });
    const response = { pages: pages.map((item) => ({ referenceId: item.referenceId, analysis: analysisFor(item.number) })), storyText: ordinal === 2 ? '取消之后的迟到结果不应覆盖当前剧情。' : originalStory };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) }).catch((error) => { if (ordinal !== 2) throw error; });
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, api, chapterId }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const project = { ...state.project, id: 'comic-story-ui-qa', name: '漫画剧情隔离测试', sourceDocuments: [{ id: chapterId, name: '漫画章节', content: '原来的剧情正文。', createdAt: now, updatedAt: now }, { id: 'chapter-b', name: '第二章', content: '第二章保持原文。', createdAt: now, updatedAt: now }], activeChapterId: chapterId, chapterWorkspaces: {}, storyDraft: undefined, characters: [], locations: [], props: [], scenes: [], assets: [], storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.visionApi = { ...state.settings.visionApi, enabled: true, vision: true, provider: 'openai_compatible', baseUrl: api, model: 'qa-comic-joint', apiKey: '' };
    state.settings.activeVisionApiProfileId = null; state.settings.visionApiProfiles = [];
    state.settings.textApi.enabled = false; state.settings.imageApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, api: baseUrl + 'qa-comic/v1', chapterId });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.getByRole('group', { name: '本章视频创作方式' }).getByRole('button', { name: '图生视频', exact: true }).click();
  assert.equal(await page.getByLabel('上传参考图片，一次一张').getAttribute('multiple'), null);
  assert.ok(await page.getByRole('button', { name: '上传一张图片', exact: true }).isEnabled());
  await page.getByRole('group', { name: '图生视频来源' }).getByRole('button', { name: '漫画生视频', exact: true }).click();
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eabed7'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#448b88'; ctx.fillRect(0, 0, 160, 60);
    return { png: canvas.toDataURL('image/png').split(',')[1], jpg: canvas.toDataURL('image/jpeg').split(',')[1] };
  });
  const upload = page.getByLabel('上传漫画图片，可多选PNG或JPG');
  assert.notEqual(await upload.getAttribute('multiple'), null);
  await upload.setInputFiles([{ name: '漫画第1页.png', mimeType: 'image/png', buffer: Buffer.from(imageData.png, 'base64') }, { name: '漫画第2页.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imageData.jpg, 'base64') }]);
  const first = page.getByRole('article', { name: '图1参考图', exact: true });
  const second = page.getByRole('article', { name: '图2参考图', exact: true });
  await second.waitFor();
  await waitStored((project) => project.assets.length === 2 && project.chapterWorkspaces[chapterId]?.storyReferences?.length === 2, 'multi uploads saved sequentially');
  let saved = await storedProject();
  assert.deepEqual(saved.chapterWorkspaces[chapterId].storyReferences.map((reference) => reference.sourceRole), ['comic', 'comic']);
  assert.deepEqual(saved.chapterWorkspaces[chapterId].storyReferences.map((reference) => saved.assets.find((asset) => asset.id === reference.assetId).name), ['漫画第1页.png', '漫画第2页.jpg']);
  assert.equal(await first.getByRole('button', { name: 'AI 识图', exact: true }).count(), 0);
  await first.getByRole('button', { name: '图1漫画页下移', exact: true }).click();
  await waitStored((project) => project.chapterWorkspaces[chapterId].storyReferences.find((reference) => reference.number === 1).pageOrder === 2, 'page order saved without renumbering');
  assert.match(await first.innerText(), /第 2 页 · 图1/u); assert.match(await second.innerText(), /第 1 页 · 图2/u);
  await page.getByLabel('漫画对白语言').selectOption('chinese');
  await page.getByRole('button', { name: '识别漫画并生成剧情', exact: true }).click();
  await page.getByLabel('编辑漫画剧情预览').waitFor();
  await waitStored((project) => project.chapterWorkspaces[chapterId].comicStoryDraft?.storyText === originalStory, 'joint recognition and draft saved');
  assert.equal(requests.length, 1);
  saved = await storedProject();
  const pageEvidence = saved.chapterWorkspaces[chapterId].storyReferences;
  assert.equal(pageEvidence.flatMap((reference) => reference.analysis.comic.panels).length, 3);
  assert.equal(new Set(pageEvidence.flatMap((reference) => reference.analysis.comic.panels.flatMap((panel) => panel.actions.map((action) => action.eventId)))).size, 1);
  stages.push('ordinary reference entry remains available; PNG/JPG multi uploads retain selected order; page reorder preserves image labels; one multi image request saves two pages and three panels');

  const adopt = page.getByRole('button', { name: '采用为本章剧情', exact: true });
  assert.ok(await adopt.isEnabled());
  await page.getByLabel('漫画阅读方向').selectOption('ltr');
  await page.getByText('漫画来源、页序、阅读设置或资料已更改。请重新生成剧情后再采用。', { exact: true }).waitFor();
  assert.ok(await adopt.isDisabled());
  await page.getByLabel('漫画阅读方向').selectOption('rtl');
  await page.getByLabel('编辑漫画剧情预览').fill(editedStory);
  await adopt.click();
  assert.equal(await page.locator('.story-source-textarea').inputValue(), editedStory);
  await waitStored((project) => project.chapterWorkspaces[chapterId].comicStoryDraft?.adoptedAt && project.chapterWorkspaces[chapterId].storyDraft?.content === editedStory, 'edited adopted story persisted');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  await page.getByLabel('编辑漫画剧情预览').waitFor();
  assert.equal(await page.getByLabel('编辑漫画剧情预览').inputValue(), editedStory);
  assert.equal(await page.locator('.story-source-textarea').inputValue(), editedStory);
  stages.push('changed settings disable stale adoption; edited adopted story and source mode survive reload');

  await first.getByRole('button', { name: '查看图格与资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '图1 · 参考资料', exact: true });
  assert.match(await dialog.innerText(), /对白 · 阿林/u);
  assert.match(await dialog.innerText(), /原文：どうぞ/u);
  assert.match(await dialog.innerText(), /中文对照：请拿好。/u);
  assert.match(await dialog.innerText(), /拟声/u);
  assert.match(await dialog.innerText(), /背景招牌文字无法确认/u);
  await dialog.getByRole('button', { name: '裁出本格作为视频参考', exact: true }).first().click();
  await waitStored((project) => project.assets.some((asset) => asset.comicPanelSource?.panelId === 'page-1-panel-1'), 'original-pixel crop saved separately');
  saved = await storedProject();
  const cropped = saved.assets.find((asset) => asset.comicPanelSource?.panelId === 'page-1-panel-1');
  assert.equal(cropped.width, 160); assert.equal(cropped.height, 60);
  const dimensions = await page.evaluate(async (src) => { const image = new Image(); image.src = src; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, cropped.dataUrl);
  assert.deepEqual(dimensions, { width: 160, height: 60 });
  assert.equal(saved.chapterWorkspaces[chapterId].storyReferences.filter((reference) => reference.sourceRole === 'comic').length, 2);
  await page.screenshot({ path: path.join(outputDirectory, 'comic-panel-evidence.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
  stages.push('panel view retains original and Chinese dialogue, speaker, sound effect and uncertainty; 160x60 crop preserves both original pages');

  const draftBeforeCancel = JSON.stringify((await storedProject()).chapterWorkspaces[chapterId].comicStoryDraft);
  await page.getByRole('button', { name: '识别漫画并生成剧情', exact: true }).click();
  await waitForCondition({ label: 'held cancellation request', timeoutMs: 15_000, intervalMs: 50, check: () => Boolean(releaseHeld) });
  assert.ok(await page.getByLabel('漫画阅读方向').isDisabled());
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await page.getByRole('button', { name: '识别漫画并生成剧情', exact: true }).waitFor();
  releaseHeld(); releaseHeld = undefined;
  await waitStored((project) => project.chapterWorkspaces[chapterId].storyReferences.every((reference) => reference.status !== 'recognizing'), 'cancel clears in progress state');
  await page.waitForTimeout(250);
  assert.equal(JSON.stringify((await storedProject()).chapterWorkspaces[chapterId].comicStoryDraft), draftBeforeCancel);
  assert.equal(await page.locator('.story-source-textarea').inputValue(), editedStory);
  assert.equal(requests.length, 2); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(outputDirectory, 'comic-entry.png') });
  stages.push('generation locks source edits; cancellation and late response preserve the prior edited draft and adopted chapter story');

  const assetsBeforeSwitch = (await storedProject()).assets.length;
  await page.evaluate(() => {
    const originalRead = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {
      if (file.name?.startsWith('切章')) {
        window.__comicUploadReadStarted = true;
        setTimeout(() => originalRead.call(this, file), 400);
        return;
      }
      return originalRead.call(this, file);
    };
  });
  await upload.setInputFiles([1, 2].map((number) => ({ name: '切章第' + number + '页.png', mimeType: 'image/png', buffer: Buffer.from(imageData.png, 'base64') })));
  await page.waitForFunction(() => window.__comicUploadReadStarted === true);
  await page.getByRole('combobox', { name: '当前章节', exact: true }).selectOption('chapter-b');
  await waitStored((project) => project.activeChapterId === 'chapter-b', 'switch to other chapter while upload awaits original pixels');
  await page.waitForTimeout(650);
  saved = await storedProject();
  assert.equal(saved.assets.length, assetsBeforeSwitch);
  assert.equal(saved.chapterWorkspaces['chapter-b']?.storyReferences?.length || 0, 0);
  assert.equal(saved.chapterWorkspaces[chapterId].storyReferences.length, 2);
  stages.push('chapter switch cancels the pending upload and stops the remaining batch before it can enter the new chapter');
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
  releaseHeld?.(); await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
