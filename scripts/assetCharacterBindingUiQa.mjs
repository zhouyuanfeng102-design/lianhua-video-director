import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, 'asset-character-binding'));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output must not traverse directory links');
}
fs.mkdirSync(output, { recursive: true });

const storageKey = 'lianhua_video_director_state_v22';
const port = await findAvailableTcpPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const bootstrap = `import {createServer} from 'vite'; const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await server.listen(); console.log('Isolated asset character binding QA ready');`;
const server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: server, qaLabel: 'asset character binding UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser;
let context;
let page;
const errors = [];
const results = [];
const screenshots = [];

const seed = async (font) => page.evaluate(async ({ key, fontScale }) => {
  const { applyOfficialH3Prompt } = await import('/src/officialPrompt.ts');
  const state = JSON.parse(localStorage.getItem(key));
  const now = Date.now();
  const character = (id, name) => ({
    id, name, gender: '女性', apparentAge: '30岁', actualAge: '30岁', race: '人类',
    appearance: '成年旅人', outfit: '蓝色长外套', signatureProps: '', personality: '平静',
    motionHabits: '站立', anchor: '深色短发', negativeContinuity: '', assetIds: [],
  });
  const characters = [character('binding-person-a', '成年旅人甲'), character('binding-person-b', '成年旅人乙')];
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 120;
  const paint = canvas.getContext('2d');
  paint.fillStyle = '#526f99'; paint.fillRect(0, 0, 160, 120);
  paint.fillStyle = '#fff'; paint.fillText('ADULT REFERENCE QA', 14, 60);
  const asset = {
    id: 'binding-image', name: '可选人物绑定测试图', type: 'reference', role: 'subject', referenceRole: 'subject',
    mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'),
    width: 160, height: 120, source: 'upload', tags: ['隔离合成图片'], createdAt: now, updatedAt: now,
  };
  const legacyAsset = {
    ...asset, id: 'binding-legacy-image', name: '旧人物来源测试图', type: 'character', role: 'character', referenceRole: 'character',
    sourceEntityKind: 'character', sourceEntityId: characters[0].id,
  };
  characters[0].assetIds = [legacyAsset.id];
  const assets = [asset, legacyAsset];
  const story = '成年旅人甲在廊桥入口等候成年旅人乙。';
  const prompt = '【0s-5s】 主体：@成年旅人甲（平静）[朝向：廊桥入口] 正在 [站立→抬头]（等待同伴）；空间：成年旅人甲在廊桥入口；光影：自然侧光；镜头：中景固定；台词：无；音效：环境层-[微风] 动作层-[无] 情绪层-[无配乐]';
  const scene = {
    id: 'binding-scene', title: '廊桥等候', content: story, summary: story,
    characterIds: characters.map((entry) => entry.id), locationIds: [], propIds: [], storyboardIds: ['binding-board'], createdAt: now, updatedAt: now,
  };
  const board = applyOfficialH3Prompt({
    id: 'binding-board', chapterId: 'binding-chapter', sceneId: scene.id, sourceStoryContent: story, sourceStoryTitle: '廊桥等候',
    workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
    pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
    ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', globalLock: '',
    shots: [{ id: 'binding-shot', index: 1, startSec: 0, endSec: 5, subject: characters[0].name, action: '抬头等候', purpose: '等待同伴', camera: '中景固定', lighting: '自然侧光', sound: '', transition: '自然承接', result: '等待同伴', referenceAssetIds: [], prompt, locked: false }],
    finalPrompt: prompt, targetModelId: 'minimax-h3', createdAt: now, updatedAt: now,
  }, { assets, characters, locations: [], props: [], sceneContent: story });
  board.officialPromptEn = 'integrated_multimodal_description: [Shot 1] An adult traveler waits beside a bridge.\n\noverall_soundscape: Gentle wind.\n\nnon_diegetic_music: N/A';
  board.officialPromptEnSource = board.officialPromptZh;
  const project = {
    ...state.project, id: 'binding-project', name: '人物绑定隔离测试', activeChapterId: 'binding-chapter', chapterWorkspaces: {}, storyDraft: story,
    sourceDocuments: [{ id: 'binding-chapter', name: '第1章', content: story, createdAt: now, updatedAt: now }],
    scenes: [scene], storyboards: [board], sequencePlans: [], assets, generationTasks: [], characters, locations: [], props: [], updatedAt: now,
  };
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  state.settings.uiFontScalePercent = fontScale;
  for (const kind of ['textApi', 'visionApi', 'imageApi', 'videoTaskApi']) {
    if (state.settings[kind]) { state.settings[kind].enabled = false; state.settings[kind].apiKey = ''; }
  }
  state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null; state.settings.videoBackend = 'api';
  localStorage.setItem(key, JSON.stringify(state));
}, { key: storageKey, fontScale: font });

const snapshot = async () => page.evaluate(async (key) => {
  const state = JSON.parse(localStorage.getItem(key));
  const project = state.project.id === 'binding-project' ? state.project : state.projects.find((entry) => entry.id === 'binding-project');
  const { videoReferenceCharacterOwners } = await import('/src/videoH3ReferenceBinding.ts');
  return {
    boards: project.storyboards,
    characters: project.characters,
    assets: project.assets.map((asset) => ({ ...asset, owners: videoReferenceCharacterOwners(project, asset).map((owner) => owner.id) })),
  };
}, storageKey);

const assertStoredBinding = async (assetId, id) => {
  await page.waitForFunction(({ key, assetId: targetId, characterId }) => {
    const state = JSON.parse(localStorage.getItem(key));
    const project = state.project.id === 'binding-project' ? state.project : state.projects.find((entry) => entry.id === 'binding-project');
    return project.assets.find((asset) => asset.id === targetId)?.characterReferenceId === characterId;
  }, { key: storageKey, assetId, characterId: id });
  const current = await snapshot();
  assert.deepEqual(current.assets.find((asset) => asset.id === assetId).owners, id ? [id] : []);
  return current;
};

const assertReachable = async (locator, label) => {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && box.height > 0 && box.x >= 0 && box.right <= innerWidth + 1
      && box.y >= 0 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit));
  }), `${label} must be visible and unobstructed`);
};

const assertActionsDoNotOverlap = async (card) => {
  const overlaps = await card.locator('.asset-actions button').evaluateAll((buttons) => {
    const boxes = buttons.map((button) => ({ text: button.textContent, box: button.getBoundingClientRect() }));
    return boxes.flatMap((left, index) => boxes.slice(index + 1).filter((right) =>
      Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left) > 1
      && Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top) > 1,
    ).map((right) => `${left.text} / ${right.text}`));
  });
  assert.deepEqual(overlaps, [], 'asset card actions must not overlap');
};

const run = async () => {
  await waitForCondition({ label: 'binding QA Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(baseUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  for (const spec of [{ width: 1280, height: 800, font: 100 }, { width: 1366, height: 768, font: 125 }]) {
    context = await browser.newContext({ viewport: { width: spec.width, height: spec.height } });
    page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__binding_qa__')) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__binding_qa__', '1'); }
      window.__bindingQaRequests = [];
      window.lianhuaDesktop = {
        onVideoProgress: () => () => {}, unwatchVideoProgress: async () => true,
        videoRequest: async (payload) => { window.__bindingQaRequests.push(payload.url); throw new Error('No real API request permitted in binding QA'); },
      };
    });
    await page.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) {
        errors.push(`Unexpected API request: ${url.href}`); await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await seed(spec.font); await page.reload({ waitUntil: 'networkidle', timeout: 40_000 });
    const nav = () => page.locator('.sidebar').getByRole('button', { name: '资产库', exact: true }).click();
    await nav();
    const card = page.locator('#asset-card-binding-image');
    const legacyCard = page.locator('#asset-card-binding-legacy-image');
    await card.waitFor();
    const before = await snapshot();
    assert.ok(before.boards[0].officialPromptZh && before.boards[0].officialPromptEn, 'fixture must retain both saved prompts');
    for (const name of ['首帧', '尾帧', '绑定分镜']) assert.equal(await page.locator('.asset-card').getByRole('button', { name, exact: true }).count(), 0);
    await card.getByText('未绑定人物（可直接使用）', { exact: true }).waitFor();
    const bindingButton = (targetCard) => targetCard.getByRole('button', { name: '选择、更换或解除人物绑定', exact: true });
    assert.equal(await bindingButton(card).innerText(), '绑定');
    await assertReachable(bindingButton(card), 'image binding action');
    await assertActionsDoNotOverlap(card);
    const saveImage = async (name) => { await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name); };
    await saveImage(`cards-${spec.width}x${spec.height}-font${spec.font}.png`);

    const dialog = page.getByRole('dialog', { name: '绑定人物参考图', exact: true });
    const openBinding = async (targetCard) => { await bindingButton(targetCard).click(); await dialog.waitFor(); };
    const select = dialog.getByLabel('绑定人物', { exact: true });
    await openBinding(card);
    assert.equal(await select.locator('option:checked').innerText(), '不绑定人物');
    await select.selectOption('binding-person-a');
    await assertReachable(select, 'character selector');
    await assertReachable(dialog.getByRole('button', { name: '保存绑定', exact: true }), 'save binding action');
    await assertReachable(dialog.getByRole('button', { name: '取消', exact: true }), 'cancel action');
    assert.ok(await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect(); return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    }), 'binding dialog must fit the viewport');
    await saveImage(`dialog-${spec.width}x${spec.height}-font${spec.font}.png`);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual((await snapshot()).assets, before.assets, 'cancel must not save a binding');
    await openBinding(card); await select.selectOption('binding-person-a');
    await dialog.getByRole('button', { name: '保存绑定', exact: true }).click();
    await assertStoredBinding('binding-image', 'binding-person-a');
    await card.getByText('人物参考：成年旅人甲', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' }); await nav();
    await card.getByText('人物参考：成年旅人甲', { exact: true }).waitFor();
    await openBinding(card); assert.equal(await select.inputValue(), 'binding-person-a');
    await select.selectOption('binding-person-b'); await dialog.getByRole('button', { name: '保存绑定', exact: true }).click();
    await assertStoredBinding('binding-image', 'binding-person-b');
    await card.getByText('人物参考：成年旅人乙', { exact: true }).waitFor();
    await openBinding(card); await select.selectOption({ label: '不绑定人物' });
    await dialog.getByRole('button', { name: '保存绑定', exact: true }).click();
    await assertStoredBinding('binding-image', null);
    await card.getByText('未绑定人物（可直接使用）', { exact: true }).waitFor();

    // A legacy character source is provenance, so explicit unbinding must
    // override it without deleting that source or the character's old asset list.
    await legacyCard.getByText('人物参考：成年旅人甲', { exact: true }).waitFor();
    await openBinding(legacyCard); await select.selectOption({ label: '不绑定人物' });
    await dialog.getByRole('button', { name: '保存绑定', exact: true }).click();
    await assertStoredBinding('binding-legacy-image', null);
    await page.reload({ waitUntil: 'networkidle' }); await nav();
    await legacyCard.getByText('未绑定人物（可直接使用）', { exact: true }).waitFor();
    await card.getByRole('button', { name: '用此图生成视频', exact: true }).click();
    await page.locator('.video-director-view').waitFor();
    assert.equal(await page.locator('.vd-reference-row').count(), 1, 'unbound image must remain usable as a video reference');
    assert.ok((await page.locator('.vd-reference-row').innerText()).includes('可选人物绑定测试图'));
    const after = await snapshot();
    assert.deepEqual(after.boards, before.boards, 'binding changes must preserve all storyboard data and both saved prompts');
    assert.deepEqual(after.characters, before.characters, 'binding changes must not rewrite dossiers or legacy ownership');
    for (const previous of before.assets) {
      const current = after.assets.find((asset) => asset.id === previous.id);
      const stripBinding = ({ characterReferenceId, updatedAt, owners, ...rest }) => rest;
      assert.deepEqual(stripBinding(current), stripBinding(previous), 'binding must preserve image bytes, role, and generation provenance');
      assert.equal(current.characterReferenceId, null);
    }
    assert.deepEqual(await page.evaluate(() => window.__bindingQaRequests), []);
    assert.deepEqual(errors, []);
    results.push({ ...spec, bindAndReload: true, changeAndUnbind: true, legacyUnbindPersists: true, cancelPreservesData: true, unboundUsable: true, bilingualPromptsUnchanged: true, noControlOverlap: true, apiRequests: 0 });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mockOnly: true, noProductionDataRead: true, results, screenshots, errors }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
    await context.close(); context = undefined;
  }
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), results, errors }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite.log'), harness.readElectronLog());
}
