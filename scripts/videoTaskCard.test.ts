import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { VideoTaskCardProps } from '../src/components/VideoDirectorView';
import { assetPreviewUrl } from '../src/media';
import { formatUserFacingError } from '../src/userFacingError';
import { formatSafeErrorDiagnostics, getSafeErrorDiagnostics } from '../src/errorDiagnostics';
import { videoProviderErrorDiagnostics, videoTaskDiagnosticEntries, videoTaskErrorOptions } from '../src/videoTaskErrorDiagnostics';
import { TaskErrorDetails, type TaskErrorDetailsProps } from '../src/components/TaskErrorDetails';
import { frozenVideoReferenceAsset } from '../src/videoProvenance';
import { formatVideoElapsed, videoExecutionElapsedMs } from '../src/videoDirectorDraft';
import { videoTailTaskPresentation } from '../src/videoTailReference';
import { canRecoverRunningHubResult, runningHubRemoteSucceeded } from '../src/videoResultRecovery';
import { canRecoverComfyPreviewResult } from '../src/comfyuiVideo';
import type { VideoGenerationTask } from '../src/types';
import { createVideoRuntimeStore } from '../src/videoRuntimeStore';

// Execute the production task card in memory without loading browser CSS or
// starting an Electron/browser session. Only React hooks are inert; the actual
// JSX, predicates, event callbacks and their task-id routing are exercised.
const source = readFileSync(new URL('../src/components/VideoDirectorView.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('VideoDirectorView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = parsed.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'VideoTaskCard'
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) =>
    ['imageRoles', 'imageRoleLabel', 'stageLabels'].includes(entry.name.getText(parsed)))
));
assert.equal(declarations.length, 4, 'the actual task card and its display constants must remain covered');
const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed).replace(/^export\s+/u, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
const dependencies = {
  React,
  useState: <T,>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, () => {}],
  useEffect: () => {},
  useVideoTaskRuntime: (taskId: string, store?: VideoTaskCardProps['runtimeStore'], fallback?: VideoTaskCardProps['runtime']) => store ? store.getTaskSnapshot(taskId) : fallback,
  assetPreviewUrl, formatUserFacingError, frozenVideoReferenceAsset, formatVideoElapsed, videoExecutionElapsedMs, videoTailTaskPresentation,
  canRecoverRunningHubResult, runningHubRemoteSucceeded, canRecoverComfyPreviewResult,
  getSafeErrorDiagnostics, videoTaskDiagnosticEntries, videoTaskErrorOptions, TaskErrorDetails,
};
const TaskCard = new Function(...Object.keys(dependencies), `${compiled}\nreturn VideoTaskCard;`)(...Object.values(dependencies)) as (props: VideoTaskCardProps) => React.ReactElement;

const fixture = (): VideoGenerationTask => ({
  id: 'original-task-id', kind: 'video', storyboardId: 'board-1', targetId: 'fixture', status: 'failed', requestBody: {},
  batchId: 'chain-batch', batchIndex: 1, batchTotal: 3, createdAt: 1, updatedAt: 2,
  videoJob: { stage: 'failed', batchQueueState: 'done', trackingStopped: false,
    preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
    snapshot: { projectId: 'project', clientId: 'client', batchCompletionOrder: true, images: [],
      connection: { backend: 'api' }, draft: { name: '链首段', backend: 'api', prompt: '原始剧情对白', references: [], parameters: {} } } },
});
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<{ children?: React.ReactNode }>(value) ? textOf(value.props.children) : '';
};
const buttons = (value: React.ReactNode): React.ReactElement<{ children?: React.ReactNode; onClick?: () => void; disabled?: boolean }>[] => {
  if (Array.isArray(value)) return value.flatMap(buttons);
  if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void; disabled?: boolean }>(value)) return [];
  return [...(value.type === 'button' ? [value] : []), ...buttons(value.props.children)];
};
const diagnosticBlocks = (value: React.ReactNode): React.ReactElement<TaskErrorDetailsProps>[] => {
  if (Array.isArray(value)) return value.flatMap(diagnosticBlocks);
  if (!React.isValidElement<{ children?: React.ReactNode }>(value)) return [];
  if (value.type === TaskErrorDetails) return [value as React.ReactElement<TaskErrorDetailsProps>];
  return diagnosticBlocks(value.props.children);
};
const render = (task: VideoGenerationTask, runtime?: VideoTaskCardProps['runtime'], runtimeStore?: VideoTaskCardProps['runtimeStore'], assets: VideoTaskCardProps['assets'] = [], knownSecrets?: readonly string[]) => {
  const calls: Array<[string, string]> = [];
  const tree = TaskCard({ task, runtime, runtimeStore, assets, knownSecrets,
    onResume: (id) => { calls.push(['resume', id]); }, onRetryDownload: (id) => { calls.push(['download', id]); },
    onRecoverResult: (id) => { calls.push(['recover', id]); }, onSelectResultVideo: (id, assetId) => { calls.push([`select:${id}`, assetId]); },
    onCancel: (id) => { calls.push(['cancel', id]); }, onReuse: (value) => { calls.push(['reuse', value.id]); } });
  const button = (label: string) => buttons(tree).find((item) => textOf(item.props.children) === label);
  return { calls, button, markup: renderToStaticMarkup(tree), text: textOf(tree), diagnostics: diagnosticBlocks(tree) };
};
let count = 0;
const test = (name: string, run: () => void) => { run(); count += 1; console.log(`ok ${count} - ${name}`); };

test('saved file with project-save error exposes retryDownload even when resultAssetId already exists', () => {
  const value = fixture(); value.status = 'succeeded'; value.resultAssetId = 'saved-video'; value.resultUrl = 'https://example.test/generated.mp4';
  value.videoJob!.stage = 'succeeded'; value.videoJob!.downloadError = '成片已落盘但项目保存失败';
  const card = render(value); assert.ok(card.button('仅重试保存')); assert.equal(card.button('载入相同设置再次生成'), undefined);
  assert.deepEqual(card.calls, []); card.button('仅重试保存')!.props.onClick!();
  assert.deepEqual(card.calls, [['download', value.id]]); assert.match(card.text, /不会重新生成或重复扣费/u);
});

test('partial runtime does not hide a persisted save error', () => {
  const value = fixture(); value.resultAssetId = 'saved-video'; value.resultUrl = 'https://example.test/generated.mp4';
  value.videoJob!.downloadError = '项目保存失败'; value.videoJob!.stage = 'succeeded';
  assert.ok(render(value, { stage: 'succeeded', message: '正在核对项目记录' }).button('仅重试保存'));
});

test('a task card reads only its own live store entry and retains legacy runtime fallback', () => {
  const value = fixture(); value.batchId = undefined; value.videoJob!.snapshot.batchCompletionOrder = undefined;
  const store = createVideoRuntimeStore();
  store.update('another-task', { stage: 'failed', message: '其它任务的错误不应串到本卡' });
  store.update(value.id, { stage: 'downloading', message: '本任务正在保存' });
  const card = render(value, { stage: 'stopped', message: '旧的props状态' }, store);
  assert.match(card.text, /本任务正在保存/u);
  assert.doesNotMatch(card.text, /其它任务的错误|旧的props状态/u);
  store.remove(value.id);
  assert.doesNotMatch(render(value, { stage: 'stopped', message: '旧的props状态' }, store).text, /旧的props状态/u,
    'removing the store entry must not resurrect a stale prop');
  assert.match(render(value, { stage: 'stopped', message: '兼容无store的旧控制器' }).text, /兼容无store的旧控制器/u);
  store.dispose();
});

test('a fully saved video does not offer a redundant save retry', () => {
  const value = fixture(); value.status = 'succeeded'; value.videoJob!.stage = 'succeeded';
  value.resultAssetId = 'saved-video'; value.resultUrl = 'https://example.test/generated.mp4';
  const card = render(value); assert.equal(card.button('仅重试保存'), undefined); assert.ok(card.button('载入相同设置再次生成'));
});

test('chain first segment can continue preparation on original id without trackingStopped', () => {
  const value = fixture(); const card = render(value);
  assert.ok(card.button('继续准备原任务')); assert.equal(card.button('载入相同设置再次生成'), undefined);
  assert.match(card.text, /准备完成后才首次提交/u); card.button('继续准备原任务')!.props.onClick!();
  assert.deepEqual(card.calls, [['resume', value.id]]);
  card.button('取消尚未提交任务')!.props.onClick!(); assert.deepEqual(card.calls[1], ['cancel', value.id]);
});

test('confirmed remote failure never offers single-task regeneration as a way to resume old chain', () => {
  const value = fixture(); value.remoteTaskId = 'failed-remote'; value.videoJob!.preparation!.phase = 'acknowledged';
  value.videoJob!.trackingStopped = true;
  const card = render(value); assert.equal(card.button('继续准备原任务'), undefined);
  assert.equal(card.button('恢复查询原任务'), undefined); assert.equal(card.button('载入相同设置再次生成'), undefined);
  assert.match(card.text, /先取消仍等待的后续段/u); assert.match(card.text, /失败段及所需后续段/u); assert.deepEqual(card.calls, []);
});

test('uncertain submitted chain still exposes querying the original remote task', () => {
  const value = fixture(); value.status = 'unknown'; value.videoJob!.stage = 'submission-unknown'; value.videoJob!.preparation!.phase = 'post-started';
  const card = render(value); assert.ok(card.button('恢复查询原任务')); assert.equal(card.button('继续准备原任务'), undefined);
  card.button('恢复查询原任务')!.props.onClick!(); assert.deepEqual(card.calls, [['resume', value.id]]);
});

test('cancelled local chain cannot continue preparation or create a misleading replacement task', () => {
  const value = fixture(); value.videoJob!.batchQueueState = 'cancelled'; value.videoJob!.stage = 'stopped'; value.videoJob!.trackingStopped = true;
  const card = render(value); assert.equal(card.button('继续准备原任务'), undefined); assert.equal(card.button('恢复查询原任务'), undefined);
  assert.equal(card.button('载入相同设置再次生成'), undefined); assert.equal(card.button('取消尚未提交任务'), undefined);
});

test('explicit cancelled tail phase also blocks resume when queue metadata is older', () => {
  const value = fixture(); value.videoJob!.stage = 'stopped'; value.videoJob!.trackingStopped = true;
  value.videoJob!.tailPreparation = { phase: 'cancelled', revision: 1 };
  const card = render(value); assert.equal(card.button('恢复查询原任务'), undefined); assert.equal(card.button('继续准备原任务'), undefined);
});

test('unknown submit boundary is never presented as an unpaid local preparation retry', () => {
  const value = fixture(); value.status = 'unknown'; value.videoJob!.trackingStopped = true;
  value.videoJob!.batchQueueState = 'cancelled';
  const card = render(value); assert.match(card.text, /提交结果待确认/u);
  assert.equal(card.button('继续准备原任务'), undefined); assert.equal(card.button('取消尚未提交任务'), undefined);
  assert.ok(card.button('恢复查询原任务')); assert.ok(card.button('停止本地追踪'));
});

test('blocked future tail retries original child and ready-tail upload failure continues the same child', () => {
  const value = fixture(); value.videoJob!.snapshot.previousTail = {
    version: 1, predecessorTaskId: 'original-parent', predecessorItemKey: 'board-1:zh', predecessorRequestFingerprint: 'original-fingerprint',
    sequencePlanId: 'plan', predecessorSegmentId: 'segment-1', predecessorSegmentIndex: 1,
    segmentId: 'segment-2', segmentIndex: 2, referenceIndex: 0, referenceRole: 'first-frame', reservedFrameAssetId: 'reserved-frame',
  };
  value.status = 'draft'; value.videoJob!.stage = 'preparing'; value.videoJob!.tailPreparation = { phase: 'blocked', revision: 1, message: '上段项目尚未保存' };
  const blocked = render(value); assert.ok(blocked.button('重试尾帧衔接')); blocked.button('重试尾帧衔接')!.props.onClick!();
  assert.deepEqual(blocked.calls, [['resume', value.id]]); assert.equal(blocked.button('载入相同设置再次生成'), undefined);
  value.status = 'failed'; value.videoJob!.stage = 'failed'; value.videoJob!.tailPreparation.phase = 'ready';
  const ready = render(value); assert.ok(ready.button('继续准备原任务')); ready.button('继续准备原任务')!.props.onClick!();
  assert.deepEqual(ready.calls, [['resume', value.id]]);
  value.status = 'unknown'; value.videoJob!.tailPreparation.phase = 'blocked';
  const uncertain = render(value); assert.equal(uncertain.button('重试尾帧衔接'), undefined); assert.equal(uncertain.button('取消尚未提交任务'), undefined);
});

const aiTailFixture = (): VideoGenerationTask => {
  const value = fixture(); value.batchIndex = 2; value.status = 'running';
  value.videoJob!.stage = 'preparing'; value.videoJob!.batchQueueState = 'active';
  value.videoJob!.snapshot.draft.name = '原链第2段';
  value.videoJob!.snapshot.previousTail = {
    version: 1, predecessorTaskId: 'original-parent', predecessorItemKey: 'board-1:zh', predecessorRequestFingerprint: 'original-fingerprint',
    sequencePlanId: 'plan', predecessorSegmentId: 'segment-1', predecessorSegmentIndex: 1,
    segmentId: 'segment-2', segmentIndex: 2, referenceIndex: 0, referenceRole: 'first-frame', reservedFrameAssetId: 'reserved-frame',
    selectionMode: 'ai-assisted', requireAiSelection: true, aiMaxAttempts: 4,
  };
  value.videoJob!.tailPreparation = { phase: 'extracting', revision: 4,
    message: '正在自动重试 AI 选帧 1/3（输出额度 6000 tokens）…',
    selection: { status: 'started', run: 1, attempt: 2, maxAttempts: 4, maxTokens: 6000 } };
  return value;
};

test('live automatic AI retries expose progress and cancellation without a concurrent manual retry or parent regeneration', () => {
  const value = aiTailFixture();
  for (const [attempt, maxTokens] of [[2, 6000], [3, 12000], [4, 24000]]) {
    value.videoJob!.tailPreparation!.selection = { status: 'started', run: 1, attempt, maxAttempts: 4, maxTokens };
    value.videoJob!.tailPreparation!.message = `正在自动重试 AI 选帧 ${attempt - 1}/3（输出额度 ${maxTokens} tokens）…`;
    const card = render(value);
    assert.ok(card.text.includes(value.videoJob!.tailPreparation!.message!));
    assert.ok(card.button('取消尚未提交任务')); assert.equal(card.button('取消尚未提交任务')!.props.disabled, false);
    assert.equal(card.button('重试 AI 选帧（可能收费）'), undefined);
    assert.equal(card.button('重试尾帧衔接'), undefined); assert.equal(card.button('继续准备原任务'), undefined);
    assert.equal(card.button('载入相同设置再次生成'), undefined); assert.deepEqual(card.calls, []);
    card.button('取消尚未提交任务')!.props.onClick!(); assert.deepEqual(card.calls, [['cancel', value.id]]);
  }
});

test('exhausted AI retry diagnostics retain attempt count and concrete cause, redact secrets and resume only the original child', () => {
  const value = aiTailFixture(); value.status = 'failed'; value.videoJob!.stage = 'failed';
  const secret = 'tail-vision-key-without-standard-prefix';
  const message = `已自动重试 3/3 次；视觉 AI 选帧未完成：模型达到最大输出额度，只返回了思考内容，没有返回选帧正文；${secret}；尚未应用衔接帧，不会自动改用原尾帧。`;
  value.error = message; value.videoJob!.message = message;
  value.videoJob!.tailPreparation = { phase: 'blocked', revision: 9, errorCode: 'ai-selection-failed', message,
    selection: { status: 'started', run: 1, attempt: 4, maxAttempts: 4, maxTokens: 24000 } };
  const before = JSON.stringify(value);
  const card = render(value, undefined, undefined, [], [secret]);
  assert.equal(card.diagnostics.length, 1);
  const props = card.diagnostics[0].props;
  const copied = formatSafeErrorDiagnostics(props.error, { knownSecrets: props.knownSecrets, sensitiveTexts: props.sensitiveTexts });
  for (const shown of [card.markup, copied]) {
    assert.match(shown, /已自动重试 3\/3 次/u); assert.match(shown, /最大输出额度/u);
    assert.match(shown, /思考内容，没有返回选帧正文/u); assert.match(shown, /已脱敏/u);
    assert.doesNotMatch(shown, /tail-vision-key|暂时无法识别具体原因/u);
  }
  assert.match(card.text, /此操作不会重新生成上段/u);
  assert.match(card.text, /最多自动重试3次，含首次最多4次视觉API调用，可能收费/u);
  assert.ok(card.button('重试 AI 选帧（可能收费）')); assert.equal(card.button('继续准备原任务'), undefined);
  assert.equal(card.button('载入相同设置再次生成'), undefined); assert.equal(card.calls.length, 0);
  assert.equal(JSON.stringify(value), before, 'diagnostic rendering never edits the frozen source or saved attempt record');
  card.button('重试 AI 选帧（可能收费）')!.props.onClick!();
  assert.deepEqual(card.calls, [['resume', value.id]]); assert.ok(!card.calls.some(([, id]) => id === 'original-parent'));
});

test('unknown visual-request outcome states why automatic retries stopped without pretending all retries were used', () => {
  const value = aiTailFixture(); value.status = 'failed'; value.videoJob!.stage = 'failed';
  const message = '视觉 AI 选帧等待超时，远端结果未确认，已停止自动重试以免重复计费；尚未应用衔接帧，不会自动改用原尾帧。';
  value.error = message; value.videoJob!.tailPreparation = { phase: 'blocked', revision: 5, message,
    selection: { status: 'started', run: 1, attempt: 1, maxAttempts: 4, maxTokens: 3000 } };
  const card = render(value);
  assert.match(card.markup, /等待超时，远端结果未确认，已停止自动重试以免重复计费/u);
  assert.doesNotMatch(card.markup, /已自动重试 3\/3|自动重试次数已用完/u);
  assert.ok(card.button('重试 AI 选帧（可能收费）')); assert.equal(card.button('载入相同设置再次生成'), undefined);
  assert.deepEqual(card.calls, [], 'display alone must not purchase another visual analysis request');
});

test('normal independent failed tasks keep the explicit reuse workflow', () => {
  const value = fixture(); value.batchId = undefined; value.videoJob!.snapshot.batchCompletionOrder = undefined;
  const card = render(value); assert.ok(card.button('载入相同设置再次生成')); assert.equal(card.button('继续准备原任务'), undefined);
  card.button('载入相同设置再次生成')!.props.onClick!(); assert.deepEqual(card.calls, [['reuse', value.id]]);
});

const comfyPreviewFailure = (): VideoGenerationTask => {
  const value = fixture();
  value.remoteTaskId = 'comfy-original-id'; value.videoJob!.preparation!.phase = 'acknowledged';
  value.videoJob!.snapshot.connection = { backend: 'comfyui', comfyui: { enabled: true, baseUrl: 'https://comfy.invalid' }, workflow: {
    id: 'old-comfy', name: '旧预览误绑', createdAt: 1, updatedAt: 1,
    workflowJson: JSON.stringify({
      '9': { class_type: 'SaveVideo', inputs: {} },
      '10': { class_type: 'SaveAnimatedWEBP', inputs: {} },
      '11': { class_type: 'SaveVideo', inputs: {} },
    }), mapping: { prompt: [], images: [], outputNodeId: '10' },
  } };
  value.response = { status: { completed: true, status_str: 'success' }, outputs: {
    '9': { videos: [{ filename: 'original.mp4' }] }, '10': { images: [{ filename: 'preview.webp' }] },
  } };
  value.error = '工作流已完成，但绑定输出节点没有可播放视频';
  return value;
};

test('old Comfy preview-mapping failure exposes original-task query for both independent and chain tasks', () => {
  for (const independent of [true, false]) {
    const value = comfyPreviewFailure();
    if (independent) { value.batchId = undefined; value.videoJob!.snapshot.batchCompletionOrder = undefined; }
    const card = render(value);
    assert.ok(card.button('恢复查询原任务')); assert.equal(card.button('载入相同设置再次生成'), undefined);
    assert.match(card.text, /视频已生成，待接收/u); assert.match(card.text, /接收已有成片，不会重新生成/u);
    assert.doesNotMatch(card.text, /生成失败|失败段及所需后续段|绑定输出节点没有可播放视频/u);
    card.button('恢复查询原任务')!.props.onClick!(); assert.deepEqual(card.calls, [['resume', value.id]]);
  }
});

test('Comfy preview recovery is unavailable for arbitrary failures, ambiguous outputs and explicit video selections', () => {
  const mutations: Array<(value: VideoGenerationTask) => void> = [
    (value) => { value.remoteTaskId = undefined; },
    (value) => { value.response = { status: { completed: true, status_str: 'error' } }; },
    (value) => { (value.response as { status: { completed: boolean } }).status.completed = false; },
    (value) => { (value.response as { status: { status_str?: string } }).status.status_str = undefined; },
    (value) => { (value.response as { outputs: Record<string, unknown> }).outputs['11'] = { videos: [{ filename: 'other.mp4' }] }; },
    (value) => { delete (value.response as { outputs: Record<string, unknown> }).outputs['9']; },
    (value) => { value.videoJob!.snapshot.connection.workflow!.mapping.outputNodeId = '11'; },
    (value) => { value.videoJob!.snapshot.connection.workflow = undefined; },
    (value) => { value.videoJob!.snapshot.connection.workflow!.workflowJson = 'invalid'; },
    (value) => { value.videoJob!.snapshot.connection.backend = 'api'; },
    (value) => { value.videoJob!.batchQueueState = 'cancelled'; },
    (value) => { value.videoJob!.cancellationPending = true; },
    (value) => { value.resultAssetId = 'already-saved'; },
  ];
  for (const mutate of mutations) {
    const value = comfyPreviewFailure(); mutate(value);
    assert.equal(canRecoverComfyPreviewResult(value), false);
    assert.equal(render(value).button('恢复查询原任务'), undefined);
  }
});

test('old RunningHub failed status with SUCCESS ZIP response offers only original-result recovery as the primary action', () => {
  const value = fixture(); value.remoteTaskId = 'cloud-original-id'; value.videoJob!.preparation!.phase = 'acknowledged';
  value.videoJob!.snapshot.connection.api = { enabled: true, provider: 'runninghub', endpoint: 'https://example.test/run', statusEndpointTemplate: 'https://example.test/query', authHeader: '', authScheme: '', taskIdPath: 'taskId', statusPath: 'status', resultUrlPath: 'results.0.url' };
  value.response = { status: 'SUCCESS', results: [{ outputType: 'zip', url: 'https://example.test/result.zip' }] };
  value.error = 'RunningHub 已完成但旧版未识别 ZIP';
  const card = render(value);
  assert.match(card.text, /云端已成功，待取回成片/u); assert.doesNotMatch(card.text, /生成失败/u);
  card.button('重新获取成片（不重新生成）')!.props.onClick!(); assert.deepEqual(card.calls, [['recover', value.id]]);
});
test('multiple saved videos require an explicit asset choice without mounting players', () => {
  const value = fixture(); value.status = 'succeeded'; value.videoJob!.stage = 'succeeded';
  value.videoJob!.resultAssetIds = ['video-a', 'video-b']; value.videoJob!.resultSelectionRequired = true;
  const card = render(value, undefined, undefined, ['video-a', 'video-b'].map((id) => ({ id, name: id, fileName: `${id}.mp4`, type: 'video', role: 'motion', mediaType: 'video', sourceVideoTaskId: value.id, tags: [], createdAt: 1, updatedAt: 1 })));
  assert.match(card.text, /已保存，待选择成片/u); assert.match(card.text, /自动尾帧衔接会等待/u);
  assert.doesNotMatch(card.markup, /<video\b/u); assert.equal(card.button('载入相同设置再次生成'), undefined);
  card.button('用作本任务成片')!.props.onClick!(); assert.deepEqual(card.calls, [[`select:${value.id}`, 'video-a']]);
});
test('RunningHub queue failure has one clear summary plus raw details instead of duplicate generic lines', () => {
  const value = fixture();
  const raw = 'api queue limit reached, please retry later | API 并发数已达上线，请降低并发或稍后重试';
  value.error = raw; value.videoJob!.message = raw;
  value.response = { errorCode: 'RH_QUEUE_FULL', errorMessage: raw, statusCode: 429, request: { prompt: 'never-render-response-request' },
    failedReason: { node_id: '17', exception_message: 'An untranslated supplemental node failure' } };
  const before = JSON.stringify(value);
  const card = render(value);
  assert.equal(card.diagnostics.length, 1);
  assert.equal((card.markup.match(/class="task-error-summary"/gu) || []).length, 1);
  assert.match(card.markup, /接口并发生成数量已达上限，请等待正在运行的任务完成后再试/u);
  assert.match(card.markup, /查看错误详情/u); assert.match(card.markup, /复制错误详情/u);
  assert.match(card.markup, /api queue limit reached/u); assert.match(card.markup, /RH_QUEUE_FULL/u); assert.match(card.markup, /HTTP 状态：429/u);
  assert.doesNotMatch(card.markup, /暂时无法识别具体原因|余额|充值|never-render-response-request/u);
  assert.match(card.markup, /An untranslated supplemental node failure/u, 'node details remain available without degrading the main summary');
  assert.match(formatUserFacingError(card.diagnostics[0].props.summaryError), /接口并发生成数量已达上限/u);
  assert.deepEqual(card.calls, [], 'rendering and collapsed diagnostics have no retry/submission side effects');
  assert.equal(JSON.stringify(value), before, 'display never rewrites saved task originals');
});

test('legacy generic error does not hide the actual provider primary reason in the compact summary', () => {
  const value = fixture(); value.error = '操作失败，暂时无法识别具体原因。'; value.videoJob!.message = '视频接口报告任务失败';
  value.response = { errorCode: 'RH_QUEUE_FULL', errorMessage: 'api queue limit reached, please retry later',
    failedReason: { node_id: '17', exception_message: 'Unknown supplemental node cause' } };
  const card = render(value);
  const summary = formatUserFacingError(card.diagnostics[0].props.summaryError);
  assert.match(summary, /接口并发生成数量已达上限/u); assert.doesNotMatch(summary, /未识别|暂时无法/u);
  assert.match(card.markup, /Unknown supplemental node cause/u); assert.deepEqual(card.calls, []);
});

test('unknown English response and nested node failure remain inspectable without request/traceback fields', () => {
  const value = fixture();
  value.videoJob!.message = '视频接口报告任务失败';
  value.response = {
    errorCode: 805, errorMessage: 'Previously unseen vendor failure',
    failedReason: JSON.stringify({ node_id: '31', node_type: 'VideoSampler', exception_type: 'VendorError',
      exception_message: 'Unable to complete frame processing', current_inputs: { unrelatedName: 'private-node-input' },
      traceback: ['private-trace-line'], current_outputs: ['private-output-pixels'] }),
    requestBody: { ignored: 'private-full-request' }, unexpected: 'private-unrecognized-field',
  };
  const card = render(value); assert.equal(card.diagnostics.length, 1);
  const detail = renderToStaticMarkup(card.diagnostics[0]);
  assert.match(detail, /Previously unseen vendor failure/u); assert.match(detail, /Unable to complete frame processing/u);
  assert.match(detail, /节点：31/u); assert.match(detail, /VideoSampler/u); assert.match(detail, /VendorError/u); assert.match(detail, /错误码：805/u);
  assert.doesNotMatch(detail, /private-node-input|private-trace-line|private-output-pixels|private-full-request|private-unrecognized-field/u);
  assert.deepEqual(card.calls, []);
});

test('credentials, original draft and workflow-specific prompts are redacted in both summary and copy diagnostics', () => {
  const value = fixture();
  const originalPrompt = '一段不应出现在报错详情里的私人剧情';
  const nodePrompt = 'A private converted narrative for node seventeen';
  const secret = 'runninghub-key-without-standard-prefix';
  value.videoJob!.snapshot.draft.prompt = originalPrompt;
  value.requestBody = { nodeInfoList: [{ fieldValue: nodePrompt }], headers: { apiKey: secret } };
  value.error = `Unknown failure: ${originalPrompt}; ${nodePrompt}; ${secret}`;
  value.response = { errorMessage: encodeURIComponent(originalPrompt), errorCode: 'VENDOR_TEST' };
  const card = render(value, undefined, undefined, [], [secret]);
  assert.equal(card.diagnostics.length, 1);
  const props = card.diagnostics[0].props;
  const copied = formatSafeErrorDiagnostics(props.error, { knownSecrets: props.knownSecrets, sensitiveTexts: props.sensitiveTexts });
  const detail = renderToStaticMarkup(card.diagnostics[0]);
  for (const shown of [copied, detail]) {
    assert.doesNotMatch(shown, /私人剧情|private converted|runninghub-key|%E4%B8%80/u);
    assert.match(shown, /已脱敏/u); assert.match(shown, /VENDOR_TEST/u);
  }
  assert.deepEqual(card.calls, [], 'inspection/copy formatting never calls a generation callback');
});

test('download errors do not repeat identical task/runtime errors, while distinct action reasons are retained', () => {
  const value = fixture(); value.status = 'succeeded'; value.videoJob!.stage = 'succeeded';
  value.error = '本地磁盘 ENOSPC'; value.videoJob!.message = value.error; value.videoJob!.downloadError = value.error;
  const card = render(value);
  assert.equal(card.diagnostics.length, 1); assert.match(card.text, /保存失败原因/u);
  assert.match(card.markup, /磁盘空间不足/u); assert.match(card.text, /不会重新生成或重复扣费/u);
  const entries = videoTaskDiagnosticEntries({ task: value, failed: false, message: value.error, downloadError: value.error,
    actionError: Object.assign(new Error('Unable to reveal file'), { code: 'REVEAL_FAILED' }) }, videoTaskErrorOptions(value));
  assert.equal(entries.length, 2); assert.equal(entries[1].key, 'action'); assert.equal(entries[1].error.code, 'REVEAL_FAILED');
  const different = videoTaskDiagnosticEntries({ task: { ...value, error: '任务记录保存失败' }, failed: false,
    downloadError: '下载连接已断开', actionError: '任务记录保存失败' }, videoTaskErrorOptions(value));
  assert.deepEqual(different.map((entry) => entry.key), ['generation', 'download']);
});

test('provider diagnostics are bounded, immutable and never call getters/toJSON or open raw JSON payloads', () => {
  let accessed = 0;
  const response = Object.defineProperty({ errorMessage: 'Unhandled vendor error', code: 'VENDOR_TEST',
    failedReason: '{"current_inputs":{"prompt":"private-malformed"}',
    toJSON() { accessed += 1; return 'private-toJSON'; } }, 'requestBody', { get() { accessed += 1; throw new Error('must not read'); } });
  Object.defineProperty(response, 'data', { get() { accessed += 1; throw new Error('must not read'); } });
  const result = videoProviderErrorDiagnostics(response);
  assert.match(result!.message, /Unhandled vendor error/u);
  assert.doesNotMatch(JSON.stringify(result), /private-malformed|private-toJSON/u); assert.equal(accessed, 0);
  const cyclic: { errorMessage: string; response?: unknown } = { errorMessage: 'Cycle-safe diagnostic' }; cyclic.response = cyclic;
  assert.doesNotThrow(() => videoProviderErrorDiagnostics(cyclic));
  assert.equal(videoProviderErrorDiagnostics({ unrelated: 'must not display' }), undefined);
});

test('stopping local tracking is not remote completion and does not expose another paid generation action', () => {
  const value = fixture(); value.status = 'running'; value.remoteTaskId = 'still-running';
  value.batchId = undefined; value.videoJob!.snapshot.batchCompletionOrder = undefined;
  value.videoJob!.stage = 'stopped'; value.videoJob!.trackingStopped = true;
  const card = render(value);
  assert.match(card.text, /已停止追踪，远端结果待确认/u); assert.match(card.text, /占用生成名额/u);
  assert.equal(card.button('载入相同设置再次生成'), undefined); assert.ok(card.button('恢复查询原任务'));
  assert.deepEqual(card.calls, []);
});
console.log(`videoTaskCard: ${count} component recovery/diagnostic checks passed`);
