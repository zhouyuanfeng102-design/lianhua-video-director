import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// A fresh browser has no desktop bridge or production storage. Only one
// loopback text-model route is allowed to POST; every other request is blocked.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `sequence-prompt-handoff-${Date.now()}`));
const relativeOutput = path.relative(outputBase, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Handoff QA output must remain below output/playwright');
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Handoff QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const apiPath = '/qa-text-handoff-only/v1/chat/completions';
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'qa-text-handoff-project';
const fixturePage = '/__text_handoff_fixture.html';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated text handoff QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'text handoff UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const requests = []; const errors = []; const blockedRequests = []; const screenshots = []; const steps = [];
let phase = 'generate'; let held; let repairSerial = 0;
const sourceParts = [
  '师傅与徒弟站在山道石阶旁，师傅从药篓取出一株药草。',
  '师傅说：“接稳这株药草。”她将药草递到徒弟伸出的手前，双方的手指尚未完成交接。',
  '徒弟伸手接取药草，师傅的手指仍触着药草的根部。',
  '徒弟说：“好，我会小心。”他握稳药草后把药篓背带递向师傅抬起的右手。',
  '师傅伸手接取徒弟递来的药篓背带，双方的手仍靠在一起。',
  '师傅将药篓背好，与徒弟沿着同一条山道继续前行。',
];
const story = sourceParts.join('');
const dialogue = ['接稳这株药草。', '好，我会小心。'];
const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
const messageText = (payload, role) => (payload.messages || []).filter((message) => message.role === role).map((message) => textContent(message.content)).join('\n');
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  return match ? JSON.parse(match[1]) : undefined;
};
const translated = (source) => {
  const preserved = [];
  const protectedText = source.replace(/"[^"\n]*"|“[^”\n]*”|师傅|徒弟/gu, (value) => {
    const token = `__QA_KEEP_${preserved.length}__`; preserved.push(value); return token;
  });
  return protectedText.replace(/[\p{Script=Han}]+/gu, ' translated scene ')
    .replace(/，/gu, ', ').replace(/；/gu, '; ').replace(/。/gu, '.')
    .replace(/__QA_KEEP_(\d+)__/gu, (_all, index) => preserved[Number(index)]);
};
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
const stateBoards = (state) => state.project.sequencePlans[0].segments.map((segment) => state.project.storyboards.find((board) => board.id === segment.storyboardId));
const storedDrafts = (state) => stateBoards(state).map((board) => board && ({
  id: board.id, shots: board.shots, finalPrompt: board.finalPrompt, promptPlan: board.promptPlan,
  officialPromptZh: board.officialPromptZh, officialPromptEn: board.officialPromptEn,
  sequencePromptHandoff: board.sequencePromptHandoff, revisions: board.revisions,
}));
const fixedBoard = (board) => ({
  id: board.id, durationSec: board.durationSec, shotCount: board.shotCount,
  shots: board.shots.map((shot) => ({ id: shot.id, startSec: shot.startSec, endSec: shot.endSec, prompt: shot.prompt, dialogue: shot.dialogue })),
  finalPrompt: board.finalPrompt, parameters: board.targetOutput?.parameters,
});
const planStructure = (plan) => ({ ...plan, updatedAt: undefined, segments: plan.segments.map((segment) => ({
  ...segment, status: undefined, updatedAt: undefined, error: undefined, errorStage: undefined,
})) });
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false }); screenshots.push(`${name}.png`); };
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-all-sections').waitFor();
};
const installStoredFixture = async (fixture) => {
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, fixture }) => {
    fixture.projects = [fixture.project]; fixture.activeProjectId = fixture.project.id;
    localStorage.setItem(key, JSON.stringify(fixture));
  }, { key: storageKey, fixture });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
};
const selectSegmentResult = async (index) => {
  await page.locator('.sequence-director-strip .sequence-segment-chip').nth(index - 1).click();
  const resultTab = page.getByRole('button', { name: '结果', exact: true });
  if (await resultTab.count()) await resultTab.click();
  await page.getByLabel('本段文本衔接状态', { exact: true }).waitFor();
};
const waitForComplete = async () => {
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    const plan = state.project?.sequencePlans?.[0];
    return plan?.segments.length === 3 && plan.segments.every((segment) => {
      const board = state.project.storyboards.find((entry) => entry.id === segment.storyboardId);
      return board?.officialPromptZh && board.officialPromptEn && !board.officialPromptEnError
        && board.officialPromptEnSource === board.officialPromptZh
        && (segment.index === 1 || board.sequencePromptHandoff?.resultFingerprint);
    });
  }, storageKey, { timeout: 50_000 });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '顺序生成全部', exact: true }).waitFor();
};
const assertNoMedia = (state) => {
  assert.equal(state.project.id, projectId);
  assert.deepEqual(state.project.assets, [], 'text handoff cannot create or require a media asset');
  assert.deepEqual(state.project.generationTasks, [], 'text handoff cannot create or require video/image generation tasks');
};
const installModelMock = async () => {
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push({ method: request.method(), path: url.pathname }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePage) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>Text handoff fixture</title><body>Isolated local QA only</body></html>' }); return;
    }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      assert.equal(request.method(), 'POST');
      const payload = request.postDataJSON();
      const user = messageText(payload, 'user'); const system = messageText(payload, 'system');
      const conversion = tagged(user, 'video_conversion_data');
      const review = tagged(user, 'video_staging_review_data');
      const englishReview = tagged(user, 'review_data');
      const handoff = tagged(user, 'sequence_text_handoff_data')?.sequenceHandoff
        || review?.sequenceHandoff || conversion?.sequenceHandoff || englishReview?.stagingContext?.sequenceHandoff;
      const kind = conversion ? 'convert' : review ? 'review' : englishReview ? 'english-review'
        : /提示词翻译器/u.test(system) ? 'translate' : 'unexpected';
      assert.notEqual(kind, 'unexpected', `unexpected text request: ${system.slice(0, 80)}`);
      const segmentIndex = review?.segmentScope?.segmentIndex || conversion?.continuityContext?.segmentIndex
        || handoff?.segmentIndex || (phase === 'generate' ? 1 : 0);
      const entry = { phase, kind, segmentIndex, handoff, sourcePrompt: englishReview?.sourcePrompt,
        candidatePrompt: review?.candidatePrompt, imageCount: (payload.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url').length };
      requests.push(entry);
      assert.equal(entry.imageCount, 0, 'no reference pixels are required for text continuity');
      if (handoff) {
        assert.equal(handoff.openingOverlapSec, 0.5);
        assert.equal(handoff.previousSegmentIndex, handoff.segmentIndex - 1);
        assert.match(system, /0\.5/u);
        assert.match(system, /(?:同一|同场|相同).*(?:场面|画面)|递.*接/u);
      }
      let response;
      if (conversion) {
        response = conversion.shotEvidence.map((shot) => shot.localStructureDraft).join('\n');
        assert.ok(response.startsWith('【'), 'converter mock must return the actual per-shot canonical drafts');
      }
      else if (review) {
        response = review.candidatePrompt;
        assert.ok(typeof response === 'string' && response.includes('[Shot 1]'));
        if (handoff) {
          const scene = handoff.segmentIndex === 2
            ? '首镜前0.5秒呈现同一山道石阶的递药草画面：师傅的手指仍碰着药草根部，徒弟的手正在接拢，再继续接稳，不能跳成已经接完。'
            : '首镜前0.5秒呈现同一山道的递药篓背带画面：徒弟的手仍托着背带，师傅的右手正在接拢，再继续背好药篓。';
          response = response.replace('[Shot 1]', `[Shot 1] QA_HANDOFF_${phase}_${++repairSerial}: ${scene}`);
        }
        if (phase.startsWith('regenerate-')) {
          response = response.replace('[Shot 1]', `[Shot 1] QA_REGENERATED_${phase}_${++repairSerial}: 保持山道清晨侧光，双手与药草的位置清楚可见。`);
        }
      } else if (englishReview) response = englishReview.candidateEnglishPrompt;
      else response = translated(user.split('\n\n<sequence_text_handoff_data>')[0]);
      if (['repair-english-failure', 'regenerate-english-failure'].includes(phase) && kind === 'english-review') response = '';
      if (held && kind === 'review' && segmentIndex === held.segmentIndex && !held.started) {
        held.started = true; held.request = entry; await held.gate;
      }
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) }); }
      catch (error) { if (!held?.started) throw error; }
    } catch (error) {
      errors.push(String(error));
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"isolated handoff QA rejected request"}}' }).catch(() => {});
    }
  });
};
const seedFixture = async () => {
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, projectId, story, apiBase }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const state = createInitialState(); const now = Date.now();
    const characters = [
      { id: 'qa-teacher', name: '师傅', gender: '女', apparentAge: '35岁成年', race: '人类', appearance: '黑发盘起，固定面容', outfit: '青色长衣', signatureProps: '药篓', personality: '沉稳', motionHabits: '动作平稳', anchor: '青色长衣', negativeContinuity: '', assetIds: [] },
      { id: 'qa-student', name: '徒弟', gender: '男', apparentAge: '25岁成年', race: '人类', appearance: '短黑发，固定面容', outfit: '灰色长衣', signatureProps: '无', personality: '认真', motionHabits: '双手接物', anchor: '灰色长衣', negativeContinuity: '', assetIds: [] },
    ];
    const scene = { id: 'qa-handoff-scene', title: '山道递药草', content: story, summary: '山道递药草与接取药篓的连续动作', characterIds: characters.map((item) => item.id), locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: projectId, name: '纯文本衔接 · 三段隔离验证', characters, locations: [], props: [],
      sourceDocuments: [{ id: 'qa-handoff-source', name: '山道递药草', content: story, createdAt: now, updatedAt: now }],
      scenes: [scene], storyboards: [], sequencePlans: [], assets: [], generationTasks: [], createdAt: now, updatedAt: now,
      directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBase, apiKey: '', model: 'qa-text-handoff-158', vision: false };
    state.settings.imageApi.enabled = false; state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false;
    state.settings.runningHubVideo.enabled = false; state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, projectId, story, apiBase: `${origin}/qa-text-handoff-only/v1` });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  const timing = page.locator('#sequence-director-settings-panel #director-setup-timing');
  await timing.getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key))?.project?.directorSettingsConfirmedFingerprint, storageKey);
  await page.goto(`${origin}${fixturePage}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ key, sourceParts, story }) => {
    const { buildLocalSequencePlan, extractStoryBeats, validateSequencePlan } = await import('/src/storySegmentation.ts');
    const { masterPromptConfirmationFingerprint } = await import('/src/masterTimeline.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = JSON.parse(localStorage.getItem(key)); const project = state.project; const now = Date.now();
    const plan = buildLocalSequencePlan({ title: '山道递药草', story, totalDurationSec: 45, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [project.scenes[0].id] });
    const beats = extractStoryBeats(story); let cursor = 0;
    const shots = sourceParts.map((part, index) => {
      const start = cursor; cursor += part.length; const startSec = index * 7.5; const endSec = startSec + 7.5;
      const line = index === 1 ? '第1s @师傅:"接稳这株药草。"' : index === 3 ? '第1s @徒弟:"好，我会小心。"' : '无';
      const prompt = `【${startSec}s-${endSec}s】主体：@师傅与@徒弟（专注平静）[朝向：彼此双手] 正在 [${part}]（连贯交接药草与药篓）；空间：前景药草，中景师傅在左徒弟在右，背景山道石阶；光影：清晨柔和侧光；镜头：稳定中景侧拍；台词：${line}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
      return { id: `qa-master-shot-${index + 1}`, index: index + 1, startSec, endSec, subject: '师傅与徒弟', action: part,
        purpose: '连贯交接药草与药篓', camera: '稳定中景侧拍', lighting: '清晨柔和侧光', sound: '', transition: '自然承接', result: part,
        sourceStart: start, sourceEnd: cursor, sourceExcerpt: part,
        sourceBeatIds: beats.filter((beat) => beat.sourceStart < cursor && beat.sourceEnd > start).map((beat) => beat.id),
        referenceAssetIds: [], prompt, locked: false, authoredBy: 'text-api' };
    });
    const canonical = shots.map((shot) => shot.prompt).join('\n');
    const converter = state.converterPresets.find((item) => item.id === 'converter_unified_video') || state.converterPresets.find((item) => item.enabled && item.scope === 'video');
    const board = { id: 'qa-handoff-master', sceneId: project.scenes[0].id, sequencePlanId: plan.id, sourceStoryTitle: '山道递药草', sourceStoryContent: story,
      workflow: 'drama', inputMode: 'text', durationSec: 45, durationPreset: 'custom', shotMode: 'exact', shotCount: 6, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: converter.id,
      globalLock: '师傅在左，徒弟在右；二人保持青衣与灰衣，山道方向和清晨光线不变。', shots, finalPrompt: canonical, targetModelId: 'minimax-h3',
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId,
        converterPresetId: converter.id, sourceDocumentIds: ['qa-handoff-source'], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    plan.masterStoryboardId = board.id; plan.planningStage = 'segmented'; plan.segmentationSource = 'ai'; plan.segmentationReason = '隔离fixture已确认母镜头分配'; plan.fitStatus = 'balanced';
    plan.masterPromptDirectorSettingsFingerprint = project.directorSettingsConfirmedFingerprint; plan.masterPromptDirectorSettingsConfirmedAt = now;
    plan.segments.forEach((segment, index) => {
      const owned = shots.slice(index * 2, index * 2 + 2); Object.assign(segment, {
        title: `第${index + 1}段·${['递出药草', '接草递篓', '接篓同行'][index]}`, content: sourceParts.slice(index * 2, index * 2 + 2).join(''), summary: `山道连续动作第${index + 1}段`,
        sourceShotIds: owned.map((shot) => shot.id), sourceBeatIds: [...new Set(owned.flatMap((shot) => shot.sourceBeatIds))], globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15,
        narrativePurpose: '连贯交接药草与药篓', entryState: index === 0 ? '二人山道相对站立' : index === 1 ? '药草交接正在发生' : '药篓背带交接正在发生',
        exitState: index === 0 ? '师傅的手指仍触着药草根部，徒弟伸手接拢' : index === 1 ? '徒弟仍托着药篓背带，师傅右手开始接拢' : '二人沿同一方向前行',
        continuityPack: '准确承接上段末镜动作，不改变左右关系和衣着', transitionHint: '下一段首镜保留约0.5秒同一交接动作的视觉重合', boundaryReason: '已确认完整镜头分配', status: 'planned', locked: false,
      });
    });
    plan.masterPromptConfirmedAt = now; plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, board);
    plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    const issues = validateSequencePlan(plan, { requireMasterStoryboard: true, storyboards: [board] });
    if (issues.length) throw new Error(`Invalid QA plan: ${issues.join('; ')}`);
    project.storyboards = [board]; project.sequencePlans = [plan]; state.projects = [project]; localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, sourceParts, story });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
};

const run = async () => {
  await waitForCondition({ label: 'text handoff Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', (error) => errors.push(error.message));
  await installModelMock(); await seedFixture();
  const before = await readState(); assertNoMedia(before);
  assert.equal(before.project.storyboards.length, 1, 'fixture has only the confirmed master; no segment prompt preexists');
  await capture('before-three-segment-prompts');
  phase = 'cancel-initial-generation';
  let releaseInitial;
  held = { segmentIndex: 1, started: false, gate: new Promise((resolve) => { releaseInitial = resolve; }) };
  await page.getByRole('button', { name: '顺序生成全部', exact: true }).click();
  await waitForCondition({ label: 'held first-segment text generation', timeoutMs: 20_000, intervalMs: 30, check: () => held.started });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).click(); releaseInitial();
  await page.getByRole('button', { name: '顺序生成全部', exact: true }).waitFor(); await page.waitForTimeout(250);
  const cancelledInitial = await readState(); assertNoMedia(cancelledInitial);
  assert.equal(cancelledInitial.project.storyboards.length, 1, 'cancelled first prompt is not committed after its late API response');
  assert.equal(requests.filter((request) => request.phase === phase).length, 1, 'cancelled first prompt cannot start translation or later segments');
  held = undefined; await installStoredFixture(before);
  steps.push('cancelling initial sequential generation during first review discards late response before any segment prompt, translation or video task is created');
  phase = 'double-new-segment';
  let releaseDouble;
  held = { segmentIndex: 1, started: false, gate: new Promise((resolve) => { releaseDouble = resolve; }) };
  const doubleStart = requests.length;
  // Invoke the SAME rendered React handler twice synchronously: browser
  // disabled-state rerenders must not be the only duplicate-submit guard.
  await page.getByRole('button', { name: '生成当前段提示词', exact: true }).evaluate((element) => {
    const propKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    const onClick = propKey && element[propKey]?.onClick;
    if (typeof onClick !== 'function') throw new Error('cannot locate the actual rendered generation callback');
    const event = { target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} };
    onClick(event); onClick(event);
  });
  await waitForCondition({ label: 'same-render duplicate generation held at one request', timeoutMs: 20_000, intervalMs: 30, check: () => held.started });
  await page.waitForTimeout(150);
  assert.equal(requests.length - doubleStart, 1, 'same-render double click starts only one Chinese review');
  releaseDouble();
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key)); const segment = state.project.sequencePlans[0].segments[0];
    const board = state.project.storyboards.find((entry) => entry.id === segment.storyboardId);
    return segment.status === 'ready' && board?.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh;
  }, storageKey);
  const afterDouble = await readState(); assertNoMedia(afterDouble);
  assert.equal(afterDouble.project.storyboards.length, 2); assert.equal(afterDouble.project.sequencePlans[0].segments[0].failureReason, undefined);
  assert.deepEqual(requests.slice(doubleStart).map((request) => request.kind), ['review', 'translate', 'english-review']);
  held = undefined; await installStoredFixture(before); phase = 'generate';
  steps.push('same-render current-segment double-click invokes one review/translation pipeline and leaves the new segment ready, not failed');
  await page.getByRole('button', { name: '顺序生成全部', exact: true }).click();
  await waitForComplete();
  const generated = await readState(); assertNoMedia(generated); const boards = stateBoards(generated);
  assert.equal(boards.length, 3); assert.ok(boards.every(Boolean));
  for (const board of boards) {
    assert.equal(board.durationSec, 15); assert.equal(board.shots.length, 2);
    assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 7.5], [7.5, 15]]);
    assert.match(board.officialPromptZh, /\[Shot 1\][\s\S]*\[Shot 2\]\s+At 00:07\.500/u);
    assert.match(board.officialPromptEn, /\[Shot 1\][\s\S]*\[Shot 2\]\s+At 00:07\.500/u);
  }
  for (const [index, words] of dialogue.entries()) {
    assert.ok(boards[index].officialPromptZh.includes(words)); assert.ok(boards[index].officialPromptEn.includes(words));
  }
  for (const segmentIndex of [2, 3]) {
    const childRequests = requests.filter((request) => request.phase === 'generate' && request.handoff?.segmentIndex === segmentIndex);
    assert.ok(childRequests.length >= 3, `segment ${segmentIndex}: review plus both English passes carry parent text`);
    assert.ok(childRequests.every((request) => request.handoff.previousFinalPrompt === boards[segmentIndex - 2].officialPromptZh), 'every real payload uses preceding reviewed final H3, not old canonical source');
    assert.ok(childRequests.every((request) => request.handoff.previousStoryboardId === boards[segmentIndex - 2].id));
  }
  assert.match(boards[1].officialPromptZh, /师傅的手指仍碰着药草根部，徒弟的手正在接拢/u);
  const firstChildRequest = requests.findIndex((request) => request.handoff?.segmentIndex === 2);
  assert.ok(firstChildRequest > 0 && requests.slice(0, firstChildRequest).some((request) => request.kind === 'english-review'), 'first segment finishes bilingual work before next segment');
  await capture('three-bilingual-prompts-without-video');
  steps.push('three 15-second two-shot bilingual prompts generated sequentially from a confirmed master; no media/video task; exact previous reviewed H3 enters all child API calls; handoff opens with ongoing exchange');

  phase = 'repair';
  const protectedBeforeRepair = boards.map(fixedBoard); const originalFirst = JSON.stringify(boards[0]); const startRepairRequests = requests.length;
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).click();
  await page.waitForFunction(({ key, old }) => {
    const state = JSON.parse(localStorage.getItem(key)); const plan = state.project.sequencePlans[0];
    return plan.segments.slice(1).every((segment, index) => {
      const board = state.project.storyboards.find((entry) => entry.id === segment.storyboardId);
      return board?.officialPromptZh !== old[index] && board.officialPromptEnSource === board.officialPromptZh && !board.officialPromptEnError;
    });
  }, { key: storageKey, old: boards.slice(1).map((board) => board.officialPromptZh) }, { timeout: 50_000 });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).waitFor();
  const repaired = await readState(); assertNoMedia(repaired); const repairedBoards = stateBoards(repaired);
  assert.equal(JSON.stringify(repairedBoards[0]), originalFirst, 'repair leaves the first source segment untouched');
  assert.deepEqual(repairedBoards.map(fixedBoard), protectedBeforeRepair, 'repair cannot resegment, retime or rewrite canonical shots/parameters');
  assert.deepEqual(planStructure(repaired.project.sequencePlans[0]), planStructure(generated.project.sequencePlans[0]));
  for (const [index, board] of repairedBoards.entries()) {
    if (!index) continue;
    assert.ok(board.revisions?.some((revision) => revision.officialPromptZh === boards[index].officialPromptZh), 'original reviewed deliverable retained in version history');
    assert.ok(board.revisions?.some((revision) => revision.officialPromptZh === board.officialPromptZh), 'repaired deliverable retained in version history');
  }
  assert.ok(requests.slice(startRepairRequests).every((request) => request.kind !== 'convert'), 'continuity-only repair must not redo conversion or planning');
  await capture('continuity-only-repair-versions'); steps.push('continuity-only repair preserves first segment, canonical shots, fixed timing, parameters and plan; old/new reviewed drafts preserved as versions; no converter/planner request');

  phase = 'cancel';
  let release; held = { segmentIndex: 2, started: false, gate: new Promise((resolve) => { release = resolve; }) };
  const beforeCancel = storedDrafts(await readState());
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).click();
  await waitForCondition({ label: 'held second-segment text repair', timeoutMs: 20_000, intervalMs: 30, check: () => held.started });
  const batchRegenerate = page.getByRole('button').filter({ hasText: /^重新生成本段提示词$/u });
  await batchRegenerate.waitFor();
  assert.equal(await batchRegenerate.isDisabled(), true, 'completed segment keeps its regenerate button visible but disabled while sequential work is running');
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).click(); release();
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.deepEqual(storedDrafts(await readState()), beforeCancel, 'cancelled late response cannot replace an existing Chinese/English draft or create a version');
  held = undefined; await capture('cancelled-repair-preserves-drafts'); steps.push('cancel during delayed second-segment review rejects late response and preserves all drafts/versions');

  phase = 'repair-english-failure';
  const beforePartial = await readState(); const partialOriginalBoards = stateBoards(beforePartial); const partialStart = requests.length;
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).click();
  await page.waitForFunction(({ key, id, old }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh !== old && board.officialPromptEnError && !board.officialPromptEn;
  }, { key: storageKey, id: partialOriginalBoards[1].id, old: partialOriginalBoards[1].officialPromptZh });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  const partialState = await readState(); const partialBoard = stateBoards(partialState)[1]; assertNoMedia(partialState);
  assert.ok(partialBoard.sequencePromptHandoff?.resultFingerprint, 'qualified Chinese handoff remains stamped after English failure');
  assert.ok(partialBoard.revisions.some((revision) => revision.officialPromptZh === partialOriginalBoards[1].officialPromptZh));
  assert.ok(partialBoard.revisions.some((revision) => revision.officialPromptZh === partialBoard.officialPromptZh));
  assert.deepEqual(stateBoards(partialState)[2], partialOriginalBoards[2], 'English failure stops subsequent repair segments');
  assert.ok(requests.slice(partialStart).every((request) => request.handoff?.segmentIndex === 2));
  await selectSegmentResult(2); await capture('english-failure-keeps-qualified-chinese');
  phase = 'english-only-retry'; const retryStart = requests.length;
  await page.getByRole('button', { name: '仅重试英文', exact: true }).first().click();
  await page.waitForFunction(({ key, id, zh }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh === zh && board.officialPromptEn && board.officialPromptEnSource === zh && !board.officialPromptEnError;
  }, { key: storageKey, id: partialBoard.id, zh: partialBoard.officialPromptZh });
  const completedPartial = stateBoards(await readState())[1];
  assert.deepEqual(requests.slice(retryStart).map((request) => request.kind), ['translate', 'english-review'], 'English retry cannot repeat paid Chinese repair');
  assert.deepEqual(completedPartial.revisions, partialBoard.revisions); assert.deepEqual(completedPartial.sequencePromptHandoff, partialBoard.sequencePromptHandoff);
  assert.equal(completedPartial.officialPromptZh, partialBoard.officialPromptZh);
  await capture('english-only-retry-preserves-chinese'); steps.push('English failure saves qualified Chinese+handoff and original/new revisions, stops later segments; English-only retry makes exactly two translation calls and preserves Chinese, stamp and versions');

  phase = 'single-repair';
  await selectSegmentResult(2);
  assert.match(await page.getByLabel('本段文本衔接状态', { exact: true }).innerText(), /已按第 1 段末镜完成文本衔接/u);
  await page.getByText('查看文字衔接依据 · 无需视频或尾帧', { exact: true }).click();
  assert.match(await page.locator('.sequence-text-handoff-details pre').innerText(), /药草|交接/u);
  const beforeSingle = await readState(); const beforeSingleBoards = stateBoards(beforeSingle); const singleStart = requests.length;
  await page.getByRole('button', { name: '修复本段衔接', exact: true }).click();
  await page.waitForFunction(({ key, id, old }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh !== old && board.officialPromptEnSource === board.officialPromptZh;
  }, { key: storageKey, id: beforeSingleBoards[1].id, old: beforeSingleBoards[1].officialPromptZh });
  const afterSingle = await readState(); const afterSingleBoards = stateBoards(afterSingle);
  assert.deepEqual(afterSingleBoards[0], beforeSingleBoards[0]); assert.deepEqual(afterSingleBoards[2], beforeSingleBoards[2]);
  assert.deepEqual(afterSingleBoards.map(fixedBoard), beforeSingleBoards.map(fixedBoard));
  assert.ok(requests.slice(singleStart).length >= 3 && requests.slice(singleStart).every((request) => request.handoff?.segmentIndex === 2));
  await capture('single-segment-text-repair'); steps.push('single-segment repair exposes actual prior-shot evidence, changes only selected segment, preserves other drafts and fixed shot data');

  phase = 'locked';
  const lockedFixture = structuredClone(afterSingle); lockedFixture.project.sequencePlans[0].segments[2].locked = true;
  await installStoredFixture(lockedFixture); await selectSegmentResult(3);
  assert.equal(await page.getByRole('button', { name: '修复本段衔接', exact: true }).isDisabled(), true, 'locked segment cannot invoke single repair');
  assert.equal(await page.getByRole('button').filter({ hasText: /^重新生成本段提示词$/u }).isDisabled(), true, 'locked completed segment cannot regenerate its prompt');
  const beforeLocked = await readState(); const lockedBoards = stateBoards(beforeLocked); const lockedStart = requests.length;
  await page.getByRole('button', { name: '仅修复上下段衔接', exact: true }).click();
  await page.waitForFunction(({ key, old }) => {
    const state = JSON.parse(localStorage.getItem(key)); const segment = state.project.sequencePlans[0].segments[1];
    const board = state.project.storyboards.find((entry) => entry.id === segment.storyboardId);
    return board.officialPromptZh !== old && board.officialPromptEnSource === board.officialPromptZh;
  }, { key: storageKey, old: lockedBoards[1].officialPromptZh });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  const afterLocked = await readState(); assert.deepEqual(stateBoards(afterLocked)[2], lockedBoards[2]);
  assert.ok(requests.slice(lockedStart).every((request) => request.handoff?.segmentIndex === 2));
  await capture('locked-segment-is-preserved'); steps.push('locked segment disables single repair and is excluded from bulk repair; its complete prompt/version snapshot remains byte-identical');

  phase = 'missing-parent';
  const missingFixture = structuredClone(afterSingle); const missingParentId = stateBoards(missingFixture)[0].id;
  missingFixture.project.storyboards = missingFixture.project.storyboards.filter((board) => board.id !== missingParentId);
  await installStoredFixture(missingFixture); await selectSegmentResult(2);
  const missingStart = requests.length; const beforeMissing = storedDrafts(await readState());
  await page.getByRole('button', { name: '修复本段衔接', exact: true }).click();
  await page.getByText(/第 1 段尚无正确关联的最终提示词/u).first().waitFor();
  await page.waitForTimeout(150);
  assert.equal(requests.length, missingStart, 'missing exact parent must not call AI or borrow the master/another segment');
  assert.deepEqual(storedDrafts(await readState()), beforeMissing);
  await capture('missing-parent-stops-before-api'); steps.push('missing exact preceding prompt shows a precise message and cannot call AI, reuse master or overwrite existing child drafts');

  phase = 'changed-parent';
  const changedFixture = structuredClone(afterSingle); const changedParent = stateBoards(changedFixture)[0];
  changedParent.officialPromptZh = changedParent.officialPromptZh.replace('At 00:07.500,', 'At 00:07.500, USER_EDITED_PREVIOUS_FINAL:药草仍由双方手指共同托住。');
  changedParent.targetOutput.prompt = changedParent.officialPromptZh;
  changedParent.officialPromptEn = ''; changedParent.officialPromptEnSource = ''; changedParent.englishPrompt = ''; changedParent.englishPromptSource = '';
  await installStoredFixture(changedFixture); await selectSegmentResult(2);
  assert.match(await page.getByLabel('本段文本衔接状态', { exact: true }).innerText(), /变化|重新对齐/u);
  const changedStart = requests.length; const beforeChanged = stateBoards(await readState());
  await page.getByRole('button', { name: '修复本段衔接', exact: true }).click();
  await page.waitForFunction(({ key, id, old }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh !== old && board.officialPromptEnSource === board.officialPromptZh;
  }, { key: storageKey, id: beforeChanged[1].id, old: beforeChanged[1].officialPromptZh });
  const changedCalls = requests.slice(changedStart);
  assert.ok(changedCalls.length >= 3 && changedCalls.every((request) => request.handoff?.previousFinalPrompt === changedParent.officialPromptZh));
  assert.deepEqual(stateBoards(await readState())[0], beforeChanged[0], 'repairing a child cannot regenerate its edited source parent');
  await capture('changed-parent-new-evidence'); steps.push('editing prior final text marks child stale; explicit repair sends the newly edited full parent text through all API stages without regenerating parent');

  phase = 'regenerate-current';
  await installStoredFixture(generated); await selectSegmentResult(1);
  const regenerateButton = page.getByRole('button').filter({ hasText: /^重新生成本段提示词$/u });
  await regenerateButton.waitFor();
  assert.equal(await regenerateButton.isEnabled(), true, 'completed first segment exposes a usable regenerate action');
  const beforeRegenerate = await readState(); const beforeRegenerateBoards = stateBoards(beforeRegenerate); const regenerateStart = requests.length;
  let releaseRegenerate;
  held = { segmentIndex: 1, started: false, gate: new Promise((resolve) => { releaseRegenerate = resolve; }) };
  await regenerateButton.scrollIntoViewIfNeeded(); await capture('completed-first-segment-regenerate-button');
  await regenerateButton.click();
  await waitForCondition({ label: 'held first-segment regeneration review', timeoutMs: 20_000, intervalMs: 30, check: () => held.started });
  assert.equal(await regenerateButton.isDisabled(), true, 'regenerate action is disabled while its review is pending');
  assert.deepEqual(storedDrafts(await readState()), storedDrafts(beforeRegenerate), 'pending regeneration cannot replace a saved draft before review and translation finish');
  await capture('regenerate-first-segment-busy'); releaseRegenerate();
  await page.waitForFunction(({ key, id, old }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh !== old && board.officialPromptZh.includes('QA_REGENERATED_regenerate-current_')
      && board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh && !board.officialPromptEnError;
  }, { key: storageKey, id: beforeRegenerateBoards[0].id, old: beforeRegenerateBoards[0].officialPromptZh });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '重新生成本段提示词' && !button.disabled));
  held = undefined;
  const regenerated = await readState(); const regeneratedBoards = stateBoards(regenerated); const regeneratedFirst = regeneratedBoards[0]; assertNoMedia(regenerated);
  assert.deepEqual(requests.slice(regenerateStart).map((request) => request.kind), ['convert', 'review', 'translate', 'english-review'], 'actual regenerate click must perform conversion, Chinese review and both English stages');
  assert.equal(regeneratedFirst.id, beforeRegenerateBoards[0].id, 'regeneration updates the existing segment storyboard');
  assert.equal(regeneratedFirst.durationSec, beforeRegenerateBoards[0].durationSec);
  assert.deepEqual(regeneratedFirst.shots.map((shot) => [shot.startSec, shot.endSec]), beforeRegenerateBoards[0].shots.map((shot) => [shot.startSec, shot.endSec]));
  assert.deepEqual(regeneratedFirst.targetOutput?.parameters, beforeRegenerateBoards[0].targetOutput?.parameters, 'regeneration preserves output video parameters');
  assert.deepEqual(regenerated.project.sequencePlans, beforeRegenerate.project.sequencePlans, 'regeneration cannot rewrite or resegment the full plan');
  assert.deepEqual(regenerated.project.storyboards.filter((board) => board.id !== regeneratedFirst.id), beforeRegenerate.project.storyboards.filter((board) => board.id !== regeneratedFirst.id), 'all other segments and the confirmed master remain byte-identical');
  assert.ok(regeneratedFirst.revisions.some((revision) => revision.reason === 'pre-regenerate' && revision.officialPromptZh === beforeRegenerateBoards[0].officialPromptZh && revision.officialPromptEn === beforeRegenerateBoards[0].officialPromptEn), 'old bilingual prompt is retained in version history');
  assert.ok(regeneratedFirst.revisions.some((revision) => revision.reason === 'regenerate' && revision.officialPromptZh === regeneratedFirst.officialPromptZh && revision.officialPromptEn === regeneratedFirst.officialPromptEn), 'new bilingual prompt is retained in version history');
  await regenerateButton.scrollIntoViewIfNeeded(); await capture('regenerated-first-segment-with-history');
  steps.push('completed first segment exposes a real regenerate button; click performs exactly convert/review/translate/English-review, disables itself while busy, retains old/new bilingual revisions, and preserves duration, shot timing, video parameters, other segments, master, full plan and empty media tasks');

  phase = 'regenerate-english-failure'; const regenerationFailureStart = requests.length;
  await regenerateButton.click();
  await page.waitForFunction(({ key, id, old }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh !== old && board.officialPromptZh.includes('QA_REGENERATED_regenerate-english-failure_')
      && board.officialPromptEnError && !board.officialPromptEn;
  }, { key: storageKey, id: regeneratedFirst.id, old: regeneratedFirst.officialPromptZh });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '重新生成本段提示词' && !button.disabled));
  const regenerationPartial = await readState(); const regenerationPartialFirst = stateBoards(regenerationPartial)[0]; assertNoMedia(regenerationPartial);
  const regenerationFailureKinds = requests.slice(regenerationFailureStart).map((request) => request.kind);
  assert.deepEqual(regenerationFailureKinds.slice(0, 3), ['convert', 'review', 'translate']);
  assert.ok(regenerationFailureKinds.length >= 4 && regenerationFailureKinds.slice(3).every((kind) => kind === 'english-review'), 'automatic empty-output recovery may only repeat English review');
  assert.deepEqual(regenerationPartial.project.sequencePlans, regenerated.project.sequencePlans);
  assert.deepEqual(regenerationPartial.project.storyboards.filter((board) => board.id !== regeneratedFirst.id), regenerated.project.storyboards.filter((board) => board.id !== regeneratedFirst.id));
  assert.ok(regenerationPartialFirst.revisions.some((revision) => revision.officialPromptZh === regeneratedFirst.officialPromptZh));
  assert.ok(regenerationPartialFirst.revisions.some((revision) => revision.officialPromptZh === regenerationPartialFirst.officialPromptZh));
  await capture('regenerated-first-segment-english-failure');
  phase = 'regeneration-english-only-retry'; const regenerationRetryStart = requests.length;
  await page.getByRole('button', { name: '仅重试英文', exact: true }).first().click();
  await page.waitForFunction(({ key, id, zh }) => {
    const board = JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === id);
    return board.officialPromptZh === zh && board.officialPromptEn && board.officialPromptEnSource === zh && !board.officialPromptEnError;
  }, { key: storageKey, id: regeneratedFirst.id, zh: regenerationPartialFirst.officialPromptZh });
  const regenerationRetried = await readState(); const regenerationRetriedFirst = stateBoards(regenerationRetried)[0]; assertNoMedia(regenerationRetried);
  assert.deepEqual(requests.slice(regenerationRetryStart).map((request) => request.kind), ['translate', 'english-review'], 'retry after regeneration failure repeats only English work');
  assert.equal(regenerationRetriedFirst.officialPromptZh, regenerationPartialFirst.officialPromptZh);
  assert.deepEqual(regenerationRetriedFirst.revisions, regenerationPartialFirst.revisions);
  assert.deepEqual(regenerationRetried.project.sequencePlans, regenerationPartial.project.sequencePlans);
  assert.deepEqual(regenerationRetried.project.storyboards.filter((board) => board.id !== regeneratedFirst.id), regenerationPartial.project.storyboards.filter((board) => board.id !== regeneratedFirst.id));
  await regenerateButton.scrollIntoViewIfNeeded(); await capture('regenerated-first-segment-english-retried');
  steps.push('regeneration with failed English review keeps the new qualified Chinese and old/new versions; its visible English-only retry makes exactly two English calls while preserving Chinese, revisions, other segments and full plan; locked and sequentially busy completed segments disable regeneration');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, isolatedBrowserStorage: true, productionDataRead: false, externalRequests: 0,
    paidApiCalls: 0, requests, steps, screenshots, errors, blockedRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), steps, screenshots }));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); }
  const failedFixture = page ? await readState().catch(() => undefined) : undefined;
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, requests, errors, blockedRequests, failedFixture }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
