import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App regression, exclusively synthetic state in a new browser context.
// No Electron bridge, production storage, real credentials, or remote API is
// available. Only the exact same-origin mock paths below may accept a POST.
const root = path.resolve(import.meta.dirname, '..');
const focus = process.env.QA_FOCUS || 'all';
if (!['all', 'layout', 'legacy', 'transient', 'nine-images'].includes(focus)) throw new Error(`Unknown grid retirement QA focus: ${focus}`);
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `grid-retirement-160-${Date.now()}`));
const relativeOutput = path.relative(outputBase, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Grid retirement QA output must stay below output/playwright');
const outputPathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
for (let current = output; ;) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Grid retirement QA output cannot traverse links');
  if (outputPathKey(current) === outputPathKey(root)) break;
  const parent = path.dirname(current);
  if (parent === current) throw new Error('Grid retirement QA output did not resolve inside the workspace');
  current = parent;
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const fixturePath = '/__grid_retirement_fixture.html';
const textPath = '/__grid_retirement_mock__/text/v1/chat/completions';
const imagePath = '/__grid_retirement_mock__/image/v1/images/generations';
const projectId = 'qa-grid-retirement-project';
const gridAssetId = 'qa-legacy-grid-asset';
const gridBoardId = 'qa-legacy-grid-board';
const gridTaskId = 'qa-legacy-grid-failed';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'grid retirement UI QA', runTimeoutMs: 300_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let fixture; let png; let legacyPng;
let phase = 'seed';
const requests = []; const errors = []; const blockedRequests = []; const screenshots = []; const steps = []; const layouts = [];
const sourceParts = [
  '师傅与徒弟站在山道石阶旁，师傅从药篓取出一株药草。',
  '师傅说：“接稳这株药草。”她将药草递到徒弟伸出的手前，双方的手指尚未完成交接。',
  '徒弟伸手接取药草，师傅的手指仍触着药草的根部。',
  '徒弟说：“好，我会小心。”他握稳药草后把药篓背带递向师傅抬起的右手。',
  '师傅伸手接取徒弟递来的药篓背带，双方的手仍靠在一起。',
  '师傅将药篓背好，与徒弟沿着同一条山道继续前行。',
];
const story = sourceParts.join('');
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false }); screenshots.push(`${name}.png`); };
const enterDirector = async () => { await nav('提示词导演台'); await page.locator('.director-all-sections').waitFor(); };
const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n') : '';
const messageText = (payload, role) => payload.messages.filter((message) => message.role === role).map((message) => textContent(message.content)).join('\n');
const fixedBoard = (board) => ({
  id: board.id, workflow: board.workflow, inputMode: board.inputMode, durationSec: board.durationSec, shotCount: board.shotCount,
  shots: board.shots.map(({ id, index, startSec, endSec, prompt }) => ({ id, index, startSec, endSec, prompt })),
  finalPrompt: board.finalPrompt, officialPromptZh: board.officialPromptZh, officialPromptEn: board.officialPromptEn,
  globalReferenceAssetIds: board.globalReferenceAssetIds, videoReferenceAssetIds: board.videoReferenceAssetIds,
});
const legacySnapshot = (state) => ({
  asset: state.project.assets.find((asset) => asset.id === gridAssetId),
  board: state.project.storyboards.find((board) => board.id === gridBoardId),
  tasks: state.project.generationTasks.filter((task) => task.id.startsWith('qa-legacy-grid-')),
});

const installMock = async () => {
  // Install at the context level so popup first requests are guarded too.
  // Vite's injected client still opens its dev socket with HMR disabled. Mock
  // that exact loopback endpoint in memory (never connectToServer); block all
  // other sockets so no app request can escape through WebSocket transport.
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host && url.pathname === '/') return;
    blockedRequests.push({ method: 'WEBSOCKET', url: socket.url() }); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && ![textPath, imagePath].includes(url.pathname))) {
      blockedRequests.push({ method: request.method(), origin: url.origin, path: url.pathname }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Grid retirement isolated fixture</title><body>Only synthetic QA state</body></html>' }); return;
    }
    if (![textPath, imagePath].includes(url.pathname)) { await route.continue(); return; }
    try {
      assert.equal(request.method(), 'POST');
      const payload = request.postDataJSON();
      if (url.pathname === imagePath) {
        requests.push({ phase, kind: 'image', prompt: payload.prompt, size: payload.size });
        const resultPixels = phase === 'legacy-explicit-retry' ? legacyPng : png;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: resultPixels.split(',')[1] }] }) }); return;
      }
      const user = messageText(payload, 'user'); const system = messageText(payload, 'system');
      let response; let entry;
      if (system.includes('实际出镜人物解析器')) {
        const evidence = JSON.parse(user.slice(user.indexOf('{')));
        entry = { phase, kind: 'visible-characters', shotIds: evidence.shots.map((shot) => shot.id) };
        response = JSON.stringify({ shots: evidence.shots.map((shot) => ({ shotId: shot.id, visibleCharacterNames: ['师傅', '徒弟'] })) });
      } else if (system.includes('分镜静帧规划导演')) {
        const input = JSON.parse(user);
        assert.equal(input.requestedImageCount, 9);
        assert.equal(input.source.shots.length, 2, 'nine image frames must not become nine video shots');
        const frames = Array.from({ length: 9 }, (_entry, index) => {
          const shot = input.source.shots[index < 4 ? 0 : 1];
          return { sourceShotId: shot.id, description: `隔离静帧 ${index + 1}：山道药草交接的第${index + 1}个独立可见瞬间，师傅左侧青衣、徒弟右侧灰衣，手掌与药草接触位置连续，固定中景。`, timeSec: shot.startSec + (index < 4 ? index + 1 : index - 3) };
        });
        entry = { phase, kind: 'frame-plan', requestedImageCount: input.requestedImageCount, source: input.source, frames };
        response = JSON.stringify(frames);
      } else {
        assert.match(system, /图像|生图|图片/u, `Unexpected text request: ${system.slice(0, 90)}`);
        const serial = requests.filter((entry) => entry.phase === phase && entry.kind === 'image-conversion').length + 1;
        entry = { phase, kind: 'image-conversion', source: user };
        response = `A single cinematic still moment ${serial}: an adult teacher in a teal robe stands on the left and an adult student in a gray robe on the right, both hands carefully touching one herb on a mountain stone path, stable medium view, soft morning side light, clear spatial depth.`;
      }
      requests.push(entry);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
    } catch (error) {
      errors.push(String(error));
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"Isolated grid retirement mock rejected request"}}' }).catch(() => {});
    }
  });
};

const createFixture = async () => {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  const pixels = await page.evaluate(async ({ key, projectId, story, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#59759b'; paint.fillRect(0, 0, 512, 512);
    for (let index = 0; index < 9; index += 1) { paint.fillStyle = index % 2 ? '#bca572' : '#749c91'; paint.fillRect((index % 3) * 170 + 8, Math.floor(index / 3) * 170 + 8, 154, 154); }
    const characters = [
      { id: 'qa-teacher', name: '师傅', gender: '女', apparentAge: '35岁成年', actualAge: '35岁', height: '约170cm', race: '人类', morphology: 'humanoid', bodyPlan: '成年女性，双手双足直立', appearance: '黑发盘起，固定面容', outfit: '青色长衣', signatureProps: '药篓', personality: '沉稳', motionHabits: '动作平稳', anchor: '青色长衣', negativeContinuity: '', assetIds: [] },
      { id: 'qa-student', name: '徒弟', gender: '男', apparentAge: '25岁成年', actualAge: '25岁', height: '约175cm', race: '人类', morphology: 'humanoid', bodyPlan: '成年男性，双手双足直立', appearance: '短黑发，固定面容', outfit: '灰色长衣', signatureProps: '无', personality: '认真', motionHabits: '双手接物', anchor: '灰色长衣', negativeContinuity: '', assetIds: [] },
    ];
    const scene = { id: 'qa-grid-retirement-scene', title: '山道交接', content: story, summary: '山道药草交接与接取药篓', characterIds: characters.map((entry) => entry.id), locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: projectId, name: '九宫格入口退休 · 隔离回归', characters, locations: [], props: [],
      sourceDocuments: [{ id: 'qa-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], scenes: [scene],
      storyboards: [], sequencePlans: [], assets: [], generationTasks: [], createdAt: now, updatedAt: now,
      directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__grid_retirement_mock__/text`, apiKey: '', model: 'qa-text-160', vision: false };
    state.settings.imageApi = { ...state.settings.imageApi, enabled: true, backend: 'openai', baseUrl: `${origin}/__grid_retirement_mock__/image`, apiKey: '', model: 'qa-image-160' };
    state.settings.imageApiProfiles = []; state.settings.activeImageApiProfileId = null;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false;
    state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    const legacyPng = canvas.toDataURL('image/png');
    paint.fillStyle = '#59759b'; paint.fillRect(0, 0, 512, 512); paint.fillStyle = '#bca572'; paint.fillRect(160, 128, 192, 256);
    return { png: canvas.toDataURL('image/png'), legacyPng };
  }, { key: storageKey, projectId, story, origin });
  png = pixels.png; legacyPng = pixels.legacyPng;
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.locator('#sequence-director-settings-panel #director-setup-timing').getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.waitForFunction((key) => Boolean(JSON.parse(localStorage.getItem(key))?.project?.directorSettingsConfirmedFingerprint), storageKey);
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(async ({ key, sourceParts, story, png, gridAssetId, gridBoardId, gridTaskId }) => {
    const { buildLocalSequencePlan, extractStoryBeats, validateSequencePlan } = await import('/src/storySegmentation.ts');
    const { masterPromptConfirmationFingerprint } = await import('/src/masterTimeline.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { buildSequencePromptHandoff, stampSequencePromptHandoff } = await import('/src/sequencePromptHandoff.ts');
    const { createImageGenerationTask } = await import('/src/generationTasks.ts');
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const now = Date.now();
    const plan = buildLocalSequencePlan({ title: '山道交接', story, totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [project.scenes[0].id] });
    const beats = extractStoryBeats(story); let cursor = 0;
    const shots = sourceParts.map((part, index) => {
      const start = cursor; cursor += part.length; const startSec = index * 7.5; const endSec = startSec + 7.5;
      const dialogue = index === 1 ? '第1s @师傅:"接稳这株药草。"' : index === 3 ? '第1s @徒弟:"好，我会小心。"' : '无';
      const detail = '人物手指与道具接触关系清晰，身体重心连续，视线跟随交接中的药草和背带，保持清晨同一侧光。'.repeat(7);
      const prompt = `【${startSec}s-${endSec}s】主体：@师傅与@徒弟（专注平静）[朝向：彼此双手] 正在 [${part}${detail}]（连贯交接药草与药篓）；空间：前景药草，中景师傅在左徒弟在右，背景山道石阶；光影：清晨柔和侧光；镜头：稳定中景侧拍；台词：${dialogue}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
      return { id: `qa-master-shot-${index + 1}`, index: index + 1, startSec, endSec, subject: '师傅与徒弟', action: `${part}${detail}`, purpose: '连贯交接药草与药篓', camera: '稳定中景侧拍', lighting: '清晨柔和侧光', sound: '', transition: '自然承接', result: part,
        sourceStart: start, sourceEnd: cursor, sourceExcerpt: part, sourceBeatIds: beats.filter((beat) => beat.sourceStart < cursor && beat.sourceEnd > start).map((beat) => beat.id), referenceAssetIds: [], prompt, locked: false, authoredBy: 'text-api' };
    });
    const canonical = shots.map((shot) => shot.prompt).join('\n');
    const master = { id: 'qa-grid-retirement-master', sceneId: project.scenes[0].id, sequencePlanId: plan.id, sourceStoryTitle: '山道交接', sourceStoryContent: story,
      workflow: 'drama', inputMode: 'text', durationSec: 45, durationPreset: 'custom', shotMode: 'exact', shotCount: 6, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '师傅在左，徒弟在右；衣着、山道方向和晨光保持不变。', shots, finalPrompt: canonical, targetModelId: 'minimax-h3',
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: ['qa-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    plan.masterStoryboardId = master.id; plan.planningStage = 'segmented'; plan.segmentationSource = 'ai'; plan.segmentationReason = '已确认完整镜头分配'; plan.fitStatus = 'balanced';
    plan.masterPromptDirectorSettingsFingerprint = project.directorSettingsConfirmedFingerprint; plan.masterPromptDirectorSettingsConfirmedAt = now;
    plan.segments.forEach((segment, index) => {
      const owned = shots.slice(index * 2, index * 2 + 2);
      Object.assign(segment, { title: `第${index + 1}段·山道交接`, content: sourceParts.slice(index * 2, index * 2 + 2).join(''), summary: `连续动作第${index + 1}段`,
        sourceShotIds: owned.map((shot) => shot.id), sourceBeatIds: [...new Set(owned.flatMap((shot) => shot.sourceBeatIds))], globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15,
        narrativePurpose: '连贯交接药草与药篓', entryState: '交接动作正在发生', exitState: '双方手部仍靠近', continuityPack: '不改变左右关系、衣着与光线', transitionHint: '保留0.5秒动作重合', boundaryReason: '已确认完整镜头分配', status: 'ready', locked: false, storyboardId: `qa-grid-retirement-segment-${index + 1}` });
    });
    plan.masterPromptConfirmedAt = now; plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, master);
    plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    project.storyboards = [master]; project.sequencePlans = [plan];
    const officialContext = { assets: [], characters: project.characters, locations: [], props: [], sceneContent: story };
    const english = (source) => {
      const preserved = [];
      return source.replace(/"[^"\n]*"|“[^”\n]*”|师傅|徒弟/gu, (value) => { const token = `__QA_KEEP_${preserved.length}__`; preserved.push(value); return token; })
        .replace(/[\p{Script=Han}]+/gu, ' English scene detail ').replace(/__QA_KEEP_(\d+)__/gu, (_all, index) => preserved[Number(index)]);
    };
    const bilingual = (board, context) => {
      const result = applyOfficialH3Prompt(board, context);
      const detail = Array.from({ length: 12 }, (_entry, index) => `动作细节${index + 1}：药草叶片完整可见，人物手掌缓慢靠近并保持准确接触位置，山道背景、晨光方向、衣服轮廓和摄影机方位连续。`).join('\n');
      result.officialPromptZh = result.officialPromptZh.replace(/\noverall_soundscape:/u, `\n${detail}\noverall_soundscape:`);
      result.targetOutput = { ...result.targetOutput, prompt: result.officialPromptZh };
      result.officialPromptEn = english(result.officialPromptZh); result.officialPromptEnSource = result.officialPromptZh;
      result.englishPrompt = result.officialPromptEn; result.englishPromptSource = result.finalPrompt;
      if (!hasCurrentOfficialH3Prompt(result, context) || !hasCurrentOfficialH3EnglishPrompt(result, context)) throw new Error('Fixture bilingual H3 must be current');
      return result;
    };
    for (const segment of plan.segments) {
      const segmentShots = shots.slice((segment.index - 1) * 2, segment.index * 2).map((shot, index) => ({ ...shot, id: `${segment.storyboardId}-shot-${index + 1}`, index: index + 1, startSec: index * 7.5, endSec: (index + 1) * 7.5, prompt: shot.prompt.replace(/^【[^】]+】/u, `【${index * 7.5}s-${(index + 1) * 7.5}s】`) }));
      const finalPrompt = segmentShots.map((shot) => shot.prompt).join('\n');
      let board = bilingual({ ...master, id: segment.storyboardId, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3, sourceStoryTitle: segment.title, sourceStoryContent: segment.content, durationSec: 15, durationPreset: '15s', shotCount: 2, shots: segmentShots, finalPrompt, promptTrace: { ...master.promptTrace, convertedPromptFingerprint: sourceContentHash(finalPrompt) } }, officialContext);
      if (segment.index > 1) {
        const handoff = buildSequencePromptHandoff(project, plan.id, segment.id);
        if (!handoff.context) throw new Error(`Fixture handoff invalid: ${handoff.issue}`);
        board = stampSequencePromptHandoff(board, handoff.context);
      }
      project.storyboards.push(board);
    }
    const issues = validateSequencePlan(plan, { requireMasterStoryboard: true, storyboards: project.storyboards });
    if (issues.length) throw new Error(`Invalid isolated sequence plan: ${issues.join('; ')}`);
    const gridAsset = { id: gridAssetId, name: '旧九宫格素材·原样保留', type: 'grid', role: 'grid', referenceRole: 'grid', mediaType: 'image', source: 'generated', mimeType: 'image/png', dataUrl: png, width: 512, height: 512,
      prompt: 'LEGACY_GRID_IMAGE_PROMPT: a saved 3 by 3 mountain herb exchange contact sheet.', tags: ['九宫格', '隔离旧资料'], gridStates: Array.from({ length: 9 }, (_entry, index) => ({ index: index + 1, state: `旧第${index + 1}格视觉状态` })), createdAt: now, updatedAt: now };
    project.assets = [gridAsset];
    const oldSource = structuredClone(project.storyboards[2]);
    for (const key of ['sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount', 'sequencePromptHandoff']) delete oldSource[key];
    const oldGrid = bilingual({ ...oldSource, id: gridBoardId, workflow: 'grid', inputMode: 'text_reference', converterPresetId: 'converter_grid', globalReferenceAssetIds: [gridAssetId], sourceStoryTitle: '旧九宫格保存提示词', promptTrace: { ...oldSource.promptTrace, referenceAssetIds: [gridAssetId] } }, { ...officialContext, assets: project.assets });
    project.storyboards.push(oldGrid);
    const baseTask = { name: '旧九宫格已完成任务', assetKind: 'grid', imageVariant: 'grid', prompt: gridAsset.prompt, width: 512, height: 512, backend: 'openai', model: 'qa-image-160', referenceAssetIds: [], primaryReferenceAssetIds: [] };
    project.generationTasks = [
      { ...createImageGenerationTask({ ...baseTask, id: 'qa-legacy-grid-succeeded' }, now, 'succeeded'), resultAssetId: gridAssetId },
      { ...createImageGenerationTask({ ...baseTask, id: gridTaskId, name: '旧九宫格失败任务' }, now, 'failed'), error: '隔离旧任务失败；用户可以明确重试。' },
    ];
    project.scenes[0].storyboardIds = project.storyboards.map((board) => board.id);
    state.projects = [project]; localStorage.setItem(key, JSON.stringify(state)); return state;
  }, { key: storageKey, sourceParts, story, png: legacyPng, gridAssetId, gridBoardId, gridTaskId });
};

const installFixture = async (scenario, fontScale = 100) => {
  const state = structuredClone(fixture); const project = state.project;
  state.settings.uiFontScalePercent = fontScale;
  if (scenario !== 'sequence') {
    const chosen = project.storyboards.find((board) => board.id === (scenario === 'legacy' ? gridBoardId : 'qa-grid-retirement-segment-2'));
    for (const key of ['sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount', 'sequencePromptHandoff']) delete chosen[key];
    project.storyboards = [chosen, ...project.storyboards.filter((board) => board.id === gridBoardId && board.id !== chosen.id)];
    project.sequencePlans = []; project.scenes[0].storyboardIds = project.storyboards.map((board) => board.id);
  }
  if (scenario === 'legacy') {
    const snapshot = JSON.parse(project.directorSettingsConfirmedFingerprint);
    snapshot[0] = 'grid'; snapshot[1] = 'text_reference'; snapshot[10] = 'converter_grid'; snapshot[16] = [gridAssetId];
    project.directorSettingsConfirmedFingerprint = JSON.stringify(snapshot);
  }
  state.projects = [project];
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, state }) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state)); }, { key: storageKey, state });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
  if (scenario === 'sequence') await page.locator('.sequence-director-strip .sequence-segment-chip').nth(1).click();
  await settle();
  return readState();
};

const assertNoGridCreation = async (label) => {
  assert.equal(await page.getByRole('button', { name: '九宫格', exact: true }).count(), 0, `${label}: retired mode cannot be a new-entry button`);
  assert.equal(await page.locator('.grid-director-readiness, .grid-workbench-guide').count(), 0, `${label}: retired binding/return guide cannot reappear`);
  const actionable = await page.locator('button, a, [role="button"]').allTextContents();
  assert.ok(!actionable.some((text) => /(?:先创建并绑定九宫格|去生成或上传九宫格|返回九宫格导演|绑定.*九宫格母版|生成\s*3×3\s*九宫格|转换九宫格提示词)/u.test(text)), `${label}: retired creation/binding action found`);
};

const auditLayout = async (scenario, fontScale, viewport) => {
  await page.setViewportSize(viewport); await page.locator('.director-result-copy').waitFor(); await settle();
  const result = await page.evaluate(() => {
    const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const initiallyVisible = (element) => {
      const box = rect(element); const clippedBy = [];
      if (box.width <= 0 || box.height <= 0 || box.x < -1 || box.y < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) clippedBy.push('viewport');
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent); const bounds = rect(parent);
        const left = bounds.x + parent.clientLeft; const top = bounds.y + parent.clientTop;
        if ((style.overflowX !== 'visible' && (box.x < left - 1 || box.right > left + parent.clientWidth + 1))
          || (style.overflowY !== 'visible' && (box.y < top - 1 || box.bottom > top + parent.clientHeight + 1))) {
          clippedBy.push(parent.className || parent.tagName);
        }
      }
      return { visible: clippedBy.length === 0, clippedBy };
    };
    const prompt = document.querySelector('.director-result-copy'); const row = document.querySelector('.director-result-actions');
    const controls = [...row.querySelectorAll(':scope > button, :scope > .storyboard-image-count-control')].map((element) => {
      const label = element.querySelector('span:not(.button-icon)') || element;
      const range = document.createRange(); range.selectNodeContents(label);
      const textRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      return { name: element.textContent.trim(), rect: rect(element), ...initiallyVisible(element), textLines: new Set(textRects.map((r) => Math.round(r.top * 2) / 2)).size, textRects: textRects.map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })) };
    });
    const outerPanels = ['.workspace', '.director-view', '.director-work-grid', '.director-control-card', '.director-setup-body', '.director-side-panel', '.director-result-pane'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing layout container ${selector}`);
      const original = element.scrollTop; element.scrollTop = 80; const scrollTest = element.scrollTop; element.scrollTop = original;
      return { selector, rect: rect(element), ...initiallyVisible(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, originalScrollTop: original, scrollTest };
    });
    const supportingRows = [...document.querySelectorAll('.director-reference-head .card-title, .director-reference-head .director-result-bridge, .director-result-head, .director-generate-bar, .director-result-actions')].map((element) => ({
      name: element.className, rect: rect(element), ...initiallyVisible(element),
    }));
    const original = prompt.scrollTop; prompt.scrollTop = 80; const scrollTest = prompt.scrollTop; prompt.scrollTop = original;
    const centers = controls.map((control) => control.rect.y + control.rect.height / 2);
    return { viewport: { width: innerWidth, height: innerHeight }, fontScale: Number(document.querySelector('.app-shell').dataset.uiFontScale), prompt: rect(prompt), promptVisibility: initiallyVisible(prompt), minHeight: parseFloat(getComputedStyle(prompt).minHeight), maxHeight: parseFloat(getComputedStyle(prompt).maxHeight), flexShrink: getComputedStyle(prompt).flexShrink,
      clientHeight: prompt.clientHeight, scrollHeight: prompt.scrollHeight, scrollTest, overflowY: getComputedStyle(prompt).overflowY,
      row: rect(row), rowClientWidth: row.clientWidth, rowScrollWidth: row.scrollWidth, controls, outerPanels, supportingRows, centerSpread: Math.max(...centers) - Math.min(...centers), documentScrollWidth: document.documentElement.scrollWidth, documentScrollHeight: document.documentElement.scrollHeight };
  });
  const label = `${scenario}-${viewport.width}x${viewport.height}-font${fontScale}`;
  layouts.push({ label, ...result }); await capture(label);
  assert.equal(result.fontScale, fontScale);
  assert.ok(result.prompt.height >= 159 && result.prompt.height <= 361 && result.minHeight === 160 && result.maxHeight === 360 && result.flexShrink === '1', `${label}: prompt body must use the available 160–360 CSS pixels without displacing controls`);
  assert.ok(result.promptVisibility.visible, `${label}: prompt viewport must be fully visible before any scrolling: ${result.promptVisibility.clippedBy.join(', ')}`);
  assert.ok(result.scrollHeight > result.clientHeight + 1 && result.scrollTest > 0 && ['auto', 'scroll'].includes(result.overflowY), `${label}: long body must scroll independently`);
  assert.ok(result.documentScrollHeight <= viewport.height + 1, `${label}: the document must not scroll vertically`);
  for (const panel of result.outerPanels) {
    assert.ok(panel.visible, `${label}: ${panel.selector} must start fully visible: ${panel.clippedBy.join(', ')}`);
    assert.ok(panel.scrollHeight <= panel.clientHeight + 1 && panel.originalScrollTop === 0 && panel.scrollTest === 0, `${label}: ${panel.selector} must fit without outer vertical scrolling`);
  }
  assert.equal(await page.locator('.director-reference-head .director-result-bridge').count(), 1, `${label}: video-director entry remains in the fixed header`);
  for (const supportingRow of result.supportingRows) assert.ok(supportingRow.visible, `${label}: ${supportingRow.name} must start fully visible: ${supportingRow.clippedBy.join(', ')}`);
  assert.equal(result.controls.length, 4, `${label}: three actions and image-count control must remain`);
  assert.ok(result.centerSpread <= 2, `${label}: bottom controls must stay on one row`);
  assert.ok(result.rowScrollWidth <= result.rowClientWidth + 1 && result.documentScrollWidth <= viewport.width + 1, `${label}: horizontal overflow`);
  assert.ok(result.prompt.bottom <= result.row.y + 1, `${label}: prompt overlaps actions`);
  for (const [index, control] of result.controls.entries()) {
    assert.ok(control.visible, `${label}: ${control.name} must be fully visible before scrolling: ${control.clippedBy.join(', ')}`);
    assert.ok(control.rect.x >= result.row.x - 1 && control.rect.right <= result.row.right + 1, `${label}: ${control.name} leaves its action row`);
    assert.ok(index === 0 || result.controls[index - 1].rect.right <= control.rect.x + 1, `${label}: bottom controls overlap`);
    assert.equal(control.textLines, 1, `${label}: ${control.name} text must remain on one line`);
    assert.ok(control.textRects.every((text) => text.x >= control.rect.x - 1 && text.right <= control.rect.right + 1 && text.y >= control.rect.y - 1 && text.bottom <= control.rect.bottom + 1), `${label}: ${control.name} text is clipped`);
  }
  for (const control of await page.locator('.director-result-actions > button, .director-result-actions input, .director-reference-head .director-result-bridge button').all()) {
    assert.ok(await control.evaluate((element) => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === element || element.contains(hit); }), `${label}: action must be unobscured before any outer scrolling`);
  }
  await assertNoGridCreation(label);
};

const downloadFrom = async (button, name) => {
  const pending = page.waitForEvent('download'); await button.click(); const download = await pending;
  const target = path.join(output, name); await download.saveAs(target); assert.ok(fs.statSync(target).size > 0); return target;
};

const runLegacy = async () => {
  phase = 'legacy-open'; const initial = await installFixture('legacy'); const original = legacySnapshot(initial); const calls = requests.length;
  assert.equal(original.board.workflow, 'grid'); assert.equal(original.asset.type, 'grid'); assert.equal(original.tasks.length, 2);
  await assertNoGridCreation('legacy stored grid settings');
  await page.getByRole('button', { name: '结果', exact: true }).click();
  await page.locator('.legacy-grid-notice').waitFor();
  assert.match(await page.locator('.legacy-grid-notice').innerText(), /历史.*(?:保留|保管)/u, 'legacy grid notice explains that saved content is retained');
  await page.locator('.director-result-copy').waitFor();
  assert.equal(await page.locator('.director-result-copy').textContent(), original.board.officialPromptZh, 'saved grid result must still be readable');
  await page.locator('.result-language-switch').getByRole('button', { name: 'English', exact: true }).click();
  assert.equal(await page.locator('.director-result-copy').textContent(), original.board.officialPromptEn);
  await page.locator('.result-language-switch').getByRole('button', { name: '中文', exact: true }).click();
  await capture('legacy-grid-prompt-readable');
  await nav('分镜时间线');
  const txt = await downloadFrom(page.getByRole('button', { name: '导出 TXT', exact: true }), 'legacy-grid-prompt.txt');
  assert.equal(fs.readFileSync(txt, 'utf8'), original.board.finalPrompt, 'TXT export preserves the complete saved grid prompt');
  await nav('资产库');
  const asset = page.locator(`#asset-card-${gridAssetId}`); await asset.waitFor();
  await asset.getByRole('button', { name: '查看大图并保存', exact: true }).click();
  const preview = page.getByRole('dialog', { name: original.asset.name, exact: true }); await preview.waitFor();
  assert.ok(await preview.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0));
  const exportedImage = await downloadFrom(preview.getByRole('button', { name: '保存图片', exact: true }), 'legacy-grid-asset.png');
  assert.deepEqual(fs.readFileSync(exportedImage), Buffer.from(original.asset.dataUrl.split(',')[1], 'base64'), 'saving a legacy grid image preserves its original PNG bytes');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await asset.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '资产提示词', exact: true }).inputValue(), original.asset.prompt, 'saved legacy image prompt stays readable');
  await page.locator('.modal').filter({ has: page.getByRole('heading', { name: '编辑资产资料', exact: true }) }).getByRole('button', { name: '关闭', exact: true }).click();
  await nav('生成任务'); await page.getByRole('tab', { name: /^图片任务/u }).click();
  const task = page.locator(`#image-task-${gridTaskId}`); await task.waitFor();
  assert.equal(await task.locator('.job-prompt').getAttribute('title'), original.tasks.find((entry) => entry.id === gridTaskId).prompt);
  await task.getByRole('button', { name: '复制「旧九宫格失败任务」的最终提示词', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original.tasks.find((entry) => entry.id === gridTaskId).prompt);
  await capture('legacy-grid-tasks-readable');
  assert.equal(requests.length, calls, 'opening, copying and exporting legacy data must never generate or convert');
  assert.deepEqual(legacySnapshot(await readState()), original, 'legacy data must not change while browsing/exporting');
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector(); await assertNoGridCreation('legacy reload');
  await page.getByRole('button', { name: '结果', exact: true }).click();
  assert.equal(await page.locator('.director-result-copy').textContent(), original.board.officialPromptZh);
  assert.deepEqual(legacySnapshot(await readState()), original, 'reload cannot migrate grid types or lose saved prompts');
  steps.push('stored grid mode: old image/prompt/tasks open, bilingual text reads, TXT/PNG export, task copy and reload preserve original grid records without a model call');

  phase = 'legacy-explicit-retry'; await nav('生成任务'); await page.getByRole('tab', { name: /^图片任务/u }).click();
  const retryBefore = requests.length;
  await page.locator(`#image-task-${gridTaskId} .image-regenerate-button`).click();
  await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key)).project.generationTasks.some((task) => task.regenerationSourceTaskId === id && ['succeeded', 'failed'].includes(task.status)), { key: storageKey, id: gridTaskId });
  const retried = await readState(); const child = retried.project.generationTasks.find((task) => task.regenerationSourceTaskId === gridTaskId);
  assert.equal(child.status, 'succeeded', child.error); assert.equal(child.assetKind, 'grid'); assert.equal(child.imageVariant, 'grid');
  assert.equal(child.prompt, original.tasks.find((entry) => entry.id === gridTaskId).prompt);
  assert.equal(retried.project.assets.find((asset) => asset.id === child.resultAssetId).type, 'grid');
  assert.deepEqual(legacySnapshot(retried), original, 'explicit retry adds a child without replacing original records');
  assert.deepEqual(requests.slice(retryBefore).map((entry) => entry.kind), ['image'], 'saved legacy prompt retry must not reconvert');
  await capture('legacy-explicit-retry-keeps-grid-type');
  steps.push('explicit historical grid retry makes one mock image request; child remains grid, original image/task/prompt are unchanged');
};

const runNineImages = async (scenario) => {
  phase = `${scenario}-nine-images`; await installFixture(scenario);
  const before = await readState(); const id = 'qa-grid-retirement-segment-2'; const board = before.project.storyboards.find((board) => board.id === id);
  const priorTasks = new Set(before.project.generationTasks.map((task) => task.id));
  const count = page.getByRole('spinbutton', { name: '自定义分镜图片数量', exact: true }); await count.fill('9');
  await page.getByRole('button', { name: '生成分镜图片（9张）', exact: true }).click();
  await page.waitForFunction(({ key, previous }) => {
    const tasks = JSON.parse(localStorage.getItem(key)).project.generationTasks.filter((task) => !previous.includes(task.id));
    return tasks.length === 9 && tasks.every((task) => ['succeeded', 'failed'].includes(task.status));
  }, { key: storageKey, previous: [...priorTasks] }, { timeout: 45_000 });
  const after = await readState(); const created = after.project.generationTasks.filter((task) => !priorTasks.has(task.id));
  assert.equal(created.length, 9); assert.ok(created.every((task) => task.kind === 'image' && task.assetKind === 'storyboard' && task.status === 'succeeded'), JSON.stringify(created.map((task) => ({ status: task.status, error: task.error }))));
  assert.deepEqual(created.map((task) => task.imageFrameIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(created.every((task) => task.imageFrameCount === 9 && task.sourceStoryboardId === id));
  assert.equal(new Set(created.map((task) => task.resultAssetId)).size, 9);
  const generatedIds = new Set(created.map((task) => task.resultAssetId));
  assert.ok(after.project.assets.filter((asset) => generatedIds.has(asset.id)).every((asset) => asset.type !== 'grid' && asset.role !== 'grid'));
  assert.deepEqual(fixedBoard(after.project.storyboards.find((entry) => entry.id === id)), fixedBoard(board), '9 image frames cannot retime, rewrite or increase fixed video shots');
  assert.deepEqual(after.project.sequencePlans, before.project.sequencePlans, 'image planning cannot resegment the long-story plan');
  assert.deepEqual(legacySnapshot(after), legacySnapshot(before), 'ordinary image generation cannot rewrite legacy records');
  const calls = requests.filter((entry) => entry.phase === phase);
  assert.equal(calls.filter((entry) => entry.kind === 'frame-plan').length, 1);
  assert.equal(calls.filter((entry) => entry.kind === 'image').length, 9);
  assert.equal(calls.filter((entry) => entry.kind === 'image-conversion').length, 9);
  assert.equal(after.project.generationTasks.filter((task) => task.kind === 'video' || task.kind == null).length, 0);
  await page.getByRole('button', { name: '送到视频导演台', exact: true }).click();
  await page.locator('.video-director-view').waitFor();
  const referenceRows = page.locator('#vd-single-generation-panel .vd-reference-row');
  assert.equal(await referenceRows.count(), 0, 'the fixture has no explicit references, so none of the nine generated image outputs may auto-bind');
  const draftPrompt = await page.getByRole('textbox', { name: '本次生成使用的完整提示词', exact: true }).inputValue();
  assert.equal(draftPrompt, board.officialPromptZh, 'opening a video draft must preserve the complete saved prompt');
  await capture(`${scenario}-nine-images-video-draft-not-auto-bound`);
  const manualCallCount = requests.length;
  const generatedAssets = created.slice().sort((left, right) => left.imageFrameIndex - right.imageFrameIndex)
    .map((task) => after.project.assets.find((asset) => asset.id === task.resultAssetId));
  assert.equal(new Set(generatedAssets.map((asset) => asset.name)).size, 9, 'independent frames have distinct selectable names');
  const firstSelection = [generatedAssets[8], generatedAssets[0]];
  await page.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
  let picker = page.getByRole('dialog', { name: '从图片资产库选择生成参考图', exact: true }); await picker.waitFor();
  for (const asset of firstSelection) await picker.getByRole('button', { name: `选择图片 ${asset.name}`, exact: true }).click();
  await picker.getByRole('button', { name: '使用所选图片', exact: true }).click();
  assert.deepEqual(await referenceRows.locator('.vd-reference-info .reference-image-name-text').allTextContents(), firstSelection.map((asset) => asset.name), 'the user can explicitly choose separate frames in their preferred order');
  await page.getByRole('button', { name: '从图片资产库选择', exact: true }).click();
  picker = page.getByRole('dialog', { name: '从图片资产库选择生成参考图', exact: true }); await picker.waitFor();
  const remainingSelection = generatedAssets.slice(1, 8);
  for (const asset of remainingSelection) await picker.getByRole('button', { name: `选择图片 ${asset.name}`, exact: true }).click();
  await picker.getByRole('button', { name: '使用所选图片', exact: true }).click();
  assert.deepEqual(await referenceRows.locator('.vd-reference-info .reference-image-name-text').allTextContents(), [...firstSelection, ...remainingSelection].map((asset) => asset.name), 'manual selection of all nine independent images remains available');
  assert.equal(await page.getByRole('textbox', { name: '本次生成使用的完整提示词', exact: true }).inputValue(), draftPrompt);
  assert.equal(requests.length, manualCallCount, 'manual image selection cannot convert, generate or submit a video');
  await capture(`${scenario}-nine-images-video-draft-manually-selected`);
  const draftState = await readState();
  assert.equal(draftState.project.generationTasks.filter((task) => task.kind === 'video' || task.kind == null).length, 0, 'opening a draft cannot submit video');
  assert.deepEqual(fixedBoard(draftState.project.storyboards.find((entry) => entry.id === id)), fixedBoard(board), 'video reference selection cannot change original video timing, shots, references or prompts');
  assert.deepEqual(draftState.project.sequencePlans, before.project.sequencePlans);
  assert.deepEqual(draftState.project.assets, after.project.assets, 'draft image selection cannot change source asset classifications or metadata');
  steps.push(`${scenario}: count=9 uses one mock AI frame plan, nine separate converter/image requests and tasks; fixed 15 seconds / 2 shots and sequence plan unchanged; video draft auto-binds none, while explicit selection of two and then all nine independent outputs remains available without submission`);
};

const runTransientGridUi = async () => {
  phase = 'transient-grid-ui'; await installFixture('single'); await nav('图像工作台');
  await page.locator('.image-view').waitFor();
  const before = await readState(); const callCount = requests.length;
  const marker = 'LEGACY_TRANSIENT_GRID_PROMPT: saved old nine-cell prompt, never convert or discard it.';
  // This is deliberately NOT a fake App or added production test hook. Invoke
  // the real mounted component's existing React setters to model an old tab
  // surviving a hot update with workbenchAssetKind/assetKind still set to grid.
  // Find lane state structurally, not by a brittle hook index.
  await page.locator('.image-view').evaluate((element, { marker, pixels, alternatePixels, gridAssetId }) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let component = key && element[key];
    while (component && !(typeof component.memoizedProps?.setAssetKind === 'function' && component.memoizedProps?.state)) component = component.return;
    if (!component) throw new Error('Cannot locate the real image workbench context');
    const kindHook = component.memoizedState;
    if (!kindHook?.queue?.dispatch || !['character', 'location', 'prop', 'grid', 'storyboard'].includes(kindHook.memoizedState)) throw new Error('Image workbench kind hook shape changed');
    let laneHook = kindHook;
    while (laneHook && !(laneHook.memoizedState?.ordinary && laneHook.memoizedState?.private && typeof laneHook.memoizedState.ordinary.generatedPrompt === 'string')) laneHook = laneHook.next;
    if (!laneHook?.queue?.dispatch) throw new Error('Cannot locate real image generation lanes');
    component.memoizedProps.setAssetKind('grid'); kindHook.queue.dispatch('grid');
    laneHook.queue.dispatch((current) => ({ ...current, ordinary: { ...current.ordinary, generatedPrompt: marker, generatedImagePreview: pixels,
      generatedImages: [
        { id: gridAssetId, preview: pixels, label: '旧九宫格暂存结果', prompt: marker },
        { id: 'qa-transient-second-image', preview: alternatePixels, label: '旧九宫格历史结果二', prompt: `${marker} SECOND_HISTORY_IMAGE` },
      ], selectedGeneratedAssetId: gridAssetId, outputLabel: '旧九宫格暂存结果', outputPane: 'prompt' } }));
  }, { marker, pixels: legacyPng, alternatePixels: png, gridAssetId });
  await settle(); await assertNoGridCreation('transient old grid UI');
  assert.equal((await page.locator('.image-asset-kind-tabs button.active').innerText()).trim(), '人物角色', 'a stale grid tab is displayed as the ordinary character category');
  assert.equal(await page.locator('.image-results-container').count(), 0, 'retiring transient grid UI cannot restore the removed duplicate results panel');
  await page.locator('.image-form-head').getByRole('button', { name: '提示词', exact: true }).click();
  assert.equal(await page.locator('.image-prompt-copy').innerText(), marker, 'retiring transient grid UI must preserve its already generated prompt in the independent left pane');
  await capture('transient-grid-ui-keeps-existing-prompt');
  assert.deepEqual(legacySnapshot(await readState()), legacySnapshot(before));
  assert.equal(requests.length, callCount, 'recovering a retired UI tab cannot regenerate anything');
  steps.push('real mounted workbench receives stale grid UI values: new creation/binding controls stay retired; its old generated prompt stays readable in the left pane and saved assets/tasks remain unchanged; duplicate results panel stays absent; no model call');
};

const run = async () => {
  await waitForCondition({ label: 'grid retirement Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    // Exercise the App's copy action without reading or replacing the user's
    // operating-system clipboard. This state belongs only to each QA page.
    let copiedText = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value) => { copiedText = String(value); },
      readText: async () => copiedText,
    } });
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await installMock(); fixture = await createFixture();
  if (focus === 'all' || focus === 'layout') {
    for (const scenario of ['single', 'sequence', 'legacy']) {
      for (const fontScale of [100, 130]) {
        phase = `${scenario}-layout-${fontScale}`; await installFixture(scenario, fontScale);
        if (scenario === 'legacy') {
          await page.getByRole('button', { name: '结果', exact: true }).click();
          await page.locator('.legacy-grid-notice').waitFor();
        }
        for (const viewport of [{ width: 1120, height: 800 }, { width: 1280, height: 720 }, { width: 1600, height: 900 }]) await auditLayout(scenario, fontScale, viewport);
        await nav('图像工作台'); await page.locator('.image-asset-kind-tabs').waitFor();
        assert.deepEqual((await page.locator('.image-asset-kind-tabs button').allTextContents()).map((text) => text.trim()), ['人物角色', '场景', '物品', '分镜图']);
        await assertNoGridCreation(`${scenario} image workbench`);
      }
    }
    assert.equal(requests.length, 0, 'normal entry and layout checks must not call models');
    steps.push('single/long-story/legacy reference result with retained notice at 1120, 1280, 1600 pixels and 100%/130% fonts: 160–360px independently scrollable prompt, initially visible headings and single-row actions, no outer scroll and no retired creation/binding entry');
  }
  if (focus === 'all' || focus === 'legacy') await runLegacy();
  if (focus === 'all' || focus === 'transient') await runTransientGridUi();
  if (focus === 'all' || focus === 'nine-images') for (const scenario of ['single', 'sequence']) await runNineImages(scenario);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, focus, isolatedBrowserStorage: true, productionDataRead: false, desktopBridge: false, paidApiCalls: 0, externalRequests: 0, steps, layouts, requests, screenshots, errors, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, focus, report: path.join(output, 'report.json'), steps, screenshots }));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, phase, steps, layouts, requests, errors, blockedRequests }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
