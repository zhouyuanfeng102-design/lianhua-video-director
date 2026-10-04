import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App/browser + synthetic, deterministic text responses only. This is a
// transport/state transaction regression, not an assessment of model quality.
// It never reads the desktop profile or real project, calls a paid provider,
// or starts image/video generation. All non-loopback traffic is blocked.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `speech-first-duration-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA evidence must stay under output/playwright');
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  try { if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error('QA evidence cannot traverse symlinks'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__speech_first_fixture.html';
const apiPath = '/__speech_first_mock__/v1/chat/completions';
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'speech-first-duration-ui-project';
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
const sourceParts = [
  '成年乙在河边对成年甲说：“我们先在这里休息，喝完水再沿着这条小路走吧。”',
  '成年甲举杯喝一小口水，再把杯子放回桌面，喝水时不说话。',
  '成年甲放下杯子后对成年乙说：“好的，我们等你一起。”',
  '成年乙对成年甲说：“前面的木桥正在维修，我们需要绕过那片树林，从右侧石桥过去，过桥以后仍然沿着河岸走。”',
  '成年甲和成年乙沿着同一条小路离开桌边。',
];
const story = sourceParts.join('');
const estimate = (duration) => ({ minSec: duration, recommendedSec: duration, maxSec: duration + 15,
  fitStatus: 'balanced', reason: `隔离模型先安排完整发话及喝水动作，再采用${duration}秒的完整15秒窗口。` });
const initialEstimate = estimate(15);
const expandedEstimate = estimate(30);
const shotRanges = [[0, 6.5], [6.5, 9], [9, 15], [15, 26], [26, 30]];
const lines = ['我们先在这里休息，喝完水再沿着这条小路走吧。', '好的，我们等你一起。', '前面的木桥正在维修，我们需要绕过那片树林，从右侧石桥过去，过桥以后仍然沿着河岸走。'];
const makeShots = (duration) => {
  const shots = shotRanges.map(([startSec, endSec], index) => ({ startSec, endSec,
    sourceExcerpt: sourceParts[index], purpose: '依原文保持发话与口部动作次序',
    subject: index === 0 || index === 3 ? '成年乙' : index === 1 || index === 2 ? '成年甲' : '成年甲、成年乙',
    action: sourceParts[index], camera: '同轴侧面中景，根据当前发话者转移重点',
    transition: '自然承接前镜结果', lighting: '河边自然柔光', sound: '原对白及轻微水声，无配乐',
    result: index === 1 ? '杯子放回桌面，成年甲嘴部恢复自由' : '保持原人物位置和朝向',
    space: '二人不越轴换位，石桥位于沿河方向', direction: '保持河岸世界方向',
    performance: '听者自然听取反应，不做同步说话口型',
    dialogue: index === 0 ? `第0.2–6.2s @成年乙（原声音身份、在画、听者成年甲）：“${lines[0]}”`
      : index === 2 ? `第0.2–3.0s @成年甲（原声音身份、在画、听者成年乙）：“${lines[1]}”`
        : index === 3 ? `第0.2–10.7s @成年乙（原声音身份、在画、听者成年甲）：“${lines[2]}”` : '无',
  }));
  if (duration === 45) shots.push({ ...shots.at(-1), startSec: 30, endSec: 45, action: '二人继续沿同一路径行走，无新增对白。' });
  return shots;
};
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  return match ? JSON.parse(match[1]) : undefined;
};
const messageText = (payload, role) => (payload.messages || []).filter((entry) => entry.role === role)
  .map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')).join('\n');
const translated = (source) => {
  const kept = [];
  return source.replace(/<d>[\s\S]*?<\/d>|"[^"\n]*"|“[^”\n]*”|成年甲|成年乙/gu, (value) => {
    const token = `__QA_KEEP_${kept.length}__`; kept.push(value); return token;
  }).replace(/[\p{Script=Han}]+/gu, ' translated scene ')
    .replace(/，/gu, ', ').replace(/；/gu, '; ').replace(/。/gu, '.')
    .replace(/__QA_KEEP_(\d+)__/gu, (_all, index) => kept[Number(index)]);
};
const requests = []; const errors = []; const blockedRequests = []; const stages = []; const screenshots = [];
let browser; let context; let page; let phase = 'expand'; let hold;
const setHold = (kind) => { let release; const gate = new Promise((resolve) => { release = resolve; }); hold = { kind, gate, release, started: false, finished: false }; return hold; };
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled' }); screenshots.push(file); };
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).waitFor();
};
const exposeControls = async () => {
  const expand = page.getByRole('button', { name: '展开规划参数', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByLabel('全片总秒数', { exact: true }).waitFor();
};
const masterFacts = (state) => ({ plan: state.project.sequencePlans[0],
  boards: state.project.storyboards });
const assertNoMedia = (state) => {
  assert.equal(state.project.id, projectId);
  assert.deepEqual(state.project.assets, []); assert.deepEqual(state.project.generationTasks, []);
};
const waitHeld = () => waitForCondition({ label: `${phase} held model response`, timeoutMs: 40_000, intervalMs: 100, check: async () => hold?.started });

try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host && url.pathname === '/') return;
    blockedRequests.push(socket.url()); socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push(request.url()); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated duration fixture</body></html>' }); return; }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      assert.equal(request.method(), 'POST'); const payload = request.postDataJSON();
      const user = messageText(payload, 'user'); const system = messageText(payload, 'system');
      const durationData = tagged(user, 'story_data'); const durationReview = tagged(user, 'story_duration_review_data');
      const planning = tagged(user, 'storyboard_planning_data'); const planningReview = tagged(user, 'storyboard_ai_review_data');
      const conversion = tagged(user, 'video_conversion_data'); const stagingReview = tagged(user, 'video_staging_review_data');
      const englishReview = tagged(user, 'review_data');
      const segmentation = tagged(user, 'ai_segmentation_data'); const segmentationReview = tagged(user, 'ai_segmentation_review_data');
      let kind; let response; let data;
      if (durationData || durationReview) {
        kind = durationData ? 'estimate' : 'estimate-review'; data = durationData || durationReview.originalData;
        assert.equal(data.story, story); assert.equal(data.segmentDurationSec, 15);
        response = initialEstimate;
      } else if (system.includes('智能导演分类器')) { kind = 'director'; response = { mode: 'narrative', reason: '合成河边对话与喝水动作' }; }
      else if (planning || planningReview) {
        kind = planning ? 'planning' : 'planning-review'; data = planning || planningReview;
        assert.equal(data.allowDurationExpansion, true); assert.equal(data.requiredSegmentDurationSec, 15);
        assert.equal(data.durationSec, phase === 'expand' ? 15 : 30);
        assert.equal(data.story || data.sourceStory, story);
        assert.equal(data.requiredShotCount, undefined, 'auto does not turn one window into one mandatory shot');
        const duration = phase === 'expand' ? 30 : 45;
        response = { shots: makeShots(duration), durationEstimate: estimate(duration) };
      } else if (conversion) {
        kind = 'convert'; data = conversion;
        response = conversion.shotEvidence.map((shot) => shot.localStructureDraft).join('\n');
        assert.match(response, /【0s-/u);
      } else if (stagingReview) { kind = 'staging-review'; data = stagingReview; response = stagingReview.candidatePrompt; }
      else if (englishReview) { kind = 'english-review'; data = englishReview; response = englishReview.candidateEnglishPrompt; }
      else if (segmentation || segmentationReview) {
        kind = segmentation ? 'segmentation' : 'segmentation-review'; data = segmentation || segmentationReview.originalData;
        assert.equal(data.totalDurationSec, 30); assert.equal(data.preferredSegmentDurationSec, 15);
        const segments = [0, 1].map((index) => {
          const start = index * 15; const end = start + 15;
          const owned = data.masterShots.filter((shot) => shot.startSec >= start && shot.endSec <= end);
          assert.ok(owned.length > 0);
          return { title: `第${index + 1}段·合成对话`, summary: index ? '完整后一句与离开' : '前两句与喝水动作',
            sourceShotIds: owned.map((shot) => shot.id), sourceBeatIds: [...new Set(owned.flatMap((shot) => shot.sourceBeatIds || []))],
            boundaryAfterShotId: owned.at(-1).id, durationSec: 15, globalStartSec: start, globalEndSec: end,
            narrativePurpose: '依原文保留完整发话与口部动作', entryState: index ? '成年甲已放杯并回应，成年乙准备接话' : '两位成年人站在河边桌旁',
            exitState: index ? '二人沿着同一路径离开' : '成年甲完整回应结束，成年乙准备接话',
            transitionHint: '维持沿河方向和说话人身份，开头仅短暂承接', boundaryReason: '15秒完整窗口，位于完整发话之间',
            continuityPack: '保持同一人物声音、服装、位置与河岸光线', };
        });
        response = { reason: '隔离模型按已确认30秒母时间轴分为两个15秒窗口', segments };
      } else if (/提示词翻译器/u.test(system)) { kind = 'translate'; response = translated(user); }
      else throw new Error(`Unexpected mock request: ${system.slice(0, 100)}`);
      const entry = { phase, kind, data, response }; requests.push(entry);
      console.log(`MOCK ${phase}: ${kind}`);
      if (phase === 'conversion-failure' && kind === 'convert') {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA_EXPECTED_CONVERSION_FAILURE_45_SECONDS' } }) }); return;
      }
      const requestHold = hold;
      if (requestHold && kind === requestHold.kind && !requestHold.started) {
        requestHold.started = true; await requestHold.gate;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: typeof response === 'string' ? response : JSON.stringify(response) }, finish_reason: 'stop' }] }) }).catch((cause) => {
        if (phase !== 'late') throw cause;
      });
      entry.completed = true;
      if (requestHold?.started) requestHold.finished = true;
    } catch (cause) {
      errors.push(String(cause));
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: `Isolated mock rejected request: ${cause.message}` } }) }).catch(() => {});
    }
  });

  await page.goto(`${origin}${fixturePath}`);
  await page.evaluate(async ({ key, projectId, story, origin }) => {
    const { createInitialState } = await import('/src/storage.ts'); const state = createInitialState(); const now = Date.now();
    const characters = [
      { id: 'adult-a', name: '成年甲', gender: '女', apparentAge: '30岁成年', race: '人类', appearance: '短黑发，固定面容', outfit: '蓝色外套', signatureProps: '无', personality: '沉稳', motionHabits: '动作自然', anchor: '蓝色外套', negativeContinuity: '', assetIds: [] },
      { id: 'adult-b', name: '成年乙', gender: '男', apparentAge: '30岁成年', race: '人类', appearance: '短棕发，固定面容', outfit: '灰色外套', signatureProps: '无', personality: '认真', motionHabits: '动作自然', anchor: '灰色外套', negativeContinuity: '', assetIds: [] },
    ];
    const scene = { id: 'speech-ui-scene', title: '河边休息与完整对白', content: story, summary: '喝水与完整对白顺序', characterIds: characters.map((entry) => entry.id), locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: projectId, name: '完整发话扩时隔离测试', characters, locations: [], props: [], scenes: [scene],
      sourceDocuments: [{ id: 'speech-ui-source', name: scene.title, content: story, createdAt: now, updatedAt: now }],
      assets: [], generationTasks: [], storyboards: [], sequencePlans: [], storyDraft: undefined,
      directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined, createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = projectId;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__speech_first_mock__/v1`, apiKey: '', model: 'mock-speech-first', vision: false };
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    state.settings.imageApi.enabled = false; state.settings.visionApi.enabled = false;
    state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false; state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, projectId, story, origin });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.locator('#sequence-director-settings-panel #director-setup-timing').getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
  await page.locator('.sequence-planner-panel').waitFor();
  await page.getByLabel('全片总秒数', { exact: true }).fill('15');
  setHold('planning');
  await page.getByRole('button', { name: '估算全片时长', exact: true }).click(); await waitHeld();
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '15');
  assert.match(await page.locator('.sequence-estimate-copy strong').innerText(), /估时建议 15 秒/u);
  assert.equal((await readState()).project.storyboards.length, 0, 'pending expanded master cannot write early');
  await capture('01-estimated-15-pending-master'); hold.release();
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key)); const plan = state.project.sequencePlans[0];
    const board = state.project.storyboards.find((item) => item.id === plan?.masterStoryboardId);
    return (plan?.totalDurationSec === 30 && board?.officialPromptZh && board?.officialPromptEn && !board.officialPromptEnError)
      || Boolean(document.querySelector('.sequence-planning-error'));
  }, storageKey, { timeout: 60_000 });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.sequence-planning-error').count(), 0, 'initial master/H3 should complete');
  await page.locator('.sequence-master-review').getByRole('button', { name: '重新生成', exact: true }).waitFor();
  const completed = await readState(); const completedPlan = completed.project.sequencePlans[0];
  const completedBoard = completed.project.storyboards.find((item) => item.id === completedPlan.masterStoryboardId);
  assert.deepEqual([completedPlan.requestedTotalDurationSec, completedPlan.totalDurationSec, completedPlan.segmentDurationSec], [30, 30, 15]);
  assert.equal(completedBoard.durationSec, 30); assert.equal(completedBoard.shots.length, 5);
  assert.deepEqual(completedBoard.shots.map(({ startSec, endSec }) => [startSec, endSec]), shotRanges);
  assert.deepEqual(completedBoard.shots.map((shot) => shot.dialogue), makeShots(30).map((shot) => shot.dialogue));
  assert.equal(completedBoard.sourceStoryContent, story);
  assert.equal(completedPlan.durationEstimateSnapshot.estimate.recommendedSec, 30);
  assert.equal(completedPlan.durationEstimateSnapshot.estimate.reason, expandedEstimate.reason);
  assert.match(completedBoard.officialPromptZh, /\[Shot 5\]/u); assert.match(completedBoard.officialPromptEn, /\[Shot 5\]/u);
  assert.equal(completedBoard.officialPromptEnSource, completedBoard.officialPromptZh);
  await exposeControls();
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '30');
  assert.match(await page.locator('.sequence-estimate-copy strong').innerText(), /估时建议 30 秒/u);
  assert.match(await page.locator('.sequence-planner-controls').innerText(), /全片 30 秒 = 2 段 × 15 秒/u);
  assertNoMedia(completed); stages.push('real-estimate-and-full-master-H3-pipeline-15-to30-without-self-cancellation');
  await capture('02-expanded-30-five-shots');

  await page.reload({ waitUntil: 'networkidle' }); await enterDirector(); await exposeControls();
  assert.deepEqual(masterFacts(await readState()), masterFacts(completed), 'reload must preserve committed full master');
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '30');
  assert.match(await page.locator('.sequence-estimate-copy strong').innerText(), /估时建议 30 秒/u);
  stages.push('expanded-duration-estimate-and-bilingual-master-persist-after-real-reload');

  phase = 'segment'; hold = undefined;
  await page.locator('.sequence-master-review').getByRole('button', { name: '确认总提示词', exact: true }).click();
  await page.locator('.sequence-master-review').getByRole('button', { name: '② AI 按剧情边界分段', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.sequencePlans[0]?.segments.length === 2, storageKey, { timeout: 45_000 });
  const split = await readState(); const splitPlan = split.project.sequencePlans[0];
  assert.deepEqual(splitPlan.segments.map((segment) => [segment.globalStartSec, segment.globalEndSec, segment.durationSec]), [[0, 15, 15], [15, 30, 15]]);
  assert.deepEqual(splitPlan.segments.flatMap((segment) => segment.sourceShotIds), completedBoard.shots.map((shot) => shot.id));
  const contentWithoutSaveTime = (boards) => boards.map(({ updatedAt, ...board }) => board);
  assert.deepEqual(contentWithoutSaveTime(split.project.storyboards), contentWithoutSaveTime(completed.project.storyboards), 'grouping does not retime or rewrite master shots');
  assertNoMedia(split); stages.push('real-confirm-and-AI-segmentation-produces-two15s-windows-preserving-five-master-shots');
  await capture('03-two-full-15-second-segments');

  await page.getByRole('tab', { name: '全片总提示词', exact: true }).click(); await exposeControls();
  phase = 'conversion-failure'; const beforeFailure = masterFacts(await readState());
  await page.locator('.sequence-master-review').getByRole('button', { name: '重新生成', exact: true }).click();
  await page.locator('.sequence-planning-error').waitFor({ timeout: 60_000 });
  assert.match(await page.locator('.sequence-planning-error').innerText(), /原有结果未覆盖/u);
  assert.deepEqual(masterFacts(await readState()), beforeFailure, 'failed45s conversion cannot overwrite prior30s master or segments');
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '30');
  assert.match(await page.locator('.sequence-estimate-copy strong').innerText(), /估时建议 30 秒/u);
  stages.push('new45s-AI-plan-conversion-failure-retains-old30s-plan-H3-segments-and-UI');
  await capture('04-conversion-failure-preserves-old-master');

  await page.getByRole('tab', { name: '全片总提示词', exact: true }).click();
  phase = 'late'; const beforeLate = masterFacts(await readState()); setHold('planning-review');
  await page.locator('.sequence-master-review').getByRole('button', { name: '重新生成', exact: true }).click(); await waitHeld();
  await exposeControls();
  await page.getByLabel('全片总秒数', { exact: true }).fill('60'); hold.release();
  await waitForCondition({ label: 'late review mock response fulfilled', timeoutMs: 20_000, intervalMs: 100, check: async () => hold.finished });
  // The outer planning lease is invalidated by the user edit. The existing
  // inner conversion may finish, but its result still must never commit.
  await waitForCondition({ label: 'late bilingual conversion finished without commit', timeoutMs: 40_000, intervalMs: 100,
    check: async () => requests.some((entry) => entry.phase === 'late' && entry.kind === 'english-review' && entry.completed) });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByRole('tab', { name: '全片总提示词', exact: true }).click();
  await page.locator('.sequence-master-review').getByRole('button', { name: '重新生成', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.sequence-master-review .sequence-master-textarea')?.disabled, undefined, { timeout: 40_000 });
  await exposeControls();
  assert.deepEqual(masterFacts(await readState()), beforeLate, 'stale45s result cannot replace saved30s master');
  assert.equal(await page.getByLabel('全片总秒数', { exact: true }).inputValue(), '60', 'late result cannot replace user new60s intent');
  stages.push('late45s-response-after-user60s-edit-preserves-user-intent-and-old30s-master');
  await capture('05-late-response-cannot-overwrite-user-duration');

  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []); assertNoMedia(await readState());
  const kinds = requests.filter((entry) => entry.phase === 'expand').map((entry) => entry.kind);
  assert.deepEqual(kinds, ['estimate', 'estimate-review', 'director', 'planning', 'planning-review', 'convert', 'staging-review', 'translate', 'english-review']);
  const report = { passed: true, isolatedBrowserStorage: true, productionDataRead: false, paidApiCalls: 0,
    stages, screenshots, requestCounts: Object.fromEntries([...new Set(requests.map((entry) => entry.phase))].map((name) => [name, requests.filter((entry) => entry.phase === name).map((entry) => entry.kind)])),
    errors, blockedRequests, requests, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, stages, requestCounts: report.requestCounts, report: path.join(output, 'report.json') }, null, 2));
} catch (cause) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); await fs.writeFile(path.join(output, 'failure.txt'), `${cause.stack}\n\n${await page.locator('body').innerText()}`); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stages, requests, errors, blockedRequests, output }, null, 2));
  throw cause;
} finally {
  hold?.release(); await context?.close(); await browser?.close(); await server.close();
}
