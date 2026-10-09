import type { ReferenceRole, VideoGenerationTask, VideoTaskApiConfig } from './types';
import type { ManagedMediaResult } from './storage';
import type { VideoWorkbenchStatus, WorkbenchExtractedFrame, WorkbenchFrameRequest, WorkbenchFrameResult } from './videoWorkbenchTypes';
import type { VideoRuntimeStore, VideoRuntimeSnapshot } from './videoRuntimeStore';

export interface VideoDesktopRequest {
  requestId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  multipart?: { fields?: Record<string, string> | Array<{ name: string; value: string }>; files: Array<{ fieldName?: string; name?: string; fileName: string; dataUrl: string }> };
  responseType?: 'text' | 'base64' | 'auto';
}
export interface VideoDesktopProgressEvent { watchId: string; type: 'message' | 'connected' | 'disconnected' | 'error'; data?: unknown; message?: string }
export interface GeneratedMediaDownloadRequest {
  requestId: string;
  url: string;
  headers?: Record<string, string>;
  noTimeout?: boolean;
  /** Human-readable stem. The desktop store detects and appends the real media extension. */
  fileName?: string;
  /** Only the video-task workflow can opt in to ZIP video extraction. */
  allowVideoArchive?: boolean;
  archiveHint?: boolean;
}
export interface GeneratedMediaDownloadResult extends ManagedMediaResult {
  /** All videos are imported; multiple results need an explicit primary choice. */
  additionalVideos?: ManagedMediaResult[];
  archiveFileName?: string;
}
/** Standalone bridge contract also usable by tests and non-Window environments. */
export interface VideoGenerationDesktop {
  rhtvRequest?: VideoGenerationDesktop['videoRequest'];
  rhtvDownload?: VideoGenerationDesktop['downloadGeneratedMedia'];
  rhtvControl?: (request: import('./rhtvBridge').RhTvControlRequest) => Promise<import('./rhtvBridge').RhTvBridgeStatus>;
  videoRequest: (payload: VideoDesktopRequest) => Promise<{ status: number; body: string; bodyEncoding?: 'text' | 'base64'; contentType?: string }>;
  cancelVideoRequest: (requestId: string) => Promise<boolean>;
  watchVideoProgress: (payload: { watchId: string; url: string; headers?: Record<string, string> }) => Promise<void>;
  unwatchVideoProgress: (watchId: string) => Promise<boolean>;
  onVideoProgress: (callback: (event: VideoDesktopProgressEvent) => void) => () => void;
  setVideoTaskCredential: (payload: { taskId: string; apiKey: string }) => Promise<{ persisted: boolean }>;
  getVideoTaskCredential: (taskId: string) => Promise<string | null>;
  downloadGeneratedMedia: (payload: GeneratedMediaDownloadRequest) => Promise<GeneratedMediaDownloadResult>;
  readManagedImageDataUrl: (payload: { relativePath: string; expectedChecksum?: string }) => Promise<{ dataUrl: string }>;
  storeGeneratedImage?: (payload: { dataUrl: string; fileName?: string }) => Promise<ManagedMediaResult>;
  saveVideoTaskCheckpoint?: (task: VideoGenerationTask) => Promise<{ persisted: boolean }>;
  getVideoTaskCheckpoint?: (taskId: string) => Promise<VideoGenerationTask | null>;
  deleteVideoTaskCheckpoint?: (taskId: string) => Promise<boolean>;
  videoWorkbenchStatus?: () => Promise<VideoWorkbenchStatus>;
  extractWorkbenchFrames?: (request: WorkbenchFrameRequest) => Promise<WorkbenchFrameResult>;
  cancelWorkbenchJob?: (jobId: string) => Promise<boolean>;
}

export type VideoGenerationBackend = 'api' | 'comfyui';
/** UI source; cloud workflows reuse the authenticated API task transport. */
export type VideoGenerationSource = VideoGenerationBackend | 'runninghub';
export interface VideoPromptSource {
  chapterId?: string;
  storyboardId?: string;
  sequencePlanId?: string;
  segmentId?: string;
  segmentIndex?: number;
  promptVersion?: number | string;
  language?: 'zh' | 'en';
  label?: string;
}
export interface VideoImageReference {
  assetId: string;
  role: ReferenceRole;
  /** Zero-based physical input slot. Omitted in legacy dense selections. */
  slotIndex?: number;
  /** Explicit per-selection identities; multiple IDs support a group photo.
   * Empty means intentionally no identity binding, never infer from filename. */
  characterIds?: string[];
}
export interface VideoGenerationDraft {
  name: string;
  prompt: string;
  /** Exact authored identity anchors used only to serialize image bindings. */
  h3ReferenceBinding?: import('./videoH3ReferenceBinding').VideoH3ReferenceBinding;
  /** Informational reference warnings only; never a submission gate. */
  h3ReferenceWarnings?: string[];
  backend: VideoGenerationBackend;
  source?: VideoPromptSource;
  references: VideoImageReference[];
  /** Remembers empty slots' uses for replacement; never sent as image inputs. */
  referenceSlotRoles?: ReferenceRole[];
  /** Only explicitly entered values. Empty means preserve workflow/provider defaults. */
  parameters: Record<string, unknown>;
  apiProfileId?: string;
  /** Selects the independent RunningHub cloud library, not videoApiProfiles. */
  runningHubWorkflowId?: string;
  workflowId?: string;
  /** Reuse this task's frozen connection/workflow and credential, not newly edited settings. */
  reuseTaskId?: string;
}
export interface ComfyVideoInputBinding { nodeId: string; inputName: string }
export interface ComfyVideoMapping {
  prompt: ComfyVideoInputBinding[];
  images: Array<ComfyVideoInputBinding & { role?: ReferenceRole }>;
  parameters?: Record<string, ComfyVideoInputBinding>;
  outputNodeId?: string;
}
export interface ComfyVideoWorkflowPreset {
  id: string;
  name: string;
  workflowJson: string;
  mapping: ComfyVideoMapping;
  createdAt: number;
  updatedAt: number;
}
export interface ComfyVideoConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  promptPath?: string;
  workflows: ComfyVideoWorkflowPreset[];
  activeWorkflowId?: string | null;
}
export type VideoApiProfile = VideoTaskApiConfig & { id: string; name: string; createdAt: number; updatedAt: number };
export type VideoGenerationStage = 'preparing' | 'submitting' | 'queued' | 'running' | 'reconnecting' | 'downloading' | 'succeeded' | 'failed' | 'submission-unknown' | 'stopped';
export interface VideoGenerationRuntime {
  stage: VideoGenerationStage;
  message?: string;
  progress?: number;
  nodeId?: string;
  step?: number;
  totalSteps?: number;
  startedAt?: number;
  submittedAt?: number;
  generatedAt?: number;
  completedAt?: number;
  trackingStopped?: boolean;
  /** A directed provider-side cancellation is still being verified. */
  cancellationPending?: boolean;
  /** The provider confirmed the remote queue/task cancellation. */
  cancellationConfirmed?: boolean;
  downloadError?: string;
  receivedBytes?: number;
  totalBytes?: number;
}
export interface VideoGenerationSnapshot {
  projectId: string;
  draft: VideoGenerationDraft;
  connection: {
    backend: VideoGenerationBackend;
    api?: Omit<VideoTaskApiConfig, 'apiKey'>;
    comfyui?: Omit<ComfyVideoConfig, 'apiKey' | 'workflows'>;
    workflow?: ComfyVideoWorkflowPreset;
  };
  /** Desktop freezes actual bytes in the content-addressed asset store. dataUrl is only the browser fallback. */
  images: Array<VideoImageReference & {
    name: string; fileName?: string; relativePath?: string; checksum?: string; url?: string;
    dataUrl?: string;
    freezeState?: 'pending' | 'frozen';
    frozenAt?: number;
  }>;
  clientId: string;
  /** Immutable dependency identity. The reserved reference ID already exists in
   * draft.references; resolving its pixels never rewrites the frozen draft. */
  previousTail?: VideoPreviousTailDefinition;
  /** Any dependency makes the whole selected batch completion-ordered. */
  batchCompletionOrder?: true;
  /** Exact preceding selected task, including entries that use manual images. */
  batchPredecessorTaskId?: string;
  /** Exact task lineage, not a prompt/image similarity match. Frozen before a
   * continued task can be submitted and retained by its independent journal. */
  continuedFrom?: {
    version: 1;
    planId: string;
    batchId: string;
    taskId: string;
    requestFingerprint: string;
  };
}
export interface VideoBatchContinuationClaim {
  version: 1;
  planId: string;
  batchId: string;
  taskId: string;
  /** Monotonic journal revision; a released pre-creation attempt can be retried. */
  revision: number;
  released?: true;
}
export interface VideoPreviousTailDefinition {
  version: 1;
  predecessorTaskId: string;
  predecessorItemKey: string;
  predecessorRequestFingerprint: string;
  sequencePlanId: string;
  predecessorSegmentId: string;
  predecessorSegmentIndex: number;
  segmentId: string;
  segmentIndex: number;
  referenceIndex: number;
  referenceRole: ReferenceRole;
  reservedFrameAssetId: string;
  /** Omitted on legacy tasks: extract the exact last frame without AI. */
  selectionMode?: 'ai-assisted';
  /** New one-click AI requests must not silently fall back to an unreviewed frame. */
  requireAiSelection?: true;
  /** Omitted on older frozen tasks: one request only. New strict requests allow
   * the initial request and at most three settled-failure retries. */
  aiMaxAttempts?: number;
}
export interface VideoTailSelectionPreparation {
  /** The started boundary is durable before any potentially billable AI call.
   * An interrupted request is never automatically issued a second time. */
  status: 'started' | 'completed';
  /** One explicit user-authorized selection run; retries within a live run
   * advance attempt only after the prior request has definitively failed.
   * These optional fields are all present together; legacy records omit them. */
  run?: number;
  attempt?: number;
  maxAttempts?: number;
  maxTokens?: number;
  source?: 'ai' | 'last-frame';
  selectedId?: string;
  reason?: string;
  warning?: string;
  offsetFromEndSec?: number;
  selectedTimeSec?: number;
  lastFrameTimeSec?: number;
  candidateCount?: number;
  /** Exact managed pixels returned by selection; persisted before binding. */
  frame?: WorkbenchExtractedFrame;
}
export interface VideoTailPreparation {
  phase: 'waiting' | 'extracting' | 'ready' | 'blocked' | 'cancelled';
  /** Monotonic local preparation progress; journal recovery cannot lose a
   * completed tail binding merely because both POST phases are preparing. */
  revision: number;
  sourceVideoAssetId?: string;
  sourceRelativePath?: string;
  sourceChecksum?: string;
  errorCode?: string;
  message?: string;
  selection?: VideoTailSelectionPreparation;
}
export interface VideoGenerationJob extends VideoGenerationRuntime {
  snapshot: VideoGenerationSnapshot;
  /** Explicit provider success/failure/cancellation, or a rejected generation
   * POST. Local stop/query/download errors must never set this marker. */
  remoteGenerationEnded?: true;
  legacyMetadataIncomplete?: boolean;
  /** A durable post-started boundary is written BEFORE POST; it is never permission to resubmit. */
  preparation?: { version: 1; phase: 'preparing' | 'post-started' | 'acknowledged'; uploadedImages: Array<string | null> };
  /** Persistent local submission gate for a batch task. Only ready/active entries
   * may enter prepareAndSubmit; waiting entries have not completed their durable
   * checkpoint yet and cancelled/done entries must never be auto-submitted. */
  batchQueueState?: 'waiting' | 'ready' | 'active' | 'done' | 'cancelled';
  tailPreparation?: VideoTailPreparation;
  resultAssetIds?: string[];
  resultSelectionRequired?: boolean;
  resultArchiveFileName?: string;
  /** Does not change the original task's status/cancellation tombstone. A
   * continuation owns this exact unfinished slot, including across restarts. */
  batchContinuation?: VideoBatchContinuationClaim;
}
export interface VideoBatchTailPlacement {
  /** prepend reserves slot 1 for continuity while retaining every identity input. */
  mode: 'append' | 'replace' | 'replace-all' | 'prepend';
  index: number;
  /** Physical slot for an append into a vacancy; index stays a dense index. */
  slotIndex?: number;
  role: ReferenceRole;
  replacedAssetId?: string;
  /** Explicitly confirmed selection for a one-image connection. Not asset deletion. */
  replacedReferences?: VideoImageReference[];
}
export interface VideoBatchItemInput {
  /** Stable within the caller's selection, normally `${storyboardId}:${language}`. */
  itemKey: string;
  draft: VideoGenerationDraft;
  /** Explicitly generate another copy even when an identical successful task exists. */
  force?: boolean;
  previousTail?: {
    predecessorItemKey: string;
    placement: VideoBatchTailPlacement;
    selectionMode?: 'ai-assisted';
    requireAiSelection?: true;
  };
}
export interface VideoBatchStartInput {
  projectId: string;
  label: string;
  items: VideoBatchItemInput[];
  /** Legacy preparation concurrency. Actual remote capacity is controlled by
   * the application-wide videoExecutionMode/videoExecutionConcurrency setting. */
  concurrency?: number;
  /** Batch-wide successful-result override. In-flight/unknown work is never re-submitted. */
  force?: boolean;
  /** Preserve a continued chain's completion order even when the suffix uses only static references. */
  completionOrder?: true;
}
export interface VideoBatchSkippedItem {
  itemKey: string;
  requestFingerprint: string;
  reason: 'in-flight' | 'succeeded';
  taskId?: string;
}
export interface VideoBatchStartResult {
  batchId: string;
  taskIds: string[];
  skipped: VideoBatchSkippedItem[];
}
export interface VideoBatchCancelResult {
  batchId: string;
  cancelledTaskIds: string[];
  /** Already POST-started/acknowledged tasks retain normal tracking. */
  retainedTaskIds: string[];
}
export interface VideoBatchContinuationPlan {
  /** Opaque, in-memory confirmation token; drafts and source checks stay in the engine. */
  id: string;
  batchId: string;
  projectId: string;
  label: string;
  items: Array<{ taskId: string; name: string; segmentIndex?: number; reason: 'failed' | 'cancelled' | 'preparing'; willRegenerate: boolean }>;
  completedTaskIds: string[];
  requiresAiTail: boolean;
  predecessorTaskId?: string;
}
export interface VideoBatchResumeResult {
  batchId: string;
  resumedTaskIds: string[];
  completedTaskIds: string[];
  waitingTaskIds: string[];
  issues: Array<{ taskId: string; message: string }>;
  continuation?: VideoBatchContinuationPlan;
}
export interface VideoGenerationController {
  start: (draft: VideoGenerationDraft) => Promise<string>;
  startBatch: (input: VideoBatchStartInput) => Promise<VideoBatchStartResult>;
  retryDownload: (taskId: string) => Promise<void>;
  recoverResult?: (taskId: string) => Promise<void>;
  selectResultVideo?: (taskId: string, assetId: string) => Promise<void>;
  resume: (taskId: string) => Promise<void>;
  cancel: (taskId: string) => Promise<void>;
  cancelBatch: (batchId: string) => Promise<VideoBatchCancelResult>;
  /** Stop observation of removed projects immediately; does not cancel server jobs. */
  reconcileProjectLibrary?: () => void;
  resumeBatch?: (batchId: string) => Promise<VideoBatchResumeResult>;
  confirmContinueBatch?: (planId: string, signal?: AbortSignal) => Promise<VideoBatchStartResult>;
  /** Stable external store: subscribe only in task cards / the task-list view. */
  runtimeStore?: VideoRuntimeStore;
  /** Compatibility snapshot getter. Reading this does not subscribe App. */
  readonly runtimeById: VideoRuntimeSnapshot;
}

export const defaultComfyVideoConfig: ComfyVideoConfig = {
  enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', promptPath: '/prompt', workflows: [], activeWorkflowId: null,
};
