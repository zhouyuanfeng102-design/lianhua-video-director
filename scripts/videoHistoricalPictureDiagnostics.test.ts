import assert from 'node:assert/strict';
import { videoTaskDiagnosticEntries, videoTaskErrorOptions } from '../src/videoTaskErrorDiagnostics';
import type { VideoGenerationTask } from '../src/types';

const strictError = (numbers: number[], count: number) => `MiniMax H3 prompt media tag validation failed: ${numbers.map((number) => `<Picture ${number}> is not connected; available picture count is ${count}`).join('; ')}. Connect the referenced media, correct the ordinal, or disable strict_prompt_tags to treat it as plain prompt text.`;
const fixture = (count = 6, remote = [7, 8, 9]): VideoGenerationTask => {
  const references = Array.from({ length: count }, (_, index) => ({ assetId: `synthetic-image-${index + 1}`, role: 'general' as const, slotIndex: index }));
  return {
    id: 'synthetic-historical-task', kind: 'video', storyboardId: 'synthetic-board', targetId: 'synthetic-cloud', status: 'failed', remoteTaskId: 'synthetic-remote-task', error: 'RunningHub 任务失败', requestBody: {}, createdAt: 1, updatedAt: 2,
    response: { code: 805, msg: '工作流运行失败', data: { failedReason: JSON.stringify({ node_id: '498', node_name: 'MiniMaxH3AudioConditioningT8', exception_type: 'ValueError', exception_message: strictError(remote, count), current_inputs: { prompt: 'PRIVATE_REMOTE_PROMPT', apiKey: 'PRIVATE_KEY' }, traceback: ['PRIVATE_TRACEBACK'] }) } },
    videoJob: { stage: 'failed', preparation: { version: 1, phase: 'acknowledged', uploadedImages: references.map((_, index) => `synthetic-upload-${index + 1}.png`) }, snapshot: { projectId: 'synthetic-project', clientId: 'synthetic-client', draft: { name: '合成历史任务', backend: 'api', prompt: `PRIVATE_LOCAL_BODY ${Array.from({ length: count - 1 }, (_, index) => `<Picture ${index + 2}>`).join(' ')}`, references, parameters: {} }, connection: { backend: 'api', api: { enabled: true, provider: 'runninghub', model: 'synthetic-cloud', endpoint: 'https://synthetic.invalid/openapi/v2/run/ai-app/2104753059472990209', runningHubAppId: '2104753059472990209', statusEndpointTemplate: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url', errorPath: 'errorMessage', requestTemplate: '', runningHubMappedFields: [{ nodeId: '456', fieldName: 'text', kind: 'prompt' }, ...references.map((_, index) => ({ nodeId: `synthetic-node-${index}`, fieldName: 'image', kind: 'image' as const, imageIndex: index })), { nodeId: '827', fieldName: 'value', kind: 'image-count', imageCountMode: 'prefix', imageCountSource: 'verified-app', originalValue: String(count) }] } }, images: references.map((reference) => ({ ...reference, name: '合成图片', freezeState: 'frozen', frozenAt: 1 })) } },
  };
};
const diagnostic = (task: VideoGenerationTask) => videoTaskDiagnosticEntries({ task, failed: true }, videoTaskErrorOptions(task, ['PRIVATE_KEY']))[0];
let groups = 0;
const check = (name: string, action: () => void) => { action(); groups += 1; console.log(`PASS ${name}`); };

check('真实T8例文与冻结6图上传证明显示云端后续编号差异并保留805和历史任务', () => {
  const task = fixture(); const original = JSON.stringify(task); const result = diagnostic(task);
  assert.equal(result.error.code, '805'); assert.equal(result.summaryError?.code, '805');
  assert.match(result.error.message, /MiniMax H3 prompt media tag validation failed/u);
  assert.match(result.error.message, /本地已提交 6 张图片.*<Picture 2>.*<Picture 6>/u);
  assert.match(result.error.message, /云端后续处理.*<Picture 7>.*<Picture 8>.*<Picture 9>.*可用图片数 6/u);
  assert.match(result.summaryError!.message, /直接接收最终 H3 正文的工作流/u);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LOCAL_BODY|PRIVATE_REMOTE_PROMPT|PRIVATE_KEY|PRIVATE_TRACEBACK/u);
  assert.equal(task.remoteTaskId, 'synthetic-remote-task'); assert.equal(JSON.stringify(task), original);
});

check('图片数量与Image/Picture别名来自证据，不硬编码6张或7至9号', () => {
  const task = fixture(3, [4]); task.videoJob!.snapshot.draft.prompt = 'PRIVATE_LOCAL_BODY <Image1> and Picture #2';
  const message = diagnostic(task).error.message;
  assert.match(message, /本地已提交 3 张图片.*<Picture 1>.*<Picture 2>/u);
  assert.match(message, /云端后续处理.*<Picture 4>.*可用图片数 3/u);
  assert.doesNotMatch(message, /本地已提交 6 张|<Picture [789]>/u);
});

check('缺上传或映射证明、未提交、非失败、本地原稿含越界编号时不推断云端原因', () => {
  const cases: Array<(task: VideoGenerationTask) => void> = [
    (task) => { task.videoJob!.preparation = undefined; },
    (task) => { task.videoJob!.preparation!.phase = 'preparing'; },
    (task) => { task.videoJob!.preparation!.uploadedImages.pop(); },
    (task) => { task.videoJob!.preparation!.uploadedImages[0] = null; },
    (task) => { task.videoJob!.snapshot.images[0].freezeState = 'pending'; },
    (task) => { task.videoJob!.snapshot.images[0].assetId = 'mismatched-image'; },
    (task) => { task.videoJob!.snapshot.draft.references[1].slotIndex = 3; },
    (task) => { task.videoJob!.snapshot.connection.api!.runningHubMappedFields!.find((field) => field.kind === 'image-count')!.imageCountMode = undefined; },
    (task) => { task.videoJob!.snapshot.connection.api!.runningHubMappedFields!.find((field) => field.kind === 'image-count')!.imageCountSource = undefined; },
    (task) => { task.videoJob!.snapshot.connection.api!.provider = 'generic'; },
    (task) => { task.remoteTaskId = undefined; },
    (task) => { task.status = 'succeeded'; },
    (task) => { task.videoJob!.snapshot.draft.prompt += ' quoted literal "Picture9"'; },
  ];
  for (const mutate of cases) { const task = fixture(); mutate(task); assert.doesNotMatch(diagnostic(task).error.message, /历史提交核对|云端后续处理/u); }
});

check('错误类型、远端可用数或编号不符及非白名单输入不能建立诊断证据', () => {
  for (const response of [
    { failedReason: { node_name: 'UnrelatedNode', exception_message: strictError([7], 6) } },
    { failedReason: { node_name: 'MiniMaxH3AudioConditioningT8', exception_message: 'An unrelated image operation failed' } },
    { failedReason: { node_name: 'MiniMaxH3AudioConditioningT8', exception_message: strictError([7], 5) } },
    { failedReason: { node_name: 'MiniMaxH3AudioConditioningT8', exception_message: strictError([2], 6) } },
    { failedReason: { node_name: 'MiniMaxH3AudioConditioningT8', current_inputs: { exception_message: strictError([7], 6) } } },
  ]) { const task = fixture(); task.response = response; assert.doesNotMatch(diagnostic(task).error.message, /历史提交核对|云端后续处理/u); }
  let readInputs = false; const reason = { node_name: 'MiniMaxH3AudioConditioningT8', exception_message: strictError([7, 8, 9], 6) };
  Object.defineProperty(reason, 'current_inputs', { get: () => { readInputs = true; throw new Error('must not inspect provider inputs'); } });
  Object.defineProperty(reason, 'traceback', { get: () => { readInputs = true; throw new Error('must not inspect provider traceback'); } });
  const task = fixture(); task.response = { code: 805, failedReason: reason };
  assert.match(diagnostic(task).error.message, /历史提交核对/u); assert.equal(readInputs, false);
});

console.log(`Historical picture diagnostics passed: ${groups} focused groups, synthetic only, no API calls.`);
