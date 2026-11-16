import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { installSeedanceCharacterBindingFixture } from './videoSeedanceCharacterBindingUiQa.mjs';

// Isolated real-component check. All tasks terminate at the mock controller;
// this script never reads saved user data or contacts ComfyUI/model endpoints.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.tmp', 'comfy-workflow-selection-ui');
await fs.mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, plugins: [react()],
  // Only the component fixture is mounted. Avoid crawling the complete App
  // dependency tree from the production index before the fixture can load.
  optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const checks = [];
const errors = [];
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  const { blockedRequests } = await installSeedanceCharacterBindingFixture(page, origin);
  await page.evaluate(async () => {
    const fixture = window.__seedanceCharacterBindingQa;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { VideoDirectorView } = await import('/src/components/VideoDirectorView.tsx');
    const { videoParameterConnectionKey } = await import('/src/videoGenerationSource.ts');
    const { videoPromptChoiceKey } = await import('/src/videoBatch.ts');
    const base = structuredClone(fixture.project);
    base.assets = [];
    base.characters = [];
    base.generationTasks = [];
    base.name = '隔离 ComfyUI 选择状态';
    base.activeChapterId = 'comfy-selection-chapter';
    base.sourceDocuments = [{ id: base.activeChapterId, name: '合成章节', content: '一位成年人缓慢走过庭院。', createdAt: 1, updatedAt: 1 }];
    base.storyboards[0] = { ...base.storyboards[0], chapterId: base.activeChapterId, globalReferenceAssetIds: [],
      finalPrompt: '一位成年人缓慢走过庭院，镜头小幅度慢速跟随。', seedance25Output: undefined };
    base.sequencePlans[0].chapterId = base.activeChapterId;
    const makeWorkflow = (id, name, slots) => ({
      id, name, createdAt: 1, updatedAt: 1,
      workflowJson: JSON.stringify({
        1: { class_type: 'CLIPTextEncode', inputs: { text: '原提示词' } },
        ...Object.fromEntries(Array.from({ length: slots }, (_, index) => [10 + index, {
          class_type: 'LoadImage', inputs: { image: `synthetic-${index}.png` },
        }])),
        20: { class_type: 'VHS_VideoCombine', inputs: { images: ['10', 0], positive: ['1', 0], seed: 0, format: 'video/h264-mp4' } },
      }),
      mapping: { prompt: [{ nodeId: '1', inputName: 'text' }],
        images: Array.from({ length: slots }, (_, index) => ({ nodeId: String(10 + index), inputName: 'image' })),
        parameters: { seed: { nodeId: '20', inputName: 'seed' } }, outputNodeId: '20' },
    });
    const current = makeWorkflow('workflow-current', '合成当前工作流', 6);
    const other = makeWorkflow('workflow-other', '合成自选工作流', 2);
    const frozen = makeWorkflow('workflow-archived', '原任务冻结工作流', 3);
    const qa = window.__comfyWorkflowSelectionQa = { persisted: [], custom: undefined, calls: [], mountCount: 0, current, other, frozen };
    qa.mount = (spec = {}) => {
      const project = structuredClone(base);
      project.id = `comfy-selection-${++qa.mountCount}`;
      const plan = project.sequencePlans[0], board = project.storyboards[0], segment = plan.segments[0];
      const workflowId = spec.workflowId === undefined ? 'workflow-deleted' : spec.workflowId;
      const draft = { name: '合成视频', prompt: board.finalPrompt, backend: 'comfyui', workflowId,
        source: { chapterId: project.activeChapterId, storyboardId: board.id, sequencePlanId: plan.id,
          segmentId: segment.id, segmentIndex: 1, promptFormat: 'ordinary', language: 'zh' },
        references: [], parameters: { seed: 11 } };
      const oldKey = videoParameterConnectionKey(draft);
      const newKey = videoParameterConnectionKey({ ...draft, workflowId: current.id });
      const parameters = [[newKey, '{"seed":22}']];
      const batch = { planId: plan.id, backend: 'comfyui', workflowId, apiProfileId: '',
        parameterText: '{"seed":11}', parameterDrafts: parameters,
        selectedKeys: [videoPromptChoiceKey(board.id, 'zh', 'ordinary')], languages: {}, promptFormat: 'ordinary',
        promptFormats: {}, referenceOverrides: {}, referenceRoleOverrides: {}, automaticTails: {}, tailCharacterModes: {},
        previewSegmentId: segment.id, previewPane: 'prompt', settingsCollapsed: false, query: '' };
      const chapterDraft = { draft, parameterText: '{"seed":11}', parameterDrafts: parameters,
        generationMode: spec.mode === 'single' ? 'single' : 'batch', batch };
      const settings = { ...fixture.settings, videoBackend: 'comfyui', videoSource: 'comfyui',
        comfyuiVideo: { enabled: true, baseUrl: `${location.origin}/unused-comfy`, apiKey: '',
          workflows: [current, other], activeWorkflowId: spec.noCurrent ? null : current.id } };
      let launchRequest;
      if (spec.frozen) {
        const saved = { ...draft, workflowId: spec.emptyFrozenId ? '' : frozen.id, parameters: { seed: 37 } };
        const task = { id: 'frozen-video-task', kind: 'video', status: 'failed', targetId: frozen.name,
          storyboardId: board.id, sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: 1,
          requestBody: { prompt: saved.prompt }, createdAt: 1, updatedAt: 2, videoJob: { stage: 'failed',
            snapshot: { projectId: project.id, clientId: 'fixture-client', draft: saved, images: [],
              connection: { backend: 'comfyui', workflow: frozen,
                comfyui: { enabled: true, baseUrl: `${location.origin}/unused-frozen`, activeWorkflowId: frozen.id } } } } };
        project.generationTasks = [task];
        launchRequest = { id: `frozen-launch-${qa.mountCount}`, batchTaskIds: [task.id] };
      }
      qa.persisted = []; qa.calls = []; qa.oldKey = oldKey; qa.newKey = newKey; qa.custom = undefined;
      const controller = { ...fixture.controller, start: async (value) => { qa.calls.push(structuredClone(value)); return 'mock-video'; },
        startBatch: async (input) => { qa.calls.push(structuredClone(input)); return { taskIds: [], skipped: [] }; } };
      function Harness() {
        const [custom, setCustom] = React.useState({ active: spec.mode === 'custom', version: 1,
          draft: { ...draft, source: undefined, origin: 'custom', promptMode: 'raw' },
          parameterText: '{"seed":11}', parameterDrafts: [] });
        return React.createElement('main', { 'data-comfy-selection-case': project.id },
          React.createElement(VideoDirectorView, { key: project.id, project, chapterId: project.activeChapterId,
          chapterDraft, settings, controller, launchRequest, customVideoDraft: custom,
          onChapterDraftChange: (_projectId, _chapterId, next) => qa.persisted.push(structuredClone(next)),
          onCustomVideoDraftChange: (next) => { qa.custom = structuredClone(next); setCustom(next); },
          onImportCustomVideoImages: async () => [] }));
      }
      fixture.root.render(React.createElement(Harness, { key: project.id }));
      return project.id;
    };
  });

  const mount = async (spec) => {
    const id = await page.evaluate((value) => window.__comfyWorkflowSelectionQa.mount(value), spec);
    await page.locator(`[data-comfy-selection-case="${id}"] .video-director-view`).waitFor();
  };
  const batchSelect = page.getByLabel('批量视频工作流', { exact: true });
  const footer = page.locator('.vd-batch-footer');
  const row = page.locator('[data-segment-id="scb-segment-1"]');
  await mount({});
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.persisted.at(-1)?.batch?.workflowId === 'workflow-current');
  assert.equal(await batchSelect.inputValue(), 'workflow-current');
  assert.match(await footer.innerText(), /ComfyUI · 合成当前工作流/u);
  assert.match(await row.innerText(), /参考图 0 张 \/ 6 个槽/u);
  const restored = await page.evaluate(() => {
    const qa = window.__comfyWorkflowSelectionQa;
    const batch = qa.persisted.at(-1).batch;
    return { workflowId: batch.workflowId, text: batch.parameterText, drafts: batch.parameterDrafts, oldKey: qa.oldKey };
  });
  assert.equal(restored.text, '{"seed":22}', 'restoring a connection uses its saved parameter draft');
  assert.equal(new Map(restored.drafts).get(restored.oldKey), '{"seed":11}', 'the deleted connection parameter draft is retained');
  await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认批量生成视频', exact: true });
  await dialog.waitFor();
  await dialog.getByLabel('确认批量生成费用', { exact: true }).check();
  await dialog.getByRole('button', { name: '确认生成 1 段', exact: true }).click();
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.calls.length === 1);
  const submitted = await page.evaluate(() => window.__comfyWorkflowSelectionQa.calls[0].items[0].draft);
  assert.equal(submitted.workflowId, 'workflow-current');
  assert.equal(submitted.parameters.seed, 22);
  checks.push('deleted batch selection restores the configured current ID; select, six slots, summary, parameters and mock submission agree');
  await page.screenshot({ path: path.join(output, 'restored-batch.png'), animations: 'disabled' });

  await mount({ noCurrent: true });
  await batchSelect.waitFor();
  assert.notEqual(await batchSelect.inputValue(), 'workflow-current');
  const missingText = await batchSelect.locator('option:checked').innerText();
  assert.match(missingText, /删除|不存在|重新选择|请选择/u);
  assert.match(await footer.innerText(), /未选择工作流/u);
  assert.doesNotMatch(await footer.innerText(), /请先启用 ComfyUI 并选择/u, 'missing selection is not falsely reported as a disabled connection');
  assert.equal(await page.getByRole('button', { name: '检查并生成 1 段视频', exact: true }).isDisabled(), true);
  checks.push('an unavailable explicit workflow with no active replacement remains visibly missing instead of displaying a different real workflow');

  await mount({ workflowId: 'workflow-other' });
  await batchSelect.waitFor();
  assert.equal(await batchSelect.inputValue(), 'workflow-other');
  assert.match(await footer.innerText(), /ComfyUI · 合成自选工作流/u);
  assert.match(await row.innerText(), /参考图 0 张 \/ 2 个槽/u);
  checks.push('a valid per-draft workflow is preserved when the global current workflow differs');

  await mount({ frozen: true });
  await batchSelect.waitFor();
  assert.equal(await batchSelect.inputValue(), 'workflow-archived');
  assert.match(await batchSelect.locator('option:checked').innerText(), /原失败批次快照.*原任务冻结工作流/u);
  assert.match(await footer.innerText(), /ComfyUI · 原任务冻结工作流/u);
  assert.match(await row.innerText(), /参考图 0 张 \/ 3 个槽/u);
  assert.equal(await page.evaluate(() => window.__comfyWorkflowSelectionQa.calls.length), 0);
  checks.push('a failed task retains its frozen workflow and three-slot mapping even when that workflow is no longer in the library');

  await mount({ frozen: true, emptyFrozenId: true });
  await batchSelect.waitFor();
  assert.equal(await batchSelect.inputValue(), '');
  assert.match(await batchSelect.locator('option:checked').innerText(), /原失败批次快照.*原任务冻结工作流/u);
  assert.match(await footer.innerText(), /ComfyUI · 原任务冻结工作流/u);
  assert.match(await row.innerText(), /参考图 0 张 \/ 3 个槽/u);
  assert.equal(await page.evaluate(() => window.__comfyWorkflowSelectionQa.calls.length), 0);
  checks.push('a frozen legacy task with an empty draft workflow ID still selects and displays its actual saved snapshot');

  await mount({ mode: 'single' });
  const singleSelect = page.getByLabel('ComfyUI 视频工作流', { exact: true });
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.persisted.at(-1)?.draft?.workflowId === 'workflow-current');
  assert.equal(await singleSelect.inputValue(), 'workflow-current');
  assert.match(await page.locator('#vd-single-generation-panel').innerText(), /已绑定 6 个图片输入/u);
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.calls.length === 1);
  assert.equal(await page.evaluate(() => window.__comfyWorkflowSelectionQa.calls[0].workflowId), 'workflow-current');
  checks.push('the single-segment form also restores and mock-submits the same actual current workflow ID');

  await mount({ mode: 'custom' });
  const customSelect = page.locator('.custom-video-source-controls select').nth(1);
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.custom?.draft?.workflowId === 'workflow-current');
  assert.equal(await customSelect.inputValue(), 'workflow-current');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await page.waitForFunction(() => window.__comfyWorkflowSelectionQa.calls.length === 1);
  assert.equal(await page.evaluate(() => window.__comfyWorkflowSelectionQa.calls[0].workflowId), 'workflow-current');
  checks.push('the independent custom form restores and mock-submits the same actual current workflow ID');

  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, [], 'no model, upload, ComfyUI or external request was attempted');
  const report = { passed: true, checks, errors, externalApiCalls: 0, blockedRequests };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {});
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error), stack: error.stack, errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
