import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App + isolated synthetic localStorage + two intercepted text responses.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `seedance-action-retiming-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const key = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite';const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'Seedance existing regenerate UI', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let page; let context; let fixture;
const errors = []; const blockedRequests = []; const modelCalls = []; const checks = [];
const actions = ['甲颔首回礼并抬手起势。', '甲虚晃同时横移，乙跟随转身。', '甲连续三拳、左腿低扫两次；乙逐次格挡避让并右掌持续按左肩，至甲下沉后脱开。'];
const narrative = actions.join('');
const canonicalAt = (cuts) => actions.map((action, i) => `【${cuts[i]}s-${cuts[i + 1]}s】主体：@甲与乙，正在 [${action}]；空间：石台；光影：日光；镜头：侧面中景；台词：无；音效：脚步、衣料与格挡同期声。`).join('\n');
const originalCanonical = canonicalAt([0, 5, 10, 15]);
const canonical = canonicalAt([0, 1.5, 4, 15]);
const prose = (body) => ['视频规格：15秒；16:9；1080p；stereo。', '参考素材与职责：无外部参考素材。', '主体连续性：甲黑衣，乙白衣。',
  '一句话概述：甲乙试探后连续攻防。', `连续时间轴：\n${body.replaceAll('@', '')}`, '全局约束：保留已有同期声，间隙安静，无背景音乐。'].join('\n\n');
const chinese = prose(canonical);
const english = ['Video specification: 15 seconds; 16:9; 1080p; stereo.', 'References and responsibilities: No external reference media.',
  'Subject continuity: 甲 wears black; 乙 wears white.', 'One-sentence summary: 甲 and 乙 probe and continue sparring.',
  'Continuous timeline:\n0–1.5 seconds: 甲 nods and raises the hands.\n1.5–4 seconds: 甲 feints and moves sideways while 乙 turns.\n4–15 seconds: 甲 throws three punches and sweeps low twice with the left leg. 乙 blocks and evades each action and maintains right-palm pressure on the left shoulder until 甲 lowers and breaks free.',
  'Global constraints: Only the existing synchronous sounds, quiet gaps and no background music.'].join('\n\n');
const readBoard = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project.storyboards.find((board) => board.id === 'action-board'), key);
const expectPrompt = async (value) => {
  const region = page.getByRole('region', { name: '视频提示词正文', exact: true });
  await region.waitFor();
  await waitForCondition({ label: 'Seedance text displayed', timeoutMs: 10_000, intervalMs: 75, check: async () => await region.textContent() === value });
};
const run = async () => {
  await waitForCondition({ label: 'Vite', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/mock/v1/chat/completions' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      const user = payload.messages.findLast((message) => message.role === 'user')?.content || '';
      const review = user.match(/<seedance_source_data>\s*([\s\S]*?)\s*<\/seedance_source_data>/u);
      let content;
      if (review) {
        const data = JSON.parse(review[1]);
        modelCalls.push({ stage: 'chinese', taskAuthority: data.taskAuthority, revisionScope: data.revisionScope, executionContext: data.executionContext });
        assert.equal(modelCalls.length, 1);
        assert.equal(data.taskAuthority, 'current-segment-staging-replan');
        assert.equal(data.revisionScope, 'current-segment-action-retiming');
        assert.equal(data.canonicalPrompt, originalCanonical);
        assert.equal(data.specification.durationSec, 15);
        assert.ok(data.executionContext, 'the existing App request includes selected execution facts');
        assert.equal(data.executionContext.model, 'configured-seedance-2.0', 'the 2.5 authored label cannot replace the selected model');
        assert.equal(data.executionContext.modelSource, 'configured-model');
        assert.deepEqual(data.sourceEvidence.shots.map((shot) => shot.id), ['action-shot-1', 'action-shot-2', 'action-shot-3']);
        content = JSON.stringify({ canonicalPrompt: canonical, seedancePrompt: chinese, shotSourceIds: data.sourceEvidence.shots.map((shot) => [shot.id]), shotMetadata: [null, null, null] });
      } else {
        modelCalls.push({ stage: 'english' });
        assert.equal(modelCalls.length, 2, 'exactly the existing writer and translation');
        assert.equal(user, chinese);
        content = english;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'synthetic', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
      return;
    }
    if ((request.method() !== 'GET' && request.method() !== 'HEAD') || url.origin !== origin) {
      blockedRequests.push({ method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/__seedance_fixture.html') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>Synthetic Seedance fixture</body>' }); return; }
    await route.continue();
  });
  await page.goto(`${origin}/__seedance_fixture.html`);
  fixture = await page.evaluate(async ({ key, origin, narrative, actions, originalCanonical, previousZh }) => {
    const { createInitialState, normalizeState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { createStoryboardRevision } = await import('/src/storyboardVersions.ts');
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } = await import('/src/seedanceSource.ts');
    const { getOfficialSeedanceSourceFingerprint } = await import('/src/seedancePrompt.ts');
    const { emptyVideoDraft } = await import('/src/videoDirectorDraft.ts');
    const state = createInitialState(); const now = Date.now();
    const chapter = { id: 'action-chapter', name: '合成动作章', content: narrative, order: 0, archived: false, createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'seedance-ui-project', name: 'Seedance重生成隔离验证', activeChapterId: chapter.id, sourceDocuments: [chapter], chapterWorkspaces: {},
      scenes: [], storyboards: [], sequencePlans: [], characters: [], locations: [], props: [], assets: [], generationTasks: [], createdAt: now, updatedAt: now,
      directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now };
    project.characters = [['actor-a', '甲', '黑色练功服。'], ['actor-b', '乙', '白色练功服。']].map(([id, name, outfit]) => ({
      id, name, gender: '男', apparentAge: '成年', race: '人类', appearance: '原有外貌', outfit, signatureProps: '', personality: '', motionHabits: '', anchor: name, negativeContinuity: '', assetIds: [] }));
    const plan = materializeSemanticSequencePlan({ title: chapter.name, story: narrative, segmentDurationSec: 15,
      directorSettingsFingerprint: 'synthetic-director-settings', creativeDirection: { cameraTerms: ['侧面中景'], lightingTerms: ['日光'], extraRequirement: '' },
      characterContinuity: project.characters, sourceSceneIds: ['action-scene'], shotMode: 'exact', shotCount: 3,
    }, { segmentCount: 1, reason: '合成完整动作段', fitStatus: 'balanced', segments: [{ title: chapter.name, content: narrative, summary: narrative, narrativePurpose: '完整攻防',
      entryState: '甲乙相对', exitState: '甲脱开', transitionHint: '动作接续', boundaryReason: '完整动作', continuityPack: '保持甲乙与石台',
      semanticSource: { sourceEvidence: [{ text: narrative }], events: actions.map((description, index) => ({ id: `action-${index + 1}`, description })), dialogues: [] } }] }, { planId: 'action-plan', now });
    plan.chapterId = chapter.id; project.sequencePlans = [plan]; const segment = plan.segments[0];
    const board = { id: 'action-board', chapterId: chapter.id, sceneId: 'action-scene', sourceSceneIds: ['action-scene'], sourceStoryTitle: chapter.name,
      sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: 1, segmentCount: 1, sourceStoryContent: narrative, sourceContentHash: sourceContentHash(narrative),
      workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3',
      globalLock: '', globalReferenceAssetIds: [], extraRequirement: '', finalPrompt: originalCanonical,
      shots: actions.map((action, index) => ({ id: `action-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
        subject: '甲与乙', action, purpose: '完整攻防', camera: '侧面中景', lighting: '日光', sound: '脚步衣料与格挡声。', transition: '顺接', result: '',
        referenceAssetIds: [], prompt: originalCanonical.split('\n')[index], locked: false, authoredBy: 'text-api', sourceBeatIds: [`action-${index + 1}`], sourceExcerpt: action })),
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(originalCanonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
        modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [chapter.id], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    project.storyboards = [board]; segment.storyboardId = board.id; segment.status = 'ready'; plan.reviewConfirmedAt = now;
    project.scenes = [{ id: 'action-scene', chapterId: chapter.id, title: chapter.name, content: narrative, sourceDocumentId: chapter.id, sourceContentHash: sourceContentHash(narrative),
      summary: '', characterIds: ['actor-a', 'actor-b'], propIds: [], storyboardIds: [board.id], createdAt: now, updatedAt: now }];
    project.chapterWorkspaces[chapter.id] = { storyDraft: { name: chapter.name, content: narrative, updatedAt: now }, directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now,
      directorControls: { activeSceneId: 'action-scene', activeStoryboardId: board.id, productionMode: 'sequence', activePlanId: plan.id, activeSegmentId: segment.id,
        sequenceStage: 'direct', sequenceSettingsOpen: false, generationPromptFormat: 'seedance', durationMode: 'ai-estimated', totalDuration: 15,
        planningSegmentDurationPreset: '15s', planningCustomSegmentDuration: 15, segmentationMode: 'natural' },
      videoDirector: { draft: emptyVideoDraft(state.settings), parameterText: '{}', parameterDrafts: [], generationMode: 'single' } };
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api';
    for (const api of ['imageApi', 'visionApi', 'videoTaskApi']) state.settings[api].enabled = false;
    state.settings.videoTaskApi = { ...state.settings.videoTaskApi, provider: 'generic', model: 'configured-seedance-2.0' };
    state.settings.activeVideoApiProfileId = null; state.settings.videoApiProfiles = [];
    project.chapterWorkspaces[chapter.id].videoDirector.draft = emptyVideoDraft(state.settings);
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/mock/v1`, apiKey: 'synthetic-only', model: 'synthetic-text', vision: false };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.ui = { ...state.ui, activeView: 'director' };
    const normalized = normalizeState(state); const saved = normalized.project.storyboards[0]; const normalizedPlan = normalized.project.sequencePlans[0];
    normalizedPlan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(normalizedPlan);
    normalized.project.chapterWorkspaces[chapter.id].directorControls.confirmedSequencePlanFingerprint = normalizedPlan.reviewConfirmedFingerprint;
    saved.seedance25Output = { targetId: 'seedance-2.5', promptZh: previousZh, promptEn: 'Previous synthetic Seedance English.', durationSec: 15,
      sourceFingerprint: getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(normalized.project, saved)), referenceManifest: [], warnings: [], generatedAt: now };
    saved.seedance25Output.englishSourceFingerprint = saved.seedance25Output.sourceFingerprint;
    saved.revisions = [createStoryboardRevision(saved, [], { id: 'older-archive', reason: 'manual-save', label: '已有版本' })];
    normalized.projects = [normalized.project];
    if (!hasCurrentSeedancePrompt(normalized.project, saved, 'en')) throw new Error('Fixture requires a current saved Seedance pair');
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(normalized));
    return { zh: saved.seedance25Output.promptZh, en: saved.seedance25Output.promptEn, revision: JSON.parse(JSON.stringify(saved.revisions[0])) };
  }, { key, origin, narrative, actions, originalCanonical, previousZh: prose(originalCanonical) });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await expectPrompt(fixture.zh);
  assert.equal(await page.getByRole('button').filter({ hasText: /^重排动作节奏$/u }).count(), 0);
  if (await page.getByRole('button', { name: '更多', exact: true }).count()) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '重排动作节奏', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button').filter({ hasText: /重新生成本段Seedance.*提示词/u }).click();
  await page.waitForFunction(({ key, canonical }) => {
    const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards?.find((entry) => entry.id === 'action-board');
    return board?.finalPrompt === canonical && board?.seedance25Output?.promptEn?.includes('three punches') && !board.seedance25Output.englishError;
  }, { key, canonical });
  const updated = await readBoard();
  assert.equal(updated.durationSec, 15); assert.equal(updated.seedance25Output.promptZh, chinese); assert.equal(updated.seedance25Output.promptEn, english);
  assert.deepEqual(updated.shots.map(({ id, startSec, endSec }) => [id, startSec, endSec]), [['action-shot-1', 0, 1.5], ['action-shot-2', 1.5, 4], ['action-shot-3', 4, 15]]);
  actions.forEach((action) => { assert.ok(updated.finalPrompt.includes(action)); assert.ok(updated.seedance25Output.promptZh.includes(action)); });
  assert.equal(updated.revisions.length, 2); assert.deepEqual(updated.revisions[0], fixture.revision);
  assert.equal(updated.revisions[1].finalPrompt, originalCanonical); assert.equal(updated.revisions[1].seedance25Output.promptZh, fixture.zh); assert.equal(updated.revisions[1].seedance25Output.promptEn, fixture.en);
  checks.push('existing segment regenerate button sends action-retiming; no extra rhythm button; fixed 15 seconds, all actions and source IDs survive nonuniform 0/1.5/4/15 cuts');
  checks.push('old revision and pre-regeneration bilingual source preserved; new canonical and Seedance Chinese/English saved together');
  await expectPrompt(chinese); await page.screenshot({ path: path.join(output, 'regenerated.png'), animations: 'disabled' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await expectPrompt(chinese);
  const reloaded = await readBoard();
  for (const field of ['finalPrompt', 'shots', 'revisions']) assert.deepEqual(reloaded[field], updated[field]);
  // Storage normalizes an empty error string to absence; delivery content and
  // source identity must persist, without making that normalization a bug.
  assert.deepEqual({ ...reloaded.seedance25Output, englishError: reloaded.seedance25Output.englishError || '' },
    { ...updated.seedance25Output, englishError: updated.seedance25Output.englishError || '' });
  assert.deepEqual(modelCalls.map((call) => call.stage), ['chinese', 'english']); assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  checks.push('saved source, bilingual delivery, nonuniform timing and revisions survive real App reload with exactly two mocked calls');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, checks, modelCalls, blockedRequests, errors }, null, 2));
  console.log(`Seedance UI QA passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, modelCalls, errors, blockedRequests, checks,
    visibleButtons: await page?.getByRole('button').allTextContents().catch(() => []) }, null, 2)); throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
