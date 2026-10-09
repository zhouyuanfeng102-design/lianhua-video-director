import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addRunningHubLoraSlot, addRunningHubOtherField, listRunningHubLoraSlots,
  listRunningHubOtherFields, normalizeRunningHubGenerationExtras,
  removeRunningHubLoraSlot, removeRunningHubOtherField,
} from '../src/runningHubGenerationExtras';
import {
  compileRunningHubVideoApi, copyRunningHubVideoWorkflow, defaultRunningHubVideoConfig,
  exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig,
  readRunningHubVideoRequest, saveRunningHubVideoWorkflow, updateRunningHubVideoNodeValue,
} from '../src/runningHubVideo';
import { parseRunningHubVideoNodes, resolveRunningHubVideoFieldControl } from '../src/runningHubVideoNodes';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { RunningHubLoraSlot, RunningHubVideoInputBinding, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { AppState, VideoGenerationTask } from '../src/types';

// Text fixture only: no shell executes its cURL and no test calls a cloud API.
const curl = readFileSync(new URL('./fixtures/runningHubOrbitH3Curl.txt', import.meta.url), 'utf8');
const binding = (nodeId: string, inputName: string): RunningHubVideoInputBinding => ({ nodeId, inputName });
const keyOf = (item: RunningHubVideoInputBinding) => JSON.stringify([item.nodeId, item.inputName]);
const valueOf = (request: Record<string, unknown>, item: RunningHubVideoInputBinding) =>
  (request.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>)
    .find((node) => node.nodeId === item.nodeId && node.fieldName === item.inputName)?.fieldValue;
const freshWorkflow = (): RunningHubVideoWorkflow => {
  const workflow = importRunningHubVideoWorkflow(curl, 'LoRA 和其它隔离测试').workflow;
  workflow.mapping.prompt = [binding('192', 'text')];
  return workflow;
};
const configFor = (workflow: RunningHubVideoWorkflow) => ({
  ...structuredClone(defaultRunningHubVideoConfig), enabled: true, baseUrl: 'https://runninghub.example.test',
  apiKey: 'extras-local-test-key', activeWorkflowId: workflow.id, workflows: [workflow],
});
const draftFor = (workflow: RunningHubVideoWorkflow, parameters: Record<string, unknown> = {}): VideoGenerationDraft => ({
  name: 'LoRA 参数隔离验证', backend: 'api', runningHubWorkflowId: workflow.id,
  prompt: '两位训练者接招后各退一步，收棍回防。', references: [], parameters,
});
const model = binding('901', 'adapter_file');
const strength = binding('901', 'adapter_weight');
const clipStrength = binding('901', 'clip_weight');
const otherText = binding('950', 'style_mode');
const otherBoolean = binding('950', 'enabled');
const otherNumber = binding('950', 'scale');
const manualSlot: RunningHubLoraSlot = { model, strength, label: '手动真实槽位' };
const catalogueWorkflow = (): RunningHubVideoWorkflow => {
  const workflow = freshWorkflow();
  // Synthetic provider-shaped discovery data exercises COMBO parsing without
  // claiming that unavailable cloud model choices were fetched from an API.
  workflow.nodeCatalog = parseRunningHubVideoNodes(JSON.stringify({ nodeInfoList: [
    { nodeId: '159', fieldName: 'lora_name', fieldValue: 'cloud-refresh-default.safetensors',
      fieldData: JSON.stringify(['COMBO', { options: ['MysticXXX_MMH3-V1.safetensors', 'folder/custom adapter.safetensors'] }]) },
    { nodeId: '901', fieldName: 'adapter_file', fieldValue: 'manual/first.safetensors',
      fieldData: ['COMBO', { options: ['manual/first.safetensors', 'manual/second.safetensors'] }] },
    { nodeId: '901', fieldName: 'adapter_weight', fieldValue: '0.6000000000000001',
      fieldData: ['FLOAT', { step: 0.01 }] },
    { nodeId: '901', fieldName: 'clip_weight', fieldValue: 0.7 },
    { nodeId: '901', fieldName: 'unselected_input', fieldValue: 'must not submit' },
    { nodeId: '902', fieldName: 'lora_name', fieldValue: 'unselected-lora.safetensors' },
    { nodeId: '950', fieldName: 'style_mode', fieldValue: 'provider_a', fieldData: ['COMBO', { options: ['provider_a', 'provider_b'] }] },
    { nodeId: '950', fieldName: 'enabled', fieldValue: true },
    { nodeId: '950', fieldName: 'scale', fieldValue: 3.5, fieldData: ['FLOAT', { min: 0, step: 0.25 }] },
    { nodeId: '950', fieldName: 'api_key', fieldValue: 'synthetic-never-save-secret' },
  ] })).nodes;
  return workflow;
};
const extrasWorkflow = () => {
  let workflow = addRunningHubLoraSlot(catalogueWorkflow(), manualSlot);
  for (const item of [otherText, otherBoolean, otherNumber]) workflow = addRunningHubOtherField(workflow, item);
  workflow.fieldControls = {
    [keyOf(model)]: { kind: 'select', options: ['manual/first.safetensors', 'manual/second.safetensors'] },
    [keyOf(strength)]: { kind: 'number', step: 0.01 },
    [keyOf(otherBoolean)]: { kind: 'select', options: ['true', 'false'] },
    [keyOf(otherNumber)]: { kind: 'number', step: 0.25 },
  };
  workflow.mapping.parameters = { custom_adapter: model, custom_strength: strength, custom_scale: otherNumber, custom_enabled: otherBoolean };
  return workflow;
};
let groups = 0;
const check = (name: string, action: () => void) => { action(); groups += 1; console.log(`PASS ${name}`); };
const checkAsync = async (name: string, action: () => Promise<void>) => { await action(); groups += 1; console.log(`PASS ${name}`); };

check('attachment discovers four actual LoRA inputs without counting the main UNet or changing legacy values', () => {
  const workflow = freshWorkflow(); const before = workflow.requestTemplate;
  assert.equal(workflow.generationExtras, undefined, 'old imported configurations need no migration');
  const slots = listRunningHubLoraSlots(workflow);
  assert.deepEqual(slots.map((slot) => slot.model.nodeId), ['159', '199', '224', '153']);
  assert.ok(slots.every((slot) => slot.automatic && slot.strength?.nodeId === slot.model.nodeId && slot.strength.inputName === 'strength_model'));
  assert.equal(slots.some((slot) => slot.model.nodeId === '165'), false);
  assert.equal(valueOf(readRunningHubVideoRequest(before), binding('159', 'strength_model')), '0.5000000000000001');
  assert.equal(valueOf(readRunningHubVideoRequest(before), binding('153', 'strength_model')), '1.0000000000000002');
  assert.deepEqual(listRunningHubOtherFields(workflow), []);
  assert.equal(workflow.requestTemplate, before, 'discovery never rewrites the request');
  assert.equal(normalizeRunningHubVideoConfig(configFor(workflow)).workflows[0].generationExtras, undefined);
  assert.deepEqual(buildVideoApiBody(compileRunningHubVideoApi(configFor(workflow)), draftFor(workflow), []).nodeInfoList,
    readRunningHubVideoRequest(before).nodeInfoList.map((node) => node.nodeId === '192' && node.fieldName === 'text' ? { ...node, fieldValue: draftFor(workflow).prompt } : node));
});

check('catalogue choices stay exact and undisplayed catalogue fields enter the request only when explicitly selected', () => {
  const original = catalogueWorkflow(); const before = original.requestTemplate;
  assert.deepEqual(resolveRunningHubVideoFieldControl(original, binding('159', 'lora_name')),
    { control: { kind: 'select', options: ['MysticXXX_MMH3-V1.safetensors', 'folder/custom adapter.safetensors'] }, defaultValue: 'MysticXXX_MMH3-V1.safetensors' });
  assert.equal(listRunningHubLoraSlots(original).length, 4, 'catalogue-only LoRA is not auto-submitted or counted as an active slot');
  const added = addRunningHubLoraSlot(original, manualSlot); const request = readRunningHubVideoRequest(added.requestTemplate);
  assert.deepEqual(request.nodeInfoList.slice(0, readRunningHubVideoRequest(before).nodeInfoList.length), readRunningHubVideoRequest(before).nodeInfoList);
  assert.deepEqual(request.nodeInfoList.slice(-2).map((node) => [node.nodeId, node.fieldName, node.fieldValue]),
    [['901', 'adapter_file', 'manual/first.safetensors'], ['901', 'adapter_weight', '0.6000000000000001']]);
  assert.ok(request.nodeInfoList.slice(-2).every((node) => !('control' in node) && !('fieldData' in node)));
  for (const item of [clipStrength, binding('901', 'unselected_input'), binding('902', 'lora_name')]) assert.equal(valueOf(request, item), undefined);
  const slots = listRunningHubLoraSlots(added);
  assert.equal(slots.length, 5); assert.equal(slots[0].automatic, false);
  assert.deepEqual(slots[0].model, model); assert.deepEqual(slots[0].strength, strength);
  assert.equal(resolveRunningHubVideoFieldControl(added, strength)?.defaultValue, '0.6000000000000001');
  const withClip = addRunningHubLoraSlot(added, { ...manualSlot, clipStrength });
  assert.equal(valueOf(readRunningHubVideoRequest(withClip.requestTemplate), clipStrength), 0.7);
  assert.equal(listRunningHubLoraSlots(withClip).length, 5, 'editing a position updates its slot instead of duplicating it');
  assert.equal(original.requestTemplate, before, 'adding positions never mutates the previous draft');
});

check('other fields keep scalar types, local controls and real names while unsafe, reserved and ambiguous positions are rejected', () => {
  const workflow = extrasWorkflow(); const request = readRunningHubVideoRequest(workflow.requestTemplate);
  assert.deepEqual(listRunningHubOtherFields(workflow), [otherText, otherBoolean, otherNumber]);
  assert.equal(valueOf(request, otherText), 'provider_a'); assert.equal(valueOf(request, otherBoolean), true); assert.equal(valueOf(request, otherNumber), 3.5);
  assert.deepEqual(resolveRunningHubVideoFieldControl(workflow, otherBoolean)?.control, { kind: 'select', options: ['true', 'false'] });
  assert.equal(workflow.nodeCatalog?.some((node) => node.fieldName === 'api_key'), false);
  assert.throws(() => addRunningHubOtherField(workflow, binding('950', 'api_key')), /密钥|真实/u);
  assert.throws(() => addRunningHubOtherField(workflow, binding('192', 'text')), /提示词/u);
  assert.throws(() => addRunningHubOtherField(workflow, model), /LoRA/u);
  assert.throws(() => addRunningHubLoraSlot(workflow, { model, strength: model }), /不同/u);
  assert.throws(() => addRunningHubLoraSlot(workflow, { model: otherText, strength }), /其它/u);
  assert.throws(() => addRunningHubLoraSlot(workflow, { model: binding('902', 'lora_name'), strength }), /另一个/u);
  const reserved = { ...workflow, mapping: { ...workflow.mapping, parameters: { ...workflow.mapping.parameters, steps: binding('124', 'steps') } } };
  assert.throws(() => addRunningHubOtherField(reserved, binding('124', 'steps')), /常用/u);
  const plainOther = addRunningHubOtherField(catalogueWorkflow(), otherText);
  assert.throws(() => addRunningHubLoraSlot(plainOther, { model: otherText }), /其它/u);
  const explicitImageConflict = { ...workflow, mapping: { ...workflow.mapping, images: [{ ...otherText, role: 'general' as const }] } };
  assert.throws(() => addRunningHubOtherField(explicitImageConflict, otherText), /参考图片/u);
  const countConflict = { ...workflow, mapping: { ...workflow.mapping, imageCount: binding('173', 'value') } };
  assert.throws(() => addRunningHubOtherField(countConflict, binding('173', 'value')), /实际图片数量/u);
  const bad = freshWorkflow(); const badRequest = readRunningHubVideoRequest(bad.requestTemplate);
  badRequest.nodeInfoList.push(
    { nodeId: 'bad', fieldName: 'complex', fieldValue: ['123', 0] },
    { nodeId: 'bad', fieldName: 'unsafe', fieldValue: 9007199254740992 },
    { nodeId: 'duplicate', fieldName: 'model', fieldValue: 'one' },
    { nodeId: 'duplicate', fieldName: 'model', fieldValue: 'two' },
  );
  bad.requestTemplate = JSON.stringify(badRequest);
  for (const item of [binding('bad', 'complex'), binding('bad', 'unsafe'), binding('duplicate', 'model'), binding('missing', 'field')])
    assert.throws(() => addRunningHubOtherField(bad, item), /唯一|真实/u);
});

check('removing display positions preserves original nodes, edited values and existing task override mappings', () => {
  let workflow = extrasWorkflow();
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, strength, '0.4000000000000001');
  const before = workflow.requestTemplate; const mapping = structuredClone(workflow.mapping);
  workflow = removeRunningHubLoraSlot(workflow, model);
  workflow = removeRunningHubLoraSlot(workflow, binding('159', 'lora_name'));
  workflow = removeRunningHubOtherField(workflow, otherNumber);
  assert.equal(workflow.requestTemplate, before); assert.deepEqual(workflow.mapping, mapping);
  assert.equal(valueOf(readRunningHubVideoRequest(workflow.requestTemplate), strength), '0.4000000000000001');
  assert.deepEqual(listRunningHubLoraSlots(workflow).map((slot) => slot.model.nodeId), ['199', '224', '153']);
  assert.deepEqual(listRunningHubOtherFields(workflow), [otherText, otherBoolean]);
  assert.throws(() => addRunningHubOtherField(workflow, binding('159', 'strength_model')), /LoRA/u);
  workflow = addRunningHubLoraSlot(workflow, manualSlot);
  assert.equal(listRunningHubLoraSlots(workflow).length, 4);
  assert.equal(workflow.requestTemplate, before, 'restoring a hidden slot retains its edited default');
  assert.equal(valueOf(buildVideoApiBody(compileRunningHubVideoApi(configFor(workflow)), draftFor(workflow), []), otherNumber), 3.5,
    'hidden other fields retain their bound defaults at submission');
});

check('display metadata and controls round trip through save, copy, export/import and full application storage', () => {
  const workflow = removeRunningHubLoraSlot(extrasWorkflow(), binding('224', 'lora_name'));
  workflow.requestTemplate = updateRunningHubVideoNodeValue(workflow.requestTemplate, model, 'manual/second.safetensors');
  const saved = saveRunningHubVideoWorkflow(configFor(workflow), workflow).workflows[0];
  const normalized = normalizeRunningHubVideoConfig(configFor(saved)).workflows[0];
  const copied = copyRunningHubVideoWorkflow(normalized);
  const exported = exportRunningHubVideoWorkflow(normalized);
  assert.doesNotMatch(exported, /Authorization|RUNNINGHUB_API_KEY|synthetic-never-save-secret|extras-local-test-key/u);
  const imported = importRunningHubVideoWorkflow(exported).workflow;
  const state = createInitialState(); state.settings.runningHubVideo = configFor(saved);
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized)).settings.runningHubVideo!.workflows[0];
  for (const recovered of [saved, normalized, copied, imported, restored]) {
    assert.deepEqual(recovered.generationExtras, workflow.generationExtras);
    assert.deepEqual(recovered.fieldControls, workflow.fieldControls);
    assert.deepEqual(recovered.mapping, workflow.mapping);
    assert.deepEqual(recovered.nodeCatalog, workflow.nodeCatalog);
    assert.equal(recovered.requestTemplate, workflow.requestTemplate);
    assert.equal(valueOf(readRunningHubVideoRequest(recovered.requestTemplate), binding('159', 'strength_model')), '0.5000000000000001');
    assert.equal(valueOf(readRunningHubVideoRequest(recovered.requestTemplate), binding('153', 'strength_model')), '1.0000000000000002');
    assert.equal(listRunningHubLoraSlots(recovered).some((slot) => slot.model.nodeId === '224'), false);
  }
  copied.generationExtras!.loraSlots![0].label = 'copy-only';
  assert.equal(normalized.generationExtras!.loraSlots![0].label, '手动真实槽位');
  assert.deepEqual(normalizeRunningHubGenerationExtras({
    loraSlots: [{ model }, { model }, { model: binding('1', 'api_key') }],
    otherFields: [otherNumber, otherNumber, binding('1', 'authorization')],
    hiddenLoras: [model, model, binding('1', 'access_token')],
  }), { loraSlots: [{ model }], otherFields: [otherNumber], hiddenLoras: [model] });
});

check('manager-edited defaults and explicit overrides use actual node fields and preserve types without leaking local metadata', () => {
  let workflow = extrasWorkflow(); const original = readRunningHubVideoRequest(workflow.requestTemplate);
  for (const [item, text] of [[model, 'manual/second.safetensors'], [strength, '0.2000000000000001'], [otherText, 'provider_b'], [otherBoolean, 'false'], [otherNumber, '4.75']] as const)
    workflow = { ...workflow, requestTemplate: updateRunningHubVideoNodeValue(workflow.requestTemplate, item, text) };
  const body = buildVideoApiBody(compileRunningHubVideoApi(configFor(workflow)), draftFor(workflow), []);
  assert.equal(valueOf(body, model), 'manual/second.safetensors');
  assert.equal(valueOf(body, strength), '0.2000000000000001');
  assert.equal(valueOf(body, otherText), 'provider_b'); assert.equal(valueOf(body, otherBoolean), false); assert.equal(valueOf(body, otherNumber), 4.75);
  assert.equal(valueOf(body, binding('192', 'text')), draftFor(workflow).prompt);
  const edited = new Set([model, strength, otherText, otherBoolean, otherNumber, binding('192', 'text')].map(keyOf));
  assert.deepEqual((body.nodeInfoList as typeof original.nodeInfoList).filter((node) => !edited.has(JSON.stringify([node.nodeId, node.fieldName]))),
    original.nodeInfoList.filter((node) => !edited.has(JSON.stringify([node.nodeId, node.fieldName]))));
  for (const local of ['generationExtras', 'loraSlots', 'otherFields', 'hiddenLoras', 'fieldControls', 'nodeCatalog', 'custom_adapter', 'custom_scale']) assert.equal(local in body, false);
  assert.equal(JSON.stringify(body).includes('手动真实槽位'), false);
  const overrides = { custom_adapter: 'provider/specific.safetensors', custom_strength: '0.9000000000000001', custom_scale: '6.25', custom_enabled: 'true' };
  const overridden = buildVideoApiBody(compileRunningHubVideoApi(configFor(workflow), workflow.id, overrides), draftFor(workflow, overrides), []);
  assert.equal(valueOf(overridden, model), overrides.custom_adapter); assert.equal(valueOf(overridden, strength), overrides.custom_strength);
  assert.equal(valueOf(overridden, otherNumber), 6.25); assert.equal(valueOf(overridden, otherBoolean), true);
  assert.equal(valueOf(body, otherBoolean), false, 'building another request never mutates a previously built body');
  assert.equal(valueOf(readRunningHubVideoRequest(workflow.requestTemplate), otherNumber), 4.75);
});

await checkAsync('changing current LoRA defaults leaves an old task frozen and resuming only queries its original remote task', async () => {
  let state: AppState = createInitialState(); const workflow = extrasWorkflow(); state.settings.runningHubVideo = configFor(workflow);
  state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 2;
  state.project = { ...state.project, assets: [], storyboards: [], generationTasks: [] }; state.projects = [state.project];
  const requests: Array<Parameters<VideoGenerationDesktop['videoRequest']>[0]> = [];
  const checkpoints = new Map<string, VideoGenerationTask>(); const credentials = new Map<string, string>();
  const desktop = {
    videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      requests.push(structuredClone(request));
      assert.ok(request.url.startsWith('https://runninghub.example.test/'), 'only local mocks handle requests');
      assert.equal(request.url.includes('/media/'), false, 'text-only drafts require no upload');
      return { status: 200, body: JSON.stringify(request.url.includes('/run/')
        ? { taskId: '2092524412225826802', status: 'QUEUED', results: null }
        : { taskId: '2092524412225826802', status: 'RUNNING', results: null }) };
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId: string) => credentials.get(taskId) ?? null,
    saveVideoTaskCheckpoint: async (task: VideoGenerationTask) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId: string) => structuredClone(checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId: string) => checkpoints.delete(taskId),
  } as VideoGenerationDesktop;
  const options = { getState: () => state, setState: (updater: (previous: AppState) => AppState) => { state = updater(state); }, desktop, onRuntime: () => {}, pollIntervalMs: 20, persistState: async () => {} };
  const waitFor = async (ready: () => boolean) => { for (let attempt = 0; attempt < 500; attempt += 1) { if (ready()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail('mock task did not reach query stage'); };
  const engine = new VideoGenerationEngine(options); let resumed: VideoGenerationEngine | undefined;
  try {
    const taskId = await engine.start(draftFor(workflow, { custom_strength: '0.8000000000000001' }));
    await waitFor(() => requests.some((request) => request.url.endsWith('/query'))); engine.dispose();
    const task = state.project.generationTasks.find((entry) => entry.id === taskId)!;
    assert.ok(task.videoJob); const frozen = structuredClone(task.videoJob.snapshot);
    assert.equal(valueOf(readRunningHubVideoRequest(frozen.connection.api!.requestTemplate!), model), 'manual/first.safetensors');
    assert.equal(valueOf(readRunningHubVideoRequest(frozen.connection.api!.requestTemplate!), strength), '0.8000000000000001');
    assert.equal('generationExtras' in frozen.connection.api!, false);
    const changed = { ...workflow, requestTemplate: updateRunningHubVideoNodeValue(workflow.requestTemplate, model, 'manual/second.safetensors') };
    state.settings.runningHubVideo = configFor(removeRunningHubLoraSlot(changed, model));
    assert.equal(valueOf(readRunningHubVideoRequest(compileRunningHubVideoApi(state.settings.runningHubVideo!).requestTemplate!), model), 'manual/second.safetensors');
    const beforeResume = requests.length;
    resumed = new VideoGenerationEngine(options); await resumed.resume(taskId);
    await waitFor(() => requests.slice(beforeResume).some((request) => request.url.endsWith('/query')));
    assert.ok(requests.slice(beforeResume).every((request) => request.url.endsWith('/query')));
    assert.deepEqual(JSON.parse(requests.slice(beforeResume)[0].body || '{}'), { taskId: '2092524412225826802' });
    assert.equal(requests.filter((request) => request.url.includes('/run/')).length, 1, 'resume never regenerates the old task');
    assert.deepEqual(state.project.generationTasks.find((entry) => entry.id === taskId)!.videoJob!.snapshot, frozen);
  } finally { engine.dispose(); resumed?.dispose(); }
});

console.log(`RunningHub generation extras: ${groups} focused groups passed; no real network, package build or full regression.`);
