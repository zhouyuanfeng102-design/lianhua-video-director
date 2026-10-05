import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Fresh Chromium storage and neutral synthetic work only. The desktop bridge
// captures provider-shaped requests in memory; no real account, user project,
// upload, generation endpoint, filesystem persistence or media download is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.join(outputBase, `runninghub-resolution-${Date.now()}`);
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must stay below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('QA output cannot traverse links'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
const storageKey = 'lianhua_video_director_state_v22';
const errors = []; const blockedRequests = []; const stages = []; const screenshots = []; const layouts = [];
let browser; let page; let origin;
const capture = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file);
};
const savedState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const savedWorkflow = async (id = 'qa-mp-workflow') => (await savedState()).settings.runningHubVideo.workflows.find((workflow) => workflow.id === id);
const requestValue = (request, nodeId, fieldName) => JSON.parse(request.body).nodeInfoList.find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;
const expectedMpPixels = { '0.2': [608, 352], '0.3': [736, 416], '0.4': [864, 480], '0.5': [960, 544], '0.6': [1056, 608], '0.7': [1152, 640], '0.8': [1216, 672], '0.9': [1280, 736], '1.0': [1376, 768] };
async function assertMpPixelLabels(selector, valuePrefix = '') {
  for (const [mp, [width, height]] of Object.entries(expectedMpPixels)) {
    const label = await selector.locator(`option[value="${valuePrefix}${mp}"]`).innerText();
    assert.match(label, new RegExp(`${width}\\s*[×x]\\s*${height}`, 'u'), `${mp} MP must display its explicit 16:9 dimensions`);
  }
}

async function checkLayout(scope, label) {
  await scope.scrollIntoViewIfNeeded();
  const layout = await scope.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('select,input,button,textarea')].filter((control) => {
      const bounds = control.getBoundingClientRect(); const style = getComputedStyle(control);
      return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && !control.closest('[hidden]');
    }).map((control) => {
      const bounds = control.getBoundingClientRect();
      return { name: control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 50),
        horizontalFit: bounds.left >= -1 && bounds.right <= innerWidth + 1,
        top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scopeOverflow: element.scrollWidth > element.clientWidth + 1, scopeRight: rect.right, controls };
  });
  layouts.push({ label, ...layout });
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: page horizontal overflow`);
  assert.equal(layout.scopeOverflow, false, `${label}: form horizontal overflow`);
  assert.ok(layout.controls.every((control) => control.horizontalFit), `${label}: control outside viewport ${JSON.stringify(layout.controls)}`);
  await capture(label);
}

async function installFixture() {
  await page.addInitScript(({ origin }) => {
    const qa = window.__runningHubResolutionQa = { requests: [], posts: [], credentials: {}, checkpoints: {} };
    const json = (body) => ({ status: 200, body: JSON.stringify(body) });
    window.lianhuaDesktop = {
      videoRequest: async (request) => {
        if (!request.url.startsWith(`${origin}/__qa_runninghub__/`)) throw new Error(`QA rejected unexpected provider endpoint: ${request.url}`);
        const entry = { url: request.url, method: request.method, body: request.body };
        qa.requests.push(entry);
        if (request.url.includes('/openapi/v2/run/')) {
          qa.posts.push(entry);
          return json({ taskId: `90000000000000000${qa.posts.length}`, status: 'QUEUED', errorCode: '', results: null });
        }
        if (request.url.endsWith('/openapi/v2/query')) return json({ taskId: JSON.parse(request.body).taskId, status: 'QUEUED', errorCode: '', results: null });
        throw new Error('Only queued run/query fixture responses are supported');
      },
      cancelVideoRequest: async () => true,
      watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
      setVideoTaskCredential: async ({ taskId, apiKey }) => { qa.credentials[taskId] = apiKey; return { persisted: true }; },
      getVideoTaskCredential: async (taskId) => qa.credentials[taskId] ?? null,
      saveVideoTaskCheckpoint: async (task) => { qa.checkpoints[task.id] = structuredClone(task); return { persisted: true }; },
      getVideoTaskCheckpoint: async (taskId) => structuredClone(qa.checkpoints[taskId] || null),
      deleteVideoTaskCheckpoint: async (taskId) => { delete qa.checkpoints[taskId]; return { deleted: true }; },
      downloadGeneratedMedia: async () => { throw new Error('Queued-only QA must not download media'); },
      assetStatus: async () => ({ exists: true }), revealAsset: async () => true,
    };
  }, { origin });
  await page.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== origin, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route(`${origin}/__qa_runninghub__/**`, async (route) => {
    blockedRequests.push(route.request().url()); await route.abort('blockedbyclient');
  });
  await page.route(`${origin}/__resolution_fixture__.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated fixture boot</body></html>' }));
  await page.goto(`${origin}/__resolution_fixture__.html`);
  await page.evaluate(async ({ key, origin }) => {
    const { createInitialState } = await import('/src/storage.ts');
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    const state = createInitialState(); const now = Date.now();
    const makeWorkflow = (id, name, remoteId, fieldName, fieldValue, bound) => ({
      id, name, runKind: 'workflow', remoteId, createdAt: now, updatedAt: now,
      requestTemplate: JSON.stringify({ nodeInfoList: [
        { nodeId: '263', fieldName: 'text', fieldValue: '工作人员整理桌面。' },
        { nodeId: '259', fieldName: 'value', fieldValue: 15 },
        ...(bound ? [{ nodeId: '310', fieldName, fieldValue }] : []),
      ], instanceType: 'default', usePersonalQueue: false, addMetadata: true }),
      nodeCatalog: [
        { nodeId: '263', fieldName: 'text', fieldValue: '工作人员整理桌面。', description: '视频提示词' },
        { nodeId: '259', fieldName: 'value', fieldValue: 15, description: '视频时长' },
        { nodeId: bound ? '310' : '252', fieldName, fieldValue, description: '分辨率选择器' },
        ...(!bound ? [
          { nodeId: '252', fieldName: 'aspect_ratio', fieldValue: '16:9 (Widescreen)', description: '分辨率选择器' },
          { nodeId: '252', fieldName: 'multiple', fieldValue: 32, description: '分辨率选择器' },
        ] : []),
      ],
      mapping: { prompt: [{ nodeId: '263', inputName: 'text' }], images: [], parameters: {
        duration: { nodeId: '259', inputName: 'value' }, ...(bound ? { resolution: { nodeId: '310', inputName: fieldName } } : {}),
      } },
    });
    const mp = makeWorkflow('qa-mp-workflow', '隔离 MP 工作流', '9000000000000000001', 'megapixels', 0.5, false);
    const standard = makeWorkflow('qa-standard-workflow', '隔离 720P 工作流', '9000000000000000002', 'resolution', '720P', true);
    const legacyMp = structuredClone(mp);
    Object.assign(legacyMp, { id: 'qa-legacy-mp-workflow', name: '旧宽度映射 MP 工作流', remoteId: '9000000000000000003' });
    legacyMp.mapping.parameters.width = { nodeId: '252', inputName: 'megapixels' };
    legacyMp.mapping.parameters.aspect_ratio = { nodeId: '252', inputName: 'aspect_ratio' };
    const legacyRequest = JSON.parse(legacyMp.requestTemplate);
    legacyRequest.nodeInfoList.push({ nodeId: '252', fieldName: 'megapixels', fieldValue: 0.5 });
    legacyRequest.nodeInfoList.push({ nodeId: '252', fieldName: 'aspect_ratio', fieldValue: '16:9 (Widescreen)' });
    legacyMp.requestTemplate = JSON.stringify(legacyRequest);
    legacyMp.fieldControls = { [JSON.stringify(['252', 'megapixels'])]: { kind: 'select', unit: 'MP', options: ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'], min: 0.2, max: 1, step: 0.1,
      optionLabelAspectRatio: '16:9', optionLabels: { '0.2': '608 × 352', '0.3': '736 × 416', '0.4': '864 × 480', '0.5': '960 × 544', '0.6': '1056 × 608', '0.7': '1152 × 640', '0.8': '1216 × 672', '0.9': '1280 × 736', '1.0': '1376 × 768' } } };
    const dimensions = makeWorkflow('qa-dimensions-workflow', '真实宽高工作流', '9000000000000000004', 'width', 960, true);
    delete dimensions.mapping.parameters.resolution;
    dimensions.mapping.parameters.width = { nodeId: '310', inputName: 'width' };
    dimensions.mapping.parameters.height = { nodeId: '310', inputName: 'height' };
    dimensions.nodeCatalog.push({ nodeId: '310', fieldName: 'height', fieldValue: 544, description: '输出高度' });
    const dimensionRequest = JSON.parse(dimensions.requestTemplate);
    dimensionRequest.nodeInfoList.push({ nodeId: '310', fieldName: 'height', fieldValue: 544 });
    dimensions.requestTemplate = JSON.stringify(dimensionRequest);
    state.settings.runningHubVideo = { enabled: true, apiKey: 'QA_NO_REAL_CREDENTIAL', baseUrl: `${origin}/__qa_runninghub__`, activeWorkflowId: mp.id, workflows: [mp, standard, legacyMp, dimensions] };
    state.settings.videoSource = 'runninghub'; state.settings.videoBackend = 'api';
    state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 4;
    state.settings.videoApiProfiles = []; state.settings.activeVideoApiProfileId = null;
    state.settings.uiFontScalePercent = 100;
    const segments = [1, 2].map((index) => ({
      id: `qa-resolution-segment-${index}`, index, title: `整理桌面 ${index}`, content: `工作人员整理第${index}张桌面。`, summary: '整理桌面',
      globalStartSec: (index - 1) * 15, globalEndSec: index * 15, durationSec: 15,
      sourceSceneIds: ['qa-resolution-scene'], sourceBeatIds: [`qa-resolution-beat-${index}`],
      narrativePurpose: '完成整理', entryState: '桌面待整理', exitState: '桌面整洁', transitionHint: '自然接续',
      storyboardId: `qa-resolution-board-${index}`, status: 'ready',
    }));
    const plan = { id: 'qa-resolution-plan', title: '整理桌面隔离计划', sourceStoryTitle: '整理桌面隔离计划', sourceStoryContent: '工作人员依次整理两张桌面。',
      durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 15, segmentationMode: 'natural', segmentationSource: 'ai', fitStatus: 'balanced', planningStage: 'segmented', segments, createdAt: now, updatedAt: now };
    const boards = segments.map((segment) => {
      const zh = `【0s-15s】主体：工作人员；动作：整理第${segment.index}张桌面；镜头：固定中景；光线：自然光；声音：环境声。`;
      return { id: segment.storyboardId, sceneId: 'qa-resolution-scene', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1,
        pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId,
        converterPresetId: 'generic-video', targetModelId: 'custom', globalLock: '', globalReferenceAssetIds: [], finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh,
        promptMigrationPending: false, promptTrace: { modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'generic-video', stylePresetId: state.settings.defaultStylePresetId,
          sourceDocumentIds: [], referenceAssetIds: [], generatedAt: now, mode: 'text-api', convertedPromptFingerprint: sourceContentHash(zh), shotPlanMode: 'ai-complete' },
        shots: [{ id: `qa-resolution-shot-${segment.index}`, index: 1, startSec: 0, endSec: 15, subject: '工作人员', action: '整理桌面', purpose: '完成整理', camera: '固定中景', lighting: '自然光', sound: '环境声', transition: '自然接续', result: '桌面整洁', referenceAssetIds: [], prompt: zh, locked: false }],
        sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 2, createdAt: now, updatedAt: now };
    });
    const historicalTask = { id: 'qa-resolution-history', kind: 'video', status: 'succeeded', targetId: 'qa-old-workflow', createdAt: now - 1000, updatedAt: now - 1000,
      requestBody: { nodeInfoList: [{ nodeId: '252', fieldName: 'megapixels', fieldValue: 0.98 }] },
      videoJob: { stage: 'succeeded', completedAt: now - 1000, snapshot: { projectId: 'qa-resolution-project', clientId: 'qa-historical-client',
        draft: { name: '历史 MP 任务', backend: 'api', runningHubWorkflowId: mp.id, prompt: '工作人员整理桌面。', references: [], parameters: { resolution: 0.98 } },
        connection: { backend: 'api', api: { provider: 'runninghub', enabled: true, model: '历史工作流', endpoint: `${origin}/__qa_runninghub__/openapi/v2/run/workflow/9000000000000000001`, requestTemplate: mp.requestTemplate } }, images: [] } } };
    const project = { ...state.project, id: 'qa-resolution-project', name: '分辨率离线验证', sourceDocuments: [], characters: [], locations: [], props: [], assets: [],
      scenes: [{ id: 'qa-resolution-scene', title: '办公室', content: plan.sourceStoryContent, summary: '整理桌面', characterIds: [], propIds: [], storyboardIds: boards.map((board) => board.id), createdAt: now, updatedAt: now }],
      storyboards: boards, sequencePlans: [plan], generationTasks: [historicalTask], updatedAt: now };
    state.project = project; state.projects = [project]; state.activeProjectId = project.id;
    localStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, origin });
  await page.goto(origin, { waitUntil: 'networkidle' });
}

async function openManager() {
  await page.locator('.sidebar').getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('tab', { name: '视频生成', exact: true }).click();
  await page.getByRole('tab', { name: 'RunningHub 云端', exact: true }).click();
  await page.getByRole('button', { name: '管理云端工作流', exact: true }).click();
  await page.getByRole('dialog', { name: 'RunningHub 云端视频工作流管理', exact: true }).waitFor();
  await page.getByRole('tab', { name: '时长、比例与分辨率', exact: true }).click();
}

async function selectResolution(prefix, label) {
  const selector = page.getByLabel(`${prefix}视频分辨率选项`, { exact: true });
  const options = await selector.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.textContent })));
  const option = options.find((entry) => entry.label === label || entry.value === label);
  assert.ok(option, `${prefix}: missing resolution option ${label}; actual ${JSON.stringify(options)}`);
  await selector.selectOption(option.value);
}

async function editManagerWorkflow(name) {
  await page.getByRole('button', { name: `编辑云端工作流 ${name}`, exact: true }).click();
  await page.getByRole('tab', { name: '时长、比例与分辨率', exact: true }).click();
  await page.getByRole('tab', { name: '时长、比例与像素 / 分辨率', exact: true }).click();
}

async function assertMpOnlyFields(prefix) {
  assert.equal(await page.getByLabel(`${prefix}视频宽度（像素）`, { exact: true }).count(), 0, 'MP is not presented as pixel width');
  assert.equal(await page.getByLabel(`${prefix}视频高度（像素）`, { exact: true }).count(), 0, 'MP does not expose an unrelated height field');
  assert.equal(await page.getByLabel(`${prefix}视频分辨率选项`, { exact: true }).count(), 1, 'MP has one scalar option selector');
  await assertMpPixelLabels(page.getByLabel(`${prefix}视频分辨率选项`, { exact: true }), 'value:');
}

try {
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await installFixture();
  const historicalTask = (await savedState()).project.generationTasks.find((task) => task.id === 'qa-resolution-history');
  assert.equal(historicalTask?.videoJob?.snapshot?.draft.parameters.resolution, 0.98, 'legacy non-preset task survives fixture loading');
  const initialHistory = JSON.stringify(historicalTask);
  await openManager();
  assert.equal(await page.getByLabel('时长分辨率字段范围', { exact: true }).inputValue(), 'common');
  const binding = page.getByLabel('RunningHub 分辨率节点字段', { exact: true });
  assert.ok((await binding.locator('option').allTextContents()).some((text) => text.includes('252.megapixels')), 'catalog-only megapixels is suggested without switching to advanced');
  assert.equal((await savedWorkflow()).mapping.parameters.resolution, undefined, 'suggestion alone must not bind');
  await binding.selectOption(JSON.stringify(['252', 'megapixels']));
  assert.equal(await page.getByLabel('RunningHub 分辨率默认值', { exact: true }).inputValue(), '0.5');
  await page.getByText('输入选项设置', { exact: true }).click();
  await page.getByRole('button', { name: /0\.2.*1\.0.*MP/u }).click();
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).settings.runningHubVideo.workflows.find((workflow) => workflow.id === 'qa-mp-workflow').mapping.parameters.resolution?.inputName === 'megapixels', storageKey);
  const saved = await savedWorkflow();
  assert.equal(JSON.parse(saved.requestTemplate).nodeInfoList.find((node) => node.nodeId === '252').fieldValue, 0.5, 'presets must not alter the numeric cloud default');
  assert.deepEqual(saved.fieldControls[JSON.stringify(['252', 'megapixels'])].options, ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0']);
  assert.equal(saved.fieldControls[JSON.stringify(['252', 'megapixels'])].step, 0.1);
  await assertMpPixelLabels(page.getByLabel('RunningHub 分辨率默认值', { exact: true }));
  assert.equal(await page.getByLabel('RunningHub 分辨率输入方式', { exact: true }).isDisabled(), true, 'installed MP preset must not allow switching back to arbitrary numeric input');
  for (const label of ['可选值', '最小值', '最大值', '步长']) {
    assert.equal(await page.getByLabel(`RunningHub 分辨率${label}`, { exact: true }).evaluate((element) => element.readOnly), true, `installed MP preset keeps ${label} read-only`);
  }
  const metadataIdentity = await page.evaluate(async (key) => {
    const { compileRunningHubVideoApi } = await import('/src/runningHubVideo.ts');
    const { videoBatchRequestFingerprint } = await import('/src/videoBatch.ts');
    const config = JSON.parse(localStorage.getItem(key)).settings.runningHubVideo;
    const plain = structuredClone(config); delete plain.workflows.find((workflow) => workflow.id === 'qa-mp-workflow').fieldControls;
    const withControls = compileRunningHubVideoApi(config, 'qa-mp-workflow', { resolution: 0.5 });
    const withoutControls = compileRunningHubVideoApi(plain, 'qa-mp-workflow', { resolution: 0.5 });
    const vertical = structuredClone(config);
    vertical.workflows.find((workflow) => workflow.id === 'qa-mp-workflow').nodeCatalog.find((node) => node.nodeId === '252' && node.fieldName === 'aspect_ratio').fieldValue = '9:16 (Portrait)';
    const verticalApi = compileRunningHubVideoApi(vertical, 'qa-mp-workflow', { resolution: 0.5 });
    const strip = ({ runningHubParameterControls: _controls, ...rest }) => rest;
    const draft = { name: '元数据身份验证', backend: 'api', runningHubWorkflowId: 'qa-mp-workflow', prompt: '工作人员整理桌面。', references: [], parameters: { resolution: 0.5 } };
    return {
      compiledTransportEqual: JSON.stringify(strip(withControls)) === JSON.stringify(strip(withoutControls)),
      batchFingerprintEqual: videoBatchRequestFingerprint(draft, [], { backend: 'api', api: withControls }) === videoBatchRequestFingerprint(draft, [], { backend: 'api', api: withoutControls }),
      requestContainsControlMetadata: /fieldControls|runningHubParameterControls|optionLabels/.test(withControls.requestTemplate),
      otherAspectRatioHidesPixelLabels: !verticalApi.runningHubParameterControls?.resolution?.optionLabels,
    };
  }, storageKey);
  assert.deepEqual(metadataIdentity, { compiledTransportEqual: true, batchFingerprintEqual: true, requestContainsControlMetadata: false, otherAspectRatioHidesPixelLabels: true });
  stages.push('catalog-only-megapixels-visible-explicit-binding-and-preset-save');
  await page.setViewportSize({ width: 1120, height: 720 });
  await checkLayout(page.locator('.rhv-output-fields'), 'manager-mp-1120x720');
  const legacyBeforeEdit = await savedWorkflow('qa-legacy-mp-workflow');
  assert.deepEqual(legacyBeforeEdit.mapping.parameters.width, { nodeId: '252', inputName: 'megapixels' });
  assert.equal(legacyBeforeEdit.mapping.parameters.resolution, undefined);
  await editManagerWorkflow('旧宽度映射 MP 工作流');
  assert.equal(JSON.stringify(await savedWorkflow('qa-legacy-mp-workflow')), JSON.stringify(legacyBeforeEdit), 'opening old width-to-MP configuration must not silently save changes');
  assert.equal(await page.getByLabel('RunningHub 分辨率节点字段', { exact: true }).inputValue(), JSON.stringify(['252', 'megapixels']));
  assert.equal(await page.getByLabel('RunningHub 像素高度节点字段', { exact: true }).count(), 0, 'MP main panel does not expose height');
  assert.equal(await page.getByLabel('RunningHub 像素宽度节点字段', { exact: true }).count(), 0, 'MP main panel does not expose width');
  assert.ok((await page.locator('.rhv-output-fields').innerText()).includes('像素（MP）'));
  await assertMpPixelLabels(page.getByLabel('RunningHub 分辨率默认值', { exact: true }));
  await page.getByRole('button', { name: '保存工作流', exact: true }).click();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).settings.runningHubVideo.workflows.find((workflow) => workflow.id === 'qa-legacy-mp-workflow').mapping.parameters.resolution?.inputName === 'megapixels', storageKey);
  const legacyAfterSave = await savedWorkflow('qa-legacy-mp-workflow');
  assert.equal(legacyAfterSave.mapping.parameters.width, undefined);
  assert.deepEqual(legacyAfterSave.mapping.parameters.resolution, { nodeId: '252', inputName: 'megapixels' });
  assert.deepEqual(JSON.parse(legacyAfterSave.requestTemplate), JSON.parse(legacyBeforeEdit.requestTemplate), 'saving corrected MP binding preserves request node values');
  await checkLayout(page.locator('.rhv-output-fields'), 'manager-legacy-width-as-mp-1120x720');
  stages.push('legacy-width-megapixels-is-one-MP-control-and-explicit-save-corrects-binding');
  await editManagerWorkflow('真实宽高工作流');
  await page.getByRole('tab', { name: '高级：指定宽高', exact: true }).click();
  assert.equal(await page.getByLabel('RunningHub 像素宽度节点字段', { exact: true }).inputValue(), JSON.stringify(['310', 'width']));
  assert.equal(await page.getByLabel('RunningHub 像素高度节点字段', { exact: true }).inputValue(), JSON.stringify(['310', 'height']));
  await checkLayout(page.locator('.rhv-output-fields'), 'manager-real-dimensions-1120x720');
  await page.getByRole('button', { name: '关闭 RunningHub 工作流管理', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  await page.getByRole('button', { name: 'RunningHub 云端', exact: true }).click();
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-legacy-mp-workflow');
  await page.getByLabel('本次生成使用的完整提示词', { exact: true }).fill('工作人员将资料按日期整齐放在桌上，固定中景，自然光。');
  await selectResolution('本次', 'value:0.2');
  await selectResolution('本次', 'value:0.5');
  await assertMpPixelLabels(page.getByLabel('本次视频分辨率选项', { exact: true }), 'value:');
  await assertMpOnlyFields('本次');
  await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
  const singleParameterJson = page.getByLabel('本次额外参数 JSON', { exact: true });
  await singleParameterJson.fill(JSON.stringify({ resolution: 0.5, aspect_ratio: '9:16 (Portrait)' }));
  assert.doesNotMatch(await page.getByLabel('本次视频分辨率选项', { exact: true }).innerText(), /960\s*×\s*544/u, 'vertical override must hide 16:9 labels immediately');
  await singleParameterJson.fill(JSON.stringify({ resolution: 0.5, aspect_ratio: '16:9 (Widescreen)' }));
  await assertMpPixelLabels(page.getByLabel('本次视频分辨率选项', { exact: true }), 'value:');
  await singleParameterJson.fill(JSON.stringify({ resolution: 0.5 }));
  await page.getByText('可选参数覆盖（不填保持原值）', { exact: true }).click();
  stages.push('single-aspect-ratio-override-hides-and-restores-pixel-labels');
  assert.equal(await page.getByLabel('本次视频分辨率', { exact: true }).count(), 0, 'strict MP preset has no arbitrary custom input');
  assert.equal(await page.getByLabel('本次视频分辨率选项', { exact: true }).locator('option[value="value:0.98"]').count(), 0);
    await checkLayout(page.getByLabel('本次时长、比例与分辨率', { exact: true }), 'single-mp-1120x720');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__runningHubResolutionQa.posts.length >= 1);
  const firstRequest = await page.evaluate(() => window.__runningHubResolutionQa.posts[0]);
  assert.equal(requestValue(firstRequest, '252', 'megapixels'), 0.5);
  stages.push('single-selection-delivers-numeric-0.5-and-only-tenth-step-options');
  await selectResolution('本次', 'value:1.0');
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-standard-workflow');
  assert.equal(await page.getByLabel('本次视频分辨率', { exact: true }).inputValue(), '', 'MP override must not leak into 720P workflow');
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-legacy-mp-workflow');
  assert.match(await page.getByLabel('本次视频分辨率选项', { exact: true }).locator('option:checked').innerText(), /1\.0\s*MP/u);
  await selectResolution('本次', '__default__');
  stages.push('single-default-and-workflow-isolation-without-arbitrary-MP-values');
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开批量设置', exact: true });
  if (await expand.count()) await expand.click();
  await page.getByLabel('批量生成方式', { exact: true }).selectOption('runninghub');
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('qa-legacy-mp-workflow');
  await selectResolution('批量', 'value:0.2');
  await selectResolution('批量', 'value:0.5');
  await selectResolution('批量', 'value:1.0');
  await assertMpPixelLabels(page.getByLabel('批量视频分辨率选项', { exact: true }), 'value:');
  await assertMpOnlyFields('批量');
  await page.getByText('高级公共参数 JSON · 不填写则保持接口 / 工作流原值', { exact: true }).click();
  const batchParameterJson = page.getByLabel('批量公共参数 JSON', { exact: true });
  await batchParameterJson.fill(JSON.stringify({ resolution: 1.0, aspect_ratio: '9:16 (Portrait)' }));
  assert.doesNotMatch(await page.getByLabel('批量视频分辨率选项', { exact: true }).innerText(), /1376\s*×\s*768/u, 'batch vertical override must hide 16:9 labels immediately');
  await batchParameterJson.fill(JSON.stringify({ resolution: 1.0, aspect_ratio: '16:9 (Widescreen)' }));
  await assertMpPixelLabels(page.getByLabel('批量视频分辨率选项', { exact: true }), 'value:');
  await batchParameterJson.fill(JSON.stringify({ resolution: 1.0 }));
  await page.getByText('高级公共参数 JSON · 不填写则保持接口 / 工作流原值', { exact: true }).click();
  stages.push('batch-aspect-ratio-override-hides-and-restores-pixel-labels');
  assert.equal(await page.getByLabel('批量视频分辨率', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('批量视频分辨率选项', { exact: true }).locator('option[value="value:0.98"]').count(), 0);
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('qa-standard-workflow');
  assert.equal(await page.getByLabel('批量视频分辨率', { exact: true }).inputValue(), '', 'batch MP must not leak into 720P workflow');
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('qa-dimensions-workflow');
  await page.getByLabel('批量时长、比例与分辨率', { exact: true }).getByText('高级：指定宽高', { exact: true }).click();
  await page.getByLabel('批量视频宽度（像素）', { exact: true }).fill('800');
  await page.getByLabel('批量视频高度（像素）', { exact: true }).fill('448');
  await checkLayout(page.getByLabel('批量时长、比例与分辨率', { exact: true }), 'batch-real-dimensions-1120x720');
  await page.getByLabel('批量 RunningHub 云端工作流', { exact: true }).selectOption('qa-legacy-mp-workflow');
  await assertMpOnlyFields('批量');
  assert.match(await page.getByLabel('批量视频分辨率选项', { exact: true }).locator('option:checked').innerText(), /1\.0\s*MP/u);
  await selectResolution('批量', '__default__');
  await selectResolution('批量', 'value:1.0');
  const mpRowSummaries = await page.locator('.vd-batch-row-main .vop-request-summary').allTextContents();
  assert.equal(mpRowSummaries.length, 2);
  assert.ok(mpRowSummaries.every((summary) => /请求像素\s*1(?:\.0)?\s*MP/u.test(summary)), 'batch row summaries retain MP unit instead of generic resolution wording');
  await checkLayout(page.getByLabel('批量时长、比例与分辨率', { exact: true }), 'batch-mp-1120x720');
  await page.getByRole('button', { name: '全选中文', exact: true }).click();
  await page.getByRole('button', { name: '检查并生成 2 段视频', exact: true }).click();
  await page.getByRole('checkbox', { name: '确认批量生成费用', exact: true }).check();
  await page.locator('.vd-batch-confirm-dialog .vd-modal-footer button').click();
  await page.waitForFunction(() => window.__runningHubResolutionQa.posts.length >= 3);
  const mpRequests = await page.evaluate(() => window.__runningHubResolutionQa.posts);
  assert.ok(mpRequests.slice(1).every((request) => requestValue(request, '252', 'megapixels') === 1), 'batch submits each row with numeric 1 MP');
  assert.equal(JSON.stringify((await savedState()).project.generationTasks.find((task) => task.id === 'qa-resolution-history')), initialHistory, 'existing task snapshot stays byte-identical');
  assert.equal(JSON.parse((await savedWorkflow()).requestTemplate).nodeInfoList.find((node) => node.nodeId === '252').fieldValue, 0.5, 'task overrides do not change workflow defaults');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  stages.push('batch-numeric-1.0-requests-and-frozen-history-preserved');
  await page.locator('.sidebar').getByRole('button', { name: '视频导演台', exact: true }).click();
  await page.getByRole('tab', { name: '单段生成', exact: true }).click();
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-dimensions-workflow');
  await page.getByLabel('本次时长、比例与分辨率', { exact: true }).getByText('高级：指定宽高', { exact: true }).click();
  await page.getByLabel('本次视频宽度（像素）', { exact: true }).fill('800');
  await page.getByLabel('本次视频高度（像素）', { exact: true }).fill('448');
  await checkLayout(page.getByLabel('本次时长、比例与分辨率', { exact: true }), 'single-real-dimensions-1120x720');
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-legacy-mp-workflow');
  await assertMpOnlyFields('本次');
  await page.getByLabel('RunningHub 云端工作流', { exact: true }).selectOption('qa-dimensions-workflow');
  const widthDetails = page.getByLabel('本次时长、比例与分辨率', { exact: true }).locator('details').filter({ hasText: '高级：指定宽高' });
  if (await widthDetails.getAttribute('open') === null) await widthDetails.locator('summary').click();
  assert.equal(await page.getByLabel('本次视频宽度（像素）', { exact: true }).inputValue(), '800');
  assert.equal(await page.getByLabel('本次视频高度（像素）', { exact: true }).inputValue(), '448');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__runningHubResolutionQa.posts.length >= 4);
  const requests = await page.evaluate(() => window.__runningHubResolutionQa.posts);
  assert.equal(requestValue(requests[3], '310', 'width'), 800);
  assert.equal(requestValue(requests[3], '310', 'height'), 448);
  assert.equal(requestValue(requests[3], '252', 'megapixels'), undefined);
  assert.equal(JSON.stringify((await savedState()).project.generationTasks.find((task) => task.id === 'qa-resolution-history')), initialHistory);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  stages.push('real-width-height-single-and-batch-controls-remain-isolated-and-submit-numeric-dimensions');
  const report = { stages, metadataIdentity, layouts, screenshots, errors, blockedRequests, requests: requests.map((request) => ({ url: request.url, megapixels: requestValue(request, '252', 'megapixels'), width: requestValue(request, '310', 'width'), height: requestValue(request, '310', 'height') })) };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) {
  if (page) { await capture('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, stages, errors, blockedRequests, screenshots, layouts }, null, 2)); }
  throw error;
} finally { await browser?.close(); await server.close(); }
