import { nestedValue } from './videoTasks';
import { parseVideoApiResult, videoApiSubmitEndpoint } from './videoGenerationApi';
import type { VideoGenerationTask } from './types';

export const VIDEO_EXECUTION_CONCURRENCY_MAX = 100;

export interface VideoExecutionScope {
  key: string;
  label: string;
  known: boolean;
}

/** Capacity follows the frozen service, never the currently selected settings,
 * project, workflow, profile name or credential. API endpoints on one origin
 * conservatively share capacity because historical snapshots have no stable
 * account identity. URL credentials, paths, queries and fragments are excluded.
 * Legacy jobs synthesized from current settings do not prove their origin. */
export const videoTaskExecutionScope = (task: VideoGenerationTask): VideoExecutionScope => {
  const job = task.videoJob;
  const connection = job?.snapshot?.connection;
  if (connection && !job?.legacyMetadataIncomplete) {
    const backend = connection.backend;
    if (backend === 'api' && connection.api?.provider === 'rhtv_web') return { key: 'api:rhtv-local-single-account', label: 'rhTV 本机网页账号', known: true };
    try {
      // Use the same endpoint resolver as the POST itself, including the
      // supported RunningHub default when its optional template is empty.
      const endpoint = backend === 'comfyui' ? connection.comfyui?.baseUrl
        : backend === 'api' && connection.api ? videoApiSubmitEndpoint(connection.api) : undefined;
      if (typeof endpoint === 'string' && endpoint.trim()) {
        const url = new URL(endpoint);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) {
          // Common local Comfy aliases share one conservative capacity bucket;
          // switching profiles between loopback spellings cannot multiply it.
          if (backend === 'comfyui' && ['localhost', 'localhost.', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
            url.hostname = '127.0.0.1';
          }
          const service = backend === 'comfyui' ? 'ComfyUI'
            : connection.api?.provider === 'runninghub' ? 'RunningHub' : '视频 API';
          return { key: `${backend}:${url.origin}`, label: `${service} · ${url.origin}`, known: true };
        }
      }
    } catch { /* Malformed historical addresses remain quarantined, not terminal. */ }
  }
  return { key: 'video-connection:unknown', label: '连接来源未知（历史记录）', known: false };
};

export const videoTasksShareExecutionScope = (left: VideoGenerationTask, right: VideoGenerationTask): boolean => (
  videoTaskExecutionScope(left).key === videoTaskExecutionScope(right).key
);

/** Unknown-origin work may still belong to the target account. Retain its
 * conservative reservation until terminal evidence exists; do not pretend that
 * quarantining its metadata proved a different service or remote completion. */
export const videoExecutionScopesMayShareCapacity = (left: VideoExecutionScope, right: VideoExecutionScope): boolean => (
  !left.known || !right.known || left.key === right.key
);

export const videoTasksMayShareExecutionScope = (left: VideoGenerationTask, right: VideoGenerationTask): boolean => (
  videoExecutionScopesMayShareCapacity(videoTaskExecutionScope(left), videoTaskExecutionScope(right))
);

/** Application-wide settings; the actual generation limit applies per frozen
 * connection scope across projects, single tasks, batches and continuations. */
export const resolveVideoExecutionLimit = (settings: {
  videoExecutionMode?: unknown;
  videoExecutionConcurrency?: unknown;
}): number => settings.videoExecutionMode === 'concurrent'
  && typeof settings.videoExecutionConcurrency === 'number'
  && Number.isInteger(settings.videoExecutionConcurrency)
  && settings.videoExecutionConcurrency >= 1
  && settings.videoExecutionConcurrency <= VIDEO_EXECUTION_CONCURRENCY_MAX
  ? settings.videoExecutionConcurrency : 1;

/** A local queue label alone does not prove that no billable submission exists.
 * Callers must cancel through the engine and re-read this predicate afterwards:
 * a newer durable journal may still replace an old preparing project snapshot. */
export const isUnsubmittedVideoTask = (task: VideoGenerationTask): boolean => {
  const job = task.videoJob;
  return (task.kind == null || task.kind === 'video')
    && job?.preparation?.version === 1 && job.preparation.phase === 'preparing'
    && !task.remoteTaskId && !task.resultUrl && !task.resultAssetId && !job.resultAssetIds?.length
    && !job.submittedAt && !job.generatedAt
    && ['draft', 'submitting', 'failed'].includes(task.status)
    && ['preparing', 'queued', 'stopped', 'failed'].includes(job.stage);
};

/** Provider completion and local scheduling are separate: stopping observation
 * never proves remote cancellation or permits replaying the original POST. */
export const videoTaskRemoteGenerationEnded = (task: VideoGenerationTask): boolean => {
  const job = task.videoJob;
  if (job?.remoteGenerationEnded === true || job?.cancellationConfirmed === true
    || task.resultAssetId || task.resultUrl || task.status === 'succeeded'
    || typeof job?.generatedAt === 'number' && job.generatedAt > 0) return true;
  if (!job || !task.response) return false;
  if (job.snapshot.connection.backend === 'api' && job.snapshot.connection.api) {
    const config = job.snapshot.connection.api;
    const mapped = parseVideoApiResult(task.response, config);
    if (mapped.status === 'succeeded') return true;
    if (mapped.status !== 'failed') return false;
    if (config.provider === 'rhtv_web') return mapped.remoteTaskId === task.remoteTaskId && (nestedValue(task.response, 'cancellation_confirmed') === true || nestedValue(task.response, 'terminal_confirmed') === true);
    // A rejected submission with no remote ID is over. For an existing remote
    // task a query-envelope/authentication error does not end that task.
    if (!task.remoteTaskId && job.preparation?.phase === 'acknowledged') return true;
    const rawStatus = String(nestedValue(task.response, config.statusPath || 'status') || '').toLowerCase();
    return /^(?:failed|fail|error|cancelled|canceled|aborted)$/u.test(rawStatus);
  }
  return ['error', 'success'].includes(String(nestedValue(task.response, 'status_str')))
    || ['error', 'success'].includes(String(nestedValue(task.response, 'status.status_str')))
    || nestedValue(task.response, 'status.completed') === true;
};

/** Retain original task identity while its remote outcome remains unresolved,
 * including after local tracking stops. This is not a local capacity count. */
export const videoTaskHasUnresolvedSubmission = (task: VideoGenerationTask): boolean => {
  if (task.kind != null && task.kind !== 'video') return false;
  if (videoTaskRemoteGenerationEnded(task)) return false;
  if (task.remoteTaskId || task.status === 'unknown' || task.videoJob?.stage === 'submission-unknown') return true;
  const phase = task.videoJob?.preparation?.phase;
  if (phase === 'post-started' || phase === 'acknowledged') return true;
  if (phase === 'preparing') return false;
  return task.status === 'submitted' || task.status === 'running' || task.status === 'submitting';
};

export const videoTaskStoppedLocally = (task: VideoGenerationTask): boolean => (
  task.videoJob?.trackingStopped === true && task.videoJob.stage === 'stopped'
);

/** Stopped tasks, including persisted history in another project, release the
 * software's slot without changing remote evidence. Unstopped unknown POSTs
 * still reserve capacity; explicit resume queries the original task only. */
export const videoTaskOccupiesGenerationSlot = (task: VideoGenerationTask): boolean => (
  !videoTaskStoppedLocally(task) && videoTaskHasUnresolvedSubmission(task)
);
