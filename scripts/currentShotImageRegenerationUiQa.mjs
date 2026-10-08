import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'current-shot-image-regeneration-existing-buttons'));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const key = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Current-shot image QA ready');`],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'current-shot image regeneration UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser, context, page;
const errors = [], results = [], screenshots = [];
const oldPrompt = 'OLD_BAD_FRAME: two adult warriors face the camera in a full-body poster.';
const currentH3 = 'integrated_multimodal_description: [Shot 1] CURRENT_FINAL_H3: 成年战士青岚位于画面左侧，侧身面向画面右侧的成年战士明川，目光落在明川的持杖手上。摄影机在青岚左后方，两人中景对峙。最后镜头向下移动，结束时刻只拍青岚踏稳的战靴，头部与明川均在画外。\n\noverall_soundscape: 微风。\n\nnon_diegetic_music: N/A';
const convertedPrompt = 'CURRENT_SHOT_RECONVERTED: 结束时刻低位战靴特写，只见成年战士青岚的靴子稳稳踏住石砖，摄影机已沿原镜下移，头部和明川保持画外，不拉远补全身体。';

const seed = async (font) => page.evaluate(async ({ key, font, oldPrompt, currentH3, convertedPrompt }) => {
  const { createInitialState } = await import('/src/storage.ts');
  const state = createInitialState(), now = Date.now();
  const png = (color) => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 160, 90); return canvas.toDataURL('image/png'); };
  const makeAsset = (id, name, color) => ({ id, name, type: 'character', role: 'character', referenceRole: 'character', mediaType: 'image', mimeType: 'image/png', dataUrl: png(color), width: 160, height: 90, source: 'upload', tags: ['隔离色块'], createdAt: now, updatedAt: now });
  const a = { ...makeAsset('qa-ref-a', '青岚人物参考', '#4079b1'), sourceEntityKind: 'character', sourceEntityId: 'qa-a', characterReferenceId: 'qa-a' };
  const b = { ...makeAsset('qa-ref-b', '明川人物参考', '#728946'), sourceEntityKind: 'character', sourceEntityId: 'qa-b', characterReferenceId: 'qa-b' };
  const oldShot = { ...makeAsset('qa-old-shot', '旧错误分镜图', '#a15568'), type: 'reference', role: 'composition', referenceRole: 'composition', source: 'generated', sourceStoryboardId: 'qa-board', sourceShotId: 'qa-shot', imageVariant: 'storyboard-frame', prompt: oldPrompt };
  const tail = { ...makeAsset('qa-old-tail', '青岚对峙 · 第1段 · 尾帧', '#815699'), type: 'last-frame', role: 'last-frame', referenceRole: 'last-frame', source: 'generated', sourceEntityKind: 'storyboard', sourceEntityId: 'qa-board', sourceStoryboardId: 'qa-board', sourceShotId: 'qa-shot', imageVariant: 'last-frame', prompt: oldPrompt, imageBackend: 'openai', imagePromptFormat: 'natural-language', imageRequestSize: { width: 160, height: 90, sizeOverride: true } };
  const makeCharacter = (id, name, assetId) => ({ id, name, gender: '男', apparentAge: '30岁', actualAge: '30岁', race: '人类', morphology: 'humanoid', bodyPlan: '成年战士身体结构', appearance: '深色短发，成年面孔', outfit: '蓝灰战甲', signatureProps: '长杖', personality: '平静', motionHabits: '自然站立', anchor: '成年战士', negativeContinuity: '', assetIds: [assetId] });
  const story = '两名成年战士青岚和明川在门廊对峙。青岚看向明川的持杖手，摄影机从中景下移，最后只拍青岚的战靴。';
  const canonical = '【0s–5s】主体：青岚、明川；动作：青岚看向明川持杖手；空间：青岚在左，明川在右；镜头：从青岚左后方中景下移至战靴特写；台词：无。';
  const board = { id: 'qa-board', chapterId: 'qa-chapter', sceneId: 'qa-scene', sourceStoryTitle: '门廊对峙', sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '两位成年战士身份保持', visualStyle: '中性电影色彩', globalReferenceAssetIds: [b.id], lastFrameAssetId: tail.id,
    shots: [{ id: 'qa-shot', index: 1, startSec: 0, endSec: 5, purpose: '展示对峙与蓄力', subject: '青岚、明川', action: '青岚注视明川，随后战靴踏稳', camera: '左后方中景下移至战靴特写', lighting: '自然侧光', sound: '微风', transition: '自然结束', result: '只拍青岚战靴', referenceAssetIds: [oldShot.id, tail.id], prompt: canonical, locked: false }], finalPrompt: canonical, officialPromptZh: currentH3, officialPromptEn: 'integrated_multimodal_description: [Shot 1] Two adult warriors, ending on a close-up of boots.\n\noverall_soundscape: Wind.\n\nnon_diegetic_music: N/A', officialPromptEnSource: currentH3, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now };
  const oldTask = { id: 'qa-old-task', kind: 'image', name: tail.name, assetKind: 'storyboard', imageVariant: 'last-frame', imageGenerationMode: 'text-to-image', status: 'succeeded', prompt: oldPrompt, width: 160, height: 90, sizeOverride: true, backend: 'openai', model: 'qa-image', sourceStoryboardId: board.id, sourceShotId: 'qa-shot', imagePromptFormat: 'natural-language', referenceAssetIds: [oldShot.id, b.id, a.id], primaryReferenceAssetIds: [], conversionSource: 'OLD_WRONG_SOURCE: both warriors face the audience', converterSystemPrompt: 'OLD_RULE_COMPLETE_BODY', resultAssetId: tail.id, createdAt: now, updatedAt: now };
  const characterTask = { id: 'qa-character-task', kind: 'image', name: '青岚人物参考', assetKind: 'character', imageVariant: 'reference', status: 'succeeded', prompt: 'CHARACTER_REPLAY: a neutral adult warrior reference, blue opaque armor, plain background.', width: 160, height: 90, sizeOverride: true, backend: 'openai', model: 'qa-image', sourceEntityId: 'qa-a', imagePromptFormat: 'natural-language', referenceAssetIds: [], primaryReferenceAssetIds: [], resultAssetId: a.id, createdAt: now, updatedAt: now };
  const project = { ...state.project, id: 'qa-project', name: '当前镜头重做隔离测试', activeChapterId: 'qa-chapter', chapterWorkspaces: {}, sourceDocuments: [{ id: 'qa-chapter', name: '第1章', content: story, createdAt: now, updatedAt: now }], storyDraft: story, scenes: [{ id: 'qa-scene', title: '门廊', content: story, summary: story, characterIds: ['qa-a', 'qa-b'], locationIds: [], propIds: [], storyboardIds: [board.id], createdAt: now, updatedAt: now }], storyboards: [board], assets: [tail, oldShot, a, b], characters: [makeCharacter('qa-a', '青岚', a.id), makeCharacter('qa-b', '明川', b.id)], locations: [], props: [], generationTasks: [oldTask, characterTask], sequencePlans: [], createdAt: now, updatedAt: now };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  state.settings.uiFontScalePercent = font;
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: 'https://qa-text.invalid/v1/chat/completions', apiKey: '', model: 'qa-text', vision: false };
  state.settings.imageApi = { enabled: true, backend: 'openai', baseUrl: 'https://qa-image.invalid/v1', apiKey: '', model: 'qa-image' };
  state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null; state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
  state.settings.imagePromptRuleSetIdByBackend = { openai: 'image-rule-openai-gpt-image' };
  state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  localStorage.setItem('__qa_result_png', png('#9ba978')); localStorage.setItem('__qa_converted_prompt', convertedPrompt);
  return { a: a.dataUrl, b: b.dataUrl, oldShot: oldShot.dataUrl };
}, { key, font, oldPrompt, currentH3, convertedPrompt });

const read = () => page.evaluate((key) => { const state = JSON.parse(localStorage.getItem(key)); return state.project.id === 'qa-project' ? state.project : state.projects.find((project) => project.id === 'qa-project'); }, key);
const calls = () => page.evaluate(() => window.__qaRequests);
const settle = async (count) => {
  await page.waitForFunction(({ key, count }) => { const state = JSON.parse(localStorage.getItem(key)); const project = state.project.id === 'qa-project' ? state.project : state.projects.find((item) => item.id === 'qa-project'); return project.generationTasks.length === count && project.generationTasks.every((task) => ['succeeded', 'failed'].includes(task.status)); }, { key, count }, { timeout: 20_000 });
  const project = await read(); const task = project.generationTasks[0]; assert.equal(task.status, 'succeeded', task.error); return { project, task };
};
const reachable = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(await locator.evaluate((element) => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return box.width > 0 && box.height > 0 && box.x >= 0 && box.right <= innerWidth + 1 && box.y >= 0 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit)); }), 'action must be visible and unobstructed');
};
const noOverlap = async (buttons) => {
  const overlaps = await buttons.evaluateAll((elements) => { const boxes = elements.map((element) => ({ name: element.textContent, box: element.getBoundingClientRect() })).filter((item) => item.box.width && item.box.height); return boxes.flatMap((left, index) => boxes.slice(index + 1).filter((right) => Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left) > 1 && Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top) > 1).map((right) => `${left.name}/${right.name}`)); });
  assert.deepEqual(overlaps, [], 'card buttons must not overlap');
};
const capture = async (name) => { await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name); };

const run = async () => {
  await waitForCondition({ label: 'current-shot QA startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  const viewports = [{ width: 1280, height: 800, font: 100 }, { width: 1366, height: 768, font: 125 }];
  for (const spec of viewports) {
    context = await browser.newContext({ viewport: { width: spec.width, height: spec.height } }); page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      window.__qaRequests = [];
      window.lianhuaDesktop = { onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true, request: async (payload) => {
        window.__qaRequests.push(payload);
        if (payload.url.startsWith('https://qa-text.invalid/')) return { status: 200, body: JSON.stringify({ choices: [{ message: { content: localStorage.getItem('__qa_converted_prompt') } }] }) };
        if (payload.url.startsWith('https://qa-image.invalid/')) return { status: 200, body: JSON.stringify({ data: [{ b64_json: localStorage.getItem('__qa_result_png').split(',')[1] }] }) };
        throw new Error(`Unexpected QA bridge URL: ${payload.url}`);
      } };
    });
    await page.route('**/*', async (route) => { const request = route.request(); const url = new URL(request.url()); if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) { errors.push(`Unexpected network: ${url.href}`); await route.abort('blockedbyclient'); } else await route.continue(); });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    const refs = await seed(spec.font); await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
    const card = page.locator('#asset-card-qa-old-tail'); await card.waitFor();
    const before = await read();
    assert.equal(await page.locator('.asset-current-shot-button, .image-current-shot-button').count(), 0);
    assert.equal(await page.getByRole('button', { name: '按当前镜头重做', exact: true }).count(), 0);
    await reachable(card.locator('.asset-regenerate-button')); await noOverlap(card.locator('.asset-actions button'));
    await capture(`asset-${spec.width}x${spec.height}-font${spec.font}.png`);
    if (spec.font === 125) {
      await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
      const imageTab = page.getByRole('tab', { name: /图片任务/u }); if (await imageTab.count()) await imageTab.click();
      const taskCard = page.locator('#image-task-qa-old-task'); await taskCard.waitFor();
      assert.equal(await page.locator('.asset-current-shot-button, .image-current-shot-button').count(), 0);
      assert.equal(await page.getByRole('button', { name: '按当前镜头重做', exact: true }).count(), 0);
      await reachable(taskCard.locator('.image-regenerate-button')); await noOverlap(taskCard.locator('button'));
      await capture(`task-${spec.width}x${spec.height}-font${spec.font}.png`);
      assert.deepEqual(await calls(), []); assert.deepEqual(errors, []);
      results.push({ ...spec, layoutOnly: true, noNewButtons: true, noButtonOverlap: true, apiRequests: 0 });
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, results, screenshots, errors }, null, 2));
      console.log(JSON.stringify(results.at(-1))); await context.close(); context = undefined; continue;
    }
    await card.locator('.asset-regenerate-button').click();
    const first = await settle(3); const firstCalls = await calls();
    assert.equal(firstCalls.filter((call) => call.url.startsWith('https://qa-text.invalid/')).length, 1);
    assert.equal(firstCalls.filter((call) => call.url.startsWith('https://qa-image.invalid/')).length, 1);
    const text = firstCalls.find((call) => call.url.startsWith('https://qa-text.invalid/'));
    const textBody = JSON.parse(text.body); const textMessages = JSON.stringify(textBody.messages);
    assert.match(textMessages, /CURRENT_FINAL_H3/u); assert.match(textMessages, /尾帧保留结束时刻/u); assert.doesNotMatch(textMessages, /OLD_BAD_FRAME|OLD_WRONG_SOURCE|OLD_RULE_COMPLETE_BODY/u);
    const image = firstCalls.find((call) => call.url.startsWith('https://qa-image.invalid/'));
    assert.deepEqual(image.multipart.files.map((file) => file.dataUrl), [refs.b, refs.a], 'actual uploads omit old generated composition and preserve identity order');
    const imagePrompt = image.multipart.fields.find((field) => field.name === 'prompt').value;
    assert.ok(imagePrompt.startsWith(convertedPrompt)); assert.match(imagePrompt, /本次实际上传图片/u); assert.ok(imagePrompt.indexOf('明川') < imagePrompt.lastIndexOf('青岚'), 'upload map names follow actual B, A order');
    assert.deepEqual(first.project.assets.find((asset) => asset.id === 'qa-old-tail'), before.assets.find((asset) => asset.id === 'qa-old-tail'));
    assert.deepEqual(first.project.generationTasks.find((task) => task.id === 'qa-old-task'), before.generationTasks[0]);
    assert.equal(first.project.storyboards[0].officialPromptZh, before.storyboards[0].officialPromptZh); assert.equal(first.project.storyboards[0].officialPromptEn, before.storyboards[0].officialPromptEn);
    assert.ok(first.project.assets.some((asset) => asset.id === first.task.resultAssetId && asset.id !== 'qa-old-tail'));
    await page.locator('.sidebar').getByRole('button', { name: '生成任务', exact: true }).click();
    const imageTab = page.getByRole('tab', { name: /图片任务/u }); if (await imageTab.count()) await imageTab.click();
    const taskCard = page.locator('#image-task-qa-old-task'); await taskCard.waitFor();
    await reachable(taskCard.locator('.image-regenerate-button')); await noOverlap(taskCard.locator('button'));
    await capture(`task-${spec.width}x${spec.height}-font${spec.font}.png`);
    await taskCard.locator('.image-regenerate-button').click(); await settle(4);
    const secondCalls = await calls(); assert.equal(secondCalls.length, 4, 'task-card current shot repeats exactly one text and image request');
    const characterCard = page.locator('#image-task-qa-character-task');
    await characterCard.locator('.image-regenerate-button').click(); await settle(5);
    const finalCalls = await calls(); assert.equal(finalCalls.length, 5, 'ordinary replay adds only the image request');
    const replay = finalCalls.at(-1); assert.ok(replay.url.startsWith('https://qa-image.invalid/'));
    const replayPrompt = replay.multipart ? replay.multipart.fields.find((field) => field.name === 'prompt').value : JSON.parse(replay.body).prompt;
    assert.equal(replayPrompt, before.generationTasks.find((task) => task.id === 'qa-character-task').prompt, 'ordinary character replay preserves the original prompt');
    assert.deepEqual(errors, []);
    results.push({ ...spec, existingAssetAndTaskButtonsReconvert: true, noNewButtons: true, converterRequests: 2, imageRequests: 3, oldReferencesExcluded: true, uploadIdentityOrder: ['明川', '青岚'], oldImageAndTaskPreserved: true, bilingualVideoPromptsPreserved: true, ordinaryCharacterReplayNoConversion: true, noButtonOverlap: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, results, screenshots, errors }, null, 2)); console.log(JSON.stringify(results.at(-1)));
    await context.close(); context = undefined;
  }
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), results, errors }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
