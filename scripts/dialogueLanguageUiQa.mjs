import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One isolated browser flow, using synthetic data and one mocked translator.
// This never opens Electron storage or contacts a real text/video API.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const outputDirectory = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'dialogue-language-0.5.78'));
const relativeOutput = path.relative(outputBase, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error('Dialogue language QA output must be a child of output/playwright');
}
for (let current = outputDirectory; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse a directory link');
}
fs.mkdirSync(outputDirectory, { recursive: true });

const storageKey = 'lianhua_video_director_state_v22';
const boardId = 'qa-dialogue-language-board';
const spokenLine = '前进！';
const speaker = '边缘划水';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'focused dialogue language UI QA', runTimeoutMs: 120_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const requests = [];
const errors = [];

const readProject = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, storageKey);
const readCurrentness = () => page.evaluate(async ({ key, id }) => {
  const { hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } = await import('/src/officialPrompt.ts');
  const project = JSON.parse(localStorage.getItem(key)).project;
  const board = project.storyboards.find((item) => item.id === id);
  const compileContext = { assets: project.assets, characters: project.characters, locations: project.locations,
    props: project.props, sceneContent: project.scenes.find((scene) => scene.id === board.sceneId)?.content };
  return { chinese: hasCurrentOfficialH3Prompt(board, compileContext), english: hasCurrentOfficialH3EnglishPrompt(board, compileContext) };
}, { key: storageKey, id: boardId });

const run = async () => {
  await waitForCondition({ label: 'focused dialogue language Vite startup', timeoutMs: 40_000, intervalMs: 100,
    check: async () => {
      try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseUrl).origin });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__dialogue_language_focused_qa__')) {
      localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__dialogue_language_focused_qa__', '1');
    }
  });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
    errors.push('Unexpected non-local request'); await route.abort('blockedbyclient');
  });
  await page.route('**/qa-dialogue-language/v1/chat/completions', async (route) => {
    try {
      const payload = route.request().postDataJSON();
      const textFor = (role) => payload.messages.filter((message) => message.role === role).map((message) => message.content).join('\n');
      const system = textFor('system');
      const user = textFor('user');
      assert.equal(requests.length, 0, 'English-only refresh must call the translator exactly once');
      assert.match(user, /__LH_DIALOGUE_\d+__/u, 'spoken dialogue must be protected before crossing the API boundary');
      assert.match(user, /__LH_ENTITY_\d+__/u, 'speaker identity must be protected');
      assert.match(user, /__LH_H3_(?:TAG|SECTION)_\d+__/u, 'official structure must be protected');
      assert.doesNotMatch(user, /前进|Advance/u, 'translator must never receive an exposed spoken line');
      assert.match(system, /对白|dialogue/iu);
      const tokens = user.match(/__LH_[A-Z_]+_\d+__/gu) || [];
      requests.push({ stage: 'translate', dialogueTokens: tokens.filter((token) => token.startsWith('__LH_DIALOGUE_')).length,
        protectedTokens: tokens.length });
      const translated = user.replace(/[\p{Script=Han}]+/gu, ' translated description ');
      assert.deepEqual(translated.match(/__LH_[A-Z_]+_\d+__/gu) || [], tokens);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: translated } }] }) });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      await route.fulfill({ status: 500, body: 'Focused dialogue language mock rejected its input' });
    }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(async ({ key, apiBase, id, line, name }) => {
    const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const state = JSON.parse(localStorage.getItem(key));
    const content = `${name}握紧车架，将对讲机举到嘴边，用中文说：“${line}”`;
    const scene = { id: 'qa-dialogue-language-scene', title: '对白语言定向验证', content, summary: content,
      characterIds: ['qa-dialogue-speaker'], propIds: [], storyboardIds: [id], createdAt: 1, updatedAt: 1 };
    const hero = { id: 'qa-dialogue-speaker', name, gender: '男', apparentAge: '成年', race: '人类',
      appearance: '黑发', outfit: '外套', signatureProps: '对讲机', anchor: '车架旁', personality: '',
      motionHabits: '', negativeContinuity: '', assetIds: [] };
    const sound = `环境层-[无] 动作层-[第1.3s起${name}原对白："${line}"] 情绪层-[无配乐]`;
    const canonical = `【0s-5s】 主体：@${name}（男）[朝向：前方] 正在 [握紧车架后将对讲机举到嘴边]（发出指令）；空间：前景-车架 中景-${name} 背景-车队；光影：自然光；镜头：近景平视；台词：无；音效：${sound}`;
    const shot = { id: 'qa-dialogue-language-shot', index: 1, startSec: 0, endSec: 5, subject: name,
      action: '握紧车架后将对讲机举到嘴边', purpose: '发出指令', camera: '近景平视', lighting: '自然光', sound,
      result: '指令已发出', transition: '硬切', referenceAssetIds: [], locked: true,
      sourceStart: 0, sourceEnd: content.length, prompt: canonical };
    const board = { id, sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: content,
      workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
      pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.stylePresets[0].id, ruleSetId: state.ruleSets[0].id,
      converterPresetId: state.converterPresets[0].id, globalLock: '对白用中文', globalReferenceAssetIds: [],
      shots: [shot], finalPrompt: canonical, createdAt: 1, updatedAt: 1,
      targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: '',
        parameters: { seed: 1234567, steps: 15, cfg: 1, custom: { audioSteps: 15 } },
        referenceManifest: [], warnings: [], generatedAt: 1 } };
    const official = applyOfficialH3Prompt(board, { assets: [], characters: [hero], locations: [], props: [], sceneContent: content });
    if (!official.officialPromptZh.includes(`第1.3s起${name}原对白："${line}"`)) {
      throw new Error('The fixture must preserve the screenshot regression: dialogue inside the sound action layer');
    }
    const legacyEnglish = official.officialPromptZh.replaceAll(line, 'Advance!').replace(/[\p{Script=Han}]+/gu, ' old translated description ');
    const legacyBoard = { ...official, officialPromptEn: legacyEnglish, officialPromptEnSource: 'older official source',
      englishPrompt: legacyEnglish, englishPromptSource: 'older canonical source' };
    const otherBoard = { ...board, id: 'qa-other-board', sceneId: 'qa-other-scene', finalPrompt: '其它分镜不得变化',
      shots: [{ ...shot, id: 'qa-other-shot', locked: false }], targetModelId: 'qa-other-model',
      targetOutput: { ...board.targetOutput, targetId: 'qa-other-model', prompt: 'OTHER_UNTOUCHED', parameters: { seed: 9988 } } };
    const project = { ...state.project, name: '对白语言修复 QA', characters: [hero], locations: [], props: [], assets: [],
      scenes: [scene], sourceDocuments: [{ id: 'qa-dialogue-source', name: scene.title, type: 'text', content, createdAt: 1, updatedAt: 1 }],
      storyboards: [legacyBoard, otherBoard], sequencePlans: [], generationTasks: [] };
    state.project = project; state.projects = [project];
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: apiBase, apiKey: '', model: 'qa-dialogue-language' };
    state.settings.activeTextApiProfileId = null; state.settings.textApiProfiles = [];
    state.settings.uiFontScalePercent = 100;
    for (const kind of ['visionApi', 'imageApi', 'videoTaskApi']) state.settings[kind].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, apiBase: `${baseUrl}qa-dialogue-language/v1`, id: boardId, line: spokenLine, name: speaker });
  await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
  await page.getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.locator('.director-result-copy').waitFor();
  await page.locator('body').ariaSnapshot();
  const englishButton = page.getByRole('button', { name: 'English', exact: true });
  const refreshButton = page.getByRole('button', { name: '重新生成英文描述', exact: true });
  assert.deepEqual(await readCurrentness(), { chinese: true, english: false });
  assert.equal(await englishButton.isDisabled(), true, 'a saved English prompt belonging to an older source must be disabled');
  assert.equal(await refreshButton.isVisible(), true);
  const before = await readProject();
  const beforeBoard = before.storyboards.find((board) => board.id === boardId);
  assert.equal(await page.locator('.director-result-copy').textContent(), beforeBoard.officialPromptZh);
  assert.match(beforeBoard.officialPromptEn, /Advance!/u);

  await refreshButton.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'English' && !button.disabled));
  await page.locator('body').ariaSnapshot();
  await englishButton.click();
  await page.waitForFunction(({ line, name }) => {
    const body = document.querySelector('.director-result-copy')?.textContent || '';
    return body.includes(line) && body.includes(name) && body.includes('translated description');
  }, { line: spokenLine, name: speaker });
  await page.locator('body').ariaSnapshot();
  const displayedEnglish = await page.locator('.director-result-copy').textContent();
  assert.match(displayedEnglish, /前进！/u);
  assert.match(displayedEnglish, /边缘划水/u);
  assert.doesNotMatch(displayedEnglish, /Advance!|__LH_/u);
  await page.locator('.result-language-tools').getByRole('button', { name: '复制', exact: true }).click();
  await page.waitForFunction((expected) => navigator.clipboard.readText().then((actual) => actual === expected), displayedEnglish);

  await page.waitForFunction(({ key, id, english }) => JSON.parse(localStorage.getItem(key)).project.storyboards
    .find((board) => board.id === id)?.officialPromptEn === english, { key: storageKey, id: boardId, english: displayedEnglish });
  const after = await readProject();
  const afterBoard = after.storyboards.find((board) => board.id === boardId);
  const englishOnlyFields = new Set(['officialPromptEn', 'officialPromptEnSource', 'officialPromptEnError', 'englishPrompt', 'englishPromptSource', 'updatedAt']);
  const preserveBoard = (board) => Object.fromEntries(Object.entries(board).filter(([key]) => !englishOnlyFields.has(key)));
  assert.deepEqual(preserveBoard(afterBoard), preserveBoard(beforeBoard), 'Chinese, shots, provenance, references and workflow parameters must remain exact');
  const { storyboards: beforeBoards, updatedAt: beforeUpdatedAt, ...beforeOtherProject } = before;
  const { storyboards: afterBoards, updatedAt: afterUpdatedAt, ...afterOtherProject } = after;
  assert.deepEqual(afterOtherProject, beforeOtherProject, 'other project data must remain unchanged');
  assert.deepEqual(afterBoards.filter((board) => board.id !== boardId), beforeBoards.filter((board) => board.id !== boardId), 'other boards must remain unchanged');
  assert.equal(afterBoard.officialPromptEnSource, beforeBoard.officialPromptZh);
  assert.deepEqual(await readCurrentness(), { chinese: true, english: true });
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  const screenshot = 'dialogue-language-focused-1280x800.png';
  await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
  const report = { viewport: { width: 1280, height: 800 }, requests, mockOnly: true, isolatedSyntheticData: true,
    staleSourceEnglishDisabled: true, englishOnlyRecoveryAvailable: true, chineseDialoguePreserved: spokenLine,
    speakerIdentityPreserved: speaker, clipboardMatchesEnglishBody: true, chineseShotsAndParametersUnchanged: true,
    otherBoardsAndProjectDataUnchanged: true, chineseAndEnglishCurrent: true, errors, screenshot };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

try {
  await Promise.race([run(), harness.qaFailure]);
} catch (error) {
  const notice = page ? await page.locator('.sidebar-notice').textContent().catch(() => '') : '';
  throw new Error(`Focused dialogue language UI failed: ${JSON.stringify({ requests, errors, notice })}`, { cause: error });
} finally {
  await context?.close();
  await browser?.close();
  harness.markElectronStopping();
  await harness.stopAll();
  fs.writeFileSync(path.join(outputDirectory, 'vite-process.log'), harness.readElectronLog());
}
