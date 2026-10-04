import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { isImageGenerationTask, isVideoGenerationTask, isAutofillGenerationTask, isVisibleGenerationTask } from '../src/generationTasks';
import { videoTaskBatchStatus } from '../src/videoTaskBatchStatus';
import { runningHubRemoteSucceeded } from '../src/videoResultRecovery';
import { formatUserFacingError } from '../src/userFacingError';
import { videoTaskHasUnresolvedSubmission } from '../src/videoGenerationQueue';
import { inspectVideoBatchDeletion } from '../src/videoBatchDeletion';

// Run the actual task-center JSX and event handlers. Hooks/controller I/O are
// isolated; there is no desktop profile, network call or real paid generation.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = parsed.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'GenerationTasksView'
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => entry.name.getText(parsed) === 'videoTaskCanStopBeforeSubmit'));
assert.equal(nodes.length, 2);
const compiled = ts.transpileModule(nodes.map((node) => node.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
type Node = React.ReactElement<{ children?: React.ReactNode; [key: string]: any }>;
const children = (node: React.ReactNode): Node[] => Array.isArray(node) ? node.flatMap(children)
  : React.isValidElement(node) ? [node as Node, ...children((node as Node).props.children)] : [];
const text = (node: React.ReactNode): string => Array.isArray(node) ? node.map(text).join('')
  : React.isValidElement(node) ? text((node as Node).props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const empty = () => null;
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>((done) => { resolve = done; }); return { resolve, promise }; };
const fixture = () => {
  let state = createInitialState();
  state.project.id = 'continue-ui-project';
  state.project.generationTasks = ['succeeded', 'failed', 'draft'].map((status, index) => ({
    id: `task-${index + 1}`, kind: 'video', batchId: 'batch-original', batchIndex: index + 1, batchLabel: '原始批次', status,
    storyboardId: `board-${index + 1}`, targetId: 'api', requestBody: {}, createdAt: index + 1, updatedAt: index + 1,
    ...(index === 0 ? { resultAssetId: 'completed-video' } : {}),
    videoJob: { stage: index === 0 ? 'succeeded' : index === 1 ? 'failed' : 'stopped',
      ...(index === 2 ? { batchQueueState: 'cancelled', preparation: { version: 1, phase: 'preparing' }, trackingStopped: true } : {}),
      snapshot: { projectId: state.project.id, clientId: `client-${index + 1}`, batchCompletionOrder: true, images: [],
        draft: { name: `第${index + 1}段`, prompt: `冻结原提示词${index + 1}`, backend: 'api', references: [], parameters: {}, source: { storyboardId: `board-${index + 1}`, sequencePlanId: 'plan', segmentId: `segment-${index + 1}` } },
        connection: { backend: 'api' } },
    },
  })) as any;
  const plan = { id: 'opaque-plan', batchId: 'batch-original', projectId: state.project.id, label: '续跑',
    items: [{ taskId: 'task-2', name: '第2段', segmentIndex: 2, reason: 'failed', willRegenerate: true },
      { taskId: 'task-3', name: '第3段', segmentIndex: 3, reason: 'cancelled', willRegenerate: false }],
    completedTaskIds: ['task-1'], requiresAiTail: false };
  const reply = { batchId: 'batch-original', resumedTaskIds: [], completedTaskIds: ['task-1'], waitingTaskIds: [], issues: [], continuation: plan };
  const calls = { preview: [] as string[], confirm: [] as Array<{ id: string; signal: AbortSignal }> };
  let resume = async () => reply as any;
  let confirm = async () => ({ batchId: 'new-batch', taskIds: ['new-2', 'new-3'], skipped: [] });
  const hooks: any[] = []; let cursor = 0; let dirty = false;
  const dependencies: Record<string, any> = {
    React, Fragment: React.Fragment,
    useState: (initial: any) => { const at = cursor++; if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial;
      return [hooks[at], (value: any) => { const next = typeof value === 'function' ? value(hooks[at]) : value; if (!Object.is(next, hooks[at])) { hooks[at] = next; dirty = true; } }]; },
    useRef: (initial: any) => { const at = cursor++; if (!(at in hooks)) hooks[at] = { current: initial }; return hooks[at]; },
    useEffect: (effect: () => (() => void) | undefined, deps: any[]) => { const at = cursor++; const previous = hooks[at];
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        previous?.cleanup?.(); hooks[at] = { deps, cleanup: effect() };
      } },
    useVideoRuntimes: () => ({}), isImageGenerationTask, isVideoGenerationTask, isAutofillGenerationTask, isVisibleGenerationTask,
    videoTaskBatchStatus, runningHubRemoteSucceeded, formatUserFacingError, videoTaskHasUnresolvedSubmission, inspectVideoBatchDeletion,
    VideoExecutionControls: 'aside',
    Card: 'section', Button: 'button', Badge: 'span', Empty: 'aside', SectionHeading: 'header', VideoTaskCard: 'article',
  };
  for (const name of ['ImageIcon', 'Film', 'FileText', 'Play', 'ChevronUp', 'ChevronDown', 'X', 'Trash2']) dependencies[name] = empty;
  const View = new Function(...Object.keys(dependencies), `${compiled}\nreturn GenerationTasksView;`)(...Object.values(dependencies));
  const ctx = { state, setState: empty, storyboardImageBatchLifecycle: {}, setView: empty, notify: empty,
    getCurrentState: () => state, videoController: {
      runtimeById: {}, resumeBatch: async (id: string) => { calls.preview.push(id); return resume(); },
      confirmContinueBatch: async (id: string, signal: AbortSignal) => { calls.confirm.push({ id, signal }); return confirm(); },
    } };
  let tree: React.ReactNode;
  const render = () => { do { dirty = false; cursor = 0; ctx.state = state; tree = View(ctx); } while (dirty); return tree; };
  const button = (label: string) => { const found = children(render()).find((node) => node.type === 'button' && text(node.props.children) === label); assert.ok(found, label); return found; };
  const click = async (label: string) => { const target = button(label); assert.equal(Boolean(target.props.disabled), false); await target.props.onClick(); await Promise.resolve(); await Promise.resolve(); render(); };
  return { calls, reply, plan, render, button, click, get text() { return text(render()); },
    get deletionNote() { return children(render()).find((node) => node.props['data-video-batch-delete-reason'] !== undefined); },
    updateTask: (id: string, update: (task: any) => any) => {
      state = { ...state, project: { ...state.project, generationTasks: state.project.generationTasks.map((task) => task.id === id ? update(task) : task) } }; render();
    },
    setResume: (callback: typeof resume) => { resume = callback; },
    setConfirm: (callback: typeof confirm) => { confirm = callback; }, switchProject: () => { state = { ...state, project: { ...state.project, id: 'other-project' } }; render(); } };
};

{
  const ui = fixture();
  assert.equal(ui.button('删除批次').props.disabled, false, 'fully terminal batch can be deleted');
  assert.equal(ui.deletionNote, undefined, 'deletable batch has no stale blocked explanation');
  assert.equal(ui.button('停止未提交项').props.disabled, true);
  await ui.click('继续批次');
  assert.equal(ui.button('删除批次').props.disabled, true, 'pending continuation confirmation protects the same batch');
  assert.equal(text(ui.deletionNote), ui.button('删除批次').props.title, 'blocked reason is rendered visibly as well as in the tooltip');
  assert.match(text(ui.deletionNote), /暂不继续/u);
  assert.deepEqual(ui.calls.preview, ['batch-original']); assert.equal(ui.calls.confirm.length, 0);
  assert.match(ui.text, /不重做 1 个成功项/u); assert.match(ui.text, /重新生成（可能再次收费）/u);
  assert.match(ui.text, /继续尚未提交的生成/u);
  await ui.click('确认继续 2 项（可能收费）');
  assert.equal(ui.calls.confirm[0].id, 'opaque-plan');
  assert.match(ui.text, /已继续 2 个未完成项/u);
}
{
  const ui = fixture(); await ui.click('继续批次'); await ui.click('暂不继续');
  assert.equal(ui.calls.confirm.length, 0); assert.match(ui.text, /未提交新的生成/u);
  assert.equal(ui.button('删除批次').props.disabled, false);
  assert.equal(ui.deletionNote, undefined, 'cancelling continuation removes its visible delete block');
}
{
  const ui = fixture();
  ui.updateTask('task-2', (task) => ({ ...task, status: 'running', remoteTaskId: 'synthetic-running', videoJob: { ...task.videoJob, stage: 'running' } }));
  assert.equal(ui.button('删除批次').props.disabled, true, 'active tasks remain protected');
  assert.equal(ui.deletionNote?.props.role, 'note');
  assert.equal(text(ui.deletionNote), ui.button('删除批次').props.title, 'running-task delete restriction is visible without hovering');
  assert.ok(text(ui.deletionNote).trim());
}
{
  const ui = fixture();
  ui.updateTask('task-2', (task) => ({ ...task, historyOnly: true, batchId: undefined }));
  const videoTab = () => children(ui.render()).find((node) => node.props['data-task-category'] === 'video');
  assert.equal(videoTab()?.props['aria-label'], '视频任务，2 个', 'hidden standalone history is excluded from the task count');
  assert.equal(children(ui.render()).some((node) => node.props['data-video-task-id'] === 'task-2'), false);
  for (const id of ['task-1', 'task-3']) ui.updateTask(id, (task) => ({ ...task, historyOnly: true }));
  assert.equal(videoTab()?.props['aria-label'], '视频任务，0 个', 'hidden batch history does not count as visible tasks');
  assert.equal(children(ui.render()).some((node) => node.props['data-video-batch-id'] === 'batch-original'), false);
}
{
  const ui = fixture(); const hold = deferred(); ui.setConfirm(() => hold.promise);
  await ui.click('继续批次'); const button = ui.button('确认继续 2 项（可能收费）');
  button.props.onClick(); button.props.onClick();
  assert.equal(ui.calls.confirm.length, 1, 'same-render double-click cannot confirm twice');
  await ui.click('取消续跑准备'); assert.equal(ui.calls.confirm[0].signal.aborted, true);
  hold.resolve({ batchId: 'late', taskIds: ['late'], skipped: [] }); await Promise.resolve(); await Promise.resolve();
  assert.doesNotMatch(ui.text, /已继续 1 个/u);
}
{
  const ui = fixture(); const hold = deferred(); ui.setResume(() => hold.promise);
  await ui.click('继续批次'); ui.switchProject(); hold.resolve(ui.reply); await Promise.resolve(); await Promise.resolve();
  assert.doesNotMatch(ui.text, /确认继续 2 项/u); assert.equal(ui.calls.confirm.length, 0);
}
{
  const ui = fixture(); ui.setResume(async () => ({ ...ui.reply, continuation: undefined, waitingTaskIds: ['task-2'], issues: [{ taskId: 'task-2', message: '提交状态未知，不能重复提交。' }] }));
  await ui.click('继续批次');
  assert.match(ui.text, /提交状态未知/u); assert.doesNotMatch(ui.text, /确认继续 2 项/u); assert.equal(ui.calls.confirm.length, 0);
}
{
  const ui = fixture(); ui.setResume(async () => ({ ...ui.reply, continuation: { ...ui.plan, batchId: 'continued-child-batch' } }));
  await ui.click('继续批次');
  assert.ok(ui.button('确认继续 2 项（可能收费）'), 'following a child batch still displays confirmation under the clicked original card');
  await ui.click('确认继续 2 项（可能收费）'); assert.equal(ui.calls.confirm[0].id, 'opaque-plan');
}
{
  const ui = fixture(); ui.setResume(async () => { throw new Error('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。'); });
  await ui.click('继续批次');
  assert.match(ui.text, /RunningHub 任务缺少可用 API 密钥/u);
  assert.doesNotMatch(ui.text, /确认继续 2 项/u);
  assert.equal(ui.button('继续批次').props.disabled, false);
  assert.equal(ui.calls.confirm.length, 0);
}
{
  const ui = fixture(); ui.setResume(async () => ({ ...ui.reply, continuation: undefined, waitingTaskIds: ['task-2'],
    issues: [{ taskId: 'task-2', message: 'RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。' }] }));
  await ui.click('继续批次');
  assert.match(ui.text, /RunningHub 任务缺少可用 API 密钥/u);
  assert.match(ui.text, /本次未发送请求/u);
  assert.doesNotMatch(ui.text, /确认继续 2 项/u);
  assert.equal(ui.calls.confirm.length, 0);
}
{
  const ui = fixture(); ui.setConfirm(async () => { throw new Error('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。'); });
  await ui.click('继续批次'); await ui.click('确认继续 2 项（可能收费）');
  assert.match(ui.text, /RunningHub 任务缺少可用 API 密钥/u);
  assert.doesNotMatch(ui.text, /已继续 2 个未完成项/u);
  assert.doesNotMatch(ui.text, /确认继续 2 项/u);
  assert.equal(ui.button('继续批次').props.disabled, false);
}
console.log('Batch continue UI: header, continuation confirmation/cancel, visible delete restrictions, hidden history cards/counts, double-click/project safety, unknown-submission and credential errors passed.');
