import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App; synthetic adult ordinary characters, one generated pixel, and mocked
// model responses only. No production project, private prompt, or paid API call.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', `character-completion-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite';const s=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});await s.listen();`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'character completion UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser, context, page;
const errors = [], blocked = [], checks = [];
const savedProject = () => page.evaluate(() => { const state = window.__completionQa.saved; return state?.project?.characters ? state.project : state?.projects.find((entry) => entry.id === state.activeProjectId); });
const waitSaved = async (predicate, label) => waitForCondition({ label, timeoutMs: 15_000, intervalMs: 100, check: async () => predicate(await savedProject()) });
const select = (id) => page.getByLabel('调用项目实体', { exact: true }).selectOption(id);
const field = (label) => page.getByLabel(label, { exact: true });
const sourceGroup = () => page.getByRole('group', { name: '是否参考剧情补齐资料' });
const openWorkbench = async () => { await page.locator('.sidebar').getByRole('button', { name: '图像工作台', exact: true }).click(); await field('调用项目实体').waitFor(); };
const save = async (id, check) => { await page.getByRole('button', { name: '保存当前实体资料', exact: true }).click(); await waitSaved((project) => check(project?.characters.find((item) => item.id === id)), `${id} saved`); };
const chooseReference = async () => {
  await page.getByRole('button', { name: '从资产库选择', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从资产库选择参考图' });
  await dialog.locator('.reference-image-picker-item').filter({ hasText: '合成普通参考像素' }).click();
  await dialog.getByRole('button', { name: '使用所选图片', exact: true }).click();
  await page.getByAltText('普通参考图缩略图').waitFor();
};
const waitRequestFinished = async (kind) => waitForCondition({ label: `${kind} request finished`, timeoutMs: 15_000, intervalMs: 100, check: () => page.evaluate((expected) => window.__completionQa.finished.some((entry) => entry.kind === expected), kind) });
const clearRequests = () => page.evaluate(() => { window.__completionQa.requests = []; window.__completionQa.finished = []; });
const releaseHeld = () => page.evaluate(() => { const qa = window.__completionQa; qa.hold = false; qa.pending.splice(0).forEach((resolve) => resolve()); });
const holdNext = () => page.evaluate(() => { window.__completionQa.hold = true; });
const waitHeld = () => waitForCondition({ label: 'held synthetic request', timeoutMs: 10_000, intervalMs: 100, check: () => page.evaluate(() => window.__completionQa.pending.length > 0) });

async function run() {
  await waitForCondition({ label: 'Vite ready', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route((url) => /^https?:$/.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => { blocked.push(route.request().url()); await route.abort('blockedbyclient'); });
  await page.addInitScript(({ origin }) => {
    const raw = sessionStorage.getItem('__completion_qa_state__');
    const qa = window.__completionQa = { saved: raw ? JSON.parse(raw) : null, input: raw, loads: [], requests: [], finished: [], pending: [], hold: false, empty: false, privateRequests: 0 };
    window.lianhuaDesktop = {
      loadState: async () => qa.input || new Promise((resolve) => qa.loads.push(resolve)),
      saveState: async (serialized) => { qa.saved = JSON.parse(serialized); sessionStorage.setItem('__completion_qa_state__', serialized); return { ok: true, checksum: 'synthetic' }; },
      request: async (request) => {
        if (!request.url.startsWith(origin)) throw new Error('QA prohibits external API');
        const body = JSON.parse(request.body), kind = body.model === 'qa-vision' ? 'vision' : 'completion';
        const systemText = body.messages?.filter((entry) => entry.role === 'system').map((entry) => entry.content).join('\n') || body.system || '';
        if (/稳定私密外貌资料补齐助手|本次目标字段：[^\n]*(?:nsfwFullBody|nsfwBreasts|nsfwVulva)/.test(systemText)) { qa.privateRequests++; throw new Error('Ordinary UI must never request private completion'); }
        qa.requests.push({ kind, body });
        const prefix = kind === 'vision' ? '识图' : '补齐';
        const resultFields = qa.empty ? { gender: '', appearance: '', outfit: '', props: '', personality: '', race: '', anchor: '' } : {
          gender: '男性', morphology: 'human-like', bodyPlan: '普通成年人体结构', appearance: `${prefix}：成年人物，黑色短发，棕色眼睛`, outfit: '模型不应覆盖的红色大衣', props: `${prefix}：普通旅行包`, personality: `${prefix}：沉稳`, age: '成年三十岁', apparentAge: '成年三十岁', actualAge: '三十岁', height: '175cm', race: '人类', motion: `${prefix}：站姿自然`, anchor: `${prefix}：黑色短发与棕色眼睛`, negativeContinuity: '保持发色一致',
        };
        if (kind === 'vision') delete resultFields.negativeContinuity;
        const response = { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(resultFields) } }] }) };
        if (qa.hold) await new Promise((resolve) => qa.pending.push(resolve));
        qa.finished.push({ kind }); return response;
      },
      assetStatus: async () => ({ exists: true }), getVideoTaskCheckpoint: async () => null, getVideoTaskCredential: async () => null,
    };
  }, { origin: new URL(baseUrl).origin });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(async (base) => {
    const { createInitialState, normalizeState } = await import('/src/storage.ts');
    const state = createInitialState(), project = state.project;
    project.id = 'ordinary-completion-project'; project.name = '普通人物补齐回归'; project.description = 'MAIN_STORY_SENTINEL_DESCRIPTION';
    project.sourceDocuments = [{ id: 'ordinary-document', name: '普通剧情', content: 'MAIN_STORY_SENTINEL_CONTENT：成年旅行者在公园散步，身穿蓝色外套。', createdAt: 1, updatedAt: 1 }];
    project.scenes = []; project.storyboards = []; project.sequences = []; project.generationTasks = []; project.videoGenerationTasks = [];
    const formFields = ['name', 'gender', 'morphology', 'bodyPlan', 'appearance', 'outfit', 'props', 'personality', 'age', 'actualAge', 'height', 'race', 'motion', 'anchor', 'negativeContinuity'];
    const make = (id, useStory) => ({ id, name: `成年人物 ${id}`, gender: '', apparentAge: '', actualAge: '三十岁', height: '', race: '', morphology: '', bodyPlan: '', appearance: '', outfit: '手工锁定蓝色外套', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: ['ordinary-reference'],
      // A benign legacy marker tests that ordinary completion ignores private slots.
      nsfwProfile: { fullBody: 'LEGACY_PROFILE_SENTINEL', provenance: 'manual' },
      dossier: { useStory, confirmedFields: [...formFields], fieldSources: Object.fromEntries(formFields.map((key) => [key, 'manual'])) },
    });
    project.characters = ['vision-yes', 'vision-no', 'completion-yes', 'completion-no', 'empty-result', 'delayed-vision', 'delayed-completion', 'untouched-other'].map((id) => make(id, !id.endsWith('-no')));
    project.assets = [{ id: 'ordinary-reference', name: '合成普通参考像素', type: 'character', role: 'character', mediaType: 'image', source: 'uploaded', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', tags: [], createdAt: 1, updatedAt: 1 }];
    state.projects = [project]; state.activeProjectId = project.id;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, baseUrl: `${base}mock/v1`, apiKey: '', model: 'qa-text' };
    state.settings.visionApi = { ...state.settings.visionApi, enabled: true, baseUrl: `${base}mock/v1`, apiKey: '', model: 'qa-vision' };
    const qa = window.__completionQa; qa.input = JSON.stringify(normalizeState(state)); qa.saved = JSON.parse(qa.input); qa.loads.splice(0).forEach((resolve) => resolve(qa.input));
  }, baseUrl);
  await openWorkbench();

  for (const useStory of [true, false]) {
    const id = useStory ? 'vision-yes' : 'vision-no';
    await select(id); await chooseReference(); await clearRequests();
    assert.equal(await field('详细外观').inputValue(), '');
    await page.getByRole('button', { name: 'AI 识图', exact: true }).click();
    await waitRequestFinished('vision');
    await waitForCondition({ label: `${id} applied`, timeoutMs: 10_000, intervalMs: 100, check: async () => (await field('详细外观').inputValue()).startsWith('识图：') });
    assert.equal(await field('常驻服装').inputValue(), '手工锁定蓝色外套');
    assert.equal(await field('性别').inputValue(), '男性');
    await page.getByText(/视觉分析完成，已回填 \d+ 项资料/).waitFor();
    await save(id, (character) => character?.appearance.startsWith('识图：') && character?.dossier.fieldSources.appearance === 'reference' && !character.dossier.confirmedFields.includes('appearance'));
    await page.reload({ waitUntil: 'networkidle' }); await openWorkbench(); await select(id);
    assert.match(await field('详细外观').inputValue(), /^识图：/);
    assert.equal(await sourceGroup().getByRole('button', { name: useStory ? '是' : '否', exact: true }).getAttribute('aria-pressed'), 'true');
    checks.push(`Vision ${useStory ? 'story-on' : 'story-off'} fills formerly confirmed empty fields, retains populated manual fields, and persists reference provenance through reload`);
  }

  await select('vision-no'); await chooseReference(); await clearRequests();
  await page.getByRole('button', { name: 'AI 识图', exact: true }).click();
  await page.getByText('识图完成，但没有可回填的新资料；已有内容保持不变。', { exact: true }).waitFor();
  assert.match(await field('详细外观').inputValue(), /^识图：/);
  checks.push('A repeat vision response with no applicable new fields reports no changes instead of claiming a successful fill');

  for (const useStory of [true, false]) {
    const id = useStory ? 'completion-yes' : 'completion-no';
    await select(id); await clearRequests();
    await field('普通生图自定义要求').fill('普通成年人物，黑色短发，棕色眼睛，三十岁，旅行包。');
    await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click();
    await waitRequestFinished('completion');
    await waitForCondition({ label: `${id} applied`, timeoutMs: 10_000, intervalMs: 100, check: async () => (await field('详细外观').inputValue()).startsWith('补齐：') });
    assert.equal(await field('常驻服装').inputValue(), '手工锁定蓝色外套');
    assert.equal(await field('性别').inputValue(), '男性');
    await page.getByText(/AI 已补齐 \d+ 项资料/).waitFor();
    const calls = await page.evaluate(() => window.__completionQa.requests);
    assert.equal(calls.length, 1, 'one ordinary model request, no hidden private completion');
    assert.equal(JSON.stringify(calls).includes('MAIN_STORY_SENTINEL'), useStory, 'story-source switch controls only its intended context');
    assert.equal(await page.evaluate(() => window.__completionQa.privateRequests), 0);
    await save(id, (character) => character?.appearance.startsWith('补齐：') && !character.dossier.confirmedFields.includes('appearance'));
    checks.push(`Completion ${useStory ? 'story-on' : 'story-off'} fills confirmed empty fields, keeps manual values, and never calls the private completion path`);
  }

  await select('empty-result'); await clearRequests();
  await page.evaluate(() => { window.__completionQa.empty = true; });
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click();
  await page.getByText(/AI 没有返回可填写的补齐资料/).waitFor();
  await waitSaved((project) => project?.generationTasks.some((task) => task.sourceEntityId === 'empty-result' && task.status === 'failed'), 'empty result failure status');
  assert.equal(await field('详细外观').inputValue(), '');
  assert.equal((await savedProject()).generationTasks.some((task) => task.sourceEntityId === 'empty-result' && task.status === 'succeeded'), false);
  await page.evaluate(() => { window.__completionQa.empty = false; });
  checks.push('All-empty model output is a failed task with an actionable message rather than false success');

  await select('delayed-completion'); await holdNext();
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).click(); await waitHeld();
  await select('untouched-other'); await releaseHeld();
  await page.getByRole('button', { name: 'AI 补齐资料', exact: true }).waitFor();
  assert.equal(await field('详细外观').inputValue(), '');
  assert.equal(await field('常驻服装').inputValue(), '手工锁定蓝色外套');
  checks.push('An autofill response after selecting another character never fills the new selection');

  await select('delayed-vision'); await chooseReference(); await holdNext();
  await page.getByRole('button', { name: 'AI 识图', exact: true }).click(); await waitHeld();
  await select('untouched-other'); await releaseHeld();
  await waitForCondition({ label: 'vision busy released', timeoutMs: 10_000, intervalMs: 100, check: async () => await field('调用项目实体').isEnabled() });
  assert.equal(await field('详细外观').inputValue(), '');
  checks.push('A vision response after selecting another character never fills the new selection');

  await select('delayed-vision'); await chooseReference(); await holdNext();
  await page.getByRole('button', { name: 'AI 识图', exact: true }).click(); await waitHeld();
  await sourceGroup().getByRole('button', { name: '否', exact: true }).click(); await releaseHeld();
  await waitForCondition({ label: 'source-switch vision released', timeoutMs: 10_000, intervalMs: 100, check: async () => await page.getByRole('button', { name: 'AI 识图', exact: true }).isEnabled() });
  assert.equal(await field('详细外观').inputValue(), '');
  checks.push('Changing the story-source choice during vision analysis invalidates its delayed response');

  assert.equal(await page.evaluate(() => window.__completionQa.privateRequests), 0);
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  await select('vision-no'); await page.screenshot({ path: path.join(output, 'vision-filled.png') });
  await select('completion-yes'); await page.screenshot({ path: path.join(output, 'completion-filled.png') });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, noProductionDataRead: true, checks, errors, blocked }, null, 2));
  console.log(`Character completion UI QA passed: ${path.join(output, 'report.json')}`);
}
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); const syntheticState = await page?.evaluate(() => ({ requests: window.__completionQa.requests, privateRequests: window.__completionQa.privateRequests, tasks: window.__completionQa.saved?.project?.generationTasks })).catch(() => null); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, blocked, syntheticState, error: String(error), stack: error?.stack }, null, 2)); throw error; }
finally { await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll(); fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog()); }
