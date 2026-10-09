import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import {
  compileRunningHubVideoApi, copyRunningHubVideoWorkflow, defaultRunningHubVideoConfig,
  exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig,
  readRunningHubVideoRequest, saveRunningHubVideoWorkflow, updateRunningHubVideoNodeValue,
} from '../src/runningHubVideo';
import { bindRunningHubVideoOutput, runningHubVideoOutputCandidates, runningHubVideoOutputControl } from '../src/runningHubVideoOutput';
import { listRunningHubVideoNodes, parseRunningHubVideoNodes } from '../src/runningHubVideoNodes';
import * as output from '../src/videoOutputParameters';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { buildVideoBatchRows } from '../src/videoBatch';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, Project, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';
import type { RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoOutputParametersProps } from '../src/components/VideoOutputParameters';

// The supplied cURL is a text fixture. It is never sent to a shell or a network.
// Its Authorization header contains only the original environment placeholder.
const curl = readFileSync(new URL('./fixtures/runningHubOrbitH3Curl.txt', import.meta.url), 'utf8');
const rawBody = curl.match(/--data-raw\s+'([\s\S]*)'\s*$/u)?.[1];
assert.ok(rawBody);
const originalRequest = JSON.parse(rawBody.replace(/'\\''/gu, "'"));
const stepsBinding = { nodeId: '124', inputName: 'steps' };
const fieldValue = (request: Record<string, unknown>, nodeId: string, fieldName = 'steps'): unknown =>
  (request.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>).find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;
const freshWorkflow = (): RunningHubVideoWorkflow => {
  const imported = importRunningHubVideoWorkflow(curl, '星轨 H3 隔离采样测试').workflow;
  const mapped = bindRunningHubVideoOutput(imported, 'steps', stepsBinding);
  mapped.mapping.prompt = [{ nodeId: '192', inputName: 'text' }];
  return mapped;
};
const configFor = (workflow: RunningHubVideoWorkflow) => ({
  ...structuredClone(defaultRunningHubVideoConfig), enabled: true, baseUrl: 'https://runninghub.example.test',
  apiKey: 'sampling-test-key', activeWorkflowId: workflow.id, workflows: [workflow],
});
const draftFor = (workflow: RunningHubVideoWorkflow, parameters: Record<string, unknown> = {}): VideoGenerationDraft => ({
  name: '采样参数隔离验证', backend: 'api', runningHubWorkflowId: workflow.id,
  prompt: '两位训练者交手后收棍回防。对白：“接住。”', references: [], parameters,
});
let groups = 0;
const check = (name: string, action: () => void) => { action(); groups += 1; console.log(`PASS ${name}`); };
const checkAsync = async (name: string, action: () => Promise<void>) => { await action(); groups += 1; console.log(`PASS ${name}`); };

check('actual supplied cURL imports safely and keeps every node value while steps is explicitly bound', () => {
  const imported = importRunningHubVideoWorkflow(curl);
  assert.equal(imported.workflow.remoteId, '2092524412225826817');
  assert.equal(imported.workflow.runKind, 'ai-app');
  assert.deepEqual(readRunningHubVideoRequest(imported.workflow.requestTemplate).nodeInfoList, originalRequest.nodeInfoList);
  assert.equal(readRunningHubVideoRequest(imported.workflow.requestTemplate).usePersonalQueue, false);
  assert.equal(readRunningHubVideoRequest(imported.workflow.requestTemplate).instanceType, 'default');
  assert.equal(imported.workflow.mapping.parameters?.steps, undefined, 'import does not guess a workflow mapping');
  assert.doesNotMatch(JSON.stringify(imported), /Authorization|RUNNINGHUB_API_KEY/u);
  assert.ok(imported.warnings.some((warning) => warning.includes('认证头')));
  const candidates = runningHubVideoOutputCandidates(listRunningHubVideoNodes(imported.workflow.requestTemplate), 'steps');
  assert.deepEqual(candidates.map((node) => `${node.nodeId}.${node.fieldName}`), ['124.steps']);
  const before = imported.workflow.requestTemplate;
  const bound = bindRunningHubVideoOutput(imported.workflow, 'steps', stepsBinding);
  assert.deepEqual(bound.mapping.parameters?.steps, stepsBinding);
  assert.equal(bound.requestTemplate, before, 'binding an existing field preserves all request bytes');
  assert.equal(fieldValue(readRunningHubVideoRequest(bound.requestTemplate), '124'), '10');
  assert.equal(typeof fieldValue(readRunningHubVideoRequest(bound.requestTemplate), '124'), 'string');
  assert.equal(imported.workflow.mapping.parameters?.steps, undefined, 'explicit binding is immutable');
});

check('steps discovery uses real scalar fields and retains cloud controls without inventing a range', () => {
  const workflow = freshWorkflow();
  assert.deepEqual(runningHubVideoOutputCandidates([
    { nodeId: 'value', fieldName: 'value', fieldValue: '10' },
    { nodeId: 'lora', fieldName: 'lora_name', fieldValue: 'steps.safetensors' },
    { nodeId: 'caption', fieldName: 'text', fieldValue: '采样步数 10' },
    { nodeId: 'real', fieldName: 'sampling_steps', fieldValue: 10 },
    { nodeId: 'title', fieldName: 'value', description: '采样步数', fieldValue: '10' },
  ], 'steps').map((node) => node.nodeId), ['real', 'title']);
  assert.equal(runningHubVideoOutputControl(workflow, 'steps')?.control.min, undefined);
  assert.equal(runningHubVideoOutputControl(workflow, 'steps')?.control.max, undefined);
  workflow.nodeCatalog = parseRunningHubVideoNodes(JSON.stringify({ nodeInfoList: [{ nodeId: '124', fieldName: 'steps', fieldValue: '22',
    fieldData: ['INT', { min: 1, max: 48, step: 1, default: 22 }] }] })).nodes;
  assert.deepEqual(runningHubVideoOutputControl(workflow, 'steps')?.control, { kind: 'number', min: 1, max: 48, step: 1 });
  assert.equal(fieldValue(readRunningHubVideoRequest(workflow.requestTemplate), '124'), '10', 'metadata cannot replace the request default');
  assert.throws(() => bindRunningHubVideoOutput({ ...workflow, mapping: { ...workflow.mapping, parameters: { cfg: stepsBinding } } }, 'steps', stepsBinding), /已绑定/u);
});

check('workflow defaults survive save, copy, export and full state persistence without touching unrelated nodes', () => {
  const workflow = freshWorkflow(); const before = readRunningHubVideoRequest(workflow.requestTemplate);
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, stepsBinding, '24');
  const expected = structuredClone(before);
  (expected.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>).find((node) => node.nodeId === '124')!.fieldValue = '24';
  assert.deepEqual(readRunningHubVideoRequest(workflow.requestTemplate), expected);
  const saved = saveRunningHubVideoWorkflow(configFor(workflow), workflow).workflows[0];
  const normalized = normalizeRunningHubVideoConfig(configFor(saved)).workflows[0];
  const copied = copyRunningHubVideoWorkflow(normalized);
  const backedUp = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(normalized)).workflow;
  for (const recovered of [saved, normalized, copied, backedUp]) {
    assert.deepEqual(recovered.mapping.parameters?.steps, stepsBinding);
    assert.equal(fieldValue(readRunningHubVideoRequest(recovered.requestTemplate), '124'), '24');
    assert.equal(recovered.requestTemplate, workflow.requestTemplate);
  }
  copied.requestTemplate = updateRunningHubVideoNodeValue(copied.requestTemplate, stepsBinding, '18');
  assert.equal(fieldValue(readRunningHubVideoRequest(normalized.requestTemplate), '124'), '24');
  const state = createInitialState(); state.settings.runningHubVideo = configFor(normalized);
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.equal(fieldValue(readRunningHubVideoRequest(restored.settings.runningHubVideo!.workflows[0].requestTemplate), '124'), '24');
  assert.deepEqual(restored.settings.runningHubVideo!.workflows[0].mapping.parameters?.steps, stepsBinding);
});

check('single and batch quick controls show the default, edit steps and clear only its override', () => {
  const module = { exports: {} as Record<string, unknown> };
  const source = readFileSync(new URL('../src/components/VideoOutputParameters.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  new Function('require', 'module', 'exports', 'React', compiled)((name: string) => {
    if (name === '../videoOutputParameters') return output;
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected output component import ${name}`);
  }, module, module.exports, React);
  const Component = module.exports.VideoOutputParameters as (props: VideoOutputParametersProps) => React.ReactElement;
  const nodesOf = (value: React.ReactNode): Array<React.ReactElement<any>> => Array.isArray(value) ? value.flatMap(nodesOf)
    : React.isValidElement<any>(value) ? [value, ...nodesOf(value.props.children)] : [];
  const workflow = freshWorkflow(); const api = compileRunningHubVideoApi(configFor(workflow));
  assert.ok(output.availableVideoParameterKeys('runninghub', api).includes('steps'));
  const props = output.videoOutputParameterPresentation(api);
  assert.equal(props.defaultValues.steps, '10');
  for (const scope of ['single', 'batch'] as const) {
    const changes: Array<[string, string]> = [];
    const label = `${scope === 'single' ? '本次' : '批量'}采样步数（步）`;
    const tree = Component({ scope, source: 'runninghub', availableKeys: ['steps'], parameterText: '{}', ...props, onChange: (key, value) => changes.push([key, value]) });
    const input = nodesOf(tree).find((node) => node.type === 'input' && node.props['aria-label'] === label)!;
    assert.ok(input); assert.equal(input.props.disabled, false); assert.equal(input.props.value, '');
    assert.equal(input.props.placeholder, '使用默认值（10）');
    assert.equal(input.props.min, undefined); assert.equal(input.props.max, undefined);
    assert.deepEqual(changes, [], 'rendering never writes a default override');
    input.props.onChange({ target: { value: '30' } }); input.props.onChange({ target: { value: '' } });
    assert.deepEqual(changes, [['steps', '30'], ['steps', '']]);
  }
  const original = '{"duration":10,"steps":30,"resolution":"0.4","seed":"9223372036854775807"}';
  const cleared = output.changeVideoParameterText(original, 'steps', '');
  assert.deepEqual(cleared.value, { duration: 10, resolution: '0.4', seed: '9223372036854775807' });
  assert.equal(output.changeVideoParameterText('{}', 'steps', '200').value.steps, 200, 'no global step cap is invented');
  assert.equal(output.videoOutputParameterSummary({ steps: 30 }), '请求采样步数 30 步');
});

const makeBatchFixture = () => {
  const state = createInitialState(); const project: Project = { ...state.project, assets: [], scenes: [], characters: [], storyboards: [], sequencePlans: [], generationTasks: [] };
  const plan: VideoSequencePlan = {
    id: 'sampling-plan', title: '采样测试两段', sourceStoryTitle: '隔离训练', sourceStoryContent: '两段中性训练', durationMode: 'fixed', totalDurationSec: 20,
    segmentDurationSec: 10, segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented',
    segments: [1, 2].map((index) => ({ id: `sampling-segment-${index}`, index, title: `采样第${index}段`, globalStartSec: (index - 1) * 10,
      globalEndSec: index * 10, durationSec: 10, content: `第${index}段中性训练`, summary: '中性训练', sourceSceneIds: [], sourceBeatIds: [], narrativePurpose: '训练',
      entryState: '', exitState: '', transitionHint: '', storyboardId: `sampling-board-${index}`, status: 'ready' as const })), createdAt: 1, updatedAt: 1,
  };
  project.sequencePlans = [plan];
  project.storyboards = plan.segments.map((segment) => ({
    id: segment.storyboardId!, sceneId: '', sourceStoryTitle: segment.title, sourceStoryContent: segment.content, workflow: 'drama', inputMode: 'text',
    durationSec: 10, durationPreset: 'custom', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '',
    converterPresetId: '', targetModelId: 'custom', globalLock: '', finalPrompt: segment.content, shots: [], sequencePlanId: plan.id, segmentId: segment.id,
    segmentIndex: segment.index, segmentCount: 2, createdAt: 1, updatedAt: 1,
  } as Storyboard));
  return { state, project, plan };
};

check('single and real batch row drafts serialize only the mapped steps override and clearing restores string 10', () => {
  const workflow = freshWorkflow(); const config = configFor(workflow); const api = compileRunningHubVideoApi(config, workflow.id, { steps: 30 });
  const before = readRunningHubVideoRequest(workflow.requestTemplate);
  const assertTransport = (draft: VideoGenerationDraft, expectedSteps: string) => {
    const body = buildVideoApiBody(api, draft, []);
    assert.equal(fieldValue(body, '124'), expectedSteps);
    assert.equal(typeof fieldValue(body, '124'), 'string');
    assert.equal(fieldValue(body, '192', 'text'), draft.prompt);
    assert.deepEqual((body.nodeInfoList as Array<{ nodeId: string }>).filter((node) => !['124', '192'].includes(node.nodeId)),
      before.nodeInfoList.filter((node) => !['124', '192'].includes(String(node.nodeId))));
    assert.equal(body.instanceType, 'default'); assert.equal(body.usePersonalQueue, false);
    assert.equal('steps' in body, false, 'steps is a mapped node value rather than an invented outer API field');
  };
  assertTransport(draftFor(workflow, { steps: 30 }), '30');
  assertTransport(draftFor(workflow), '10');
  const { state, project, plan } = makeBatchFixture(); state.settings.runningHubVideo = config;
  const rows = buildVideoBatchRows(project, plan, state.settings, { backend: 'api', runningHubWorkflowId: workflow.id, promptFormat: 'ordinary', parameters: { steps: 24 }, includeStoryboardReferences: false });
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.ok(row.zh); assert.equal(row.zh.draft.parameters.steps, 24); assertTransport(row.zh.draft, '24'); }
  const resetRows = buildVideoBatchRows(project, plan, state.settings, { backend: 'api', runningHubWorkflowId: workflow.id, promptFormat: 'ordinary', parameters: {}, includeStoryboardReferences: false });
  for (const row of resetRows) { assert.ok(row.zh); assert.equal('steps' in row.zh.draft.parameters, false); assertTransport(row.zh.draft, '10'); }
  assert.equal(fieldValue(readRunningHubVideoRequest(workflow.requestTemplate), '124'), '10');
});

await checkAsync('changing today’s workflow default leaves a frozen old task unchanged and resume only queries its original task', async () => {
  let state: AppState = createInitialState(); const workflow = freshWorkflow(); state.settings.runningHubVideo = configFor(workflow);
  state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 2;
  state.project = { ...state.project, assets: [], storyboards: [], generationTasks: [] }; state.projects = [state.project];
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const checkpoints = new Map<string, VideoGenerationTask>(); const credentials = new Map<string, string>();
  const desktop = {
    videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      requests.push(structuredClone(request));
      assert.ok(request.url.startsWith('https://runninghub.example.test/'), 'every request is handled only by this mock');
      assert.equal(request.url.includes('/media/'), false, 'this text-only fixture cannot upload media');
      return { status: 200, body: JSON.stringify(request.url.includes('/run/')
        ? { taskId: '2092524412225826801', status: 'QUEUED', results: null }
        : { taskId: '2092524412225826801', status: 'RUNNING', results: null }) };
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => credentials.get(taskId) ?? null,
    saveVideoTaskCheckpoint: async (task: VideoGenerationTask) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId: string) => structuredClone(checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId: string) => checkpoints.delete(taskId),
  } as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (updater: (previous: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 20, persistState: async () => {} };
  const waitFor = async (check: () => boolean) => { for (let attempt = 0; attempt < 500; attempt += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail('mock task did not reach query stage'); };
  const engine = new VideoGenerationEngine(options);
  let resumed: VideoGenerationEngine | undefined;
  try {
    const taskId = await engine.start(draftFor(workflow, { steps: 18 }));
    await waitFor(() => requests.some((request) => request.url.endsWith('/query')));
    engine.dispose();
    const task = state.project.generationTasks.find((entry) => entry.id === taskId)!;
    assert.ok(task.videoJob); const frozen = structuredClone(task.videoJob.snapshot);
    assert.equal(frozen.draft.parameters.steps, 18);
    assert.equal(fieldValue(readRunningHubVideoRequest(frozen.connection.api!.requestTemplate!), '124'), '18');
    const changed = { ...workflow, requestTemplate: updateRunningHubVideoNodeValue(workflow.requestTemplate, stepsBinding, '40') };
    state.settings.runningHubVideo = configFor(changed);
    assert.equal(fieldValue(readRunningHubVideoRequest(compileRunningHubVideoApi(state.settings.runningHubVideo!).requestTemplate!), '124'), '40');
    const beforeResume = requests.length;
    resumed = new VideoGenerationEngine(options); await resumed.resume(taskId);
    await waitFor(() => requests.slice(beforeResume).some((request) => request.url.endsWith('/query')));
    assert.ok(requests.slice(beforeResume).every((request) => request.url.endsWith('/query')), 'restoring a frozen task never reposts generation');
    assert.deepEqual(JSON.parse(requests.slice(beforeResume)[0].body || '{}'), { taskId: '2092524412225826801' });
    assert.equal(requests.filter((request) => request.url.includes('/run/')).length, 1);
    assert.deepEqual(state.project.generationTasks.find((entry) => entry.id === taskId)!.videoJob!.snapshot, frozen);
  } finally { engine.dispose(); resumed?.dispose(); }
});

console.log(`RunningHub sampling steps: ${groups} focused groups passed; no shell cURL execution or real network requests.`);
