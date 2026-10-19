import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Existing "regenerate this segment" workflow in the real App. The browser owns a new, synthetic
// localStorage; two model responses are fulfilled in-process, with no real API.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `action-retiming-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__action_retiming_fixture.html';
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'action retiming UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let fixture;
const errors = []; const blockedRequests = []; const checks = []; const modelCalls = [];
const actions = [
  '甲左拳连续三次击向乙胸前，乙边后撤边抬右臂格挡。',
  '甲贴身左腿低扫两次，乙抬左脚避过并顺势侧移。',
  '乙右掌按住甲左肩持续下压，甲下沉转身脱开，双方站稳。',
];
const narrative = actions.join('');
const summary = '只有拳臂接触、扫腿带动衣料和脚步的同期声，均随动作发生与结束，间隙安静。';
const canonical = `【0s-15s】主体：甲与乙；空间：石台；光影：日光；镜头：稳定中景；动作：0.4—3.0秒${actions[0]}3.0—5.0秒${actions[1]}5.0—8.0秒${actions[2]}连续攻防以常速完成，接触、回应和脱开保持因果；台词：无；音效：拳臂接触、衣料摩擦和脚步。`;
const performance = {
  version: 1, timeBase: 'clip', descriptionLanguage: 'zh',
  characters: [{ characterId: 'actor-a', visualDescription: '黑色练功服。' }, { characterId: 'actor-b', visualDescription: '白色练功服。' }],
  shots: [{ shotIndex: 1, startSec: 0, visualDescription: '甲与乙在石台上相对，稳定中景，日光。', events: [
    { kind: 'visual', eventId: 'punches', sourceFact: actions[0], description: actions[0], startSec: 0.4, endSec: 3, silentCharacterIds: ['actor-a', 'actor-b'], soundDescription: '拳臂接触与后撤脚步声。' },
    { kind: 'visual', eventId: 'sweeps', sourceFact: actions[1], description: actions[1], startSec: 3, endSec: 5, silentCharacterIds: ['actor-a', 'actor-b'], soundDescription: '衣料摩擦与侧移脚步声。' },
    { kind: 'visual', eventId: 'release', sourceFact: actions[2], description: actions[2], startSec: 5, endSec: 8, silentCharacterIds: ['actor-a', 'actor-b'], soundDescription: '按肩衣料声与站稳脚步声。' },
  ] }], overallSoundscape: summary, nonDiegeticMusic: 'N/A',
};
const englishFields = {
  'performance.characters.0.visualDescription': 'Black training clothes.',
  'performance.characters.1.visualDescription': 'White training clothes.',
  'performance.shots.0.visualDescription': '甲 and 乙 face each other on a stone platform, in a steady medium shot under daylight.',
  'performance.shots.0.events.0.description': '甲 punches toward the chest of 乙 three times with the left fist; 乙 steps backward while raising the right forearm to block.',
  'performance.shots.0.events.0.soundDescription': 'Fist-to-forearm contact and retreating footsteps.',
  'performance.shots.0.events.1.description': '甲 closes in and sweeps low twice with the left leg; 乙 lifts the left foot to evade and steps sideways in the same movement.',
  'performance.shots.0.events.1.soundDescription': 'Clothing friction and sidestepping footsteps.',
  'performance.shots.0.events.2.description': '乙 presses continuously downward on the left shoulder of 甲 with the right palm; 甲 sinks and turns free, and both regain their footing.',
  'performance.shots.0.events.2.soundDescription': 'Clothing friction at the shoulder and feet settling onto the ground.',
  'performance.overallSoundscape': 'Only synchronous fist-to-forearm contact, clothing friction and footsteps occur with the actions; the gaps remain quiet.',
};
const readStored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const readBoard = async () => (await readStored()).project.storyboards.find((item) => item.id === 'action-board');
const expectPrompt = async (expected) => {
  const region = page.getByRole('region', { name: 'H3提示词原文', exact: true });
  await region.waitFor();
  await waitForCondition({ label: 'saved H3 displayed', timeoutMs: 10_000, intervalMs: 75, check: async () => await region.textContent() === expected });
};

const run = async () => {
  await waitForCondition({ label: 'action retiming Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
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
      let content;
      const review = user.match(/<video_staging_review_data>\s*([\s\S]*?)\s*<\/video_staging_review_data>/u);
      if (review) {
        const data = JSON.parse(review[1]);
        modelCalls.push({ stage: 'chinese-delivery', taskAuthority: data.taskAuthority, revisionScope: data.revisionScope });
        assert.equal(modelCalls.length, 1, 'retiming must begin with the existing Chinese delivery call');
        assert.equal(data.taskAuthority, 'current-segment-staging-replan');
        assert.equal(data.revisionScope, 'current-segment-action-retiming');
        assert.equal(data.canonicalPrompt, fixture.canonical);
        assert.ok(user.includes(narrative));
        content = JSON.stringify({ canonicalPrompt: canonical,
          h3Prompt: `integrated_multimodal_description: [Shot 1] 甲与乙在石台上相对。${narrative}\n\noverall_soundscape: ${summary}\n\nnon_diegetic_music: N/A`,
          shotSourceIds: data.shots.map((shot) => [shot.id]),
          identityBindings: { version: 1, characters: [
            { characterId: 'actor-a', name: '甲', referenceAnchor: 'Identity: 甲, 黑色练功服。' },
            { characterId: 'actor-b', name: '乙', referenceAnchor: 'Identity: 乙, 白色练功服。' },
          ], performance },
          characterParticipation: { version: 1, characters: ['actor-a', 'actor-b'].map((characterId, index) => ({
            characterId, name: index ? '乙' : '甲', presence: 'visible', shotIndex: 1, evidence: narrative, speaking: false,
          })) },
        });
      } else {
        const data = JSON.parse(user);
        modelCalls.push({ stage: 'english-translation', slotCount: data.slots?.length });
        assert.equal(modelCalls.length, 2, 'only the existing English translation follows Chinese delivery');
        assert.ok(Array.isArray(data.slots));
        content = JSON.stringify({ slots: data.slots.map((slot) => {
          assert.ok(englishFields[slot.id], `Unknown synthetic translation field: ${slot.id}`);
          return { id: slot.id, text: englishFields[slot.id] };
        }) });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'synthetic-response', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) });
      return;
    }
    if ((request.method() !== 'GET' && request.method() !== 'HEAD') || url.origin !== origin) {
      blockedRequests.push({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic action retiming fixture</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  fixture = await page.evaluate(async ({ key, origin, narrative }) => {
    const { createInitialState, normalizeState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { officialH3ContextForStoryboard } = await import('/src/officialH3Context.ts');
    const { emptyVideoDraft } = await import('/src/videoDirectorDraft.ts');
    const { createStoryboardRevision } = await import('/src/storyboardVersions.ts');
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const state = createInitialState(); const now = Date.now();
    const chapter = { id: 'action-chapter', name: '合成动作章', content: narrative, order: 0, archived: false, createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'action-retiming-project', name: '动作重排隔离验证', activeChapterId: chapter.id,
      sourceDocuments: [chapter], chapterWorkspaces: {}, scenes: [], storyboards: [], sequencePlans: [], characters: [], locations: [], props: [], assets: [], generationTasks: [],
      createdAt: now, updatedAt: now, directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now };
    project.characters = [['actor-a', '甲', '黑色练功服。'], ['actor-b', '乙', '白色练功服。']].map(([id, name, outfit]) => ({
      id, name, gender: '男', apparentAge: '成年', race: '人类', appearance: '原有外貌', outfit, signatureProps: '', personality: '', motionHabits: '', anchor: name, negativeContinuity: '', assetIds: [],
    }));
    const plan = materializeSemanticSequencePlan({ title: chapter.name, story: narrative, segmentDurationSec: 15,
      directorSettingsFingerprint: 'synthetic-director-settings', creativeDirection: { cameraTerms: ['稳定中景'], lightingTerms: ['日光'], extraRequirement: '' },
      characterContinuity: project.characters, sourceSceneIds: ['action-scene'], shotMode: 'auto',
    }, { segmentCount: 1, reason: '合成完整动作段', fitStatus: 'balanced', segments: [{
      title: chapter.name, content: narrative, summary: narrative, narrativePurpose: '完成原有攻防', entryState: '甲乙相对', exitState: '双方站稳',
      transitionHint: '动作接续', boundaryReason: '完整动作', continuityPack: '保持甲乙与石台',
      semanticSource: { sourceEvidence: [{ text: narrative }], events: [{ id: 'source-actions', description: narrative }], dialogues: [] },
    }] }, { planId: 'action-plan', now });
    plan.chapterId = chapter.id; project.sequencePlans = [plan];
    const segment = plan.segments[0];
    const canonical = `【0s-15s】主体：甲与乙；空间：石台；光影：日光；镜头：稳定中景；动作：${narrative}每次动作后重新摆好姿势；台词：无；音效：拳臂接触、衣料摩擦和脚步。`;
    const source = { id: 'action-board', chapterId: chapter.id, sceneId: 'action-scene', sourceSceneIds: ['action-scene'], sourceStoryTitle: chapter.name,
      sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: 1, segmentCount: 1,
      sourceStoryContent: narrative, sourceContentHash: sourceContentHash(narrative), workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3', globalLock: '', globalReferenceAssetIds: [], extraRequirement: '', finalPrompt: canonical,
      shots: [{ id: 'action-shot', index: 1, startSec: 0, endSec: 15, subject: '甲与乙', action: narrative, purpose: '完成原有攻防', camera: '稳定中景', lighting: '日光', sound: '拳臂接触、衣料摩擦和脚步。', transition: '顺接', result: '双方站稳。', referenceAssetIds: [], prompt: canonical, locked: false, authoredBy: 'text-api' }],
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api', modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [chapter.id], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
    const context = officialH3ContextForStoryboard(project, source);
    const board = applyOfficialH3Prompt(source, context);
    board.officialPromptEn = board.officialPromptZh.replace(/[\p{Script=Han}]+/gu, ' Synthetic previous English description ');
    board.officialPromptEnSource = board.officialPromptZh;
    board.englishPrompt = 'Synthetic previous ordinary English draft.'; board.englishPromptSource = canonical;
    board.revisions = [createStoryboardRevision(board, [], { id: 'older-archive', reason: 'manual-save', label: '已有版本' })];
    if (!hasCurrentOfficialH3Prompt(board, context) || !hasCurrentOfficialH3EnglishPrompt(board, context)) throw new Error('Fixture must have current bilingual H3');
    project.storyboards = [board];
    segment.storyboardId = board.id; segment.status = 'ready';
    plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    project.scenes = [{ id: 'action-scene', chapterId: chapter.id, title: chapter.name, content: narrative, sourceDocumentId: chapter.id, sourceContentHash: sourceContentHash(narrative), summary: '', characterIds: ['actor-a', 'actor-b'], propIds: [], storyboardIds: [board.id], createdAt: now, updatedAt: now }];
    project.chapterWorkspaces[chapter.id] = {
      storyDraft: { name: chapter.name, content: narrative, updatedAt: now }, directorSettingsConfirmedFingerprint: 'synthetic-director-settings', directorSettingsConfirmedAt: now,
      directorControls: { activeSceneId: 'action-scene', activeStoryboardId: board.id, productionMode: 'sequence', activePlanId: plan.id, activeSegmentId: segment.id,
        sequenceStage: 'direct', sequenceSettingsOpen: false, generationPromptFormat: 'h3', durationMode: 'ai-estimated', totalDuration: 15,
        planningSegmentDurationPreset: '15s', planningCustomSegmentDuration: 15, segmentationMode: 'natural', confirmedSequencePlanFingerprint: plan.reviewConfirmedFingerprint },
      videoDirector: { draft: emptyVideoDraft(state.settings), parameterText: '{}', parameterDrafts: [], generationMode: 'single' },
    };
    state.settings.videoSource = 'api'; state.settings.videoBackend = 'api';
    for (const api of ['imageApi', 'visionApi', 'videoTaskApi']) state.settings[api].enabled = false;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/mock/v1`, apiKey: 'synthetic-only', model: 'synthetic-text', vision: false };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.ui = { ...state.ui, activeView: 'director' };
    // Fingerprint the complete, normalized project, including its scene. A
    // fixture compiled before adding sceneContent would be stale at startup.
    const normalized = normalizeState(state);
    const normalizedPlan = normalized.project.sequencePlans[0];
    normalizedPlan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(normalizedPlan);
    normalized.project.chapterWorkspaces[chapter.id].directorControls.confirmedSequencePlanFingerprint = normalizedPlan.reviewConfirmedFingerprint;
    const normalizedSource = normalized.project.storyboards[0];
    const normalizedContext = officialH3ContextForStoryboard(normalized.project, normalizedSource);
    const saved = applyOfficialH3Prompt(normalizedSource, normalizedContext);
    saved.officialPromptEn = saved.officialPromptZh.replace(/[\p{Script=Han}]+/gu, ' Synthetic previous English description ');
    saved.officialPromptEnSource = saved.officialPromptZh;
    saved.revisions = [createStoryboardRevision(saved, [], { id: 'older-archive', reason: 'manual-save', label: '已有版本' })];
    normalized.project.storyboards = [saved]; normalized.projects = [normalized.project];
    if (!hasCurrentOfficialH3Prompt(saved, normalizedContext) || !hasCurrentOfficialH3EnglishPrompt(saved, normalizedContext)) throw new Error('Normalized fixture must have current bilingual H3');
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(normalized));
    return { canonical, zh: saved.officialPromptZh, en: saved.officialPromptEn, revision: JSON.parse(JSON.stringify(saved.revisions[0])) };
  }, { key: storageKey, origin, narrative });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await expectPrompt(fixture.zh);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '重排动作节奏', exact: true }).count(), 0, 'no extra retiming menu entry');
  await page.keyboard.press('Escape');
  // App Button uses its tooltip as aria-label, so select the existing visible
  // label without depending on wording of the longer tooltip.
  await page.getByRole('button').filter({ hasText: /重新生成本段.*提示词/u }).click();
  await page.waitForFunction(({ key, canonical }) => {
    const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards?.find((item) => item.id === 'action-board');
    return board?.finalPrompt === canonical && board?.officialPromptEn?.includes('three times') && !board.officialPromptEnError;
  }, { key: storageKey, canonical });
  const updated = await readBoard();
  assert.equal(updated.finalPrompt, canonical);
  assert.equal(updated.durationSec, 15);
  assert.deepEqual(updated.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 15]]);
  for (const action of actions) {
    assert.ok(updated.finalPrompt.includes(action)); assert.ok(updated.officialPromptZh.includes(action));
  }
  assert.equal((updated.officialPromptZh.match(/连续三次/gu) || []).length, 1);
  assert.equal((updated.officialPromptZh.match(/低扫两次/gu) || []).length, 1);
  assert.ok(updated.officialPromptEn.includes('three times')); assert.ok(updated.officialPromptEn.includes('twice'));
  assert.ok(updated.officialPromptZh.split('overall_soundscape:')[1]?.trimStart().startsWith(summary));
  for (const body of [updated.officialPromptZh, updated.officialPromptEn]) {
    assert.equal((body.match(/^overall_soundscape:/gmu) || []).length, 1);
    assert.equal((body.match(/^non_diegetic_music:\s*N\/A$/gmu) || []).length, 1);
  }
  assert.equal(updated.revisions.length, 2);
  assert.deepEqual(updated.revisions[0], fixture.revision);
  assert.equal(updated.revisions[1].reason, 'pre-action-retiming');
  assert.equal(updated.revisions[1].finalPrompt, fixture.canonical);
  assert.equal(updated.revisions[1].officialPromptZh, fixture.zh);
  assert.equal(updated.revisions[1].officialPromptEn, fixture.en);
  assert.deepEqual(updated.h3IdentityBindings.performance.shots[0].events.map(({ eventId, startSec, endSec }) => [eventId, startSec, endSec]), [['punches', 0.4, 3], ['sweeps', 3, 5], ['release', 5, 8]]);
  assert.deepEqual(updated.h3IdentityBindingsEn.performance.shots, updated.h3IdentityBindings.performance.shots.map((shot, shotIndex) => ({
    ...shot, visualDescription: englishFields[`performance.shots.${shotIndex}.visualDescription`], events: shot.events.map((event, index) => ({ ...event,
      description: englishFields[`performance.shots.${shotIndex}.events.${index}.description`], soundDescription: englishFields[`performance.shots.${shotIndex}.events.${index}.soundDescription`],
    })),
  })));
  checks.push('existing regenerate-this-segment button applies retiming, with no extra menu entry; existing revisions and old drafts, all action counts and 15-second boundaries are retained');
  await expectPrompt(updated.officialPromptZh);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await expectPrompt(updated.officialPromptZh);
  const reloaded = await readBoard();
  for (const key of ['finalPrompt', 'officialPromptZh', 'officialPromptEn', 'revisions', 'h3IdentityBindings', 'h3IdentityBindingsEn']) assert.deepEqual(reloaded[key], updated[key], `saved ${key} survives reload`);
  checks.push('Chinese/English performance fields, times, official audio footer and history persist through App reload');
  await page.getByRole('button', { name: '送到视频导演台', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '本次生成使用的完整提示词', exact: true });
  await editor.waitFor();
  await waitForCondition({ label: 'video draft uses new H3', timeoutMs: 10_000, intervalMs: 75, check: async () => await editor.inputValue() === updated.officialPromptZh });
  await page.waitForFunction(({ key, expected }) => JSON.parse(localStorage.getItem(key) || '{}').project?.chapterWorkspaces?.['action-chapter']?.videoDirector?.draft?.prompt === expected, { key: storageKey, expected: updated.officialPromptZh });
  assert.equal((await readStored()).project.generationTasks.length, 0);
  assert.deepEqual(modelCalls.map((call) => call.stage), ['chinese-delivery', 'english-translation']);
  assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  checks.push('Send to Video copies the new H3 with both audio sections; exactly two mocked existing calls, no extra model/video request');
  await page.screenshot({ path: path.join(output, 'video-draft.png'), fullPage: false, animations: 'disabled' });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, modelCalls, blockedRequests, errors }, null, 2));
  console.log(`Action retiming UI QA passed. Report: ${path.join(output, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const visibleButtons = page ? await page.getByRole('button').allTextContents().catch(() => []) : [];
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, modelCalls, blockedRequests, errors, visibleButtons, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
