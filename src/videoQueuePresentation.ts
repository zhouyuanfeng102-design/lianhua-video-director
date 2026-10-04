import type { Project, VideoGenerationTask } from './types';
import { getSafeErrorDiagnostics } from './errorDiagnostics';
import { videoTaskErrorOptions } from './videoTaskErrorDiagnostics';
import { videoTaskExecutionScope, videoTaskOccupiesGenerationSlot, videoTaskRemoteGenerationEnded, videoTaskStoppedLocally, videoTasksMayShareExecutionScope } from './videoGenerationQueue';

const MAX_VISIBLE_BLOCKERS = 8;
const clipped = (value: string, limit: number): string => value.length > limit ? `${value.slice(0, limit)}…` : value;
const blockerStatus = (task: VideoGenerationTask): string => {
  if (videoTaskRemoteGenerationEnded(task)) return '本地提交收尾中';
  if (task.videoJob?.preparation?.phase === 'preparing' && !task.remoteTaskId) return '准备素材中（尚未提交）';
  if (task.videoJob?.cancellationPending) return '取消结果待确认';
  if (task.videoJob?.trackingStopped || task.videoJob?.stage === 'stopped') return '已停止跟踪，远端结果待确认';
  if (task.status === 'unknown' || task.videoJob?.stage === 'submission-unknown') return '提交结果待确认';
  if (task.status === 'failed') return '本地或查询失败，远端结果待确认';
  if (!task.remoteTaskId) return '请求已发出，等待确认';
  return task.status === 'running' || task.videoJob?.stage === 'running' ? '远端运行中' : '远端排队或执行中';
};

/** Metadata-only explanation of occupied capacity. It never queries/restarts
 * work or includes raw responses, prompts, connection URLs or credentials.
 * Sanitize against each blocking task before persisting this status message;
 * the waiting card's own redaction context cannot know another task's prompt. */
export const videoQueueBlockerSummary = (
  projects: readonly Pick<Project, 'id' | 'name' | 'generationTasks'>[],
  waitingTask: VideoGenerationTask,
  knownSecrets: readonly string[] = [],
  preparingTaskIds: ReadonlySet<string> = new Set(),
): string => {
  const seen = new Set<string>();
  const blockers = projects.flatMap((project) => project.generationTasks.flatMap((candidate) => {
    if (candidate.kind != null && candidate.kind !== 'video') return [];
    const task = candidate as VideoGenerationTask;
    if (task.id === waitingTask.id || seen.has(task.id) || videoTaskStoppedLocally(task) || (!videoTaskOccupiesGenerationSlot(task) && !preparingTaskIds.has(task.id))
      || !videoTasksMayShareExecutionScope(task, waitingTask)) return [];
    seen.add(task.id);
    return [{ project, task }];
  })).sort((left, right) => left.task.createdAt - right.task.createdAt || left.task.id.localeCompare(right.task.id));
  if (!blockers.length) return '';
  const lines = blockers.slice(0, MAX_VISIBLE_BLOCKERS).map(({ project, task }, index) => {
    const options = videoTaskErrorOptions(task, knownSecrets);
    const safeLabel = (value: string, fallback: string, limit: number): string => {
      const safe = getSafeErrorDiagnostics(value || fallback, options).message.replace(/\s+/gu, ' ').trim();
      return clipped(safe || fallback, limit);
    };
    const projectName = safeLabel(project.name, '未命名项目', 40);
    const taskName = safeLabel(task.videoJob?.snapshot.draft.name || '', `视频任务${task.segmentIndex ? ` · 第${task.segmentIndex}段` : ''}`, 90);
    const shortId = safeLabel(task.id, '未记录', 100).slice(-12);
    const origin = videoTaskExecutionScope(task).known ? '' : ' · 来源连接待核实';
    return `${index + 1}. 项目「${projectName}」／${taskName} · ${blockerStatus(task)}${origin} · 任务尾号 ${shortId}`;
  });
  if (blockers.length > MAX_VISIBLE_BLOCKERS) lines.push(`另有 ${blockers.length - MAX_VISIBLE_BLOCKERS} 条占位任务；以上按创建时间列出。`);
  return `占位任务（同连接及来源待核实）：\n${lines.join('\n')}`;
};
