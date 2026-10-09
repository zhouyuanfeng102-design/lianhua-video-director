import assert from 'node:assert/strict';
import { bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow } from '../src/runningHubVideo';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { isRunningHubH3AutoPromptInput, runningHubWholePromptPictureNumbers } from '../src/runningHubPromptPictures';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import type { AppState, VideoGenerationTask } from '../src/types';
import type { VideoDesktopRequest, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const appId = '2104753059472990209';
const nodeIds = ['438', '435', '437', '439', '431', '429'];
const workflow = { ...createRunningHubVideoWorkflow('合成自动改稿应用'), remoteId: appId, runKind: 'ai-app' as const,
  mapping: { prompt: [{ nodeId: '456', inputName: 'text' }], images: nodeIds.map((nodeId) => ({ nodeId, inputName: 'image' })) },
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: '456', fieldName: 'text', fieldValue: '' },
    ...nodeIds.map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'example.png' })),
    { nodeId: '827', fieldName: 'value', fieldValue: '1' },
    { nodeId: '824', fieldName: 'value', fieldValue: 'false' },
    { nodeId: 'strict-preserved', fieldName: 'strict_prompt_tags', fieldValue: true },
  ], instanceType: 'default', usePersonalQueue: false }),
};
const api = compileRunningHubVideoApi({ enabled: true, baseUrl: 'https://fixture.invalid', apiKey: '',
  workflows: [workflow], activeWorkflowId: workflow.id });
assert.ok(isRunningHubH3AutoPromptInput(api));
const valueAt = (body: Record<string, unknown>, nodeId: string, fieldName: string): unknown => (
  body.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>
).find((node) => node.nodeId === nodeId && node.fieldName === fieldName)?.fieldValue;

// Both preflight and actual upload binding build the same contract with the
// actual selected count. The original body is not rewritten or duplicated.
for (const count of [1, 6]) {
  const prompt = `subject_definitions: 测试角色 reference <Picture ${count}>\nintegrated_multimodal_description: [Shot 1] 看向木门。声音 <d>[Chinese] 只说一次原话。</d> [Shot 9] 延续原动作，人物 <Subject 12>；同一图片内的多视图面板不增加图片。`;
  const draft: VideoGenerationDraft = { backend: 'api', name: '合成输入合同', prompt, parameters: {},
    references: Array.from({ length: count }, (_, index) => ({ assetId: `asset-${index + 1}`, role: index ? 'character' : 'first-frame' })) };
  const before = structuredClone(draft); const apiBefore = structuredClone(api);
  const validationImages = draft.references.map((_, index) => `validation-${index}`);
  const uploadedImages = draft.references.map((_, index) => `openapi/upload-${index}.png`);
  const preflight = buildVideoApiBody(api, draft, validationImages);
  const submission = buildVideoApiBody(api, draft, uploadedImages);
  const submitted = String(valueAt(submission, '456', 'text'));
  assert.equal(valueAt(preflight, '456', 'text'), submitted, 'the submitted field carries the same reviewed count contract as preflight');
  assert.equal(submitted.split(prompt).length - 1, 1, 'the complete authored body occurs exactly once, verbatim');
  assert.match(submitted, new RegExp(`本次实际连接 ${count} 张图片`, 'u'));
  assert.match(submitted, /已经完成的 H3 正文.*不再重新规划或扩写/u);
  assert.match(submitted, /人物\/Subject 编号、分镜\/Shot 编号和镜头数量都不是新增图片/u);
  assert.match(submitted, /逐字保留原主体身份、完整对白及其语言和说话人、镜头结构、时码切点/u);
  assert.deepEqual([...runningHubWholePromptPictureNumbers(submitted)].sort(), Array.from({ length: count }, (_, index) => String(index + 1)).sort());
  assert.equal(valueAt(submission, '827', 'value'), String(count));
  assert.equal(valueAt(submission, '824', 'value'), 'false', 'the ZIP switch is not a guessed native rewrite bypass');
  assert.equal(valueAt(submission, 'strict-preserved', 'strict_prompt_tags'), true);
  uploadedImages.forEach((image, index) => assert.equal(valueAt(submission, nodeIds[index], 'image'), image));
  assert.deepEqual(draft, before); assert.deepEqual(api, apiBefore, 'saved draft/API snapshots are unchanged');
  assert.equal(valueAt(bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, draft, uploadedImages), '456', 'text'), prompt,
    'without explicit submit context, old standalone/frozen binders are unchanged');
}

const draft: VideoGenerationDraft = { backend: 'api', name: '未修改来源', prompt: 'subject_definitions: 角色 reference <Picture 1>\nintegrated_multimodal_description: 原动作。',
  parameters: {}, references: [{ assetId: 'first-frame', role: 'first-frame' }] };
for (const other of [
  { ...api, runningHubAppId: '999', endpoint: 'https://fixture.invalid/openapi/v2/run/ai-app/999' },
  { ...api, endpoint: `https://fixture.invalid/openapi/v2/run/workflow/${appId}` },
  { ...api, runningHubMappedFields: api.runningHubMappedFields!.filter((field) => field.kind !== 'image-count') },
]) {
  assert.equal(isRunningHubH3AutoPromptInput(other), false);
  assert.equal(valueAt(buildVideoApiBody(other, draft, ['openapi/first.png']), '456', 'text'), draft.prompt,
    'unknown graphs, workflow endpoints and old snapshots without prefix evidence receive no speculative wrapper');
}

// A different prompt mapping in the same application must not be repurposed.
const wrongWorkflow = { ...workflow, requestTemplate: workflow.requestTemplate.replaceAll('"456"', '"455"'),
  mapping: { ...workflow.mapping, prompt: [{ nodeId: '455', inputName: 'text' }] } };
const wrongApi = compileRunningHubVideoApi({ enabled: true, baseUrl: 'https://fixture.invalid', apiKey: '', workflows: [wrongWorkflow], activeWorkflowId: wrongWorkflow.id });
assert.equal(isRunningHubH3AutoPromptInput(wrongApi), false);
assert.equal(valueAt(buildVideoApiBody(wrongApi, draft, ['openapi/first.png']), '455', 'text'), draft.prompt);

// The transmitted body still fails locally if its untouched source contains
// an unsupported Picture. No guard is disabled to accommodate the wrapper.
assert.throws(() => buildVideoApiBody(api, { ...draft, prompt: draft.prompt + '\n<Picture 7>' }, ['openapi/first.png']), /实际连接 1 张图片.*<Picture 7>/u);

// A remote task already exists: resuming it must query its original ID even
// when its old prompt contains a now-rejected label. No new POST is built.
{
  let state = createInitialState();
  const existing: VideoGenerationTask = { id: 'existing-cloud-task', kind: 'video', storyboardId: '', targetId: 'synthetic-app', status: 'running',
    remoteTaskId: 'synthetic-remote-id', createdAt: 1, updatedAt: 1, requestBody: {},
    videoJob: { stage: 'stopped', trackingStopped: true, snapshot: { projectId: state.project.id, clientId: 'synthetic-client',
      draft: { ...draft, prompt: draft.prompt + '\n<Picture 7>' }, connection: { backend: 'api', api }, images: [] },
      preparation: { version: 1, phase: 'acknowledged', uploadedImages: ['openapi/already-uploaded.png'] } } };
  const before = structuredClone(existing.videoJob!.snapshot);
  state.project.generationTasks = [existing]; state.projects = [state.project];
  const requests: VideoDesktopRequest[] = [];
  const unexpected = async (): Promise<never> => { throw new Error('Remote task recovery must not upload, read images or generate again'); };
  const desktop: VideoGenerationDesktop = { videoRequest: async (request) => {
    requests.push(structuredClone(request));
    assert.equal(request.url, 'https://fixture.invalid/openapi/v2/query');
    assert.deepEqual(JSON.parse(request.body || '{}'), { taskId: 'synthetic-remote-id' });
    return { status: 200, body: JSON.stringify({ taskId: 'synthetic-remote-id', status: 'RUNNING', results: null }) };
  }, cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {}, getVideoTaskCredential: async () => 'synthetic-key', setVideoTaskCredential: async () => ({ persisted: true }),
    saveVideoTaskCheckpoint: async () => ({ persisted: true }), getVideoTaskCheckpoint: async () => null,
    readManagedImageDataUrl: unexpected, storeGeneratedImage: unexpected, downloadGeneratedMedia: unexpected };
  const engine = new VideoGenerationEngine({ getState: () => state,
    setState: (updater: (current: AppState) => AppState) => { state = updater(state); }, desktop,
    onRuntime: () => {}, pollIntervalMs: 100000, persistState: async () => {} });
  try {
    await engine.resume(existing.id);
    for (let index = 0; index < 30 && !requests.length; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests.length, 1, 'only one original-task query, without automatic generation or another paid POST');
    assert.deepEqual((state.project.generationTasks[0] as VideoGenerationTask).videoJob!.snapshot, before);
  } finally { engine.dispose(); }
}
console.log('RunningHub automatic prompt input contract passed: exact app/profile only, actual counts 1/6, preflight/submission parity, verbatim source once, preserved snapshots, unchanged unknown mappings and query-only frozen-task recovery (zero API calls).');
