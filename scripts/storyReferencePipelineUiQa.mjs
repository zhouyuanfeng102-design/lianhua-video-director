import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Only the unverified text pipeline is exercised here. Two recognized images
// are fixtures; uploads, vision transport and responsive layout have separate QA.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'story-reference-pipeline'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('QA output must stay below output/playwright');
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse links');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'pipeline-chapter';
const narrator = { name: '旅行者阿林', description: '未出现在参考图中的旅行者，穿绿色外套，知道石桥的位置。' };
const story = '我带着图1中的小雨与南枝，拿起铜灯，在石桥上与图2中的北辰会面。';
const scenery = '雨后的山谷里，低云缓缓掠过远山，地面空无一人。';
const expanded = '旅行者阿林带着小雨与南枝走上石桥。小雨将铜灯递给南枝，南枝稳稳接住。北辰从桥另一端走近，三人转向来人。阿林停下脚步，示意大家站在桥中央会面。' + '\n\n' + scenery;
const meeting = '石桥上，旅行者阿林走在小雨和南枝身旁。小雨将铜灯交到南枝手中；南枝握稳灯柄。北辰从石桥另一端走来，阿林停步，小雨和南枝一同转身面对北辰。';
const optimized = meeting + '\n\n' + scenery;
const pendingOptimization = '石桥中央，旅行者阿林停步。小雨把铜灯交给南枝，南枝握住灯柄。北辰从另一端走近，小雨和南枝一起转向北辰。' + '\n\n' + scenery;
const subject = (id, label, description) => ({ id, label, description, fields: { 外观: description, 位置: '画面前景', 衣物材质: '可见布料纹理' } });
const completeAnalysis = (number) => ({
  description: number === 1 ? '小雨和南枝站在石桥上，铜灯放在两人之间；石桥边缘可见青苔。' : '北辰站在山谷入口，穿深蓝色外套。',
  characters: number === 1 ? [subject('character-1', '小雨', '银色长发，蓝色外套'), subject('character-2', '南枝', '黑色短发，棕色披肩')] : [subject('character-1', '北辰', '深棕色卷发，深蓝色外套')],
  locations: number === 1 ? [subject('location-1', '石桥', '灰色石桥，边缘有青苔')] : [],
  props: number === 1 ? [subject('prop-1', '铜灯', '古铜色提灯，透明玻璃罩')] : [],
  events: ['人物站立等待'], relationships: ['人物之间有一个身位的距离'], readableText: ['路牌上可见：归途'], uncertainties: ['不能仅凭图片确认真实姓名与身高'],
  style: '写实插画', composition: '平视构图', lighting: '阴天漫射光', colors: '蓝绿与暖铜色', model: 'fixture-vision', analyzedAt: 1000 + number, revision: 1,
  rawResponse: '完整原始识别记录' + number,
  structuredData: { visibleDetails: { foreground: ['人物衣物上的细纹', '道具上的反光'], background: '逐段保留的背景细节。'.repeat(1700) + '图' + number + '完整信息末尾标记' }, relationships: [{ from: '人物', to: '石桥', relation: '站立于' }] },
});
const references = [1, 2].map((number) => ({
  id: 'reference-' + number, number, assetId: 'image-' + number, enabled: true, status: 'ready', analysis: completeAnalysis(number),
  fullDescription: '图' + number + '人工修订后的完整描述：保留画面外貌，不沿用原图正在等待的事件。',
  notes: '图' + number + '补充说明：本章保持衣物颜色，铜灯处于熄灭状态。',
  subjectBindings: completeAnalysis(number).characters.map((item) => ({ subjectId: item.id, kind: 'character', name: item.label })),
  createdAt: 1000, updatedAt: 1000,
}));
const link = (referenceId, subjectId) => ({ referenceId, subjectId });
const character = (name, bindings = []) => ({ name, gender: '男', apparentAge: '成年青年', actualAge: '约25岁', height: '约175厘米', race: '人类', morphology: 'human-like', bodyPlan: '一头两臂两腿', appearance: name + '的可见外貌', outfit: '旅行外套', signatureProps: '', personality: '沉稳', motionHabits: '步伐平稳', anchor: name + '的稳定外貌与衣着', negativeContinuity: '保持发色和身体结构', storyReferenceBindings: bindings });
const enrichedNorth = character('北辰', [link('reference-2', 'character-1')]);
const parsed = {
  characters: [character('小雨', [link('reference-1', 'character-1')]), character('南枝', [link('reference-1', 'character-2')]), { ...enrichedNorth, appearance: '' }, character(narrator.name)],
  locations: [{ name: '石桥', description: '灰色石桥横跨溪水，两侧覆盖青苔', timeWeather: '白天阴天', lighting: '天空漫射光', palette: '灰绿石材', fixedProps: '石质护栏', anchor: '青苔石桥横跨溪水', storyReferenceBindings: [link('reference-1', 'location-1')] }],
  props: [{ name: '铜灯', category: '提灯', material: '古铜与玻璃', appearance: '古铜灯框配透明玻璃罩', effect: '交接的道具', stateRules: '始终熄灭，形状不变', storyReferenceBindings: [link('reference-1', 'prop-1')] }],
  // Missing titles are legal model output. The second scene uses only image 2's
  // style/composition, so entity-owned image links cannot hide a lost scene link.
  scenes: [
    { content: meeting, summary: '四人在桥上会面并交接铜灯', characters: ['小雨', '南枝', '北辰', narrator.name], location: '石桥', props: ['铜灯'], referenceAssetIds: ['image-1', 'image-2'] },
    { content: scenery, summary: '山谷空景，采用图2的风格与构图', characters: [], props: [], referenceAssetIds: ['image-2'] },
  ],
};
const port = await findAvailableTcpPort(); const baseUrl = 'http://127.0.0.1:' + port + '/';
const bootstrap = 'import {createServer} from "vite"; const server=await createServer({server:{host:"127.0.0.1",port:' + port + ',strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log("Story reference pipeline QA ready");';
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused story reference text pipeline QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let optimizationCount = 0;
const requests = []; const stages = []; const errors = [];
const storedProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const waitStored = (predicate, label) => waitForCondition({ label, timeoutMs: 12_000, intervalMs: 70, check: async () => predicate(await storedProject()) });
const validateContext = (data, stage) => {
  const context = data.referenceContext;
  assert.equal(context?.mode, 'image', stage + ': image context supplied');
  assert.equal(context.chapterId, chapterId);
  assert.equal(context.references.length, 2, stage + ': both images supplied');
  assert.deepEqual(context.narrator, narrator, stage + ': complete first person configuration');
  for (const expected of references) {
    const actual = context.references.find((item) => item.referenceId === expected.id);
    assert.ok(actual, stage + ': stable reference identity');
    assert.equal(actual.assetId, expected.assetId); assert.equal(actual.number, expected.number);
    assert.deepEqual(actual.analysis, expected.analysis, stage + ': complete, untruncated recognition including nested data');
    assert.equal(actual.fullDescription, expected.fullDescription); assert.equal(actual.notes, expected.notes);
    assert.ok(expected.subjectBindings.every((binding) => actual.subjectBindings.some((item) => item.subjectId === binding.subjectId && item.name === binding.name)));
  }
  requests.push({ stage, referenceIds: context.references.map((item) => item.referenceId), completeContextCharacters: JSON.stringify(context).length });
};

const run = async () => {
  await waitForCondition({ label: 'Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { errors.push('Unexpected remote request: ' + route.request().url()); await route.abort('blockedbyclient'); });
  await page.route('**/qa-story-reference-text/v1/chat/completions', async (route) => {
    try {
      const payload = route.request().postDataJSON();
      const textFor = (role) => payload.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
      const user = textFor('user'); const system = textFor('system');
      let result;
      const preparation = user.match(/<story_expansion_data>\s*([\s\S]*?)\s*<\/story_expansion_data>/u);
      const analysis = user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u);
      const enrichment = user.match(/<story_reference_data>\s*([\s\S]*?)\s*<\/story_reference_data>/u);
      if (preparation) {
        const data = JSON.parse(preparation[1]); validateContext(data, data.mode);
        if (data.mode === 'expand') { assert.equal(data.sourceTextOrRequirement, story); result = expanded; }
        else { optimizationCount++; assert.equal(data.sourceTextOrRequirement, optimizationCount === 1 ? expanded : optimized); result = optimizationCount === 1 ? optimized : pendingOptimization; }
      } else if (analysis) {
        const data = JSON.parse(analysis[1]); validateContext(data, 'analysis'); assert.equal(data.sourceStory, optimized); result = JSON.stringify(parsed);
      } else if (enrichment) {
        validateContext(JSON.parse(enrichment[1]), 'enrichment'); assert.match(system, /人物视觉设定师/u); assert.ok(user.includes(optimized)); assert.ok(user.includes('北辰'));
        result = JSON.stringify({ items: [enrichedNorth] });
      } else throw new Error('Unexpected text request contract');
      // Preparation intentionally sends its final output contract after the
      // user data, while analysis/enrichment put the same rule in the system.
      assert.match(system + '\n' + user, /STORY_REFERENCE_CONTEXT_V1/u);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: result } }] }) });
    } catch (error) { errors.push(error instanceof Error ? error.stack : String(error)); await route.fulfill({ status: 500, body: 'Pipeline fixture assertion failed' }); }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, api, chapterId, references, narrator, story }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#568f87'; ctx.fillRect(0, 0, 64, 64);
    const assets = references.map((reference) => ({ id: reference.assetId, name: '预置图' + reference.number, type: 'reference', role: 'composition', mediaType: 'image', referenceRole: 'general', source: 'upload', dataUrl: canvas.toDataURL('image/png'), tags: ['隔离测试'], createdAt: now, updatedAt: now }));
    const project = { ...state.project, id: 'story-reference-pipeline-qa', name: '参考图文本流程隔离测试', sourceDocuments: [{ id: chapterId, name: '会面章节', content: story, createdAt: now, updatedAt: now }], activeChapterId: chapterId,
      chapterWorkspaces: { [chapterId]: { storyInputMode: 'image', storyReferences: references, nextStoryReferenceNumber: 3, storyNarrator: narrator } }, storyDraft: undefined, storyVisualConversions: [],
      characters: [], locations: [], props: [], scenes: [], assets, storyboards: [], sequencePlans: [], generationTasks: [], updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: api, model: 'qa-text-pipeline', apiKey: '' };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.settings.visionApi.enabled = false; state.settings.imageApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, api: baseUrl + 'qa-story-reference-text/v1', chapterId, references, narrator, story });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
  const input = page.locator('.story-source-textarea'); const actions = page.locator('.story-input-actions');
  await actions.getByRole('button', { name: 'AI扩写', exact: true }).click();
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea').value === expected, expanded);
  assert.equal((await storedProject()).sourceDocuments[0].content, story, 'expansion remains an editor draft');
  await actions.getByRole('button', { name: 'AI画面描述转化', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'AI 画面描述转化 · 结果审阅', exact: true });
  await review.waitFor(); assert.equal(await input.inputValue(), expanded, 'conversion waits for adoption');
  await review.locator('.sr-review-reference-source > summary').click();
  assert.ok((await review.locator('.sr-review-reference-content').innerText()).includes(narrator.description));
  assert.ok((await review.locator('.sr-review-reference-content').innerText()).includes(references[1].notes));
  await review.getByRole('button', { name: '采用到编辑区', exact: true }).click();
  await page.waitForFunction((expected) => document.querySelector('.story-source-textarea').value === expected, optimized);
  await waitStored((project) => project.storyVisualConversions?.length === 1, 'adopted conversion snapshot persisted');
  const adopted = structuredClone((await storedProject()).storyVisualConversions[0]);
  assert.deepEqual(adopted.storyReferenceContext.narrator, narrator);
  assert.deepEqual(adopted.storyReferenceContext.references.map((reference) => reference.analysis), references.map((reference) => reference.analysis));
  stages.push('expansion and reviewed conversion receive complete two-image context and preserve adoption provenance');

  await actions.getByRole('button', { name: '解析并补全', exact: true }).click();
  await waitStored((project) => project.scenes.some((scene) => scene.title === '场景 1') && project.characters.find((item) => item.name === '北辰')?.appearance === enrichedNorth.appearance, 'analysis and missing-dossier enrichment committed');
  const analyzed = await storedProject(); const byName = (kind, name) => analyzed[kind].find((item) => item.name === name);
  assert.deepEqual(byName('characters', '小雨').assetIds, ['image-1']);
  assert.deepEqual(byName('characters', '南枝').assetIds, ['image-1']);
  assert.deepEqual(byName('characters', '北辰').assetIds, ['image-2']);
  assert.deepEqual(byName('characters', narrator.name).assetIds, [], 'off-image first-person character gets no invented reference');
  assert.deepEqual(byName('locations', '石桥').assetIds, ['image-1']);
  assert.deepEqual(byName('props', '铜灯').assetIds, ['image-1']);
  const scene = analyzed.scenes.find((item) => item.title === '场景 1');
  const styleScene = analyzed.scenes.find((item) => item.title === '场景 2');
  assert.ok(styleScene, 'omitted titles receive chapter-local default titles');
  assert.deepEqual(styleScene.characterIds, [], 'style-only scene has no character asset fallback');
  assert.deepEqual(styleScene.storyReferenceAssetIds, ['image-2'], 'titleless style-only scene keeps the exact model-selected reference image');
  assert.deepEqual([...scene.storyReferenceAssetIds].sort(), ['image-1', 'image-2']);
  assert.deepEqual(scene.storyReferenceContext.references.map((reference) => reference.analysis.structuredData), references.map((reference) => reference.analysis.structuredData));
  const firstAssetLinks = analyzed.assets.find((item) => item.id === 'image-1').storyReferenceSubjects;
  assert.deepEqual(firstAssetLinks.map((item) => item.kind + ':' + item.subjectId).sort(), ['character:character-1', 'character:character-2', 'location:location-1', 'prop:prop-1']);
  for (const binding of firstAssetLinks) assert.equal(binding.entityId, byName(binding.kind === 'character' ? 'characters' : binding.kind === 'location' ? 'locations' : 'props', binding.label).id);
  assert.equal(analyzed.assets.find((item) => item.id === 'image-1').characterReferenceId, undefined, 'multi-subject original is not destructively bound to one character');
  stages.push('analysis plus enrichment preserve context and bind shared media to each character, location, prop and scene');
  stages.push('model-omitted scene titles retain explicit style-only image links through committed scene IDs');

  await actions.getByRole('button', { name: 'AI画面描述转化', exact: true }).click();
  await review.waitFor(); await review.getByRole('button', { name: '稍后查看', exact: true }).click();
  await page.getByRole('article', { name: '图1参考图' }).getByRole('button', { name: '查看与修改', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '图1 · 参考资料', exact: true });
  const changedNotes = '新修订：下次剧情让铜灯发出绿色光。';
  await editor.getByLabel('补充与纠正说明').fill(changedNotes);
  await editor.getByRole('button', { name: '保存资料与绑定', exact: true }).click();
  await page.getByRole('button', { name: '查看转化结果', exact: true }).click(); await review.waitFor();
  assert.ok(await review.getByRole('button', { name: '采用到编辑区', exact: true }).isDisabled(), 'changed image notes invalidate a pending review even when story text is unchanged');
  assert.match(await review.locator('.sr-review-stale').innerText(), /参考资料/u);
  await review.getByRole('button', { name: '稍后查看', exact: true }).click();
  await waitStored((project) => project.chapterWorkspaces[chapterId].storyReferences[0].notes === changedNotes, 'new notes persisted');
  const afterEdit = await storedProject();
  assert.equal(await input.inputValue(), optimized);
  assert.deepEqual(afterEdit.storyVisualConversions[0], adopted, 'adopted source keeps immutable complete reference data after live edits');
  assert.ok(afterEdit.scenes.find((item) => item.id === scene.id).sourceStale, 'changed reference evidence marks derived scene stale');
  await page.getByRole('button', { name: '查看转化来源', exact: true }).click();
  const source = page.getByRole('dialog', { name: '画面描述 · 转化来源', exact: true });
  await source.locator('.sr-review-reference-source > summary').click();
  const frozenVisibleText = await source.locator('.sr-review-reference-content').innerText();
  assert.ok(frozenVisibleText.includes(references[0].notes)); assert.ok(!frozenVisibleText.includes(changedNotes));
  await source.getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('editing reference notes disables old pending adoption and leaves frozen conversion source unchanged');
  assert.deepEqual(requests.map((request) => request.stage), ['expand', 'optimize', 'analysis', 'enrichment', 'optimize']);
  assert.deepEqual(errors, []);
  const report = { mockOnly: true, noProductionDataRead: true, requests, stages, errors };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), requests, stages, errors, body: await page?.locator('body').innerText().catch(() => '') }, null, 2)); throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
