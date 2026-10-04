import assert from 'node:assert/strict';
import {
  assertRunningHubTemplateNumbersSafe,
  buildVideoApiBody,
  defaultRunningHubVideoApi,
  isRunningHubUploadedFile,
  parseVideoApiResult,
  runningHubVideoResult,
  runningHubVideoResults,
  videoApiSubmitEndpoint,
} from '../src/videoGenerationApi';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';
import { compileRunningHubVideoApi, createRunningHubTutorialVideoWorkflow } from '../src/runningHubVideo';

const draft: VideoGenerationDraft = {
  name: '云端工作流测试', backend: 'api', prompt: '镜头平移，角色说：“到了。”轻声背景音乐。',
  references: [{ assetId: 'frame', role: 'first-frame' }], parameters: {},
};
const template = JSON.stringify({
  nodeInfoList: [
    { nodeId: '138', fieldName: 'value', fieldValue: '{{prompt}}' },
    { nodeId: '137', fieldName: 'image', fieldValue: '{{image_1}}' },
    { nodeId: '160', fieldName: 'value', fieldValue: 'false' },
    { nodeId: '132', fieldName: 'value', fieldValue: '12' },
    { nodeId: '321', fieldName: 'seed', fieldValue: '2084261333662810113' },
  ],
  instanceType: 'default', usePersonalQueue: false,
});
const config = { ...defaultRunningHubVideoApi, runningHubAppId: '2084261333662810113', requestTemplate: template,
  runningHubImageRoles: ['first-frame' as const],
};

assert.equal(videoApiSubmitEndpoint(config), 'https://www.runninghub.ai/openapi/v2/run/ai-app/2084261333662810113');
assert.equal(videoApiSubmitEndpoint({ ...config, endpoint: 'https://www.runninghub.cn/openapi/v2/run/workflow/1923539279828742146' }), 'https://www.runninghub.cn/openapi/v2/run/workflow/1923539279828742146');
assert.equal(videoApiSubmitEndpoint({ ...config, runningHubAppId: '' }), '', 'missing cloud ID cannot silently use another endpoint');
const body = buildVideoApiBody(config, draft, ['openapi/uploaded-reference.png']);
assert.deepEqual(body, {
  ...JSON.parse(template),
  nodeInfoList: JSON.parse(template).nodeInfoList.map((item: { nodeId: string }) => item.nodeId === '138'
    ? { ...item, fieldValue: draft.prompt }
    : item.nodeId === '137' ? { ...item, fieldValue: 'openapi/uploaded-reference.png' } : item),
});
const noImages = buildVideoApiBody(config, { ...draft, references: [] }, []);
assert.equal((noImages.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>).find((node) => node.nodeId === '137')?.fieldValue, '', 'legacy templates clear unused image placeholders instead of requiring a full set');
assert.doesNotThrow(() => buildVideoApiBody(config, { ...draft, references: [{ assetId: 'frame', role: 'last-frame' }] }, ['openapi/ref.png']), 'an explicitly mapped first frame accepts the user-selected original image regardless of its asset category');
const ordinaryRoleMismatch = buildVideoApiBody(
  { ...config, runningHubImageRoles: ['character'] },
  { ...draft, references: [{ assetId: 'frame', role: 'composition' }] },
  ['openapi/ref.png'],
);
assert.equal(
  (ordinaryRoleMismatch.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>)
    .find((node) => node.nodeId === '137')?.fieldValue,
  'openapi/ref.png',
  'a segment-level purpose mismatch is warning-only; the selected image still reaches its physical slot',
);
assert.doesNotThrow(() => buildVideoApiBody({ ...config, runningHubImageRoles: ['general'] }, draft, ['openapi/ref.png']));
assert.throws(() => buildVideoApiBody({ ...config, runningHubImageRoles: [], requestTemplate: '{"nodeInfoList": [{"nodeId":"138","fieldName":"value","fieldValue":"{{prompt}}"}], "seed":2084261333662810113}' }, { ...draft, references: [] }, []), /安全精度/u);
assert.throws(() => assertRunningHubTemplateNumbersSafe('{"seed":2084261333662810113}'), /安全精度/u);
assert.throws(() => assertRunningHubTemplateNumbersSafe('{"value":1e1000}'), /安全精度/u);
assert.doesNotThrow(() => assertRunningHubTemplateNumbersSafe('{"seed":"2084261333662810113", "value":0.6000000000000001,"negative":-8,"safe":9007199254740991}'));
assert.doesNotThrow(() => assertRunningHubTemplateNumbersSafe('{"text":"引号\\\"2084261333662810113\\\"保持"}'));
for (const value of ['openapi/reference.png', 'api/a-b_01.png', 'reference.png', 'folder/角色.png', 'https://cdn.example.test/reference.png']) {
  assert.equal(isRunningHubUploadedFile(value), true, value);
}
for (const value of ['', '../reference.png', '/local/path.png', 'C:\\reference.png', 'file:///C:/reference.png', 'data:image/png;base64,AA', 'api/../ref.png', 'api/%2e%2e/ref.png', 'api\\ref.png', 'api//ref.png', 'api/ref.png\n']) {
  assert.equal(isRunningHubUploadedFile(value), false, value);
}
assert.equal(defaultRunningHubVideoApi.imageUploadUrlPath, 'data.fileName', 'Comfy input requires upload fileName, not model download_url');

const mappedWorkflow = createRunningHubTutorialVideoWorkflow();
mappedWorkflow.requestTemplate = JSON.stringify({ ...JSON.parse(mappedWorkflow.requestTemplate), untouched: '{{prompt}} / {{duration}} / {{image_1}}' });
const mappedApi = compileRunningHubVideoApi({ enabled: true, baseUrl: 'https://www.runninghub.ai', apiKey: '', workflows: [mappedWorkflow], activeWorkflowId: mappedWorkflow.id }, mappedWorkflow.id, { duration: 8 });
const mappedRequest = buildVideoApiBody(mappedApi, { ...draft, parameters: { duration: 9 } }, ['openapi/ref.png']);
assert.equal(mappedRequest.untouched, '{{prompt}} / {{duration}} / {{image_1}}', 'transport must leave unbound literal placeholders untouched');
const mappedNodes = mappedRequest.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
assert.equal(mappedNodes.find((node) => node.nodeId === '132')?.fieldValue, '9', 'frozen metadata rebinds explicit parameter edits');
const defaults = buildVideoApiBody(mappedApi, draft, ['openapi/ref.png']).nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>;
assert.equal(defaults.find((node) => node.nodeId === '132')?.fieldValue, '12', 'clearing task overrides restores original workflow defaults');
assert.throws(() => buildVideoApiBody(mappedApi, { ...draft, parameters: { unmappedSeed: 7 } }, ['openapi/ref.png']), /尚未绑定/u);
assert.throws(() => buildVideoApiBody(mappedApi, { ...draft, parameters: { duration: Number.MAX_SAFE_INTEGER + 1 } }, ['openapi/ref.png']), /安全|精度/u);

const preview = { nodeId: '2', outputType: 'png', url: 'https://cdn.example.test/preview.png' };
const video = { nodeId: '328', outputType: 'mp4', url: 'https://cdn.example.test/result.mp4?signature=test' };
const report = { taskId: '2013508786110730241', status: 'SUCCESS', errorCode: '', errorMessage: '', results: [preview, video] };
assert.equal(parseVideoApiResult(report, config).resultUrl, video.url, 'bare mp4 outputType must win over preceding PNG');
assert.equal(parseVideoApiResult({ ...report, results: [preview, { ...video, outputType: 'video/h264-mp4' }] }, config).resultUrl, video.url);
assert.equal(parseVideoApiResult({ ...report, results: [{ ...video, outputType: '', url: 'https://cdn.example.test/view?filename=final.MP4' }] }, config).status, 'succeeded');
assert.equal(parseVideoApiResult({ ...report, results: [{ ...video, outputType: 'mp4', url: 'https://cdn.example.test/opaque-download' }] }, config).status, 'succeeded');
assert.equal(parseVideoApiResult({ ...report, results: [{ ...video, outputType: 'png' }] }, config).resultUrl, undefined, 'declared image is not reclassified from a misleading URL suffix');
assert.ok(parseVideoApiResult({ ...report, results: [{ ...video, outputType: 'mp4', url: 'file:///C:/output.mp4' }] }, config).downloadError);
for (const results of [[preview], [{ outputType: 'txt', text: 'done', url: 'https://cdn.example.test/result.txt' }], [], null]) {
  const parsed = parseVideoApiResult({ ...report, results }, config);
  assert.equal(parsed.status, 'succeeded', 'provider success must not become local generation failure');
  assert.ok(parsed.downloadError, 'missing output is a recoverable receipt issue');
  assert.equal(parsed.resultUrl, undefined, 'no fallback to non-video first result');
  assert.match(parsed.message!, /未返回可下载的视频/u);
}
assert.equal(parseVideoApiResult(report, { ...config, runningHubOutputNodeIds: ['328'] }).resultUrl, video.url);
assert.ok(parseVideoApiResult(report, { ...config, runningHubOutputNodeIds: ['missing-final'] }).downloadError, 'explicit final-node selection may not fall back to another output');
const selectedError = parseVideoApiResult({ ...report, results: [preview] }, { ...config, runningHubOutputNodeIds: ['2'] });
assert.match(selectedError.message!, /指定输出节点/u);
for (const status of ['QUEUED', 'RUNNING']) {
  const parsed = parseVideoApiResult({ ...report, status }, config);
  assert.equal(parsed.status, status === 'QUEUED' ? 'submitted' : 'running');
  assert.equal(parsed.resultUrl, undefined, 'partial outputs are not final completion');
}
const failed = parseVideoApiResult({ ...report, status: 'FAILED', errorMessage: '节点138不存在' }, config);
assert.equal(failed.status, 'failed');
assert.equal(failed.resultUrl, undefined, 'failure must not be overwritten by a result URL');
assert.match(failed.message!, /节点138/u);
assert.equal(parseVideoApiResult({ ...report, errorCode: 'INVALID_NODE' }, config).status, 'failed');
assert.equal(parseVideoApiResult({ code: 401, message: 'Invalid key' }, config).status, 'failed');
assert.equal(parseVideoApiResult({ ...report, errorCode: 0, code: 0 }, config).status, 'succeeded');

const zip = { nodeId: '186', outputType: 'zip', url: 'https://cdn.example.test/输出视频.zip?signature=test' };
const testOnlyZip = { nodeId: '203', outputType: 'zip', url: 'https://cdn.example.test/test-only.zip' };
const multiOutput = { ...report, results: [testOnlyZip, zip, { nodeId: '229', outputType: 'txt', url: 'https://cdn.example.test/prompt.txt' }] };
assert.deepEqual(runningHubVideoResults(multiOutput), [
  { resultUrl: testOnlyZip.url, archiveHint: true, nodeId: '203' },
  { resultUrl: zip.url, archiveHint: true, nodeId: '186' },
], 'all ZIP candidates survive enumeration; only the receiver knows which contains video');
assert.deepEqual(runningHubVideoResults(multiOutput, ['186']), [{ resultUrl: zip.url, archiveHint: true, nodeId: '186' }]);
assert.deepEqual(runningHubVideoResults(multiOutput, ['missing']), [], 'never leave the explicitly selected output nodes');
assert.deepEqual(runningHubVideoResults({ ...report, results: [testOnlyZip, video, zip, { ...zip, nodeId: 'duplicate' }, preview] }).map((item) => item.resultUrl), [video.url, testOnlyZip.url, zip.url], 'prefer direct videos and deduplicate identical addresses without guessing filenames');
assert.deepEqual(runningHubVideoResult(multiOutput), { resultUrl: testOnlyZip.url, archiveHint: true }, 'the legacy first-candidate accessor keeps its public shape');
assert.deepEqual(runningHubVideoResults({ results: null }), []);
const text = { nodeId: '187', outputType: 'txt', url: 'https://cdn.example.test/prompt.txt' };
const zipResult = parseVideoApiResult({ ...report, results: [text, preview, zip] }, config);
assert.equal(zipResult.status, 'succeeded');
assert.equal(zipResult.stage, 'downloading');
assert.equal(zipResult.resultUrl, zip.url);
assert.equal(zipResult.archiveHint, true);
assert.equal(parseVideoApiResult({ ...report, results: [zip, video] }, config).resultUrl, video.url, 'direct video wins over ZIP');
assert.equal(parseVideoApiResult({ ...report, results: [zip, video] }, { ...config, runningHubOutputNodeIds: ['186'] }).resultUrl, zip.url, 'explicit ZIP node wins over unselected video');
assert.equal(parseVideoApiResult({ ...report, results: [{ ...zip, outputType: 'application/zip', url: 'https://cdn.example.test/opaque' }] }, config).archiveHint, true);
assert.equal(parseVideoApiResult({ ...report, results: [{ ...zip, outputType: '', url: 'https://cdn.example.test/download?filename=video.ZIP' }] }, config).archiveHint, true);
assert.equal(parseVideoApiResult({ ...report, results: [{ ...zip, outputType: 'txt' }] }, config).resultUrl, undefined, 'misleading ZIP suffix cannot bypass declared text');
assert.equal(parseVideoApiResult({ ...report, status: 'RUNNING', results: [zip] }, config).resultUrl, undefined);
assert.equal(parseVideoApiResult({ ...report, status: 'FAILED', results: [zip] }, config).resultUrl, undefined);

console.log('RunningHub video protocol tests passed: cloud fileName uploads, quoted 64-bit IDs, exact node/role mapping, MP4 selection, pending/failed/empty results and no first-image fallback');
