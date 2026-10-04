import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App in an ephemeral browser, entirely synthetic storage. All POSTs and
// non-loopback traffic are blocked; no desktop profile or paid task is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `semantic-video-prompt-context-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain below output/playwright');
for (let directory = output; directory !== root; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('QA output cannot traverse directory links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const fixturePath = '/__semantic_video_prompt_context_fixture.html';
const storageKey = 'lianhua_video_director_state_v22';
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'semantic video prompt context UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const errors = []; const blockedRequests = []; const steps = []; const screenshots = [];
const capture = async (name) => {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false, animations: 'disabled' });
  screenshots.push(`${name}.png`);
};
const openBatch = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.locator('.vd-batch-row').first().waitFor();
};
const assertBatch = async (fixtures) => {
  assert.equal(await page.locator('.vd-batch-row').count(), fixtures.length);
  for (const fixture of fixtures) {
    const row = page.locator(`.vd-batch-row[data-segment-id="${fixture.segmentId}"]`);
    for (const [language, label] of [['zh', '中文'], ['en', '英文']]) {
      const button = row.getByRole('button', { name: label, exact: true });
      assert.equal(await button.isEnabled(), true, `${fixture.index}/${language} remains selectable`);
      await button.click();
      await row.getByRole('button', { name: '预览', exact: true }).click();
      assert.equal(await page.locator('.vd-batch-preview .vd-prompt-preview').textContent(), fixture[language], `${fixture.index}/${language} preview preserves exact source`);
      assert.equal(await row.getByRole('checkbox').isEnabled(), true);
    }
  }
  assert.equal(await page.getByText('当前语言尚无可用提示词', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '全选英文', exact: true }).click();
  assert.equal(await page.locator('.vd-batch-row input[type="checkbox"]:checked').count(), fixtures.length);
  assert.equal(await page.getByRole('button', { name: `检查并生成 ${fixtures.length} 段视频`, exact: true }).isEnabled(), true);
};

const run = async () => {
  await waitForCondition({ label: 'semantic prompt context Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== 'GET' && request.method() !== 'HEAD' || url.origin !== origin) {
      blockedRequests.push({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic semantic video fixture</body></html>' }); return;
    }
    await route.continue();
  });
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  const fixtures = await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const { materializeSemanticSequencePlan } = await import('/src/semanticSequencePlan.ts');
    const { sequencePlanReviewFingerprint } = await import('/src/sequencePlan.ts');
    const { applyOfficialH3Prompt, hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
    const { officialH3ContextForStoryboard } = await import('/src/officialH3Context.ts');
    const { createRunningHubTutorialVideoWorkflow, defaultRunningHubVideoConfig } = await import('/src/runningHubVideo.ts');
    const state = createInitialState(); const now = Date.now();
    const frozen = { id: 'semantic-frozen-character', name: '林舟', gender: '男', apparentAge: '30岁成年', race: '人类',
      appearance: '原计划黑发', outfit: '原计划蓝袍', signatureProps: '铜铃', personality: '沉稳', motionHabits: '步态平稳', anchor: '固定身份', negativeContinuity: '', assetIds: [] };
    const live = { ...frozen, appearance: '后续人物资料白发', outfit: '后续人物资料红袍', anchor: '后续更新的身份资料' };
    const parts = ['林舟在石桥左侧提起铜铃。', '林舟提着铜铃走向石阶。', '林舟沿石阶离开石桥。'];
    const story = parts.join('\n');
    const plan = materializeSemanticSequencePlan({ title: '冻结人物与实时人物不同', story, segmentDurationSec: 15,
      directorSettingsFingerprint: 'synthetic-frozen-director-settings', creativeDirection: { cameraTerms: ['稳定中景'], lightingTerms: ['自然晨光'], extraRequirement: '' },
      characterContinuity: [frozen], sourceSceneIds: ['semantic-context-scene'], shotMode: 'auto',
    }, { segmentCount: 3, reason: '合成三个连续完整窗口', fitStatus: 'balanced', segments: parts.map((content, index) => ({
      title: `隔离第${index + 1}段`, content, summary: content, narrativePurpose: '推进动作', entryState: index ? parts[index - 1] : '站在石桥',
      exitState: content, transitionHint: '动作接续', boundaryReason: '完整动作', continuityPack: '保持蓝袍与铜铃',
      semanticSource: { sourceEvidence: [{ text: content }], events: [{ id: `event-${index + 1}`, description: content }], dialogues: [] },
    })) }, { planId: 'semantic-context-plan', now });
    const scene = { id: 'semantic-context-scene', title: '无关实时场景', content: '这是后来更新的场景内容，不属于已冻结分段。', summary: '', characterIds: [frozen.id], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'semantic-context-project', name: '语义提示词来源一致性验证', characters: [live], locations: [], props: [],
      sourceDocuments: [{ id: 'semantic-context-source', name: '原始剧情', content: story, createdAt: now, updatedAt: now }],
      scenes: [scene], storyboards: [], sequencePlans: [plan], assets: [], generationTasks: [], createdAt: now, updatedAt: now,
      directorSettingsConfirmedFingerprint: plan.semanticPlanningSnapshot.directorSettingsFingerprint, directorSettingsConfirmedAt: now };
    for (const segment of plan.segments) {
      const canonical = `【0s-15s】主体：林舟；空间：石桥左侧与石阶；光影：清晨柔和侧光；镜头：稳定中景；动作：${segment.content} QA_SEGMENT_${segment.index}；台词：无；音效：无配乐，无对白。`;
      const source = { id: `semantic-context-board-${segment.index}`, sceneId: scene.id, sourceSceneIds: [scene.id], sourceStoryTitle: segment.title,
        sourceStoryContent: segment.content, sourceContentHash: sourceContentHash(segment.content), sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 3,
        workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
        stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3',
        globalLock: '', globalReferenceAssetIds: [], extraRequirement: '', finalPrompt: canonical,
        shots: [{ id: `semantic-context-shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, subject: '林舟', action: segment.content,
          purpose: '推进动作', camera: '稳定中景', lighting: '晨光', sound: '', transition: '顺接', result: segment.content,
          referenceAssetIds: [], prompt: canonical, locked: false, authoredBy: 'text-api' }],
        promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(canonical), shotPlanMode: 'ai-complete', shotRecommendationMode: 'text-api',
          modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now }, createdAt: now, updatedAt: now };
      const context = officialH3ContextForStoryboard(project, source);
      const board = applyOfficialH3Prompt(source, context);
      board.officialPromptEn = board.officialPromptZh.replace(/[\p{Script=Han}]+/gu, ' English scene description ');
      board.officialPromptEnSource = board.officialPromptZh; board.englishPrompt = board.officialPromptEn; board.englishPromptSource = board.finalPrompt;
      if (!hasCurrentOfficialH3Prompt(board, context) || !hasCurrentOfficialH3EnglishPrompt(board, context)) throw new Error('Synthetic bilingual H3 fixture must be current');
      const oldContext = { assets: [], characters: [live], locations: [], props: [], sceneContent: scene.content };
      if (hasCurrentOfficialH3Prompt(board, oldContext)) throw new Error('Fixture must reproduce old live-context fingerprint rejection');
      segment.storyboardId = board.id; segment.status = 'ready'; project.storyboards.push(board);
    }
    plan.reviewConfirmedAt = now; plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
    scene.storyboardIds = project.storyboards.map((board) => board.id);
    const workflow = createRunningHubTutorialVideoWorkflow(); workflow.id = 'semantic-context-workflow'; workflow.name = '隔离 RunningHub 工作流';
    state.settings.runningHubVideo = { ...defaultRunningHubVideoConfig, enabled: true, apiKey: '', baseUrl: origin, workflows: [workflow], activeWorkflowId: workflow.id };
    state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api';
    for (const api of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi']) state.settings[api].enabled = false;
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.project = project; state.projects = [project]; state.activeProjectId = project.id; state.ui = { ...state.ui, activeView: 'director' };
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
    return project.storyboards.map((board) => ({ id: board.id, segmentId: board.segmentId, index: board.segmentIndex, zh: board.officialPromptZh, en: board.officialPromptEn }));
  }, { key: storageKey, origin });
  steps.push('three bilingual official artifacts are current with frozen semantic facts and provably rejected by the former live context');
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-result-copy').waitFor();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: 'H3提示词原文', exact: true }).textContent(), fixtures[0].en);
  await capture('director-original-english');
  await page.getByRole('button', { name: '送到视频导演台', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '本次生成使用的完整提示词', exact: true });
  await editor.waitFor(); assert.equal(await editor.inputValue(), fixtures[0].en);
  await capture('single-video-original-english');
  steps.push('director English display sends exact existing artifact to the single-video draft');
  await page.getByRole('button', { name: '从提示词导演台选择', exact: true }).click();
  assert.equal(await page.locator('.vd-choice').count(), fixtures.length * 2);
  await page.getByRole('combobox', { name: '描述语言', exact: true }).selectOption('zh');
  assert.equal(await page.locator('.vd-choice').count(), fixtures.length);
  await page.locator('.vd-choice').filter({ hasText: '长剧情 · 第 2 段' }).click();
  assert.equal(await page.locator('.vd-choice-preview .vd-prompt-preview').textContent(), fixtures[1].zh);
  await page.getByRole('button', { name: '使用这段提示词', exact: true }).click();
  assert.equal(await editor.inputValue(), fixtures[1].zh);
  steps.push('single-video picker exposes all six choices and preserves Chinese source bytes');
  await openBatch(); await assertBatch(fixtures); await capture('batch-three-bilingual-prompts');
  steps.push('all three batch rows enable both languages, selection, and exact previews');
  await page.reload({ waitUntil: 'networkidle' });
  await openBatch(); await assertBatch(fixtures); await capture('batch-after-reload');
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(stored.project.generationTasks.length, 0);
  for (const fixture of fixtures) {
    const board = stored.project.storyboards.find((candidate) => candidate.id === fixture.id);
    assert.equal(board.officialPromptZh, fixture.zh); assert.equal(board.officialPromptEn, fixture.en);
  }
  assert.deepEqual(blockedRequests, [], 'UI navigation must not attempt model or video requests');
  assert.deepEqual(errors, []);
  steps.push('reload retains all bilingual choices and exact saved artifacts; no generation tasks or network submissions were made');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, segments: fixtures.length, languages: ['zh', 'en'], steps, screenshots, blockedRequests, errors }, null, 2));
  console.log(`Semantic video prompt context UI QA passed. Report: ${path.join(output, 'report.json')}`);
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ steps, screenshots, blockedRequests, errors, error: String(error), stack: error?.stack }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
