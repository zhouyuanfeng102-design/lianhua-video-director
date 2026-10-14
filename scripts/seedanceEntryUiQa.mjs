import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Run the built app in an isolated browser. Requests are handled by local
// doubles; this script cannot read desktop projects or call a paid service.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `seedance-entry-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'seedance-entry-chapter';
const apiPath = '/mock-entry/v1/chat/completions';
const story = '师傅把药草递给徒弟，二人沿山道继续前行。';
const bootstrap = `import {preview} from 'vite'; const server=await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true,open:false}}); console.log('Isolated built Seedance entry QA ready');`;
const preview = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: preview, qaLabel: 'Seedance entry built UI QA', runTimeoutMs: 200_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure;
let failChinese = true; let failEnglish = true;
const errors = []; const blockedRequests = []; const requests = []; const screenshots = [];
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  return match ? JSON.parse(match[1]) : undefined;
};
const textOf = (content) => typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
const chinese = [
  '视频规格：时长 15 秒；画面比例 16:9；分辨率 2K；声音模式 stereo。',
  '参考素材与职责：\n没有上传参考素材，按剧情与已确认分镜呈现。',
  '主体连续性：\n师傅与徒弟的衣着和身份保持连续，药草从师傅手中交给徒弟。',
  '一句话概述：\n师傅把药草递给徒弟，完成交接后两人沿着山道继续前行。',
  '连续时间轴（覆盖 0–15 秒）：\n【0s-15s】稳定中景侧拍清晨山道，师傅从左侧向右侧的徒弟递出药草。徒弟接稳药草，师傅收手，二人沿同一条山道继续走，脚步和衣摆自然跟随动作。保持左右关系和清晨侧光。无对白，保留药草摩擦声与山道环境声。',
  '全局约束：\n保持师傅、徒弟、药草和山道位置连续，不增加对白或额外人物。',
].join('\n\n');
const english = [
  'Video specification: duration 15 seconds; aspect ratio 16:9; resolution 2K; audio mode stereo.',
  'References and responsibilities:\nNo uploaded reference materials.',
  'Subject continuity:\nThe teacher and student keep their identities and outfits while the herb passes from the teacher to the student.',
  'One-sentence summary:\nThe teacher hands the herb to the student and they continue along the mountain path.',
  'Continuous timeline (covering 0–15 seconds):\n【0s-15s】A stable medium side shot on the morning mountain path follows the teacher handing the herb from the left to the student on the right. The student takes the herb, the teacher withdraws her hand, and both continue along the same path with natural footsteps and fabric movement. Keep their positions and morning sidelight continuous. No dialogue; retain the rustle of herbs and mountain ambience.',
  'Global constraints:\nKeep the teacher, student, herb and path continuous. Add no dialogue or extra characters.',
].join('\n\n');
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
const storedBoard = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').project.storyboards[0], storageKey);
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false }); screenshots.push(`${name}.png`); };
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('group', { name: '目标提示词格式', exact: true }).waitFor();
};
const targetGroup = () => page.getByRole('group', { name: '目标提示词格式', exact: true });
const targetStored = (state) => state.project.chapterWorkspaces?.[chapterId]?.directorControls?.generationPromptFormat;
const installFixture = async (content, format) => {
  await page.evaluate(({ key, chapterId, content, format, origin }) => {
    const state = JSON.parse(localStorage.getItem(key)); const now = Date.now();
    const project = { ...state.project, id: 'seedance-entry-project', name: 'Seedance 首次入口隔离验收',
      activeChapterId: chapterId, sourceDocuments: [{ id: chapterId, name: '山道交接', content, createdAt: now, updatedAt: now }],
      scenes: content ? [{ id: 'entry-scene', chapterId, title: '山道交接', content, summary: '师徒交接药草后沿山道继续前行', characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now }] : [],
      storyboards: [], sequencePlans: [], characters: [], locations: [], props: [], assets: [], generationTasks: [],
      storyDraft: undefined, storyReferenceWorkspace: undefined, directorSettingsConfirmedFingerprint: undefined,
      chapterWorkspaces: { [chapterId]: { directorControls: { generationPromptFormat: format, productionMode: 'single', durationPreset: '15s', customDuration: 15, shotMode: 'auto' } } },
      createdAt: now, updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    const api = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/mock-entry/v1`, apiKey: '', model: 'isolated-seedance-entry', vision: false };
    state.settings.textApi = api;
    state.settings.textApiProfiles = [{ ...api, id: 'entry-text-api', name: '本地 mock', createdAt: now, updatedAt: now }];
    state.settings.activeTextApiProfileId = 'entry-text-api';
    for (const name of ['visionApi', 'imageApi', 'videoTaskApi', 'runningHubVideo']) state.settings[name].enabled = false;
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, chapterId, content, format, origin });
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
};
const fulfillContent = (route, content) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
const run = async () => {
  await waitForCondition({ label: 'built Seedance entry preview', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(18_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push({ method: request.method(), path: url.pathname }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      const payload = request.postDataJSON();
      const system = (payload.messages || []).filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n');
      const user = (payload.messages || []).filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n');
      const planning = tagged(user, 'storyboard_planning_data');
      const planningReview = tagged(user, 'storyboard_ai_review_data');
      const conversion = tagged(user, 'video_conversion_data');
      const seedance = tagged(user, 'seedance_source_data');
      let kind; let response;
      if (/智能导演分类器/u.test(system)) { kind = 'director'; response = JSON.stringify({ mode: 'narrative', reason: '山道药草交接是连续叙事动作。' }); }
      else if (planning || planningReview) {
        kind = planning ? 'planning' : 'planning-review';
        response = JSON.stringify({ reason: '单镜完整呈现药草交接与继续前行。', breakdown: ['山道交接'], aiReview: { status: 'passed', summary: '保留完整剧情与连续动作。', issues: [] }, shots: [{
          startSec: 0, endSec: 15, durationSec: 15, localTimeRangeSec: [0, 15], sourceExcerpt: story,
          purpose: '完整药草交接与继续前行', subject: '师傅与徒弟', action: story, camera: '稳定中景侧拍，保持山道方向',
          transition: '连续动作', lighting: '清晨柔和侧光', sound: '药草摩擦声与山道环境声', result: '二人沿同一条山道继续前行',
          space: '师傅在左，徒弟在右，山道通向背景', performance: '双方专注完成药草交接', direction: '师傅面向徒弟，交接后一起沿山道走', dialogue: '无',
        }] });
      } else if (conversion) { kind = 'canonical-convert'; response = conversion.shotEvidence.map((shot) => shot.localStructureDraft).join('\n'); }
      else if (seedance) {
        kind = 'seedance-writer';
        if (failChinese) {
          failChinese = false; requests.push({ kind });
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"mock Seedance writer unavailable"}}' }); return;
        }
        response = chinese;
      } else if (/Seedance/u.test(system) && /翻译|translator/iu.test(system)) {
        kind = 'seedance-english';
        if (failEnglish) {
          failEnglish = false; requests.push({ kind });
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"mock Seedance English unavailable"}}' }); return;
        }
        response = english;
      } else throw new Error(`Unexpected request; possible H3 stage: ${system.slice(0, 90)}`);
      requests.push({ kind }); await fulfillContent(route, response);
    } catch (error) {
      errors.push(String(error)); await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"isolated QA rejected request"}}' }).catch(() => {});
    }
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await installFixture('', 'h3');
  await targetGroup().getByRole('button', { name: 'Seedance', exact: true }).click();
  await page.waitForFunction(({ key, chapterId }) => JSON.parse(localStorage.getItem(key)).project.chapterWorkspaces?.[chapterId]?.directorControls?.generationPromptFormat === 'seedance', { key: storageKey, chapterId });
  assert.equal(requests.length, 0, 'choosing the target format makes no model request');
  assert.equal(await targetGroup().getByRole('button', { name: 'Seedance', exact: true }).getAttribute('aria-pressed'), 'true');
  await capture('empty-story-target');
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  assert.equal(targetStored(await readState()), 'seedance', 'empty chapter restores its generation preference');
  assert.equal(await targetGroup().getByRole('button', { name: 'Seedance', exact: true }).getAttribute('aria-pressed'), 'true');

  await installFixture(story, 'seedance');
  const main = () => page.locator('.director-generate-bar').getByRole('button', { name: /AI.*分镜并生成Seedance提示词/u });
  await main().click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.storyboards[0]?.promptTrace?.mode === 'text-api', storageKey);
  await main().waitFor();
  await page.waitForFunction((key) => !JSON.parse(localStorage.getItem(key)).project.storyboards[0]?.seedance25Output, storageKey);
  const canonical = await storedBoard();
  assert.ok(canonical.finalPrompt && canonical.shots.length === 1, 'failed target writer preserves the public storyboard checkpoint');
  assert.ok(!canonical.officialPromptZh && !canonical.officialPromptEn, 'Seedance-first has no generated H3 artifact');
  assert.deepEqual(requests.map((request) => request.kind), ['director', 'planning', 'planning-review', 'canonical-convert', 'seedance-writer']);
  await capture('writer-failed-canonical-preserved');

  await main().click();
  await page.getByText(/中文稿已保存，英文版待重试/u).first().waitFor();
  const chineseBoard = await storedBoard();
  assert.equal(chineseBoard.id, canonical.id, 'retry retains the public storyboard identity');
  assert.deepEqual(chineseBoard.shots, canonical.shots, 'retry does not ask for or replace the public shot plan');
  assert.equal(chineseBoard.seedance25Output.promptZh, chinese);
  assert.deepEqual(requests.slice(5).map((request) => request.kind), ['seedance-writer', 'seedance-english'], 'target retry skips planning and H3');
  await capture('chinese-saved-english-failed');
  await page.getByRole('button', { name: '仅重试英文', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).waitFor();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.storyboards[0]?.seedance25Output?.promptEn, storageKey);
  const complete = await storedBoard();
  assert.equal(complete.seedance25Output.promptZh, chinese, 'English-only retry preserves the Chinese checkpoint');
  assert.deepEqual(complete.shots, canonical.shots);
  assert.equal(complete.seedance25Output.promptEn, english);
  assert.equal(requests[requests.length - 1].kind, 'seedance-english');
  const calls = requests.length;
  await page.getByRole('group', { name: '官方提示词格式', exact: true }).getByRole('button', { name: 'MiniMax H3', exact: true }).click();
  assert.equal(requests.length, calls, 'viewing a saved format must not generate any artifact');
  assert.equal(await targetGroup().getByRole('button', { name: 'Seedance', exact: true }).getAttribute('aria-pressed'), 'true', 'result view choice cannot change generation preference');
  await page.getByRole('group', { name: '官方提示词格式', exact: true }).getByRole('button', { name: 'Seedance 2.5', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  assert.equal((await page.locator('.director-result-copy pre').innerText()).trim(), english);
  await capture('seedance-english-view');
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  assert.equal(await targetGroup().getByRole('button', { name: 'Seedance', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('group', { name: '官方提示词格式', exact: true }).getByRole('button', { name: 'Seedance 2.5', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(requests.length, calls, 'restoring preferences and output does not start generation');
  const final = await readState();
  assert.deepEqual(final.project.generationTasks, [], 'prompt generation cannot create image/video tasks');
  assert.deepEqual(final.project.assets, []);
  assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, []);
  const report = { passed: true, builtApp: true, isolatedBrowserStorage: true, mockedTextApiOnly: true, checkpointsAndRetryCovered: true, requests, screenshots, errors, blockedRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Seedance entry built UI QA passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack, requests, errors, blockedRequests }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); fs.writeFileSync(path.join(output, 'preview-process.log'), harness.readElectronLog()); }
if (failure) throw failure;
