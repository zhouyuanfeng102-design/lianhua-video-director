import { applyOwnedProjectUpdate } from './appEffects';
import { bindComfyVideoWorkflow, comfyVideoExecutionStartedAt, mapComfyVideoProgress, parseComfyVideoWorkflow, resolveComfyVideoOutputs } from './comfyuiVideo';
import { ComfyMissingTaskTracker, ComfyQueuePresenceCache } from './comfyPolling';
import { assertNoEmbeddedVideoCredentials, buildVideoApiBody, defaultMiniMaxVideoApi, defaultRunningHubVideoApi, isRunningHubUploadedFile, parseVideoApiResult, redactVideoSecrets, runningHubVideoResults, videoApiSubmitEndpoint } from './videoGenerationApi';
import { compileRunningHubVideoApi, resolveConfiguredVideoApi } from './runningHubVideo';
import { nestedValue } from './videoTasks';
import { defaultComfyVideoConfig } from './videoGenerationTypes';
import { defaultRhTvApi, RHTV_ORIGIN } from './rhtvBridge';
import { findProjectVideoTask, snapshotVideoAssetSourceTask } from './videoProvenance';
import { createStoryboardImageNameAllocator } from './storyboardImageNames';
import { cancelledVideoBatchTaskBeforePost, validVideoBatchPreviousTail, videoBatchConnectionIdentity, videoBatchDependencyFingerprint, videoBatchRequestFingerprint, videoBatchTailReferences, videoTaskMatchesRequestFingerprint, videoTaskRequestFingerprint } from './videoBatch';
import { videoReferenceUsage } from './videoReferenceUsage';
import { videoReferenceSelection } from './videoReferenceSlots';
import { prepareVideoH3ReferenceDraft } from './videoH3ReferenceBinding';
import { getVideoTailCharacterPlacement, getVideoTailReferencePlacements } from './videoTailReference';
import { videoBatchContinuationPersistenceIssue } from './videoBatchContinuation';
import { runningHubRemoteSucceeded } from './videoResultRecovery';
import { canRecoverComfyPreviewResult } from './comfyuiVideo';
import { isUnsubmittedVideoTask, resolveVideoExecutionLimit, videoExecutionScopesMayShareCapacity, videoTaskExecutionScope, videoTaskOccupiesGenerationSlot, videoTaskRemoteGenerationEnded, videoTaskStoppedLocally, videoTasksMayShareExecutionScope, type VideoExecutionScope } from './videoGenerationQueue';
import { videoQueueBlockerSummary } from './videoQueuePresentation';
import { getOfficialH3SubmissionIssue, isOfficialH3TargetId } from './officialPrompt';
import { officialH3ContextForStoryboard } from './officialH3Context';
import type { WorkbenchExtractedFrame } from './videoWorkbenchTypes';
import type { extractVideoTailFrameSelection } from './videoFrameSelection';
import type { AppState, Project, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from './types';
import type {
  ComfyVideoConfig,
  ComfyVideoWorkflowPreset,
  VideoBatchCancelResult,
  VideoBatchContinuationClaim,
  VideoBatchContinuationPlan,
  VideoBatchResumeResult,
  VideoBatchItemInput,
  VideoBatchSkippedItem,
  VideoBatchStartInput,
  VideoBatchStartResult,
  VideoGenerationDesktop,
  VideoGenerationDraft,
  VideoGenerationJob,
  VideoGenerationRuntime,
  VideoGenerationSnapshot,
  VideoTailSelectionPreparation,
} from './videoGenerationTypes';

type Desktop = VideoGenerationDesktop;
type RequestInput = Parameters<Desktop['videoRequest']>[0];
type StateUpdater = (updater: (state: AppState) => AppState) => void;
type VideoWatchLease = { watchId: string; identity: string; dispatched: boolean; nodeNames?: Record<string, string> };
const runtimeKeys: ReadonlyArray<keyof VideoGenerationRuntime> = [
  'stage', 'message', 'progress', 'nodeId', 'step', 'totalSteps', 'startedAt', 'submittedAt',
  'generatedAt', 'completedAt', 'trackingStopped', 'cancellationPending', 'cancellationConfirmed',
  'downloadError', 'receivedBytes', 'totalBytes',
];
// Progress callbacks must never copy a frozen workflow, reference image, or
// preparation journal into a UI runtime object.
const runtimeOnly = (value: VideoGenerationRuntime): VideoGenerationRuntime => Object.fromEntries(
  runtimeKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]),
) as unknown as VideoGenerationRuntime;
const sameRuntime = (left: VideoGenerationRuntime, right: VideoGenerationRuntime): boolean => runtimeKeys.every((key) => Object.is(left[key], right[key]));
const samePatch = (value: object, patch: object): boolean => Object.entries(patch).every(([key, next]) => Object.is((value as Record<string, unknown>)[key], next));
const comfyExecutionEvents = new Set(['progress', 'executing', 'executed', 'execution_start', 'execution_cached', 'execution_success', 'execution_error', 'execution_interrupted']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const completedFileResult = (task: VideoGenerationTask): string | undefined => {
  const config = task.videoJob?.snapshot.connection.api;
  if (!config || !task.response || task.resultUrl) return undefined;
  const result = parseVideoApiResult(task.response, config);
  return result.status === 'succeeded' ? result.fileId : undefined;
};
const pending = (task: VideoGenerationTask) => Boolean(task.videoJob && !task.videoJob.trackingStopped && (task.remoteTaskId || completedFileResult(task)) && ['submitted', 'running', 'unknown'].includes(task.status));
const allProjects = (state: AppState): Project[] => [state.project, ...state.projects.filter((project) => project.id !== state.project.id)];
/**
 * H3's saved official delivery is the only source allowed across the paid
 * request boundary.  Keep this check outside the renderer/body builder so it
 * can resolve the owning storyboard and its exact source context.  Non-H3
 * models intentionally return no issue and retain the existing generic path.
 */
const officialH3SubmissionIssue = (
  body: Record<string, unknown>,
  draft: VideoGenerationDraft,
  project: Project | undefined,
): string | undefined => {
  if (!isOfficialH3TargetId(body.model)) return undefined;
  const board = project?.storyboards.find((item) => item.id === draft.source?.storyboardId);
  const binding = draft.h3ReferenceBinding;
  const officialBody = binding && binding.projectId === project?.id && draft.prompt === binding.renderedPrompt
    && body.prompt === draft.prompt ? { ...body, prompt: binding.basePrompt } : body;
  return getOfficialH3SubmissionIssue(
    officialBody,
    board,
    board && project ? officialH3ContextForStoryboard(project, board) : undefined,
    draft.source?.language === 'en' ? 'en' : 'zh',
  );
};
const assertOfficialH3Submission = (
  body: Record<string, unknown>,
  draft: VideoGenerationDraft,
  project: Project | undefined,
): void => {
  const issue = officialH3SubmissionIssue(body, draft, project);
  if (issue) throw new Error(issue);
};
const withoutApiKey = (config: VideoTaskApiConfig): Omit<VideoTaskApiConfig, 'apiKey'> => {
  const { apiKey: _secret, ...safe } = config;
  return redactVideoSecrets(safe);
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const canonicalText = (value: unknown): string => JSON.stringify(canonical(value));
const apiCredentialConfig = (config: Omit<VideoTaskApiConfig, 'apiKey'>) => Object.fromEntries(Object.entries(config)
  .filter(([key]) => !['apiKey', 'id', 'name', 'createdAt', 'updatedAt', 'runningHubParameterControls'].includes(key))
  .map(([key, value]) => [key, key === 'runningHubMappedFields' && Array.isArray(value)
    ? value.map((field) => {
      if (!record(field) || field.kind !== 'image') return field;
      // Added in 0.7.7: empty-slot submission policy is not credential identity.
      // Excluding it preserves pre-0.7.7 vault scopes; every original endpoint,
      // workflow, template, binding and parameter still has to match exactly.
      const { emptyValue: _emptyValue, ...identity } = field;
      return identity;
    }) : value]));
const credentialScope = (connection: VideoGenerationSnapshot['connection']): string => JSON.stringify(canonical({
  backend: connection.backend,
  ...(connection.backend === 'api' ? { api: apiCredentialConfig(connection.api!) } : { comfyui: connection.comfyui }),
}));
const frozenRunningHubParameters = (snapshot: VideoGenerationSnapshot): Record<string, unknown> => {
  const api = snapshot.connection.api;
  if (api?.provider !== 'runninghub' || !api.runningHubMappedFields) return snapshot.draft.parameters;
  try {
    const request: unknown = JSON.parse(api.requestTemplate || '{}');
    const nodes = record(request) && Array.isArray(request.nodeInfoList) ? request.nodeInfoList.filter(record) : [];
    const values: Record<string, unknown> = {};
    for (const field of api.runningHubMappedFields) {
      if (field.kind !== 'parameter' || !field.parameter) continue;
      const node = nodes.find((candidate) => candidate.nodeId === field.nodeId && candidate.fieldName === field.fieldName);
      if (node && Object.prototype.hasOwnProperty.call(node, 'fieldValue')) values[field.parameter] = node.fieldValue;
    }
    return values;
  } catch { return snapshot.draft.parameters; }
};
const videoWatchIdentity = (task: VideoGenerationTask): string => JSON.stringify([
  task.videoJob!.snapshot.projectId, task.id, task.createdAt, task.remoteTaskId,
  task.videoJob!.snapshot.clientId, credentialScope(task.videoJob!.snapshot.connection),
]);
const join = (base: string, path: string) => `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const downloadWasAborted = (error: unknown): boolean => Boolean(error && typeof error === 'object'
  && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR'))
  || /(?:AbortError|\bABORT_ERR\b|(?:视频下载|ZIP 视频接收|请求)已取消)/u.test(messageOf(error));
const safeDownloadFailure = (error: unknown, headers?: Record<string, string>, limit = 600): string => {
  let message = messageOf(error);
  for (const value of Object.values(headers || {})) {
    for (const secret of [value, value.replace(/^Bearer\s+/iu, '')]) {
      if (secret) message = message.split(secret).join('[已脱敏]');
    }
  }
  return message.replace(/https?:\/\/[^\s<>"'，；。]+/giu, '[下载地址]')
    .replace(/data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu, '[媒体数据]')
    .replace(/\bbearer\s+[^\s,;，；。"'\[\]]+/giu, 'Bearer [已脱敏]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,;&}，；。"'\[\]]+/giu, '$1[已脱敏]')
    .replace(/[\r\n]+/gu, ' ').trim().slice(0, limit) || '文件下载或解压失败';
};
const downloadCandidates = (task: VideoGenerationTask): ReturnType<typeof runningHubVideoResults> => {
  const api = task.videoJob?.snapshot.connection.api;
  if (task.videoJob?.snapshot.connection.backend === 'api' && api?.provider === 'runninghub') {
    const candidates = runningHubVideoResults(task.response, api.runningHubOutputNodeIds);
    const current = candidates.find((candidate) => candidate.resultUrl === task.resultUrl);
    if (candidates.length) return current ? [current, ...candidates.filter((candidate) => candidate !== current)] : candidates;
    // An old stored URL must not bypass an explicit node filter, nor override
    // a cached output list which contains only images/text/unselected nodes.
    if (api.runningHubOutputNodeIds?.some((nodeId) => nodeId.trim())
      || Array.isArray(nestedValue(task.response, 'results'))) return [];
  }
  return task.resultUrl ? [{ resultUrl: task.resultUrl }] : [];
};
const videoFileStem = (value: string): string => value
  .replace(/\.(?:mp4|webm|mov)$/iu, '')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
  .trim() || '生成视频';
const isVideoAsset = (asset: ReferenceAsset): boolean => asset.mediaType === 'video'
  || asset.type === 'video'
  || Boolean(asset.mimeType?.startsWith('video/'));
const allocateVideoName = (project: Project, requested: string, reservations: readonly string[] = []): string => createStoryboardImageNameAllocator([
  ...project.assets.filter(isVideoAsset).flatMap((asset) => [
    asset.name,
    asset.fileName ? videoFileStem(asset.fileName) : '',
  ]),
  ...project.generationTasks.flatMap((item) => {
    const name = (item as VideoGenerationTask).videoJob?.snapshot.draft.name;
    return name ? [name] : [];
  }),
  ...reservations,
])(videoFileStem(requested));
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export interface VideoGenerationEngineOptions {
  getState: () => AppState;
  setState: StateUpdater;
  desktop?: Desktop;
  onRuntime: (taskId: string, runtime: VideoGenerationRuntime) => void;
  onRemoveRuntime?: (taskId: string) => void;
  notify?: (message: string, kind?: 'normal' | 'error') => void;
  pollIntervalMs?: number;
  /** Flushes the newly inserted task before any generated-video POST can be issued. */
  persistState?: () => Promise<void>;
  /** Injected by the app with its explicitly selected vision connection. The
   * engine owns cancellation and each bounded, durable analysis boundary. */
  selectTailFrame?: (input: Omit<Parameters<typeof extractVideoTailFrameSelection>[0], 'config'>) => ReturnType<typeof extractVideoTailFrameSelection>;
}

interface PreparedBatchItem {
  item: VideoBatchItemInput;
  index: number;
  draft: VideoGenerationDraft;
  /** Preserves reference indices; the slot replaced by a future tail has no
   * original asset because those bytes will never be sent. */
  assets: Array<ReferenceAsset | undefined>;
  config?: VideoTaskApiConfig;
  comfy: ComfyVideoConfig;
  workflow?: ComfyVideoWorkflowPreset;
  apiKey: string;
  requestFingerprint: string;
}

interface SavedBatchContinuation {
  publicPlan: VideoBatchContinuationPlan;
  signature: string;
  taskIds: string[];
  chain: boolean;
  preparedFirstFrame?: ReferenceAsset;
}

interface BatchContinuationCreation {
  batchId: string;
  planId: string;
  sources: Map<string, { task: VideoGenerationTask; targetTaskId: string }>;
}

const batchConcurrency = (value: number | undefined): number => {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('批量提交并发数必须是 1 到 4 的整数。');
  return value;
};

const requestFingerprintOwnerKey = (projectId: string, requestFingerprint: string): string => (
  JSON.stringify([projectId, requestFingerprint])
);

const batchTaskStillBlocksDuplicate = (task: VideoGenerationTask): boolean => {
  if (cancelledVideoBatchTaskBeforePost(task)) return false;
  // Old progress/checkpoint records can retain a transient stage after the
  // finished video was saved. The explicit terminal result wins over that
  // stale stage; unknown POST outcomes and real downloads without an asset
  // must still block duplicate billing, even when force was requested.
  if (task.status === 'succeeded' && task.resultAssetId) return false;
  const stage = task.videoJob?.stage;
  return ['draft', 'submitting', 'submitted', 'running', 'unknown'].includes(task.status)
    || Boolean(stage && ['preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading', 'submission-unknown'].includes(stage));
};

const batchTaskSucceeded = (task: VideoGenerationTask): boolean => (
  task.status === 'succeeded' || task.videoJob?.stage === 'succeeded' || Boolean(task.resultAssetId)
);

/** Lifetime belongs to the App root. Only explicit starts and proven pre-POST preparations may submit. */
export class VideoGenerationEngine {
  private options: VideoGenerationEngineOptions;
  private disposed = false;
  private credentials = new Map<string, string>();
  private credentialIdsByTask = new Map<string, Set<string>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private busy = new Set<string>();
  private downloading = new Set<string>();
  private recoveringResults = new Set<string>();
  private resultSelectionsRestored = new Set<string>();
  private restoringResultSelections = new Map<string, Promise<void>>();
  private stopping = new Set<string>();
  /** Remote cancellation requests must be allowed to finish even if the
   * user removes the local task immediately afterwards.  Otherwise reconcile
   * would abort the queue DELETE together with the task's normal requests. */
  private remoteCancellations = new Map<string, Set<number>>();
  /** Cancel/resume is a new observation session even when the remote ID stays
   * unchanged. Transport abort alone cannot retire an already-delivered reply. */
  private controlEpochs = new Map<string, number>();
  private pollLeases = new Map<string, object>();
  private requestIds = new Map<string, Set<string>>();
  private downloadOwners = new Map<string, string>();
  private watches = new Map<string, VideoWatchLease>();
  private watchTasks = new Map<string, string>();
  private runtimes = new Map<string, VideoGenerationRuntime>();
  private retryCounts = new Map<string, number>();
  private comfyQueuePresence = new ComfyQueuePresenceCache();
  private comfyMissingTasks = new ComfyMissingTaskTracker();
  private acknowledgementChecks = new Map<string, object>();
  private acknowledgementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private acknowledgementRetries = new Map<string, number>();
  private restoredCheckpoints = new Set<string>();
  private restoringCheckpoints = new Set<string>();
  private checkpointErrors = new Map<string, string>();
  private videoNameReservations = new Map<string, Set<string>>();
  private batchStarts = new Map<string, Promise<VideoBatchStartResult>>();
  private batchResumes = new Map<string, Promise<VideoBatchResumeResult>>();
  private continuationPlans = new Map<string, SavedBatchContinuation>();
  private continuationStarts = new Map<string, Promise<VideoBatchStartResult>>();
  private continuationControllers = new Map<string, AbortController>();
  private batchClaims = new Set<string>();
  /** Synchronous admission claims cover preparation awaits before the durable
   * POST boundary exists. Remote occupancy thereafter comes from saved tasks. */
  private generationClaims = new Map<string, VideoExecutionScope>();
  private queueWakeupPending = false;
  private lastCreatedTaskAt = 0;
  private initializingBatches = new Set<string>();
  private cancelledBatches = new Set<string>();
  private tailPreparations = new Set<string>();
  /** A retry clicked while failure persistence is finishing waits for that
   * exact run to release its lock instead of being silently discarded. */
  private tailPreparationSettlements = new Map<string, Promise<void>>();
  private tailExtractionJobs = new Map<string, string>();
  private tailSelectionControllers = new Map<string, AbortController>();
  private completionPersistence = new Set<string>();
  private archivedDependencies = new Map<string, { signature: string; task: VideoGenerationTask }>();
  private archivedDependencyAttempts = new Map<string, string>();
  private restoringArchivedDependencies = new Set<string>();
  /** Also reserves fingerprints while a batch is freezing local inline inputs. */
  private requestFingerprintOwners = new Map<string, string>();
  private unsubscribe?: () => void;

  /**
   * A batch is deliberately invisible to reconciliation while its task shells
   * are being inserted and their first durable checkpoints are being written.
   * React can run the state-change effect in that small window; treating the
   * still-preparing shell as a restarted task would mistake the not-yet-written
   * journal for a missing journal and stop it before the batch can become ready.
   */
  private isInitializingBatch(task?: Pick<VideoGenerationTask, 'batchId'>): boolean {
    return Boolean(task?.batchId && this.initializingBatches.has(task.batchId));
  }

  constructor(options: VideoGenerationEngineOptions) {
    this.options = options;
    this.unsubscribe = options.desktop?.onVideoProgress?.((event) => {
      if (this.disposed) return;
      const downloadOwner = this.downloadOwners.get(event.watchId);
      if (downloadOwner && event.type === 'message' && record(event.data) && record(event.data.data) && event.data.type === 'download_progress') {
        const task = this.find(downloadOwner);
        if (task && !this.stopping.has(downloadOwner)) {
          const phase = event.data.data.phase;
          if (phase === 'extracting' || phase === 'verifying') {
            const extractedBytes = Number(event.data.data.extractedBytes) || 0;
            const files = Number(event.data.data.files) || 0;
            this.progress(task, { stage: 'downloading', progress: undefined, message: phase === 'extracting'
              ? `云端已生成，正在解压 ZIP${extractedBytes ? `（已提取 ${(extractedBytes / 1048576).toFixed(1)} MB）` : ''}`
              : `云端已生成，正在验证并保存视频${files ? `（${files} 个文件）` : ''}` });
            return;
          }
          const receivedBytes = Number(event.data.data.receivedBytes) || 0;
          const totalBytes = Number(event.data.data.totalBytes) || undefined;
          this.progress(task, { stage: 'downloading', receivedBytes, totalBytes, progress: totalBytes ? receivedBytes / totalBytes * 100 : undefined, message: `视频已生成，已保存 ${(receivedBytes / 1048576).toFixed(1)} MB${totalBytes ? ` / ${(totalBytes / 1048576).toFixed(1)} MB` : ''}` });
        }
        return;
      }
      const taskId = this.watchTasks.get(event.watchId);
      const lease = taskId ? this.watches.get(taskId) : undefined;
      if (!taskId || !lease || lease.watchId !== event.watchId) return;
      const task = this.currentWatchTask(taskId, lease);
      if (!task?.videoJob) { void this.releaseWatch(taskId, lease).catch(() => {}); return; }
      if (event.type === 'disconnected' || event.type === 'error') {
        this.comfyMissingTasks.reset(task.id);
        this.progress(task, { stage: 'reconnecting', message: '实时连接中断，仍在查询原任务；不会重复提交。' });
        return;
      }
      if (event.type !== 'message') return;
      let payload = event.data;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
      // Comfy broadcasts status/other prompts over each socket. Reject them
      // before parsing a potentially megabyte-sized workflow or scheduling a
      // history request. Legacy progress lacking prompt_id remains valid only
      // because currentWatchTask already proved this unique client's lease.
      if (!record(payload) || !record(payload.data) || !comfyExecutionEvents.has(String(payload.type))
        || payload.data.prompt_id && String(payload.data.prompt_id) !== task.remoteTaskId) return;
      this.comfyMissingTasks.reset(task.id);
      if (payload.type === 'executing' && payload.data.node != null && !lease.nodeNames) {
        try {
          const workflow = task.videoJob.snapshot.connection.workflow;
          const nodes = workflow ? parseComfyVideoWorkflow(workflow.workflowJson) : {};
          lease.nodeNames = Object.fromEntries(Object.entries(nodes).map(([nodeId, node]) => [nodeId, node._meta?.title || node.class_type]));
        } catch { lease.nodeNames = {}; /* historical malformed metadata must not break progress tracking */ }
      }
      const progress = mapComfyVideoProgress(payload, task.remoteTaskId || '', lease.nodeNames);
      if (progress?.stage === 'failed') {
        this.patch(task, { status: 'failed', error: progress.message, videoJob: { ...task.videoJob, remoteGenerationEnded: true } }, { ...progress, completedAt: Date.now() });
        void this.stopWatch(task.id);
        this.wakeGenerationQueue();
      } else if (progress) this.progress(task, progress);
      if (['execution_success', 'executed'].includes(String(payload.type))) this.schedule(task.id, 0);
    });
  }

  private find(taskId: string): VideoGenerationTask | undefined {
    for (const project of allProjects(this.options.getState())) {
      const task = findProjectVideoTask(project, taskId);
      if (task) return task;
    }
    return undefined;
  }

  private reserveVideoName(project: Project, requested: string): string {
    const reservations = this.videoNameReservations.get(project.id) || new Set<string>();
    const currentProject = allProjects(this.options.getState()).find((candidate) => candidate.id === project.id) || project;
    const name = allocateVideoName(currentProject, requested, [...reservations]);
    reservations.add(name);
    this.videoNameReservations.set(project.id, reservations);
    return name;
  }

  private releaseVideoName(projectId: string, name: string) {
    const reservations = this.videoNameReservations.get(projectId);
    reservations?.delete(name);
    if (!reservations?.size) this.videoNameReservations.delete(projectId);
  }

  private liveTask(taskId: string): VideoGenerationTask | undefined {
    for (const project of allProjects(this.options.getState())) {
      const task = project.generationTasks.find((item) => item.id === taskId && (item.kind === 'video' || item.kind == null));
      if (task) return task as VideoGenerationTask;
    }
    return undefined;
  }

  private allVideoTasks(): VideoGenerationTask[] {
    return allProjects(this.options.getState()).flatMap((project) => project.generationTasks
      .filter((task): task is VideoGenerationTask => task.kind === 'video' || task.kind == null));
  }

  private nextTaskCreatedAt(): number {
    // Several starts can occur within one millisecond. A durable increasing
    // timestamp keeps their queue order stable instead of sorting random IDs.
    this.lastCreatedTaskAt = Math.max(Date.now(), this.lastCreatedTaskAt + 1);
    return this.lastCreatedTaskAt;
  }

  private generationQueueCandidates(): VideoGenerationTask[] {
    return this.allVideoTasks().filter((task) => {
      const job = task.videoJob;
      return job?.preparation?.version === 1 && job.preparation.phase === 'preparing'
        && !task.remoteTaskId && !job.trackingStopped && !this.stopping.has(task.id)
        && !this.checkpointErrors.has(task.id) && !this.isInitializingBatch(task)
        && (task.status === 'draft' || task.status === 'submitting')
        && (!task.batchId || job.batchQueueState === 'ready' || job.batchQueueState === 'active')
        && this.tailReady(task) && this.chainDependencyReady(task);
    }).sort((left, right) => left.createdAt - right.createdAt
      || (left.batchId === right.batchId ? (left.batchIndex || 0) - (right.batchIndex || 0) : 0)
      || left.id.localeCompare(right.id));
  }

  private generationScopeTasks(task: VideoGenerationTask): VideoGenerationTask[] {
    return this.allVideoTasks().filter((candidate) => videoTasksMayShareExecutionScope(candidate, task));
  }

  private hasUnrestoredGenerationPreparation(tasks: VideoGenerationTask[]): boolean {
    // A journal can be newer than the project JSON and already contain a POST
    // boundary. Read recoverable pre-POST records for this same frozen service,
    // including other projects/batches. Unknown-origin records remain a
    // conservative barrier; proven unrelated services must stay runnable.
    return tasks.some((candidate) => candidate.videoJob?.preparation?.phase === 'preparing'
      && !videoTaskStoppedLocally(candidate)
      && !candidate.remoteTaskId && !candidate.resultAssetId
      && !['cancelled', 'done'].includes(candidate.videoJob.batchQueueState || '')
      && !this.isInitializingBatch(candidate)
      && (!this.restoredCheckpoints.has(candidate.id) || this.restoringCheckpoints.has(candidate.id)));
  }

  private claimGenerationSlot(task: VideoGenerationTask): boolean {
    const scope = videoTaskExecutionScope(task);
    if (this.generationClaims.get(task.id)?.key === scope.key) return true;
    const tasks = this.generationScopeTasks(task);
    if (this.hasUnrestoredGenerationPreparation(tasks)) return false;
    const occupied = new Set(tasks.filter(videoTaskOccupiesGenerationSlot).map((candidate) => candidate.id));
    this.generationClaims.forEach((claimScope, taskId) => { if (videoExecutionScopesMayShareCapacity(claimScope, scope)) occupied.add(taskId); });
    const remaining = (task.videoJob?.snapshot.connection.api?.provider === 'rhtv_web' ? 1 : resolveVideoExecutionLimit(this.options.getState().settings)) - occupied.size;
    if (remaining <= 0) return false;
    const admitted = this.generationQueueCandidates().filter((candidate) => videoTaskExecutionScope(candidate).key === scope.key
      && !occupied.has(candidate.id)).slice(0, remaining);
    if (!admitted.some((candidate) => candidate.id === task.id)) return false;
    this.generationClaims.set(task.id, scope);
    return true;
  }

  private markLocallyQueued(task: VideoGenerationTask) {
    const job = task.videoJob;
    if (!job || job.trackingStopped || this.stopping.has(task.id)) return;
    const scope = videoTaskExecutionScope(task);
    const tasks = this.generationScopeTasks(task);
    const occupied = tasks.filter((candidate) => videoTaskOccupiesGenerationSlot(candidate) || this.generationClaims.has(candidate.id));
    const unknownOrigins = occupied.filter((candidate) => !videoTaskExecutionScope(candidate).known);
    const confirmedOrigins = occupied.length - unknownOrigins.length;
    const uncertain = occupied.filter((candidate) => candidate.videoJob?.trackingStopped
      || candidate.status === 'unknown' || candidate.videoJob?.stage === 'submission-unknown');
    const state = this.options.getState();
    const settings = state.settings;
    const limit = task.videoJob?.snapshot.connection.api?.provider === 'rhtv_web' ? 1 : resolveVideoExecutionLimit(settings);
    const waitingForJournal = this.hasUnrestoredGenerationPreparation(tasks);
    const unresolvedOrigins = unknownOrigins.length ? `另有 ${unknownOrigins.length} 个旧任务来源连接待核实，保守占位（不能认定远端已停止）；` : '';
    const summary = `本地排队中（同连接最多同时生成 ${limit} 个；${scope.label}）`;
    const knownSecrets = [...this.credentials.values(), settings.videoTaskApi?.apiKey, settings.comfyuiVideo?.apiKey,
      settings.runningHubVideo?.apiKey, settings.textApi?.apiKey, settings.visionApi?.apiKey, settings.imageApi?.apiKey,
      ...(settings.videoApiProfiles || []).map((profile) => profile.apiKey),
      ...(settings.textApiProfiles || []).map((profile) => profile.apiKey),
      ...(settings.visionApiProfiles || []).map((profile) => profile.apiKey),
      ...(settings.imageApiProfiles || []).map((profile) => profile.apiKey),
      ...(settings.apiCredentialBook || []).map((entry) => entry.apiKey)]
      .filter((secret): secret is string => typeof secret === 'string' && Boolean(secret));
    const blockers = videoQueueBlockerSummary(allProjects(state), task, knownSecrets, new Set(this.generationClaims.keys()));
    const reason = waitingForJournal
      ? `${summary}：正在核对同连接或来源连接待核实的历史提交记录；本任务尚未发送到服务端。`
      : unknownOrigins.length || uncertain.length
        ? `${summary}：同连接有 ${confirmedOrigins} 个占位任务；${unresolvedOrigins}远端状态尚未确认的任务请恢复查询；本任务尚未提交，不会重复扣费。`
        : `${summary}：等待同连接前序视频生成结束后自动提交（已占用 ${confirmedOrigins} 个名额）；本任务尚未发送到服务端。`;
    this.patch(task, {
      status: 'draft', error: undefined,
      videoJob: { ...job, ...(task.batchId ? { batchQueueState: 'ready' as const } : {}) },
    }, {
      stage: 'queued',
      message: blockers ? `${reason}\n${blockers}` : reason,
    });
  }

  private generationClaimCanDispatch(taskId: string): boolean {
    const target = this.liveTask(taskId);
    if (!target) return false;
    const scope = videoTaskExecutionScope(target);
    if (this.generationClaims.get(taskId)?.key !== scope.key) return false;
    const tasks = this.generationScopeTasks(target);
    const occupied = tasks.filter(videoTaskOccupiesGenerationSlot);
    if (occupied.some((task) => task.id === taskId)) return true;
    if (this.hasUnrestoredGenerationPreparation(tasks)) return false;
    const remaining = (target.videoJob?.snapshot.connection.api?.provider === 'rhtv_web' ? 1 : resolveVideoExecutionLimit(this.options.getState().settings)) - occupied.length;
    const orderedClaims = tasks.filter((task) => {
      const claimScope = this.generationClaims.get(task.id);
      return claimScope && videoExecutionScopesMayShareCapacity(claimScope, scope)
        && !occupied.some((remote) => remote.id === task.id);
    }).sort((left, right) => left.createdAt - right.createdAt
      || (left.batchId === right.batchId ? (left.batchIndex || 0) - (right.batchIndex || 0) : 0)
      || left.id.localeCompare(right.id));
    return remaining > 0 && orderedClaims.slice(0, remaining).some((task) => task.id === taskId);
  }

  private wakeGenerationQueue() {
    if (this.disposed || this.queueWakeupPending) return;
    this.queueWakeupPending = true;
    queueMicrotask(() => {
      this.queueWakeupPending = false;
      if (!this.disposed) this.reconcile();
    });
  }

  private advanceControlEpoch(taskId: string): number {
    const epoch = (this.controlEpochs.get(taskId) || 0) + 1;
    this.controlEpochs.set(taskId, epoch);
    // An obsolete, possibly non-settling IPC query must not occupy the new
    // session's poll slot. Its finally block owns only its original lease.
    if (this.pollLeases.delete(taskId)) this.busy.delete(taskId);
    // An unresolved acknowledgement lookup must neither own the replacement
    // session's slot nor make it await the retired session's cached queue read.
    if (this.acknowledgementChecks.delete(taskId)) this.comfyQueuePresence.clear();
    const acknowledgementTimer = this.acknowledgementTimers.get(taskId);
    if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
    this.acknowledgementTimers.delete(taskId);
    this.acknowledgementRetries.delete(taskId);
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    return epoch;
  }

  private controlIsCurrent(task: VideoGenerationTask, epoch: number, allowRemoved = false): boolean {
    if (this.disposed || (this.controlEpochs.get(task.id) || 0) !== epoch) return false;
    const current = this.liveTask(task.id);
    return current?.videoJob ? videoWatchIdentity(current) === videoWatchIdentity(task) : allowRemoved;
  }

  private releaseCancellation(taskId: string, epoch: number) {
    const pending = this.remoteCancellations.get(taskId);
    pending?.delete(epoch);
    if (!pending?.size) this.remoteCancellations.delete(taskId);
  }

  private restoreOrphanCancellation(task: VideoGenerationTask) {
    const epoch = this.controlEpochs.get(task.id) || 0;
    this.patch(task, {}, {
      stage: 'stopped', trackingStopped: true, cancellationPending: false, cancellationConfirmed: false,
      message: '上次远端取消确认已中断；当前仅停止本地跟踪，未确认服务器任务已取消。请恢复查询原任务，确认结束后再删除本地记录。',
    });
    const stopped = this.liveTask(task.id);
    if (!stopped) return;
    void (async () => {
      try {
        const saved = await this.options.desktop?.saveVideoTaskCheckpoint?.(stopped);
        if (this.options.desktop?.saveVideoTaskCheckpoint && !saved?.persisted) throw new Error('本地停止记录尚未保存');
        if (this.controlIsCurrent(task, epoch)) await this.options.persistState?.();
      } catch (error) {
        if (this.controlIsCurrent(task, epoch)) this.options.notify?.(`本地停止状态已恢复，保存记录暂时失败：${messageOf(error)}`, 'error');
      }
    })();
  }

  private archivedDependencyKey(projectId: string, taskId: string): string {
    return JSON.stringify([projectId, taskId]);
  }

  /** Archived cards never become runnable tasks. Only the durable success
   * journal may certify their existing local video as a chain dependency. */
  private chainTasks(task: VideoGenerationTask): VideoGenerationTask[] {
    const projectId = task.videoJob!.snapshot.projectId;
    const project = allProjects(this.options.getState()).find((entry) => entry.id === projectId);
    if (!project || !task.batchId) return [];
    const live = project.generationTasks.filter((entry): entry is VideoGenerationTask => (
      (entry.kind === 'video' || entry.kind == null) && entry.batchId === task.batchId
      && entry.videoJob?.snapshot.projectId === projectId
    ));
    const liveIds = new Set(project.generationTasks.map((entry) => entry.id));
    const candidates = new Map<string, VideoGenerationTask[]>();
    for (const asset of project.assets) {
      const archived = asset.videoSourceTask;
      if (!isVideoAsset(asset) || !archived?.videoJob || !archived.id || liveIds.has(archived.id)
        || asset.sourceVideoTaskId !== archived.id || archived.batchId !== task.batchId
        || archived.videoJob.snapshot.projectId !== projectId || !archived.videoJob.snapshot.batchCompletionOrder) continue;
      const entries = candidates.get(archived.id) || [];
      entries.push(archived); candidates.set(archived.id, entries);
    }
    for (const [taskId, entries] of candidates) {
      const source = entries[0];
      // Conflicting provenance is never resolved by picking the first asset.
      if (entries.some((entry) => canonicalText(entry) !== canonicalText(source))) continue;
      const signature = this.archivedDependencySignature(project, source);
      const key = this.archivedDependencyKey(projectId, taskId);
      const cached = this.archivedDependencies.get(key);
      if (cached?.signature === signature && this.validArchivedDependency(project, source, cached.task)) {
        live.push(cached.task);
      } else if (!this.restoringArchivedDependencies.has(key) && this.archivedDependencyAttempts.get(key) !== signature) {
        this.archivedDependencyAttempts.set(key, signature);
        this.restoringArchivedDependencies.add(key);
        void this.restoreArchivedDependency(projectId, source, signature);
      }
    }
    return live.sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0) || left.createdAt - right.createdAt);
  }

  private archivedDependencySignature(project: Project, source: VideoGenerationTask): string {
    return canonicalText([source, project.assets.filter((asset) => asset.sourceVideoTaskId === source.id)
      .map((asset) => [asset.id, asset.type, asset.mediaType, asset.relativePath, asset.checksum, asset.missing])]);
  }

  private validArchivedDependency(project: Project, source: VideoGenerationTask, saved: VideoGenerationTask): boolean {
    const job = saved.videoJob;
    const sourceJob = source.videoJob;
    if (!job || !sourceJob || saved.id !== source.id || job.snapshot.projectId !== project.id
      || sourceJob.snapshot.projectId !== project.id || saved.status !== 'succeeded' || job.stage !== 'succeeded'
      || job.preparation?.phase !== 'acknowledged' || job.trackingStopped || job.cancellationPending || job.downloadError
      || job.resultSelectionRequired || !saved.resultAssetId || !saved.batchId || !Number.isSafeInteger(saved.batchIndex)
      || saved.batchIndex! < 1 || !job.snapshot.batchCompletionOrder
      || canonicalText([saved.id, saved.createdAt, saved.remoteTaskId, saved.batchId, saved.batchIndex, saved.batchItemKey, saved.batchTotal,
        saved.batchConcurrency, saved.requestFingerprint, saved.storyboardId, saved.sequencePlanId, saved.segmentId, saved.segmentIndex, job.snapshot])
        !== canonicalText([source.id, source.createdAt, source.remoteTaskId, source.batchId, source.batchIndex, source.batchItemKey, source.batchTotal,
          source.batchConcurrency, source.requestFingerprint, source.storyboardId, source.sequencePlanId, source.segmentId, source.segmentIndex, sourceJob.snapshot])
      || canonicalText(job.resultAssetIds) !== canonicalText(sourceJob.resultAssetIds)
      || job.resultArchiveFileName !== sourceJob.resultArchiveFileName
      || source.resultAssetId && source.resultAssetId !== saved.resultAssetId) return false;
    const asset = project.assets.find((entry) => entry.id === saved.resultAssetId);
    return Boolean(asset && isVideoAsset(asset) && !asset.missing && asset.relativePath && asset.checksum
      && asset.sourceVideoTaskId === saved.id && (!job.resultAssetIds || job.resultAssetIds.includes(asset.id)));
  }

  private async restoreArchivedDependency(projectId: string, source: VideoGenerationTask, signature: string) {
    const key = this.archivedDependencyKey(projectId, source.id);
    try {
      // A copied/imported success flag without its matching durable journal is
      // not proof that the prior POST completed and its output was saved.
      const saved = await this.options.desktop?.getVideoTaskCheckpoint?.(source.id);
      let project = allProjects(this.options.getState()).find((entry) => entry.id === projectId);
      if (this.disposed || !saved || !project || project.generationTasks.some((entry) => entry.id === source.id)
        || this.archivedDependencySignature(project, source) !== signature || !this.validArchivedDependency(project, source, saved)) return;
      await this.options.persistState?.();
      project = allProjects(this.options.getState()).find((entry) => entry.id === projectId);
      if (this.disposed || !project || project.generationTasks.some((entry) => entry.id === source.id)
        || this.archivedDependencySignature(project, source) !== signature || !this.validArchivedDependency(project, source, saved)) return;
      this.archivedDependencies.set(key, { signature, task: saved });
    } catch { /* No verified archive means the existing dependency gate stays closed. */ }
    finally {
      this.restoringArchivedDependencies.delete(key);
      if (!this.disposed) this.reconcile();
    }
  }

  private chainPredecessor(task: VideoGenerationTask, taskId: string): VideoGenerationTask | undefined {
    return this.chainTasks(task).find((entry) => entry.id === taskId);
  }

  private chainDependencyReady(task: VideoGenerationTask): boolean {
    const job = task.videoJob;
    if (!job) return false;
    if (!job.snapshot.batchCompletionOrder) return !job.snapshot.previousTail && !job.snapshot.batchPredecessorTaskId;
    if (!task.batchId || !task.batchIndex || this.cancelledBatches.has(task.batchId)) return false;
    const batch = this.chainTasks(task);
    if (batch.some((entry) => this.checkpointErrors.has(entry.id))) return false;
    const predecessors = batch.filter((entry) => (entry.batchIndex || 0) < task.batchIndex!);
    if (predecessors.length !== task.batchIndex - 1) return false;
    if (task.batchIndex > 1 && job.snapshot.batchPredecessorTaskId !== predecessors[predecessors.length - 1]?.id) return false;
    if (task.batchIndex === 1 && job.snapshot.batchPredecessorTaskId) return false;
    return predecessors.every((predecessor) => Boolean(this.completedLocalAsset(predecessor, job.snapshot.projectId)));
  }

  private completedLocalAsset(task: VideoGenerationTask, projectId: string): ReferenceAsset | undefined {
    const archived = !this.liveTask(task.id) && this.archivedDependencies.get(this.archivedDependencyKey(projectId, task.id))?.task === task;
    if (this.downloading.has(task.id) || this.completionPersistence.has(task.id) || !archived && this.stopping.has(task.id)
      || task.videoJob?.trackingStopped || task.status !== 'succeeded' || task.videoJob?.stage !== 'succeeded'
      || task.videoJob.snapshot.projectId !== projectId || task.videoJob.downloadError || task.videoJob.resultSelectionRequired || !task.resultAssetId
      || (task.videoJob.resultAssetIds?.length || 0) > 1 && !archived && !this.resultSelectionsRestored.has(task.id)) return undefined;
    const project = allProjects(this.options.getState()).find((entry) => entry.id === projectId);
    const asset = project?.assets.find((entry) => entry.id === task.resultAssetId);
    return asset && isVideoAsset(asset) && !asset.missing && asset.relativePath && asset.checksum
      && asset.sourceVideoTaskId === task.id ? asset : undefined;
  }

  private tailIdentityMatches(task: VideoGenerationTask): boolean {
    const snapshot = task.videoJob?.snapshot;
    const dependency = snapshot?.previousTail;
    if (!dependency || dependency.version !== 1 || !snapshot?.batchCompletionOrder || !task.batchId
      || dependency.predecessorTaskId !== snapshot.batchPredecessorTaskId) return false;
    const project = allProjects(this.options.getState()).find((entry) => entry.id === snapshot.projectId);
    const predecessor = project && this.chainPredecessor(task, dependency.predecessorTaskId);
    const reference = snapshot.draft.references[dependency.referenceIndex];
    const image = snapshot.images[dependency.referenceIndex];
    return Boolean(predecessor?.videoJob && predecessor.batchId === task.batchId
      && predecessor.batchItemKey === dependency.predecessorItemKey && predecessor.requestFingerprint === dependency.predecessorRequestFingerprint
      && predecessor.sequencePlanId === dependency.sequencePlanId && predecessor.segmentId === dependency.predecessorSegmentId
      && predecessor.segmentIndex === dependency.predecessorSegmentIndex && predecessor.videoJob.snapshot.projectId === snapshot.projectId
      && predecessor.videoJob.snapshot.draft.source?.sequencePlanId === dependency.sequencePlanId
      && predecessor.videoJob.snapshot.draft.source?.segmentId === dependency.predecessorSegmentId
      && predecessor.videoJob.snapshot.draft.source?.segmentIndex === dependency.predecessorSegmentIndex
      && task.sequencePlanId === dependency.sequencePlanId && task.segmentId === dependency.segmentId && task.segmentIndex === dependency.segmentIndex
      && snapshot.draft.source?.sequencePlanId === dependency.sequencePlanId && snapshot.draft.source?.segmentId === dependency.segmentId
      && snapshot.draft.source?.segmentIndex === dependency.segmentIndex && dependency.segmentIndex === dependency.predecessorSegmentIndex + 1
      && dependency.predecessorSegmentId !== dependency.segmentId
      && ['first-frame', 'composition', 'general'].includes(dependency.referenceRole)
      && reference?.assetId === dependency.reservedFrameAssetId && reference.role === dependency.referenceRole
      && image?.assetId === dependency.reservedFrameAssetId && image.role === dependency.referenceRole);
  }

  private tailReady(task: VideoGenerationTask): boolean {
    const job = task.videoJob;
    if (!job?.snapshot.previousTail) return !job?.tailPreparation;
    if (this.tailPreparations.has(task.id) || job.tailPreparation?.phase !== 'ready' || !this.tailIdentityMatches(task)) return false;
    const image = job.snapshot.images[job.snapshot.previousTail.referenceIndex];
    const predecessor = this.chainPredecessor(task, job.snapshot.previousTail.predecessorTaskId);
    const asset = predecessor && this.completedLocalAsset(predecessor, job.snapshot.projectId);
    return Boolean(asset && asset.id === job.tailPreparation.sourceVideoAssetId && asset.relativePath === job.tailPreparation.sourceRelativePath
      && asset.checksum === job.tailPreparation.sourceChecksum && image.freezeState === 'frozen' && image.relativePath && image.checksum);
  }

  private async prepareTail(original: VideoGenerationTask, retry = false): Promise<void> {
    const task = this.liveTask(original.id);
    const job = task?.videoJob;
    const dependency = job?.snapshot.previousTail;
    if (!task || !job || !dependency || this.disposed || job.trackingStopped || this.stopping.has(task.id)
      || job.preparation?.phase !== 'preparing' || !['ready', 'active'].includes(job.batchQueueState || '')
      || job.tailPreparation?.phase === 'ready' || job.tailPreparation?.phase === 'cancelled' || this.tailPreparations.has(task.id)
      || !this.restoredCheckpoints.has(task.id) || this.restoringCheckpoints.has(task.id)) return;
    if (!retry && job.tailPreparation?.phase === 'blocked' && job.tailPreparation.errorCode !== 'source-not-ready') return;
    const predecessor = this.chainPredecessor(task, dependency.predecessorTaskId);
    if (!predecessor && this.restoringArchivedDependencies.has(this.archivedDependencyKey(job.snapshot.projectId, dependency.predecessorTaskId))) return;
    const predecessorAsset = predecessor && this.completedLocalAsset(predecessor, job.snapshot.projectId);
    if (this.tailIdentityMatches(task) && (!predecessorAsset || !this.chainDependencyReady(task))) {
      const selecting = predecessor?.videoJob?.resultSelectionRequired;
      const blocked = predecessor?.status === 'failed' || predecessor?.videoJob?.downloadError || predecessor?.videoJob?.trackingStopped;
      const phase = blocked ? 'blocked' as const : 'waiting' as const;
      const message = selecting ? `第 ${dependency.predecessorSegmentIndex} 段返回多段视频，请先选择用于衔接的成片；本段未提交。`
        : blocked ? `第 ${dependency.predecessorSegmentIndex} 段尚未成功保存，请先处理上一段；本段未提交。` : `等待第 ${dependency.predecessorSegmentIndex} 段视频完成并保存到本地后再抽取尾帧。`;
      if (job.tailPreparation?.phase !== phase || job.tailPreparation.message !== message) this.patch(task, {
        videoJob: { ...job, message, tailPreparation: { ...job.tailPreparation, phase, revision: (job.tailPreparation?.revision || 0) + 1, errorCode: blocked ? 'source-not-ready' : undefined, message } },
      });
      return;
    }
    this.tailPreparations.add(task.id);
    let settlePreparation!: () => void;
    this.tailPreparationSettlements.set(task.id, new Promise<void>((resolve) => { settlePreparation = resolve; }));
    const selectionController = new AbortController();
    this.tailSelectionControllers.set(task.id, selectionController);
    try {
      this.ensureActive(task);
      if (!this.tailIdentityMatches(task) || !predecessorAsset) throw new Error('上一段任务或尾帧依赖身份不匹配，未改用其他项目或其他视频。');
      const source = { sourceVideoAssetId: predecessorAsset.id, sourceRelativePath: predecessorAsset.relativePath!, sourceChecksum: predecessorAsset.checksum! };
      if (job.tailPreparation?.sourceVideoAssetId && (job.tailPreparation.sourceVideoAssetId !== source.sourceVideoAssetId
        || job.tailPreparation.sourceRelativePath !== source.sourceRelativePath || job.tailPreparation.sourceChecksum !== source.sourceChecksum)) throw new Error('上一段成片来源已经改变，不能把新来源覆盖到旧尾帧任务。');
      const checkSource = (): VideoGenerationTask => {
        this.ensureActive(task);
        const current = this.liveTask(task.id)!;
        if (!this.tailIdentityMatches(current) || !this.chainDependencyReady(current)) throw new Error('抽帧期间上一段任务或依赖身份发生变化，未绑定迟到结果。');
        const currentPredecessor = this.chainPredecessor(current, dependency.predecessorTaskId);
        const currentSource = currentPredecessor && this.completedLocalAsset(currentPredecessor, job.snapshot.projectId);
        if (!currentSource || currentSource.id !== source.sourceVideoAssetId || currentSource.relativePath !== source.sourceRelativePath
          || currentSource.checksum !== source.sourceChecksum) throw new Error('抽帧期间上一段成片来源发生变化，未绑定旧来源的迟到结果。');
        return current;
      };
      let live = this.liveTask(task.id)!;
      let image = live.videoJob!.snapshot.images[dependency.referenceIndex];
      if (image.freezeState !== 'frozen') {
        const aiAssisted = dependency.selectionMode === 'ai-assisted';
        let selection: VideoTailSelectionPreparation | undefined = live.videoJob!.tailPreparation?.selection;
        let frame: WorkbenchExtractedFrame;
        if (aiAssisted && selection?.status === 'completed' && selection.frame) {
          if (dependency.requireAiSelection && selection.source !== 'ai') throw new Error('已保存的衔接帧不是 AI 选帧结果，请重新请求 AI 选择；本段尚未提交。');
          // The selected pixels may be durable in the independent journal even
          // when a crash preceded their binding into the task image/asset list.
          frame = structuredClone(selection.frame);
          if (!this.options.desktop?.readManagedImageDataUrl) throw new Error('已保存的 AI 选帧无法读取，请检查素材存储。');
          await this.options.desktop.readManagedImageDataUrl({ relativePath: frame.relativePath!, expectedChecksum: frame.checksum });
          live = checkSource();
        } else {
          if (!this.options.desktop?.extractWorkbenchFrames || !this.options.desktop.videoWorkbenchStatus) throw new Error('本地视频抽帧工具不可用，请检查 FFmpeg。');
          const status = await this.options.desktop.videoWorkbenchStatus();
          live = checkSource();
          if (!status.available) throw new Error(status.message || '本地视频抽帧工具不可用。');
          const message = aiAssisted ? '上一段视频已保存，正在准备末段候选帧与 AI 辅助分析。' : '上一段视频已保存，正在抽取真实最后一帧。';
          live = await this.checkpoint({ ...live, videoJob: { ...live.videoJob!, message, tailPreparation: { ...live.videoJob!.tailPreparation, phase: 'extracting', revision: (live.videoJob!.tailPreparation?.revision || 0) + 1, ...source, message } } });
          await this.options.persistState?.();
          live = checkSource();
          const extractionJobId = id(`video_tail_${task.id}`);
          const mediaSource = { assetId: source.sourceVideoAssetId, relativePath: source.sourceRelativePath, expectedChecksum: source.sourceChecksum };
          if (aiAssisted && (selection?.status !== 'started' || retry && dependency.requireAiSelection) && this.options.selectTailFrame) {
            const owner = allProjects(this.options.getState()).find((project) => project.id === job.snapshot.projectId);
            const storyContext = owner?.sequencePlans.find((plan) => plan.id === dependency.sequencePlanId)?.sourceStoryContent;
            // Old snapshots never silently acquire a larger paid budget. An
            // explicit strict retry authorizes a fresh bounded run without
            // rewriting the immutable original dependency definition.
            const maxAiAttempts = retry && dependency.requireAiSelection ? 4 : dependency.aiMaxAttempts ?? 1;
            const aiRun = (selection?.run || 0) + 1;
            let startedAttempt = 0;
            let startedSelection: VideoTailSelectionPreparation | undefined;
            const result = await this.options.selectTailFrame({
              desktop: this.options.desktop, jobId: extractionJobId, projectId: job.snapshot.projectId,
              source: mediaSource, previousPrompt: predecessor!.videoJob!.snapshot.draft.prompt,
              nextPrompt: job.snapshot.draft.prompt, storyContext, signal: selectionController.signal,
              requireAiSelection: dependency.requireAiSelection,
              maxAiAttempts,
              onProgress: (progress) => {
                const current = this.liveTask(task.id);
                if (!this.disposed && !this.stopping.has(task.id) && current?.videoJob && !selectionController.signal.aborted) this.patch(current, {}, { message: progress });
              },
              onBeforeAI: async (attempt) => {
                live = checkSource();
                const savedSelection = live.videoJob!.tailPreparation?.selection;
                if (savedSelection?.status === 'completed'
                  || savedSelection?.status === 'started' && startedAttempt === 0 && !(retry && dependency.requireAiSelection)) throw new Error('此任务的 AI 选帧请求已经记录，不会重复调用。');
                if (attempt && (!Number.isSafeInteger(attempt.attempt) || attempt.attempt !== startedAttempt + 1
                  || attempt.maxAttempts !== maxAiAttempts || attempt.attempt > maxAiAttempts
                  || !Number.isSafeInteger(attempt.maxTokens) || attempt.maxTokens < 1)
                  || startedAttempt > 0 && (!attempt || savedSelection?.run !== aiRun || savedSelection.attempt !== startedAttempt)) {
                  throw new Error('AI 选帧重试记录不连续，已停止重复请求；本段尚未提交。');
                }
                const nextSelection: VideoTailSelectionPreparation = { status: 'started', ...(attempt ? { run: aiRun, ...attempt } : {}) };
                const message = `正在由视觉 AI 分析候选帧${attempt ? `（第 ${attempt.attempt}/${attempt.maxAttempts} 次）` : ''}；不使用本地人物完整度规则拦截。`;
                live = await this.checkpoint({ ...live, videoJob: { ...live.videoJob!, message, tailPreparation: {
                  ...live.videoJob!.tailPreparation, phase: 'extracting', revision: (live.videoJob!.tailPreparation?.revision || 0) + 1,
                  ...source, message, selection: nextSelection,
                } } });
                await this.options.persistState?.();
                live = checkSource();
                startedAttempt = attempt?.attempt ?? 1;
                startedSelection = nextSelection;
              },
            });
            live = checkSource();
            if (dependency.requireAiSelection && result.selection.source !== 'ai') throw new Error('AI 没有返回选帧结果，未改用原尾帧，本段尚未提交。');
            frame = result.frame;
            selection = { ...startedSelection, status: 'completed', ...result.selection, frame: structuredClone(frame) };
          } else {
            if (dependency.requireAiSelection) throw new Error(selection?.status === 'started'
              ? '上次 AI 选帧请求结果未保存。没有自动重复收费，也没有改用原尾帧；请点击“重试 AI 选帧（可能收费）”。'
              : 'AI 选帧服务暂不可用，未改用原尾帧，本段尚未提交。');
            this.tailExtractionJobs.set(task.id, extractionJobId);
            const extraction = await this.options.desktop.extractWorkbenchFrames({
              jobId: extractionJobId, projectId: job.snapshot.projectId, source: mediaSource,
              mode: 'last', fileName: `${job.snapshot.draft.name}-上段尾帧.png`,
            });
            live = checkSource();
            if (extraction.frames.length !== 1) throw new Error(`尾帧抽取返回 ${extraction.frames.length} 张图片，无法确定唯一尾帧。`);
            frame = extraction.frames[0];
            if (frame.role !== 'last-frame') throw new Error('尾帧抽取没有返回真实最后一帧。');
            if (aiAssisted) selection = {
              ...selection, status: 'completed', source: 'last-frame', selectedId: 'last', reason: '已使用上一段视频的真实最后一帧。',
              warning: selection?.status === 'started'
                ? '上次 AI 选帧分析已开始但结果未完整保存，为避免重复收费，已回退真实尾帧继续生成。'
                : 'AI 辅助选帧服务不可用，已回退真实尾帧继续生成。',
              selectedTimeSec: frame.timeSec, lastFrameTimeSec: frame.timeSec, offsetFromEndSec: 0, candidateCount: 1,
              frame: structuredClone(frame),
            };
          }
          if (aiAssisted) {
            // This result checkpoint precedes binding. A persistence failure or
            // restart reuses exactly this selection, never purchases it again.
            this.patch(live, { videoJob: { ...live.videoJob!, tailPreparation: {
              ...live.videoJob!.tailPreparation, phase: 'extracting', revision: (live.videoJob!.tailPreparation?.revision || 0) + 1,
              ...source, selection,
            } } });
            live = await this.checkpoint(this.liveTask(task.id)!);
            await this.options.persistState?.();
            live = checkSource();
          }
        }
        if (!['last-frame', ...(aiAssisted ? ['custom-frame', 'first-frame'] : [])].includes(frame.role)
          || !frame.relativePath || !frame.checksum || frame.missing || frame.mediaType !== 'image'
          || !Number.isFinite(frame.timeSec) || frame.timeSec < 0) throw new Error('衔接帧没有保存为可校验的本地图片。');
        live = checkSource();
        image = live.videoJob!.snapshot.images[dependency.referenceIndex];
        const earlierFrame = Boolean(selection?.source === 'ai' && (selection.offsetFromEndSec || 0) > 0);
        const frameLabel = earlierFrame ? '上段 AI 衔接帧' : '上段尾帧';
        const frameAsset: ReferenceAsset = {
          ...frame, id: dependency.reservedFrameAssetId, name: `${job.snapshot.draft.name} · ${frameLabel}`,
          type: earlierFrame ? 'reference' : 'last-frame', role: earlierFrame ? 'composition' : 'last-frame', referenceRole: earlierFrame ? 'composition' : 'last-frame', source: 'derived',
          sourceVideoAssetId: source.sourceVideoAssetId, sourceVideoChecksum: source.sourceChecksum, sourceTimeSec: frame.timeSec, sourceFrameIndex: frame.frameIndex,
          tags: ['视频抽帧', aiAssisted ? 'AI 辅助选帧' : '自动衔接尾帧'], createdAt: Date.now(), updatedAt: Date.now(),
        };
        const images = [...live.videoJob!.snapshot.images]; images[dependency.referenceIndex] = { ...image, name: frameLabel, fileName: frame.fileName, relativePath: frame.relativePath, checksum: frame.checksum, freezeState: 'frozen', frozenAt: Date.now(), dataUrl: undefined, url: frame.url };
        const message = selection?.warning || (earlierFrame ? 'AI 已选择上段末尾较早的衔接帧，原视频未剪辑；请留意动作回退。' : '上一段尾帧已保存，等待提交本段。');
        const nextJob = { ...live.videoJob!, snapshot: { ...live.videoJob!.snapshot, images }, tailPreparation: { phase: 'ready' as const, revision: (live.videoJob!.tailPreparation?.revision || 0) + 1, ...source, ...(selection ? { selection } : {}), message } };
        this.options.setState((current) => applyOwnedProjectUpdate(current, job.snapshot.projectId, (project) => ({ ...project, assets: [frameAsset, ...project.assets.filter((asset) => asset.id !== frameAsset.id)], generationTasks: project.generationTasks.map((entry) => entry.id === task.id ? { ...entry, videoJob: nextJob, updatedAt: Date.now() } : entry) })));
      } else {
        // A previous persistence failure already produced the correct PNG.
        // Validate/reuse that exact file instead of re-extracting a new frame.
        await this.imageData(live, this.imageAsset(image));
        this.ensureActive(live);
        live = checkSource();
        this.patch(live, { videoJob: { ...live.videoJob!, tailPreparation: { ...live.videoJob!.tailPreparation, phase: 'ready', revision: (live.videoJob!.tailPreparation?.revision || 0) + 1, ...source, message: '已恢复已抽取衔接帧，正在保存衔接记录。' } } });
      }
      // tailPreparations is also checked at every submission entry. Neither a
      // React reconcile nor an explicit resume can see this as authorization
      // until BOTH the frame asset/main state and the ready journal are durable.
      await this.options.persistState?.();
      this.ensureActive(task);
      await this.checkpoint(this.liveTask(task.id)!);
      this.ensureActive(task);
      const completedTail = this.liveTask(task.id)!;
      this.patch(completedTail, {}, { message: completedTail.videoJob!.tailPreparation?.message || 'AI 衔接帧已保存，等待提交本段。' });
      const warning = this.liveTask(task.id)?.videoJob?.tailPreparation?.selection?.warning;
      if (warning) this.options.notify?.(warning);
    } catch (error) {
      const current = this.liveTask(task.id);
      if (!this.disposed && !this.stopping.has(task.id) && current?.videoJob && current.videoJob.tailPreparation?.phase !== 'cancelled') {
        const message = `自动衔接暂停，后段未提交：${messageOf(error)}；可重试衔接或取消。`;
        this.patch(current, { videoJob: { ...current.videoJob, message, tailPreparation: { ...current.videoJob.tailPreparation, phase: 'blocked', revision: (current.videoJob.tailPreparation?.revision || 0) + 1, errorCode: 'extract-failed', message } } }, { message });
        const blocked = this.liveTask(task.id)!;
        await this.options.desktop?.saveVideoTaskCheckpoint?.(blocked).catch(() => {});
        try { await this.options.persistState?.(); } catch { /* remain blocked in memory; no POST */ }
        this.options.notify?.(message, 'error');
      }
    } finally {
      this.tailExtractionJobs.delete(task.id);
      this.tailSelectionControllers.delete(task.id);
      this.tailPreparations.delete(task.id);
      this.tailPreparationSettlements.delete(task.id);
      settlePreparation();
      if (!this.disposed) this.reconcile();
    }
  }

  private ensureActive(task: VideoGenerationTask) {
    const current = this.liveTask(task.id);
    if (this.disposed || this.stopping.has(task.id) || !current || current.videoJob?.trackingStopped
      || current.videoJob?.snapshot.projectId !== task.videoJob?.snapshot.projectId) throw new Error('本地跟踪已停止');
  }

  /** The independent journal prevents a delayed project autosave from erasing the POST boundary. */
  private async checkpoint(task: VideoGenerationTask): Promise<VideoGenerationTask> {
    this.ensureActive(task);
    const checkpoint = structuredClone({ ...task, updatedAt: Date.now() });
    if (this.options.desktop?.saveVideoTaskCheckpoint) {
      try {
        const saved = await this.options.desktop.saveVideoTaskCheckpoint(checkpoint);
        if (!saved.persisted) throw new Error('视频任务准备记录保存失败，尚未提交生成。');
      } catch (error) {
        if (checkpoint.videoJob?.preparation?.phase !== 'acknowledged') throw error;
        // Once the server provides an ID/result, retain it even if the secondary journal write fails.
        // The earlier durable POST boundary still prevents duplicate generation on a crash.
        this.ensureActive(task);
        this.patch(task, checkpoint);
        try { await this.options.persistState?.(); } catch { /* keep the known remote result in memory */ }
        this.options.notify?.(`服务端已返回任务结果，准备记录暂未保存：${messageOf(error)}；继续处理原任务，不会重新生成。`, 'error');
        return checkpoint;
      }
    }
    this.ensureActive(task);
    this.patch(task, checkpoint);
    if (!this.options.desktop?.saveVideoTaskCheckpoint) await this.options.persistState?.();
    return checkpoint;
  }

  private patch(task: VideoGenerationTask, patch: Partial<VideoGenerationTask>, progress?: Partial<VideoGenerationRuntime>) {
    if (this.disposed || (this.stopping.has(task.id) && !this.find(task.id))) return;
    const projectId = task.videoJob?.snapshot.projectId;
    if (!projectId) return;
    if (progress) {
      const previous = this.runtimes.get(task.id) || runtimeOnly(task.videoJob!);
      const runtime = { ...previous, ...progress };
      if (!sameRuntime(previous, runtime)) { this.runtimes.set(task.id, runtime); this.options.onRuntime(task.id, runtime); }
    }
    const { videoJob: jobPatch, ...taskPatch } = patch;
    const combinedJobPatch = { ...jobPatch, ...progress };
    const changed = (current: VideoGenerationTask) => !samePatch(current, taskPatch) || !samePatch(current.videoJob || {}, combinedJobPatch);
    const currentTask = this.liveTask(task.id);
    if (currentTask && !changed(currentTask)) return;
    this.options.setState((current) => {
      const project = current.project.id === projectId ? current.project : current.projects.find((owner) => owner.id === projectId);
      if (!project) return current;
      const currentTask = project.generationTasks.find((item) => item.id === task.id && (item.kind === 'video' || item.kind == null)) as VideoGenerationTask | undefined;
      if (!currentTask || !changed(currentTask)) return current;
      return applyOwnedProjectUpdate(current, projectId, (owner) => ({
        ...owner,
        generationTasks: owner.generationTasks.map((item) => item === currentTask ? {
          ...currentTask, ...taskPatch, videoJob: { ...currentTask.videoJob!, ...combinedJobPatch }, updatedAt: Date.now(),
        } as VideoGenerationTask : item),
      }));
    });
  }

  private progress(task: VideoGenerationTask, patch: Partial<VideoGenerationRuntime>) {
    if (this.disposed || this.stopping.has(task.id)) return;
    const previous = this.runtimes.get(task.id) || runtimeOnly(task.videoJob!);
    // Only an authoritative running signal reaches this branch: ComfyUI's
    // execution/progress events or queue_running, and an API's running status.
    // Submission and queue acknowledgement deliberately never start the clock.
    let executionPatch = patch;
    if (previous.startedAt && patch.startedAt && patch.startedAt >= previous.startedAt) {
      const { startedAt: _duplicateStart, ...withoutDuplicateStart } = patch;
      executionPatch = withoutDuplicateStart;
    } else if (patch.stage === 'running' && !previous.startedAt && !patch.startedAt) {
      executionPatch = { ...patch, startedAt: Date.now() };
    }
    const runtime = { ...previous, ...executionPatch };
    if (sameRuntime(previous, runtime)) return;
    this.runtimes.set(task.id, runtime);
    this.options.onRuntime(task.id, runtime);
    // Presentation-only steps/bytes/node names are recoverable from the server.
    // Persist semantic state, never rewrite a large library just to advance a
    // progress bar. POST/checkpoint/output barriers use patch/checkpoint directly.
    if ((['stage', 'startedAt', 'submittedAt', 'generatedAt', 'completedAt', 'trackingStopped',
      'cancellationPending', 'cancellationConfirmed', 'downloadError'] as const)
      .some((key) => !Object.is(previous[key], runtime[key]))) {
      this.patch(task, { status: runtime.stage === 'running' ? 'running' : task.status }, executionPatch);
    }
  }

  private async key(task: VideoGenerationTask): Promise<string> {
    const scopedId = await this.credentialId(task);
    if (this.credentials.has(scopedId)) return this.credentials.get(scopedId)!;
    const restored = await this.options.desktop?.getVideoTaskCredential?.(scopedId);
    if (restored !== null && restored !== undefined) { this.credentials.set(scopedId, restored); return restored; }
    // No current-settings fallback: editing an interface must not send another provider's key to an old endpoint.
    return '';
  }

  private async credentialId(task: VideoGenerationTask): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('当前环境无法安全绑定视频任务凭据，请使用桌面版或本地安全连接。');
    const bytes = new TextEncoder().encode(`${task.id}\n${credentialScope(task.videoJob!.snapshot.connection)}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const scopedId = `video-task-scope-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const ids = this.credentialIdsByTask.get(task.id) || new Set<string>(); ids.add(scopedId); this.credentialIdsByTask.set(task.id, ids);
    return scopedId;
  }

  private async rememberKey(task: VideoGenerationTask, apiKey: string): Promise<{ persisted: boolean }> {
    const scopedId = await this.credentialId(task);
    this.credentials.set(scopedId, apiKey);
    return await this.options.desktop?.setVideoTaskCredential?.({ taskId: scopedId, apiKey }) || { persisted: false };
  }

  /** Restore preparation/retry credentials only from the exact frozen connection.
   * Polling continues to use key() so changing settings never switches an active
   * remote task to another account. Existing task keys are preserved by default. */
  private async recoverCredential(task: VideoGenerationTask, refreshRejected = false): Promise<string> {
    const saved = await this.key(task);
    if (saved.trim() && !refreshRejected) return saved;
    const current = this.options.getState().settings;
    const connection = task.videoJob!.snapshot.connection;
    const candidates = [current.videoTaskApi, ...(current.videoApiProfiles || [])];
    if (connection.backend === 'api' && connection.api?.provider === 'runninghub' && current.runningHubVideo) {
      for (const workflow of current.runningHubVideo.workflows) {
        try { candidates.push(compileRunningHubVideoApi(current.runningHubVideo, workflow.id, frozenRunningHubParameters(task.videoJob!.snapshot))); }
        catch { /* Unfinished workflows cannot supply credentials. */ }
      }
    }
    const matching = connection.backend === 'api'
      ? candidates.find((candidate) => candidate.apiKey?.trim()
        && credentialScope({ backend: 'api', api: withoutApiKey(candidate) }) === credentialScope(connection))?.apiKey
      : current.comfyuiVideo && credentialScope({ backend: 'comfyui', comfyui: (({ apiKey: _key, workflows: _workflows, ...safe }) => safe)(current.comfyuiVideo) }) === credentialScope(connection) ? current.comfyuiVideo.apiKey : undefined;
    if (!matching) return saved;
    await this.rememberKey(task, matching);
    return matching;
  }

  private requireRunningHubCredential(config: Omit<VideoTaskApiConfig, 'apiKey'> | undefined, apiKey: string | undefined) {
    if (config?.provider === 'runninghub' && !apiKey?.trim()) {
      throw new Error('RunningHub 任务缺少可用 API 密钥。请在“视频连接设置”中检查原连接的密钥，再继续任务；本次未发送请求。');
    }
  }

  private async headers(task: VideoGenerationTask): Promise<Record<string, string>> {
    const key = await this.key(task);
    const config = task.videoJob!.snapshot.connection;
    this.requireRunningHubCredential(config.api, key);
    const header = config.backend === 'api' ? config.api?.authHeader || 'Authorization' : 'Authorization';
    const scheme = config.backend === 'api' ? config.api?.authScheme ?? 'Bearer' : 'Bearer';
    return key ? { [header]: `${scheme ? `${scheme} ` : ''}${key}` } : {};
  }

  private async request(task: VideoGenerationTask, payload: Omit<RequestInput, 'requestId'>, cancellationControl = false): Promise<unknown> {
    if (this.disposed || (!cancellationControl && (this.stopping.has(task.id) || !this.liveTask(task.id)))) throw new Error('本地跟踪已停止');
    const requestId = id(`video_${task.id}`);
    const requests = this.requestIds.get(task.id) || new Set<string>();
    requests.add(requestId); this.requestIds.set(task.id, requests);
    try {
      const bridge = this.options.desktop;
      let response: Awaited<ReturnType<Desktop['videoRequest']>>;
      if (task.videoJob?.snapshot.connection.api?.provider === 'rhtv_web') {
        if (!bridge?.rhtvRequest) throw new Error('rhTV 网页桥接仅在新版桌面程序中可用');
        response = await bridge.rhtvRequest({ ...payload, method: payload.method || 'GET', requestId });
      } else if (bridge?.videoRequest) response = await bridge.videoRequest({ ...payload, method: payload.method || 'GET', requestId });
      else {
        let body: BodyInit | undefined = payload.body;
        if (payload.multipart) {
          const form = new FormData();
          const fields = payload.multipart.fields || {};
          if (Array.isArray(fields)) fields.forEach((field) => form.append(field.name, field.value));
          else Object.entries(fields).forEach(([name, value]) => form.append(name, value));
          for (const file of payload.multipart.files) form.append(file.fieldName || file.name || 'file', await (await fetch(file.dataUrl)).blob(), file.fileName);
          body = form;
        }
        // Browser development fallback also has no deadline. Desktop release uses the cancellable main-process bridge.
        const result = await fetch(payload.url, { method: payload.method || 'GET', headers: payload.headers, body });
        response = { status: result.status, body: await result.text() };
      }
      let result: unknown = response.body;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* allow explicit non-JSON HTTP error */ } }
      if (response.status < 200 || response.status >= 300) {
        const detail = record(result) ? String(result.message || nestedValue(result, 'error.message') || nestedValue(result, 'base_resp.status_msg') || '') : '';
        throw new HttpError(response.status, `HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      }
      return result;
    } finally { requests.delete(requestId); }
  }

  private comfyQueue(task: VideoGenerationTask, headers: Record<string, string>) {
    const endpoint = join(task.videoJob!.snapshot.connection.comfyui!.baseUrl, '/queue');
    return this.comfyQueuePresence.get(endpoint, headers, () => this.request(task, { url: endpoint, headers }),
      Math.min(1000, Math.max(1, (this.options.pollIntervalMs || 5000) / 2)));
  }

  private async pauseMissingComfyTask(task: VideoGenerationTask) {
    const current = this.liveTask(task.id);
    if (!current?.videoJob || !pending(current) || this.stopping.has(task.id)
      || videoWatchIdentity(current) !== videoWatchIdentity(task)) return;
    const message = '多次成功查询仍未在 ComfyUI 队列或历史中找到原任务，已暂停本地追踪以减少资源占用；没有重新生成，也没有取消服务器任务。可点击“恢复查询原任务”继续核对。';
    this.patch(current, { status: 'unknown', error: message }, { stage: 'stopped', trackingStopped: true, message });
    this.comfyMissingTasks.reset(task.id);
    await this.stopWatch(task.id);
    const stopped = this.liveTask(task.id);
    if (!stopped?.videoJob?.trackingStopped || stopped.videoJob.message !== message) return;
    // This is a resumable local pause, not a cancellation and not a new POST
    // boundary. Keep the exact remote ID/snapshot in both durable stores.
    try {
      const saved = await this.options.desktop?.saveVideoTaskCheckpoint?.(stopped);
      if (this.options.desktop?.saveVideoTaskCheckpoint && !saved?.persisted) throw new Error('暂停状态尚未写入任务记录');
      await this.options.persistState?.();
    } catch (error) {
      this.options.notify?.(`原 ComfyUI 任务已在当前窗口暂停；暂停记录暂未保存：${messageOf(error)}`, 'error');
    }
  }

  private async imageData(task: VideoGenerationTask, asset: ReferenceAsset): Promise<string> {
    if (asset.missing) throw new Error(`图片“${asset.name}”文件丢失，请重新关联素材。`);
    if (asset.relativePath && this.options.desktop?.readManagedImageDataUrl) {
      return (await this.options.desktop.readManagedImageDataUrl({ relativePath: asset.relativePath, expectedChecksum: asset.checksum })).dataUrl;
    }
    if (asset.dataUrl?.startsWith('data:image/')) return asset.dataUrl;
    if (asset.url && /^https?:\/\//iu.test(asset.url)) {
      const requestId = id(`video_image_${task.id}`);
      const requests = this.requestIds.get(task.id) || new Set<string>(); requests.add(requestId); this.requestIds.set(task.id, requests);
      let result: Awaited<ReturnType<Desktop['videoRequest']>> | undefined;
      try { result = await this.options.desktop?.videoRequest?.({ requestId, url: asset.url, method: 'GET', responseType: 'base64' }); }
      finally { requests.delete(requestId); }
      if (result && result.status >= 200 && result.status < 300 && result.bodyEncoding === 'base64' && result.contentType?.startsWith('image/')) return `data:${result.contentType.split(';')[0]};base64,${result.body}`;
      if (!this.options.desktop) {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
        const blob = await response.blob();
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
      }
      throw new Error(`无法读取图片“${asset.name}”的实际像素数据。`);
    }
    throw new Error(`图片“${asset.name}”没有可读取的素材，不能把本地路径发给视频模型。`);
  }

  private imageAsset(image: VideoGenerationSnapshot['images'][number]): ReferenceAsset {
    return { ...image, id: image.assetId, type: 'reference', role: 'composition', referenceRole: image.role, tags: [], createdAt: 0, updatedAt: 0 };
  }

  private async freezeImage(task: VideoGenerationTask, image: VideoGenerationSnapshot['images'][number]): Promise<{ image: VideoGenerationSnapshot['images'][number]; dataUrl: string }> {
    const dataUrl = await this.imageData(task, this.imageAsset(image));
    this.ensureActive(task);
    if (task.videoJob?.snapshot.previousTail?.reservedFrameAssetId === image.assetId) {
      if (image.freezeState !== 'frozen' || !image.relativePath || !image.checksum) throw new Error('上段尾帧没有可信原始文件，后段未提交。');
      return { image, dataUrl };
    }
    if (this.options.desktop?.storeGeneratedImage) {
      const managed = await this.options.desktop.storeGeneratedImage({ dataUrl, fileName: image.fileName || `${image.assetId}.png` });
      this.ensureActive(task);
      if (!managed.relativePath || !managed.checksum) throw new Error(`图片“${image.name}”快照保存失败，尚未提交生成。`);
      return { image: { assetId: image.assetId, role: image.role, ...(image.slotIndex !== undefined ? { slotIndex: image.slotIndex } : {}), name: image.name, fileName: managed.fileName, relativePath: managed.relativePath, checksum: managed.checksum, freezeState: 'frozen', frozenAt: image.frozenAt || Date.now() }, dataUrl };
    }
    // A browser has no managed-file bridge. Persist the captured bytes, never reread a mutable asset/URL.
    return { image: { assetId: image.assetId, role: image.role, ...(image.slotIndex !== undefined ? { slotIndex: image.slotIndex } : {}), name: image.name, fileName: image.fileName, dataUrl, freezeState: 'frozen', frozenAt: image.frozenAt || Date.now() }, dataUrl };
  }

  /** Resolve and structurally validate one batch row without changing project
   * state, storing files, uploading inputs or issuing a generation POST. */
  private async preflightBatchItem(
    state: AppState,
    project: Project,
    item: VideoBatchItemInput,
    index: number,
  ): Promise<PreparedBatchItem> {
    const itemKey = String(item.itemKey || '').trim();
    if (!itemKey || itemKey.length > 500 || /[\r\n\u0000]/u.test(itemKey)) throw new Error(`批量第 ${index + 1} 项缺少有效条目标识。`);
    const draft = structuredClone(item.draft);
    if (!draft.prompt.trim()) throw new Error(`批量第 ${index + 1} 项“${itemKey}”缺少视频提示词。`);
    let requestedTail = item.previousTail;
    if (requestedTail !== undefined) {
      if (!validVideoBatchPreviousTail(requestedTail)) throw new Error(`批量第 ${index + 1} 项的自动尾帧配置无效。`);
    }
    // Validate exactly the references that will be submitted, before reading any
    // asset. A confirmed single-slot replacement excludes all old selections.
    const validationDraft = structuredClone(draft);
    if (requestedTail) {
      const placement = requestedTail.placement;
      const rememberedRoles = videoReferenceSelection(draft.references, draft.referenceSlotRoles).referenceSlotRoles!;
      validationDraft.references = videoBatchTailReferences(draft.references, placement, 'future-tail-validation');
      // Preflight must use the same physical-slot coordinates as the frozen
      // task. The additional-reference purposes move together with their
      // images when the local tail reserves slot 1.
      validationDraft.referenceSlotRoles = videoReferenceSelection(validationDraft.references,
        placement.mode === 'prepend' ? [placement.role, ...rememberedRoles]
          : placement.mode === 'replace-all' ? [placement.role] : rememberedRoles).referenceSlotRoles;
    }
    const reusedTask = draft.reuseTaskId ? findProjectVideoTask(project, draft.reuseTaskId) : undefined;
    const reused = reusedTask?.videoJob?.snapshot;
    const reuse = reused && reused.projectId === project.id && reused.connection.backend === draft.backend
      && draft.workflowId === reused.draft.workflowId && draft.apiProfileId === reused.draft.apiProfileId
      && draft.runningHubWorkflowId === reused.draft.runningHubWorkflowId ? reused : undefined;
    const assets = validationDraft.references.map((reference, referenceIndex) => {
      if (requestedTail && referenceIndex === requestedTail.placement.index) return undefined;
      const frozen = reuse?.images.find((image) => image.assetId === reference.assetId);
      if (frozen) {
        if (!(frozen.relativePath && frozen.checksum) && !(frozen.freezeState === 'frozen' && frozen.dataUrl?.startsWith('data:image/'))) {
          throw new Error(`批量第 ${index + 1} 项的旧任务图片“${frozen.name}”没有可信原始字节，请重新选择图片。`);
        }
        return this.imageAsset({ ...structuredClone(frozen), role: reference.role });
      }
      const asset = project.assets.find((candidate) => candidate.id === reference.assetId);
      if (!asset || asset.type === 'video' || asset.type === 'audio') throw new Error(`批量第 ${index + 1} 项所选图片已不存在或不是图片资产。`);
      if (asset.missing) throw new Error(`批量第 ${index + 1} 项的图片“${asset.name}”文件丢失，请重新关联素材。`);
      return structuredClone(asset);
    });
    const config: VideoTaskApiConfig | undefined = reuse?.connection.api ? { ...reuse.connection.api, apiKey: await this.recoverCredential(reusedTask!) }
      : draft.backend === 'api' ? resolveConfiguredVideoApi(state.settings, draft) : undefined;
    const comfy: ComfyVideoConfig = reuse?.connection.comfyui
      ? { ...reuse.connection.comfyui, apiKey: await this.key(reusedTask!), workflows: reuse.connection.workflow ? [reuse.connection.workflow] : [] }
      : state.settings.comfyuiVideo || defaultComfyVideoConfig;
    const workflow = reuse?.connection.workflow || comfy.workflows.find((entry) => entry.id === (draft.workflowId || comfy.activeWorkflowId));
    validationDraft.references = videoReferenceUsage(validationDraft.references, { backend: draft.backend, workflow, api: config, slotRoles: validationDraft.referenceSlotRoles });
    if (requestedTail) {
      // A per-segment slot purpose is authoritative even when it differs from
      // the historical tail placement role.  Keep the selected physical slot
      // and surface any semantic mismatch in the director UI; do not block a
      // valid upload or silently move the tail image to another slot.  The
      // confirmed tail role itself remains authoritative for the replacement
      // frame, so a remembered per-segment role cannot turn it into a generic
      // identity image before the provider request is built.
      const placement = requestedTail.placement;
      if (validationDraft.references[placement.index]) {
        validationDraft.references[placement.index] = {
          ...validationDraft.references[placement.index], role: placement.role,
        };
      }
      if (validationDraft.referenceSlotRoles) {
        const slotRoles = [...validationDraft.referenceSlotRoles];
        const slotIndex = placement.slotIndex ?? placement.index;
        slotRoles[slotIndex] = placement.role;
        validationDraft.referenceSlotRoles = slotRoles;
      }
    }
    const apiEndpoint = config ? videoApiSubmitEndpoint(config) : '';
    if (draft.backend === 'api' && (!config?.enabled || !apiEndpoint)) {
      throw new Error(`批量第 ${index + 1} 项无法提交：${config?.provider === 'runninghub' ? '请先启用 RunningHub，并选择已填写云端 ID 的工作流。' : '请先启用并设置视频 API。'}`);
    }
    this.requireRunningHubCredential(config, config?.apiKey);
    if (draft.backend === 'comfyui' && (!comfy.enabled || !comfy.baseUrl.trim() || !workflow)) throw new Error(`批量第 ${index + 1} 项无法提交：请先启用 ComfyUI 视频并选择工作流。`);
    if (requestedTail?.placement.mode === 'replace-all' && !getVideoTailReferencePlacements({
      backend: draft.backend, workflow, api: config, references: draft.references,
    }).options.some((placement) => placement.mode === 'replace-all' && placement.role === requestedTail.placement.role)) {
      throw new Error(`批量第 ${index + 1} 项整体替换只适用于已确认的单图连接，请重新选择尾帧位置。`);
    }
    if (requestedTail?.placement.mode === 'prepend') {
      const composite = getVideoTailCharacterPlacement({ backend: draft.backend, workflow, api: config, references: draft.references });
      if (!composite.placement || composite.placement.role !== requestedTail.placement.role) {
        throw new Error(`批量第 ${index + 1} 项本地末帧＋参考图无效：${composite.reason || '第 1 个图片槽用途已变化，请重新设置。'}`);
      }
    }
    assertNoEmbeddedVideoCredentials(draft.parameters, `批量第 ${index + 1} 项视频参数`);
    if (draft.backend === 'api' && config?.requestTemplate?.trim()) {
      let template: unknown;
      try { template = JSON.parse(config.requestTemplate); } catch { throw new Error(`批量第 ${index + 1} 项的视频 API 请求模板不是有效 JSON。`); }
      assertNoEmbeddedVideoCredentials(template, `批量第 ${index + 1} 项视频 API 模板`);
    }
    // Preflight the *future* frame slot as well. A text-only template/workflow
    // must fail before segment 1 can create a billable remote task.
    const validationImages = assets.map((asset, assetIndex) => asset ? `image-validation-${assetIndex}-${asset.fileName || asset.name}` : 'future-tail-validation.png');
    const boundValidation = prepareVideoH3ReferenceDraft(project, validationDraft, { backend: draft.backend, workflow, api: config });
    Object.assign(validationDraft, boundValidation.draft);
    // Pending-tail drafts keep their pre-insertion image array for dependency
    // placement, but display/fingerprint the exact eventual submission text.
    draft.prompt = validationDraft.prompt;
    draft.h3ReferenceBinding = validationDraft.h3ReferenceBinding;
    draft.h3ReferenceWarnings = validationDraft.h3ReferenceWarnings;
    if (draft.backend === 'comfyui') {
      assertNoEmbeddedVideoCredentials(parseComfyVideoWorkflow(workflow!.workflowJson), `批量第 ${index + 1} 项 ComfyUI 工作流`);
      bindComfyVideoWorkflow(workflow!, validationDraft.prompt, validationImages, validationDraft.parameters, validationDraft.references);
      // Slot roles configured by a workflow describe the physical input, but
      // image roles are selected per segment.  A mismatch is surfaced by the
      // director UI as a warning only; it must not block a valid upload or
      // change the user's selected image order.
    } else {
      const body = buildVideoApiBody(config!, validationDraft, validationImages);
      assertOfficialH3Submission(body, validationDraft, project);
    }
    // This must be byte-for-byte identical to the candidate fingerprint shown
    // by videoBatch.ts; UI duplicate badges and engine idempotency share it.
    const baseRequestFingerprint = videoBatchRequestFingerprint(
      draft,
      project.assets,
      reuse?.connection || videoBatchConnectionIdentity(state.settings, draft),
      requestedTail?.placement.mode === 'prepend' ? 1 : 0,
    );
    const requestFingerprint = videoBatchDependencyFingerprint(baseRequestFingerprint, requestedTail);
    return {
      item: { ...item, itemKey, ...(requestedTail ? { previousTail: requestedTail } : {}) }, index, draft, assets, config, comfy, workflow,
      apiKey: draft.backend === 'api' ? config!.apiKey : comfy.apiKey,
      requestFingerprint,
    };
  }

  private async createBatchTaskShell(
    prepared: PreparedBatchItem,
    project: Project,
    batchId: string,
    label: string,
    concurrency: number,
    batchIndex: number,
    total: number,
    predecessorTask?: VideoGenerationTask,
    chainEnabled = false,
    continuation?: BatchContinuationCreation,
  ): Promise<VideoGenerationTask> {
    const continued = continuation?.sources.get(prepared.item.itemKey);
    if (continuation && !continued) throw new Error('续跑条目缺少原任务认领，未创建新的收费任务。');
    const taskId = continued?.targetTaskId || id('video_task');
    const now = this.nextTaskCreatedAt();
    const draft = structuredClone(prepared.draft);
    const requestedTail = prepared.item.previousTail;
    let previousTail: VideoGenerationSnapshot['previousTail'];
    let reservedFrameAssetId = '';
    if (requestedTail) {
      if (!validVideoBatchPreviousTail(requestedTail)) throw new Error(`批量第 ${batchIndex} 项自动衔接定义无效。`);
      if (!predecessorTask?.id || !predecessorTask.requestFingerprint || !predecessorTask.videoJob?.snapshot.draft.source?.sequencePlanId || !predecessorTask.segmentId || predecessorTask.segmentIndex == null) {
        throw new Error(`批量第 ${batchIndex} 项找不到唯一的上一段任务，已停止创建链式批次。`);
      }
      const placement = requestedTail.placement;
      const rememberedRoles = videoReferenceSelection(draft.references, draft.referenceSlotRoles).referenceSlotRoles!;
      reservedFrameAssetId = id('asset_tail_frame');
      draft.references = videoBatchTailReferences(draft.references, placement, reservedFrameAssetId);
      // Occupied references and empty-slot purpose memory share one coordinate
      // system. Prepending the tail moves both by exactly one; replacement and
      // gap filling update only the target physical slot.
      draft.referenceSlotRoles = videoReferenceSelection(draft.references,
        placement.mode === 'prepend' ? [placement.role, ...rememberedRoles]
          : placement.mode === 'replace-all' ? [placement.role] : rememberedRoles).referenceSlotRoles;
      previousTail = {
        version: 1,
        predecessorTaskId: predecessorTask.id,
        predecessorItemKey: requestedTail.predecessorItemKey,
        predecessorRequestFingerprint: predecessorTask.requestFingerprint,
        sequencePlanId: draft.source?.sequencePlanId || '',
        predecessorSegmentId: predecessorTask.segmentId || predecessorTask.videoJob.snapshot.draft.source?.segmentId || '',
        predecessorSegmentIndex: (predecessorTask.segmentIndex ?? predecessorTask.videoJob.snapshot.draft.source?.segmentIndex) || 0,
        segmentId: draft.source?.segmentId || '',
        segmentIndex: draft.source?.segmentIndex ?? 0,
        referenceIndex: placement.index,
        referenceRole: placement.role,
        reservedFrameAssetId,
        ...(requestedTail.selectionMode === 'ai-assisted' ? { selectionMode: 'ai-assisted' as const } : {}),
        ...(requestedTail.requireAiSelection ? { requireAiSelection: true as const, aiMaxAttempts: 4 } : {}),
      };
    }
      draft.references = videoReferenceUsage(draft.references, { backend: draft.backend, workflow: prepared.workflow, api: prepared.config, slotRoles: draft.referenceSlotRoles });
    Object.assign(draft, prepareVideoH3ReferenceDraft(project, draft, { backend: draft.backend, workflow: prepared.workflow, api: prepared.config }).draft);
    const { apiKey: _comfyKey, workflows: _workflows, ...safeComfy } = prepared.comfy;
    const snapshot: VideoGenerationSnapshot = {
      projectId: project.id,
      draft,
      connection: draft.backend === 'api'
        ? { backend: 'api', api: withoutApiKey(prepared.config!) }
        : { backend: 'comfyui', comfyui: safeComfy, workflow: structuredClone(prepared.workflow!) },
      images: draft.references.map((reference, imageIndex) => {
        if (reference.assetId === reservedFrameAssetId) return {
          ...reference, name: '等待上一段尾帧', freezeState: 'pending' as const,
        };
        const asset = prepared.assets[imageIndex];
        if (!asset) throw new Error(`批量第 ${batchIndex} 项第 ${imageIndex + 1} 个参考图快照缺失；此次没有提交。`);
        return {
          ...reference, name: asset.name, fileName: asset.fileName, relativePath: asset.relativePath,
          checksum: asset.checksum, dataUrl: asset.dataUrl,
          url: /^https?:\/\//iu.test(asset.url || '') ? asset.url : undefined,
          freezeState: 'pending' as const,
        };
      }),
      clientId: id('video_client'),
      ...(previousTail ? { previousTail } : {}),
      ...(chainEnabled ? { batchCompletionOrder: true } : {}),
      ...(predecessorTask ? { batchPredecessorTaskId: predecessorTask.id } : {}),
      ...(continued ? { continuedFrom: { version: 1 as const, planId: continuation!.planId,
        batchId: continued.task.batchId!, taskId: continued.task.id, requestFingerprint: continued.task.requestFingerprint! } } : {}),
    };
    // Capture inline pixels before any task from the batch can be submitted.
    if (this.options.desktop?.storeGeneratedImage) for (let imageIndex = 0; imageIndex < snapshot.images.length; imageIndex += 1) {
      const image = snapshot.images[imageIndex];
      if (!image.dataUrl?.startsWith('data:image/')) continue;
      const managed = await this.options.desktop.storeGeneratedImage({ dataUrl: image.dataUrl, fileName: image.fileName });
      if (!managed.relativePath || !managed.checksum) throw new Error(`图片“${image.name}”快照保存失败，批量任务尚未提交。`);
      snapshot.images[imageIndex] = {
        assetId: image.assetId, role: image.role, ...(image.slotIndex !== undefined ? { slotIndex: image.slotIndex } : {}), name: image.name, fileName: managed.fileName,
        relativePath: managed.relativePath, checksum: managed.checksum, freezeState: 'frozen', frozenAt: Date.now(),
      };
    }
    return {
      id: taskId,
      kind: 'video',
      storyboardId: draft.source?.storyboardId || '',
      targetId: draft.backend === 'api' ? prepared.config?.model || 'api' : prepared.workflow?.name || 'comfyui',
      status: 'draft',
      requestBody: { prompt: draft.prompt, parameters: draft.parameters, referenceAssetIds: draft.references.map((reference) => reference.assetId) },
      sequencePlanId: draft.source?.sequencePlanId,
      segmentId: draft.source?.segmentId,
      segmentIndex: draft.source?.segmentIndex,
      batchId,
      batchLabel: label,
      batchItemKey: prepared.item.itemKey,
      batchIndex,
      batchTotal: total,
      batchConcurrency: concurrency,
      requestFingerprint: prepared.requestFingerprint,
      videoJob: {
        snapshot,
        stage: 'preparing',
        batchQueueState: 'waiting',
        preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
        message: '已加入批量任务，等待安全提交',
        ...(previousTail ? { tailPreparation: { phase: 'waiting' as const, revision: 0, message: '等待上一段视频完成并保存到本地' } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private fingerprintTask(project: Project, requestFingerprint: string): VideoGenerationTask | undefined {
    const persisted = project.generationTasks.filter((item): item is VideoGenerationTask => (
      (item.kind === 'video' || item.kind == null) && videoTaskMatchesRequestFingerprint(item as VideoGenerationTask, requestFingerprint)
    ));
    const owner = this.requestFingerprintOwners.get(requestFingerprintOwnerKey(project.id, requestFingerprint));
    const ownedTask = owner && !owner.startsWith('initializing:')
      ? persisted.find((task) => task.id === owner)
      : undefined;
    return (ownedTask && batchTaskStillBlocksDuplicate(ownedTask) ? ownedTask : undefined)
      || persisted.find(batchTaskStillBlocksDuplicate)
      || (ownedTask && batchTaskSucceeded(ownedTask) ? ownedTask : undefined)
      || persisted.find(batchTaskSucceeded)
      || ownedTask
      || persisted[0];
  }

  startBatch(input: VideoBatchStartInput): Promise<VideoBatchStartResult> {
    let invocationKey: string;
    try { invocationKey = canonicalText(input); }
    catch { return Promise.reject(new Error('批量视频参数无法序列化。')); }
    const existing = this.batchStarts.get(invocationKey);
    if (existing) return existing;
    const operation = this.startBatchInternal(structuredClone(input)).finally(() => {
      if (this.batchStarts.get(invocationKey) === operation) this.batchStarts.delete(invocationKey);
    });
    this.batchStarts.set(invocationKey, operation);
    return operation;
  }

  private async startBatchInternal(input: VideoBatchStartInput, signal?: AbortSignal, continuationGuard?: () => void, continuation?: BatchContinuationCreation): Promise<VideoBatchStartResult> {
    const checkContinuation = () => {
      if (signal?.aborted || signal && this.options.getState().project.id !== input.projectId) throw Object.assign(new Error('已取消或切换项目，本次批次未继续提交。'), { name: 'AbortError' });
      continuationGuard?.();
    };
    checkContinuation();
    if (this.disposed) throw new Error('视频任务控制器已停止。');
    const projectId = String(input.projectId || '').trim();
    const state = this.options.getState();
    const project = allProjects(state).find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('批量视频所属项目已不存在。');
    const label = String(input.label || '').trim() || '批量视频';
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('请至少选择一条视频提示词。');
    const keys = input.items.map((item) => String(item.itemKey || '').trim());
    if (new Set(keys).size !== keys.length) throw new Error('批量视频包含重复的条目标识，请重新选择。');
    const concurrency = batchConcurrency(input.concurrency);

    // Promise.all is safe here: preflight performs reads and pure validation only.
    // No task shell, upload or billable generation request exists until all pass.
    const prepared = await Promise.all(input.items.map((item, index) => this.preflightBatchItem(state, project, item, index)));
    checkContinuation();
    const chainEnabled = input.completionOrder === true || prepared.some((candidate) => Boolean(candidate.item.previousTail));
    const orderedPrepared = chainEnabled
      ? [...prepared].sort((left, right) => (left.draft.source?.segmentIndex || 0) - (right.draft.source?.segmentIndex || 0) || left.index - right.index)
      : prepared;
    if (chainEnabled) {
      if (!this.options.desktop?.extractWorkbenchFrames || !this.options.desktop.videoWorkbenchStatus
        || !this.options.desktop.saveVideoTaskCheckpoint || !this.options.persistState) throw new Error('自动尾帧衔接需要桌面本地抽帧与持久任务记录；本批次尚未提交。');
      const status = await this.options.desktop.videoWorkbenchStatus();
      checkContinuation();
      if (!status.available) throw new Error(`本地抽帧工具不可用：${status.message || '请检查 FFmpeg'}；本批次尚未提交。`);
      const plan = orderedPrepared[0].draft.source?.sequencePlanId;
      const segmentIds = new Set<string>();
      const indices = new Set<number>();
      for (let index = 0; index < orderedPrepared.length; index += 1) {
        const candidate = orderedPrepared[index];
        const source = candidate.draft.source;
        if (!plan || source?.sequencePlanId !== plan || !source.segmentId || !Number.isSafeInteger(source.segmentIndex)
          || source.segmentIndex! < 1 || segmentIds.has(source.segmentId) || indices.has(source.segmentIndex!)) {
          throw new Error('自动尾帧批次必须属于同一个分段计划，每段只选择一种语言且段号不能重复。');
        }
        segmentIds.add(source.segmentId); indices.add(source.segmentIndex!);
        const dependency = candidate.item.previousTail;
        if (!dependency) continue;
        const predecessor = orderedPrepared[index - 1];
        if (!predecessor || predecessor.item.itemKey !== dependency.predecessorItemKey
          || predecessor.draft.source?.segmentIndex !== source.segmentIndex! - 1) {
          throw new Error(`第 ${source.segmentIndex} 段必须同时选择同计划的第 ${source.segmentIndex! - 1} 段，不能跳段或改用其他视频的尾帧。`);
        }
        // Parent text/settings are part of a child's intent. The item key alone
        // would incorrectly reuse an old child after its parent was edited.
        candidate.requestFingerprint = videoBatchDependencyFingerprint(candidate.requestFingerprint, dependency, predecessor.requestFingerprint);
      }
    }
    const batchId = continuation?.batchId || id('video_batch');
    const skipped: VideoBatchSkippedItem[] = [];
    const selected: PreparedBatchItem[] = [];
    for (const candidate of orderedPrepared) {
      const ownerKey = requestFingerprintOwnerKey(projectId, candidate.requestFingerprint);
      const ownerMarker = this.requestFingerprintOwners.get(ownerKey);
      const existingTask = this.fingerprintTask(project, candidate.requestFingerprint);
      if (ownerMarker?.startsWith('initializing:') || existingTask && batchTaskStillBlocksDuplicate(existingTask)) {
        skipped.push({ itemKey: candidate.item.itemKey, requestFingerprint: candidate.requestFingerprint, reason: 'in-flight', taskId: existingTask?.id });
        continue;
      }
      if (existingTask && batchTaskSucceeded(existingTask) && !(input.force || candidate.item.force)) {
        skipped.push({ itemKey: candidate.item.itemKey, requestFingerprint: candidate.requestFingerprint, reason: 'succeeded', taskId: existingTask.id });
        continue;
      }
      this.requestFingerprintOwners.set(ownerKey, `initializing:${batchId}`);
      selected.push(candidate);
    }
    if (!selected.length) return { batchId: skipped[0]?.taskId ? this.find(skipped[0].taskId!)?.batchId || batchId : batchId, taskIds: [], skipped };

    const orderedSelected = selected;
    if (chainEnabled && skipped.length) {
      for (const candidate of selected) this.requestFingerprintOwners.delete(requestFingerprintOwnerKey(projectId, candidate.requestFingerprint));
      throw new Error('此自动衔接批次中有部分视频已生成或正在生成，不能部分跳过后继续串接。请继续原批次；如确需新版本，请等待旧任务结束后明确选择重新生成整批。此次没有创建新任务。');
    }
    this.initializingBatches.add(batchId);
    const reservedNames: string[] = [];
    let shells: VideoGenerationTask[] = [];
    let inserted = false;
    try {
      for (const candidate of orderedSelected) {
        candidate.draft.name = this.reserveVideoName(project, candidate.draft.name || candidate.draft.source?.label || label);
        reservedNames.push(candidate.draft.name);
      }
      // Local inline capture may fail, but still occurs only after every row's
      // structural preflight and before any shell/POST is created.
      shells = [];
      for (let selectedIndex = 0; selectedIndex < orderedSelected.length; selectedIndex += 1) {
        checkContinuation();
        const candidate = orderedSelected[selectedIndex];
        const predecessor = chainEnabled ? shells[selectedIndex - 1] : undefined;
        const shell = await this.createBatchTaskShell(
          candidate, project, batchId, label, concurrency,
          selectedIndex + 1, orderedSelected.length, predecessor, chainEnabled, continuation,
        );
        shells.push(shell);
      }
      checkContinuation();

      let warnedMemoryOnlyCredential = false;
      for (let index = 0; index < shells.length; index += 1) {
        const saved = await this.rememberKey(shells[index], orderedSelected[index].apiKey);
        checkContinuation();
        if (orderedSelected[index].apiKey && !saved.persisted && !warnedMemoryOnlyCredential) {
          warnedMemoryOnlyCredential = true;
          this.options.notify?.('系统加密不可用：批量任务可在本次运行中提交，关闭软件后需恢复凭据。', 'error');
        }
      }

      this.options.setState((current) => applyOwnedProjectUpdate(current, projectId, (owner) => ({
        ...owner,
        generationTasks: [...shells, ...owner.generationTasks],
      })));
      const insertedOwner = allProjects(this.options.getState()).find((candidate) => candidate.id === projectId);
      inserted = Boolean(insertedOwner && shells.every((shell) => insertedOwner.generationTasks.some((task) => task.id === shell.id)));
      if (!inserted) throw new Error('批量视频所属项目在创建任务前已被移除；本次没有提交视频。');
      shells.forEach((task) => this.requestFingerprintOwners.set(
        requestFingerprintOwnerKey(projectId, task.requestFingerprint!),
        task.id,
      ));
      await this.options.persistState?.();
      checkContinuation();

      // Each ready transition is independently journaled. A crash can at worst
      // leave a waiting task unsubmitted; it can never make a POST ambiguous.
      // For a completion-ordered chain, authorize segment 1 LAST. A crash in
      // the middle cannot make it billable while later entries lack journals.
      for (const shell of chainEnabled ? [...shells].reverse() : shells) {
        checkContinuation();
        const live = this.liveTask(shell.id);
        if (!live?.videoJob) continue;
        try {
          await this.checkpoint({
            ...live,
            videoJob: { ...live.videoJob, batchQueueState: 'ready', message: '批量任务已安全保存，等待提交' },
          });
          this.restoredCheckpoints.add(shell.id);
        } catch (error) {
          if (chainEnabled) throw error;
          const message = `批量任务准备记录保存失败，尚未提交：${messageOf(error)}`;
          this.patch(live, {
            status: 'failed', error: message,
            videoJob: { ...live.videoJob, batchQueueState: 'cancelled', stage: 'failed', completedAt: Date.now(), message },
          });
        }
      }
      try { await this.options.persistState?.(); }
      catch (error) { this.options.notify?.(`批量任务状态主文件暂未更新：${messageOf(error)}；独立提交记录已保留。`, 'error'); }
      checkContinuation();
      const liveOwner = allProjects(this.options.getState()).find((candidate) => candidate.id === projectId);
      if (!liveOwner || shells.some((shell) => !liveOwner.generationTasks.some((task) => task.id === shell.id))) {
        throw new Error('批量视频所属项目或任务在安全保存期间已被移除；本次没有继续提交。');
      }
    } catch (error) {
      const failureMessage = `批量任务未提交：${messageOf(error)}`;
      if (inserted) {
        for (const shell of shells) {
          const live = this.liveTask(shell.id);
          if (!live?.videoJob || live.remoteTaskId || live.videoJob.preparation?.phase !== 'preparing') continue;
          this.patch(live, {
            status: 'failed', error: failureMessage,
            videoJob: {
              ...live.videoJob,
              batchQueueState: 'cancelled', stage: 'failed', trackingStopped: true,
              ...(live.videoJob.snapshot.previousTail ? { tailPreparation: { ...live.videoJob.tailPreparation, phase: 'cancelled' as const, revision: (live.videoJob.tailPreparation?.revision || 0) + 1, errorCode: 'initialization-failed', message: failureMessage } } : {}),
              completedAt: Date.now(), message: failureMessage,
            },
          });
        }
        if (chainEnabled) {
          const failures: string[] = [];
          for (const shell of shells) {
            const stopped = this.liveTask(shell.id);
            if (!stopped?.videoJob || stopped.videoJob.preparation?.phase !== 'preparing' || stopped.remoteTaskId) continue;
            try {
              const saved = await this.options.desktop?.saveVideoTaskCheckpoint?.(stopped);
              if (!saved?.persisted) throw new Error('取消断点未落盘');
            } catch (cause) { failures.push(messageOf(cause)); }
          }
          try { await this.options.persistState?.(); } catch (cause) { failures.push(messageOf(cause)); }
          if (failures.length) this.options.notify?.(`此链式批次初始化失败，当前窗口不会提交；取消记录保存仍有异常，请勿关闭软件：${failures.join('；')}`, 'error');
        }
      }
      for (const candidate of selected) {
        const ownerKey = requestFingerprintOwnerKey(projectId, candidate.requestFingerprint);
        const owner = this.requestFingerprintOwners.get(ownerKey);
        if (owner === `initializing:${batchId}` || shells.some((shell) => shell.id === owner)) {
          this.requestFingerprintOwners.delete(ownerKey);
        }
      }
      for (const shell of shells) {
        for (const scopedId of this.credentialIdsByTask.get(shell.id) || []) {
          this.credentials.delete(scopedId);
          void this.options.desktop?.setVideoTaskCredential?.({ taskId: scopedId, apiKey: '' }).catch(() => {});
        }
        this.credentialIdsByTask.delete(shell.id);
      }
      throw error;
    } finally {
      reservedNames.forEach((name) => this.releaseVideoName(projectId, name));
      this.initializingBatches.delete(batchId);
    }
    this.scheduleBatch(batchId);
    return { batchId, taskIds: shells.map((task) => task.id), skipped };
  }

  async start(input: VideoGenerationDraft): Promise<string> {
    const state = this.options.getState();
    const project = state.project;
    const draft = structuredClone(input);
    if (!draft.prompt.trim()) throw new Error('请选择或填写本次视频提示词。');
    const reusedTask = draft.reuseTaskId ? this.find(draft.reuseTaskId) : undefined;
    const reused = reusedTask?.videoJob?.snapshot;
    const reuse = reused && reused.projectId === project.id && reused.connection.backend === draft.backend
      && draft.workflowId === reused.draft.workflowId && draft.apiProfileId === reused.draft.apiProfileId
      && draft.runningHubWorkflowId === reused.draft.runningHubWorkflowId ? reused : undefined;
    const assets = draft.references.map((reference) => {
      const frozen = reuse?.images.find((image) => image.assetId === reference.assetId);
      if (frozen) {
        // .82 managed bytes were protected by checksums; its inline/remote references were not captured.
        if (!(frozen.relativePath && frozen.checksum) && !(frozen.freezeState === 'frozen' && frozen.dataUrl?.startsWith('data:image/'))) {
          throw new Error(`旧任务的图片“${frozen.name}”没有保存原始字节，无法保证同图重生成。请明确重新选择图片后作为新任务生成；不会悄悄使用已更改的素材。`);
        }
        return this.imageAsset({ ...structuredClone(frozen), role: reference.role });
      }
      const asset = project.assets.find((item) => item.id === reference.assetId);
      if (!asset || asset.type === 'video' || asset.type === 'audio') throw new Error('所选图片已不存在或不是图片资产。');
      return structuredClone(asset);
    });
    const config: VideoTaskApiConfig | undefined = reuse?.connection.api ? { ...reuse.connection.api, apiKey: await this.recoverCredential(reusedTask!) }
      : draft.backend === 'api' ? resolveConfiguredVideoApi(state.settings, draft) : undefined;
    const comfy = reuse?.connection.comfyui ? { ...reuse.connection.comfyui, apiKey: await this.key(reusedTask!), workflows: reuse.connection.workflow ? [reuse.connection.workflow] : [] } : state.settings.comfyuiVideo || defaultComfyVideoConfig;
    const workflow = reuse?.connection.workflow || comfy.workflows.find((item) => item.id === (draft.workflowId || comfy.activeWorkflowId));
    draft.references = videoReferenceUsage(draft.references, { backend: draft.backend, workflow, api: config, slotRoles: draft.referenceSlotRoles });
    Object.assign(draft, prepareVideoH3ReferenceDraft(project, draft, { backend: draft.backend, workflow, api: config }).draft);
    const apiEndpoint = config ? videoApiSubmitEndpoint(config) : '';
    if (draft.backend === 'api' && (!config?.enabled || !apiEndpoint)) {
      throw new Error(config?.provider === 'runninghub' ? '请先启用 RunningHub，并选择已填写云端 ID 的工作流。' : '请先启用并设置视频 API 提交端点。');
    }
    this.requireRunningHubCredential(config, config?.apiKey);
    if (draft.backend === 'comfyui' && (!comfy.enabled || !comfy.baseUrl.trim() || !workflow)) throw new Error('请先启用 ComfyUI 视频并选择视频工作流。');
    assertNoEmbeddedVideoCredentials(draft.parameters, '视频参数');
    if (draft.backend === 'api' && config?.requestTemplate?.trim()) {
      let template: unknown;
      try { template = JSON.parse(config.requestTemplate); } catch { throw new Error('视频 API 请求模板不是有效 JSON。'); }
      assertNoEmbeddedVideoCredentials(template, '视频 API 模板');
    }
    if (draft.backend === 'comfyui') assertNoEmbeddedVideoCredentials(parseComfyVideoWorkflow(workflow!.workflowJson), 'ComfyUI 视频工作流');
    if (draft.backend === 'comfyui') bindComfyVideoWorkflow(workflow!, draft.prompt, assets.map((asset) => asset.fileName || asset.name), draft.parameters, draft.references);
    if (draft.backend === 'api') {
      const body = buildVideoApiBody(config!, draft, assets.map((_, index) => `image-validation-${index}`));
      assertOfficialH3Submission(body, draft, project);
    }
    // Physical workflow slot roles are informational metadata.  Each segment
    // may assign a different purpose to the selected image, so role conflicts
    // are warning-only and are never a submission gate.
    draft.name = this.reserveVideoName(project, draft.name || draft.source?.label || '生成视频');
    try {
      const taskId = id('video_task');
      const now = this.nextTaskCreatedAt();
      const { apiKey: _comfyKey, workflows: _workflows, ...safeComfy } = comfy;
      const snapshot: VideoGenerationSnapshot = {
        projectId: project.id, draft,
        connection: draft.backend === 'api' ? { backend: 'api', api: withoutApiKey(config!) } : { backend: 'comfyui', comfyui: safeComfy, workflow: structuredClone(workflow!) },
        images: draft.references.map((reference, index) => ({ ...reference, name: assets[index].name, fileName: assets[index].fileName, relativePath: assets[index].relativePath, checksum: assets[index].checksum, dataUrl: assets[index].dataUrl, url: /^https?:\/\//iu.test(assets[index].url || '') ? assets[index].url : undefined, freezeState: 'pending' })),
        clientId: id('video_client'),
      };
      const task: VideoGenerationTask = {
        id: taskId, kind: 'video', storyboardId: draft.source?.storyboardId || '', targetId: draft.backend === 'api' ? config?.model || 'api' : workflow?.name || 'comfyui',
        status: 'submitting', requestBody: { prompt: draft.prompt, parameters: draft.parameters, referenceAssetIds: draft.references.map((item) => item.assetId) },
        sequencePlanId: draft.source?.sequencePlanId, segmentId: draft.source?.segmentId, segmentIndex: draft.source?.segmentIndex,
        videoJob: { snapshot, stage: 'preparing', preparation: { version: 1, phase: 'preparing', uploadedImages: [] }, message: '正在准备已选择的提示词与图片' }, createdAt: now, updatedAt: now,
      };
      // Inline images are quick local writes. Never put their full pixels in desktop project JSON.
      if (this.options.desktop?.storeGeneratedImage) for (let index = 0; index < snapshot.images.length; index += 1) {
        const image = snapshot.images[index];
        if (!image.dataUrl?.startsWith('data:image/')) continue;
        const managed = await this.options.desktop.storeGeneratedImage({ dataUrl: image.dataUrl, fileName: image.fileName });
        if (!managed.relativePath || !managed.checksum) throw new Error(`图片“${image.name}”快照保存失败，尚未提交生成。`);
        snapshot.images[index] = { assetId: image.assetId, role: image.role, ...(image.slotIndex !== undefined ? { slotIndex: image.slotIndex } : {}), name: image.name, fileName: managed.fileName, relativePath: managed.relativePath, checksum: managed.checksum, freezeState: 'frozen', frozenAt: Date.now() };
      }
      if (this.disposed || this.options.getState().project.id !== project.id) throw new Error('已切换项目，本次视频尚未提交。');
      this.restoredCheckpoints.add(taskId);
      this.options.setState((current) => applyOwnedProjectUpdate(current, project.id, (owner) => ({ ...owner, generationTasks: [task, ...owner.generationTasks] })));
      this.releaseVideoName(project.id, draft.name);
      return this.prepareAndSubmit(task, draft.backend === 'api' ? config!.apiKey : comfy.apiKey);
    } catch (error) {
      this.releaseVideoName(project.id, draft.name);
      throw error;
    }
  }

  private async prepareAndSubmit(original: VideoGenerationTask, initialKey?: string): Promise<string> {
    const taskId = original.id;
    if (this.busy.has(taskId)) return taskId;
    if (original.videoJob?.preparation?.version !== 1 || original.videoJob.preparation.phase !== 'preparing' || original.remoteTaskId) return taskId;
    if (original.batchId && !['ready', 'active'].includes(original.videoJob.batchQueueState || '')) return taskId;
    if (!this.tailReady(original)) {
      throw new Error('本段依赖的上一段尾帧尚未保存，不能提交视频生成。');
    }
    if (!this.chainDependencyReady(original)) throw new Error('本段依赖的上一段视频尚未完成并落盘，不能提交视频生成。');
    // Existing queued records already own their durable credentials/snapshot.
    // Do not rewrite journals repeatedly while waiting for remote capacity.
    if (initialKey === undefined && !this.claimGenerationSlot(original)) {
      this.markLocallyQueued(original);
      return taskId;
    }
    this.busy.add(taskId);
    let task = original;
    let postStarted = false;
    try {
      this.ensureActive(task);
      if (initialKey !== undefined) {
        const saved = await this.rememberKey(task, initialKey);
        if (initialKey && !saved.persisted) this.options.notify?.('系统加密不可用：本次任务可生成，但关闭软件后需恢复凭据才能查询。', 'error');
      }
      // Establish trusted preparation first; an orphan journal cannot revive a missing project task.
      // A project JSON without its journal is never accepted as permission to resume a POST.
      task = await this.checkpoint(task);
      await this.options.persistState?.();
      if (!this.claimGenerationSlot(task)) {
        this.markLocallyQueued(this.liveTask(taskId) || task);
        const queued = this.liveTask(taskId);
        if (queued) await this.checkpoint(queued);
        await this.options.persistState?.();
        return taskId;
      }
      const admitted = this.liveTask(taskId) || task;
      this.patch(admitted, { status: 'submitting' }, { stage: 'preparing', message: '已取得视频生成名额，正在准备已选择的提示词与图片' });
      task = this.liveTask(taskId) || task;
      const draft = task.videoJob!.snapshot.draft;
      const config = task.videoJob!.snapshot.connection.api;
      const comfy = task.videoJob!.snapshot.connection.comfyui;
      const workflow = task.videoJob!.snapshot.connection.workflow;
      // Queued descendants may also have lost their old scoped keys. Restore
      // only during their authorized first-submission preparation, using the
      // same frozen connection check as an explicit retry.
      if (config?.provider === 'runninghub') await this.recoverCredential(task);
      this.ensureActive(task);
      const headers = await this.headers(task);
      const imageValues: string[] = [];
      for (let index = 0; index < task.videoJob!.snapshot.images.length; index += 1) {
        this.ensureActive(task);
        let image = task.videoJob!.snapshot.images[index];
        const uploaded = task.videoJob!.preparation!.uploadedImages[index];
        if (image.freezeState === 'frozen' && uploaded) { imageValues.push(uploaded); continue; }
        const frozen = await this.freezeImage(task, image);
        image = frozen.image;
        const images = [...task.videoJob!.snapshot.images]; images[index] = image;
        task = await this.checkpoint({ ...task, videoJob: { ...task.videoJob!, snapshot: { ...task.videoJob!.snapshot, images }, stage: 'preparing', message: `已保存原图快照，正在传入图片 ${index + 1}/${images.length}` } });
        const dataUrl = frozen.dataUrl;
        let uploadedValue: string | null = null;
        if (draft.backend === 'comfyui') {
          const result = await this.request(task, { url: join(comfy!.baseUrl, '/upload/image'), method: 'POST', headers, multipart: {
            fields: { overwrite: 'false', type: 'input' }, files: [{ fieldName: 'image', fileName: `${taskId}_${index}_${image.fileName || 'reference.png'}`, dataUrl }],
          } });
          if (!record(result) || !result.name) throw new Error('ComfyUI 图片上传未返回文件名。');
          uploadedValue = `${result.subfolder ? `${result.subfolder}/` : ''}${result.name}`;
        } else if (config!.provider === 'rhtv_web') {
          const result = await this.request(task, { url: `${RHTV_ORIGIN}/v1/assets`, method: 'POST', multipart: {
            files: [{ fieldName: 'file', fileName: image.fileName || 'reference.png', dataUrl }],
          } });
          const remote = nestedValue(result, 'upload_id');
          if (typeof remote !== 'string' || !/^[a-f0-9]{64}_(?:png|jpeg|webp)$/u.test(remote)) throw new Error('rhTV 原图暂存未返回有效标识');
          uploadedValue = remote;
        } else if (config!.imageUploadEndpoint) {
          const result = await this.request(task, { url: config!.imageUploadEndpoint, method: 'POST', headers, multipart: {
            files: [{ fieldName: config!.imageUploadField || 'file', fileName: image.fileName || 'reference.png', dataUrl }],
          } });
          if (config!.provider === 'runninghub') {
            const code = nestedValue(result, 'code');
            if (code != null && code !== '' && String(code) !== '0') {
              throw new Error(`RunningHub 图片上传失败：${String(nestedValue(result, 'message') || nestedValue(result, 'msg') || `错误码 ${String(code)}`)}；尚未提交视频生成。`);
            }
          }
          const remote = nestedValue(result, config!.imageUploadUrlPath || 'url');
          if (config!.provider === 'runninghub' ? !isRunningHubUploadedFile(remote) : typeof remote !== 'string' || !/^https?:\/\//iu.test(remote)) {
            throw new Error(config!.provider === 'runninghub'
              ? 'RunningHub 图片上传未返回可用的云端 fileName，请检查上传返回字段映射（ComfyUI 节点应使用 data.fileName）。'
              : '图片上传接口未返回视频服务可读取的网址，请检查上传返回字段映射。');
          }
          uploadedValue = remote as string;
        }
        imageValues.push(uploadedValue || dataUrl);
        const uploadedImages = [...task.videoJob!.preparation!.uploadedImages]; uploadedImages[index] = uploadedValue;
        task = await this.checkpoint({ ...task, videoJob: { ...task.videoJob!, preparation: { version: 1, phase: 'preparing', uploadedImages } } });
      }
      const body = draft.backend === 'api' ? buildVideoApiBody(config!, draft, imageValues) : {
        prompt: bindComfyVideoWorkflow(workflow!, draft.prompt, imageValues, draft.parameters, draft.references), client_id: task.videoJob!.snapshot.clientId,
      };
      if (config?.provider === 'rhtv_web') body.client_id = task.videoJob!.snapshot.clientId;
      if (draft.backend === 'api') {
        const ownerProject = allProjects(this.options.getState()).find((project) => project.id === task.videoJob!.snapshot.projectId);
        // Re-check immediately before the POST.  A queued/retried task may
        // outlive the storyboard source that was current when it was created;
        // never let that stale or hand-edited H3 text cross the paid boundary.
        assertOfficialH3Submission(body, draft, ownerProject);
      }
      const gated = this.liveTask(taskId);
      if (!gated || !this.tailReady(gated) || !this.chainDependencyReady(gated)) {
        throw new Error('尾帧或上一段成片在提交前失效，后段未提交。');
      }
      // Changing parallelism while reference uploads are in flight must not
      // create more remote jobs than the newly selected limit. Uploaded images
      // and frozen parameters stay reusable in this same queued task.
      if (!this.generationClaimCanDispatch(taskId)) {
        this.markLocallyQueued(gated);
        await this.checkpoint(this.liveTask(taskId)!);
        return taskId;
      }
      task = await this.checkpoint({ ...task, videoJob: { ...task.videoJob!, preparation: { ...task.videoJob!.preparation!, phase: 'post-started' }, stage: 'submitting', message: '正在提交视频任务；不会自动重复提交' } });
      this.ensureActive(task);
      if (!this.tailReady(task) || !this.chainDependencyReady(task)) throw new Error('保存提交边界期间上一段或尾帧失效；本段没有发送生成请求，请处理依赖后建立新任务。');
      postStarted = true;
      const result = await this.request(task, { url: draft.backend === 'api' ? videoApiSubmitEndpoint(config!) : join(comfy!.baseUrl, comfy!.promptPath || '/prompt'), method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const mapped = draft.backend === 'api' ? parseVideoApiResult(result, config!) : {
        remoteTaskId: record(result) && result.prompt_id ? String(result.prompt_id) : '', status: 'submitted' as const, stage: 'queued' as const, resultUrl: undefined, message: '已进入 ComfyUI 队列', fileId: undefined, downloadError: undefined,
      };
      if (draft.backend === 'comfyui' && record(result) && (result.error || (record(result.node_errors) && Object.keys(result.node_errors).length))) throw new HttpError(400, `ComfyUI 拒绝工作流：${JSON.stringify(result.error || result.node_errors)}`);
      if (!mapped.remoteTaskId && !mapped.resultUrl && !(mapped.status === 'succeeded' && (mapped.fileId || mapped.downloadError)) && mapped.status !== 'failed') {
        task = await this.checkpoint({ ...task, status: 'unknown', response: redactVideoSecrets(result), error: '接口已响应但没有可用任务 ID；请核对映射，不会再次提交。', videoJob: { ...task.videoJob!, stage: 'submission-unknown', message: '提交结果待确认，不会自动重新生成' } });
        return taskId;
      }
      // A synchronous Success+file_id is generated but still needs file retrieval.
      // Keep it pollable until its actual downloadable video has been resolved.
      const submittedAt = Date.now();
      const next = await this.checkpoint({ ...task, remoteTaskId: mapped.remoteTaskId, status: mapped.status === 'unknown' || (mapped.status === 'succeeded' && !mapped.resultUrl && !mapped.downloadError) ? 'submitted' : mapped.status, resultUrl: mapped.resultUrl, response: redactVideoSecrets(result), error: mapped.status === 'failed' ? mapped.message : undefined, videoJob: { ...task.videoJob!, preparation: { ...task.videoJob!.preparation!, phase: 'acknowledged' }, stage: mapped.stage, message: mapped.message, downloadError: mapped.downloadError, submittedAt, ...(['succeeded', 'failed'].includes(mapped.status) ? { remoteGenerationEnded: true as const } : {}), ...(mapped.stage === 'running' ? { startedAt: submittedAt } : {}), ...(mapped.status === 'failed' || mapped.downloadError ? { completedAt: submittedAt } : {}) } });
      if (!this.stopping.has(taskId)) {
        if (mapped.resultUrl) {
          // The provider is already terminal. Independent rows may use the
          // freed remote slot while this result is saved; tail dependencies
          // still require successful, durable local completion.
          if (task.batchId) void this.download(next);
          else await this.download(next);
        }
        else if (mapped.status !== 'failed' && !mapped.downloadError) { await this.watch(next); this.schedule(taskId, 0); }
      }
      return taskId;
    } catch (error) {
      if (this.disposed || !this.liveTask(taskId)) return taskId;
      const uncertain = postStarted && (!(error instanceof HttpError) || error.status >= 500);
      const stopped = this.stopping.has(taskId);
      this.patch(task, { status: uncertain ? 'unknown' : 'failed', error: messageOf(error),
        ...(!uncertain && task.videoJob?.preparation?.phase !== 'preparing'
          ? { videoJob: { ...task.videoJob!, remoteGenerationEnded: true as const } } : {}),
      }, {
        stage: stopped ? 'stopped' : uncertain ? 'submission-unknown' : 'failed', trackingStopped: stopped,
        message: uncertain ? '提交连接中断，服务端可能已接收；不会自动重投或重复扣费。' : messageOf(error),
        ...(!uncertain ? { completedAt: Date.now() } : {}),
      });
      const failed = this.liveTask(taskId);
      if (failed && !stopped) await this.options.desktop?.saveVideoTaskCheckpoint?.(failed).catch(() => {});
      if (!stopped) this.options.notify?.(uncertain ? '提交结果暂不确定，已保留记录，不会自动重复生成。' : messageOf(error), 'error');
      return taskId;
    } finally {
      this.busy.delete(taskId);
      if (this.generationClaims.delete(taskId)) this.wakeGenerationQueue();
    }
  }

  private tasksForBatch(batchId: string): VideoGenerationTask[] {
    return allProjects(this.options.getState()).flatMap((project) => project.generationTasks.filter((item): item is VideoGenerationTask => (
      (item.kind === 'video' || item.kind == null) && item.batchId === batchId
    ))).sort((left, right) => (left.batchIndex || 0) - (right.batchIndex || 0) || left.createdAt - right.createdAt);
  }

  private scheduleBatch(batchId: string) {
    if (!batchId || this.disposed || this.initializingBatches.has(batchId) || this.cancelledBatches.has(batchId)) return;
    // A live settings change may add capacity while a previous POST is still
    // awaiting acknowledgement. Another pump is safe: task claims plus the
    // connection-scoped generation gate, not an awaiting Promise, own admission.
    void this.runBatch(batchId).catch((error) => {
      if (!this.disposed) this.options.notify?.(`批量视频调度暂停：${messageOf(error)}`, 'error');
    });
  }

  private async runBatch(batchId: string): Promise<void> {
    const initial = this.tasksForBatch(batchId);
    if (!initial.length || this.cancelledBatches.has(batchId)) return;
    const concurrency = resolveVideoExecutionLimit(this.options.getState().settings);
    const claimNext = (): VideoGenerationTask | undefined => {
      if (this.disposed || this.cancelledBatches.has(batchId)) return undefined;
      const candidates = this.tasksForBatch(batchId).filter((task) => (
        !this.batchClaims.has(task.id)
        && !this.busy.has(task.id)
        && !this.stopping.has(task.id)
        && !task.videoJob?.trackingStopped
        && task.videoJob?.preparation?.version === 1
        && task.videoJob.preparation.phase === 'preparing'
        && (task.videoJob.batchQueueState === 'ready' || task.videoJob.batchQueueState === 'active')
        && this.chainDependencyReady(task)
        && this.tailReady(task)
        && (task.status === 'draft' || task.status === 'submitting')
      ));
      for (const candidate of candidates) {
        if (!this.claimGenerationSlot(candidate)) {
          this.markLocallyQueued(candidate);
          continue;
        }
        this.batchClaims.add(candidate.id);
        return candidate;
      }
      return undefined;
    };
    const worker = async () => {
      while (!this.disposed && !this.cancelledBatches.has(batchId)) {
        const candidate = claimNext();
        if (!candidate?.videoJob) return;
        try {
          this.patch(candidate, {
            status: 'submitting', error: undefined,
            videoJob: { ...candidate.videoJob, batchQueueState: 'active', stage: 'preparing', trackingStopped: false, message: '正在按批量顺序准备并提交' },
          });
          const live = this.liveTask(candidate.id);
          if (!live?.videoJob) continue;
          await this.prepareAndSubmit(live);
          const latest = this.liveTask(candidate.id);
          if (latest?.videoJob?.preparation?.phase === 'preparing'
            && (latest.status === 'draft' || latest.status === 'submitting')
            && !latest.videoJob.trackingStopped) return;
          if (latest?.videoJob && latest.videoJob.batchQueueState === 'active' && !latest.videoJob.trackingStopped) {
            this.patch(latest, { videoJob: { ...latest.videoJob, batchQueueState: 'done' } });
          }
        } finally {
          this.batchClaims.delete(candidate.id);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  private continuationBatchState(batchId: string, ignoreClaims = false) {
    const tasks = this.tasksForBatch(batchId);
    if (!tasks.length) throw new Error('原批次已不存在，无法继续。');
    const projectId = tasks[0].videoJob?.snapshot.projectId;
    const owner = this.options.getState().project;
    if (!projectId || owner.id !== projectId || tasks.some((task) => task.videoJob?.snapshot.projectId !== projectId
      || !owner.generationTasks.some((entry) => entry.id === task.id))) throw new Error('批次所属项目不唯一或项目已切换，未继续其他项目的任务。');
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('批次存在重复任务标识，未继续提交。');
    for (const task of tasks) {
      const issue = videoBatchContinuationPersistenceIssue(task, projectId);
      if (issue) throw new Error(issue);
    }
    const signature = canonicalText([projectId, tasks.map((task) => ({
      id: task.id, batchId: task.batchId, batchIndex: task.batchIndex, batchTotal: task.batchTotal,
      requestFingerprint: task.requestFingerprint, status: task.status, remoteTaskId: task.remoteTaskId,
      resultAssetId: task.resultAssetId, resultUrl: task.resultUrl,
      snapshot: task.videoJob?.snapshot, preparation: task.videoJob?.preparation,
      tailPreparation: task.videoJob?.tailPreparation, batchQueueState: task.videoJob?.batchQueueState,
      stage: task.videoJob?.stage, trackingStopped: task.videoJob?.trackingStopped,
      downloadError: task.videoJob?.downloadError, resultSelectionRequired: task.videoJob?.resultSelectionRequired,
      cancellationPending: task.videoJob?.cancellationPending,
      batchContinuation: ignoreClaims ? undefined : task.videoJob?.batchContinuation,
    })), owner.assets.filter((asset) => tasks.some((task) => task.resultAssetId === asset.id))
      .map((asset) => [asset.id, asset.relativePath, asset.checksum, asset.missing, asset.sourceVideoTaskId])]);
    return { tasks, project: owner, signature, chain: tasks.some((task) => task.videoJob?.snapshot.batchCompletionOrder) };
  }

  private continuationReason(task: VideoGenerationTask): VideoBatchContinuationPlan['items'][number]['reason'] | undefined {
    const job = task.videoJob;
    if (!job || job.legacyMetadataIncomplete || job.cancellationPending || job.resultSelectionRequired
      || task.status === 'unknown' || job.stage === 'submission-unknown' || task.resultUrl
      || completedFileResult(task) || runningHubRemoteSucceeded(task) || canRecoverComfyPreviewResult(task)) return undefined;
    if (job.preparation?.version === 1 && job.preparation.phase === 'preparing' && !task.remoteTaskId) {
      return job.batchQueueState === 'cancelled' || job.tailPreparation?.phase === 'cancelled' ? 'cancelled' : 'preparing';
    }
    // A missing ID after POST-started is not proof of a remote failure.
    return task.remoteTaskId && task.status === 'failed' && job.stage === 'failed' && !job.downloadError ? 'failed' : undefined;
  }

  private continuationFirstParent(task: VideoGenerationTask, projectId: string) {
    const definition = task.videoJob?.snapshot.previousTail;
    if (!definition) return undefined;
    if (!this.tailIdentityMatches(task)) throw new Error('原尾帧前驱身份或冻结请求指纹不一致，未改接其他段。');
    const parent = this.chainPredecessor(task, definition.predecessorTaskId);
    const video = parent && this.completedLocalAsset(parent, projectId);
    if (!parent?.videoJob || !video) throw new Error(`请先恢复第 ${definition.predecessorSegmentIndex} 段并保存成片；多视频结果须先选择用于衔接的成片。`);
    const tail = task.videoJob!.tailPreparation;
    const image = task.videoJob!.snapshot.images[definition.referenceIndex];
    const frozen = Boolean(image?.freezeState === 'frozen' && image.relativePath && image.checksum
      && tail?.sourceVideoAssetId === video.id && tail.sourceRelativePath === video.relativePath && tail.sourceChecksum === video.checksum
      && (!definition.requireAiSelection || tail.selection?.source === 'ai'));
    return { parent, video, definition, frozen };
  }

  private sameContinuationTask(left: VideoGenerationTask, right: VideoGenerationTask): boolean {
    return canonicalText([left.id, left.createdAt, left.batchId, left.batchItemKey, left.batchIndex, left.batchTotal, left.requestFingerprint,
      left.videoJob?.snapshot.projectId, left.videoJob?.snapshot.clientId, left.videoJob?.snapshot.connection,
      left.videoJob?.snapshot.draft, left.videoJob?.snapshot.continuedFrom]) === canonicalText([
      right.id, right.createdAt, right.batchId, right.batchItemKey, right.batchIndex, right.batchTotal, right.requestFingerprint,
      right.videoJob?.snapshot.projectId, right.videoJob?.snapshot.clientId, right.videoJob?.snapshot.connection,
      right.videoJob?.snapshot.draft, right.videoJob?.snapshot.continuedFrom]);
  }

  /** Claim recovery is independent of task status: a cancelled/failed source
   * keeps its tombstone but a newer journal can own its replacement slot. */
  private async restoreContinuationClaim(task: VideoGenerationTask) {
    const saved = await this.options.desktop?.getVideoTaskCheckpoint?.(task.id);
    const current = this.liveTask(task.id);
    if (this.disposed || !current?.videoJob || !saved?.videoJob?.batchContinuation) return;
    const issue = videoBatchContinuationPersistenceIssue(saved, current.videoJob.snapshot.projectId);
    if (issue || !this.sameContinuationTask(saved, current)) throw new Error(issue || '续跑认领断点与原任务身份不一致，未重复创建任务。');
    const incoming = saved.videoJob.batchContinuation;
    const existing = current.videoJob.batchContinuation;
    if (existing && incoming.revision === existing.revision && canonicalText(incoming) !== canonicalText(existing)) throw new Error('续跑认领记录存在冲突，未再次提交。');
    if (!existing || incoming.revision > existing.revision) this.patch(current, { videoJob: { ...current.videoJob, batchContinuation: incoming } });
  }

  private async followBatchContinuation(state: ReturnType<VideoGenerationEngine['continuationBatchState']>, result: VideoBatchResumeResult,
    visited: Set<string>): Promise<boolean> {
    const claimed = state.tasks.filter((task) => task.videoJob?.batchContinuation && !task.videoJob.batchContinuation.released);
    if (!claimed.length) return false;
    result.completedTaskIds = state.tasks.filter((task) => Boolean(this.completedLocalAsset(task, state.project.id))).map((task) => task.id);
    const completed = new Set(result.completedTaskIds);
    const children = new Map<string, VideoGenerationTask>();
    for (const task of claimed) {
      const claim = task.videoJob!.batchContinuation!;
      const child = state.project.generationTasks.find((entry) => entry.id === claim.taskId) as VideoGenerationTask | undefined;
      const source = child?.videoJob?.snapshot.continuedFrom;
      if (!child?.videoJob || child.batchId !== claim.batchId || child.videoJob.snapshot.projectId !== state.project.id
        || source?.version !== 1 || source.planId !== claim.planId || source.taskId !== task.id
        || source.batchId !== task.batchId || source.requestFingerprint !== task.requestFingerprint) {
        result.issues.push({ taskId: task.id, message: '此段已有续跑认领，续跑仍在准备或对应记录暂不可用；不会重复调用 AI 或创建视频。' });
      } else children.set(task.id, child);
    }
    const unclaimed = state.tasks.filter((task) => !completed.has(task.id) && !claimed.some((entry) => entry.id === task.id));
    if (unclaimed.length) result.issues.push({ taskId: unclaimed[0].id, message: '原批次的续跑认领尚未完整保存，请先恢复已认领的续跑记录；不会猜测缺失的后续任务。' });
    if (!result.issues.length) for (const batchId of new Set([...children.values()].map((task) => task.batchId!))) {
      try {
        const childResult = await this.resumeBatchInternal(batchId, visited);
        const childCompleted = new Set(childResult.completedTaskIds);
        for (const [originalId, child] of children) if (childCompleted.has(child.id)) completed.add(originalId);
        result.resumedTaskIds.push(...childResult.resumedTaskIds);
        result.issues.push(...childResult.issues);
        if (childResult.continuation && !result.continuation) result.continuation = childResult.continuation;
      } catch (error) { result.issues.push({ taskId: claimed[0].id, message: messageOf(error) }); }
    }
    result.completedTaskIds = [...completed];
    result.waitingTaskIds = state.tasks.filter((task) => !completed.has(task.id)).map((task) => task.id);
    return true;
  }

  resumeBatch(batchId: string): Promise<VideoBatchResumeResult> {
    const existing = this.batchResumes.get(batchId);
    if (existing) return existing;
    const operation = this.resumeBatchInternal(batchId).finally(() => { if (this.batchResumes.get(batchId) === operation) this.batchResumes.delete(batchId); });
    this.batchResumes.set(batchId, operation); return operation;
  }

  private async resumeBatchInternal(batchId: string, ancestors = new Set<string>()): Promise<VideoBatchResumeResult> {
    if (this.disposed) throw new Error('视频任务控制器已停止。');
    if (ancestors.has(batchId)) throw new Error('续跑来源形成循环，已停止恢复，未新建视频。');
    const visited = new Set(ancestors); visited.add(batchId);
    const initial = this.continuationBatchState(batchId);
    const result: VideoBatchResumeResult = { batchId, resumedTaskIds: [], completedTaskIds: [], waitingTaskIds: [], issues: [] };
    const issue = (taskId: string, message: string) => { if (!result.issues.some((entry) => entry.taskId === taskId && entry.message === message)) result.issues.push({ taskId, message }); };
    // A journal can contain a later POST boundary than project-state.json.
    // Restore it before deciding that any task is safe to submit for the first time.
    for (const task of initial.tasks) {
      try { await this.restoreContinuationClaim(task); }
      catch (error) { issue(task.id, messageOf(error)); }
      if (task.videoJob?.preparation?.phase !== 'preparing' || task.remoteTaskId) continue;
      try { await this.restoreCheckpoint(task); }
      catch (error) { issue(task.id, messageOf(error)); }
    }
    let state = this.continuationBatchState(batchId);
    if (await this.followBatchContinuation(state, result, visited)) return result;
    if (result.issues.length) {
      result.waitingTaskIds = state.tasks.filter((task) => !this.completedLocalAsset(task, state.project.id)).map((task) => task.id);
      return result;
    }
    for (const task of state.tasks) {
      if (this.disposed || this.options.getState().project.id !== initial.project.id) throw Object.assign(new Error('项目已切换，批次继续已取消。'), { name: 'AbortError' });
      if (this.completedLocalAsset(task, initial.project.id)) continue;
      if (this.checkpointErrors.has(task.id)) { issue(task.id, this.checkpointErrors.get(task.id)!); continue; }
      if (task.videoJob?.resultSelectionRequired) { issue(task.id, '原任务有多个成片，请先在任务卡选择用于衔接的视频。'); continue; }
      const reason = this.continuationReason(task);
      // Opening this summary can recover existing remote work, but must not
      // authorize a fresh POST or a paid AI preparation before confirmation.
      if (reason === 'cancelled' || reason === 'failed' || reason === 'preparing') continue;
      try {
        if (runningHubRemoteSucceeded(task) || canRecoverComfyPreviewResult(task)) await this.recoverResult(task.id);
        else if (task.resultUrl || completedFileResult(task)) await this.retryDownload(task.id);
        else if (task.remoteTaskId || task.status === 'unknown' || task.videoJob?.preparation?.phase === 'post-started') await this.resume(task.id);
        else { issue(task.id, '缺少可核验的提交快照，请先恢复原任务，不能直接重新生成。'); continue; }
        result.resumedTaskIds.push(task.id);
      } catch (error) { issue(task.id, messageOf(error)); }
    }
    state = this.continuationBatchState(batchId);
    result.completedTaskIds = state.tasks.filter((task) => Boolean(this.completedLocalAsset(task, state.project.id))).map((task) => task.id);
    const completed = new Set(result.completedTaskIds);
    const remaining = state.tasks.filter((task) => !completed.has(task.id));
    result.waitingTaskIds = remaining.map((task) => task.id);
    if (!remaining.some((task) => Boolean(this.continuationReason(task)))) return result;
    let candidates = remaining.filter((task) => Boolean(this.continuationReason(task)) && !this.checkpointErrors.has(task.id));
    if (state.chain) {
      if (state.tasks.some((task, index) => task.batchIndex !== index + 1 || task.batchTotal !== state.tasks.length)) {
        issue(remaining[0].id, '原链任务不完整或段落序号冲突，不能猜测续跑前驱。'); return result;
      }
      const firstIndex = state.tasks.findIndex((task) => !completed.has(task.id));
      const suffix = state.tasks.slice(firstIndex);
      if (suffix.some((task) => completed.has(task.id))) { issue(suffix[0].id, '未完成段之间夹有已成功段，不能跳过成功段后盲目重接新链；已成功视频不会重做。'); return result; }
      if (suffix.some((task) => !candidates.some((candidate) => candidate.id === task.id))) {
        issue(suffix[0].id, '原链仍有结果待确认、正在运行或待保存的任务，已恢复原任务查询；明确结果前不建立新收费任务。'); return result;
      }
      candidates = suffix;
    }
    if (!candidates.length) return result;
    let parent: ReturnType<VideoGenerationEngine['continuationFirstParent']>;
    try {
      if (state.chain) {
        candidates.forEach((task, index) => {
          const definition = task.videoJob?.snapshot.previousTail;
          if (definition && (!this.tailIdentityMatches(task) || index > 0 && definition.predecessorTaskId !== candidates[index - 1].id)) throw new Error('原后缀的前后段关系不完整，未改接其他任务。');
        });
        parent = this.continuationFirstParent(candidates[0], state.project.id);
      }
    } catch (error) { issue(candidates[0].id, messageOf(error)); return result; }
    const plan: VideoBatchContinuationPlan = {
      id: id('video_continue'), batchId, projectId: state.project.id, label: `${state.tasks[0].batchLabel || '批量视频'} · 继续`,
      items: candidates.map((task) => ({ taskId: task.id, name: task.videoJob!.snapshot.draft.name || `第 ${task.segmentIndex || task.batchIndex} 段`,
        segmentIndex: task.segmentIndex, reason: this.continuationReason(task)!, willRegenerate: this.continuationReason(task) === 'failed' })),
      completedTaskIds: [...result.completedTaskIds], requiresAiTail: Boolean(parent && !parent.frozen && parent.definition.selectionMode === 'ai-assisted'), predecessorTaskId: parent?.parent.id,
    };
    this.continuationPlans.set(plan.id, { publicPlan: structuredClone(plan), signature: state.signature, taskIds: candidates.map((task) => task.id), chain: state.chain });
    result.continuation = plan; return result;
  }

  confirmContinueBatch(planId: string, signal?: AbortSignal): Promise<VideoBatchStartResult> {
    const existing = this.continuationStarts.get(planId);
    if (existing) return existing;
    const operation = this.confirmContinueBatchInternal(planId, signal).catch((error) => {
      if (this.continuationStarts.get(planId) === operation) this.continuationStarts.delete(planId);
      throw error;
    });
    this.continuationStarts.set(planId, operation); return operation;
  }

  private async confirmContinueBatchInternal(planId: string, signal?: AbortSignal): Promise<VideoBatchStartResult> {
    const plan = this.continuationPlans.get(planId);
    if (!plan) throw new Error('续跑确认已失效，请重新点击继续批次。');
    const controller = new AbortController(); this.continuationControllers.set(planId, controller);
    const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let creation: BatchContinuationCreation | undefined;
    const check = () => {
      if (this.disposed || controller.signal.aborted) throw Object.assign(new Error('已取消本次批次续跑，未继续提交。'), { name: 'AbortError' });
      const state = this.continuationBatchState(plan.publicPlan.batchId);
      if (state.signature !== plan.signature) throw new Error('原批次、成片或冻结快照已经变化，请重新点击继续并核对。');
      return state;
    };
    try {
      let state = check();
      let tasks = plan.taskIds.map((taskId) => state.tasks.find((task) => task.id === taskId)!);
      const firstParent = plan.chain ? this.continuationFirstParent(tasks[0], state.project.id) : undefined;
      if (!this.options.desktop?.saveVideoTaskCheckpoint || !this.options.persistState) throw new Error('批次续跑需要持久任务认领记录，当前环境不能安全创建新的收费任务。');
      if (tasks.some((task) => !task?.requestFingerprint || !task.batchItemKey
        || task.videoJob?.batchContinuation && !task.videoJob.batchContinuation.released)) throw new Error('原任务已被另一续跑认领，请返回继续现有续跑批次。');
      creation = { batchId: id('video_batch'), planId,
        sources: new Map(tasks.map((task) => [task.batchItemKey!, { task, targetTaskId: id('video_task') }])) };
      const claims = new Map(tasks.map((task) => [task.id, {
        version: 1 as const, planId, batchId: creation!.batchId,
        taskId: creation!.sources.get(task.batchItemKey!)!.targetTaskId,
        revision: (task.videoJob?.batchContinuation?.revision || 0) + 1,
      }]));
      // Synchronous, all-or-nothing ownership comes BEFORE the first await,
      // including before AI tail selection. Different confirmation tokens see
      // this immediately; journals make it survive an older main-state save.
      this.options.setState((current) => applyOwnedProjectUpdate(current, state.project.id, (owner) => ({ ...owner,
        generationTasks: owner.generationTasks.map((raw) => {
          const claim = claims.get(raw.id);
          if (!claim) return raw;
          const task = raw as VideoGenerationTask;
          return { ...task, videoJob: { ...task.videoJob!, batchContinuation: claim }, updatedAt: Date.now() };
        }),
      })));
      plan.signature = this.continuationBatchState(plan.publicPlan.batchId).signature;
      for (const original of tasks) {
        check();
        const claimed = this.liveTask(original.id)!;
        if (canonicalText(claimed.videoJob?.batchContinuation) !== canonicalText(claims.get(original.id))) throw new Error('续跑认领已变化，未创建新任务。');
        const saved = await this.options.desktop.saveVideoTaskCheckpoint(claimed);
        if (!saved.persisted) throw new Error('续跑认领记录未安全保存，尚未调用 AI 或生成视频。');
      }
      await this.options.persistState(); check();
      // Fail before AI preparation or retiring the original queue. A missing
      // credential must leave the old batch available for another recovery.
      for (const original of tasks) {
        if (original.videoJob!.snapshot.connection.api?.provider !== 'runninghub') continue;
        const apiKey = await this.recoverCredential(original, /HTTP (?:401|403)|HEADER_API_KEY_NOT_FOUND/u.test(original.error || ''));
        check();
        this.requireRunningHubCredential(original.videoJob!.snapshot.connection.api, apiKey);
      }
      if (firstParent && !firstParent.frozen && !plan.preparedFirstFrame) {
        const aiAssisted = firstParent.definition.selectionMode === 'ai-assisted';
        const source = { assetId: firstParent.video.id, relativePath: firstParent.video.relativePath!, expectedChecksum: firstParent.video.checksum };
        let frame: WorkbenchExtractedFrame;
        if (aiAssisted) {
          // Historical chains retain their frozen AI contract. New local
          // chains must not acquire a vision dependency just by continuing.
          if (!this.options.selectTailFrame || !this.options.desktop?.extractWorkbenchFrames) throw new Error('AI 选帧服务暂不可用，未生成新的后段视频。');
          const selection = await this.options.selectTailFrame({
            desktop: this.options.desktop, jobId: id('video_continue_tail'), projectId: state.project.id,
            source,
            previousPrompt: firstParent.parent.videoJob!.snapshot.draft.prompt, nextPrompt: tasks[0].videoJob!.snapshot.draft.prompt,
            requireAiSelection: true, signal: controller.signal, onBeforeAI: async () => { check(); },
          });
          state = check();
          if (selection.selection.source !== 'ai' || !selection.frame.relativePath || !selection.frame.checksum || selection.frame.missing
            || !selection.candidates.some((candidate) => candidate.id === selection.selection.selectedId && candidate.frame.relativePath === selection.frame.relativePath && candidate.frame.checksum === selection.frame.checksum)) throw new Error('AI 未返回可核验的已保存衔接帧，未使用原尾帧替代。');
          frame = selection.frame;
        } else {
          if (!this.options.desktop?.extractWorkbenchFrames || !this.options.desktop.videoWorkbenchStatus) throw new Error('本地视频抽帧工具不可用，未生成新的后段视频。');
          const status = await this.options.desktop.videoWorkbenchStatus();
          state = check();
          if (!status.available) throw new Error(status.message || '本地视频抽帧工具不可用。');
          const jobId = id('video_continue_tail');
          const cancelExtraction = () => { void this.options.desktop?.cancelWorkbenchJob?.(jobId).catch(() => {}); };
          controller.signal.addEventListener('abort', cancelExtraction, { once: true });
          try {
            check();
            const extracted = await this.options.desktop.extractWorkbenchFrames({
              jobId, projectId: state.project.id, source, mode: 'last', fileName: `${tasks[0].videoJob!.snapshot.draft.name}-续跑上段尾帧.png`,
            });
            state = check();
            if (extracted.frames.length !== 1) throw new Error(`尾帧抽取返回 ${extracted.frames.length} 张图片，无法确定唯一尾帧。`);
            frame = extracted.frames[0];
            if (frame.role !== 'last-frame' || frame.mediaType !== 'image' || !frame.relativePath || !frame.checksum || frame.missing
              || !Number.isFinite(frame.timeSec) || frame.timeSec < 0) throw new Error('尾帧抽取没有返回可校验的已保存真实最后一帧。');
          } finally {
            controller.signal.removeEventListener('abort', cancelExtraction);
          }
        }
        const timestamp = Date.now();
        const asset: ReferenceAsset = { ...frame, id: id('asset_continue_tail'), name: `${tasks[0].videoJob!.snapshot.draft.name} · ${aiAssisted ? '续跑 AI 衔接帧' : '续跑上段尾帧'}`,
          type: aiAssisted ? 'reference' : 'last-frame', role: aiAssisted ? 'composition' : 'last-frame', referenceRole: firstParent.definition.referenceRole, mediaType: 'image', source: 'derived',
          sourceVideoAssetId: firstParent.video.id, sourceVideoChecksum: firstParent.video.checksum,
          sourceTimeSec: frame.timeSec, sourceFrameIndex: frame.frameIndex,
          tags: ['视频抽帧', aiAssisted ? 'AI 辅助选帧' : '自动衔接尾帧', '批次续跑'], createdAt: timestamp, updatedAt: timestamp };
        this.options.setState((current) => applyOwnedProjectUpdate(current, state.project.id, (owner) => ({ ...owner, assets: [asset, ...owner.assets] })));
        plan.preparedFirstFrame = asset;
        await this.options.persistState?.(); check();
      }
      state = check(); tasks = plan.taskIds.map((taskId) => state.tasks.find((task) => task.id === taskId)!);
      const items: VideoBatchItemInput[] = tasks.map((task, index) => {
        const snapshot = task.videoJob!.snapshot;
        const draft = { ...structuredClone(snapshot.draft), reuseTaskId: task.id };
        const definition = snapshot.previousTail;
        if (index === 0 && definition && plan.preparedFirstFrame) {
          draft.references[definition.referenceIndex] = { ...draft.references[definition.referenceIndex], assetId: plan.preparedFirstFrame.id, role: definition.referenceRole };
          draft.referenceSlotRoles = videoReferenceSelection(draft.references, draft.referenceSlotRoles).referenceSlotRoles;
        }
        const previousTail = index > 0 && definition ? {
          predecessorItemKey: tasks[index - 1].batchItemKey!, selectionMode: definition.selectionMode,
          requireAiSelection: definition.requireAiSelection,
          placement: { mode: 'replace' as const, index: definition.referenceIndex, role: definition.referenceRole,
            ...(draft.references[definition.referenceIndex].slotIndex !== undefined ? { slotIndex: draft.references[definition.referenceIndex].slotIndex } : {}),
            replacedAssetId: draft.references[definition.referenceIndex].assetId },
        } : undefined;
        return { itemKey: task.batchItemKey || `${task.storyboardId}:${draft.source?.language || 'zh'}`, draft, ...(previousTail ? { previousTail } : {}) };
      });
      // Explicit confirmation retires only original pre-POST shells. Submitted
      // or successful tasks and their immutable cancellation journals stay put.
      if (tasks.some((task) => this.continuationReason(task) === 'preparing')) {
        await this.cancelBatch(plan.publicPlan.batchId, planId);
        plan.signature = this.continuationBatchState(plan.publicPlan.batchId).signature;
      }
      check();
      return await this.startBatchInternal({ projectId: plan.publicPlan.projectId, label: plan.publicPlan.label, items,
        concurrency: tasks[0].batchConcurrency || 1, force: true, ...(plan.chain ? { completionOrder: true } : {}) }, controller.signal, () => { check(); }, creation);
    } catch (error) {
      // If no child shell was inserted, no child POST/journal could exist. An
      // ordinary failed or cancelled preparation can release its reservation.
      // Once any child exists, retain lineage regardless of its terminal state;
      // future Continue follows that exact child, never the original slot again.
      if (creation && ![...creation.sources.values()].some(({ targetTaskId }) => Boolean(this.liveTask(targetTaskId)))) {
        let unchangedSource: string | undefined;
        try {
          if (this.continuationBatchState(plan.publicPlan.batchId).signature === plan.signature) {
            unchangedSource = this.continuationBatchState(plan.publicPlan.batchId, true).signature;
          }
        } catch { /* switched/deleted projects invalidate the old confirmation */ }
        for (const { task: original } of creation.sources.values()) {
          const current = this.liveTask(original.id);
          const claim = current?.videoJob?.batchContinuation;
          if (!current?.videoJob || !claim || claim.planId !== planId || claim.released) continue;
          const released: VideoBatchContinuationClaim = { ...claim, revision: claim.revision + 1, released: true };
          try {
            const next = { ...current, videoJob: { ...current.videoJob, batchContinuation: released }, updatedAt: Date.now() };
            const saved = await this.options.desktop?.saveVideoTaskCheckpoint?.(next);
            if (!saved?.persisted) throw new Error('续跑准备释放记录未保存');
            this.patch(current, { videoJob: { ...current.videoJob, batchContinuation: released } });
          } catch { /* retain the claim: uncertain ownership is not permission to bill again */ }
        }
        try { await this.options.persistState?.(); } catch { /* independent claim journals remain authoritative */ }
        // A user may explicitly retry the same confirmation after cancelling
        // AI preparation. Only our own claim release can refresh this token;
        // edits to inputs, parent pixels or project ownership still invalidate it.
        try {
          if (unchangedSource && this.continuationBatchState(plan.publicPlan.batchId, true).signature === unchangedSource) {
            plan.signature = this.continuationBatchState(plan.publicPlan.batchId).signature;
          }
        } catch { /* leave the original token stale */ }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.continuationControllers.get(planId) === controller) this.continuationControllers.delete(planId);
    }
  }

  async cancelBatch(batchId: string, continuingPlanId?: string): Promise<VideoBatchCancelResult> {
    const normalizedId = String(batchId || '').trim();
    if (!normalizedId) throw new Error('批量任务标识为空。');
    for (const [planId, controller] of this.continuationControllers) if (planId !== continuingPlanId
      && this.continuationPlans.get(planId)?.publicPlan.batchId === normalizedId) controller.abort();
    this.cancelledBatches.add(normalizedId);
    const cancelledTaskIds: string[] = [];
    const retainedTaskIds: string[] = [];
    for (const task of this.tasksForBatch(normalizedId)) {
      const beforePost = task.videoJob?.preparation?.version === 1
        && task.videoJob.preparation.phase === 'preparing'
        && task.status !== 'unknown'
        && !task.remoteTaskId;
      if (!beforePost) {
        retainedTaskIds.push(task.id);
        continue;
      }
      await this.cancel(task.id);
      const stopped = this.liveTask(task.id);
      const stillBeforePost = stopped?.videoJob?.preparation?.version === 1
        && stopped.videoJob.preparation.phase === 'preparing'
        && stopped.status !== 'unknown'
        && !stopped.remoteTaskId
        && !completedFileResult(stopped);
      // cancel() is asynchronous. The task may have crossed the durable POST
      // boundary after tasksForBatch() produced its snapshot, so classify from
      // the latest task and never overwrite a possibly-billable submission.
      if (!stopped?.videoJob || !stillBeforePost) {
        retainedTaskIds.push(task.id);
        continue;
      }
      cancelledTaskIds.push(task.id);
      const message = '已停止此批次中尚未提交的视频；未影响已经提交到服务器的任务。';
      this.patch(stopped, {
        status: 'failed', error: message,
        videoJob: { ...stopped.videoJob, batchQueueState: 'cancelled', stage: 'stopped', trackingStopped: true, completedAt: Date.now(), message },
      });
      const persisted = this.liveTask(task.id);
      if (persisted) {
        const requestFingerprint = videoTaskRequestFingerprint(persisted);
        if (requestFingerprint) {
          const ownerKey = requestFingerprintOwnerKey(persisted.videoJob!.snapshot.projectId, requestFingerprint);
          if (this.requestFingerprintOwners.get(ownerKey) === persisted.id) this.requestFingerprintOwners.delete(ownerKey);
        }
        void this.options.desktop?.saveVideoTaskCheckpoint?.(persisted).catch(() => {});
      }
    }
    return { batchId: normalizedId, cancelledTaskIds, retainedTaskIds };
  }

  /** Adopt pending pre-upgrade records once; bind the then-current interface, never re-POST. */
  reconcile() {
    if (this.disposed) return;
    const projects = allProjects(this.options.getState());
    const liveIds = new Set(projects.flatMap((project) => project.generationTasks.filter((task) => task.kind === 'video' || task.kind == null).map((task) => task.id)));
    const retainedIds = new Set([...liveIds, ...projects.flatMap((project) => project.assets.flatMap((asset) => asset.videoSourceTask?.videoJob?.snapshot.projectId === project.id ? [asset.videoSourceTask.id] : []))]);
    const trackedIds = new Set([...this.timers.keys(), ...this.acknowledgementTimers.keys(), ...this.watches.keys(), ...this.busy, ...this.downloading, ...this.tailPreparations, ...this.requestIds.keys(), ...this.runtimes.keys(), ...this.credentialIdsByTask.keys(), ...this.remoteCancellations.keys()]);
    for (const taskId of trackedIds) if (!liveIds.has(taskId)) {
      this.stopping.add(taskId);
      this.pollLeases.delete(taskId);
      this.tailSelectionControllers.get(taskId)?.abort();
      const extractionJobId = this.tailExtractionJobs.get(taskId);
      if (extractionJobId) void this.options.desktop?.cancelWorkbenchJob?.(extractionJobId).catch(() => {});
      void this.stopWatch(taskId).catch(() => {});
      if (!this.remoteCancellations.has(taskId)) {
        for (const requestId of this.requestIds.get(taskId) || []) void this.options.desktop?.cancelVideoRequest?.(requestId).catch(() => {});
      }
      // Keep request/credential bookkeeping alive while a directed remote
      // cancellation is still running.  Removing it here can make the
      // cancellation request lose its scoped key, or let a late callback
      // allocate a second request set after the task was deleted locally.
      if (!this.remoteCancellations.has(taskId)) {
        this.requestIds.delete(taskId); this.busy.delete(taskId); this.downloading.delete(taskId);
        this.runtimes.delete(taskId); this.retryCounts.delete(taskId); this.acknowledgementRetries.delete(taskId);
        this.comfyMissingTasks.reset(taskId);
        if (!retainedIds.has(taskId)) {
          for (const scopedId of this.credentialIdsByTask.get(taskId) || []) {
            this.credentials.delete(scopedId);
            void this.options.desktop?.setVideoTaskCredential?.({ taskId: scopedId, apiKey: '' }).catch(() => {});
          }
          this.credentialIdsByTask.delete(taskId);
          void this.options.desktop?.deleteVideoTaskCheckpoint?.(taskId).catch(() => {});
        }
        this.options.onRemoveRuntime?.(taskId);
      }
    }
    for (const [taskId, lease] of this.watches) {
      if (!this.currentWatchTask(taskId, lease)) void this.releaseWatch(taskId, lease).catch(() => {});
    }
    for (const [fingerprint, owner] of this.requestFingerprintOwners) {
      if (owner.startsWith('initializing:')) continue;
      const task = this.find(owner);
      if (!task || (!batchTaskStillBlocksDuplicate(task) && !batchTaskSucceeded(task))) {
        this.requestFingerprintOwners.delete(fingerprint);
      }
    }
    for (const project of projects) for (const item of project.generationTasks) {
      if (item.kind !== 'video' && item.kind != null) continue;
      const task = item as VideoGenerationTask;
      // startBatchInternal has already inserted the shells into state, but it
      // has not necessarily written their first independent journal yet.  A
      // React state effect may call reconcile in that interval.  Do not treat
      // those in-process shells as restarted records (and do not invoke
      // restoreCheckpoint, which would stop them for a missing journal).
      if (this.isInitializingBatch(task)) continue;
      if (task.videoJob?.cancellationPending && !this.remoteCancellations.has(task.id)) {
        this.restoreOrphanCancellation(task);
        continue;
      }
      const requestFingerprint = videoTaskRequestFingerprint(task);
      if (requestFingerprint && (batchTaskStillBlocksDuplicate(task) || batchTaskSucceeded(task))) this.requestFingerprintOwners.set(
        requestFingerprintOwnerKey(project.id, requestFingerprint),
        task.id,
      );
      if (!task.videoJob && task.remoteTaskId && ['submitted', 'running', 'unknown'].includes(task.status)) {
        const settings = this.options.getState().settings.videoTaskApi;
        const job: VideoGenerationJob = {
          stage: task.status === 'running' ? 'running' : 'queued', submittedAt: task.createdAt, legacyMetadataIncomplete: true,
          snapshot: { projectId: project.id, draft: { name: `历史任务 ${task.remoteTaskId}`, prompt: typeof task.requestBody.prompt === 'string' ? task.requestBody.prompt : '', backend: 'api', references: [], parameters: {}, source: { storyboardId: task.storyboardId, segmentId: task.segmentId, sequencePlanId: task.sequencePlanId } }, connection: { backend: 'api', api: withoutApiKey(settings) }, images: [], clientId: id('video_client') },
        };
        void this.rememberKey({ ...task, videoJob: job }, settings.apiKey).catch(() => { /* a missing scoped key stops with an auth error, never falls back to an unscoped key */ });
        this.options.setState((current) => applyOwnedProjectUpdate(current, project.id, (owner) => ({ ...owner, generationTasks: owner.generationTasks.map((record) => record.id === task.id ? { ...record, videoJob: job } : record) })));
        continue;
      }
      if (this.busy.has(task.id) || this.stopping.has(task.id)) continue;
      if ((task.videoJob?.resultAssetIds?.length || 0) > 1 && !this.resultSelectionsRestored.has(task.id)
        && !this.downloading.has(task.id) && !task.videoJob?.trackingStopped) {
        void this.restoreResultSelection(task);
        continue;
      }
      if (task.resultAssetId || task.status === 'succeeded' || task.remoteTaskId || completedFileResult(task)
        || task.videoJob?.batchQueueState === 'cancelled' || task.videoJob?.batchQueueState === 'done' && task.status === 'failed') this.restoredCheckpoints.add(task.id);
      if (task.videoJob?.preparation?.version === 1 && !this.restoredCheckpoints.has(task.id)) {
        if (!this.restoringCheckpoints.has(task.id)) void this.restoreCheckpoint(task);
        continue;
      }
      if (!task.batchId && task.videoJob?.preparation?.phase === 'preparing'
        && ['preparing', 'queued'].includes(task.videoJob.stage)
        && (task.status === 'draft' || task.status === 'submitting')
        && !task.videoJob.trackingStopped && !task.remoteTaskId) {
        void this.prepareAndSubmit(task);
        continue;
      }
      if (pending(task)) { void this.watch(task); if (!this.timers.has(task.id)) this.schedule(task.id, 500); }
      if (task.videoJob?.snapshot.connection.backend === 'comfyui' && task.videoJob.stage === 'submission-unknown' && !task.remoteTaskId && !task.videoJob.trackingStopped && !this.acknowledgementChecks.has(task.id) && !this.acknowledgementTimers.has(task.id)) void this.recoverComfyAcknowledgement(task);
      if (task.videoJob && task.status === 'succeeded' && task.resultUrl && !task.resultAssetId && !task.videoJob.resultAssetIds?.length && !task.videoJob.downloadError && !task.videoJob.trackingStopped && !this.downloading.has(task.id)) void this.download(task);
    }
    const batchIds = new Set(projects.flatMap((project) => project.generationTasks.flatMap((item) => (
      (item.kind === 'video' || item.kind == null) && item.batchId ? [item.batchId] : []
    ))));
    for (const batchId of batchIds) {
      if (this.initializingBatches.has(batchId)) continue;
      const tasks = this.tasksForBatch(batchId);
      const gated = tasks.filter((task) => task.videoJob?.preparation?.phase === 'preparing'
        && task.videoJob.batchQueueState !== 'cancelled' && task.videoJob.batchQueueState !== 'done');
      for (const task of gated) {
        if (task.videoJob?.snapshot.previousTail && task.videoJob.tailPreparation?.phase !== 'ready' && task.videoJob.tailPreparation?.phase !== 'cancelled') void this.prepareTail(task);
      }
      if (gated.some((task) => (task.videoJob?.batchQueueState === 'ready' || task.videoJob?.batchQueueState === 'active')
        && !task.videoJob.trackingStopped && (task.status === 'draft' || task.status === 'submitting'))) this.scheduleBatch(batchId);
    }
  }

  private async restoreCheckpoint(task: VideoGenerationTask) {
    // A batch can be visible in React state before its first journal entry is
    // durable.  That is an in-process initialization window, not a restart;
    // leave the shells untouched and let startBatchInternal finish the ready
    // checkpoints.  The guard is intentionally scoped to the engine's own
    // initializingBatches set, so a newly constructed engine still performs
    // the strict missing-journal stop below.
    if (this.isInitializingBatch(task)) return;
    this.restoringCheckpoints.add(task.id);
    let skippedInitializingBatch = false;
    try {
      if (this.isInitializingBatch(task)) {
        skippedInitializingBatch = true;
        return;
      }
      const saved = await this.options.desktop?.getVideoTaskCheckpoint?.(task.id);
      const current = this.liveTask(task.id);
      if (this.disposed || !current?.videoJob) return;
      if (this.isInitializingBatch(current)) {
        skippedInitializingBatch = true;
        return;
      }
      if (!saved && current.videoJob.preparation?.phase === 'preparing') {
        const uncertainChain = Boolean(current.videoJob.snapshot.batchCompletionOrder || current.videoJob.snapshot.previousTail || current.videoJob.snapshot.batchPredecessorTaskId);
        const message = this.options.desktop?.getVideoTaskCheckpoint
          ? uncertainChain ? '缺少可信的链式准备记录，无法确认原任务是否已经提交；已暂停整条链并保留防重复提交保护，请先核对原任务。'
            : '缺少可信的本地准备记录，无法确认此任务尚未提交，已暂停自动恢复并保留生成名额；请先核对原任务，不能直接重复生成。'
          : '当前开发环境没有持久提交记录，不能保证重启后安全恢复准备；已暂停自动恢复并保留生成名额，请先核对原任务。';
        this.checkpointErrors.set(task.id, message);
        if (current.batchId) {
          this.patch(current, {
            status: 'unknown', error: message,
            videoJob: {
              ...current.videoJob,
              batchQueueState: 'active',
              stage: 'submission-unknown', trackingStopped: true, message,
            },
          });
        } else this.patch(current, { status: 'unknown' }, { stage: 'submission-unknown', trackingStopped: true, message });
        return;
      }
      let restored = current;
      const rank = (phase: string | undefined) => phase === 'acknowledged' ? 2 : phase === 'post-started' ? 1 : 0;
      const prepared = (job: VideoGenerationJob) => job.snapshot.images.filter((image) => image.freezeState === 'frozen').length + (job.preparation?.uploadedImages.filter(Boolean).length || 0);
      const matching = saved?.videoJob && saved.id === current.id && saved.createdAt === current.createdAt && saved.videoJob.snapshot.projectId === current.videoJob.snapshot.projectId
        && saved.videoJob.snapshot.clientId === current.videoJob.snapshot.clientId
        && JSON.stringify(canonical(saved.videoJob.snapshot.connection)) === JSON.stringify(canonical(current.videoJob.snapshot.connection))
        && JSON.stringify(canonical(saved.videoJob.snapshot.draft)) === JSON.stringify(canonical(current.videoJob.snapshot.draft))
        && canonicalText(saved.videoJob.snapshot.previousTail) === canonicalText(current.videoJob.snapshot.previousTail)
        && saved.videoJob.snapshot.batchCompletionOrder === current.videoJob.snapshot.batchCompletionOrder
        && saved.videoJob.snapshot.batchPredecessorTaskId === current.videoJob.snapshot.batchPredecessorTaskId
        && canonicalText(saved.videoJob.snapshot.continuedFrom) === canonicalText(current.videoJob.snapshot.continuedFrom)
        && (!current.videoJob.snapshot.batchCompletionOrder || canonicalText([saved.batchId, saved.batchItemKey, saved.batchIndex, saved.batchTotal, saved.batchConcurrency, saved.requestFingerprint])
          === canonicalText([current.batchId, current.batchItemKey, current.batchIndex, current.batchTotal, current.batchConcurrency, current.requestFingerprint]));
      if (saved && !matching && current.videoJob.preparation?.phase === 'preparing') {
        const message = '本地准备记录与当前任务不一致，已暂停自动提交；不会改用另一接口、提示词或参数。';
        this.checkpointErrors.set(task.id, message);
        if (current.batchId) {
          this.patch(current, {
            status: 'unknown', error: message,
            videoJob: {
              ...current.videoJob,
              batchQueueState: 'active',
              stage: 'submission-unknown', trackingStopped: true, message,
            },
          });
        } else this.patch(current, { status: 'unknown' }, { stage: 'submission-unknown', trackingStopped: true, message });
        return;
      }
      if (saved?.videoJob && matching
        && !current.resultAssetId && current.status !== 'succeeded'
        && current.videoJob.tailPreparation?.phase !== 'cancelled' && current.videoJob.batchQueueState !== 'cancelled'
        && (saved.videoJob.tailPreparation?.phase === 'cancelled' || saved.videoJob.batchQueueState === 'cancelled'
          || rank(saved.videoJob.preparation?.phase) > rank(current.videoJob.preparation?.phase)
          || rank(saved.videoJob.preparation?.phase) === rank(current.videoJob.preparation?.phase)
            && (saved.videoJob.tailPreparation?.revision || 0) > (current.videoJob.tailPreparation?.revision || 0)
          || rank(saved.videoJob.preparation?.phase) === rank(current.videoJob.preparation?.phase)
            && (saved.videoJob.tailPreparation?.revision || 0) === (current.videoJob.tailPreparation?.revision || 0)
            && (saved.updatedAt >= current.updatedAt || prepared(saved.videoJob) > prepared(current.videoJob)))) {
        restored = { ...saved, videoJob: { ...saved.videoJob, ...(current.videoJob.trackingStopped ? { stage: 'stopped', trackingStopped: true, message: current.videoJob.message } : {}) } };
      }
      if (restored.videoJob?.tailPreparation?.phase === 'cancelled') restored = { ...restored, status: 'failed', videoJob: { ...restored.videoJob, batchQueueState: 'cancelled', stage: 'stopped', trackingStopped: true } };
      if (restored.status === 'submitting' && restored.videoJob?.preparation?.phase !== 'preparing') {
        restored = { ...restored, status: restored.remoteTaskId ? 'submitted' : 'unknown', videoJob: { ...restored.videoJob!, stage: restored.videoJob?.trackingStopped ? 'stopped' : restored.remoteTaskId ? 'reconnecting' : 'submission-unknown', message: restored.remoteTaskId ? '继续查询原视频任务' : '已记录提交边界，正在核实原任务；不会再次提交。' } };
      }
      if (restored.batchId && restored.videoJob?.preparation?.phase === 'preparing'
        && restored.videoJob.batchQueueState === 'waiting') {
        const message = '批量任务尚未写入可提交断点，已停止自动恢复；不会擅自提交或重复扣费。';
        restored = {
          ...restored, status: 'failed', error: message,
          videoJob: {
            ...restored.videoJob,
            batchQueueState: 'cancelled',
            stage: 'stopped', trackingStopped: true, completedAt: Date.now(), message,
          },
        };
        this.checkpointErrors.set(task.id, message);
      }
      // Task-list deletion/undo belongs to current project state, never to an
      // older execution journal restored for continuation or result recovery.
      this.patch(current, { ...restored, historyOnly: current.historyOnly });
      // A newer ready journal can legitimately outlive an older main project
      // snapshot. Restore its exact frame reference into the owning library,
      // then flush that library before allowing uploads/POSTs on recovery.
      const restoredJob = restored.videoJob;
      const tail = restoredJob?.tailPreparation;
      const dependency = restoredJob?.snapshot.previousTail;
      if (dependency && tail?.phase === 'ready') {
        const image = restoredJob!.snapshot.images[dependency.referenceIndex];
        if (!image || image.assetId !== dependency.reservedFrameAssetId || !image.relativePath || !image.checksum
          || !this.tailIdentityMatches(restored)) throw new Error('恢复的尾帧或上一段身份不完整');
        await this.imageData(restored, this.imageAsset(image));
        this.options.setState((state) => applyOwnedProjectUpdate(state, restoredJob!.snapshot.projectId, (project) => {
          if (project.assets.some((asset) => asset.id === dependency.reservedFrameAssetId)) return project;
          const earlierFrame = tail.selection?.source === 'ai' && (tail.selection.offsetFromEndSec || 0) > 0;
          const asset: ReferenceAsset = { id: dependency.reservedFrameAssetId, name: `${restoredJob!.snapshot.draft.name} · ${earlierFrame ? '上段 AI 衔接帧' : '上段尾帧'}`,
            type: earlierFrame ? 'reference' : 'last-frame', role: earlierFrame ? 'composition' : 'last-frame', referenceRole: earlierFrame ? 'composition' : 'last-frame', mediaType: 'image', mimeType: 'image/png', source: 'derived',
            fileName: image.fileName, relativePath: image.relativePath, checksum: image.checksum, url: image.url,
            sourceVideoAssetId: tail.sourceVideoAssetId, sourceVideoChecksum: tail.sourceChecksum,
            sourceTimeSec: tail.selection?.selectedTimeSec, sourceFrameIndex: tail.selection?.frame?.frameIndex,
            tags: ['视频抽帧', dependency.selectionMode === 'ai-assisted' ? 'AI 辅助选帧' : '自动衔接尾帧'], createdAt: image.frozenAt || Date.now(), updatedAt: Date.now() };
          return { ...project, assets: [asset, ...project.assets] };
        }));
        await this.options.persistState?.();
      }
      if (restored.videoJob?.batchQueueState !== 'cancelled') this.checkpointErrors.delete(task.id);
    } catch (error) {
      const message = `准备恢复记录暂不可读：${messageOf(error)}；已暂停，未再次提交。`;
      this.checkpointErrors.set(task.id, message);
      this.patch(task, { status: 'unknown' }, { stage: 'submission-unknown', trackingStopped: true, message });
    } finally {
      this.restoringCheckpoints.delete(task.id);
      if (!skippedInitializingBatch && !this.isInitializingBatch(this.liveTask(task.id))) this.restoredCheckpoints.add(task.id);
      if (!this.disposed) this.reconcile();
    }
  }

  private schedule(taskId: string, delay = this.options.pollIntervalMs || 5000) {
    if (this.disposed || this.stopping.has(taskId)) return;
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    this.timers.set(taskId, setTimeout(() => { this.timers.delete(taskId); void this.poll(taskId); }, delay));
  }

  private async recoverComfyAcknowledgement(task: VideoGenerationTask): Promise<boolean> {
    const snapshot = task.videoJob?.snapshot;
    if (!snapshot || snapshot.connection.backend !== 'comfyui') return false;
    const epoch = this.controlEpochs.get(task.id) || 0;
    if (this.acknowledgementChecks.has(task.id) || !this.controlIsCurrent(task, epoch) || this.stopping.has(task.id)) return false;
    const existingTimer = this.acknowledgementTimers.get(task.id);
    if (existingTimer) clearTimeout(existingTimer);
    this.acknowledgementTimers.delete(task.id);
    const lease = {};
    this.acknowledgementChecks.set(task.id, lease);
    // Finding the original ID intentionally changes watch identity. Advance
    // this observation's identity only after accepting its own current reply.
    let observedTask = task;
    const currentRecovery = () => this.acknowledgementChecks.get(task.id) === lease
      && this.controlIsCurrent(observedTask, epoch) && !this.stopping.has(task.id);
    let recovered = false;
    const clientId = snapshot.clientId;
    const matches = (row: unknown): row is unknown[] => Array.isArray(row) && record(row[3]) && row[3].client_id === clientId;
    try {
      const base = snapshot.connection.comfyui!.baseUrl;
      const headers = await this.headers(task);
      if (!currentRecovery()) return false;
      const queue = await this.comfyQueue(task, headers);
      if (!currentRecovery()) return false;
      let remoteTaskId = queue.taskIdByClient.get(clientId);
      if (!remoteTaskId) {
        const history = await this.request(task, { url: join(base, '/history?max_items=100'), headers });
        if (!currentRecovery()) return false;
        if (record(history)) remoteTaskId = Object.entries(history).find(([, entry]) => record(entry) && matches(entry.prompt))?.[0];
      }
      if (!remoteTaskId) return false;
      recovered = true;
      this.acknowledgementRetries.delete(task.id);
      this.patch(task, { remoteTaskId, status: 'submitted', error: undefined }, { stage: 'reconnecting', trackingStopped: false, message: '通过本次唯一客户端标识找回原 ComfyUI 任务，继续查询；没有重新提交。' });
      observedTask = { ...task, remoteTaskId };
      await this.watch(observedTask);
      if (!currentRecovery()) return false;
      this.schedule(task.id, 0);
      return true;
    } catch { return false; }
    finally {
      if (this.acknowledgementChecks.get(task.id) === lease) {
        const canRetry = currentRecovery();
        this.acknowledgementChecks.delete(task.id);
        const latest = this.liveTask(task.id);
        if (!recovered && canRetry && latest?.videoJob?.stage === 'submission-unknown' && !latest.remoteTaskId && !latest.videoJob.trackingStopped) {
          const attempt = (this.acknowledgementRetries.get(task.id) || 0) + 1;
          this.acknowledgementRetries.set(task.id, attempt);
          const delay = Math.min(30_000, (this.options.pollIntervalMs || 5000) * 2 ** Math.min(attempt - 1, 3));
          const timer = setTimeout(() => {
            if (this.acknowledgementTimers.get(task.id) !== timer) return;
            this.acknowledgementTimers.delete(task.id);
            const current = this.liveTask(task.id);
            if (current && this.controlIsCurrent(observedTask, epoch) && !this.stopping.has(task.id)
              && !current.remoteTaskId && !current.videoJob?.trackingStopped) void this.recoverComfyAcknowledgement(current);
          }, delay);
          this.acknowledgementTimers.set(task.id, timer);
        }
      }
    }
  }

  private currentWatchTask(taskId: string, lease: VideoWatchLease): VideoGenerationTask | undefined {
    if (this.disposed || this.stopping.has(taskId) || this.watches.get(taskId) !== lease) return undefined;
    const task = this.liveTask(taskId);
    return task?.videoJob?.snapshot.connection.backend === 'comfyui' && pending(task)
      && !task.resultAssetId && videoWatchIdentity(task) === lease.identity ? task : undefined;
  }

  private async releaseWatch(taskId: string, lease: VideoWatchLease) {
    if (this.watches.get(taskId) === lease) this.watches.delete(taskId);
    this.watchTasks.delete(lease.watchId);
    if (lease.dispatched) {
      lease.dispatched = false;
      await this.options.desktop?.unwatchVideoProgress?.(lease.watchId);
    }
  }

  private async watch(candidate: VideoGenerationTask) {
    const task = this.liveTask(candidate.id);
    if (this.disposed || this.stopping.has(candidate.id) || !task?.videoJob || !pending(task)
      || task.resultAssetId || task.videoJob.snapshot.connection.backend !== 'comfyui' || !this.options.desktop?.watchVideoProgress) return;
    const identity = videoWatchIdentity(task);
    const previous = this.watches.get(task.id);
    if (previous?.identity === identity) return;
    if (previous) void this.releaseWatch(task.id, previous).catch(() => {});
    // Each registration owns a distinct IPC ID: delayed callbacks or cleanup
    // from an older registration can never address its replacement.
    const lease: VideoWatchLease = { watchId: id('video_watch'), identity, dispatched: false };
    this.watches.set(task.id, lease);
    this.watchTasks.set(lease.watchId, task.id);
    try {
      const base = task.videoJob.snapshot.connection.comfyui!.baseUrl;
      const url = new URL(join(base, '/ws')); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('clientId', task.videoJob.snapshot.clientId);
      const headers = await this.headers(task);
      if (!this.currentWatchTask(task.id, lease)) { await this.releaseWatch(task.id, lease); return; }
      lease.dispatched = true;
      await this.options.desktop.watchVideoProgress({ watchId: lease.watchId, url: url.href, headers });
      if (!this.currentWatchTask(task.id, lease)) await this.releaseWatch(task.id, lease);
    } catch { await this.releaseWatch(task.id, lease).catch(() => {}); /* history polling remains authoritative */ }
  }

  private async stopWatch(taskId: string) {
    const timer = this.timers.get(taskId); if (timer) clearTimeout(timer); this.timers.delete(taskId);
    const acknowledgementTimer = this.acknowledgementTimers.get(taskId); if (acknowledgementTimer) clearTimeout(acknowledgementTimer); this.acknowledgementTimers.delete(taskId);
    const lease = this.watches.get(taskId);
    if (lease) await this.releaseWatch(taskId, lease);
  }

  private async poll(taskId: string) {
    const task = this.find(taskId);
    if (!task || !pending(task) || this.disposed || this.stopping.has(taskId)) return;
    if (this.busy.has(taskId)) { this.schedule(taskId); return; }
    this.busy.add(taskId);
    const epoch = this.controlEpochs.get(taskId) || 0;
    const lease = {};
    this.pollLeases.set(taskId, lease);
    const currentPoll = () => this.pollLeases.get(taskId) === lease && this.controlIsCurrent(task, epoch)
      && !this.stopping.has(taskId) && !this.liveTask(taskId)?.videoJob?.trackingStopped;
    let delay = this.options.pollIntervalMs || 5000;
    try {
      const headers = await this.headers(task);
      if (!currentPoll()) return;
      const connection = task.videoJob!.snapshot.connection;
      if (connection.backend === 'comfyui') {
        const base = connection.comfyui!.baseUrl;
        const history = await this.request(task, { url: join(base, `/history/${encodeURIComponent(task.remoteTaskId!)}`), headers });
        if (!currentPoll()) return;
        const current = this.liveTask(task.id);
        if (!current?.videoJob || videoWatchIdentity(current) !== videoWatchIdentity(task)) return;
        const entry = record(history) ? history[task.remoteTaskId!] : undefined;
        const outputSelection = resolveComfyVideoOutputs(entry, base, connection.workflow);
        const files = outputSelection.outputs;
        const status = record(entry) && record(entry.status) ? entry.status : undefined;
        const historyStartedAt = comfyVideoExecutionStartedAt(entry, task.remoteTaskId!);
        const knownStartedAt = (this.runtimes.get(taskId) || task.videoJob!)?.startedAt;
        // queue_running is an immediate local fallback. If ComfyUI history later
        // supplies its exact, earlier execution_start timestamp, refine the
        // approximation once without ever moving the clock forwards.
        const historyTiming = historyStartedAt && (!knownStartedAt || historyStartedAt < knownStartedAt) ? { startedAt: historyStartedAt } : {};
        if (status?.status_str === 'error') {
          this.patch(task, { status: 'failed', error: 'ComfyUI 工作流执行失败；请查看节点错误。', response: redactVideoSecrets(status), videoJob: { ...task.videoJob!, remoteGenerationEnded: true } }, { stage: 'failed', message: 'ComfyUI 服务端报告执行错误', ...historyTiming, completedAt: Date.now() });
          await this.stopWatch(taskId); return;
        }
        if (files.length && status?.completed !== false) {
          this.patch(task, { status: 'succeeded', resultUrl: files[0].url, response: { outputs: files, ...(outputSelection.warning ? { outputSelectionWarning: outputSelection.warning } : {}) }, error: undefined }, { stage: 'downloading', message: '生成完成，正在保存最终视频', ...historyTiming, generatedAt: Date.now() });
          if (outputSelection.warning) this.options.notify?.(outputSelection.warning);
          await this.stopWatch(taskId);
          await this.download(this.liveTask(taskId) || { ...task, status: 'succeeded', resultUrl: files[0].url }); return;
        }
        if (status?.completed === true && !files.length) {
          this.patch(task, { status: 'failed', error: outputSelection.issue || '工作流已完成，但绑定输出节点没有可播放视频；请检查最终输出节点映射。', response: redactVideoSecrets(entry), videoJob: { ...task.videoJob!, remoteGenerationEnded: true } }, { stage: 'failed', message: outputSelection.issue || '未找到最终视频，不会自动重新生成', ...historyTiming, completedAt: Date.now() });
          await this.stopWatch(taskId); return;
        }
        const queue = await this.comfyQueue(task, headers);
        if (!currentPoll()) return;
        const latest = this.liveTask(task.id);
        if (!latest?.videoJob || videoWatchIdentity(latest) !== videoWatchIdentity(task)) return;
        if (queue.runningIds.has(task.remoteTaskId!)) {
          this.comfyMissingTasks.reset(taskId);
          this.progress(task, { stage: 'running', message: this.runtimes.get(taskId)?.nodeId ? this.runtimes.get(taskId)?.message : 'ComfyUI 正在执行此工作流' });
        } else if (queue.pendingIds.has(task.remoteTaskId!)) {
          this.comfyMissingTasks.reset(taskId);
          this.progress(task, { stage: 'queued', message: 'ComfyUI 排队中' });
        } else {
          const validEmptyHistory = record(history) && !entry && Object.values(history).every(record);
          if (!validEmptyHistory || !queue.valid) this.comfyMissingTasks.reset(taskId);
          else if (this.comfyMissingTasks.observe(taskId, task.videoJob!.submittedAt || task.createdAt, queue, Date.now(), videoWatchIdentity(task))) {
            await this.pauseMissingComfyTask(task); return;
          }
          this.progress(task, { stage: 'reconnecting', message: '正在核对原任务的队列与历史记录，不会重新提交' });
        }
      } else {
        const config = connection.api!;
        const submittedFileId = completedFileResult(task);
        if (submittedFileId) {
          const endpoint = config.fileEndpointTemplate || (config.provider === 'minimax' ? defaultMiniMaxVideoApi.fileEndpointTemplate : '');
          if (!endpoint) {
            this.patch(task, { error: '视频已生成，但接口快照缺少文件下载查询端点。' }, { stage: 'stopped', trackingStopped: true, message: '生成成功，尚无法取得下载地址；没有重新生成。' }); return;
          }
          const file = await this.request(task, { url: endpoint.replace(/\{id\}/gu, encodeURIComponent(submittedFileId)), headers });
          if (!currentPoll()) return;
          const url = nestedValue(file, config.fileUrlPath || (config.provider === 'minimax' ? 'file.download_url' : 'url'));
          if (typeof url === 'string' && url) {
            this.patch(task, { status: 'succeeded', resultUrl: url, error: undefined }, { stage: 'downloading', message: '生成完成，正在下载视频', generatedAt: Date.now() });
            await this.download({ ...task, status: 'succeeded', resultUrl: url }); return;
          }
          this.progress(task, {
            stage: 'reconnecting',
            message: '服务端生成成功，正在等待文件下载地址；不会重新生成。',
            generatedAt: task.videoJob!.generatedAt || Date.now(),
          }); return;
        }
        const statusEndpoint = config.provider === 'rhtv_web' ? defaultRhTvApi.statusEndpointTemplate : config.statusEndpointTemplate || (config.provider === 'minimax'
          ? defaultMiniMaxVideoApi.statusEndpointTemplate
          : config.provider === 'runninghub' ? defaultRunningHubVideoApi.statusEndpointTemplate : '');
        if (!statusEndpoint) { this.patch(task, { error: '此任务的接口快照没有状态查询端点。' }, { stage: 'stopped', trackingStopped: true, message: '缺少状态查询端点；任务未重新提交' }); return; }
        const queryUrl = statusEndpoint.replace(/\{id\}/gu, encodeURIComponent(task.remoteTaskId!));
        const response = await this.request(task, config.provider === 'runninghub'
          ? { url: queryUrl, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.remoteTaskId! }) }
          : { url: queryUrl, headers });
        if (!currentPoll()) return;
        const mapped = parseVideoApiResult(response, config);
        if (config.provider === 'rhtv_web' && mapped.remoteTaskId !== task.remoteTaskId) throw new Error('rhTV 返回的任务身份不符，未接收其他任务结果');
        if (mapped.status === 'failed') {
          const remoteGenerationEnded = videoTaskRemoteGenerationEnded({ ...task, response });
          if (!remoteGenerationEnded) {
            this.patch(task, { response: redactVideoSecrets(response), error: mapped.message }, {
              stage: 'stopped', trackingStopped: true,
              message: `状态查询失败：${mapped.message || '接口未返回可用状态'}；远端任务是否结束尚未确认，请恢复查询。后续任务仍按生成名额排队。`,
            });
            await this.stopWatch(taskId);
            return;
          }
          this.patch(task, { status: 'failed', response: redactVideoSecrets(response), error: mapped.message,
            videoJob: { ...task.videoJob!, remoteGenerationEnded: true },
          }, { stage: 'failed', message: mapped.message, completedAt: Date.now() }); return;
        }
        if (mapped.downloadError) {
          this.patch(task, { status: 'succeeded', response: redactVideoSecrets(response), error: undefined }, {
            stage: 'succeeded', downloadError: mapped.downloadError, message: mapped.message,
            generatedAt: task.videoJob!.generatedAt || Date.now(), completedAt: Date.now(),
          });
          await this.stopWatch(taskId); return;
        }
        let resultUrl = mapped.resultUrl || task.resultUrl;
        if (mapped.status === 'succeeded' && !resultUrl && mapped.fileId) {
          const endpoint = config.fileEndpointTemplate || (config.provider === 'minimax' ? defaultMiniMaxVideoApi.fileEndpointTemplate : '');
          if (endpoint) {
            const file = await this.request(task, { url: endpoint.replace(/\{id\}/gu, encodeURIComponent(mapped.fileId)), headers });
            if (!currentPoll()) return;
            const url = nestedValue(file, config.fileUrlPath || (config.provider === 'minimax' ? 'file.download_url' : 'url'));
            if (typeof url === 'string') resultUrl = url;
          }
        }
        if (resultUrl) {
          this.patch(task, { status: 'succeeded', resultUrl, response: redactVideoSecrets(response), error: undefined }, { stage: 'downloading', message: '生成完成，正在下载视频', generatedAt: Date.now() });
          await this.download(this.liveTask(taskId) || { ...task, status: 'succeeded', resultUrl }); return;
        }
        if (mapped.status === 'succeeded') this.progress(task, {
          stage: 'reconnecting',
          message: '服务端生成成功，正在等待可下载的视频文件；不会重新生成',
          generatedAt: task.videoJob!.generatedAt || Date.now(),
        });
        else this.progress(task, { stage: mapped.stage, progress: mapped.progress, message: mapped.message });
      }
      this.retryCounts.delete(taskId);
    } catch (error) {
      if (!currentPoll()) return;
      this.comfyMissingTasks.reset(taskId);
      if (this.stopping.has(taskId) || this.disposed || this.liveTask(taskId)?.videoJob?.trackingStopped) return;
      if (error instanceof HttpError && [401, 403, 404, 410].includes(error.status)) {
        this.patch(task, { error: messageOf(error) }, { stage: 'stopped', trackingStopped: true, message: `查询需要处理：${messageOf(error)}；未重新提交，也未取消服务器任务。` });
        await this.stopWatch(taskId); return;
      }
      const retries = (this.retryCounts.get(taskId) || 0) + 1;
      this.retryCounts.set(taskId, retries);
      delay = Math.min(30_000, (this.options.pollIntervalMs || 5000) * 2 ** Math.min(retries, 3));
      this.progress(task, { stage: 'reconnecting', message: `连接异常，继续恢复原任务：${messageOf(error)}` });
    } finally {
      if (this.pollLeases.get(taskId) === lease) {
        this.pollLeases.delete(taskId);
        this.busy.delete(taskId);
        const latest = this.find(taskId);
        if (latest && pending(latest) && this.controlIsCurrent(task, epoch)) this.schedule(taskId, delay);
        if (latest && videoTaskRemoteGenerationEnded(latest)) this.wakeGenerationQueue();
      }
    }
  }

  private async download(task: VideoGenerationTask) {
    if (!task.videoJob || !task.resultUrl || task.resultAssetId || task.videoJob.resultAssetIds?.length || this.downloading.has(task.id) || this.stopping.has(task.id)) return;
    this.downloading.add(task.id);
    this.patch(task, { status: 'succeeded' }, { stage: 'downloading', step: undefined, totalSteps: undefined, progress: undefined, downloadError: undefined, message: '视频已生成，正在保存到视频资产库' });
    const downloadIdentity = videoWatchIdentity(task);
    const epoch = this.controlEpochs.get(task.id) || 0;
    const ensureDownloadActive = () => {
      this.ensureActive(task);
      if (!this.controlIsCurrent(task, epoch) || videoWatchIdentity(this.liveTask(task.id)!) !== downloadIdentity) throw Object.assign(new Error('原任务跟踪会话或快照已改变，未接收过期成片'), { name: 'AbortError' });
    };
    const requests = this.requestIds.get(task.id) || new Set<string>(); this.requestIds.set(task.id, requests);
    try {
      if (!this.options.desktop?.downloadGeneratedMedia) throw new Error('桌面下载桥不可用；视频已经生成，桌面版可重试保存。');
      ensureDownloadActive();
      const source = task.videoJob.snapshot.connection;
      const mapped = source.backend === 'api' && source.api ? parseVideoApiResult(task.response, source.api) : undefined;
      if (source.api?.provider === 'runninghub' && mapped?.remoteTaskId && task.remoteTaskId && mapped.remoteTaskId !== task.remoteTaskId) {
        throw new Error('保存的云端结果与原任务 ID 不同，未接收其他任务的视频。');
      }
      const candidates = downloadCandidates(task);
      if (!candidates.length) throw new Error('原任务的允许输出节点没有可下载的视频或 ZIP；未使用其他节点或不明来源的旧链接。请检查输出节点设置后重新获取原任务成片，不会重新生成。');
      const origin = source.backend === 'comfyui' ? source.comfyui!.baseUrl : videoApiSubmitEndpoint(source.api!);
      const failures: string[] = [];
      let managed: Awaited<ReturnType<Desktop['downloadGeneratedMedia']>> | undefined;
      let resultUrl: string | undefined;
      for (const [candidateIndex, candidate] of candidates.entries()) {
        ensureDownloadActive();
        const requestId = id(`video_download_${task.id}`);
        this.downloadOwners.set(requestId, task.id); requests.add(requestId);
        let headers: Record<string, string> | undefined;
        try {
          // Each alternative can be hosted on a different origin. Never reuse
          // authorization from a failed same-origin link on a public CDN URL.
          headers = origin && new URL(candidate.resultUrl).origin === new URL(origin).origin ? await this.headers(task) : undefined;
          ensureDownloadActive();
          this.progress(task, { stage: 'downloading', receivedBytes: undefined, totalBytes: undefined,
            message: candidates.length > 1 ? `正在接收云端输出 ${candidateIndex + 1}/${candidates.length}；只获取原任务文件，不会重新生成` : '视频已生成，正在保存到视频资产库' });
          const receive = source.api?.provider === 'rhtv_web' ? this.options.desktop.rhtvDownload : this.options.desktop.downloadGeneratedMedia;
          if (!receive) throw new Error('rhTV 桌面结果接收接口不可用');
          const downloaded = await receive({
            url: candidate.resultUrl, headers, noTimeout: true, requestId,
            fileName: task.videoJob.snapshot.draft.name, allowVideoArchive: true,
            archiveHint: Boolean(candidate.archiveHint || mapped?.archiveHint && mapped.resultUrl === candidate.resultUrl),
          });
          ensureDownloadActive();
          if ([downloaded, ...(downloaded.additionalVideos || [])].some((video) => video.mediaType !== 'video')) {
            throw new Error('下载内容不是视频，未作为成片保存');
          }
          managed = downloaded; resultUrl = candidate.resultUrl;
          break;
        } catch (error) {
          // A late failed download must not trigger the next candidate after
          // cancellation, owner removal, or replacement of the frozen task.
          ensureDownloadActive();
          if (downloadWasAborted(error)) throw error;
          if (source.backend !== 'api' || source.api?.provider !== 'runninghub') throw error;
          const node = candidate.nodeId ? `节点 ${candidate.nodeId.replace(/[^\w.\-]/gu, '').slice(0, 80) || '未知'}` : `输出 ${candidateIndex + 1}`;
          failures.push(`${node}：${safeDownloadFailure(error, headers)}`);
        } finally {
          requests.delete(requestId); this.downloadOwners.delete(requestId);
        }
      }
      if (!managed || !resultUrl) throw new Error(`已尝试 ${candidates.length} 个云端输出，均未能保存可用视频。${failures.join('；')}。可重新获取原任务成片；不会重新生成或重复扣费。`);
      ensureDownloadActive();
      const { additionalVideos, archiveFileName, ...primaryMedia } = managed;
      const videos = [primaryMedia, ...(additionalVideos || [])];
      const now = Date.now();
      // The desktop store owns the global filename namespace. It may normalize a
      // Windows-reserved name or add a collision version that the project-local
      // allocator could not see, so its returned filename is authoritative.
      const storedName = videoFileStem(primaryMedia.fileName || task.videoJob.snapshot.draft.name);
      const assets: ReferenceAsset[] = videos.map((video) => ({
        id: id('asset'), name: videoFileStem(video.fileName || task.videoJob!.snapshot.draft.name), type: 'video', role: 'motion', ...video,
        mediaType: 'video', referenceRole: 'motion', source: 'generated', sourceVideoTaskId: task.id,
        sourceStoryboardId: task.storyboardId || undefined, prompt: task.videoJob!.snapshot.draft.prompt,
        tags: ['生成视频', task.targetId, source.backend], createdAt: now, updatedAt: now,
      }));
      const resultSelectionRequired = assets.length > 1;
      const outputSelectionWarning = source.backend === 'comfyui' && record(task.response) && typeof task.response.outputSelectionWarning === 'string' ? task.response.outputSelectionWarning : '';
      const savedMessage = (resultSelectionRequired ? `ZIP 内 ${assets.length} 段视频已全部保存，请选择本任务使用的成片；后续尾帧衔接正在等待` : '已保存到视频资产库')
        + (outputSelectionWarning ? `；${outputSelectionWarning}` : '');
      this.options.setState((current) => applyOwnedProjectUpdate(current, task.videoJob!.snapshot.projectId, (project) => {
        const existing = project.generationTasks.find((item) => item.id === task.id);
        if (!existing || this.disposed || this.stopping.has(task.id) || (existing as VideoGenerationTask).videoJob?.trackingStopped
          || (existing as VideoGenerationTask).resultAssetId || (existing as VideoGenerationTask).videoJob?.resultAssetIds?.length) return project;
        const existingVideoTask = existing as VideoGenerationTask;
        const completed: VideoGenerationTask = {
          ...existingVideoTask, status: 'succeeded', resultUrl, resultAssetId: resultSelectionRequired ? undefined : assets[0].id, error: undefined, updatedAt: now,
          videoJob: {
            ...existingVideoTask.videoJob!,
            snapshot: {
              ...existingVideoTask.videoJob!.snapshot,
              draft: existingVideoTask.videoJob!.snapshot.batchCompletionOrder || resultSelectionRequired
                ? existingVideoTask.videoJob!.snapshot.draft
                : { ...existingVideoTask.videoJob!.snapshot.draft, name: storedName },
            },
            stage: 'succeeded', completedAt: now, downloadError: undefined, message: savedMessage,
            resultAssetIds: assets.map((asset) => asset.id), resultSelectionRequired,
            resultArchiveFileName: archiveFileName,
          },
        };
        const provenance = snapshotVideoAssetSourceTask(completed);
        return { ...project, assets: [...assets.map((asset) => ({ ...asset, videoSourceTask: provenance })), ...project.assets], generationTasks: project.generationTasks.map((item) => item.id === task.id ? completed : item) };
      }));
      try {
        await this.options.persistState?.();
      } catch (error) {
        // A chained successor may only start after the completed asset and its
        // provenance are durable. Keep the result visible but leave a gate that
        // blocks the next POST until the user retries persistence/download.
        const latest = this.liveTask(task.id);
        if (latest) this.patch(latest, { status: 'succeeded' }, { stage: 'succeeded', downloadError: `成片已落盘但项目保存失败：${messageOf(error)}`, message: '生成成功，项目保存失败；链式后段已暂停' });
        return;
      }
      ensureDownloadActive();
      const runtime = { ...(this.runtimes.get(task.id) || runtimeOnly(task.videoJob)), stage: 'succeeded' as const, completedAt: now, downloadError: undefined, message: savedMessage };
      this.runtimes.set(task.id, runtime); this.options.onRuntime(task.id, runtime);
      const completed = this.liveTask(task.id);
      if (completed?.videoJob) await this.checkpointResult(completed);
      this.resultSelectionsRestored.add(task.id);
    } catch (error) {
      const current = this.liveTask(task.id);
      if (this.controlIsCurrent(task, epoch) && !this.stopping.has(task.id) && current?.videoJob && !current.videoJob.trackingStopped && videoWatchIdentity(current) === downloadIdentity) {
        this.patch(current, { status: 'succeeded' }, { stage: 'succeeded', downloadError: safeDownloadFailure(error, undefined, 10_000), message: '生成成功，保存失败；重试只保存，不重复生成' });
      }
    } finally {
      this.downloading.delete(task.id);
      // Completion-order gates reject a downloading/persisting predecessor.
      // Wake only after that in-memory durability barrier has been released.
      if (!this.disposed) this.reconcile();
    }
  }

  /** Unlike the POST acknowledgement, a result-selection journal failure must
   * remain a blocking save error: another selected file must never be used. */
  private async checkpointResult(task: VideoGenerationTask): Promise<void> {
    this.ensureActive(task);
    const checkpoint = structuredClone({ ...task, updatedAt: Date.now() });
    if (this.options.desktop?.saveVideoTaskCheckpoint) {
      const saved = await this.options.desktop.saveVideoTaskCheckpoint(checkpoint);
      if (!saved.persisted) throw new Error('成片结果断点未保存，后续视频任务尚未提交。');
    }
    this.ensureActive(task);
    this.patch(task, checkpoint);
  }

  /** Main autosave and the independent journal can finish at different times.
   * Recover only a selection of the exact same already-saved files, never a
   * different task/output or an implicit first ZIP entry. */
  private restoreResultSelection(task: VideoGenerationTask): Promise<void> {
    if (this.disposed || this.stopping.has(task.id) || task.videoJob?.trackingStopped) return Promise.resolve();
    const inFlight = this.restoringResultSelections.get(task.id);
    if (inFlight) return inFlight;
    const operation = (async () => {
      this.completionPersistence.add(task.id);
      try {
        this.ensureActive(task);
        const saved = await this.options.desktop?.getVideoTaskCheckpoint?.(task.id);
        this.ensureActive(task);
        const current = this.liveTask(task.id)!;
        if (!current.videoJob?.resultAssetIds?.length) return;
        if (saved?.videoJob?.resultAssetIds?.length) {
          const same = videoWatchIdentity(saved) === videoWatchIdentity(current)
            && canonicalText(saved.videoJob.snapshot.draft) === canonicalText(current.videoJob.snapshot.draft)
            && canonicalText(saved.videoJob.snapshot.previousTail) === canonicalText(current.videoJob.snapshot.previousTail)
            && canonicalText(saved.videoJob.resultAssetIds) === canonicalText(current.videoJob.resultAssetIds)
            && saved.videoJob.resultArchiveFileName === current.videoJob.resultArchiveFileName;
          if (!same) throw new Error('成片断点与当前任务的结果清单不一致，未选用其他视频。');
          if (saved.videoJob.trackingStopped && saved.updatedAt >= current.updatedAt) {
            this.patch(current, {}, { stage: 'stopped', trackingStopped: true, message: '成片断点表明本任务已停止，未恢复后续提交。' });
            return;
          }
          if (!saved.videoJob.resultSelectionRequired && saved.resultAssetId) {
            if (!current.videoJob.resultAssetIds.includes(saved.resultAssetId)) throw new Error('成片断点选择的文件不在原任务清单中。');
            if (current.resultAssetId && current.resultAssetId !== saved.resultAssetId) throw new Error('成片选择与已确认的断点不一致，未更换尾帧来源。');
            this.patch(current, { resultAssetId: saved.resultAssetId, videoJob: { ...current.videoJob, resultSelectionRequired: false } }, {
              stage: 'succeeded', message: '已恢复此任务原先确认的成片选择', downloadError: undefined,
            });
          }
        }
        const latest = this.liveTask(task.id)!;
        const project = allProjects(this.options.getState()).find((entry) => entry.id === latest.videoJob!.snapshot.projectId);
        if (latest.videoJob!.resultAssetIds!.some((assetId) => {
          const asset = project?.assets.find((entry) => entry.id === assetId);
          return !asset || !isVideoAsset(asset) || asset.missing || !asset.relativePath || !asset.checksum || asset.sourceVideoTaskId !== task.id;
        })) throw new Error('成片结果清单的本地视频记录不完整，未继续尾帧链。');
        await this.options.persistState?.();
        this.ensureActive(task);
        await this.checkpointResult(this.liveTask(task.id)!);
      } catch (error) {
        if (!this.disposed && !this.stopping.has(task.id) && this.liveTask(task.id)) this.patch(this.liveTask(task.id)!, {}, {
          stage: 'succeeded', downloadError: `成片选择恢复失败：${messageOf(error)}`, message: '成片记录需要处理；没有重新下载或重新生成，后续尾帧任务已暂停',
        });
      } finally {
        this.resultSelectionsRestored.add(task.id);
        this.completionPersistence.delete(task.id);
        this.restoringResultSelections.delete(task.id);
        if (!this.disposed) this.reconcile();
      }
    })();
    this.restoringResultSelections.set(task.id, operation);
    return operation;
  }

  async retryDownload(taskId: string) {
    let task = this.find(taskId);
    if (!task || !task.resultUrl && !task.resultAssetId && !task.videoJob?.resultAssetIds?.length) throw new Error('此任务还没有可下载的视频网址。');
    this.advanceControlEpoch(taskId);
    this.patch(task, {}, { cancellationPending: false, cancellationConfirmed: undefined });
    if ((task.resultAssetId || task.videoJob?.resultAssetIds?.length) && task.videoJob) {
      if ((task.videoJob.resultAssetIds?.length || 0) > 1 && !this.resultSelectionsRestored.has(taskId)) {
        this.stopping.delete(taskId);
        this.patch(task, {}, { trackingStopped: false });
        await this.restoreResultSelection(task);
        task = this.liveTask(taskId)!;
      }
      if (this.completionPersistence.has(taskId)) return;
      this.completionPersistence.add(taskId);
      try {
        this.stopping.delete(taskId);
        this.patch(task, {}, { stage: 'succeeded', trackingStopped: false, downloadError: undefined, message: '正在重试保存已生成视频的项目记录；不会重新生成' });
        const current = this.liveTask(taskId)!;
        const project = allProjects(this.options.getState()).find((entry) => entry.id === current.videoJob!.snapshot.projectId);
        const assetIds = current.videoJob!.resultAssetIds?.length ? current.videoJob!.resultAssetIds : [current.resultAssetId!];
        if (assetIds.some((assetId) => {
          const asset = project?.assets.find((entry) => entry.id === assetId);
          return !asset || !isVideoAsset(asset) || asset.missing || !asset.relativePath || !asset.checksum || asset.sourceVideoTaskId !== current.id;
        })) throw new Error('已生成视频的本地资产记录不完整，不能继续尾帧链。');
        await this.options.persistState?.();
        this.ensureActive(current);
        await this.checkpointResult(this.liveTask(taskId)!);
        this.patch(this.liveTask(taskId)!, {}, { message: current.videoJob!.resultSelectionRequired ? '多段视频已全部保存，请选择本任务使用的成片；后续尾帧衔接正在等待' : '已保存到视频资产库', downloadError: undefined });
      } catch (error) {
        if (!this.stopping.has(taskId)) this.patch(this.liveTask(taskId) || task, {}, { stage: 'succeeded', downloadError: messageOf(error), message: '项目保存失败；后段未提交，可重试保存' });
        throw error;
      } finally {
        this.completionPersistence.delete(taskId);
        if (!this.disposed) this.reconcile();
      }
      return;
    }
    if (!task.videoJob) {
      const owner = allProjects(this.options.getState()).find((project) => project.generationTasks.some((item) => item.id === taskId));
      if (!owner) return;
      const videoJob: VideoGenerationJob = {
        stage: 'downloading', legacyMetadataIncomplete: true, message: '旧任务仅保存已生成的视频；历史接口与参数信息不完整。',
        snapshot: {
          projectId: owner.id, clientId: id('legacy_video'), images: [],
          draft: { name: `历史视频 ${task.remoteTaskId || task.id}`, prompt: typeof task.requestBody?.prompt === 'string' ? task.requestBody.prompt : '', backend: 'api', references: [], parameters: {}, source: { storyboardId: task.storyboardId, label: '旧任务：来源参数不完整，仅恢复下载' } },
          connection: { backend: 'api', api: { enabled: false, endpoint: '', statusEndpointTemplate: '', authHeader: '', authScheme: '', taskIdPath: '', statusPath: '', resultUrlPath: '' } },
        },
      };
      const prepared = { ...task, videoJob };
      this.options.setState((current) => applyOwnedProjectUpdate(current, owner.id, (project) => ({ ...project, generationTasks: project.generationTasks.map((item) => item.id === taskId ? prepared : item) })));
      task = prepared;
    }
    this.stopping.delete(taskId);
    this.patch(task, {}, { trackingStopped: false, downloadError: undefined });
    await this.download(task);
  }

  /** Recover only an already-issued cloud task. This method has no path to
   * prepareAndSubmit/start: even a failed legacy record cannot cause rebilling. */
  async recoverResult(taskId: string) {
    let task = this.liveTask(taskId);
    if (!task?.videoJob) throw new Error('此任务没有原接口快照，不能安全查询成片。');
    if (task.resultAssetId || task.videoJob.resultAssetIds?.length) { await this.retryDownload(taskId); return; }
    const api = task.videoJob.snapshot.connection.api;
    if (task.videoJob.snapshot.connection.backend !== 'api' || api?.provider !== 'runninghub') {
      if (task.resultUrl) { await this.retryDownload(taskId); return; }
      throw new Error('此入口只恢复 RunningHub 原任务结果，不会提交新的生成任务。');
    }
    if (this.recoveringResults.has(taskId) || this.downloading.has(taskId) || this.busy.has(taskId)) return;
    const saved = parseVideoApiResult(task.response, api);
    if (saved.status === 'succeeded' && task.remoteTaskId && saved.remoteTaskId && saved.remoteTaskId !== task.remoteTaskId) {
      throw new Error('保存的云端结果与原任务 ID 不同，未接收其他任务的视频。');
    }
    const remoteTaskId = task.remoteTaskId || (saved.status === 'succeeded' ? saved.remoteTaskId : '');
    const currentResultUrl = task.resultUrl;
    const currentAllowedOutput = runningHubVideoResults(task.response, api.runningHubOutputNodeIds).find((candidate) => candidate.resultUrl === currentResultUrl);
    const savedUrl = saved.status === 'succeeded' ? currentAllowedOutput?.resultUrl || saved.resultUrl : saved.status === 'failed' ? undefined : task.resultUrl;
    if (!remoteTaskId && !savedUrl) throw new Error('原任务没有远端 ID 或已生成文件地址，不能安全恢复；没有重新提交。');
    const epoch = this.advanceControlEpoch(taskId);
    const ensureRecoveryActive = () => {
      this.ensureActive(task!);
      if (!this.controlIsCurrent(task!, epoch)) throw new Error('原任务跟踪会话已改变，未接收过期查询结果。');
    };
    this.recoveringResults.add(taskId);
    this.stopping.delete(taskId);
    this.patch(task, { error: undefined }, { trackingStopped: false, cancellationPending: false, message: '正在恢复云端原任务成片；不会重新生成' });
    try {
      await this.stopWatch(taskId);
      ensureRecoveryActive();
      // Decode/empty-archive failures do not invalidate the other saved output
      // URLs. Reuse that exact task's full candidate list, including on upgrade.
      // Only authentication/expiry/not-found failures need refreshed signed URLs.
      const refreshSavedUrl = /HTTP\s*(?:401|403|404|410)\b|(?:URL|链接|地址).*?(?:过期|expired)|expired.*?(?:URL|link)/iu.test(task.videoJob.downloadError || '');
      if (savedUrl && (!refreshSavedUrl || !remoteTaskId)) {
        this.patch(task, { status: 'succeeded', resultUrl: savedUrl, ...(remoteTaskId ? { remoteTaskId } : {}), error: undefined }, {
          stage: 'downloading', downloadError: undefined, generatedAt: task.videoJob.generatedAt || Date.now(),
          message: saved.archiveHint ? '云端已成功，正在取回 ZIP 并提取视频；不会重新生成' : '云端已成功，正在取回视频；不会重新生成',
        });
        await this.download(this.liveTask(taskId)!); return;
      }
      await this.recoverCredential(task, /HTTP (?:401|403)|HEADER_API_KEY_NOT_FOUND/u.test(task.error || task.videoJob.downloadError || ''));
      ensureRecoveryActive();
      const statusEndpoint = api.statusEndpointTemplate || defaultRunningHubVideoApi.statusEndpointTemplate;
      const headers = await this.headers(task);
      ensureRecoveryActive();
      const response = await this.request(task, {
        url: statusEndpoint.replace(/\{id\}/gu, encodeURIComponent(remoteTaskId)), method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: remoteTaskId }),
      });
      ensureRecoveryActive();
      const mapped = parseVideoApiResult(response, api);
      if (mapped.remoteTaskId && mapped.remoteTaskId !== remoteTaskId) throw new Error('云端返回的任务 ID 与原任务不同，未接收其他任务的成片。');
      task = this.liveTask(taskId)!;
      if (mapped.status === 'failed') {
        this.patch(task, { status: 'failed', remoteTaskId, response: redactVideoSecrets(response), error: mapped.message }, { stage: 'failed', downloadError: undefined, message: mapped.message, completedAt: Date.now() });
        await this.options.persistState?.(); return;
      }
      if (mapped.status === 'succeeded') {
        this.patch(task, { status: 'succeeded', remoteTaskId, resultUrl: mapped.resultUrl, response: redactVideoSecrets(response), error: undefined }, {
          stage: mapped.resultUrl ? 'downloading' : 'succeeded', message: mapped.message, downloadError: mapped.downloadError,
          generatedAt: task.videoJob!.generatedAt || Date.now(),
        });
        if (mapped.resultUrl) await this.download(this.liveTask(taskId)!);
        else await this.options.persistState?.();
        return;
      }
      this.patch(task, { status: mapped.status, remoteTaskId, response: redactVideoSecrets(response), error: undefined }, {
        stage: mapped.stage, downloadError: undefined, message: '云端原任务仍未完成，继续查询原 ID；不会重新生成',
      });
      await this.options.persistState?.();
      ensureRecoveryActive();
      this.schedule(taskId, 0);
    } catch (error) {
      if (this.controlIsCurrent(task, epoch) && !this.stopping.has(taskId) && this.liveTask(taskId)) {
        const knownSuccess = saved.status === 'succeeded' || task.status === 'succeeded';
        this.patch(this.liveTask(taskId)!, { status: knownSuccess ? 'succeeded' : 'unknown', error: knownSuccess ? undefined : messageOf(error) }, {
          stage: knownSuccess ? 'succeeded' : 'stopped', trackingStopped: !knownSuccess, downloadError: knownSuccess ? messageOf(error) : undefined,
          message: '取回原任务结果失败；未重新生成，可再次重试',
        });
        throw error;
      }
    } finally {
      this.recoveringResults.delete(taskId);
      if (!this.disposed) this.reconcile();
    }
  }

  /** A ZIP can contain alternatives or segments. Never silently choose its
   * first entry as the next segment's tail-frame source. */
  async selectResultVideo(taskId: string, assetId: string) {
    let task = this.liveTask(taskId);
    if (task?.videoJob?.resultAssetIds?.length && !this.resultSelectionsRestored.has(taskId)) {
      await this.restoreResultSelection(task);
      task = this.liveTask(taskId);
    }
    if (!task?.videoJob?.resultAssetIds?.includes(assetId)) throw new Error('所选视频不属于此任务的已保存结果。');
    if (!task.videoJob.resultSelectionRequired && task.resultAssetId && task.resultAssetId !== assetId) throw new Error('本任务已确认成片，不能更换已被后续任务使用的尾帧来源。');
    if (this.downloading.has(taskId) || this.completionPersistence.has(taskId)) return;
    this.ensureActive(task);
    const project = allProjects(this.options.getState()).find((entry) => entry.id === task.videoJob!.snapshot.projectId);
    const asset = project?.assets.find((entry) => entry.id === assetId);
    if (!asset || !isVideoAsset(asset) || asset.missing || !asset.relativePath || !asset.checksum || asset.sourceVideoTaskId !== taskId) throw new Error('所选成片缺少可信的本地视频文件，未继续后段。');
    this.completionPersistence.add(taskId);
    try {
      this.patch(task, { status: 'succeeded', resultAssetId: assetId, error: undefined, videoJob: { ...task.videoJob, resultSelectionRequired: false } }, {
        stage: 'succeeded', downloadError: undefined, message: `已选用成片：${asset.name}`,
      });
      await this.options.persistState?.();
      this.ensureActive(task);
      await this.checkpointResult(this.liveTask(taskId)!);
      this.ensureActive(task);
    } catch (error) {
      if (!this.disposed && !this.stopping.has(taskId) && this.liveTask(taskId)) this.patch(this.liveTask(taskId)!, {}, {
        stage: 'succeeded', downloadError: `成片选择记录保存失败：${messageOf(error)}`, message: '成片已保留，选择记录尚未保存；后续尾帧任务已暂停',
      });
      throw error;
    } finally {
      this.completionPersistence.delete(taskId);
      if (!this.disposed) this.reconcile();
    }
  }

  async resume(taskId: string) {
    this.comfyMissingTasks.reset(taskId);
    let task = this.liveTask(taskId);
    if (!task?.videoJob) throw new Error('任务没有可恢复的接口快照。');
    if (task.videoJob.cancellationPending) {
      this.advanceControlEpoch(taskId);
      this.stopping.delete(taskId);
      this.patch(task, {}, { cancellationPending: false, cancellationConfirmed: undefined, trackingStopped: false, message: '继续查询原任务；远端取消结果已过期，不会覆盖本次恢复。' });
      task = this.liveTask(taskId)!;
      if (!task?.videoJob) throw new Error('任务已移除，不能恢复。');
    }
    if (task.resultAssetId && !task.videoJob.downloadError && !task.videoJob.trackingStopped && task.videoJob.stage !== 'stopped') return;
    if (task.resultUrl) { await this.retryDownload(taskId); return; }
    // A prior read/persistence failure is retryable, but never relaxes the
    // journal/asset identity requirements of an archived chain dependency.
    this.archivedDependencyAttempts.clear();
    const epoch = this.advanceControlEpoch(taskId);
    this.patch(task, {}, { cancellationPending: false, cancellationConfirmed: undefined });
    const pendingTailPreparation = task.videoJob.tailPreparation?.phase === 'blocked' ? this.tailPreparationSettlements.get(taskId) : undefined;
    if (pendingTailPreparation) {
      await pendingTailPreparation;
      if (!this.controlIsCurrent(task, epoch)) return;
      task = this.liveTask(taskId)!;
      if (!task?.videoJob) throw new Error('任务已移除，不能恢复。');
    }
    if (task.videoJob.batchQueueState === 'cancelled'
      && task.videoJob.preparation?.phase === 'preparing'
      && !task.remoteTaskId
      && !completedFileResult(task)) {
      throw new Error('此批量任务已在提交前停止，没有远端任务可查询。若要生成，请重新发起任务。');
    }
    if (task.remoteTaskId || completedFileResult(task)) this.checkpointErrors.delete(taskId);
    if (!task.remoteTaskId && !completedFileResult(task) && task.videoJob.preparation?.version === 1 && (!this.restoredCheckpoints.has(taskId) || task.videoJob.preparation.phase === 'preparing' || this.checkpointErrors.has(taskId))) {
      await this.restoreCheckpoint(task);
      if (!this.controlIsCurrent(task, epoch)) return;
      task = this.liveTask(taskId)!;
    }
    if (task.videoJob?.batchQueueState === 'cancelled' || task.videoJob?.tailPreparation?.phase === 'cancelled') {
      throw new Error('可信断点表明此链式任务已经取消，不能恢复提交；若要生成，请重新确认并创建批次。');
    }
    if (this.checkpointErrors.has(taskId)) throw new Error(this.checkpointErrors.get(taskId));
    if (task.resultUrl && !task.resultAssetId) { await this.retryDownload(taskId); return; }
    const recoveredKey = await this.recoverCredential(task, /HTTP (?:401|403)|HEADER_API_KEY_NOT_FOUND/u.test(task.error || ''));
    if (!this.controlIsCurrent(task, epoch)) return;
    this.requireRunningHubCredential(task.videoJob!.snapshot.connection.api, recoveredKey);
    task = this.liveTask(taskId)!;
    if (!task?.videoJob) throw new Error('任务已移除，不能恢复。');
    if (task.videoJob.batchQueueState === 'cancelled' || task.videoJob.tailPreparation?.phase === 'cancelled') {
      throw new Error('此任务已在恢复期间取消，未继续提交。');
    }
    if (task.videoJob!.preparation?.phase === 'preparing' && !task.remoteTaskId) {
      this.stopping.delete(taskId);
      this.patch(task, { status: task.batchId ? 'draft' : 'submitting', error: undefined,
        videoJob: { ...task.videoJob!, remoteGenerationEnded: undefined, ...(task.batchId ? { batchQueueState: 'ready' as const } : {}) },
      }, { stage: 'preparing', trackingStopped: false, message: '继续准备已保存的原图与参数；尚未提交视频生成' });
      if (task.videoJob!.snapshot.previousTail && !this.tailReady(this.liveTask(taskId)!)) {
        await this.prepareTail(this.liveTask(taskId)!, true);
        if (!this.controlIsCurrent(task, epoch)) return;
        const latest = this.liveTask(taskId);
        if (!latest || !this.tailReady(latest)) return;
      }
      if (task.batchId) {
        this.scheduleBatch(task.batchId);
      } else await this.prepareAndSubmit(this.liveTask(taskId)!);
      return;
    }
    if (!task.remoteTaskId && !completedFileResult(task)) {
      this.stopping.delete(taskId);
      if (task.videoJob?.snapshot.connection.api?.provider === 'rhtv_web') {
        const result = await this.request(task, { url: `${RHTV_ORIGIN}/v1/videos/by-client/${encodeURIComponent(task.videoJob.snapshot.clientId)}` });
        if (!record(result) || result.client_id !== task.videoJob.snapshot.clientId) throw new Error('rhTV 恢复结果与原任务身份不符；没有重新提交');
        const mapped = parseVideoApiResult(result, task.videoJob.snapshot.connection.api);
        if (mapped.remoteTaskId) {
          if (!this.controlIsCurrent(task, epoch)) return;
          task = await this.checkpoint({ ...this.liveTask(taskId)!, remoteTaskId: mapped.remoteTaskId, response: result,
            videoJob: { ...this.liveTask(taskId)!.videoJob!, preparation: { ...task.videoJob.preparation!, phase: 'acknowledged' }, trackingStopped: false } });
          this.schedule(taskId, 0); return;
        }
      }
      if (await this.recoverComfyAcknowledgement(task)) return;
      throw new Error('提交结果没有远端任务 ID，尚未找到原任务；不能安全恢复查询，程序不会自动重新提交。');
    }
    this.stopping.delete(taskId);
    this.patch(task, { status: 'submitted', error: undefined }, { stage: 'reconnecting', trackingStopped: false, cancellationPending: false, cancellationConfirmed: undefined, message: '继续查询原任务' });
    await this.watch(task);
    this.schedule(taskId, 0);
  }

  async cancel(taskId: string) {
    const initial = this.find(taskId);
    if (!initial?.videoJob) return;
    let task: VideoGenerationTask = initial;
    const epoch = this.advanceControlEpoch(taskId);
    const currentCancellation = () => this.controlIsCurrent(task, epoch, true) && this.stopping.has(taskId);
    const requestsToCancel = [...(this.requestIds.get(taskId) || [])];
    this.stopping.add(taskId);
    this.tailSelectionControllers.get(taskId)?.abort();
    this.comfyMissingTasks.reset(taskId);
    // A stale project can still say "queued" after the native journal crossed
    // the paid POST boundary. Stop dispatch synchronously, then read that
    // journal before certifying cancellation or allowing one-click deletion.
    // Current-engine shells are already trusted; their initialization must not
    // be mistaken for a restarted task with a missing journal.
    if (isUnsubmittedVideoTask(task) && !this.restoredCheckpoints.has(taskId) && !this.isInitializingBatch(task)) {
      await this.restoreCheckpoint(task);
      // Recovering the remote ID legitimately changes the watch identity; only
      // a newer user action or a replaced task invalidates this cancellation.
      if (this.disposed || this.controlEpochs.get(taskId) !== epoch || !this.stopping.has(taskId)) return;
      const restored = this.liveTask(taskId);
      if (!restored?.videoJob || restored.createdAt !== initial.createdAt
        || restored.videoJob.snapshot.projectId !== initial.videoJob.snapshot.projectId
        || restored.videoJob.snapshot.clientId !== initial.videoJob.snapshot.clientId) return;
      task = restored;
    }
    const beforePost = isUnsubmittedVideoTask(task);
    const remoteCancellationPending = !beforePost && Boolean(task.remoteTaskId);
    if (!beforePost) {
      const operations = this.remoteCancellations.get(taskId) || new Set<number>();
      operations.add(epoch); this.remoteCancellations.set(taskId, operations);
    }
    let remoteDispatched = false;
    try {
    const tailCancelled = beforePost && task.videoJob!.snapshot.previousTail
      ? { ...task.videoJob!.tailPreparation, phase: 'cancelled' as const, revision: (task.videoJob!.tailPreparation?.revision || 0) + 1, sourceVideoAssetId: task.videoJob!.tailPreparation?.sourceVideoAssetId, sourceRelativePath: task.videoJob!.tailPreparation?.sourceRelativePath, sourceChecksum: task.videoJob!.tailPreparation?.sourceChecksum, errorCode: 'cancelled', message: '已取消尾帧抽取与后段提交；如需生成，请重新建立链式任务。' }
      : undefined;
    this.patch(task, { status: beforePost ? 'failed' : task.status === 'submitting' ? 'unknown' : task.status }, {
      stage: 'stopped', trackingStopped: true, cancellationPending: remoteCancellationPending,
      cancellationConfirmed: beforePost ? true : undefined,
      message: beforePost ? '已停止素材准备，尚未提交视频生成；可继续准备。' : '已停止本地跟踪并释放本机并发名额；尚未确认取消服务器任务，原任务记录保留，可继续查询。',
    });
    this.generationClaims.delete(taskId);
    this.wakeGenerationQueue();
    const stopped = this.liveTask(taskId);
    if (stopped && (tailCancelled || beforePost && stopped.videoJob?.snapshot.batchCompletionOrder)) {
      this.patch(stopped, { videoJob: { ...stopped.videoJob!, ...(tailCancelled ? { tailPreparation: tailCancelled } : {}), ...(stopped.batchId ? { batchQueueState: 'cancelled' as const } : {}) } });
    }
    const extractionJobId = this.tailExtractionJobs.get(taskId);
    if (extractionJobId) await this.options.desktop?.cancelWorkbenchJob?.(extractionJobId).catch(() => {});
    if (!currentCancellation()) return;
    const cancelledCheckpoint = this.liveTask(taskId);
    if (cancelledCheckpoint) {
      try {
        const saved = await this.options.desktop?.saveVideoTaskCheckpoint?.(cancelledCheckpoint);
        if (this.options.desktop?.saveVideoTaskCheckpoint && !saved?.persisted) throw new Error('取消断点没有落盘');
      }
      catch (error) { this.options.notify?.(`取消状态暂未写入本地记录：${messageOf(error)}；任务已在当前窗口停止。`, 'error'); }
      try { await this.options.persistState?.(); }
      catch (error) { this.options.notify?.(`取消状态主文件保存失败：${messageOf(error)}；请勿关闭软件，任务已在当前窗口停止。`, 'error'); }
    }
    if (!currentCancellation()) return;
    await this.stopWatch(taskId);
    if (!currentCancellation()) return;
    await Promise.all(requestsToCancel.map((requestId) => this.options.desktop?.cancelVideoRequest?.(requestId)));
    if (!currentCancellation()) return;
    // Cancel must remain responsive even when the no-deadline server is disconnected.
    // Remote cancellation is attempted independently after local tracking has stopped.
    if (!beforePost) {
      remoteDispatched = true;
      void this.cancelRemote(task, epoch).finally(() => {
        this.releaseCancellation(taskId, epoch);
        // A task may have been removed from the local project while the
        // provider-side queue deletion was in flight. Finish deferred cleanup
        // now that the cancellation request no longer needs its credentials.
        if (!this.disposed) this.reconcile();
      });
    }
    } finally {
      if (!remoteDispatched) this.releaseCancellation(taskId, epoch);
      // Old uploads/POSTs may never settle. Local stop releases their software
      // claim, but a newer explicit resume must retain its own claim.
      if (videoTaskStoppedLocally(this.liveTask(taskId) || task)) this.generationClaims.delete(taskId);
      this.wakeGenerationQueue();
    }
  }

  private async cancelRemote(task: VideoGenerationTask, epoch: number) {
    const taskId = task.id;
    const currentCancellation = () => this.controlIsCurrent(task, epoch, true) && this.stopping.has(taskId);
    let serverCancelled = false;
    const config = task.videoJob!.snapshot.connection;
    // Comfy's /interrupt is global. Only delete this ID from the pending queue.
    if (task.remoteTaskId && config.backend === 'comfyui') {
      try {
        const headers = await this.headers(task);
        if (!currentCancellation()) return;
        const queue = await this.request(task, { url: join(config.comfyui!.baseUrl, '/queue'), headers }, true);
        if (!currentCancellation()) return;
        const inPending = record(queue) && Array.isArray(queue.queue_pending) && queue.queue_pending.some((row) => Array.isArray(row) && String(row[1]) === task.remoteTaskId);
        if (inPending && currentCancellation()) {
          await this.request(task, { url: join(config.comfyui!.baseUrl, '/queue'), method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [task.remoteTaskId] }) }, true);
          if (!currentCancellation()) return;
          const checked = await this.request(task, { url: join(config.comfyui!.baseUrl, '/queue'), headers }, true);
          if (!currentCancellation()) return;
          serverCancelled = record(checked) && ['queue_pending', 'queue_running'].every((key) => Array.isArray(checked[key]) && !(checked[key] as unknown[]).some((row) => Array.isArray(row) && String(row[1]) === task.remoteTaskId));
          if (serverCancelled) {
            const history = await this.request(task, { url: join(config.comfyui!.baseUrl, `/history/${encodeURIComponent(task.remoteTaskId)}`), headers }, true);
            if (record(history) && history[task.remoteTaskId]) serverCancelled = false;
          }
        }
      } catch { /* stop locally, never claim server cancellation without confirmation */ }
    } else if (task.remoteTaskId && config.api && (config.api.provider === 'rhtv_web' || config.api.cancelEndpointTemplate)) {
      try {
        const headers = await this.headers(task);
        if (!currentCancellation()) return;
        const endpoint = config.api.provider === 'rhtv_web' ? defaultRhTvApi.cancelEndpointTemplate! : config.api.cancelEndpointTemplate!;
        const result = await this.request(task, { url: endpoint.replace(/\{id\}/gu, encodeURIComponent(task.remoteTaskId)), method: config.api.provider === 'rhtv_web' ? 'POST' : config.api.cancelMethod || 'POST', headers }, true);
        if (config.api.provider === 'rhtv_web' && record(result) && result.id === task.remoteTaskId && result.cancellation_confirmed === true) serverCancelled = true;
        // A 2xx can mean cancellation merely queued. Do not claim a confirmed remote stop.
      } catch { /* preserve task for resume */ }
    }
    if (!currentCancellation()) return;
    this.patch(task, { status: serverCancelled ? 'failed' : this.find(taskId)?.status || task.status,
      ...(serverCancelled ? { videoJob: { ...task.videoJob!, remoteGenerationEnded: true as const } } : {}),
    }, {
      stage: 'stopped', trackingStopped: true, cancellationPending: false, cancellationConfirmed: serverCancelled,
      message: serverCancelled ? (config.api?.provider === 'rhtv_web' ? '已取消 rhTV 本机待提交任务，未提交到网页' : '已从 ComfyUI 等待队列取消此任务') : '已停止本地跟踪，不占本机并发名额；未确认取消服务器任务，可继续查询原任务。',
      ...(serverCancelled ? { completedAt: Date.now() } : {}),
    });
  }

  dispose() {
    this.disposed = true; this.unsubscribe?.();
    for (const controller of this.continuationControllers.values()) controller.abort();
    this.continuationControllers.clear(); this.continuationPlans.clear(); this.continuationStarts.clear(); this.batchResumes.clear();
    for (const controller of this.tailSelectionControllers.values()) controller.abort();
    this.tailSelectionControllers.clear();
    for (const jobId of this.tailExtractionJobs.values()) void this.options.desktop?.cancelWorkbenchJob?.(jobId).catch(() => {});
    this.tailExtractionJobs.clear();
    this.timers.forEach((timer) => clearTimeout(timer)); this.timers.clear();
    this.acknowledgementTimers.forEach((timer) => clearTimeout(timer)); this.acknowledgementTimers.clear();
    this.watches.forEach((lease, taskId) => { void this.releaseWatch(taskId, lease).catch(() => {}); });
    this.watches.clear(); this.watchTasks.clear();
    this.videoNameReservations.clear();
    this.batchStarts.clear(); this.batchClaims.clear();
    this.generationClaims.clear();
    this.initializingBatches.clear(); this.cancelledBatches.clear(); this.remoteCancellations.clear();
    this.controlEpochs.clear(); this.pollLeases.clear(); this.acknowledgementChecks.clear();
    this.archivedDependencies.clear(); this.archivedDependencyAttempts.clear(); this.restoringArchivedDependencies.clear();
    this.requestFingerprintOwners.clear();
    this.comfyQueuePresence.clear(); this.comfyMissingTasks.clear();
  }
}
