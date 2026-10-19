import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Exercise the real App with synthetic chapters in a fresh browser profile.
// No desktop/user storage is read. POSTs and external traffic are blocked.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `director-single-selection-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__director_single_selection_fixture.html';
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'director single selection UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const blockedRequests = []; const checks = []; const screenshots = [];
const capture = async (name) => {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false, animations: 'disabled' });
  screenshots.push(`${name}.png`);
};
const sidebar = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true });
const mode = (value) => page.getByRole('group', { name: '视频生产模式', exact: true }).getByRole('button', { name: value === 'single' ? /单段(?:直出|演出)/ : '长剧情拆段' });
const editor = () => page.getByRole('textbox', { name: '本次生成使用的完整提示词', exact: true });
const expectPrompt = async (value, h3 = true) => {
  const locator = h3 ? page.getByRole('region', { name: 'H3提示词原文', exact: true }) : page.getByRole('region', { name: '视频提示词正文', exact: true });
  await locator.waitFor();
  await waitForCondition({ label: 'selected director prompt', timeoutMs: 10_000, intervalMs: 75, check: async () => await locator.textContent() === value });
  assert.equal(await locator.textContent(), value);
};
const expectEditor = async (value) => {
  await editor().waitFor();
  await waitForCondition({ label: 'selected video prompt', timeoutMs: 10_000, intervalMs: 75, check: async () => await editor().inputValue() === value });
  assert.equal(await editor().inputValue(), value);
};
const waitStored = async (chapterId, expected) => {
  await page.waitForFunction(({ key, chapterId, expected }) => {
    const project = JSON.parse(localStorage.getItem(key) || '{}').project;
    const controls = project?.chapterWorkspaces?.[chapterId]?.directorControls;
    return controls && Object.entries(expected).every(([key, value]) => controls[key] === value);
  }, { key: storageKey, chapterId, expected });
};
const switchChapter = async (id) => {
  await page.getByRole('combobox', { name: '当前章节', exact: true }).selectOption(id);
};

const run = async () => {
  await waitForCondition({ label: 'director selection Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if ((request.method() !== 'GET' && request.method() !== 'HEAD') || url.origin !== origin) {
      blockedRequests.push({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic director selection fixture</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  const fixtures = await page.evaluate(async ({ key }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { officialH3ContextForStoryboard } = await import('/src/officialH3Context.ts');
    const { emptyVideoDraft } = await import('/src/videoDirectorDraft.ts');
    const state = createInitialState(); const now = Date.now();
    const project = { ...state.project, id: 'director-selection-project', name: '单段与长剧情隔离验证', activeChapterId: 'chapter-a',
      sourceDocuments: [], chapterWorkspaces: {}, scenes: [], storyboards: [], sequencePlans: [], characters: [], locations: [], props: [], assets: [], generationTasks: [],
      createdAt: now, updatedAt: now, directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now };
    const addBoard = (chapter, id, title, content, segment, plan, durationSec = 15) => {
      const canonical = `【0s-${durationSec}s】主体：旅人；空间：石桥与石阶；光影：自然晨光；镜头：稳定中景；动作：${content}；台词：无；音效：无配乐，无对白。`;
      const source = { id, chapterId: chapter.id, sceneId: `${chapter.id}-scene`, sourceSceneIds: [`${chapter.id}-scene`], sourceStoryTitle: title,
        sourceStoryContent: content, sourceContentHash: sourceContentHash(content),
        ...(segment ? { sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: plan.segments.length } : {}),
        workflow: 'drama', inputMode: 'text', durationSec, durationPreset: durationSec === 10 ? '10s' : '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
        stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3',
        globalLock: '', globalReferenceAssetIds: [], extraRequirement: '', finalPrompt: canonical,
        shots: [{ id: `${id}-shot`, index: 1, startSec: 0, endSec: durationSec, subject: '旅人', action: content, purpose: '推进动作', camera: '稳定中景', lighting: '自然晨光', sound: '', transition: '顺接', result: content, referenceAssetIds: [], prompt: canonical, locked: false, authoredBy: 'text-api' }],
        promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [chapter.id], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
      const context = officialH3ContextForStoryboard(project, source);
      const board = applyOfficialH3Prompt(source, context);
      board.officialPromptEn = board.officialPromptZh.replace(/[\p{Script=Han}]+/gu, ' English scene description ');
      board.officialPromptEnSource = board.officialPromptZh;
      board.englishPrompt = `A traveler crosses a stone bridge under soft morning light. Medium shot, steady camera. ${id}. No dialogue or music.`;
      board.englishPromptSource = canonical;
      if (!hasCurrentOfficialH3Prompt(board, context) || !hasCurrentOfficialH3EnglishPrompt(board, context)) throw new Error(`Fixture must have current bilingual H3: ${id}`);
      project.storyboards.push(board);
      if (segment) { segment.storyboardId = board.id; segment.status = 'ready'; }
      return board;
    };
    for (const [suffix, count] of [['a', 6], ['b', 2]]) {
      const id = `chapter-${suffix}`;
      const parts = Array.from({ length: count }, (_, index) => `旅人沿石桥走过第${index + 1}块石板。`);
      const chapter = { id, name: `合成章节 ${suffix.toUpperCase()}`, content: parts.join('\n'), order: suffix === 'a' ? 0 : 1, archived: false, createdAt: now, updatedAt: now };
      project.sourceDocuments.push(chapter);
      project.scenes.push({ id: `${id}-scene`, chapterId: id, title: chapter.name, content: chapter.content, sourceDocumentId: id, sourceContentHash: sourceContentHash(chapter.content), summary: '', characterIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now });
      const plan = materializeSemanticSequencePlan({ title: chapter.name, story: chapter.content, segmentDurationSec: 15,
        directorSettingsFingerprint: 'synthetic-director-settings', creativeDirection: { cameraTerms: ['稳定中景'], lightingTerms: ['自然晨光'], extraRequirement: '' }, characterContinuity: [], sourceSceneIds: [`${id}-scene`], shotMode: 'auto',
      }, { segmentCount: count, reason: '合成连续完整窗口', fitStatus: 'balanced', segments: parts.map((content, index) => ({
        title: `${chapter.name}第${index + 1}段`, content, summary: content, narrativePurpose: '推进动作', entryState: index ? parts[index - 1] : '站在石桥', exitState: content, transitionHint: '动作接续', boundaryReason: '完整动作', continuityPack: '保持旅人与石桥',
        semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: `${id}-event-${index + 1}`, description: content }], dialogues: [] },
      })) }, { planId: `${id}-plan`, now });
      plan.chapterId = id; project.sequencePlans.push(plan);
      for (const segment of plan.segments) addBoard(chapter, `${id}-long-${segment.index}`, segment.title, segment.content, segment, plan);
      plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
      if (suffix === 'b') {
        addBoard(chapter, 'chapter-b-single-1', '合成独立稿一', '旅人停在石桥入口。', undefined, undefined, 10);
        addBoard(chapter, 'chapter-b-single-2', '合成独立稿二', '旅人在石桥中央回头。');
      }
      project.scenes.at(-1).storyboardIds = project.storyboards.filter((board) => board.chapterId === id).map((board) => board.id);
      project.chapterWorkspaces[id] = {
        storyDraft: { name: chapter.name, content: chapter.content, updatedAt: now },
        directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now,
        directorControls: { activeSceneId: `${id}-scene`, activeStoryboardId: `${id}-long-${count}`,
          ...(suffix === 'b' ? { activeSingleStoryboardId: 'chapter-b-single-2' } : {}), productionMode: 'single', activePlanId: plan.id, activeSegmentId: plan.segments.at(-1).id,
          sequenceStage: 'direct', sequenceSettingsOpen: false, confirmedSequencePlanFingerprint: plan.reviewConfirmedFingerprint, generationPromptFormat: 'h3' },
        videoDirector: { draft: emptyVideoDraft(state.settings), parameterText: '{}', parameterDrafts: [], generationMode: 'single' },
      };
    }
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api';
    for (const api of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi']) state.settings[api].enabled = false;
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.ui = { ...state.ui, activeView: 'director' };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    return Object.fromEntries(project.storyboards.map((board) => [board.id, { id: board.id, zh: board.officialPromptZh, en: board.officialPromptEn, ordinaryZh: board.finalPrompt, ordinaryEn: board.englishPrompt }]));
  }, { key: storageKey });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await sidebar('提示词导演台').click();
  await page.getByText('尚未生成单段提示词', { exact: true }).waitFor();
  assert.equal(await mode('single').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.director-result-copy').count(), 0);
  assert.equal(await page.locator('.prompt-video-links').count(), 0);
  await capture('single-empty-with-existing-long-six');
  checks.push('legacy single-mode selection of long segment six shows an explicit empty single result');

  await mode('sequence').click();
  await expectPrompt(fixtures['chapter-a-long-6'].zh);
  await sidebar('视频导演台').click();
  await expectEditor(fixtures['chapter-a-long-6'].zh);
  checks.push('sidebar navigation prefills an empty single-video draft from the visible long segment');

  await sidebar('提示词导演台').click(); await switchChapter('chapter-b');
  await expectPrompt(fixtures['chapter-b-single-2'].zh);
  await mode('sequence').click(); await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await mode('single').click(); await expectPrompt(fixtures['chapter-b-single-2'].zh);
  await waitStored('chapter-b', { productionMode: 'single', activeSingleStoryboardId: 'chapter-b-single-2' });
  await page.reload({ waitUntil: 'networkidle' }); await sidebar('提示词导演台').click();
  await expectPrompt(fixtures['chapter-b-single-2'].zh);
  await mode('sequence').click(); await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await waitStored('chapter-b', { productionMode: 'sequence', activeSingleStoryboardId: 'chapter-b-single-2' });
  await page.reload({ waitUntil: 'networkidle' }); await sidebar('提示词导演台').click();
  await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await mode('single').click(); await expectPrompt(fixtures['chapter-b-single-2'].zh);
  checks.push('two independent single drafts and the selected long segment retain separate selection through mode switches and reloads');

  await sidebar('分镜时间线').click();
  await page.getByRole('combobox', { name: '筛选分镜方案', exact: true }).selectOption('__standalone__');
  await page.locator('.storyboard-plan-content').getByRole('button', { name: /^10秒 · 1镜/ }).click();
  await sidebar('提示词导演台').click(); await expectPrompt(fixtures['chapter-b-single-1'].zh);
  await waitStored('chapter-b', { activeSingleStoryboardId: 'chapter-b-single-1' });
  await mode('sequence').click(); await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await mode('single').click(); await expectPrompt(fixtures['chapter-b-single-1'].zh);
  await page.getByRole('group', { name: '官方提示词格式', exact: true }).getByRole('button', { name: '普通原稿', exact: true }).click();
  await page.getByRole('group', { name: '普通原稿语言', exact: true }).getByRole('button', { name: 'English', exact: true }).click();
  await expectPrompt(fixtures['chapter-b-single-1'].ordinaryEn, false);
  await sidebar('视频导演台').click(); await expectEditor(fixtures['chapter-b-single-1'].ordinaryEn);
  await capture('single-video-visible-ordinary-english');
  checks.push('timeline single selection is remembered; sidebar passes the exact displayed ordinary English draft');

  const manual = '合成手工视频草稿：保留这段经过编辑的正文。';
  await editor().fill(manual);
  await sidebar('提示词导演台').click(); await mode('sequence').click();
  await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await sidebar('视频导演台').click(); await expectEditor(manual);
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  assert.equal(await page.locator('.vd-batch-row input[type="checkbox"]:checked').count(), 2);
  await sidebar('提示词导演台').click(); await mode('single').click();
  await expectPrompt(fixtures['chapter-b-single-1'].zh);
  await sidebar('视频导演台').click();
  assert.equal(await page.getByRole('tab', { name: '长剧情批量', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.vd-batch-row input[type="checkbox"]:checked').count(), 2);
  await page.getByRole('tab', { name: '单段生成', exact: true }).click(); await expectEditor(manual);
  checks.push('sidebar navigation preserves hand-edited text, batch mode, and prepared batch selections');

  await sidebar('提示词导演台').click(); await mode('sequence').click();
  await expectPrompt(fixtures['chapter-b-long-2'].zh);
  await page.getByRole('button', { name: '送到视频导演台', exact: true }).click();
  await expectEditor(fixtures['chapter-b-long-2'].zh);
  assert.equal(await page.getByRole('tab', { name: '单段生成', exact: true }).getAttribute('aria-selected'), 'true');
  checks.push('explicit send still replaces an existing video draft with the displayed prompt');

  await switchChapter('chapter-a'); await expectEditor(fixtures['chapter-a-long-6'].zh);
  await sidebar('提示词导演台').click(); await mode('single').click();
  await page.getByText('尚未生成单段提示词', { exact: true }).waitFor();
  await switchChapter('chapter-b'); await mode('single').click(); await expectPrompt(fixtures['chapter-b-single-1'].zh);
  await waitStored('chapter-b', { activeSingleStoryboardId: 'chapter-b-single-1', productionMode: 'single' });
  await capture('chapter-specific-single-selection');
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(stored.project.chapterWorkspaces['chapter-a'].videoDirector.draft.prompt, fixtures['chapter-a-long-6'].zh);
  assert.equal(stored.project.chapterWorkspaces['chapter-b'].videoDirector.draft.prompt, fixtures['chapter-b-long-2'].zh);
  assert.equal(stored.project.generationTasks.length, 0);
  for (const [id, fixture] of Object.entries(fixtures)) {
    const board = stored.project.storyboards.find((candidate) => candidate.id === id);
    assert.equal(board.finalPrompt, fixture.ordinaryZh); assert.equal(board.officialPromptZh, fixture.zh); assert.equal(board.officialPromptEn, fixture.en);
  }
  assert.deepEqual(blockedRequests, [], 'navigation must not attempt model/video requests');
  assert.deepEqual(errors, []);
  checks.push('chapter controls/video drafts remain isolated and all source prompts stay unchanged; no model/API submissions');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, screenshots, blockedRequests, errors }, null, 2));
  console.log(`Director single selection UI QA passed. Report: ${path.join(output, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, screenshots, blockedRequests, errors, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
