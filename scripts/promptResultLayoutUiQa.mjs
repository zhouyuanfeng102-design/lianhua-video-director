import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App, deterministic persisted prompts, a new ephemeral browser context,
// and no desktop bridge. Every POST and every non-loopback request is blocked.
// QA_EXPECT_BROKEN=1 records a before report without layout assertions.
// The normal prompt target is 360 CSS pixels. Large columns and the workspace
// must never scroll: controls must already be visible before any interaction.
// Only bounded text boxes may scroll; no visibility check scrolls an ancestor.
// QA_FOCUS=compact-font130 runs the formerly clipped small-window case first.
// QA_FOCUS=compact-error-font130 isolates long errors plus expanded evidence.
// QA_FOCUS=sequence-states covers the first segment before generation, a
// failed segment with no result, and a delivered segment at four widths and
// both 100%/130% font scales. This must not rely on :has(.director-result-copy).
const root = path.resolve(import.meta.dirname, '..');
const before = process.env.QA_EXPECT_BROKEN === '1';
const focus = process.env.QA_FOCUS || '';
if (focus && !['compact-font130', 'compact-error-font130', 'sequence-states', 'dialogue-repair-controls'].includes(focus)) throw new Error(`Unknown prompt layout QA focus: ${focus}`);
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `prompt-result-layout-${before ? 'before' : 'after'}-${Date.now()}`));
const relativeOutput = path.relative(outputBase, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Prompt layout QA output must remain below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Prompt layout QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePage = '/__prompt_result_layout_fixture.html';
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'qa-prompt-result-layout-project';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'prompt result layout UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let fixture;
const errors = []; const blockedRequests = []; const records = []; const violations = []; const steps = [];
const viewports = [
  { width: 1280, height: 720 }, { width: 1366, height: 768 },
  { width: 1600, height: 900 }, { width: 1920, height: 1080 },
  { width: 1780, height: 1115 },
];
const sourceParts = [
  '师傅与徒弟站在山道石阶旁，师傅从药篓取出一株药草。',
  '师傅说：“接稳这株药草。”她将药草递到徒弟伸出的手前，双方的手指尚未完成交接。',
  '徒弟伸手接取药草，师傅的手指仍触着药草的根部。',
  '徒弟说：“好，我会小心。”他握稳药草后把药篓背带递向师傅抬起的右手。',
  '师傅伸手接取徒弟递来的药篓背带，双方的手仍靠在一起。',
  '师傅将药篓背好，与徒弟沿着同一条山道继续前行。',
];
const story = sourceParts.join('');
const settle = () => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const capture = (name) => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false });
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-all-sections').waitFor();
};
const check = (condition, message) => { if (!before && !condition) violations.push(message); };
const outerContainerSelector = [
  'html', 'body', '.app-shell', '.app-shell > main', '.workspace.view-director',
  '.director-view', '.director-source-card', '.director-stage', '.director-work-grid',
  '.director-control-card', '.director-setup-body', '.director-setup-section',
  '.director-side-panel', '.director-result-pane', '.sequence-result-status',
  '.empty-result-pane > .empty',
  '.director-generate-bar', '.sequence-generation-actions', '.director-result-actions',
].join(', ');

const configurePage = async (scale = 1) => {
  context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: scale, serviceWorkers: 'block' });
  page = await context.newPage();
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
      blockedRequests.push({ method: request.method(), origin: url.origin, path: url.pathname });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePage) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Isolated prompt result layout QA</title><body>Fixture only</body></html>' }); return;
    }
    await route.continue();
  });
};

const createFixture = async () => {
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, projectId, story }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const characters = [
      { id: 'layout-teacher', name: '师傅', gender: '女', apparentAge: '35岁成年', race: '人类', appearance: '黑发盘起，固定面容', outfit: '青色长衣', signatureProps: '药篓', personality: '沉稳', motionHabits: '动作平稳', anchor: '青色长衣', negativeContinuity: '', assetIds: [] },
      { id: 'layout-student', name: '徒弟', gender: '男', apparentAge: '25岁成年', race: '人类', appearance: '短黑发，固定面容', outfit: '灰色长衣', signatureProps: '无', personality: '认真', motionHabits: '双手接物', anchor: '灰色长衣', negativeContinuity: '', assetIds: [] },
    ];
    const scene = { id: 'layout-scene', title: '山道交接', content: story, summary: '山道递药草与接取药篓的连续动作', characterIds: characters.map((entry) => entry.id), locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: projectId, name: '提示词正文优先 · 隔离布局验收', characters, locations: [], props: [],
      sourceDocuments: [{ id: 'layout-source', name: scene.title, content: story, createdAt: now, updatedAt: now }],
      scenes: [scene], storyboards: [], sequencePlans: [], assets: [], generationTasks: [], createdAt: now, updatedAt: now,
      directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    for (const api of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi']) state.settings[api].enabled = false;
    state.settings.runningHubVideo.enabled = false; state.settings.uiFontScalePercent = 100;
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, projectId, story });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.locator('#sequence-director-settings-panel #director-setup-timing').getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.waitForFunction((key) => Boolean(JSON.parse(localStorage.getItem(key))?.project?.directorSettingsConfirmedFingerprint), storageKey);
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(async ({ key, sourceParts, story }) => {
    const { buildLocalSequencePlan, extractStoryBeats, validateSequencePlan } = await import('/src/storySegmentation.ts');
    const { masterPromptConfirmationFingerprint } = await import('/src/masterTimeline.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { buildSequencePromptHandoff, stampSequencePromptHandoff } = await import('/src/sequencePromptHandoff.ts');
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const now = Date.now();
    const plan = buildLocalSequencePlan({ title: '山道交接', story, totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [project.scenes[0].id] });
    const beats = extractStoryBeats(story); let cursor = 0;
    const detailedAction = '人物手指与道具接触关系清晰，身体重心连续，视线跟随交接中的药草和背带，衣料褶皱随动作变化，保持清晨同一侧光。'.repeat(7);
    const shots = sourceParts.map((part, index) => {
      const start = cursor; cursor += part.length; const startSec = index * 7.5; const endSec = startSec + 7.5;
      const dialogue = index === 1 ? '第1s @师傅:"接稳这株药草。"' : index === 3 ? '第1s @徒弟:"好，我会小心。"' : '无';
      const prompt = `【${startSec}s-${endSec}s】主体：@师傅与@徒弟（专注平静）[朝向：彼此双手] 正在 [${part}${detailedAction}]（连贯交接药草与药篓）；空间：前景药草，中景师傅在左徒弟在右，背景山道石阶；光影：清晨柔和侧光；镜头：稳定中景侧拍；台词：${dialogue}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
      return { id: `layout-master-shot-${index + 1}`, index: index + 1, startSec, endSec, subject: '师傅与徒弟', action: `${part}${detailedAction}`,
        purpose: '连贯交接药草与药篓', camera: '稳定中景侧拍', lighting: '清晨柔和侧光', sound: '', transition: '自然承接', result: part,
        sourceStart: start, sourceEnd: cursor, sourceExcerpt: part, sourceBeatIds: beats.filter((beat) => beat.sourceStart < cursor && beat.sourceEnd > start).map((beat) => beat.id),
        referenceAssetIds: [], prompt, locked: false, authoredBy: 'text-api' };
    });
    const canonical = shots.map((shot) => shot.prompt).join('\n');
    const master = { id: 'layout-master', sceneId: project.scenes[0].id, sequencePlanId: plan.id, sourceStoryTitle: '山道交接', sourceStoryContent: story,
      workflow: 'drama', inputMode: 'text', durationSec: 45, durationPreset: 'custom', shotMode: 'exact', shotCount: 6, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video',
      globalLock: '师傅在左，徒弟在右；二人保持青衣与灰衣，山道方向和清晨光线不变。', shots, finalPrompt: canonical, targetModelId: 'minimax-h3',
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId,
        converterPresetId: 'converter_unified_video', sourceDocumentIds: ['layout-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    plan.masterStoryboardId = master.id; plan.planningStage = 'segmented'; plan.segmentationSource = 'ai'; plan.segmentationReason = '隔离fixture已确认母镜头分配'; plan.fitStatus = 'balanced';
    plan.masterPromptDirectorSettingsFingerprint = project.directorSettingsConfirmedFingerprint; plan.masterPromptDirectorSettingsConfirmedAt = now;
    plan.segments.forEach((segment, index) => {
      const owned = shots.slice(index * 2, index * 2 + 2); Object.assign(segment, {
        title: `第${index + 1}段·${['递出药草', '接草递篓', '接篓同行'][index]}`, content: sourceParts.slice(index * 2, index * 2 + 2).join(''), summary: `山道连续动作第${index + 1}段`,
        sourceShotIds: owned.map((shot) => shot.id), sourceBeatIds: [...new Set(owned.flatMap((shot) => shot.sourceBeatIds))], globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15,
        narrativePurpose: '连贯交接药草与药篓', entryState: index ? '药草或背带交接正在发生' : '二人山道相对站立', exitState: '双方的手仍靠近，交接动作自然延续',
        continuityPack: '准确承接上段末镜动作，不改变左右关系和衣着', transitionHint: '下一段首镜保留约0.5秒同一交接动作的视觉重合', boundaryReason: '已确认完整镜头分配', status: 'ready', locked: false,
        storyboardId: `layout-segment-board-${index + 1}`,
      });
    });
    plan.masterPromptConfirmedAt = now; plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, master);
    plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    project.storyboards = [master]; project.sequencePlans = [plan];
    const officialContext = { assets: [], characters: project.characters, locations: [], props: [], sceneContent: story };
    for (const segment of plan.segments) {
      const segmentShots = shots.slice((segment.index - 1) * 2, segment.index * 2).map((shot, index) => ({
        ...shot, id: `${segment.storyboardId}-shot-${index + 1}`, index: index + 1, startSec: index * 7.5, endSec: (index + 1) * 7.5,
        prompt: shot.prompt.replace(/^【[^】]+】/u, `【${index * 7.5}s-${(index + 1) * 7.5}s】`),
      }));
      const finalPrompt = segmentShots.map((shot) => shot.prompt).join('\n');
      let board = applyOfficialH3Prompt({ ...master, id: segment.storyboardId, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3,
        sourceStoryTitle: segment.title, sourceStoryContent: segment.content, durationSec: 15, durationPreset: '15s', shotCount: 2, shots: segmentShots, finalPrompt,
        promptTrace: { ...master.promptTrace, convertedPromptFingerprint: sourceContentHash(finalPrompt) },
      }, officialContext);
      // A persisted reviewed delivery may be longer than the concise local
      // compiler output. Preserve its real H3 protocol and source fingerprint,
      // while guaranteeing overflow even at the widest regression viewport.
      const reviewedDetail = Array.from({ length: 12 }, (_unused, index) => `动作细节${index + 1}：药草的叶片保持完整可见，人物手掌缓慢接近并维持准确的接触位置，山道背景层次、晨光方向和服装轮廓连续，摄影机固定在同一侧记录自然完成的交接。`).join('\n');
      board.officialPromptZh = board.officialPromptZh.replace(/\noverall_soundscape:/u, `\n${reviewedDetail}\noverall_soundscape:`);
      board.targetOutput = { ...board.targetOutput, prompt: board.officialPromptZh };
      const preserved = [];
      const english = board.officialPromptZh.replace(/"[^"\n]*"|“[^”\n]*”|师傅|徒弟/gu, (value) => {
        const token = `__QA_KEEP_${preserved.length}__`; preserved.push(value); return token;
      }).replace(/[\p{Script=Han}]+/gu, ' English scene description ')
        .replace(/__QA_KEEP_(\d+)__/gu, (_all, index) => preserved[Number(index)]);
      board.officialPromptEn = english; board.officialPromptEnSource = board.officialPromptZh;
      board.englishPrompt = english; board.englishPromptSource = board.finalPrompt;
      if (segment.index > 1) {
        const handoff = buildSequencePromptHandoff(project, plan.id, segment.id);
        if (!handoff.context) throw new Error(`Fixture handoff invalid: ${handoff.issue}`);
        board = stampSequencePromptHandoff(board, handoff.context);
      }
      if (!hasCurrentOfficialH3Prompt(board, officialContext) || !hasCurrentOfficialH3EnglishPrompt(board, officialContext)) throw new Error('Fixture needs valid, current bilingual H3 prompts');
      project.storyboards.push(board);
    }
    const issues = validateSequencePlan(plan, { requireMasterStoryboard: true, storyboards: project.storyboards });
    if (issues.length) throw new Error(`Invalid isolated layout plan: ${issues.join('; ')}`);
    project.scenes[0].storyboardIds = project.storyboards.map((board) => board.id);
    state.projects = [project]; localStorage.setItem(key, JSON.stringify(state)); return state;
  }, { key: storageKey, sourceParts, story });
};

const installFixture = async (scenario, fontScale = 100) => {
  const state = structuredClone(fixture); const project = state.project;
  state.settings.uiFontScalePercent = fontScale;
  const emptyResult = ['sequence-empty', 'sequence-failed'].includes(scenario);
  if (emptyResult) {
    project.storyboards = project.storyboards.filter((board) => !board.segmentId);
    project.scenes[0].storyboardIds = project.storyboards.map((board) => board.id);
    for (const segment of project.sequencePlans[0].segments) {
      delete segment.storyboardId;
      segment.status = scenario === 'sequence-failed' && segment.index === 1 ? 'failed' : 'planned';
      segment.failureReason = segment.status === 'failed'
        ? '当前段生成未完成：上游服务连接超时，已保存全片规划和15秒边界。AI自动修复请求未返回有效H3交付稿，请重试本段。'
        : undefined;
    }
  }
  if (scenario.startsWith('single')) {
    const board = project.storyboards.find((item) => item.id === 'layout-segment-board-2');
    for (const key of ['sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount', 'sequencePromptHandoff']) delete board[key];
    project.storyboards = [board]; project.sequencePlans = []; project.scenes[0].storyboardIds = [board.id];
  }
  if (scenario.endsWith('error')) {
    const board = project.storyboards.find((item) => item.id === 'layout-segment-board-2');
    board.officialPromptEn = ''; board.officialPromptEnSource = ''; board.englishPrompt = ''; board.englishPromptSource = '';
    board.officialPromptEnError = '英文生成未完成：请检查连接后仅重试英文，已保存的中文提示词与原镜头时长保持不变。'.repeat(14);
    if (project.sequencePlans[0]) project.sequencePlans[0].segments[1].failureReason = '上一阶段出现可恢复错误，本段中文已经保留；请查看完整原因并选择相应重试操作。'.repeat(14);
  }
  state.projects = [project];
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, state }) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); }, { key: storageKey, state });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
  if (scenario.startsWith('sequence')) {
    await clickVisible(page.locator('.sequence-director-strip .sequence-segment-chip').nth(emptyResult ? 0 : 1), `${scenario}: select the audited segment`);
    if (!emptyResult) {
      await page.getByLabel('本段文本衔接状态', { exact: true }).waitFor();
      assert.match(await page.getByLabel('本段文本衔接状态', { exact: true }).innerText(), /已按第 1 段末镜完成文本衔接/u);
    }
  }
  await page.locator(emptyResult ? '.empty-result-pane' : '.director-result-copy').waitFor(); await settle();
  if (emptyResult) assert.match(await page.locator('.empty-result-pane > .empty > strong').innerText(), scenario === 'sequence-failed' ? /第 1 段生成失败/u : /第 1 段尚未生成/u);
  assert.equal(await page.locator('.app-shell').getAttribute('data-ui-font-scale'), String(fontScale), 'fixture must apply the requested real UI font scale');
};

const measure = (label) => page.evaluate(({ label, outerContainerSelector }) => {
  const rect = (element) => {
    if (!element?.getClientRects().length) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const prompt = document.querySelector('.director-result-copy');
  // H3PromptDisplay keeps its toolbar fixed and owns the text-only scroll in
  // the body. Fall back to the legacy prompt container for older fixtures.
  const promptScroller = prompt?.querySelector('.h3-prompt-display-body') || prompt;
  const pane = document.querySelector('.director-result-pane');
  const emptyResult = Boolean(pane?.classList.contains('empty-result-pane'));
  const status = pane?.querySelector('.sequence-result-status'); const actions = pane?.querySelector('.director-result-actions');
  const visibility = (element) => {
    const r = rect(element); if (!r) return { complete: false, hit: false, visible: null };
    const visible = { x: Math.max(0, r.x), y: Math.max(0, r.y), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor); const clip = rect(ancestor); if (!clip) continue;
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { visible.x = Math.max(visible.x, clip.x); visible.right = Math.min(visible.right, clip.right); }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { visible.y = Math.max(visible.y, clip.y); visible.bottom = Math.min(visible.bottom, clip.bottom); }
    }
    visible.width = Math.max(0, visible.right - visible.x); visible.height = Math.max(0, visible.bottom - visible.y);
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { complete: visible.width >= r.width - 1 && visible.height >= r.height - 1, hit: hit === element || element.contains(hit), visible };
  };
  const measureContainer = (element) => ({
    name: element.id || `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().replace(/\s+/gu, '.')}` : ''}`,
    rect: rect(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
    overflowY: getComputedStyle(element).overflowY, ...visibility(element),
  });
  const outerContainers = [...document.querySelectorAll(outerContainerSelector)].filter((element) => element.getClientRects().length).map(measureContainer);
  const measureActionRow = (container, selector) => {
    if (!container) return null;
    const items = [...container.querySelectorAll(selector)].filter((element) => element.getClientRects().length).map((element) => {
      const r = rect(element); const text = element.querySelector('.director-option-name')
        || element.querySelector(':scope > span:not(.director-option-icon):not(.director-option-check)') || element;
      const textBox = rect(text); const textRects = [];
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const part of range.getClientRects()) if (part.width > 0) textRects.push({ x: part.x, y: part.y, right: part.right, bottom: part.bottom });
      }
      const textLines = [...new Set(textRects.map((part) => Math.round(part.y * 10) / 10))].length;
      const textClipBounds = { ...r };
      // A short line-height can make font Range boxes taller than a span's
      // layout box without clipping any glyphs. Only actual overflow-clipping
      // ancestors constrain that text; the outer button is always a boundary.
      for (let ancestor = text; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); const clip = rect(ancestor);
        if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { textClipBounds.x = Math.max(textClipBounds.x, clip.x); textClipBounds.right = Math.min(textClipBounds.right, clip.right); }
        if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { textClipBounds.y = Math.max(textClipBounds.y, clip.y); textClipBounds.bottom = Math.min(textClipBounds.bottom, clip.bottom); }
      }
      const textClipped = textRects.some((part) => part.x < textClipBounds.x - 1 || part.right > textClipBounds.right + 1
        || part.y < textClipBounds.y - 1 || part.bottom > textClipBounds.bottom + 1);
      return { name: text.textContent.trim(), rect: r, textBox, textClipBounds, textRects, textLines, textClipped, ...visibility(element),
        fontSize: parseFloat(getComputedStyle(text).fontSize), whiteSpace: getComputedStyle(text).whiteSpace };
    });
    const centers = items.map((item) => item.rect.y + item.rect.height / 2);
    return { rect: rect(container), clientWidth: container.clientWidth, scrollWidth: container.scrollWidth, ...visibility(container),
      rowCenterSpread: centers.length ? Math.max(...centers) - Math.min(...centers) : null, items };
  };
  const bottomRows = {
    left: measureActionRow(document.querySelector('.director-generate-bar .sequence-generation-actions'), ':scope > button'),
    right: measureActionRow(actions || pane?.querySelector('.empty .row'), ':scope > button, :scope > .storyboard-image-count-control'),
  };
  const leftSections = [...document.querySelectorAll('.director-all-sections > .director-setup-section')].map((element) => ({
    id: element.id, rect: rect(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY, ...visibility(element),
  }));
  const leftControls = [...document.querySelectorAll('.director-setup-body button, .director-setup-body input, .director-setup-body select, .director-setup-body textarea')]
    .filter((element) => element.getClientRects().length).map((element) => ({
      name: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent.trim() || element.tagName,
      rect: rect(element), section: rect(element.closest('.director-setup-section')), ...visibility(element),
    }));
  const intersectionPairs = (items) => items.flatMap((item, index) => items.slice(index + 1)
    .filter((other) => item.rect.x < other.rect.right - 1 && item.rect.right > other.rect.x + 1 && item.rect.y < other.rect.bottom - 1 && item.rect.bottom > other.rect.y + 1)
    .map((other) => [item.name || item.id, other.name || other.id]));
  const leftAuxiliary = [...document.querySelectorAll('.director-setup-body .field-hint, .director-setup-body .recommendation-strip')]
    .filter((element) => element.getClientRects().length).map((element) => {
      const r = rect(element); const clipBounds = { ...r };
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); const clip = rect(ancestor);
        if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { clipBounds.x = Math.max(clipBounds.x, clip.x); clipBounds.right = Math.min(clipBounds.right, clip.right); }
        if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { clipBounds.y = Math.max(clipBounds.y, clip.y); clipBounds.bottom = Math.min(clipBounds.bottom, clip.bottom); }
      }
      return { name: `${element.closest('.director-setup-section')?.id}: ${element.textContent.trim().slice(0, 70)}`, rect: r, clipBounds, ...visibility(element),
        clipped: clipBounds.right - clipBounds.x < r.width - 1 || clipBounds.bottom - clipBounds.y < r.height - 1 };
    });
  const leftLayout = { sections: leftSections, sectionOverlaps: intersectionPairs(leftSections), controls: leftControls,
    controlOverlaps: intersectionPairs(leftControls), auxiliary: leftAuxiliary,
    buttonText: measureActionRow(document.querySelector('.director-setup-body'), 'button')?.items || [] };
  const controls = [...document.querySelectorAll('.director-result-pane button, .director-result-pane input, .director-result-pane summary, .director-generate-bar button, .director-reference-head button, .director-reference-head h2, .director-result-head h2')]
    .filter((element) => element.getClientRects().length).map((element) => {
      return { name: element.getAttribute('aria-label') || element.textContent.trim(), rect: rect(element), ...visibility(element), fontSize: parseFloat(getComputedStyle(element).fontSize) };
    });
  const requiredControlSelectors = emptyResult ? [
    ['result panel heading', '.director-reference-head h2'],
    ['left parameter heading', '.director-setup-head'],
    ['empty result heading', '.empty-result-pane > .empty > strong'],
  ] : [
    ['result heading', '.director-result-head h2'], ['result panel heading', '.director-reference-head h2'],
    ['Chinese language', '.result-language-card.zh'], ['English language', '.result-language-card.en'],
    ['copy prompt', '.result-language-tools > button'], ['send to video director', '.director-result-bridge > button:not([aria-haspopup])'],
    ['left parameter heading', '.director-setup-head'],
  ];
  const requiredControls = requiredControlSelectors.map(([name, selector]) => ({ name, selector, rect: rect(document.querySelector(selector)), ...visibility(document.querySelector(selector)) }));
  const textBoxes = [...document.querySelectorAll('.director-result-copy, .sequence-text-handoff-details[open], .sequence-segment-error-text, .empty-result-pane > .empty > .small-text, .director-view textarea')]
    .filter((element) => element.getClientRects().length).map((element) => {
      const originalTop = element.scrollTop; element.scrollTop = 100; const scrollTest = element.scrollTop;
      const summary = element.querySelector('summary'); const summaryAfterScroll = summary ? visibility(summary) : null;
      element.scrollTop = originalTop;
      return { ...measureContainer(element), scrollTest, summaryAfterScroll, textLength: (element.value || element.textContent).length };
    });
  const children = [...pane.children].filter((element) => element.getClientRects().length).map((element) => ({ className: element.className, rect: rect(element) }));
  const overlaps = children.flatMap((child, index) => children.slice(index + 1).filter((other) => child.rect.x < other.rect.right - 1 && child.rect.right > other.rect.x + 1 && child.rect.y < other.rect.bottom - 1 && child.rect.bottom > other.rect.y + 1).map((other) => [child.className, other.className]));
  const promptRect = rect(prompt); const visible = visibility(prompt).visible;
  const originalTop = promptScroller?.scrollTop || 0; if (promptScroller) promptScroller.scrollTop = 100;
  const scrolled = promptScroller?.scrollTop || 0; if (promptScroller) promptScroller.scrollTop = originalTop;
  const columns = [document.querySelector('.director-control-card'), document.querySelector('.director-side-panel')].map((element) => ({ name: element.className, rect: rect(element) }));
  return { label, emptyResult, viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, fontScale: Number(document.querySelector('.app-shell')?.dataset.uiFontScale), prompt: promptRect, visiblePrompt: visible,
    promptClientHeight: promptScroller?.clientHeight || 0, promptScrollHeight: promptScroller?.scrollHeight || 0, promptOverflow: promptScroller ? getComputedStyle(promptScroller).overflowY : 'hidden',
    promptMinHeight: prompt ? parseFloat(getComputedStyle(prompt).minHeight) : 0, promptFlexShrink: prompt ? getComputedStyle(prompt).flexShrink : null,
    promptScrollTest: scrolled, promptFontSize: prompt ? parseFloat(getComputedStyle(prompt).fontSize) : 0, promptLength: prompt?.textContent.length || 0,
    pane: rect(pane), actions: rect(actions), status: rect(status), statusClientHeight: status?.clientHeight, statusScrollHeight: status?.scrollHeight,
    statusOverflow: status && getComputedStyle(status).overflowY, titleFontSize: parseFloat(getComputedStyle(pane.querySelector('h2') || pane.querySelector('.empty > strong')).fontSize),
    columns, columnOverlaps: intersectionPairs(columns),
    controls, requiredControls, controlOverlaps: intersectionPairs(controls), outerContainers, textBoxes,
    children, overlaps, bottomRows, leftLayout, documentScrollWidth: document.documentElement.scrollWidth, documentScrollHeight: document.documentElement.scrollHeight,
    windowScrollX: scrollX, windowScrollY: scrollY };
}, { label, outerContainerSelector });

const verifyVisible = async (locator, label, requireComplete = true) => {
  const hit = await locator.evaluate((element, requireComplete) => {
    const r = element.getBoundingClientRect(); let top = Math.max(0, r.top); let bottom = Math.min(innerHeight, r.bottom);
    let left = Math.max(0, r.left); let right = Math.min(innerWidth, r.right);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent); const p = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom); }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { left = Math.max(left, p.left); right = Math.min(right, p.right); }
    }
    if (bottom <= top || right <= left) return false;
    if ((requireComplete || element.matches('button, input, select, textarea, summary')) && (bottom - top < r.height - 1 || right - left < r.width - 1)) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit === element || element.contains(hit);
  }, requireComplete);
  check(hit, `${label}: must be visible and unobscured without scrolling`);
  return hit;
};

// Playwright's locator.click() can scroll a hidden control into view. Audited
// interactions use a visibility assertion followed by a direct pointer click.
const clickVisible = async (locator, label) => {
  const visible = await verifyVisible(locator, label);
  if (!visible && !before) throw new Error(`${label}: refusing to scroll a hidden control into view`);
  if (before) { await locator.evaluate((element) => element.click()); return; }
  const box = await locator.boundingBox();
  assert.ok(box, `${label}: control has no layout box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

const audit = async (scenario, viewport, language = 'zh') => {
  await page.setViewportSize(viewport); await settle();
  const label = `${scenario}-${viewport.width}x${viewport.height}-dpr${await page.evaluate(() => devicePixelRatio)}-${language}`;
  const result = await measure(label); records.push(result); await capture(label);
  const expandedText = /(?:evidence|error)/u.test(scenario);
  if (!result.emptyResult) {
    check(result.prompt.height >= (expandedText ? 160 : 240) - 1 && result.prompt.height <= 362,
    `${label}: prompt must retain at least ${expandedText ? 160 : 240}px of reading space, with a normal 360px target (got ${result.prompt.height.toFixed(1)}px)`);
  if (viewport.height >= 900 && !expandedText) check(Math.abs(result.prompt.height - 360) <= 2, `${label}: a roomy ordinary window must keep the normal 360px prompt height (got ${result.prompt.height.toFixed(1)}px)`);
  check(result.visiblePrompt.height >= result.prompt.height - 1 && result.visiblePrompt.width >= result.prompt.width - 1, `${label}: prompt reading area is cut off by an outer column`);
  check(result.promptClientHeight > 0 && result.promptScrollHeight > result.promptClientHeight + 1, `${label}: fixture must exercise a long scrollable prompt`);
  check(['auto', 'scroll'].includes(result.promptOverflow) && result.promptScrollTest > 0, `${label}: prompt text cannot scroll independently`);
    check(result.prompt.bottom <= result.actions.y + 1, `${label}: prompt overlaps its bottom actions`);
  }
  check(result.overlaps.length === 0, `${label}: sibling rows overlap ${JSON.stringify(result.overlaps)}`);
  check(result.columns.every((column) => column.rect) && result.columnOverlaps.length === 0, `${label}: left/right director columns overlap`);
  check(result.documentScrollWidth <= viewport.width + 1, `${label}: horizontal page overflow`);
  check(result.documentScrollHeight <= viewport.height + 1 && result.windowScrollX === 0 && result.windowScrollY === 0, `${label}: document must fit without page scrolling`);
  for (const container of result.outerContainers) {
    check(container.scrollHeight <= container.clientHeight && container.scrollTop === 0,
      `${label}: outer ${container.name} must not scroll vertically (${container.scrollHeight}/${container.clientHeight}px, top ${container.scrollTop})`);
    check(container.scrollWidth <= container.clientWidth && container.scrollLeft === 0,
      `${label}: outer ${container.name} must not scroll horizontally (${container.scrollWidth}/${container.clientWidth}px, left ${container.scrollLeft})`);
    check(container.complete, `${label}: outer ${container.name} is not fully inside its visible workspace`);
  }
  check(result.requiredControls.every((control) => control.rect && control.complete && control.hit),
    `${label}: required heading/language/copy/send controls are not initially visible: ${result.requiredControls.filter((control) => !control.rect || !control.complete || !control.hit).map((control) => control.name).join(', ')}`);
  check(result.controls.every((control) => control.complete && control.hit),
    `${label}: result/bottom controls are not initially visible: ${result.controls.filter((control) => !control.complete || !control.hit).map((control) => control.name).join(', ')}`);
  check(result.controlOverlaps.length === 0, `${label}: result/bottom controls overlap: ${JSON.stringify(result.controlOverlaps)}`);
  check(result.leftLayout.sections.length === 4 && result.leftLayout.sectionOverlaps.length === 0, `${label}: left parameter sections overlap or disappear`);
  check(result.leftLayout.sections.every((section) => section.complete && section.scrollHeight <= section.clientHeight), `${label}: left parameter sections must fit without scrolling or clipping: ${result.leftLayout.sections.filter((section) => !section.complete || section.scrollHeight > section.clientHeight).map((section) => `${section.id} ${section.scrollHeight}/${section.clientHeight}px`).join(', ')}`);
  check(result.leftLayout.auxiliary.every((item) => !item.clipped && item.complete), `${label}: field hint/recommendation strip crosses a clipping boundary: ${result.leftLayout.auxiliary.filter((item) => item.clipped || !item.complete).map((item) => item.name).join(', ')}`);
  check(result.leftLayout.controlOverlaps.length === 0, `${label}: left parameter controls overlap: ${JSON.stringify(result.leftLayout.controlOverlaps)}`);
  check(result.leftLayout.controls.every((control) => control.complete && control.hit), `${label}: left parameter controls must be immediately visible: ${result.leftLayout.controls.filter((control) => !control.complete || !control.hit).map((control) => control.name).join(', ')}`);
  check(result.leftLayout.controls.every((control) => !control.section || (control.rect.x >= control.section.x - 1 && control.rect.right <= control.section.right + 1 && control.rect.y >= control.section.y - 1 && control.rect.bottom <= control.section.bottom + 1)), `${label}: a left control extends beyond its clipped parameter section`);
  check(result.leftLayout.buttonText.every((button) => !button.textClipped), `${label}: left parameter button text clipped: ${result.leftLayout.buttonText.filter((button) => button.textClipped).map((button) => button.name).join(', ')}`);
  for (const [side, row] of Object.entries(result.bottomRows)) {
    check(Boolean(row?.items.length), `${label}: ${side} bottom action row must exist`);
    if (!row?.items.length) continue;
    if (side === 'right') check(row.items.length === (result.emptyResult ? 2 : 4), `${label}: right action row must keep all retry/return or result controls`);
    if (side === 'left') check(row.items.length === (scenario.startsWith('sequence') ? 5 : 1), `${label}: left action row must retain every generation/repair/export control`);
    check(row.complete && row.items.every((item) => item.complete && item.hit), `${label}: ${side} bottom row must be completely visible without scrolling`);
    check(row.rowCenterSpread <= 2, `${label}: ${side} bottom actions wrap into more than one row (${row.rowCenterSpread.toFixed(1)}px center spread)`);
    check(row.scrollWidth <= row.clientWidth + 1 && row.items.every((item) => item.rect.x >= row.rect.x - 1 && item.rect.right <= row.rect.right + 1), `${label}: ${side} bottom actions overflow horizontally`);
    check(row.items.every((item, index) => index === 0 || row.items[index - 1].rect.right <= item.rect.x + 1), `${label}: ${side} bottom controls overlap horizontally`);
    check(row.items.every((item) => item.textLines === 1 && !item.textClipped), `${label}: ${side} bottom text wraps/is clipped: ${row.items.filter((item) => item.textLines !== 1 || item.textClipped).map((item) => item.name).join(', ')}`);
  }
  for (const textBox of result.textBoxes) {
    check(textBox.complete, `${label}: bounded text box ${textBox.name} is clipped by an outer panel`);
    if (textBox.scrollHeight > textBox.clientHeight + 1) {
      check(['auto', 'scroll'].includes(textBox.overflowY) && textBox.scrollTest > 0,
        `${label}: long text must scroll within ${textBox.name}, not its parent panel`);
    }
    if (textBox.summaryAfterScroll) check(textBox.summaryAfterScroll.complete && textBox.summaryAfterScroll.hit,
      `${label}: evidence summary must stay visible while its text is scrolled`);
  }
  if (!before) {
    const afterProbe = await page.locator(outerContainerSelector).evaluateAll((elements) => elements
      .filter((element) => element.getClientRects().length)
      .map((element) => ({ name: element.id || element.className || element.tagName, top: element.scrollTop, left: element.scrollLeft })));
    check(afterProbe.every((element) => element.top === 0 && element.left === 0), `${label}: a text-only scroll probe moved an outer panel`);
  }
  return result;
};

const auditLanguageSwitch = async (scenario, viewport) => {
  const original = await page.locator('.director-result-copy').textContent();
  await clickVisible(page.locator('.result-language-switch').getByRole('button', { name: 'English', exact: true }), `${scenario}: English switch`);
  await settle(); assert.notEqual(await page.locator('.director-result-copy').textContent(), original, 'English toggle must change the rendered saved text');
  assert.equal(await page.locator('.result-language-card.en').getAttribute('aria-pressed'), 'true');
  await audit(scenario, viewport, 'en');
  await clickVisible(page.locator('.result-language-switch').getByRole('button', { name: '中文', exact: true }), `${scenario}: Chinese switch`);
  assert.equal(await page.locator('.director-result-copy').textContent(), original, 'language switches must preserve the full Chinese prompt');
  await settle();
};

const auditEvidence = async (scenario, viewport) => {
  const details = page.locator('.sequence-text-handoff-details');
  await clickVisible(details.locator('summary'), `${scenario}: expand evidence`);
  await audit(`${scenario}-evidence`, viewport);
  const evidence = details.locator('pre');
  assert.ok((await evidence.textContent()).length > 200, 'expanded fixture needs real prior-shot evidence');
  if (!before) await verifyVisible(details, `${scenario}: expanded evidence text box`);
  await clickVisible(details.locator('summary'), `${scenario}: collapse evidence`);
  await settle();
};

const auditError = async (scenario, viewport) => {
  await page.setViewportSize(viewport); await settle();
  if (scenario.startsWith('sequence')) {
    const details = page.locator('.sequence-text-handoff-details');
    if (!await details.evaluate((element) => element.open)) await clickVisible(details.locator('summary'), `${scenario}: expand evidence with long errors`);
  }
  const result = await audit(scenario, viewport);
  assert.equal(await page.locator('.result-language-card.en').isDisabled(), true, 'failed English must stay disabled');
  assert.ok(result.textBoxes.some((item) => item.name.includes('sequence-segment-error-text') && item.textLength > 200), 'error fixture must expose a real long error text box');
  const buttons = page.locator('.sequence-result-status').getByRole('button');
  for (let index = 0; index < await buttons.count(); index += 1) await verifyVisible(buttons.nth(index), `${scenario}: retry/repair without scrolling`);
};

const verifyCompletion = async () => {
  const finalState = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(finalState.project.id, projectId); assert.deepEqual(finalState.project.assets, []); assert.deepEqual(finalState.project.generationTasks, []);
  assert.deepEqual(blockedRequests, [], 'the layout interaction must never attempt a real API request');
  assert.deepEqual(errors, []);
  assert.equal(violations.length, 0, `${violations.slice(0, 3).join('\n')}\nFull geometry report: ${path.join(output, 'report.json')}`);
};

const run = async () => {
  await waitForCondition({ label: 'prompt layout Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true }); await configurePage(); fixture = await createFixture();
  if (focus === 'dialogue-repair-controls') {
    for (const fontScale of [100, 130]) {
      for (const scenario of ['single', 'sequence']) {
        await installFixture(scenario, fontScale);
        for (const viewport of [{ width: 1120, height: 720 }, viewports[0], viewports[2]]) {
          await page.setViewportSize(viewport); await settle();
          const label = `${scenario}-repair-font${fontScale}-${viewport.width}x${viewport.height}`;
          const more = page.getByRole('button', { name: '更多', exact: true });
          const send = page.getByRole('button', { name: '送到视频导演台', exact: true });
          assert.equal(await more.count(), 1);
          await verifyVisible(more, `${label}: More`); await verifyVisible(send, `${label}: send`);
          const [moreBox, sendBox] = await Promise.all([more.boundingBox(), send.boundingBox()]);
          assert.ok(moreBox.x + moreBox.width <= sendBox.x + 1, `${label}: More and send overlap`);
          assert.ok(Math.abs(moreBox.y - sendBox.y) < 1, `${label}: controls must stay on one row`);
          const withMore = await measure(label);
          await more.click();
          const repair = page.getByRole('menuitem', { name: '修复对白与排时', exact: true });
          await verifyVisible(repair, `${label}: repair in More`);
          await page.keyboard.press('Escape');
          // Compare the exact same page without the new control. This focused
          // test does not weaken the full legacy layout audit above/below.
          await more.evaluate((element) => { element.style.display = 'none'; });
          await settle();
          const withoutRepair = await measure(`${label}-without-new-control`);
          await more.evaluate((element) => { element.style.display = ''; });
          await settle();
          assert.ok(Math.abs(withMore.prompt.height - withoutRepair.prompt.height) < 1,
            `${label}: adding More must not consume prompt reading height`);
          assert.deepEqual(withMore.overlaps, withoutRepair.overlaps);
          records.push({ label, viewport, fontScale, moreBox, sendBox,
            promptHeight: withMore.prompt.height, withoutNewControlHeight: withoutRepair.prompt.height });
          await capture(label);
        }
      }
    }
    steps.push('single/sequence at 1120/1280/1600px and 100%/130% fonts: More/send both visible and single-row; repair remains in More; the control leaves prompt height unchanged; no model/media request');
    await verifyCompletion(); return;
  }
  if (focus === 'sequence-states') {
    const stateViewports = [{ width: 1120, height: 720 }, viewports[0], viewports[2], viewports[3]];
    for (const fontScale of [100, 130]) {
      for (const scenario of ['sequence-empty', 'sequence-failed', 'sequence']) {
        await installFixture(scenario, fontScale);
        for (const viewport of stateViewports) await audit(`${scenario}-font${fontScale}`, viewport);
      }
    }
    // The supplied screenshot is commonly a 2048px physical window at 150%
    // Windows scaling. Reproduce its approximately 1366x825 CSS workspace as
    // an explicit empty-result visual artifact as well as the ordinary DPR1
    // matrix above.
    await context.close(); await configurePage(1.5);
    for (const fontScale of [100, 130]) {
      await installFixture('sequence-empty', fontScale);
      await audit(`sequence-empty-user-dpi-font${fontScale}`, { width: 1366, height: 825 });
    }
    steps.push('additional 1366x825 CSS at DPR1.5 empty-result screenshots for the supplied 2048px/150% scaling case');
    steps.push('first ungenerated segment, failed segment without a result, and generated segment at 1120/1280/1600/1920px with 100%/130% fonts: complete controls, separate columns, no outer scrolling, and single-row bottom actions');
    await verifyCompletion(); return;
  }
  if (focus === 'compact-error-font130') {
    await installFixture('sequence-error', 130);
    await auditError('sequence-error-font130', viewports[0]);
    steps.push('focused 130%/1280x720 long errors plus evidence: both columns remain non-scrolling, the prompt retains 160px, and every bottom control and hint fits');
    await verifyCompletion(); return;
  }
  if (focus === 'compact-font130') {
    await installFixture('sequence', 130);
    await audit('sequence-font130', viewports[0]); await auditLanguageSwitch('sequence-font130', viewports[0]);
    await auditEvidence('sequence-font130', viewports[0]);
    steps.push('focused 130%/1280x720: both columns stay non-scrolling; headings, every parameter, bilingual/copy/send controls and both single-row bottom actions are visible before and after interactions');
    await verifyCompletion(); return;
  }
  for (const scenario of ['sequence', 'single']) {
    await installFixture(scenario);
    for (const viewport of viewports) {
      await audit(scenario, viewport); await auditLanguageSwitch(scenario, viewport);
      if (scenario === 'sequence') await auditEvidence(scenario, viewport);
    }
  }
  steps.push('five viewport sizes: current long-story segment and single prompt, Chinese/English switching, expanded prior-shot evidence');
  for (const scenario of ['sequence-error', 'single-error']) {
    await installFixture(scenario);
    for (const viewport of viewports) await auditError(scenario, viewport);
  }
  steps.push('long recoverable errors and expanded evidence scroll only inside their text boxes; retry/repair controls stay immediately visible at all five sizes');
  await installFixture('sequence');
  for (const [index, viewport] of [viewports[3], viewports[0], viewports[4], viewports[1], viewports[0]].entries()) await audit(`sequence-resize-${index + 1}`, viewport);
  steps.push('repeated live resize from large to small and back preserves the bounded prompt and immediately visible actions without outer scrolling');
  const small = records.find((record) => record.label === 'sequence-1280x720-dpr1-zh');
  const large = records.find((record) => record.label === 'sequence-1780x1115-dpr1-zh');
  check(small.titleFontSize <= large.titleFontSize && small.promptFontSize <= large.promptFontSize, 'small windows must not enlarge result typography');
  check(small.titleFontSize < large.titleFontSize || small.promptFontSize < large.promptFontSize || small.controls.some((control) => large.controls.some((other) => other.name === control.name && other.fontSize > control.fontSize)), 'result typography should respond to available window space');
  for (const scenario of ['sequence', 'single']) {
    await installFixture(scenario, 130);
    for (const viewport of [viewports[0], viewports[2]]) {
      await audit(`${scenario}-font130`, viewport); await auditLanguageSwitch(`${scenario}-font130`, viewport);
      if (scenario === 'sequence') await auditEvidence('sequence-font130', viewport);
    }
  }
  for (const scenario of ['sequence-error', 'single-error']) {
    await installFixture(scenario, 130);
    for (const viewport of [viewports[0], viewports[2]]) await auditError(`${scenario}-font130`, viewport);
  }
  steps.push('130% UI fonts at 1280x720 and 1600x900 keep both bottom action groups on one row with complete, unclipped labels');
  steps.push('all four left parameter sections retain non-overlapping controls and readable option labels without scrolling the parameter body');
  await context.close(); await configurePage(1.5);
  const screenshotSizedViewport = { width: 1187, height: 743 };
  for (const fontScale of [100, 130]) {
    for (const scenario of ['sequence', 'single']) {
      await installFixture(scenario, fontScale);
      const label = `${scenario}-user-dpi${fontScale === 130 ? '-font130' : ''}`;
      await audit(label, screenshotSizedViewport); await auditLanguageSwitch(label, screenshotSizedViewport);
      if (scenario === 'sequence') await auditEvidence(label, screenshotSizedViewport);
    }
    for (const scenario of ['sequence-error', 'single-error']) {
      await installFixture(scenario, fontScale);
      await auditError(`${scenario}-user-dpi${fontScale === 130 ? '-font130' : ''}`, screenshotSizedViewport);
    }
  }
  steps.push('1187x743 CSS at 150% DPI reproduces approximately 1780x1115 physical pixels; single/sequence, bilingual, evidence and long-error cases also pass with 130% UI fonts');
  await verifyCompletion();
};

let failure;
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  failure = error;
  if (page && !page.isClosed()) {
    await capture('failure').catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => ''));
  }
} finally {
  harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await harness.stopAll().catch((error) => { failure ||= error; });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: !failure, phase: before ? 'before' : 'after', focus: focus || 'full', isolatedBrowserStorage: true,
    productionDataRead: false, externalRequests: 0, paidApiCalls: 0, records, violations, steps, errors, blockedRequests, failure: failure?.stack }, null, 2));
  fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog());
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), cases: records.length, steps }));
