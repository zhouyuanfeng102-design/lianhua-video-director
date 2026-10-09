import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// One real-App flow. Fresh synthetic project storage and a loopback translator
// replace all external services; no production project or desktop data is read.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, 'seedance-rule-tail');
const generationOnly = process.argv.includes('--generation-only');
const reportFile = path.join(output, generationOnly ? 'report-generation.json' : 'report.json');
assert.ok(path.relative(outputBase, output) && !path.relative(outputBase, output).startsWith('..'));
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!stat?.isSymbolicLink(), `QA output cannot traverse links: ${candidate}`);
}
await fs.mkdir(output, { recursive: true });
const port = await findAvailableTcpPort(); const origin = `http://127.0.0.1:${port}`;
const key = 'lianhua_video_director_state_v22'; const boardId = 'seedance-rule-tail-board';
const fixturePath = '/__seedance_rule_tail_fixture.html';
const forbidden = /requiredDialogues|转换器输出|不要输出规则解释|QA_INTERNAL_RULE/u;
const line = '请把药草给我。';
const report = { pass: false, syntheticOnly: true, mockOnly: true, generationOnly, stages: [], apiRequests: [], blockedRequests: [], errors: [], screenshots: [] };
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen();`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'Seedance rule-tail isolated UI QA', runTimeoutMs: 150_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
const project = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).project, key);
const board = async () => (await project()).storyboards.find((entry) => entry.id === boardId);
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, scale: 'css' }); report.screenshots.push(file); };

async function seed() {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ key, origin, boardId, line }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { applyOfficialH3Prompt, buildOfficialH3References, buildOfficialH3SubjectDefinitions, hasCurrentOfficialH3Prompt } = await import('/src/officialPrompt.ts');
    const { compileOfficialSeedancePrompt } = await import('/src/seedancePrompt.ts');
    const state = createInitialState(); const now = Date.now();
    const story = `青衣旅人对灰衣旅人说：“${line}”灰衣旅人递出药草，青衣旅人接过后，两人继续沿山道走。`;
    const timeline = [
      `【0s-5s】主体：青衣旅人与灰衣旅人；动作：青衣旅人伸手请求，灰衣旅人递出药草；空间：山道；光影：清晨柔光；镜头：稳定中景；台词：青衣旅人说：“${line}”；音效：衣物摩擦与脚步声。`,
      '【5s-10s】主体：青衣旅人与灰衣旅人；动作：青衣旅人接过药草，两人沿山道继续前行；空间：山道；光影：清晨柔光；镜头：侧面跟拍；台词：无；音效：脚步与山风声。',
    ];
    const internalRules = [
      '规则基础：QA_INTERNAL_RULE 只生成可直接投递的提示词。',
      '连续性规则：QA_INTERNAL_RULE 按转换流程核对主体。',
      '输出规则：QA_INTERNAL_RULE 保持 requiredDialogues 字段。',
      '转换器 多模型自然语言：QA_INTERNAL_RULE 不要输出规则解释。',
      '转换器输出：只返回完整提示词，不要输出规则解释；requiredDialogues=[]。',
    ];
    const tail = internalRules.join('\n');
    const shots = timeline.map((prompt, index) => ({ id: `seedance-rule-shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5, subject: '青衣旅人与灰衣旅人', action: index ? '青衣旅人接过药草，两人沿山道继续前行' : '青衣旅人伸手请求，灰衣旅人递出药草', purpose: '连续交接', camera: index ? '侧面跟拍' : '稳定中景', lighting: '清晨柔光', sound: index ? '脚步与山风声' : `青衣旅人说：“${line}”；衣物摩擦与脚步声`, transition: '自然承接', result: story, sourceExcerpt: story, sourceStart: 0, sourceEnd: story.length, sourceBeatIds: [], referenceAssetIds: [], prompt, locked: false, authoredBy: 'text-api' }));
    const scene = { id: 'seedance-rule-scene', title: '中性山道交接', content: story, summary: '单段连续动作', characterIds: [], locationIds: [], propIds: [], storyboardIds: [boardId], createdAt: now, updatedAt: now };
    const context = { assets: [], characters: [], locations: [], props: [], sceneContent: story };
    const base = { id: boardId, sceneId: scene.id, sourceStoryTitle: scene.title, sourceStoryContent: story, workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: 'converter_unified_video', globalLock: '青衣旅人在左、灰衣旅人在右，保持服装与清晨光线连续。', shots, finalPrompt: timeline.join('\n'), promptPlan: { canonicalPrompt: timeline.join('\n'), durationSec: 10, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'drama', inputMode: 'text', shotIds: shots.map((shot) => shot.id), referenceAssetIds: [], constraints: ['青衣旅人在左，灰衣旅人在右。', ...internalRules], trace: { ruleSetId: '', converterId: 'converter_unified_video', styleId: '' } }, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now };
    const board = applyOfficialH3Prompt(base, context);
    if (!hasCurrentOfficialH3Prompt(board, context)) throw new Error('Fixture H3 must remain a current valid source for the Seedance entry');
    const references = buildOfficialH3References(board, [], []);
    const input = { canonicalPrompt: board.promptPlan.canonicalPrompt, durationSec: 10, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', references, subjectDefinitions: buildOfficialH3SubjectDefinitions(board, context, references), detailMode: 'director', targetId: 'seedance-2.5', constraints: board.promptPlan.constraints };
    const compiled = compileOfficialSeedancePrompt(input);
    board.seedance25Output = { targetId: 'seedance-2.5', promptZh: `${compiled.promptZh}\n${tail}`, promptEn: `Saved old English scene.\n${tail}`, durationSec: 10, sourceFingerprint: compiled.sourceFingerprint, englishSourceFingerprint: compiled.sourceFingerprint, referenceManifest: compiled.referenceManifest.assets, warnings: [], generatedAt: now };
    const project = { ...state.project, id: 'seedance-rule-tail-project', name: 'Seedance规则尾隔离测试', scenes: [scene], storyboards: [board], characters: [], locations: [], props: [], assets: [], sequencePlans: [], generationTasks: [], sourceDocuments: [{ id: 'seedance-rule-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: `${origin}/__seedance_rule_mock__`, apiKey: '', model: 'synthetic-seedance-translator', provider: 'openai-compatible' };
    state.settings.imageApi.enabled = false; state.settings.visionApi.enabled = false; state.settings.videoTaskApi.enabled = false; state.settings.runningHubVideo.enabled = false; state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key, origin, boardId, line });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.director-result-pane').waitFor();
}

async function run() {
  await waitForCondition({ label: 'local Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.__seedanceRuleQa = { clipboard: '' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__seedanceRuleQa.clipboard = value; }, readText: async () => window.__seedanceRuleQa.clipboard } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) { report.blockedRequests.push(request.url()); await route.abort('blockedbyclient'); return; }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>合成Seedance规则尾测试</title><body>合成中性剧情</body></html>' }); return; }
    if (request.method() === 'POST' && url.pathname === '/__seedance_rule_mock__/v1/chat/completions') {
      const payload = request.postDataJSON(); const source = payload.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
      report.apiRequests.push({ source, model: payload.model });
      assert.doesNotMatch(source, forbidden, 'the translator receives scene content without appended app rules');
      if (report.apiRequests.length === 1) { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ unexpected: 'synthetic-first-translation-failure' }) }); return; }
      const english = source.replace(/[\p{Script=Han}]+/gu, ' translated scene description ');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: english } }] }) }); return;
    }
    if (!['GET', 'HEAD'].includes(request.method())) { report.blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  await seed();
  const initial = await board(); const copy = page.locator('.result-language-tools').getByRole('button', { name: '复制', exact: true });
  await page.getByRole('button', { name: 'Seedance 2.5', exact: true }).click();
  if (!generationOnly) {
  assert.equal(report.apiRequests.length, 0, 'format switching does not regenerate or translate');
  assert.equal(await copy.isDisabled(), true, 'contaminated saved output is not a valid copy payload');
  assert.equal(await page.getByRole('button', { name: 'English', exact: true }).isDisabled(), true, 'contaminated saved English is not an active delivery');
  await page.getByText('Seedance 原保存稿含转换规则', { exact: true }).waitFor();
  const originalPreview = page.locator('details').filter({ has: page.getByText('查看原保存稿', { exact: true }) });
  await originalPreview.locator('summary').click();
  const reviewText = await originalPreview.innerText();
  assert.ok(reviewText.includes(initial.seedance25Output.promptZh), 'the original Chinese draft remains available for explicit review');
  assert.ok(reviewText.includes(initial.seedance25Output.promptEn), 'the original English draft remains available for explicit review');
  assert.deepEqual((await board()).seedance25Output, initial.seedance25Output, 'legacy content remains saved for review');
  const choices = await page.evaluate(async (key) => {
    const { videoPromptChoices } = await import('/src/videoDirectorDraft.ts');
    return videoPromptChoices(JSON.parse(localStorage.getItem(key)).project).map((choice) => choice.prompt);
  }, key);
  assert.ok(choices.every((prompt) => prompt !== initial.seedance25Output.promptZh && prompt !== initial.seedance25Output.promptEn), 'old Seedance output is not offered as a video submission candidate');
  await capture('old-polluted-delivery-disabled');
  report.stages.push('old-contaminated-output-kept-for-review-but-disabled-for-copy-English-and-video-selection');
  }

  await page.getByRole('button', { name: '生成 Seedance 2.5 官方稿', exact: true }).click();
  await page.getByText(/中文稿已保存，英文版待重试/u).waitFor();
  assert.equal(report.apiRequests.length, 1, 'new Chinese compilation needs one English request, no Chinese model conversion');
  const zh = await page.locator('.director-result-copy pre').innerText();
  await page.waitForFunction(({ key, boardId, zh }) => JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === boardId)?.seedance25Output?.promptZh === zh, { key, boardId, zh });
  const savedZh = await board();
  assert.equal(zh, savedZh.seedance25Output.promptZh); assert.doesNotMatch(zh, forbidden);
  assert.match(zh, /视频规格/u); assert.match(zh, /0s-5s/u); assert.match(zh, /5s-10s/u); assert.ok(zh.includes(line));
  assert.match(zh, /稳定中景/u); assert.match(zh, /侧面跟拍/u); assert.match(zh, /药草/u);
  assert.equal(await copy.isDisabled(), false); await copy.click();
  assert.equal(await page.evaluate(() => window.__seedanceRuleQa.clipboard), zh);
  assert.deepEqual(savedZh.shots, initial.shots); assert.equal(savedZh.finalPrompt, initial.finalPrompt); assert.deepEqual(savedZh.promptPlan, initial.promptPlan); assert.equal(savedZh.officialPromptZh, initial.officialPromptZh);
  await capture('clean-chinese-saved-after-English-failure');
  report.stages.push('new-clean-Chinese-delivery-saves-both-real-shots-and-dialogue-without-rewriting-source');

  await page.getByRole('button', { name: '仅重试英文', exact: true }).click();
  await page.getByRole('button', { name: '仅重试英文', exact: true }).waitFor({ state: 'detached' });
  assert.equal(report.apiRequests.length, 2, 'English-only retry sends exactly one additional translation request');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  const en = await page.locator('.director-result-copy pre').innerText();
  await page.waitForFunction(({ key, boardId, en }) => JSON.parse(localStorage.getItem(key)).project.storyboards.find((entry) => entry.id === boardId)?.seedance25Output?.promptEn === en, { key, boardId, en });
  const savedEn = await board(); assert.equal(savedEn.seedance25Output.promptZh, savedZh.seedance25Output.promptZh);
  assert.deepEqual(savedEn.shots, savedZh.shots); assert.equal(savedEn.finalPrompt, savedZh.finalPrompt); assert.deepEqual(savedEn.promptPlan, savedZh.promptPlan); assert.equal(savedEn.officialPromptZh, savedZh.officialPromptZh);
  assert.equal(en, savedEn.seedance25Output.promptEn); assert.doesNotMatch(en, forbidden); assert.ok(en.includes(line), 'English preserves original Chinese dialogue');
  await copy.click(); assert.equal(await page.evaluate(() => window.__seedanceRuleQa.clipboard), en);
  await capture('clean-English-retry-copy');
  report.stages.push('English-only-retry-keeps-Chinese-source-shots-and-dialogue-and-copies-saved-selected-language');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedRequests, []); report.pass = true;
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); report.failure.body = await page.locator('body').innerText().catch(() => ''); }
  process.exitCode = error.exitCode || 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {}); harness.markElectronStopping();
  await harness.stopAll().catch((error) => { report.cleanupError = error.message; report.pass = false; process.exitCode = 1; });
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`); await fs.writeFile(path.join(output, generationOnly ? 'vite-process-generation.log' : 'vite-process.log'), harness.readElectronLog());
}
console.log(JSON.stringify({ pass: report.pass, stages: report.stages, apiCalls: report.apiRequests.length, report: reportFile, failure: report.failure?.message }, null, 2));
