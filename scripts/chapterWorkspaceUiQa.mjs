import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One full-App integration scenario. All content is synthetic, the browser is
// fresh, and external requests and API writes are blocked before App loads.
const root = path.resolve(import.meta.dirname, '..');
const incremental = process.argv.includes('--incremental');
const runId = Date.now();
const output = path.join(root, 'output', 'playwright', `chapter-workspace-${runId}`);
const cacheDir = path.join(root, `.qa-chapter-workspace-${runId}`, 'vite');
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const base = `http://127.0.0.1:${port}`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({cacheDir:${JSON.stringify(cacheDir)},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Chapter workspace QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'chapter workspace integration', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let page; let storageKey;
const checks = []; const errors = []; const blockedRequests = [];
const analysisRequests = [];
let holdNextAnalysis = false; let pendingAnalysis;
const mark = (label) => { checks.push(label); console.log(label); };
const nav = (label) => page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
const chapterSelect = () => page.getByRole('combobox', { name: '当前章节', exact: true });
const story = () => page.locator('.story-source-textarea');
const directorInputs = () => page.locator('#director-setup-style .director-style-pane input');
const readControls = async () => ({
  category: await directorInputs().nth(0).inputValue(),
  style: await directorInputs().nth(1).inputValue(),
  visual: await directorInputs().nth(2).inputValue(),
  requirement: await page.getByRole('textbox', { name: '导演与视觉自定义要求', exact: true }).inputValue(),
  extra: await page.locator('.director-motion-pane textarea.director-requirement').inputValue(),
  duration: await page.locator('.director-timing-fields .seconds-card input').inputValue(),
  count: await page.locator('.director-timing-fields .count-card input').inputValue(),
});
const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const saved = (test, argument) => waitForCondition({
  label: 'chapter data persisted', timeoutMs: 15000, intervalMs: 50,
  check: async () => test(await readProject(), argument),
});

const runIncremental = async () => {
  // Real project creation must supply a selectable chapter before any source
  // is saved. Keep the first mock response complete to avoid enrichment calls.
  await page.locator('.top-actions').getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByPlaceholder('例如：青山剑影 · 第一场').fill('新项目章节增量检查');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await nav('剧情解析');
  await saved((project) => project.name === '新项目章节增量检查');
  const projectId = (await readProject()).id;
  const chapterA = await chapterSelect().inputValue();
  assert.ok(chapterA); assert.equal(await chapterSelect().locator('option:checked').innerText(), '第 1 章');
  assert.equal(await story().inputValue(), '');
  const firstText = '林舟沿石桥走进山城，停在茶亭前观察河水。';
  await story().fill(firstText);
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await saved((project, { id, text }) => project.sourceDocuments.find((chapter) => chapter.id === id)?.content === text, { id: chapterA, text: firstText });
  await page.getByRole('button', { name: '解析并补全', exact: true }).click();
  await saved((project, id) => project.scenes.some((scene) => scene.chapterId === id && scene.title === '首次中性解析'), chapterA);
  assert.equal(analysisRequests.length, 1);
  const first = await readProject(); const character = first.characters.find((item) => item.name === '林舟');
  assert.ok(character?.id); assert.equal(first.scenes.find((scene) => scene.chapterId === chapterA).characterIds[0], character.id);
  mark('new project creates first chapter that saves source and completes mocked analysis');

  const editedText = '林师兄检查茶亭前的药草，然后沿桥缓步返回。\n这是尚未保存的甲章编辑稿。  ';
  await story().fill(editedText);
  await page.getByRole('button', { name: '章节管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '章节管理', exact: true });
  const name = '甲章改名后保留草稿';
  await dialog.getByRole('textbox', { name: '章节名称：第 1 章', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: '搜索章节', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const storyName = page.getByRole('textbox', { name: '章节名称', exact: true });
  assert.equal(await storyName.inputValue(), name); assert.equal(await story().inputValue(), editedText);
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const chapterB = await chapterSelect().inputValue(); assert.notEqual(chapterB, chapterA);
  const bText = '乙章原文：旅人乙在海湾灯塔前整理行囊。';
  await story().fill(bText); await page.getByRole('button', { name: '保存原文', exact: true }).click();
  await chapterSelect().selectOption(chapterA);
  assert.equal(await storyName.inputValue(), name); assert.equal(await story().inputValue(), editedText);
  await saved((project, { id, name, text }) => project.activeChapterId === id && project.sourceDocuments.find((chapter) => chapter.id === id)?.name === name && project.chapterWorkspaces[id]?.storyDraft?.name === name && project.chapterWorkspaces[id]?.storyDraft?.content === text, { id: chapterA, name, text: editedText });
  await page.reload({ waitUntil: 'networkidle' }); await nav('剧情解析');
  assert.equal(await storyName.inputValue(), name); assert.equal(await story().inputValue(), editedText);
  assert.equal(await chapterSelect().inputValue(), chapterA);
  mark('renaming active chapter updates the editor draft name and survives switches and reload');

  const before = await readProject(); const bSource = before.sourceDocuments.find((chapter) => chapter.id === chapterB);
  const bScenes = before.scenes.filter((scene) => scene.chapterId === chapterB);
  holdNextAnalysis = true;
  await page.getByRole('button', { name: '解析并补全', exact: true }).click();
  await waitForCondition({ label: 'held chapter analysis request', timeoutMs: 15000, intervalMs: 25, check: async () => Boolean(pendingAnalysis) });
  // Let React's identity effects run while this chapter remains active.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const analyzingButton = page.locator('button[title="解析并补全"]');
  assert.equal(await analyzingButton.isDisabled(), true);
  assert.equal((await analyzingButton.innerText()).trim(), '解析中…');
  assert.equal(analysisRequests.length, 2);
  assert.equal(analysisRequests[1].chapterId, chapterA);
  assert.equal(analysisRequests[1].sourceStory, editedText);
  assert.ok(analysisRequests[1].existingEntityCatalog.characters.some((item) => item.id === character.id));
  await chapterSelect().selectOption(chapterB);
  const bDraft = '乙章编辑中：旅人乙正在整理地图。\n保留B章正在输入的文字。';
  await story().fill(bDraft);
  pendingAnalysis.release();
  await saved((project, id) => project.scenes.some((scene) => scene.chapterId === id && scene.title === '甲章延迟解析'), chapterA);
  const after = await readProject();
  assert.equal(after.id, projectId); assert.equal(after.activeChapterId, chapterB);
  assert.equal(await chapterSelect().inputValue(), chapterB); assert.equal(await story().inputValue(), bDraft);
  assert.deepEqual(after.sourceDocuments.find((chapter) => chapter.id === chapterB), bSource);
  assert.deepEqual(after.scenes.filter((scene) => scene.chapterId === chapterB), bScenes);
  assert.equal(after.characters.length, 1); assert.equal(after.characters[0].id, character.id);
  assert.equal(after.characters[0].appearance, character.appearance);
  assert.deepEqual(after.scenes.find((scene) => scene.chapterId === chapterA).characterIds, [character.id]);
  assert.equal(after.sourceDocuments.find((chapter) => chapter.id === chapterA).content, editedText);
  assert.equal(after.sourceDocuments.find((chapter) => chapter.id === chapterA).name, name);
  await saved((project, { id, text }) => project.chapterWorkspaces[id]?.storyDraft?.content === text, { id: chapterB, text: bDraft });
  mark('delayed analysis survives identity effects and chapter switch, writes only owner chapter, and reuses shared character');
  assert.equal(analysisRequests.length, 2); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  await page.screenshot({ path: path.join(output, 'incremental-background-result.png'), fullPage: false });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, mode: 'incremental', checks, errors, blockedRequests, mockedAnalysisRequests: analysisRequests.length, productionDataRead: false, paidRequests: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, mode: 'incremental', output, checks }));
};

const run = async () => {
  await waitForCondition({ label: 'chapter App Vite', timeoutMs: 40000, intervalMs: 100, check: async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (incremental && url.origin === base && url.pathname === '/qa-chapter-analysis/v1/chat/completions') {
      try {
        assert.equal(request.method(), 'POST');
        const body = request.postDataJSON();
        const user = body.messages.at(-1).content;
        const match = user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u);
        assert.ok(match, 'only the explicitly mocked story analysis request is allowed');
        const data = JSON.parse(match[1]); analysisRequests.push(data);
        const held = holdNextAnalysis; holdNextAnalysis = false;
        if (held) await new Promise((release) => { pendingAnalysis = { release }; });
        const existing = data.existingEntityCatalog.characters.find((item) => item.name === '林舟');
        const result = { characters: [{ name: existing ? '林师兄' : '林舟', ...(existing ? { existingEntityId: existing.id } : {}), aliases: ['林师兄'],
          gender: '男', apparentAge: '成年', actualAge: '约三十岁', height: '约175cm', race: '人类', appearance: existing ? 'AI返回的新外貌不应覆盖' : '手工基线黑发长衣',
          outfit: '朴素长衣', signatureProps: '', personality: '平静', motionHabits: '缓步', anchor: '成年黑发旅人', negativeContinuity: '保持黑发' }],
          locations: [], props: [], scenes: [{ title: held ? '甲章延迟解析' : '首次中性解析', content: data.sourceStory, summary: '中性旅途片段', characters: [existing ? '林师兄' : '林舟'], props: [] }] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
      } catch (error) { errors.push(String(error)); await route.fulfill({ status: 500, body: 'Isolated chapter analysis mock rejected the request' }).catch(() => {}); }
      return;
    }
    if (/^https?:$/u.test(url.protocol) && (url.origin !== base || !['GET', 'HEAD'].includes(request.method()))) {
      blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__chapter_fixture.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><body>Neutral chapter fixture</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${base}/__chapter_fixture.html`);
  storageKey = await page.evaluate(async ({ incremental, base }) => {
    const { createInitialState, STORAGE_KEY } = await import('/src/storage.ts');
    const state = createInitialState(); const now = 1791129000000;
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#71949f'; paint.fillRect(0, 0, 40, 30);
    const asset = (id, chapterId, name) => ({ id, ...(chapterId ? { chapterId } : {}), name, type: 'reference', role: 'scene', mediaType: 'image', source: 'upload', dataUrl: canvas.toDataURL(), tags: [], createdAt: now, updatedAt: now });
    const task = (id, chapterId) => ({ id, ...(chapterId ? { chapterId } : {}), kind: 'video', storyboardId: '', targetId: 'isolated-disabled', status: 'failed', error: '合成历史任务，无远端请求', requestBody: { prompt: '旅人走过石桥。' }, createdAt: now, updatedAt: now });
    const project = { ...state.project, id: 'chapter-ui-neutral', name: '章节整合隔离项目', description: '无生产数据、无真实生成',
      activeChapterId: 'chapter-a', chapterWorkspaces: {}, storyDraft: undefined,
      directorLookDraft: undefined, directorLookRequirement: '', directorSettingsConfirmedFingerprint: undefined,
      sourceDocuments: [
        { id: 'chapter-a', name: '初始章节甲', content: '旅人甲沿石桥走进山城，停在茶亭前。', createdAt: now, updatedAt: now },
        { id: 'chapter-other', name: '已有章节乙', content: '旅人乙在海湾观察往来的船只。', createdAt: now, updatedAt: now },
      ],
      scenes: [{ id: 'scene-a', chapterId: 'chapter-a', sourceDocumentId: 'chapter-a', title: '甲章石桥场景', content: '旅人甲沿石桥走进山城，停在茶亭前。', summary: '沿桥走到茶亭', characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now }],
      characters: [], locations: [], props: [], storyboards: [], sequencePlans: [],
      assets: [asset('asset-a', 'chapter-a', '甲章风景图'), asset('asset-other', 'chapter-other', '乙章海湾图'), asset('asset-shared', undefined, '项目共享纹理')],
      generationTasks: [task('task-a', 'chapter-a'), task('task-other', 'chapter-other'), task('task-shared', undefined)], createdAt: now, updatedAt: now,
    };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const name of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi', 'comfyuiVideo', 'runningHubVideo']) state.settings[name] = { ...state.settings[name], enabled: false, apiKey: '' };
    state.settings.textApiProfiles = []; state.settings.visionApiProfiles = []; state.settings.imageApiProfiles = []; state.settings.videoApiProfiles = [];
    state.settings.activeTextApiProfileId = null; state.settings.activeVisionApiProfileId = null; state.settings.activeImageApiProfileId = null; state.settings.activeVideoApiProfileId = null;
    state.settings.apiCredentialBook = []; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
    if (incremental) state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${base}/qa-chapter-analysis/v1`, apiKey: '', model: 'isolated-chapter-analysis' };
    localStorage.clear(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return STORAGE_KEY;
  }, { incremental, base });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 50000 });
  await nav('剧情解析'); await story().waitFor();
  if (incremental) { await runIncremental(); return; }
  assert.equal(await chapterSelect().inputValue(), 'chapter-a');
  assert.equal(await story().inputValue(), '旅人甲沿石桥走进山城，停在茶亭前。');
  mark('full App renders with chapter-scoped source and no hook loop');

  const draftA = '甲章未提交草稿：旅人推开茶亭木门。\n保留此行和末尾空格。  ';
  await story().fill(draftA);
  await nav('提示词导演台'); await directorInputs().nth(0).waitFor();
  await directorInputs().nth(0).fill('甲章自然叙事');
  await directorInputs().nth(1).fill('甲章稳定跟随');
  await directorInputs().nth(2).fill('甲章清透日光');
  await page.getByRole('textbox', { name: '导演与视觉自定义要求', exact: true }).fill('甲章保留桥上自然空间关系');
  await page.locator('.director-motion-pane textarea.director-requirement').fill('甲章通用额外要求');
  await page.getByRole('button', { name: '精确指定', exact: true }).click();
  await page.locator('.director-timing-fields .count-card input').fill('4');
  await page.locator('.director-timing-fields .seconds-card input').fill('12');
  const controlsA = await readControls();
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  const newId = await chapterSelect().inputValue(); assert.notEqual(newId, 'chapter-a');
  await page.getByText('还没有可用剧情', { exact: true }).waitFor();
  assert.equal(await page.locator('.prompt-video-links').count(), 0);
  await nav('剧情解析'); assert.equal(await story().inputValue(), '');
  mark('new chapter opens with empty story and empty director instead of prior chapter');

  const draftB = '新章独立草稿：旅人乙在海湾灯塔前停步。';
  await story().fill(draftB); await nav('提示词导演台');
  await directorInputs().nth(0).fill('乙章水墨叙事');
  await directorInputs().nth(1).fill('乙章缓慢推进');
  await directorInputs().nth(2).fill('乙章淡彩纸张');
  await page.getByRole('textbox', { name: '导演与视觉自定义要求', exact: true }).fill('乙章留出海湾远景');
  await page.locator('.director-motion-pane textarea.director-requirement').fill('乙章独立额外要求');
  const controlsB = await readControls();
  await chapterSelect().selectOption('chapter-a');
  assert.deepEqual(await readControls(), controlsA);
  await nav('剧情解析'); assert.equal(await story().inputValue(), draftA);
  await chapterSelect().selectOption(newId); assert.equal(await story().inputValue(), draftB);
  await nav('提示词导演台'); assert.deepEqual(await readControls(), controlsB);
  await saved((project, id) => project.activeChapterId === id && project.chapterWorkspaces[id]?.directorControls?.directorCategory === '乙章水墨叙事', newId);
  await page.reload({ waitUntil: 'networkidle' }); await nav('提示词导演台');
  assert.equal(await chapterSelect().inputValue(), newId); assert.deepEqual(await readControls(), controlsB);
  await chapterSelect().selectOption('chapter-a'); assert.deepEqual(await readControls(), controlsA);
  await nav('剧情解析'); assert.equal(await story().inputValue(), draftA);
  mark('chapter story drafts and director controls restore on immediate switch and reload');

  const txt = '\ufeff第一章 山门\r\n清晨，旅人推开山门。  \r\n\r\n第二章 茶亭\r\n旅人端起茶杯，又慢慢放下。\r\n';
  const md = '# 第三章 海湾\n\n远处的船只驶入海湾。\n\n# 第四章 灯塔\n旅人在灯塔前停步。  \n';
  await saved((project) => project.chapterWorkspaces['chapter-a']?.storyDraft?.content?.includes('甲章未提交草稿'));
  const sourceBeforeImport = (await readProject()).sourceDocuments;
  for (const [name, text] of [['neutral-novel.txt', txt], ['neutral-novel.md', md]]) {
    const before = (await readProject()).sourceDocuments.length;
    await page.locator('input[type="file"][accept*=".markdown"]').setInputFiles({ name, mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/plain', buffer: Buffer.from(text, 'utf8') });
    const dialog = page.getByRole('dialog', { name: '导入小说 · 分章预览', exact: true }); await dialog.waitFor();
    assert.equal((await readProject()).sourceDocuments.length, before, 'preview must not commit source');
    const previewButtons = dialog.locator('.chapter-preview-list > button');
    const pieces = await previewButtons.count(); assert.equal(pieces, 2);
    let preview = '';
    for (let index = 0; index < pieces; index++) {
      await previewButtons.nth(index).click();
      preview += await dialog.getByRole('textbox', { name: '章节原文预览，点击选择分割位置', exact: true }).inputValue();
    }
    assert.equal(preview, text.replace(/\r\n/gu, '\n'), 'browser preview keeps all text including BOM and whitespace');
    await dialog.getByRole('button', { name: '追加导入 2 个章节', exact: true }).click();
    await saved((project, count) => project.sourceDocuments.length === count, before + 2);
    assert.equal((await readProject()).sourceDocuments.slice(before).map((chapter) => chapter.content).join(''), text, 'confirmed import keeps exact decoded text, CRLF and BOM');
  }
  assert.deepEqual((await readProject()).sourceDocuments.slice(0, sourceBeforeImport.length), sourceBeforeImport);
  mark('TXT and MD preview are non-mutating; confirmed imports append and preserve exact source');

  await nav('资产库');
  const assetFilter = page.getByRole('combobox', { name: '资产章节筛选', exact: true });
  assert.equal(await assetFilter.inputValue(), 'all'); assert.equal(await page.locator('.asset-card').count(), 3);
  await assetFilter.selectOption('chapter-other'); assert.equal(await page.locator('.asset-card').count(), 1);
  assert.match(await page.locator('.asset-card').innerText(), /乙章海湾图/u);
  await assetFilter.selectOption('shared'); assert.equal(await page.locator('.asset-card').count(), 1);
  assert.match(await page.locator('.asset-card').innerText(), /项目共享纹理/u);
  await assetFilter.selectOption('all');
  await nav('生成任务');
  const taskFilter = page.getByRole('combobox', { name: '任务章节筛选', exact: true });
  assert.equal(await taskFilter.inputValue(), 'all');
  await page.locator('[data-task-category="video"]').click();
  assert.equal(await page.locator('[data-video-task-id]').count(), 3);
  await taskFilter.selectOption('chapter-other'); assert.equal(await page.locator('[data-video-task-id]').count(), 1);
  assert.equal(await page.locator('[data-video-task-id]').getAttribute('data-video-task-id'), 'task-other');
  await taskFilter.selectOption('shared'); assert.equal(await page.locator('[data-video-task-id]').count(), 1);
  assert.equal(await page.locator('[data-video-task-id]').getAttribute('data-video-task-id'), 'task-shared');
  await taskFilter.selectOption('all');
  mark('shared assets and jobs default to all chapters, with explicit chapter/shared filters');

  await nav('剧情解析'); await page.getByRole('button', { name: '章节管理', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'chapter-manager.png'), fullPage: false });
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const project = await readProject();
  assert.equal(project.assets.length, 3); assert.equal(project.generationTasks.length, 3);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, errors, blockedRequests, productionDataRead: false, paidRequests: 0, sourceDocuments: project.sourceDocuments.length }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks }));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
    await page.locator('body').innerText({ timeout: 3000 }).then((body) => fs.writeFileSync(path.join(output, 'failure.txt'), body)).catch(() => {});
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, error: String(error), checks, errors, blockedRequests, productionDataRead: false, paidRequests: 0 }, null, 2));
  console.error(JSON.stringify({ output, error: String(error), errors })); throw error;
}
finally { await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
