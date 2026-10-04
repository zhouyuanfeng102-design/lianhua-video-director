import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Isolated component harness: no App, disk projects, real AI or video requests.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', 'h3-identity-binding');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser; let page;
const failures = []; const blockedRequests = []; const measurements = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1430, height: 870 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route((url) => /^https?:$/u.test(url.protocol) && (url.origin !== origin || url.pathname.startsWith('/unused-')), async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route('**/__h3_identity_fixture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>' }));
  await page.goto(`${origin}/__h3_identity_fixture.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { createInitialState } = await import('/src/storage.ts');
    await import('/src/styles.css');
    const e = React.createElement; const state = createInitialState(); const now = Date.now();
    const names = ['甲人物', '乙人物', '丙人物', '丁人物', '戊人物'];
    const characters = names.map((name, index) => ({ id: `person-${index + 1}`, name, gender: '', race: '人类', apparentAge: '成年人', appearance: '黑发', outfit: '外套', personality: '', signatureProps: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [`image-${index + 1}`] }));
    const assets = Array.from({ length: 6 }, (_, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext('2d'); context.fillStyle = `hsl(${index * 45} 25% 50%)`; context.fillRect(0, 0, 96, 64);
      return { id: `image-${index}`, name: index ? `${names[index - 1]}参考图` : '场景参考图', type: index ? 'character' : 'location', role: index ? 'character' : 'scene', sourceEntityId: index ? `person-${index}` : undefined, sourceEntityKind: index ? 'character' : undefined, dataUrl: canvas.toDataURL(), mediaType: 'image', mimeType: 'image/png', tags: [], createdAt: now, updatedAt: now };
    });
    const identity = (name, language) => `Identity: ${name}, ${language === 'en' ? 'adult with black hair and an ordinary coat' : '黑发成年人，穿普通外套'}。`;
    const bindings = (language, broken = false) => ({ version: 1, characters: characters.map((character) => ({ characterId: character.id, name: character.name, referenceAnchor: identity(character.name, language) + (broken ? '这是旧定位句。' : '') })) });
    const segments = Array.from({ length: 6 }, (_, index) => ({ id: `segment-${index + 1}`, index: index + 1, title: `隔离剧情第 ${index + 1} 段`, globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15, content: '五人沿走廊前进。', summary: '', sourceSceneIds: ['scene'], sourceBeatIds: [], narrativePurpose: '连续前进', entryState: '', exitState: '', transitionHint: '', storyboardId: `board-${index + 1}`, status: 'ready' }));
    const plan = { id: 'plan', title: '五人物六图绑定回归', sourceStoryTitle: '隔离剧情', sourceStoryContent: '五人沿走廊前进。', durationMode: 'ai-estimated', totalDurationSec: 90, segmentDurationSec: 15, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const makePrompt = (language, index) => `integrated_multimodal_description:\n[Shot 1] ${names.map((name) => identity(name, language)).join(' ')}\n${language === 'en' ? 'The five people walk through the corridor.' : '五人沿着走廊前进。'} Segment ${index}. ${'保持人物动作与空间关系。'.repeat(65)}\noverall_soundscape: 风声。\nnon_diegetic_music: N/A`;
    const boards = segments.map((segment) => {
      const zh = makePrompt('zh', segment.index); const en = makePrompt('en', segment.index); const references = segment.index === 1 ? assets.map((asset) => asset.id) : [];
      return { id: segment.storyboardId, sceneId: 'scene', sourceStoryTitle: segment.title, workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: references, finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh, officialPromptEn: en, officialPromptEnSource: zh, h3IdentityBindings: bindings('zh', true), h3IdentityBindingsEn: bindings('en', true), shots: [{ id: `shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, subject: names.join('、'), action: '前进', camera: '跟拍', lighting: '自然光', sound: '风声', referenceAssetIds: references, prompt: zh, locked: false }], sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 6, createdAt: now, updatedAt: now };
    });
    const project = { ...state.project, id: 'identity-qa', name: '合成绑定回归', characters, assets, storyboards: boards, sequencePlans: [plan], locations: [], props: [], generationTasks: [], scenes: [{ id: 'scene', title: '走廊', content: plan.sourceStoryContent, summary: '', characterIds: characters.map((character) => character.id), propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }] };
    const images = assets.map((asset, index) => ({ nodeId: String(index + 2), inputName: 'image', role: index ? 'character' : 'scene' }));
    const settings = { ...state.settings, videoBackend: 'api', videoSource: 'runninghub', textApi: { ...state.settings.textApi, enabled: false, apiKey: '' }, runningHubVideo: { enabled: true, baseUrl: `${location.origin}/unused-runninghub`, apiKey: '', activeWorkflowId: 'cloud', workflows: [{ id: 'cloud', name: '隔离六槽云端工作流', runKind: 'workflow', remoteId: '1234567890', requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: '' }, ...images.map((image) => ({ nodeId: image.nodeId, fieldName: image.inputName, fieldValue: '' }))] }), mapping: { prompt: [{ nodeId: '1', inputName: 'text' }], images }, createdAt: now, updatedAt: now }] } };
    const qa = window.__identityQa = { repairs: [], additions: [], submissions: 0, pending: undefined, bindings, initialBoards: structuredClone(boards) };
    const controller = { runtimes: {}, start: async () => { qa.submissions += 1; return 'never'; }, startBatch: async () => { qa.submissions += 1; return { taskIds: [], skipped: [] }; }, cancel: async () => {}, resume: async () => {}, retryDownload: async () => {} };
    function Harness() {
      const [current, setProject] = React.useState(project); qa.project = current;
      const repair = async (storyboardId, language, characterIds) => {
        qa.repairs.push({ storyboardId, language, characterIds });
        await new Promise((resolve) => { qa.pending = resolve; }); qa.pending = undefined;
        const addition = `Identity binding update ${qa.repairs.length}: ${names[0]} retains the existing appearance.\n`;
        qa.additions.push(addition);
        setProject((previous) => ({ ...previous, storyboards: previous.storyboards.map((board) => {
          if (board.id !== storyboardId) return board;
          const field = language === 'en' ? 'officialPromptEn' : 'officialPromptZh';
          const prompt = board[field].replace('overall_soundscape:', `${addition}overall_soundscape:`);
          return { ...board, [field]: prompt, [language === 'en' ? 'h3IdentityBindingsEn' : 'h3IdentityBindings']: bindings(language),
            ...(language === 'zh' && board.officialPromptEnSource === board.officialPromptZh
              ? { officialPromptEn: board.officialPromptEn.replace('overall_soundscape:', `${addition}overall_soundscape:`), officialPromptEnSource: prompt, h3IdentityBindingsEn: bindings('en') } : {}),
            updatedAt: board.updatedAt + 1 };
        }) }));
      };
      return e('main', { style: { height: '100dvh', padding: 12, boxSizing: 'border-box', '--ui-font-scale': 1.3 } }, e(VideoDirectorView, { project: current, settings, controller, launchRequest: { id: 'launch', storyboardId: 'board-1', language: 'zh' }, onRepairIdentityBindings: repair }));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  });
  const batch = page.locator('.vd-batch-preview');
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await page.getByRole('button', { name: '全选英文', exact: true }).click();
  assert.equal(await page.locator('.vd-batch-row').count(), 6);
  assert.equal(await batch.locator('.vd-h3-reference-issues li').count(), 5);
  assert.equal(await batch.locator('.vd-h3-reference-issues').getAttribute('open'), null);
  assert.match(await batch.locator('.vd-prompt-preview').innerText(), /The five people walk/u);
  const capture = async (name) => {
    const value = await batch.evaluate((element) => {
      const pane = element.querySelector('.vd-batch-preview-body').getBoundingClientRect();
      const heading = element.querySelector('.vd-batch-preview-head').getBoundingClientRect();
      const prompt = element.querySelector('.vd-prompt-preview').getBoundingClientRect();
      const information = element.querySelector('.vd-h3-reference-info');
      const warnings = element.querySelector('.vd-h3-reference-issues');
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, paneHeight: pane.height, visiblePrompt: Math.min(prompt.bottom, pane.bottom, innerHeight) - Math.max(prompt.top, pane.top), headingVisible: heading.top >= 0 && heading.bottom < innerHeight, infoColor: information ? getComputedStyle(information).color : '', warningColor: warnings ? getComputedStyle(warnings).color : '' };
    });
    assert.ok(value.paneHeight >= 90); assert.ok(value.visiblePrompt >= 45); assert.equal(value.headingVisible, true);
    assert.ok(value.documentWidth <= value.width + 1); assert.notEqual(value.infoColor, value.warningColor);
    measurements.push({ name, ...value }); await page.screenshot({ path: path.join(output, `${name}.png`) });
  };
  await capture('english-collapsed');
  await batch.locator('.vd-h3-reference-issues > summary').click();
  await capture('english-expanded');
  await batch.getByRole('button', { name: '修复人物图片绑定', exact: true }).click();
  await page.getByRole('button', { name: '正在修复人物图片绑定…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '检查并生成 6 段视频', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__identityQa.repairs[0]), { storyboardId: 'board-1', language: 'en', characterIds: ['person-1', 'person-2', 'person-3', 'person-4', 'person-5'] });
  await page.evaluate(() => window.__identityQa.pending());
  await batch.locator('.vd-h3-reference-issues').waitFor({ state: 'detached' });
  const repaired = await batch.locator('.vd-prompt-preview').innerText();
  assert.match(repaired, /Identity binding update 1:/u, 'batch preview reads the repaired source body as well as metadata');
  for (let index = 2; index <= 6; index += 1) assert.ok(repaired.includes(`<Picture ${index}>`));
  await page.locator('.vd-batch-row').nth(1).getByRole('button', { name: '预览', exact: true }).click();
  assert.equal(await batch.locator('.vd-h3-reference-issues').count(), 0, 'segments without selected images never flood per-character warnings');
  await page.locator('.vd-batch-row').first().getByRole('button', { name: '中文', exact: true }).click();
  await page.locator('.vd-batch-row').first().getByRole('button', { name: '预览', exact: true }).click();
  assert.equal(await batch.locator('.vd-h3-reference-issues li').count(), 5);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1120, height: 720 }]) {
    await page.setViewportSize(viewport); await capture(`chinese-${viewport.width}x${viewport.height}`);
  }
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  const single = page.locator('#vd-single-generation-panel');
  assert.equal(await single.locator('.vd-h3-reference-issues li').count(), 5);
  assert.match(await single.getByRole('button', { name: '修复人物图片绑定', exact: true }).getAttribute('title'), /同步已有的有效英文/u);
  await single.locator('summary').filter({ hasText: '可选参数覆盖（不填保持原值）' }).click();
  await single.getByLabel('本次额外参数 JSON', { exact: true }).fill('{"seed":"123456"}');
  await single.getByRole('button', { name: '修复人物图片绑定', exact: true }).click();
  await single.getByRole('button', { name: '正在修复人物图片绑定…', exact: true }).waitFor();
  await page.evaluate(() => window.__identityQa.pending());
  await single.locator('.vd-h3-reference-issues').waitFor({ state: 'detached' });
  const editor = single.getByLabel('本次生成使用的完整提示词', { exact: true });
  assert.match(await editor.inputValue(), /Visual identity reference for 甲人物: <Picture 2>/u);
  assert.match(await editor.inputValue(), /Identity binding update 2:/u, 'single draft refreshes the changed official body');
  assert.equal(await single.getByLabel('本次额外参数 JSON', { exact: true }).inputValue(), '{"seed":"123456"}');
  assert.equal(await single.locator('.vd-reference-row').count(), 6, 'repair retains the selected physical image slots');
  const manual = `${await editor.inputValue()}\n本次手动备注原样保留。`;
  await editor.fill(manual);
  await single.getByRole('button', { name: '修复人物图片绑定', exact: true }).click();
  await single.getByRole('button', { name: '正在修复人物图片绑定…', exact: true }).waitFor();
  await page.evaluate(() => window.__identityQa.pending());
  await single.getByRole('button', { name: '正在修复人物图片绑定…', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), manual, 'explicit repair never replaces this submission’s manually edited prompt');
  assert.equal(await page.evaluate(() => window.__identityQa.project.storyboards[0].officialPromptZh.includes('Identity binding update 3:')), true);
  assert.equal(await page.evaluate(() => window.__identityQa.submissions), 0);
  assert.equal(await page.evaluate(() => window.__identityQa.project.storyboards.every((board, index) => {
    const originalText = (text) => window.__identityQa.additions.reduce((value, addition) => value.replaceAll(addition, ''), text);
    return originalText(board.officialPromptZh) === window.__identityQa.initialBoards[index].officialPromptZh
      && originalText(board.officialPromptEn) === window.__identityQa.initialBoards[index].officialPromptEn;
  })), true, 'the synthetic repairs add identity records without replacing authored narration');
  assert.deepEqual(blockedRequests, []); assert.deepEqual(failures, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, syntheticOnly: true, characters: 5, references: 6, languages: ['zh', 'en'], repairs: await page.evaluate(() => window.__identityQa.repairs), measurements, blockedRequests, failures }, null, 2));
  console.log(`H3 identity binding UI QA passed: ${path.join(output, 'report.json')}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, failures, blockedRequests, measurements }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
