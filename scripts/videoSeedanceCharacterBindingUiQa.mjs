import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic component-only regression. No App mount, saved user project,
// credential, native file, upload, model request or video generation is used.
// The actual director and request serializer run against a mock controller.
export async function installSeedanceCharacterBindingFixture(page, origin) {
  const blockedRequests = [];
  await page.route((url) => /^https?:$/u.test(url.protocol) && (url.origin !== origin || url.pathname.startsWith('/unused-')), async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__seedance_character_binding_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__seedance_character_binding_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { createInitialState } = await import('/src/storage.ts');
    const { buildOfficialSeedanceInput } = await import('/src/seedanceSource.ts');
    const { getOfficialSeedanceSourceFingerprint } = await import('/src/seedancePrompt.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    await import('/src/styles.css');
    const state = createInitialState(); const now = Date.now();
    const names = ['林舟', '苏晴', '陈宁', '许岚'];
    const roles = ['first-frame', 'middle-frame', 'middle-frame', 'middle-frame', 'last-frame', 'character', 'character', 'character', 'character'];
    const imageNames = ['清晨庭院首帧', '庭院过程一', '庭院过程二', '庭院过程三', '庭院结束帧', ...names.map((name) => `${name}人物图`)];
    const assets = imageNames.map((name, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 112;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = index < 5 ? '#365978' : '#67628a'; ctx.fillRect(0, 0, 180, 112);
      ctx.fillStyle = '#fff'; ctx.font = '15px sans-serif'; ctx.fillText(name, 10, 62);
      return { id: `scb-image-${index + 1}`, name, type: 'reference', role: roles[index], referenceRole: roles[index], source: 'upload', mediaType: 'image', mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 180, height: 112, checksum: `synthetic-${index + 1}`, ...(index >= 5 ? { sourceEntityId: `scb-character-${index - 4}`, sourceEntityKind: 'character' } : {}), tags: [], createdAt: now, updatedAt: now };
    });
    const characters = names.map((name, index) => ({ id: `scb-character-${index + 1}`, name, gender: index === 0 ? '男' : '女', apparentAge: '30', race: '人类', appearance: '固定身份', outfit: '普通外套', signatureProps: '', personality: '', motionHabits: '', anchor: '合成人物', negativeContinuity: '', assetIds: [`scb-image-${index + 6}`] }));
    const promptZh = [
      '视频规格：时长30秒，画幅16:9，分辨率2K，立体声。',
      '',
      '参考素材与职责：本次未提供图片、视频或音频参考素材，全部人物、道具与场景均以文字设定为执行依据。庭院按“清晨开放的石砖庭院”建立空间。门牌保留字样“欢迎来到庭院”，不作为对白；墙上的“@Image 77”也是原场景文字。',
      '',
      '主体连续性：林舟为三十岁男性，黑色短发，穿深蓝外套。苏晴为三十岁女性，棕色短发，穿米色外套。陈宁为三十岁女性，黑色长发，穿浅灰外套。许岚为三十岁女性，银灰短发，穿墨绿外套。本段实际发话者为陈宁，女性身份，语气轻松；其余人物在本段不说话。',
      '',
      '一句话概述：林舟与苏晴来到庭院，陈宁向两人招手，众人准备同行。',
      '',
      '连续时间轴：',
      '0秒至10秒，中景，林舟与苏晴走入庭院，镜头缓慢跟随。',
      '10秒至20秒，陈宁向林舟和苏晴招手，微笑说：“我们现在出发。”',
      '20秒至30秒，林舟转身面向陈宁等人，许岚等人也摆手拒绝，随后众人一起向庭院门口前进，脚步逐渐远去。',
      '',
      '全局约束：身份与服装连续，保留原始中文对白，不加入字幕，环境声为脚步与清风。',
    ].join('\n');
    const segment = { id: 'scb-segment-1', index: 1, title: '庭院同行', globalStartSec: 0, globalEndSec: 30, durationSec: 30, content: '林舟与苏晴到庭院，陈宁招手，众人一起出发。', summary: '庭院同行', sourceSceneIds: ['scb-scene'], sourceBeatIds: [], narrativePurpose: '结伴出发', entryState: '', exitState: '', transitionHint: '', storyboardId: 'scb-board-1', status: 'ready' };
    const plan = { id: 'scb-plan', title: '合成庭院计划', sourceStoryTitle: '庭院同行', sourceStoryContent: segment.content, durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 30, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments: [segment], createdAt: now, updatedAt: now };
    const board = { id: segment.storyboardId, sceneId: 'scb-scene', sourceStoryTitle: segment.title, sourceStoryContent: segment.content, workflow: 'drama', inputMode: 'text_reference', durationSec: 30, durationPreset: 'custom', shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [], finalPrompt: promptZh, promptMigrationPending: false, shots: [
      { id: 'scb-shot-1', index: 1, startSec: 0, endSec: 10, subject: '林舟与苏晴', action: '走入庭院', camera: '跟拍', lighting: '自然光', sound: '脚步', referenceAssetIds: [], prompt: '', locked: false },
      { id: 'scb-shot-2', index: 2, startSec: 10, endSec: 20, subject: '陈宁', action: '招手问候', camera: '中景', lighting: '自然光', sound: '中文对白', referenceAssetIds: [], prompt: '', locked: false },
      { id: 'scb-shot-3', index: 3, startSec: 20, endSec: 30, subject: '林舟和陈宁等人', action: '向门口前进', camera: '中景', lighting: '自然光', sound: '脚步', referenceAssetIds: [], prompt: '', locked: false },
    ], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: 1, segmentCount: 1, createdAt: now, updatedAt: now };
    const project = { ...state.project, id: 'scb-isolated-project', name: '合成Seedance选图回归', sourceDocuments: [], characters, locations: [], props: [], scenes: [{ id: 'scb-scene', title: '庭院', content: segment.content, summary: '', characterIds: characters.slice(0, 3).map((character) => character.id), propIds: [], storyboardIds: [board.id], createdAt: now, updatedAt: now }], storyboards: [board], sequencePlans: [plan], assets, generationTasks: [] };
    const fingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
    board.seedance25Output = { targetId: 'seedance-2.5', promptZh, promptEn: '', durationSec: 30, sourceFingerprint: fingerprint, referenceManifest: [], warnings: [], generatedAt: now };
    const settings = { ...state.settings, videoBackend: 'api', videoSource: 'api', activeVideoApiProfileId: null, videoApiProfiles: [], textApi: { ...state.settings.textApi, enabled: false, apiKey: '', baseUrl: `${location.origin}/unused-text` }, videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic', model: 'synthetic-seedance', apiKey: '', endpoint: `${location.origin}/unused-video`, statusEndpointTemplate: `${location.origin}/unused-video/{id}`, requestTemplate: '' } };
    const qa = window.__seedanceCharacterBindingQa = { project, settings, names, imageNames, roles, promptZh, submissions: [], persisted: [], originalProject: JSON.stringify(project) };
    const controller = { runtimes: {}, start: async (draft) => { qa.submissions.push({ items: [{ draft: structuredClone(draft) }] }); return 'mock-only-task'; }, startBatch: async (input) => { qa.submissions.push(structuredClone(input)); return { taskIds: [], skipped: [] }; }, cancel: async () => {}, cancelBatch: async () => ({ canceled: [], skipped: [] }), resume: async () => {}, retryDownload: async () => {} };
    qa.controller = controller;
    qa.root = ReactDOM.createRoot(document.getElementById('root'));
    qa.root.render(React.createElement('main', { style: { height: '100dvh', padding: 12, boxSizing: 'border-box' } }, React.createElement(VideoDirectorView, { project, settings, controller, onChapterDraftChange: (...args) => qa.persisted.push(structuredClone(args)) })));
  });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByLabel('批量提示词格式', { exact: true }).selectOption('seedance');
  return { blockedRequests };
}

export async function runSeedanceCharacterBindingAssertions(page, outputDirectory) {
  const stages = []; const screenshots = [];
  const row = page.locator('[data-segment-id="scb-segment-1"]');
  const showList = async () => { const tab = page.getByRole('tab', { name: '分段清单', exact: true }); if (await tab.isVisible()) await tab.click(); };
  const openPicker = async () => { await showList(); await row.getByRole('button', { name: '第 1 段选择参考图', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '第 1 段 · 选择参考图', exact: true }); await dialog.waitFor(); return dialog; };
  const currentPrompt = async () => { await showList(); await row.getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('tab', { name: '本次实际提示词', exact: true }).click(); return page.locator('.vd-batch-preview .vd-prompt-preview').innerText(); };
  const capture = async (name) => { const file = path.join(outputDirectory, `${name}.png`); await page.screenshot({ path: file, scale: 'css', animations: 'disabled' }); screenshots.push(file); };
  const fixture = await page.evaluate(() => ({ names: window.__seedanceCharacterBindingQa.names, imageNames: window.__seedanceCharacterBindingQa.imageNames, roles: window.__seedanceCharacterBindingQa.roles, promptZh: window.__seedanceCharacterBindingQa.promptZh }));
  const assertPreserved = (prompt) => {
    assert.equal(prompt.slice(prompt.indexOf('主体连续性：')), fixture.promptZh.slice(fixture.promptZh.indexOf('主体连续性：')), 'all subject descriptions, summary, actions, time ranges, exact dialogue and constraints remain byte-for-byte authored');
    for (const literal of ['“清晨开放的石砖庭院”', '“欢迎来到庭院”', '“@Image 77”']) assert.ok(prompt.includes(literal), `quoted literal ${literal} remains authored`);
  };
  const assertBindings = async (dialog, expectedSlots = [6, 7, 8, 9]) => {
    const hint = dialog.getByRole('note', { name: '本段涉及人物', exact: true });
    const chips = hint.locator('.vd-segment-character-chip');
    assert.equal(await chips.count(), 4, 'all four explicitly defined characters are included, including the silent fourth character whose action uses 等人也摆手拒绝');
    assert.equal(await hint.locator('.vd-segment-character-secondary').count(), 0, 'the fourth character is not relegated to other mentions');
    for (let index = 0; index < fixture.names.length; index += 1) {
      const chip = hint.locator(`[data-character-id="scb-character-${index + 1}"]`);
      assert.equal(await chip.getAttribute('data-reference-status'), 'bound');
      assert.match(await chip.innerText(), new RegExp(`已选 · 已关联图片 ${expectedSlots[index]}(?:\\D|$)`, 'u'));
    }
  };
  const assertSubmission = async (preview, imageIds) => {
    const input = await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.at(-1));
    assert.equal(input.items.length, 1);
    const draft = input.items[0].draft;
    assert.equal(draft.source.promptFormat, 'seedance'); assert.equal(draft.prompt, preview, 'mock submit and inspected preview use the same complete prompt');
    assert.deepEqual(draft.references.map((reference) => reference.assetId), imageIds);
    assert.deepEqual(draft.references.map((reference) => reference.role), fixture.roles);
    const serialized = await page.evaluate(async (value) => {
      const { resolveConfiguredVideoApi } = await import('/src/runningHubVideo.ts'); const { buildVideoApiBody } = await import('/src/videoGenerationApi.ts');
      const api = resolveConfiguredVideoApi(window.__seedanceCharacterBindingQa.settings, value);
      const urls = value.references.map((reference) => `https://synthetic.invalid/${reference.assetId}.png`);
      return { urls, body: buildVideoApiBody(api, value, urls) };
    }, draft);
    assert.equal(serialized.body.prompt, preview); assert.deepEqual(serialized.body.images, serialized.urls, 'the actual API serializer keeps exactly the inspected image order');
    assert.equal(serialized.body.first_frame_image, serialized.urls[0]); assert.equal(serialized.body.last_frame_image, serialized.urls[4]);
    for (const [index, id] of imageIds.entries()) {
      const name = fixture.imageNames[Number(id.split('-').at(-1)) - 1];
      assert.ok(preview.split('\n').some((line) => line.startsWith(`@Image ${index + 1}：`) && line.includes(name)), `submitted image ${index + 1} names its corresponding asset`);
    }
    assertPreserved(preview);
  };
  const submit = async () => {
    const before = await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.length);
    await showList(); await row.getByLabel('选择第 1 段', { exact: true }).check(); await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true }); await dialog.waitFor();
    assert.equal(await page.evaluate(() => window.__seedanceCharacterBindingQa.submissions.length), before, 'confirmation alone does not submit');
    await dialog.getByLabel('确认批量生成费用', { exact: true }).check(); await dialog.getByRole('button', { name: '确认生成 1 段', exact: true }).click();
    await page.waitForFunction((count) => window.__seedanceCharacterBindingQa.submissions.length === count, before + 1);
  };

  assert.equal(await currentPrompt(), fixture.promptZh, 'opening an unbound text-only Seedance draft leaves its saved source unchanged');
  let picker = await openPicker();
  assert.equal(await picker.locator('.vd-segment-character-chip').count(), 4, 'four characters visible even before selecting images');
  for (const name of fixture.imageNames) await picker.getByRole('button', { name: `选择图片 ${name}`, exact: true }).click();
  await assertBindings(picker); await capture('nine-images-four-bound-characters');
  await picker.getByRole('tab', { name: '槽位用途', exact: true }).click();
  for (const [index, role] of fixture.roles.entries()) assert.equal(await picker.getByLabel(`第 1 段图片槽 ${index + 1} 用途`, { exact: true }).inputValue(), role);
  await picker.getByRole('button', { name: '使用本段图片', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  const firstPreview = await currentPrompt(); assertPreserved(firstPreview);
  assert.match(firstPreview, /原稿写作时的素材说明/u); assert.match(firstPreview, /本次提交的参考图片（以此清单为准）/u);
  await submit(); await assertSubmission(firstPreview, Array.from({ length: 9 }, (_, index) => `scb-image-${index + 1}`));
  stages.push('four-character-roster-nine-bound-images-preview-and-real-request-serializer-agree');

  picker = await openPicker(); await picker.getByRole('button', { name: `取消选择图片 ${fixture.imageNames[5]}`, exact: true }).click();
  await picker.getByRole('button', { name: '关闭', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  assert.equal(await currentPrompt(), firstPreview, 'closing the picker discards provisional removal and preserves the applied prompt');
  picker = await openPicker(); await assertBindings(picker); await picker.getByRole('button', { name: '关闭', exact: true }).click();
  stages.push('closing-picker-discards-unapplied-selection-and-binding-changes');

  picker = await openPicker();
  for (const index of [5, 6]) await picker.getByRole('button', { name: `取消选择图片 ${fixture.imageNames[index]}`, exact: true }).click();
  for (const index of [6, 5]) await picker.getByRole('button', { name: `选择图片 ${fixture.imageNames[index]}`, exact: true }).click();
  await assertBindings(picker, [7, 6, 8, 9]); await capture('reordered-character-slots');
  await picker.getByRole('button', { name: '使用本段图片', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  const reorderedPreview = await currentPrompt();
  assert.notEqual(reorderedPreview, firstPreview); assertPreserved(reorderedPreview);
  assert.equal(reorderedPreview.split('本次提交的参考图片（以此清单为准）').length, 2, 'repeated selection regenerates one current list from the original, never accumulates lists');
  await submit(); await assertSubmission(reorderedPreview, ['scb-image-1', 'scb-image-2', 'scb-image-3', 'scb-image-4', 'scb-image-5', 'scb-image-7', 'scb-image-6', 'scb-image-8', 'scb-image-9']);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__seedanceCharacterBindingQa.project) === window.__seedanceCharacterBindingQa.originalProject), true, 'source storyboard, source prompt, assets and character identities are never mutated by selection, cancel, reorder or mock submit');
  stages.push('reordering-images-updates-character-tokens-preview-and-submitted-array-without-source-mutation');
  return { passed: true, stages, screenshots, mockSubmissions: 2, externalApiCalls: 0 };
}

export async function runStandaloneSeedanceCharacterBindingUiQa() {
  const { createServer } = await import('vite'); const { chromium } = await import('playwright');
  const root = path.resolve(import.meta.dirname, '..'); const outputDirectory = path.join(root, 'output', 'playwright', 'video-seedance-character-binding');
  await fs.mkdir(outputDirectory, { recursive: true });
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); let browser;
  try {
    await server.listen(); const address = server.httpServer.address(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20_000); const errors = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    const { blockedRequests } = await installSeedanceCharacterBindingFixture(page, `http://127.0.0.1:${address.port}`);
    const report = await runSeedanceCharacterBindingAssertions(page, outputDirectory);
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'no external, text, upload or video endpoint was attempted');
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ ...report, errors, blockedRequests }, null, 2)); return report;
  } catch (cause) {
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, error: String(cause), stack: cause.stack }, null, 2));
    if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(outputDirectory, 'failure.png') }); await fs.writeFile(path.join(outputDirectory, 'failure.txt'), `${String(cause)}\n\n${await page.locator('body').innerText()}`); } }
    throw cause;
  } finally { await browser?.close(); await server.close(); }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStandaloneSeedanceCharacterBindingUiQa(), null, 2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
