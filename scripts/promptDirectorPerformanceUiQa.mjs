import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Isolated App navigation: synthetic data by default, or a read-only project
// clone via QA_PROJECT_FILE. Fresh browser storage, disabled model APIs, no
// desktop bridge; private-project reports contain aggregate metrics only.
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.QA_OUTPUT || path.join(root, 'output', 'playwright', 'prompt-director-performance'));
const variant = process.env.QA_VARIANT || (process.argv.includes('--baseline') ? 'before' : 'after');
const sourceFiles = ['src/App.tsx', 'src/seedanceSource.ts', 'src/sequencePromptHandoff.ts', 'src/officialPrompt.ts', 'src/officialH3Context.ts'];
const snapshotDirectory = process.env.QA_BASELINE_SOURCE && path.resolve(process.env.QA_BASELINE_SOURCE);
const projectFile = process.env.QA_PROJECT_FILE && path.resolve(process.env.QA_PROJECT_FILE);
const originalProjectBytes = projectFile && await fs.readFile(projectFile);
const privateProject = originalProjectBytes && JSON.parse(originalProjectBytes.toString('utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const baseline = snapshotDirectory
  ? new Map(await Promise.all((await fs.readdir(snapshotDirectory, { recursive: true })).filter((file) => /\.(?:ts|tsx|css)$/u.test(file)).map(async (file) => [`src/${file.replaceAll('\\', '/')}`, await fs.readFile(path.join(snapshotDirectory, file), 'utf8')])))
  : variant === 'before' ? new Map(sourceFiles.map((file) => [file, execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })])) : new Map();
const expectsDisplayCache = !baseline.size || baseline.get('src/App.tsx')?.includes('createPromptDirectorReadCache');
const measured = new Set(['App', 'DirectorView', 'SequenceFilmstrip', 'buildOfficialSeedanceInput', 'hasCurrentSeedancePrompt', 'getSequencePromptHandoffStatus', 'buildSequencePromptHandoff', 'officialH3ContextForStoryboard', 'buildOfficialH3CompileInput', 'buildOfficialH3SubjectDefinitions', 'resolveSequenceSegmentPromptAction', 'createPromptDirectorReadCache', 'chapterScopeProject', 'withChapterWorkspace', 'withProjectLibrary', 'normalizeState', 'saveStateAsync', 'serializeStateForStorage']);
const instrumentation = { name: 'prompt-director-qa-only', enforce: 'pre', transform(original, id) {
  const relative = path.relative(root, id.split('?')[0]).replaceAll('\\', '/');
  if (!relative.startsWith('src/')) return;
  const source = baseline.get(relative) || original;
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, relative.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const inserts = [];
  const visit = (node) => {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const body = ts.isFunctionDeclaration(node) ? node.body : ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer) ? node.initializer.body : undefined;
    if (name && measured.has(name) && body && ts.isBlock(body)) {
      inserts.push({ at: body.getStart(ast) + 1, text: `\nconst __qaStart = performance.now(); try {\n` });
      inserts.push({ at: body.end - 1, text: `\n} finally { const m = (globalThis.__promptDirectorPerf ||= {}); const v = (m[${JSON.stringify(name)}] ||= {calls:0,ms:0}); v.calls++; v.ms += performance.now() - __qaStart; ${name === 'buildOfficialSeedanceInput' ? 'const boards = (v.boards ||= {}); boards[board.id] = (boards[board.id] || 0) + 1;' : ''} }\n` });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  let result = source;
  for (const item of inserts.sort((a, b) => b.at - a.at)) result = result.slice(0, item.at) + item.text + result.slice(item.at);
  if (relative === 'src/App.tsx') result = result.replace('  const appContext = {', `
  globalThis.__promptDirectorMutateSource = () => setBackgroundState((current) => ({ ...current, project: { ...current.project,
    characters: current.project.characters.map((character, index) => index === 0 ? { ...character,
      voiceProfile: { version: 1, source: 'manual', notes: 'isolated source invalidation fixture' } } : character),
  } }));
  const appContext = {`);
  return result;
} };
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, plugins: [instrumentation], server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/.pack-release-*/**', '**/release/**', '**/交付/**', '**/output/**'] } } });
let browser; let page;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(45000);
  const errors = []; const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      requests.push({ method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__prompt_director_fixture.html') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body>Isolated synthetic fixture</body></html>' }); return; }
    await route.continue();
  });
  await page.goto(`${origin}/__prompt_director_fixture.html`);
  await page.evaluate(async (projectFixture) => {
    const { createInitialState, normalizeState } = await import('/src/storage.ts');
    if (projectFixture) {
      const state = createInitialState();
      const project = structuredClone(projectFixture); project.generationTasks = [];
      const plan = project.sequencePlans[0]; const first = plan.segments[0];
      const chapterId = plan.chapterId || project.activeChapterId;
      project.activeChapterId = chapterId;
      project.chapterWorkspaces ||= {};
      const workspace = project.chapterWorkspaces[chapterId] ||= {};
      workspace.directorControls = { ...workspace.directorControls, activePlanId: plan.id, activeSegmentId: first.id,
        activeStoryboardId: first.storyboardId || '', productionMode: 'sequence', sequenceStage: 'direct',
        sequenceSettingsOpen: false, generationPromptFormat: 'seedance' };
      state.project = project; state.projects = [project]; state.activeProjectId = project.id;
      for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[key] = { ...state.settings[key], enabled: false, apiKey: '' };
      localStorage.setItem('lianhua_video_director_state_v22', JSON.stringify(state));
      return;
    }
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { buildVideoCreativeDirection } = await import('/src/videoCreativeDirection.ts');
    const { buildOfficialSeedanceInput } = await import('/src/seedanceSource.ts');
    const { getOfficialSeedanceSourceFingerprint } = await import('/src/seedancePrompt.ts');
    const { sourceContentHash } = await import('/src/sourceContentHash.ts');
    const { buildSequencePromptHandoff, stampSequencePromptHandoff } = await import('/src/sequencePromptHandoff.ts');
    let state = createInitialState(); const now = Date.now();
    const names = ['林舟', '苏晴', '陈宁', '许岚', '周远', '贺晨', '梁安', '程嘉'];
    const characters = names.map((name, index) => ({ id: `perf-character-${index}`, name, gender: index % 2 ? '女' : '男', apparentAge: '30', race: '人类', appearance: '黑色短发', outfit: '普通外套', signatureProps: '', personality: '', motionHabits: '', anchor: '普通合成人物', negativeContinuity: '', assetIds: [] }));
    const sourceParts = Array.from({ length: 15 }, (_, index) => {
      const sentence = `第${index + 1}段，林舟与苏晴沿着庭院缓慢前行，陈宁与许岚跟在后方，众人保持左右顺序，经过树影与石砖，来到第${index + 1}座木门旁，然后继续前进。`;
      return sentence.repeat(20).slice(0, index === 14 ? 845 : 842);
    });
    const title = '合成庭院长剧情'; const story = sourceParts.join('');
    const scenes = Array.from({ length: 13 }, (_, index) => ({ id: index ? `perf-scene-${index}` : 'perf-scene', chapterId: 'perf-chapter', title: `庭院场景${index + 1}`, content: story.slice(Math.floor(index * story.length / 13), Math.floor((index + 1) * story.length / 13)), summary: '庭院行走', characterIds: characters.map((character) => character.id), propIds: [], locationIds: [], storyboardIds: [], createdAt: now, updatedAt: now }));
    const plan = materializeSemanticSequencePlan({ title, story, segmentDurationSec: 30, directorSettingsFingerprint: 'qa-director-settings', creativeDirection: buildVideoCreativeDirection(), characterContinuity: characters, sourceSceneIds: scenes.map((scene) => scene.id) }, {
      segmentCount: 15, reason: '合成固定分段', fitStatus: 'balanced', segments: sourceParts.map((content, index) => ({ title: `庭院行走${index + 1}`, content, summary: content, sourceSceneIds: [scenes[index % scenes.length].id], narrativePurpose: '沿庭院前进', entryState: '行走', exitState: '继续行走', transitionHint: '承接上一段步伐', boundaryReason: '合成边界', continuityPack: '衣着身份与左右站位连续', semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: `event-${index}`, description: content }], dialogues: [] } })),
    }, { planId: 'perf-plan', now });
    plan.chapterId = 'perf-chapter'; plan.generationPromptFormat = 'seedance';
    const prose = (language, index) => {
      const sentence = language === 'en' ? 'The group walks through the quiet courtyard in a steady medium shot, keeping their clothes and identities consistent while tree shadows move gently across the stone pavement. ' : '众人沿石砖庭院缓慢前行，镜头在稳定的中景中跟随，衣着身份保持连续，树影和自然光保持一致，背景只有轻微风声与脚步声。';
      return [`### 视频规格\n时长30秒，画幅16:9，分辨率2K，立体声。`, '### 参考素材与职责\n本段没有外部参考素材，场景由文字确定。', `### 主体连续性\n${characters.map((character) => `${character.name}为三十岁人物，黑色短发，穿普通外套。`).join('')}`, `### 概述\n第${index + 1}段众人沿庭院行走。`, `### 连续时间轴\n0秒至10秒，林舟与苏晴走入庭院。\n10秒至20秒，陈宁与许岚跟随。${sentence.repeat(Math.ceil(6000 / sentence.length))}\n20秒至30秒，众人一起向门口前进。`, '### 全局约束\n身份与服装连续，无对白，无字幕。'].join('\n\n');
    };
    const boards = plan.segments.map((segment, index) => {
      segment.storyboardId = `perf-board-${index + 1}`; segment.status = 'ready';
      const shots = Array.from({ length: 3 }, (_, shotIndex) => ({ id: `perf-shot-${index}-${shotIndex}`, index: shotIndex + 1, startSec: shotIndex * 10, endSec: (shotIndex + 1) * 10, subject: '林舟、苏晴、陈宁、许岚', action: '沿庭院行走', camera: '稳定中景', lighting: '自然光', sound: '脚步声', referenceAssetIds: [], locked: false, authoredBy: 'text-api', prompt: `【${shotIndex * 10}s-${(shotIndex + 1) * 10}s】 主体：林舟、苏晴、陈宁、许岚沿庭院行走；空间：庭院；光影：自然光；镜头：稳定中景；台词：无；音效：脚步声` }));
      return { id: segment.storyboardId, chapterId: 'perf-chapter', sceneId: 'perf-scene', sourceStoryTitle: segment.title, sourceStoryContent: segment.content, workflow: 'drama', inputMode: 'text', durationSec: 30, durationPreset: 'custom', shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'seedance-2.5', globalLock: '', globalReferenceAssetIds: [], finalPrompt: shots.map((shot) => shot.prompt).join('\n'), promptMigrationPending: false, shots, sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 15, createdAt: now, updatedAt: now, seedance25Output: { targetId: 'seedance-2.5', promptZh: prose('zh', index), promptEn: prose('en', index), durationSec: 30, sourceFingerprint: 'pending', englishSourceFingerprint: 'pending', referenceManifest: [], warnings: [], generatedAt: now } };
    });
    for (const [index, board] of boards.entries()) {
      const scene = scenes[index % scenes.length]; board.sceneId = scene.id;
      board.sourceSceneSnapshots = [{ id: scene.id, title: scene.title, content: scene.content }];
      scene.storyboardIds.push(board.id);
      if (index === 3) Object.assign(board.seedance25Output, { promptEn: '', englishSourceFingerprint: '', englishError: 'Seedance 英文交付序列化失败：英文描述单元未完整返回；中文稿已保留。' });
    }
    for (const board of boards) board.promptTrace = { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(board.finalPrompt), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: board.converterPresetId, sourceDocumentIds: ['perf-chapter'], referenceAssetIds: [], generatedAt: now };
    plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    state.project = { ...state.project, id: 'perf-project', name: title, characters, locations: [], props: [], assets: [], generationTasks: [], activeChapterId: 'perf-chapter', sourceDocuments: [{ id: 'perf-chapter', name: title, content: story, createdAt: now, updatedAt: now }], storyDraft: { name: title, content: story, updatedAt: now }, scenes, storyboards: boards, sequencePlans: [plan], directorSettingsConfirmedFingerprint: 'qa-director-settings', chapterWorkspaces: {} };
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    for (const key of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) state.settings[key] = { ...state.settings[key], enabled: false, apiKey: '' };
    state = normalizeState(state);
    for (const board of state.project.storyboards) {
      const fingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(state.project, board));
      Object.assign(board.seedance25Output, { sourceFingerprint: fingerprint, englishSourceFingerprint: fingerprint });
    }
    for (const [index, board] of state.project.storyboards.entries()) {
      const handoff = buildSequencePromptHandoff(state.project, board.sequencePlanId, board.segmentId, 'seedance');
      if (index > 0 && !handoff.context) throw new Error(`Synthetic handoff failed: ${handoff.issue}`);
      if (handoff.context) state.project.storyboards[index] = stampSequencePromptHandoff(board, handoff.context);
    }
    state.project.sequencePlans[0].reviewConfirmedFingerprint = sequencePlanReviewFingerprint(state.project.sequencePlans[0]);
    state.projects = [state.project];
    localStorage.setItem('lianhua_video_director_state_v22', JSON.stringify(state));
  }, privateProject || null);
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 90000 });
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(600);
  const snapshot = () => page.evaluate(() => structuredClone(window.__promptDirectorPerf || {}));
  const measureClick = async (selector, text) => page.evaluate(async ({ selector, text }) => {
    window.__promptDirectorPerf = {};
    const button = [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text);
    if (!button) throw new Error(`Missing measured button: ${text}`);
    const started = performance.now(); button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = { ms: performance.now() - started, counters: structuredClone(window.__promptDirectorPerf) };
    await new Promise((resolve) => setTimeout(resolve, 550));
    return { ...result, postSaveMs: performance.now() - started, postSaveCounters: structuredClone(window.__promptDirectorPerf) };
  }, { selector, text });
  const entry = await measureClick('.sidebar button', '提示词导演台');
  await page.locator('.director-all-sections').waitFor();
  await page.locator('.sequence-director-strip .sequence-segment-chip').nth(14).waitFor();
  const settled = await snapshot(); await page.waitForTimeout(800); const idle = await snapshot();
  const fixtureSummary = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).project;
    return { segmentCount: project.sequencePlans[0].segments.length, characterCount: project.characters.length,
      sourceCharacters: project.sourceDocuments.reduce((count, document) => count + document.content.length, 0),
      sceneCount: project.scenes.length, boardCount: project.storyboards.length,
      displayedPromptCharacters: document.querySelector('.director-result-copy')?.textContent.length || 0 };
  });
  const assertSelection = async (index) => {
    const result = await page.evaluate((selectedIndex) => {
      const project = JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).project;
      const plan = project.sequencePlans[0]; const segment = plan.segments[selectedIndex - 1];
      const board = project.storyboards.find((candidate) => candidate.id === segment.storyboardId);
      const displayed = document.querySelector('.director-result-copy')?.textContent || '';
      return { exact: displayed === board?.seedance25Output?.promptZh,
        selected: document.querySelectorAll('.sequence-director-strip .sequence-segment-chip')[selectedIndex - 1]?.getAttribute('aria-selected') === 'true',
        persisted: project.chapterWorkspaces[project.activeChapterId]?.directorControls?.activeSegmentId === segment.id,
        chineseOnly: !board?.seedance25Output?.promptEn,
        pendingEnglishShown: document.querySelector('.sequence-result-status')?.textContent.includes('英文待完成') || false,
        displayedCharacters: displayed.length };
    }, index);
    assert.ok(result.exact, `segment ${index} displays exact saved Chinese prompt`);
    assert.ok(result.selected, `segment ${index} is selected`);
    assert.ok(result.persisted, `segment ${index} selection is persisted after the save interval`);
    if (result.chineseOnly) assert.ok(result.pendingEnglishShown, `segment ${index} retains pending English status`);
    return result;
  };
  await assertSelection(1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  const switches = [];
  for (const index of [2, 3, 4, 2, 3]) {
    const text = await page.locator('.sequence-director-strip .sequence-segment-chip').nth(index - 1).textContent();
    const measurement = await measureClick('.sequence-director-strip .sequence-segment-chip', text.trim());
    switches.push({ index, ...measurement, selection: await assertSelection(index) });
  }
  const { profile } = await cdp.send('Profiler.stop'); await cdp.detach();
  const nodes = new Map(profile.nodes.map((node) => [node.id, node])); const cpuTotals = new Map();
  for (const [index, id] of profile.samples.entries()) {
    const frame = nodes.get(id)?.callFrame; if (!frame) continue;
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}`;
    cpuTotals.set(key, (cpuTotals.get(key) || 0) + (profile.timeDeltas[index] || 0));
  }
  const cpuSelfMs = [...cpuTotals].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([functionName, microseconds]) => ({ functionName, ms: microseconds / 1000 }));
  if (!privateProject) await fs.writeFile(path.join(output, `${variant}.cpuprofile`), JSON.stringify(profile));
  await page.locator('.sidebar').getByRole('button', { name: '项目总览', exact: true }).click();
  const reentry = await measureClick('.sidebar button', '提示词导演台');
  await page.locator('.director-all-sections').waitFor();
  await assertSelection(3);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-all-sections').waitFor(); await page.waitForTimeout(550);
  await assertSelection(3);
  const sourceEdit = await page.evaluate(async () => {
    window.__promptDirectorPerf = {}; window.__promptDirectorMutateSource();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 550));
    const counters = structuredClone(window.__promptDirectorPerf);
    const project = JSON.parse(localStorage.getItem('lianhua_video_director_state_v22')).project;
    const plan = project.sequencePlans[0]; const segment = plan.segments[2];
    const board = project.storyboards.find((candidate) => candidate.id === segment.storyboardId);
    const { hasCurrentSeedancePrompt } = await import('/src/seedanceSource.ts');
    return { counters, authoritativeCurrent: hasCurrentSeedancePrompt(project, board),
      expiredShown: document.body.textContent.includes('Seedance 官方稿已过期') };
  });
  if (expectsDisplayCache) assert.ok(sourceEdit.counters.createPromptDirectorReadCache?.calls > 0, 'source edits replace the display cache');
  assert.ok(sourceEdit.counters.buildOfficialSeedanceInput?.calls > 0, 'source edits recompute prompt evidence');
  assert.equal(sourceEdit.expiredShown, !sourceEdit.authoritativeCurrent, 'edited source readiness matches the uncached authority');
  if (!privateProject) await page.screenshot({ path: path.join(output, `${variant}.png`), fullPage: false });
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  assert.deepEqual(idle, settled, 'idle view does not keep recalculating');
  if (projectFile) assert.equal(hash(await fs.readFile(projectFile)), hash(originalProjectBytes), 'source project file was not changed');
  const report = { passed: true, variant, fixture: privateProject ? 'isolated-private-project-clone' : 'synthetic', ...fixtureSummary,
    entry, switches, reentry, sourceEdit, cpuSelfMs, exactSavedPromptAcrossNavigation: true, selectionSurvivesReload: true,
    originalProjectFileUnchanged: Boolean(projectFile), idleExtraCalculations: false, errors, requests };
  const serializedReport = JSON.stringify(report, (key, value) => key === 'boards'
    ? { distinctBoards: Object.keys(value).length, buildsPerBoard: Object.values(value).sort((a, b) => b - a) } : value, 2);
  await fs.writeFile(path.join(output, `${variant}.json`), serializedReport);
  console.log(JSON.stringify({ passed: true, variant, fixture: report.fixture, ...fixtureSummary,
    entryMs: entry.ms, switches: switches.map((item) => ({ segment: item.index, ms: item.ms,
      builds: item.postSaveCounters.buildOfficialSeedanceInput?.calls || 0, cacheBuilds: item.postSaveCounters.createPromptDirectorReadCache?.calls || 0 })),
    reentryMs: reentry.ms, sourceEditInvalidated: sourceEdit.counters.createPromptDirectorReadCache?.calls > 0,
    originalProjectFileUnchanged: report.originalProjectFileUnchanged, report: path.join(output, `${variant}.json`) }, null, 2));
} catch (error) {
  if (page && !privateProject) { await fs.writeFile(path.join(output, `${variant}-failure.txt`), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(output, `${variant}-failure.png`) }).catch(() => {}); }
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
