import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { assetPreviewUrl } from '../media';
import { formatUserFacingError } from '../userFacingError';
import { getSafeErrorDiagnostics } from '../errorDiagnostics';
import { videoTaskDiagnosticEntries, videoTaskErrorOptions } from '../videoTaskErrorDiagnostics';
import { TaskErrorDetails } from './TaskErrorDetails';
import { activeChapter, chapterPlans, chapterWorkspace } from '../chapters';
import { ReferenceImageName } from './ReferenceImageName';
import { canRecoverRunningHubResult, runningHubRemoteSucceeded } from '../videoResultRecovery';
import { canRecoverComfyPreviewResult } from '../comfyuiVideo';
import { videoConfiguredApiState, videoDraftSource, videoSourceDraftPatch, videoParameterConnectionKey } from '../videoGenerationSource';
import { isRunningHubVideoWorkflowReady } from '../runningHubVideo';
import { availableVideoParameterKeys, changeVideoParameterText, isVideoOutputParameterKey, readVideoParameterText, videoOutputParameterSummary, videoParameterInputText, videoOutputParameterPresentation } from '../videoOutputParameters';
import { VideoOutputParameters } from './VideoOutputParameters';
import { VideoExecutionControls, type VideoExecutionPreferences } from './VideoExecutionControls';
import { useVideoTaskRuntime, type VideoRuntimeStore } from '../videoRuntimeStore';
import type { AppSettings, Project, ReferenceAsset, ReferenceRole, VideoGenerationTask } from '../types';
import type { ComfyVideoWorkflowPreset, VideoBatchStartInput, VideoGenerationController, VideoGenerationDraft, VideoGenerationRuntime, VideoGenerationStage, VideoImageReference, VideoPromptSource } from '../videoGenerationTypes';
import { findReusableVideoTask, frozenVideoReferenceAsset } from '../videoProvenance';
import { useCurrentVideoDraftImages, videoDraftReferenceAsset } from '../videoDirectorReferences';
import {
  addVideoDraftAssets, applyVideoPromptChoice, applyVideoReferenceRoleOverrides, draftFromVideoTask, emptyVideoDraft,
  formatVideoElapsed, isVideoDirectorImage, videoExecutionElapsedMs, videoPromptChoices,
  chapterIdForVideoLaunch, readVideoDirectorChapterDraft, videoDirectorChapterKey,
  type VideoDirectorLaunchRequest, type VideoDirectorChapterDraft, type VideoDirectorBatchDraft, videoImageRole,
} from '../videoDirectorDraft';
import {
  allVideoBatchChoiceKeys, buildVideoBatchRows, findVideoBatchDuplicate, toggleVideoBatchChoice,
  ungeneratedVideoBatchChoiceKeys, videoBatchTailReferences, videoBatchReferenceFingerprint, videoBatchRequestFingerprint, videoBatchConnectionIdentity, videoPromptChoiceKey, videoTaskRequestFingerprint,
  type VideoBatchChoiceCandidate, type VideoBatchRow, type VideoPromptChoiceKey,
} from '../videoBatch';
import { buildVideoBatchSubmissionItems, videoBatchCandidateWillSubmit, videoBatchConfirmationItemStatus, videoBatchConfirmationPendingCount } from '../videoBatchSelection';
import type { TailFrameTools, TailFrameSelectionContext } from './PreviousVideoTailDialog';
import {
  applyAutomaticVideoTailEntries, automaticVideoTailIssue, buildOneClickVideoTailEntries,
  applyVideoTailReference, getVideoTailReferencePlacements, getVideoTailCharacterPlacement, lookupPreviousSequenceSegment, lookupPreviousSegmentVideos,
  oneClickVideoTailReferencePlacement, resolveAutomaticVideoTailInput, videoTailSequenceFingerprint, videoTailTaskPresentation,
  type AutomaticVideoTailConfiguration, type VideoTailReferencePlacement,
} from '../videoTailReference';
import { prepareVideoTailCharacterDraft } from '../videoTailCharacters';
import { isVideoH3ReferenceInfo, prepareVideoH3ReferenceDraft, videoH3ReferenceCharacterIds, videoReferenceCharacterBindingWarning, videoReferenceCharacterOwners } from '../videoH3ReferenceBinding';
import { offsetVideoReferenceSlotRoles, videoReferenceSlotLabels, videoReferenceUsage } from '../videoReferenceUsage';
import { addVideoReference, removeVideoReference, videoReferenceSelection, videoReferenceSlotIndex, videoReferenceSlotSpan, type VideoReferenceSelection } from '../videoReferenceSlots';
import { videoSegmentCharacterHints, type VideoSegmentCharacterHint } from '../videoSegmentCharacters';
import '../videoDirector.css';

export type { VideoDirectorLaunchRequest } from '../videoDirectorDraft';
export interface VideoDirectorViewProps {
  project: Project;
  chapterId?: string;
  chapterDraft?: VideoDirectorChapterDraft;
  onChapterDraftChange?: (projectId: string, chapterId: string, draft: VideoDirectorChapterDraft) => void;
  settings: AppSettings;
  controller: VideoGenerationController;
  tailFrameTools?: TailFrameTools;
  launchRequest?: VideoDirectorLaunchRequest;
  onOpenSettings?: () => void;
  onOpenPrompt?: (storyboardId: string, source?: VideoPromptSource) => void;
  onOpenVideoAssets?: () => void;
  onOpenJobs?: () => void;
  onChangeExecution?: (patch: VideoExecutionPreferences) => void;
  onRepairIdentityBindings?: (storyboardId: string, language: 'zh' | 'en', characterIds?: string[]) => Promise<void>;
}

function VideoH3ReferenceNotices({ project, draft, warnings = [], onRepair, onRepairingChange, disabled = false }: {
  project: Project;
  draft: VideoGenerationDraft;
  warnings?: readonly string[];
  onRepair?: VideoDirectorViewProps['onRepairIdentityBindings'];
  onRepairingChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState('');
  const inFlight = useRef(false);
  const issues = [...new Set(warnings)].filter((message) => !isVideoH3ReferenceInfo(message));
  const information = [...new Set(warnings)].filter(isVideoH3ReferenceInfo);
  const storyboardId = draft.source?.storyboardId;
  const canRepair = Boolean(onRepair && storyboardId && !draft.reuseTaskId
    && project.storyboards.some((board) => board.id === storyboardId));
  const repair = async () => {
    if (!canRepair || !onRepair || !storyboardId || inFlight.current) return;
    inFlight.current = true; setRepairing(true); setRepairError(''); onRepairingChange?.(true);
    try {
      const characterIds = videoH3ReferenceCharacterIds(project, draft);
      await onRepair(storyboardId, draft.source?.language === 'en' ? 'en' : 'zh', characterIds.length ? characterIds : undefined);
    } catch (error) { setRepairError(formatUserFacingError(error)); }
    finally { inFlight.current = false; setRepairing(false); onRepairingChange?.(false); }
  };
  if (!issues.length && !information.length && !canRepair && !repairError) return null;
  return <div className="vd-h3-reference-notices" aria-label="人物图片绑定状态">
    <div className="vd-h3-reference-actions">
      {issues.length > 0 && <details className="vd-h3-reference-issues"><summary>{issues.length} 项图片绑定提示 · 展开查看</summary><ul>{issues.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
      {canRepair && <button type="button" className="btn small" disabled={disabled || repairing} onClick={() => { void repair(); }} title="修复源稿的人物图片绑定；修复中文时会同步已有的有效英文，保留剧情、对白和镜头，不提交视频">{repairing ? '正在修复人物图片绑定…' : '修复人物图片绑定'}</button>}
    </div>
    {information.length > 0 && <details className="vd-h3-reference-info"><summary>RunningHub 图片槽映射说明</summary>{information.map((message) => <p key={message}>{message}</p>)}</details>}
    {repairError && <p className="vd-error" role="alert">{repairError}</p>}
  </div>;
}

const imageRoles: Array<[ReferenceRole, string]> = [
  ['general', '通用参考'], ['character', '人物参考'], ['subject', '主体参考'], ['scene', '场景参考'],
  ['composition', '构图参考'], ['first-frame', '首帧'], ['last-frame', '尾帧'], ['style', '风格参考'],
  ['prop', '道具参考'], ['camera', '摄影参考'], ['motion', '动作参考'], ['clay-render', 'Clay Render'], ['creative', '创意参考'],
];
const imageRoleLabel = (role: ReferenceRole) => imageRoles.find(([key]) => key === role)?.[1] || role;
type ReferenceUsageContext = Parameters<typeof videoReferenceUsage>[1];
/** A library asset's category is provenance, not a submission constraint.  A
 * segment may deliberately use a scene/composition image as a character,
 * first-frame, or other physical slot.  Surface that difference as context
 * only; the selected per-segment role remains authoritative and generation is
 * never blocked by this notice. */
const assetRoleMismatchNotice = (asset: ReferenceAsset | undefined, usage: ReferenceRole | undefined): string => {
  if (!asset || !usage) return '';
  const original = videoImageRole(asset);
  if (!original || original === 'general' || original === 'unknown' || original === usage) return '';
  return `提示：原素材分类为${imageRoleLabel(original)}，当前分段用途为${imageRoleLabel(usage)}；仅提示，不阻止生成。`;
};
const mappedBoundaryRole = (context: ReferenceUsageContext, index: number): ReferenceRole | undefined => {
  const roles = context.backend === 'comfyui'
    ? context.workflow?.mapping.images.map((slot) => slot.role)
    : context.api?.provider === 'runninghub' ? context.api.runningHubImageRoles : undefined;
  const role = roles?.[index];
  return role && role !== 'general' && role !== 'unknown' ? role : undefined;
};
const boundaryUsageSummary = (context: ReferenceUsageContext): string => {
  const roles = context.backend === 'comfyui' ? context.workflow?.mapping.images.map((slot) => slot.role)
    : context.api?.provider === 'runninghub' ? context.api.runningHubImageRoles : undefined;
  return roles?.flatMap((role, index) => role === 'first-frame' || role === 'last-frame'
    ? [`图片槽 ${index + 1} 用作${imageRoleLabel(role)}`] : []).join('；') || '';
};
const stageLabels: Record<VideoGenerationStage, string> = {
  preparing: '准备素材', submitting: '正在提交', queued: '排队中', running: '生成中', reconnecting: '连接中断，恢复状态中',
  downloading: '生成成功，正在保存', succeeded: '已完成', failed: '生成失败', 'submission-unknown': '提交结果待确认', stopped: '已停止本地追踪',
};
const draftCache = new Map<string, VideoDirectorChapterDraft>();
const consumedLaunchIds = new Set<string>();

// General request deduplication deliberately prefers content checksums. A
// selected local tail additionally pins its source location for stale UI work.
const selectedTailFingerprint = (reference: VideoImageReference | undefined, assets: readonly ReferenceAsset[]): string => {
  const asset = reference && assets.find((entry) => entry.id === reference.assetId);
  return JSON.stringify([videoBatchReferenceFingerprint({ references: reference ? [reference] : [] }, assets), asset?.relativePath, asset?.url]);
};

function VideoPickerDialog({ title, onClose, children, className = '', closeDisabled = false, headerContent }: { title: string; onClose: () => void; children: ReactNode; className?: string; closeDisabled?: boolean; headerContent?: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('input,button,select,textarea,[tabindex="0"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      const openDialogs = document.querySelectorAll('.vd-modal');
      if (openDialogs[openDialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="vd-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}><div ref={dialogRef} className={`vd-modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="vd-modal-header"><h2>{title}</h2>{headerContent}<button type="button" className="btn small" disabled={closeDisabled} onClick={onClose}>关闭</button></div>{children}</div></div>;
}

export interface VideoTaskCardProps {
  task: VideoGenerationTask;
  assets: ReferenceAsset[];
  runtime?: VideoGenerationRuntime;
  runtimeStore?: VideoRuntimeStore;
  /** Current credentials are redaction inputs only; never included in diagnostics. */
  knownSecrets?: readonly string[];
  onRetryDownload?: (id: string) => void | Promise<unknown>;
  onRecoverResult?: (id: string) => void | Promise<unknown>;
  onSelectResultVideo?: (id: string, assetId: string) => void | Promise<unknown>;
  onResume?: (id: string) => void | Promise<unknown>;
  onCancel?: (id: string) => void | Promise<unknown>;
  onReuse?: (task: VideoGenerationTask) => void;
  onOpenPrompt?: (storyboardId: string, source?: VideoPromptSource) => void;
}

export function VideoTaskCard({ task, assets, runtime: fallbackRuntime, runtimeStore, knownSecrets, onRetryDownload, onRecoverResult, onSelectResultVideo, onResume, onCancel, onReuse, onOpenPrompt }: VideoTaskCardProps) {
  const runtime = useVideoTaskRuntime(task.id, runtimeStore, fallbackRuntime);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState<unknown>(undefined);
  const state = runtime ? { ...task.videoJob, ...runtime } : task.videoJob;
  const stage = state?.stage || (task.status === 'succeeded' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'queued');
  const batchQueueLabel = ['waiting', 'ready'].includes(task.videoJob?.batchQueueState || '')
    ? '等待批量提交'
    : task.videoJob?.batchQueueState === 'active' ? '正在批量提交'
      : task.videoJob?.batchQueueState === 'cancelled' ? '已停止后续提交' : undefined;
  const cancelledBeforePost = (task.videoJob?.batchQueueState === 'cancelled' || task.videoJob?.tailPreparation?.phase === 'cancelled')
    && task.videoJob?.preparation?.phase === 'preparing'
    && !task.remoteTaskId && task.status !== 'unknown';
  const tailPresentation = videoTailTaskPresentation(task);
  const tailSelection = task.videoJob?.tailPreparation?.selection;
  const automaticallyRecovering = stage === 'submission-unknown' && task.videoJob?.snapshot.connection.backend === 'comfyui' && !state?.trackingStopped;
  const isTerminal = ['succeeded', 'failed', 'stopped'].includes(stage) || (stage === 'submission-unknown' && !automaticallyRecovering);
  const executionElapsed = videoExecutionElapsedMs(state, now, isTerminal ? task.updatedAt : undefined);
  const shouldTickExecution = executionElapsed !== undefined && !isTerminal && state?.generatedAt === undefined && state?.completedAt === undefined;
  const snapshot = task.videoJob?.snapshot;
  const cloudSucceeded = runningHubRemoteSucceeded(task);
  const resultSelectionRequired = Boolean(task.videoJob?.resultSelectionRequired);
  const resultAssetIds = Array.isArray(task.videoJob?.resultAssetIds) ? task.videoJob.resultAssetIds : [];
  const resultChoices = assets.filter((item) => resultAssetIds.includes(item.id) && item.sourceVideoTaskId === task.id && item.mediaType === 'video');
  const canRecoverResult = Boolean(onRecoverResult && canRecoverRunningHubResult(task)
    && (isTerminal || state?.downloadError || state?.trackingStopped));
  const legacyCloudResultFailure = cloudSucceeded && stage === 'failed' && !task.resultAssetId;
  const legacyComfyPreviewFailure = stage === 'failed' && canRecoverComfyPreviewResult(task);
  const chainMember = Boolean(snapshot?.batchCompletionOrder || snapshot?.previousTail || snapshot?.batchPredecessorTaskId);
  const continuePreparation = chainMember && stage === 'failed' && task.videoJob?.preparation?.phase === 'preparing'
    && !task.remoteTaskId && !task.resultUrl && !task.resultAssetId && task.status !== 'unknown' && !cancelledBeforePost && !state?.cancellationPending;
  const failedChainSubmission = chainMember && stage === 'failed' && task.videoJob?.preparation?.phase !== 'preparing'
    && task.status !== 'unknown' && !state?.downloadError && !cloudSucceeded && !legacyComfyPreviewFailure;
  const asset = assets.find((item) => item.id === task.resultAssetId);
  // The generation-task page is a status/queue surface, not a media player.
  // Prefer an explicitly linked thumbnail/boundary frame when available; for
  // older generated videos fall back to the first frozen reference image. This
  // keeps the card useful without mounting a video element or starting media
  // playback while the task list is being browsed.
  const thumbnailAsset = [asset?.thumbnailAssetId, asset?.firstFrameAssetId]
    .map((id) => id ? assets.find((item) => item.id === id) : undefined)
    .find((candidate): candidate is ReferenceAsset => Boolean(candidate && assetPreviewUrl(candidate)));
  const frozenReference = snapshot?.images
    .map((reference) => frozenVideoReferenceAsset(reference))
    .find((candidate) => Boolean(assetPreviewUrl(candidate)));
  const thumbnailUrl = thumbnailAsset
    ? assetPreviewUrl(thumbnailAsset)
    : frozenReference
      ? assetPreviewUrl(frozenReference)
      : '';
  const thumbnailAlt = thumbnailAsset?.name || frozenReference?.name || `${snapshot?.draft.name || '视频'}静态缩略图`;
  useEffect(() => {
    if (!shouldTickExecution) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shouldTickExecution]);
  const act = async (name: string, action?: (id: string) => void | Promise<unknown>) => {
    if (!action) return;
    setBusy(name); setActionError(undefined);
    try { await action(task.id); } catch (cause) { setActionError(cause); } finally { setBusy(''); }
  };
  const downloadError = state?.downloadError;
  const diagnosticOptions = videoTaskErrorOptions(task, knownSecrets);
  const diagnostics = videoTaskDiagnosticEntries({
    task, failed: stage === 'failed', message: state?.message, downloadError, actionError,
    tailFailureMessage: tailPresentation.canRetry ? tailPresentation.message : undefined,
    suppressGenerationFailure: legacyCloudResultFailure || legacyComfyPreviewFailure,
  }, diagnosticOptions);
  const stateMessageIsError = stage === 'failed' || Boolean(state?.message && [task.error, downloadError, tailPresentation.canRetry ? tailPresentation.message : undefined]
    .some((error) => error && getSafeErrorDiagnostics(error, diagnosticOptions).message === getSafeErrorDiagnostics(state.message, diagnosticOptions).message));
  const remoteUnconfirmed = Boolean(state?.trackingStopped && task.remoteTaskId && !cloudSucceeded
    && task.status !== 'failed' && task.status !== 'succeeded' && !task.resultAssetId);
  const percent = typeof state?.progress === 'number' && Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : undefined;
  return <article className={`card vd-task-card vd-task-${stage}`} data-video-task-id={task.id}>
    <div className="card-title">
      <div className="vd-task-heading">
        <div className="vd-task-thumbnail" aria-label={thumbnailUrl ? `${thumbnailAlt}，静态缩略图` : '暂无视频缩略图'}>
          {thumbnailUrl
            ? <img src={thumbnailUrl} alt={thumbnailAlt} loading="lazy" />
            : <span aria-hidden="true">视频</span>}
        </div>
        <h3>{snapshot?.draft.name || `视频 ${task.remoteTaskId || task.id}`}</h3>
      </div>
      <span className={`vd-status ${stage === 'failed' || downloadError || tailPresentation.canRetry ? 'vd-status-error' : ''}`}>{downloadError ? '生成成功，保存失败' : resultSelectionRequired ? '已保存，待选择成片' : legacyCloudResultFailure ? '云端已成功，待取回成片' : legacyComfyPreviewFailure ? '视频已生成，待接收' : remoteUnconfirmed ? '已停止追踪，远端结果待确认' : task.status === 'unknown' ? '提交结果待确认' : tailPresentation.statusLabel || (continuePreparation ? '准备失败，尚未提交' : stage === 'failed' ? stageLabels[stage] : batchQueueLabel || stageLabels[stage])}</span>
    </div>
    <div className="vd-task-meta"><span>{snapshot?.connection.backend === 'comfyui' ? `ComfyUI · ${snapshot.connection.workflow?.name || '视频工作流'}` : `视频 API · ${snapshot?.connection.api?.model || task.targetId}`}</span>{task.batchId && <span>批次第 {task.batchIndex}/{task.batchTotal} 项</span>}<span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span><span>{executionElapsed === undefined ? (isTerminal ? '未记录实际执行耗时' : '尚未开始执行（排队不计时）') : `执行耗时 ${formatVideoElapsed(executionElapsed)}`}</span></div>
    {legacyCloudResultFailure ? <p className="vd-task-message" role="status">云端返回成功；旧版本未能接收结果文件。可按原任务重新获取视频或 ZIP，不会重新生成。</p> : legacyComfyPreviewFailure ? <p className="vd-task-message" role="status">ComfyUI 已完成；旧版误把动图预览当作最终视频。可恢复查询原任务，接收已有成片，不会重新生成。</p> : state?.message && !stateMessageIsError && <p className="vd-task-message" role="status">{getSafeErrorDiagnostics(state.message, diagnosticOptions).message}</p>}
    {tailPresentation.message && !tailPresentation.canRetry && tailPresentation.message !== state?.message && <p className="vd-task-message" role="status">{getSafeErrorDiagnostics(tailPresentation.message, diagnosticOptions).message}</p>}
    {remoteUnconfirmed && <p className="vd-notice">这里只停止了本地追踪，远端任务可能仍在运行并占用生成名额。请恢复查询确认结果，不要重复提交。</p>}
    {tailSelection?.status === 'completed' && <div className="vd-task-frame-selection" aria-label="衔接帧选择记录"><strong>{tailSelection.source === 'ai' ? 'AI 辅助选帧' : '原尾帧回退'}{typeof tailSelection.selectedTimeSec === 'number' && Number.isFinite(tailSelection.selectedTimeSec) ? ` · ${tailSelection.selectedTimeSec.toFixed(3)} 秒` : ''}{tailSelection.candidateCount ? ` · ${tailSelection.candidateCount} 张候选` : ''}</strong>{tailSelection.reason && <p>{tailSelection.reason}</p>}{tailSelection.warning && <p className="vd-task-frame-warning">{tailSelection.warning}</p>}{typeof tailSelection.offsetFromEndSec === 'number' && tailSelection.offsetFromEndSec > 0 && <p className="vd-task-frame-warning">采用比原尾帧早 {tailSelection.offsetFromEndSec.toFixed(3)} 秒的画面，可能动作回退；原视频未自动裁剪。</p>}</div>}
    {tailPresentation.canRetry && <p className="vd-notice">本段尚未提交。请按提示处理上段生成、保存或本地抽帧问题，再重试衔接；此操作不会重新生成上段。{snapshot?.previousTail?.requireAiSelection && '重新选帧遇到可恢复错误时最多自动重试3次，含首次最多4次视觉API调用，可能收费；取消或结果不明时停止。'}</p>}
    {continuePreparation && !tailPresentation.canRetry && <p className="vd-notice">本段尚未提交，可继续准备这个原任务。后续段仍等待本段，无需另建任务；准备完成后才首次提交生成。</p>}
    {failedChainSubmission && <p className="vd-notice">本段已提交但生成失败，原依赖链不能自动改接新任务。请先取消仍等待的后续段，再重新选择失败段及所需后续段，核对参考图并确认建立新批次。已完成的视频不会删除。</p>}
    {typeof state?.step === 'number' && state.totalSteps ? <div className="vd-progress"><span>{state.nodeId ? `节点 ${state.nodeId} · ` : ''}当前采样 {state.step}/{state.totalSteps} 步</span><progress value={state.step} max={state.totalSteps} /><small>这是当前节点进度，后续仍可能解码、处理音频及合成视频。</small></div> : percent !== undefined ? <div className="vd-progress"><span>后端进度 {Math.round(percent)}%</span><progress value={percent} max={100} /></div> : null}
    {diagnostics.map((entry) => <div key={entry.key} className="vd-error" role={entry.key === 'action' ? 'alert' : undefined}>
      <strong>{entry.label}</strong>
      <TaskErrorDetails error={entry.error} summaryError={entry.summaryError} knownSecrets={diagnosticOptions.knownSecrets} sensitiveTexts={diagnosticOptions.sensitiveTexts} />
      {entry.key === 'download' && <p>仅重试获取和保存，不会重新生成或重复扣费。</p>}
    </div>)}
    {resultSelectionRequired && <div className="vd-result-selection" aria-label="选择压缩包内的成片">
      <p>压缩包内有多个视频，已分别保存到资产库。请选择本任务使用哪一个；自动尾帧衔接会等待此选择，不会随意使用第一个视频。</p>
      {resultChoices.map((choice) => <div className="vd-result-choice" key={choice.id}><span title={choice.fileName}>{choice.name}<small>{choice.fileName} · {(Number(choice.sizeBytes || 0) / 1024 / 1024).toFixed(1)} MB</small></span><button type="button" className="btn small" disabled={Boolean(busy) || !onSelectResultVideo || choice.missing} onClick={() => { void act(`select-${choice.id}`, (id) => onSelectResultVideo?.(id, choice.id)); }}>用作本任务成片</button></div>)}
      {!resultChoices.length && <p className="vd-error">成片记录尚未完整恢复，请重新获取原任务结果。</p>}
    </div>}
    <div className="vd-toolbar">
      {canRecoverResult && <button type="button" className="btn small primary" disabled={Boolean(busy) || stage === 'downloading'} onClick={() => { void act('recover-result', onRecoverResult); }}>{busy === 'recover-result' ? '正在获取原任务结果…' : '重新获取成片（不重新生成）'}</button>}
      {onReuse && snapshot && !remoteUnconfirmed && task.status !== 'unknown' && !resultSelectionRequired && !legacyComfyPreviewFailure && !task.videoJob?.legacyMetadataIncomplete && (!chainMember || stage === 'succeeded' && !downloadError) && (!snapshot.previousTail || task.videoJob?.tailPreparation?.phase === 'ready') && <button type="button" className="btn small" title={canRecoverResult ? '这会准备一个新的生成任务，可能再次收费；取回云端成片请使用左侧重新获取按钮。' : undefined} onClick={() => onReuse(task)}>载入相同设置再次生成</button>}
      {onOpenPrompt && snapshot?.draft.source?.storyboardId && <button type="button" className="btn small" onClick={() => onOpenPrompt(snapshot.draft.source!.storyboardId!, snapshot.draft.source)}>查看来源提示词</button>}
      {!canRecoverResult && !resultSelectionRequired && onRetryDownload && (downloadError || !task.resultAssetId && task.resultUrl) && <button type="button" className="btn small" disabled={Boolean(busy) || stage === 'downloading'} onClick={() => { void act('download', onRetryDownload); }}>{busy === 'download' ? '保存中…' : '仅重试保存'}</button>}
      {onResume && !cancelledBeforePost && !failedChainSubmission && (legacyComfyPreviewFailure || tailPresentation.canRetry || continuePreparation || task.status === 'unknown' || state?.trackingStopped || ['reconnecting', 'submission-unknown', 'stopped'].includes(stage)) && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { void act('resume', onResume); }}>{busy === 'resume' ? '恢复中…' : tailPresentation.canRetry ? snapshot?.previousTail?.requireAiSelection ? '重试 AI 选帧（可能收费）' : '重试尾帧衔接' : continuePreparation ? '继续准备原任务' : '恢复查询原任务'}</button>}
      {onCancel && (!isTerminal || task.status === 'unknown' || tailPresentation.canCancel || continuePreparation) && !cancelledBeforePost && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { void act('cancel', onCancel); }}>{busy === 'cancel' ? '处理中…' : tailPresentation.canCancel || continuePreparation ? '取消尚未提交任务' : task.status === 'unknown' ? '停止本地追踪' : '停止 / 取消本任务'}</button>}
      {asset?.relativePath && <button type="button" className="btn small" onClick={() => { void window.lianhuaDesktop?.revealAsset?.(asset.relativePath!).catch((cause: unknown) => setActionError(cause)); }}>打开文件位置</button>}
    </div>
    {snapshot && <details className="vd-details"><summary>查看本次生成快照</summary>{task.videoJob?.legacyMetadataIncomplete && <p className="vd-notice">旧任务历史参数不完整，仅恢复查询 / 下载，不能保证按原设置重新生成。</p>}<div className="vd-task-meta"><span>{snapshot.draft.source?.label || '手动提示词'}</span><span>{snapshot.draft.source?.language === 'en' ? '已有英文描述，未翻译对白' : '中文 / 手动提示词'}</span><span>参考图片 {snapshot.images.length} 张</span></div><pre className="vd-prompt-preview">{snapshot.draft.prompt}</pre><div className="vd-task-meta">{snapshot.images.map((reference, index) => <span key={`${reference.assetId}-${index}`}>{index + 1}. {reference.name}（{imageRoleLabel(reference.role)}）</span>)}</div><pre className="vd-code">{JSON.stringify(snapshot.draft.parameters, null, 2)}</pre></details>}
  </article>;
}

const cloneVideoReferences = (references: readonly VideoImageReference[]): VideoImageReference[] => structuredClone([...references]);

function VideoReferenceVacancies({ selection, usageContext, offset = 0 }: { selection: VideoReferenceSelection; usageContext: ReferenceUsageContext; offset?: number }) {
  const occupied = new Set(selection.references.map(videoReferenceSlotIndex));
  const vacancies = (selection.referenceSlotRoles || []).flatMap((role, slotIndex) => !occupied.has(slotIndex) && role ? [{ assetId: '__vacancy__', role, slotIndex }] : []);
  if (!vacancies.length) return null;
  const labels = videoReferenceSlotLabels(vacancies, usageContext, offset, selection.referenceSlotRoles);
  return <p className="vd-reference-usage-hint" role="status">空位：{labels.join('、')}。再选图片会优先补回最前面的空位，继承该用途；其他图片不移动。</p>;
}

/** Per-segment physical slot editor.  It intentionally renders empty slots too:
 * a role belongs to a slot, not to the currently selected asset. */
function VideoReferenceSlotUsageEditor({
  selection, images, slotCount, slotOffset, usageContext, workflow, onRoleChange, onRemove, onPreview, segmentLabel, project, onCharacterChange,
}: {
  selection: VideoReferenceSelection;
  images: ReferenceAsset[];
  slotCount: number;
  slotOffset: number;
  usageContext: ReferenceUsageContext;
  workflow?: ComfyVideoWorkflowPreset;
  onRoleChange: (physicalSlot: number, role: ReferenceRole) => void;
  onRemove: (assetId: string, role?: ReferenceRole) => void;
  onPreview: (asset: ReferenceAsset) => void;
  segmentLabel?: string;
  project?: Project;
  onCharacterChange?: (assetId: string, characterIds: string[] | undefined) => void;
}) {
  const scopedContext = { ...usageContext, slotRoles: offsetVideoReferenceSlotRoles(selection.referenceSlotRoles, slotOffset) };
  const effective = videoReferenceUsage(selection.references, scopedContext, slotOffset);
  const labels = videoReferenceSlotLabels(selection.references, scopedContext, slotOffset, selection.referenceSlotRoles);
  const oldContext = { ...usageContext, slotRoles: undefined };
  return <div className="vd-slot-usage-editor" aria-label={`${segmentLabel || '本段'}图片槽位用途`}>
    <p className="field-hint">按物理槽位设置本段用途；空槽也可先设置用途。取消图片只释放该槽，不会重新排列其它槽。</p>
    <ol className="vd-reference-list vd-slot-usage-list">
      {Array.from({ length: slotCount }, (_, physicalSlot) => {
        if (physicalSlot < slotOffset) return <li className="vd-reference-row vd-slot-reserved" key={`reserved-${physicalSlot}`}><span className="vd-reference-order">{physicalSlot + 1}</span><div className="vd-reference-info"><strong>系统衔接槽</strong><small>由本地真实末帧占用，当前选择器不修改</small></div></li>;
        const relativeSlot = physicalSlot - slotOffset;
        const index = selection.references.findIndex((reference, position) => videoReferenceSlotIndex(reference, position) === relativeSlot);
        const reference = index >= 0 ? selection.references[index] : undefined;
        const asset = reference && images.find((image) => image.id === reference.assetId);
        const role = reference?.role || selection.referenceSlotRoles?.[relativeSlot] || 'general';
        const oldRole = mappedBoundaryRole(oldContext, physicalSlot);
        const slot = workflow?.mapping.images[physicalSlot];
        const effectiveRole = (index >= 0 ? effective[index]?.role : undefined) || role;
        const assetRoleWarning = assetRoleMismatchNotice(asset, effectiveRole);
        const characterBindingWarning = reference && videoReferenceCharacterBindingWarning(reference);
        const characterOwners = reference && asset && project ? videoReferenceCharacterOwners(project, asset, reference) : [];
        const characterIds = characterOwners.map((character) => character.id);
        return <li className={`vd-reference-row vd-slot-usage-row${reference ? '' : ' vd-slot-empty'}`} key={`slot-${physicalSlot}`}>
          <span className="vd-reference-order">{physicalSlot + 1}</span>
          {asset ? <button type="button" className="vd-reference-thumb" onClick={() => onPreview(asset)} aria-label={`预览 ${asset.name}`}><img src={assetPreviewUrl(asset)} alt={asset.name} /></button> : <span className="vd-reference-thumb vd-slot-placeholder">未选图</span>}
          <div className="vd-reference-info"><strong>{reference ? <ReferenceImageName name={asset?.name || reference.assetId} /> : `图片槽 ${physicalSlot + 1}（未选择）`}</strong>{reference && <small className="vd-image-slot-badge">{labels[index]}</small>}
            <label className="field"><span>本段用途</span><select aria-label={`${segmentLabel || '本段'}图片槽 ${physicalSlot + 1} 用途`} value={role} onChange={(event) => onRoleChange(physicalSlot, event.target.value as ReferenceRole)}>{imageRoles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {characterBindingWarning && <small className="vd-reference-usage-warning">{characterBindingWarning}</small>}
            {reference && asset && project && onCharacterChange && <details className="vd-details"><summary>对应人物／形态：{characterOwners.map((character) => character.name).join('、') || '未绑定（不阻止生成）'}</summary><p className="field-hint">只影响本段图片身份引用；合照可选多人，同一人物可对应多张图。不改台词、不调用 AI。</p>{project.characters.map((character) => {
              return <label className="check-row" key={character.id}><input type="checkbox" checked={characterIds.includes(character.id)} onChange={(event) => onCharacterChange(reference.assetId, event.target.checked ? [...characterIds, character.id] : characterIds.filter((id) => id !== character.id))} />{character.name}</label>;
            })}<button type="button" className="btn small ghost" onClick={() => onCharacterChange(reference.assetId, undefined)}>使用资产已有绑定</button></details>}
            {oldRole && oldRole !== effectiveRole && <small className="vd-reference-usage-warning">提示：旧工作流标为{imageRoleLabel(oldRole)}，本段选择为{imageRoleLabel(effectiveRole)}；仅提示，不阻止生成。</small>}
            {assetRoleWarning && <small className="vd-reference-usage-warning">{assetRoleWarning}</small>}
            {slot && <small>工作流槽 {physicalSlot + 1}：{slot.nodeId}.{slot.inputName}</small>}
          </div>
          {reference && <div className="vd-reference-actions"><button type="button" className="btn small" aria-label={`移除图片槽 ${physicalSlot + 1} 的图片`} onClick={() => onRemove(reference.assetId, effectiveRole)}>移除</button></div>}
        </li>;
      })}
      {!slotCount && <li className="vd-empty">当前连接未声明图片槽；选择图片后会按槽位显示并可设置用途。</li>}
    </ol>
  </div>;
}

/** Keep selection state in the caller: switching panels only changes visibility,
 * never the physical slots, roles, search filters, or selected images. */
function VideoReferencePickerPanels({ images, slots }: { images: ReactNode; slots: ReactNode }) {
  const id = useId();
  const [activePanel, setActivePanel] = useState<'images' | 'slots'>('images');
  const panels = [['images', '图片选择'], ['slots', '槽位用途']] as const;
  return <>
    <div className="vd-mode-tabs vd-reference-picker-tabs" role="tablist" aria-label="本段参考图设置">
      {panels.map(([panel, label], index) => <button key={panel} type="button"
        className={`btn small${activePanel === panel ? ' primary' : ''}`}
        role="tab" id={`${id}-${panel}-tab`} aria-controls={`${id}-${panel}-panel`}
        aria-selected={activePanel === panel} tabIndex={activePanel === panel ? 0 : -1}
        onClick={() => setActivePanel(panel)}
        onKeyDown={(event) => {
          const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1
            : event.key === 'ArrowRight' ? (index + 1) % panels.length
              : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length : undefined;
          if (nextIndex === undefined) return;
          event.preventDefault();
          setActivePanel(panels[nextIndex][0]);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
        }}>{label}</button>)}
    </div>
    {panels.map(([panel]) => <section key={panel} role="tabpanel" className="vd-reference-picker-panel"
      id={`${id}-${panel}-panel`} aria-labelledby={`${id}-${panel}-tab`} hidden={activePanel !== panel}>
      {panel === 'images' ? images : slots}
    </section>)}
  </>;
}

function VideoSegmentCharacterHint({ characters }: { characters: readonly VideoSegmentCharacterHint[] }) {
  return <div className="vd-segment-character-hint" role="note" aria-label="本段涉及人物">
    <span className="vd-segment-character-hint-title">本段涉及人物（仅供选图参考）</span>
    {characters.length ? <div className="vd-segment-character-hint-list">
      {characters.map((character) => <span className="vd-segment-character-chip" key={character.id} title={character.referenceImageCount ? `${character.name}：已绑定 ${character.referenceImageCount} 张人物参考图` : `${character.name}：暂无明确绑定人物参考图`}>
        {character.name}{character.referenceImageCount ? ` · ${character.referenceImageCount}张图` : ''}
      </span>)}
    </div> : <span className="vd-segment-character-hint-empty">未识别到明确人物，可继续手动选择</span>}
    <span className="vd-segment-character-hint-note">不必选满，不影响视频生成</span>
  </div>;
}

function VideoBatchImagePicker({ row, references, referenceSlotRoles, images, workflow, usageContext, slotOffset = 0, onApply, onClose, project }: {
  row: VideoBatchRow;
  references: readonly VideoImageReference[];
  referenceSlotRoles?: ReferenceRole[];
  images: ReferenceAsset[];
  workflow?: ComfyVideoWorkflowPreset;
  usageContext: ReferenceUsageContext;
  slotOffset?: number;
  onApply: (references: VideoImageReference[], referenceSlotRoles?: ReferenceRole[]) => string | void | Promise<string | void>;
  onClose: () => void;
  project: Project;
}) {
  const [selection, setSelection] = useState(() => videoReferenceSelection(references, referenceSlotRoles));
  const selected = selection.references;
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<ReferenceAsset>();
  const [applyIssue, setApplyIssue] = useState('');
  const [applying, setApplying] = useState(false);
  const boundarySummary = boundaryUsageSummary(usageContext);
  const runningHubSlots = usageContext.backend === 'api' && usageContext.api?.provider === 'runninghub'
    ? usageContext.api.runningHubImageRoles?.length : undefined;
  const configuredSlotCount = workflow?.mapping.images.length ?? runningHubSlots ?? 0;
  const rememberedSlotCount = (selection.referenceSlotRoles || []).length + slotOffset;
  const selectedSlotCount = videoReferenceSlotSpan(selected) + slotOffset;
  const slotCount = Math.max(configuredSlotCount, rememberedSlotCount, selectedSlotCount);
  const pickerUsageContext = { ...usageContext, slotRoles: offsetVideoReferenceSlotRoles(selection.referenceSlotRoles, slotOffset) };
  const effectiveReferences = videoReferenceUsage(selected, pickerUsageContext, slotOffset);
  const slotLabels = videoReferenceSlotLabels(selected, pickerUsageContext, slotOffset, selection.referenceSlotRoles);
  const plan = project.sequencePlans.find((candidate) => candidate.id === row.sequencePlanId);
  const segment = plan?.segments.find((candidate) => candidate.id === row.segmentId);
  const storyboard = row.storyboardId ? project.storyboards.find((candidate) => candidate.id === row.storyboardId) : undefined;
  const characterHints = useMemo(() => segment ? videoSegmentCharacterHints(project, plan, segment, storyboard).characters : [], [project, plan, segment, storyboard]);
  const changeSlotRole = (physicalSlot: number, role: ReferenceRole) => setSelection((current) => {
    const relativeSlot = physicalSlot - slotOffset;
    if (relativeSlot < 0) return current;
    const next = videoReferenceSelection(current.references, current.referenceSlotRoles);
    const roles = [...(next.referenceSlotRoles || [])];
    roles[relativeSlot] = role;
    const references = next.references.map((reference, index) => (
      videoReferenceSlotIndex(reference, index) === relativeSlot ? { ...reference, role } : reference
    ));
    return { references, referenceSlotRoles: roles };
  });
  const visible = images.filter((asset) => `${asset.name} ${asset.fileName || ''} ${asset.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')));
  return <>
    <VideoPickerDialog title={`第 ${row.segmentIndex} 段 · 选择参考图`} className="vd-batch-image-dialog" onClose={onClose} headerContent={<VideoSegmentCharacterHint characters={characterHints} />}>
      <VideoReferencePickerPanels images={<>
      <div className="vd-batch-image-toolbar">
        <label className="field vd-grow"><span>搜索图片资产</span><input aria-label="批量参考图搜索" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、文件名、标签" /></label>
      </div>
      <div className="vd-batch-dialog-body">
      {slotOffset > 0 ? <p className="vd-reference-usage-hint">槽1由本地真实末帧占用；槽2起默认选择人物参考图，也可自由选择场景、道具或其它参考图，并在“图片槽位用途”栏修改用途。图片类型不匹配仅提示，不阻止生成。保存后保留组合模式，不重排其它图片，不重新生成视频提示词，不调用文本或视觉AI。</p> : boundarySummary && <p className="vd-reference-usage-hint">{boundarySummary}。这些槽可选任意可用图片，不要求素材原本标为首帧或尾帧；仅改变本次用途，不改原素材分类。</p>}
      {runningHubSlots !== undefined && <p className="vd-reference-usage-hint">最多 {runningHubSlots} 张图片，各段可按需要选择不同数量，不必选满。未用槽明确清空，不补图、不沿用工作流旧图；是否支持空槽由云端工作流决定。</p>}
      <VideoReferenceVacancies selection={selection} usageContext={pickerUsageContext} offset={slotOffset} />
        <div className="vd-image-picker-grid vd-batch-image-grid">
          {visible.map((asset) => {
            const index = selected.findIndex((reference) => reference.assetId === asset.id);
            return <div key={asset.id} className={`vd-image-choice ${index >= 0 ? 'selected' : ''}`}>
              <button type="button" className="vd-image-pick" aria-pressed={index >= 0} aria-label={`${index >= 0 ? '取消选择' : '选择'}图片 ${asset.name}`} disabled={Boolean(asset.missing && index < 0)} onClick={() => setSelection((current) => index >= 0 ? removeVideoReference(current, asset.id, effectiveReferences[index]?.role) : addVideoReference(current, { assetId: asset.id, role: videoImageRole(asset) }))}>
                {assetPreviewUrl(asset) ? <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /> : <span>无预览</span>}
                <ReferenceImageName name={asset.name} /><span>{index >= 0 ? `已选 · 图片槽 ${videoReferenceSlotIndex(selected[index], index) + slotOffset + 1}` : asset.missing ? '原文件缺失' : `${asset.width || '?'} × ${asset.height || '?'}`}</span>
                {index >= 0 && <span className="vd-image-slot-badge" aria-label={`图片 ${asset.name} 占用槽位`}>{slotLabels[index]}</span>}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setPreview(asset)}>放大预览</button>
            </div>;
          })}
          {!visible.length && <div className="vd-empty">没有匹配的图片，可先在图片资产库导入。</div>}
        </div>
      </div>
      </>} slots={<div className="vd-batch-dialog-body">
        <VideoReferenceSlotUsageEditor selection={selection} images={images} slotCount={slotCount} slotOffset={slotOffset} usageContext={usageContext} workflow={workflow} segmentLabel={`第 ${row.segmentIndex} 段`} project={project} onCharacterChange={(assetId, characterIds) => setSelection((current) => ({ ...current, references: current.references.map((reference) => reference.assetId === assetId ? { ...reference, characterIds } : reference) }))} onRoleChange={changeSlotRole} onRemove={(assetId, role) => setSelection((current) => removeVideoReference(current, assetId, role))} onPreview={setPreview} />
      </div>} />
      {applyIssue && <p className="vd-error vd-reference-usage-hint" role="alert">{applyIssue}</p>}
      <div className="vd-modal-footer"><span>仅修改第 {row.segmentIndex} 段 · 已选 {selected.length} 张{slotOffset ? '参考图＋1张本地末帧' : ''}{workflow ? ` / ${workflow.mapping.images.length} 个工作流槽` : runningHubSlots !== undefined ? ` / 最多 ${runningHubSlots} 个云端槽` : ''}</span><button type="button" className="btn primary" disabled={applying} onClick={async () => { setApplying(true); setApplyIssue(''); try { const issue = await onApply(cloneVideoReferences(selected), selection.referenceSlotRoles); if (issue) setApplyIssue(issue); else onClose(); } catch (cause) { setApplyIssue(cause instanceof Error ? cause.message : String(cause)); } finally { setApplying(false); } }}>{applying ? '应用选图中…' : '使用本段图片'}</button></div>
    </VideoPickerDialog>
    {preview && <VideoPickerDialog title={`图片预览 · ${preview.name}`} onClose={() => setPreview(undefined)}><img className="vd-full-image" src={assetPreviewUrl(preview)} alt={preview.name} /></VideoPickerDialog>}
  </>;
}

interface VideoBatchConfirmation {
  input: VideoBatchStartInput;
  candidates: VideoBatchChoiceCandidate[];
  connectionLabel: string;
  signature: string;
}

interface VideoBatchRetryEntry {
  task: VideoGenerationTask;
  key: VideoPromptChoiceKey;
  planId: string;
  segmentId: string;
  storyboardId: string;
  language: 'zh' | 'en';
  draft: VideoGenerationDraft;
}

const retryableFailedVideoTask = (task: VideoGenerationTask): boolean => Boolean(
  task.videoJob
  && !task.videoJob.legacyMetadataIncomplete
  && task.videoJob.batchQueueState !== 'cancelled'
  && task.videoJob.stage !== 'stopped'
  && !task.videoJob.trackingStopped
  && (task.status === 'failed' || task.videoJob.stage === 'failed'),
);

const videoBatchRetryEntries = (
  project: Project,
  taskIds: readonly string[] | undefined,
): VideoBatchRetryEntry[] => {
  const seen = new Set<string>();
  return (taskIds || []).flatMap((taskId) => {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const task = findReusableVideoTask(project, taskId);
    if (!task || !retryableFailedVideoTask(task)) return [];
    const draft = draftFromVideoTask(task);
    const source = draft?.source;
    const planId = source?.sequencePlanId || task.sequencePlanId;
    const segmentId = source?.segmentId || task.segmentId;
    const storyboardId = source?.storyboardId || task.storyboardId;
    if (!draft?.prompt.trim() || !planId || !segmentId || !storyboardId) return [];
    const language = source?.language === 'en' || task.batchItemKey?.endsWith(':en') ? 'en' : 'zh';
    return [{
      task, draft, planId, segmentId, storyboardId, language,
      key: videoPromptChoiceKey(storyboardId, language),
    }];
  });
};

const retrySnapshotDurationSec = (draft: VideoGenerationDraft, fallback: number): number => {
  const explicit = Number(draft.parameters.duration);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const ranges = [...draft.prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/giu)]
    .map((match) => [Number(match[1]), Number(match[2])] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
  if (!ranges.length) return fallback;
  const duration = Math.max(...ranges.map(([, end]) => end)) - Math.min(...ranges.map(([start]) => start));
  return duration > 0 ? duration : fallback;
};

/** One user click extracts and applies the predecessor's actual final frame. Draft changes,
 * source replacement, cancellation and unmount all invalidate late results. */
function useOneClickVideoTail(input: {
  project: Project; tools?: TailFrameTools; scopeKey: string;
  onApply: (references: VideoImageReference[], context: TailFrameSelectionContext) => void;
  onNotice: (message: string) => void; onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const latest = useRef(input); latest.current = input;
  const mounted = useRef(true);
  const active = useRef<{ scopeKey: string; controller: AbortController; tools: TailFrameTools;
    context: TailFrameSelectionContext; sourceId: string; sourceIdentity: string }>();
  const sourceIdentity = (project: Project, context: TailFrameSelectionContext, sourceId: string) => {
    const version = lookupPreviousSegmentVideos(project, context).versions.find((entry) => entry.asset.id === sourceId);
    return version ? JSON.stringify([version.asset.id, version.asset.relativePath, version.asset.checksum,
      version.task?.id, version.asset.sourceStoryboardId, version.asset.sourceVideoTaskId]) : '';
  };
  const stop = async () => {
    const run = active.current;
    if (!run || run.controller.signal.aborted) return;
    run.controller.abort();
    try { await run.tools.cancel(); }
    catch (cause) { if (mounted.current) latest.current.onError(formatUserFacingError(cause)); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void stop(); };
  }, []);
  useEffect(() => {
    const run = active.current;
    if (run && (run.scopeKey !== input.scopeKey || sourceIdentity(input.project, run.context, run.sourceId) !== run.sourceIdentity) && !run.controller.signal.aborted) {
      latest.current.onNotice('稿件、选图或连接已变化，已取消本次本地末帧提取；没有应用迟到结果。');
      void stop();
    }
  }, [input.scopeKey, input.project]);
  const select = async (context: TailFrameSelectionContext, placement: VideoTailReferencePlacement,
    onSelected?: (references: VideoImageReference[], frame: ReferenceAsset) => void) => {
    const initial = latest.current;
    if (active.current || initial.tools?.busy) return;
    initial.onError('');
    if (!initial.tools?.available || !initial.tools.extract) { initial.onError('本地视频抽帧工具暂不可用，请检查视频处理工具。'); return; }
    const lookup = lookupPreviousSegmentVideos(initial.project, context);
    const version = lookup.versions[0];
    if (!version?.asset.relativePath) { initial.onError(lookup.reason || '准确的上一段尚无可用成片，未改用其他视频。'); return; }
    const source = { assetId: version.asset.id, relativePath: version.asset.relativePath, expectedChecksum: version.asset.checksum };
    const run = { scopeKey: initial.scopeKey, controller: new AbortController(), tools: initial.tools,
      context, sourceId: source.assetId, sourceIdentity: sourceIdentity(initial.project, context, source.assetId) };
    active.current = run; setBusy(true); initial.onBusyChange?.(true);
    initial.onNotice(`正在本地提取第 ${lookup.previousSegment!.index} 段最新已保存成片的真实最后一帧；不调用文本或视觉AI，不重新生成视频提示词，未提交视频生成。`);
    try {
      const frame = await initial.tools.extract(source);
      if (!mounted.current || run.controller.signal.aborted || latest.current.scopeKey !== run.scopeKey) return;
      const currentSource = lookupPreviousSegmentVideos(latest.current.project, context).versions.find((entry) => entry.asset.id === source.assetId)?.asset;
      if (!currentSource || currentSource.relativePath !== source.relativePath || currentSource.checksum !== source.expectedChecksum) throw new Error('上一段视频已变化，未应用旧视频的选帧结果。');
      if (!frame.id || !frame.relativePath || !frame.checksum || frame.missing || frame.mediaType !== 'image'
        || frame.referenceRole !== 'last-frame' || frame.sourceVideoAssetId !== source.assetId
        || frame.sourceVideoChecksum !== source.expectedChecksum || !Number.isFinite(frame.sourceTimeSec)) {
        throw new Error('本地抽帧未返回对应上段的已保存真实末帧，本段选图未改动。');
      }
      const references = applyVideoTailReference({ references: context.references, tailAssetId: frame.id, placement, confirmed: true });
      if (onSelected) onSelected(references, frame); else latest.current.onApply(references, context);
      latest.current.onNotice(`已使用第 ${lookup.previousSegment!.index} 段的本地真实末帧（${frame.sourceTimeSec!.toFixed(3)} 秒）。${placement.label}；原资产保留，未调用文本或视觉AI，未重新生成视频提示词，尚未提交视频生成。${placement.warning || ''}`);
    } catch (cause) {
      if (!mounted.current || latest.current.scopeKey !== run.scopeKey) return;
      if (run.controller.signal.aborted) latest.current.onNotice('已取消本地末帧提取，本段选图未改动。');
      else latest.current.onError(formatUserFacingError(cause));
    } finally {
      if (active.current === run) active.current = undefined;
      if (mounted.current) {
        setBusy(false); latest.current.onBusyChange?.(false);
        if (run.controller.signal.aborted && latest.current.scopeKey === run.scopeKey) latest.current.onNotice('已取消本地末帧提取，本段选图未改动。');
      }
    }
  };
  return { busy, select, cancel: stop };
}

function VideoBatchPanel({ project, chapterId, savedBatch, onBatchDraftChange, settings, controller, tailFrameTools, initialDraft, initialParameterText, retryTaskIds, onOpenSettings, onOpenJobs, onSubmittingChange, onRepairIdentityBindings }: {
  project: Project;
  chapterId?: string;
  savedBatch?: VideoDirectorBatchDraft;
  onBatchDraftChange: (draft: VideoDirectorBatchDraft) => void;
  settings: AppSettings;
  controller: VideoGenerationController;
  tailFrameTools?: TailFrameTools;
  initialDraft: VideoGenerationDraft;
  initialParameterText: string;
  retryTaskIds?: readonly string[];
  onOpenSettings?: () => void;
  onOpenJobs?: () => void;
  onSubmittingChange: (submitting: boolean) => void;
  onRepairIdentityBindings?: VideoDirectorViewProps['onRepairIdentityBindings'];
}) {
  const plans = useMemo(() => [...(chapterId ? chapterPlans(project, chapterId) : project.sequencePlans)].filter((plan) => plan.segments.length && !plan.sourceStale).sort((left, right) => right.updatedAt - left.updatedAt), [project, chapterId]);
  const retryEntries = useMemo(() => videoBatchRetryEntries(project, retryTaskIds).filter((entry) => plans.some((plan) => plan.id === entry.planId)), [project, retryTaskIds, plans]);
  const retryPrimary = retryEntries[0];
  const initialBatch = !retryPrimary ? savedBatch : undefined;
  const retryParameterBaselineText = retryPrimary ? JSON.stringify(retryPrimary.draft.parameters, null, 2) : '';
  const [planId, setPlanId] = useState(() => plans.find((plan) => plan.id === (retryPrimary?.planId || initialBatch?.planId || initialDraft.source?.sequencePlanId))?.id || plans[0]?.id || '');
  const [backend, setBackend] = useState(retryPrimary?.draft.backend || initialBatch?.backend || initialDraft.backend);
  const [workflowId, setWorkflowId] = useState(() => retryPrimary
    ? retryPrimary.draft.workflowId || ''
    : initialBatch?.workflowId ?? initialDraft.workflowId ?? settings.comfyuiVideo?.activeWorkflowId ?? settings.comfyuiVideo?.workflows[0]?.id ?? '');
  const [apiProfileId, setApiProfileId] = useState(retryPrimary?.draft.apiProfileId ?? initialBatch?.apiProfileId ?? initialDraft.apiProfileId ?? '');
  const [runningHubWorkflowId, setRunningHubWorkflowId] = useState(retryPrimary ? retryPrimary.draft.runningHubWorkflowId : initialBatch ? initialBatch.runningHubWorkflowId : initialDraft.runningHubWorkflowId);
  const sourceKind = videoDraftSource({ backend, runningHubWorkflowId });
  const [parameterText, setParameterText] = useState(() => retryPrimary ? retryParameterBaselineText : initialBatch?.parameterText ?? initialParameterText);
  const parameterDrafts = useRef(new Map<string, string>(initialBatch?.parameterDrafts));
  const switchParameterConnection = (patch: Partial<Pick<VideoGenerationDraft, 'backend' | 'workflowId' | 'apiProfileId' | 'runningHubWorkflowId'>>) => {
    const current = { backend, workflowId, apiProfileId, runningHubWorkflowId };
    const next = { ...current, ...patch };
    const currentKey = videoParameterConnectionKey(current);
    const nextKey = videoParameterConnectionKey(next);
    if (currentKey !== nextKey) {
      parameterDrafts.current.set(currentKey, parameterText);
      setParameterText(parameterDrafts.current.get(nextKey) ?? '{}');
    }
    setBackend(next.backend); setWorkflowId(next.workflowId); setApiProfileId(next.apiProfileId); setRunningHubWorkflowId(next.runningHubWorkflowId);
  };
  const [settingsCollapsed, setSettingsCollapsed] = useState(initialBatch?.settingsCollapsed || false);
  const [query, setQuery] = useState(initialBatch?.query || '');
  const [selectedKeys, setSelectedKeys] = useState<Set<VideoPromptChoiceKey>>(() => new Set((initialBatch?.selectedKeys as VideoPromptChoiceKey[] | undefined) || retryEntries.map((entry) => entry.key)));
  const [languages, setLanguages] = useState<Record<string, 'zh' | 'en'>>(() => initialBatch?.languages || Object.fromEntries(retryEntries.map((entry) => [entry.segmentId, entry.language])));
  const [referenceOverrides, setReferenceOverrides] = useState<Record<string, VideoImageReference[]>>(initialBatch?.referenceOverrides || {});
  const [referenceRoleOverrides, setReferenceRoleOverrides] = useState<Record<string, ReferenceRole[]>>(initialBatch?.referenceRoleOverrides || {});
  const [automaticTails, setAutomaticTails] = useState<Record<string, AutomaticVideoTailConfiguration>>(initialBatch?.automaticTails || {});
  // Derive the composite draft from the untouched original. Disabling the mode
  // restores both pictures and Picture numbering without deleting any assets.
  const [tailCharacterModes, setTailCharacterModes] = useState<VideoDirectorBatchDraft['tailCharacterModes']>(initialBatch?.tailCharacterModes || {});
  const [previewSegmentId, setPreviewSegmentId] = useState(retryPrimary?.segmentId || initialBatch?.previewSegmentId || '');
  const [previewPane, setPreviewPane] = useState<'prompt' | 'references'>(initialBatch?.previewPane || 'prompt');
  const [compactPane, setCompactPane] = useState<'list' | 'preview'>('list');
  const [imageSegmentId, setImageSegmentId] = useState('');
  const [tailSelecting, setTailSelecting] = useState(false);
  const [confirmation, setConfirmation] = useState<VideoBatchConfirmation>();
  const [feeConfirmed, setFeeConfirmed] = useState(false);
  const [regenerateSucceeded, setRegenerateSucceeded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [identityRepairing, setIdentityRepairing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => retryEntries.length
    ? `已回填 ${retryEntries.length} 个失败任务的原提示词、参数和冻结参考图；这里只是复核，尚未提交。`
    : '');
  const batchDraftChangeRef = useRef(onBatchDraftChange);
  batchDraftChangeRef.current = onBatchDraftChange;
  useEffect(() => {
    batchDraftChangeRef.current({ planId, backend, workflowId, apiProfileId, runningHubWorkflowId, parameterText,
      parameterDrafts: [...parameterDrafts.current], selectedKeys: [...selectedKeys], languages,
      referenceOverrides, referenceRoleOverrides, automaticTails, tailCharacterModes,
      previewSegmentId, previewPane, settingsCollapsed, query });
  }, [planId, backend, workflowId, apiProfileId, runningHubWorkflowId, parameterText, selectedKeys, languages,
    referenceOverrides, referenceRoleOverrides, automaticTails, tailCharacterModes, previewSegmentId, previewPane, settingsCollapsed, query]);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const interactionLocked = submitting || identityRepairing || tailSelecting || Boolean(tailFrameTools?.busy);
  useEffect(() => { onSubmittingChange(interactionLocked); }, [interactionLocked, onSubmittingChange]);
  useEffect(() => () => onSubmittingChange(false), [onSubmittingChange]);
  const plan = plans.find((item) => item.id === planId);
  const sequenceFingerprint = videoTailSequenceFingerprint(project, planId);
  const images = useMemo(() => project.assets.filter(isVideoDirectorImage), [project.assets]);
  const retryConnectionActive = Boolean(retryPrimary
    && retryPrimary.draft.backend === backend
    && retryPrimary.draft.runningHubWorkflowId === runningHubWorkflowId
    && (backend === 'comfyui'
      ? (retryPrimary.draft.workflowId || '') === workflowId
      : (retryPrimary.draft.apiProfileId || '') === apiProfileId));
  const retryConnection = retryConnectionActive ? retryPrimary?.task.videoJob?.snapshot.connection : undefined;
  const workflow = retryConnection?.backend === 'comfyui' && retryConnection.workflow
    ? retryConnection.workflow
    : settings.comfyuiVideo?.workflows.find((item) => item.id === workflowId);
  const apiState = useMemo(() => videoConfiguredApiState(settings, { backend, apiProfileId, runningHubWorkflowId, parameters: {} }, retryConnection?.backend === 'api' ? retryConnection.api : undefined), [settings, backend, apiProfileId, runningHubWorkflowId, retryConnection]);
  const api = apiState.api;
  const referenceUsageContext = useMemo(() => ({ backend, workflow, api, slotRoles: undefined }), [backend, workflow, api]);
  const usageContextForDraft = (draft: VideoGenerationDraft) => {
    const base = frozenConnectionForDraft(draft) || referenceUsageContext;
    return { ...base, slotRoles: draft.referenceSlotRoles };
  };
  const parameterKeys = availableVideoParameterKeys(sourceKind, api, workflow);
  const connectionScope = JSON.stringify({ backend, workflowId, apiProfileId, runningHubWorkflowId, workflow,
    comfyBaseUrl: retryConnection?.comfyui?.baseUrl || settings.comfyuiVideo?.baseUrl,
    api: api ? { provider: api.provider, endpoint: api.endpoint, model: api.model, requestTemplate: api.requestTemplate,
      runningHubImageRoles: api.runningHubImageRoles, runningHubMappedFields: api.runningHubMappedFields } : undefined });
  const connectionScopeRef = useRef(connectionScope);
  useEffect(() => {
    if (connectionScopeRef.current === connectionScope) return;
    connectionScopeRef.current = connectionScope;
    setAutomaticTails((current) => {
      if (Object.keys(current).length) setNotice('视频连接或工作流已变化，已清除本轮自动衔接；请按新图片槽重新设置。');
      return {};
    });
    setTailCharacterModes({});
    setConfirmation(undefined);
  }, [connectionScope]);
  const parameters = useMemo(() => readVideoParameterText(parameterText), [parameterText]);
  const presentationApi = useMemo(() => videoConfiguredApiState(settings, { backend, apiProfileId, runningHubWorkflowId, parameters: parameters.value },
    retryConnection?.backend === 'api' ? retryConnection.api : undefined).api || api,
  [settings, backend, apiProfileId, runningHubWorkflowId, parameters.value, retryConnection, api]);
  const updateParameter = (key: string, text: string) => {
    const next = changeVideoParameterText(parameterText, key, text);
    if (next.issue) { setError(next.issue); return; }
    setParameterText(next.text); setError(''); setConfirmation(undefined);
  };
  const overridesByChoice = useMemo(() => {
    const result: Partial<Record<VideoPromptChoiceKey, VideoImageReference[]>> = {};
    plan?.segments.forEach((segment) => {
      const references = referenceOverrides[segment.id];
      if (references && segment.storyboardId) for (const language of ['zh', 'en'] as const) result[videoPromptChoiceKey(segment.storyboardId, language)] = references;
    });
    return result;
  }, [plan, referenceOverrides]);
  const retryEntriesBySegment = useMemo(() => new Map(retryEntries
    .filter((entry) => entry.planId === planId)
    .map((entry) => [entry.segmentId, entry])), [retryEntries, planId]);
  const baseRows = useMemo(() => {
    if (!plan) return [];
    const built = buildVideoBatchRows(project, plan, settings, {
      backend, workflowId: workflowId || undefined, apiProfileId, runningHubWorkflowId, parameters: parameters.value, referenceOverrides: overridesByChoice,
    });
    return built.map((row): VideoBatchRow => {
      const roles = referenceRoleOverrides[row.segmentId];
      if (roles) row = { ...row,
        zh: row.zh && { ...row.zh, draft: { ...row.zh.draft, referenceSlotRoles: [...roles] } },
        en: row.en && { ...row.en, draft: { ...row.en.draft, referenceSlotRoles: [...roles] } },
      };
      const retry = retryEntriesBySegment.get(row.segmentId);
      if (!retry) return row;
      const useFrozenSnapshot = retry.draft.backend === backend
        && retry.draft.runningHubWorkflowId === runningHubWorkflowId
        && (backend === 'comfyui'
          ? (retry.draft.workflowId || '') === workflowId
          : (retry.draft.apiProfileId || '') === apiProfileId);
      const references = cloneVideoReferences(referenceOverrides[row.segmentId] || retry.draft.references);
      const retryParameters = parameterText === retryParameterBaselineText
        ? structuredClone(retry.draft.parameters)
        : structuredClone(parameters.value);
      const draft: VideoGenerationDraft = {
        ...structuredClone(retry.draft),
        backend,
        workflowId: backend === 'comfyui' ? workflowId || undefined : retry.draft.workflowId,
        apiProfileId: backend === 'api' ? apiProfileId || undefined : retry.draft.apiProfileId,
        runningHubWorkflowId: backend === 'api' ? runningHubWorkflowId : undefined,
        reuseTaskId: useFrozenSnapshot ? retry.task.id : undefined,
        references,
        referenceSlotRoles: roles || retry.draft.referenceSlotRoles,
        parameters: retryParameters,
        source: {
          ...retry.draft.source,
          storyboardId: retry.storyboardId,
          sequencePlanId: retry.planId,
          segmentId: retry.segmentId,
          segmentIndex: row.segmentIndex,
          language: retry.language,
        },
      };
      const base = row[retry.language];
      const choice = {
        id: retry.key,
        storyboardId: retry.storyboardId,
        label: retry.draft.source?.label || retry.draft.name || row.title,
        language: retry.language,
        prompt: retry.draft.prompt,
        durationSec: retrySnapshotDurationSec({ ...retry.draft, parameters: retryParameters }, row.durationSec),
        updatedAt: retry.task.createdAt,
        segmentIndex: row.segmentIndex,
        version: '失败任务原始快照',
      };
      const storedFingerprint = videoTaskRequestFingerprint(retry.task);
      const snapshotStillExact = useFrozenSnapshot
        && parameterText === retryParameterBaselineText
        && !referenceOverrides[row.segmentId];
      const requestFingerprint = snapshotStillExact && storedFingerprint
        ? storedFingerprint
        : `reviewed-retry:${retry.task.id}:${JSON.stringify({ backend, workflowId, apiProfileId, references, parameters: retryParameters })}`;
      const candidate: VideoBatchChoiceCandidate = {
        key: retry.key,
        storyboardId: retry.storyboardId,
        sequencePlanId: retry.planId,
        segmentId: retry.segmentId,
        segmentIndex: row.segmentIndex,
        language: retry.language,
        choice,
        draft,
        promptFingerprint: base?.promptFingerprint || `retry-prompt:${retry.task.id}`,
        referenceFingerprint: base?.referenceFingerprint || `retry-references:${retry.task.id}`,
        requestFingerprint,
        duplicate: storedFingerprint ? findVideoBatchDuplicate(project, storedFingerprint) : undefined,
      };
      return retry.language === 'zh'
        ? { ...row, durationSec: choice.durationSec, zh: candidate }
        : { ...row, durationSec: choice.durationSec, en: candidate };
    });
  }, [plan, project, settings, backend, workflowId, apiProfileId, runningHubWorkflowId, parameters.value, parameterText, retryParameterBaselineText, overridesByChoice, referenceOverrides, referenceRoleOverrides, retryEntriesBySegment]);
  // Automatic defaults are only for untouched rows. An explicitly empty
  // selection is intentional too; never restore deselected identity images.
  const hasEditedTailReferences = (segmentId: string): boolean => Boolean(tailCharacterModes[segmentId]?.editedReferences)
    || Object.prototype.hasOwnProperty.call(referenceOverrides, segmentId);
  const characterDrafts = useMemo(() => new Map(baseRows.flatMap((row) => [row.zh, row.en]
    .filter((candidate): candidate is VideoBatchChoiceCandidate => Boolean(candidate))
    .map((candidate) => [candidate.key, prepareVideoTailCharacterDraft(project, candidate.draft, { preserveSlots: hasEditedTailReferences(candidate.segmentId) })] as const))), [baseRows, project, tailCharacterModes, referenceOverrides]);
  const characterSourceFingerprint = (row: VideoBatchRow, rebuild = false): string => JSON.stringify([row.zh, row.en].map((candidate) => {
    if (!candidate) return null;
    const prepared = rebuild ? prepareVideoTailCharacterDraft(project, candidate.draft, { preserveSlots: true }) : characterDrafts.get(candidate.key)!;
    return [candidate.draft, prepared.issue, prepared.draft.prompt,
      videoBatchReferenceFingerprint(prepared.draft, project.assets)];
  }));
  const frozenConnectionForDraft = (draft: VideoGenerationDraft) => {
    const snapshot = draft.reuseTaskId ? findReusableVideoTask(project, draft.reuseTaskId)?.videoJob?.snapshot : undefined;
    return snapshot?.projectId === project.id && snapshot.connection.backend === draft.backend
      && snapshot.draft.workflowId === draft.workflowId && snapshot.draft.apiProfileId === draft.apiProfileId
      && snapshot.draft.runningHubWorkflowId === draft.runningHubWorkflowId ? snapshot.connection : undefined;
  };
  const outputSummaryForDraft = (draft: VideoGenerationDraft) => {
    const frozen = frozenConnectionForDraft(draft);
    const selectedApi = videoConfiguredApiState(settings, draft, frozen?.backend === 'api' ? frozen.api : undefined).api;
    return videoOutputParameterSummary(draft.parameters, selectedApi);
  };
  const rows = useMemo(() => baseRows.map((row): VideoBatchRow => {
      const mode = tailCharacterModes[row.segmentId];
      const automatic = automaticTails[row.segmentId];
      const decorate = (candidate?: VideoBatchChoiceCandidate): VideoBatchChoiceCandidate | undefined => {
        if (!candidate) return undefined;
        const prepared = mode ? characterDrafts.get(candidate.key) : undefined;
        let draft = prepared && !prepared.issue ? { ...prepared.draft,
          references: mode?.kind === 'static' && mode.tailAssetId && mode.tailRole
            ? videoBatchTailReferences(prepared.draft.references, { mode: 'prepend', index: 0, role: mode.tailRole }, mode.tailAssetId) : prepared.draft.references,
          referenceSlotRoles: mode?.kind === 'static' && mode.tailRole
            ? [mode.tailRole, ...videoReferenceSelection(prepared.draft.references, prepared.draft.referenceSlotRoles).referenceSlotRoles!]
            : prepared.draft.referenceSlotRoles,
        } : candidate.draft;
        // Pending-tail drafts retain their original pre-insertion references.
        // Their final slots are resolved after applying the tail placement.
        if (!automatic) draft = { ...draft, references: videoReferenceUsage(draft.references, usageContextForDraft(draft)) };
        const bindingInput = automatic ? { ...draft, references: videoBatchTailReferences(draft.references, automatic.placement, '__future_tail_binding__') } : draft;
        const bound = prepareVideoH3ReferenceDraft(project, bindingInput, usageContextForDraft(draft)).draft;
        draft = automatic ? { ...bound, references: draft.references } : bound;
        const referenceFingerprint = videoBatchReferenceFingerprint(draft, project.assets);
        if (!automatic && !mode) {
          const requestFingerprint = videoBatchRequestFingerprint(draft, project.assets,
            frozenConnectionForDraft(draft) || videoBatchConnectionIdentity(settings, draft));
          return { ...candidate, draft, referenceFingerprint, requestFingerprint,
            duplicate: findVideoBatchDuplicate(project, requestFingerprint) };
        }
        return { ...candidate, draft, referenceFingerprint,
          // The engine computes the durable dependency-aware fingerprint before
          // deduplication. Preview must never mistake a future tail for old refs.
          duplicate: undefined,
          requestFingerprint: `tail-binding:${candidate.requestFingerprint}:${referenceFingerprint}:${JSON.stringify([automatic, mode, draft,
            mode?.kind === 'static' ? selectedTailFingerprint(draft.references[0], project.assets) : undefined])}`,
        };
      };
      return { ...row, zh: decorate(row.zh), en: decorate(row.en) };
    }), [baseRows, automaticTails, tailCharacterModes, characterDrafts, project.assets, referenceUsageContext, retryConnection, settings]);
  const rowLanguage = (row: VideoBatchRow): 'zh' | 'en' => languages[row.segmentId] || (row.zh ? 'zh' : 'en');
  const rowChoice = (row: VideoBatchRow): VideoBatchChoiceCandidate | undefined => row[rowLanguage(row)];
  const visibleRows = rows.filter((row) => `${row.title} 第${row.segmentIndex}段 第 ${row.segmentIndex} 段`.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')));
  const selected = rows.flatMap((row) => [row.zh, row.en].filter((candidate): candidate is VideoBatchChoiceCandidate => Boolean(candidate && selectedKeys.has(candidate.key))));
  const shouldRegenerate = (candidate: VideoBatchChoiceCandidate): boolean => (
    regenerateSucceeded && candidate.duplicate?.kind === 'succeeded'
  );
  const pending = selected.filter((candidate) => videoBatchCandidateWillSubmit(candidate, regenerateSucceeded));
  const completedSelectionCount = selected.filter((candidate) => candidate.duplicate?.kind === 'succeeded').length;
  const hasAutomaticSelection = selected.some((candidate) => automaticTails[candidate.segmentId]);
  const selectedSignature = `${regenerateSucceeded ? 'regenerate-succeeded' : 'skip-succeeded'}|${connectionScope}|${selected.map((candidate) => `${candidate.key}:${candidate.requestFingerprint}`).join('|')}`;
  const previewRow = rows.find((row) => row.segmentId === previewSegmentId) || rows[0];
  const previewChoice = previewRow && rowChoice(previewRow);
  const imageRow = baseRows.find((row) => row.segmentId === imageSegmentId);
  const imageChoice = imageRow && rowChoice(imageRow);
  const connectionLabel = backend === 'comfyui' ? `ComfyUI · ${workflow?.name || '未选择工作流'}` : `${sourceKind === 'runninghub' ? 'RunningHub 云端' : '视频 API'} · ${api?.model || '未配置'}`;
  const referenceAssets = (candidate: VideoBatchChoiceCandidate): ReferenceAsset[] => {
    const snapshot = candidate.draft.reuseTaskId
      ? findReusableVideoTask(project, candidate.draft.reuseTaskId)?.videoJob?.snapshot
      : undefined;
    if (!snapshot) return images;
    const frozen = snapshot.images.map(frozenVideoReferenceAsset);
    const frozenIds = new Set(frozen.map((image) => image.id));
    return [...frozen, ...images.filter((image) => !frozenIds.has(image.id))];
  };
  const automaticResolution = (candidate: VideoBatchChoiceCandidate) => ({
    candidate, configuration: automaticTails[candidate.segmentId], project, sequencePlanId: planId,
    selected, ...usageContextForDraft(candidate.draft), connectionScope, toolsAvailable: Boolean(tailFrameTools?.available),
  });
  const intendedReferenceCount = (candidate: VideoBatchChoiceCandidate): number => automaticTails[candidate.segmentId]?.placement.mode === 'replace-all'
    ? 1 : candidate.draft.references.length + (['append', 'prepend'].includes(automaticTails[candidate.segmentId]?.placement.mode || '') ? 1 : 0);
  const referenceIssue = (candidate: VideoBatchChoiceCandidate): string => {
    const references = candidate.draft.references;
    const context = usageContextForDraft(candidate.draft);
    const mode = tailCharacterModes[candidate.segmentId];
    if (mode) {
      const prepared = characterDrafts.get(candidate.key);
      if (!prepared || prepared.issue) return prepared?.issue || '本段无法建立末帧和参考图的图片对应关系。';
      const original = baseRows.find((row) => row.segmentId === candidate.segmentId);
      if (mode.connectionScope !== connectionScope || mode.sequenceFingerprint !== sequenceFingerprint
        || !original || mode.sourceFingerprint !== characterSourceFingerprint(original)) return '稿件、参考图或连接已变化，请重新点击“本地末帧＋参考图”。';
      const placement = prepared && getVideoTailCharacterPlacement({ ...context, references: prepared.draft.references });
      if (!placement?.placement) return placement?.reason || '无法确定末帧和参考图的图片槽。';
      if (mode.kind === 'static' && placement.placement.role !== mode.tailRole) return '第1图片槽用途已变化，请重新设置组合参考。';
      if (mode.kind === 'static' && mode.tailFingerprint !== selectedTailFingerprint(references[0], project.assets)) return '已选本地真实末帧的图片内容已变化，请重新点击“本地末帧＋参考图”。';
    }
    const automaticIssue = automaticVideoTailIssue(automaticResolution(candidate));
    if (automaticIssue) return automaticIssue;
    const placement = automaticTails[candidate.segmentId]?.placement;
    const placedReferences = placement ? videoBatchTailReferences(references, placement, '__future-tail__') : references;
    const finalReferences = videoReferenceUsage(placedReferences, { ...context,
      slotRoles: placement?.mode === 'prepend'
        ? [placement.role, ...videoReferenceSelection(references, candidate.draft.referenceSlotRoles).referenceSlotRoles!]
        : context.slotRoles,
    });
    const retainedReferences = placement ? finalReferences.filter((_, index) => index !== placement.index) : finalReferences;
    const roles = finalReferences.map((reference) => reference.role);
    const availableImages = referenceAssets(candidate);
    if (retainedReferences.some((reference) => !availableImages.some((image) => image.id === reference.assetId && !image.missing))) return '参考图已缺失，请重新选择';
    if (context.backend === 'comfyui' && context.workflow) {
      if (videoReferenceSlotSpan(finalReferences) > context.workflow.mapping.images.length) return `已选图占用了工作流范围以外的图片槽（最多 ${context.workflow.mapping.images.length} 槽），请调整选图或映射。`;
    }
    if (context.backend === 'api' && context.api?.provider === 'runninghub' && context.api.runningHubImageRoles) {
      if (videoReferenceSlotSpan(finalReferences) > context.api.runningHubImageRoles.length) return `当前 RunningHub 工作流最多支持 ${context.api.runningHubImageRoles.length} 个图片槽，已选图占用了范围外的槽；请调整选图，不会丢弃图片。`;
    }
    if (context.backend === 'api' && context.api?.provider === 'minimax' && (roles.some((role) => !['first-frame', 'last-frame'].includes(role)) || roles.filter((role) => role === 'first-frame').length > 1 || roles.filter((role) => role === 'last-frame').length > 1)) return '此接口仅支持一张首帧和一张尾帧';
    return '';
  };
  const retryComfy = retryConnection?.backend === 'comfyui' ? retryConnection.comfyui : undefined;
  const configurationIssue = apiState.issue || parameters.issue || (backend === 'comfyui'
    ? retryComfy
      ? !retryComfy.enabled || !retryComfy.baseUrl.trim() || !workflow ? '失败任务保存的 ComfyUI 快照不完整，不能按原设置重试。' : ''
      : !settings.comfyuiVideo?.enabled || !settings.comfyuiVideo.baseUrl.trim() || !workflow ? '请先启用 ComfyUI 并选择视频工作流。' : ''
    : !api?.enabled || !api.endpoint.trim() ? '请先启用并设置视频 API。' : '');
  const selectedIssue = selectedKeys.size !== selected.length ? '部分已选稿件已变化或不存在，请重新选择。' : pending.map((candidate) => {
    const issue = referenceIssue(candidate); return issue ? `第 ${candidate.segmentIndex} 段：${issue}` : '';
  }).find(Boolean) || '';
  const selectLanguage = (row: VideoBatchRow, language: 'zh' | 'en') => {
    const candidate = row[language]; if (!candidate) return;
    setLanguages((current) => ({ ...current, [row.segmentId]: language }));
    setSelectedKeys((current) => {
      const wasSelected = Boolean(row.zh && current.has(row.zh.key) || row.en && current.has(row.en.key));
      const next = new Set(current); if (row.zh) next.delete(row.zh.key); if (row.en) next.delete(row.en.key);
      if (wasSelected) next.add(candidate.key); return next;
    });
  };
  const selectAll = (language: 'zh' | 'en') => {
    setLanguages(Object.fromEntries(rows.map((row) => [row.segmentId, language])));
    const keys = allVideoBatchChoiceKeys(rows, language); setSelectedKeys(keys);
    setNotice(`已选择当前计划的 ${keys.size} 段${language === 'zh' ? '中文' : '英文描述'}；${rows.length - keys.size} 段尚无可用稿件。`);
  };
  const changePlan = (nextId: string) => {
    setPlanId(nextId); setSelectedKeys(new Set()); setLanguages({}); setReferenceOverrides({}); setAutomaticTails({}); setTailCharacterModes({}); setPreviewSegmentId(''); setImageSegmentId(''); setConfirmation(undefined); setQuery(''); setError(''); setNotice('切换计划后已清空本轮选择与自动衔接；原分镜和提示词未改动。');
  };
  const clearAutomaticTails = (segmentIds: readonly string[]) => {
    setAutomaticTails((current) => {
      const next = { ...current }; segmentIds.forEach((id) => { delete next[id]; }); return next;
    });
    setTailCharacterModes((current) => {
      const next = { ...current }; segmentIds.forEach((id) => { delete next[id]; }); return next;
    });
    setConfirmation(undefined);
  };
  const copyReferences = (targetSegmentId: string, references: readonly VideoImageReference[], roles?: ReferenceRole[]) => {
    clearAutomaticTails([targetSegmentId]);
    setReferenceOverrides((current) => ({ ...current, [targetSegmentId]: cloneVideoReferences(references) }));
    setReferenceRoleOverrides((current) => ({ ...current, [targetSegmentId]: videoReferenceSelection(references, roles).referenceSlotRoles! }));
  };
  const referencesForCopy = (candidate: VideoBatchChoiceCandidate): readonly VideoImageReference[] => (
    tailCharacterModes[candidate.segmentId] ? candidate.draft.references
      : baseRows.find((row) => row.segmentId === candidate.segmentId)?.[candidate.language]?.draft.references || candidate.draft.references
  );
  const applyBatchReferenceSelection = async (row: VideoBatchRow, candidate: VideoBatchChoiceCandidate, references: VideoImageReference[], referenceSlotRoles?: ReferenceRole[]): Promise<string | void> => {
    const mode = tailCharacterModes[row.segmentId];
    if (!mode) {
      copyReferences(row.segmentId, references, referenceSlotRoles);
      setNotice(`第 ${row.segmentIndex} 段已使用独立选图，不重新生成视频提示词。${boundaryUsageSummary(usageContextForDraft(candidate.draft)) ? '首尾帧按图片槽处理，不改原素材分类。' : ''}${automaticTails[row.segmentId] ? '原自动衔接已取消，需要时可重新启用。' : ''}`);
      return;
    }
    const originalRow = baseRows.find((entry) => entry.segmentId === row.segmentId)!;
    const sourceCandidate = originalRow[candidate.language] || candidate;
    const prepared = prepareVideoTailCharacterDraft(project, { ...sourceCandidate.draft, references, referenceSlotRoles }, { preserveSlots: true });
    if (prepared.issue) return prepared.issue;
    const resolved = getVideoTailCharacterPlacement({ ...usageContextForDraft(candidate.draft), references: prepared.draft.references });
    if (!resolved.placement) return resolved.reason || '图片槽无法容纳所选参考图，未改动原选图。';
    const automatic = automaticTails[row.segmentId];
    if (mode.kind === 'automatic' && !automatic) return '原本地末帧衔接依赖已变化，请关闭选图窗口后重新设置组合。';
    if (mode.kind === 'static' && selectedTailFingerprint(mode.tailAssetId && mode.tailRole ? { assetId: mode.tailAssetId, role: mode.tailRole } : undefined, project.assets) !== mode.tailFingerprint) return '已选本地真实末帧已变化，请重新选择衔接帧；参考图尚未应用。';
    const withReferences = (entry: VideoBatchChoiceCandidate | undefined) => entry && ({ ...entry, draft: { ...entry.draft, references, referenceSlotRoles } });
    const nextRow = { ...originalRow, zh: withReferences(originalRow.zh), en: withReferences(originalRow.en) };
    setReferenceOverrides((current) => ({ ...current, [row.segmentId]: cloneVideoReferences(references) }));
    setReferenceRoleOverrides((current) => ({ ...current, [row.segmentId]: videoReferenceSelection(references, referenceSlotRoles).referenceSlotRoles! }));
    setTailCharacterModes((current) => ({ ...current, [row.segmentId]: { ...mode, editedReferences: true,
      connectionScope, sequenceFingerprint, sourceFingerprint: characterSourceFingerprint(nextRow, true) } }));
    if (automatic) setAutomaticTails((current) => ({ ...current, [row.segmentId]: { ...automatic,
      placement: structuredClone(resolved.placement!), connectionScope, sequenceFingerprint } }));
    setConfirmation(undefined); setError('');
    setNotice(`第 ${row.segmentIndex} 段参考图已更新；槽1仍由本地真实末帧占用，槽2起按你选择的人物、场景或其它参考图及用途使用，不自动补回人物图，不重排其它图片。仅同步图片引用编号，不重新生成视频提示词，不调用文本或视觉AI。尚未提交视频。${resolved.placement.warning || ''}`);
  };
  const setRegeneration = (allowed: boolean) => {
    setRegenerateSucceeded(allowed); setConfirmation(undefined); setError('');
    setNotice(allowed ? '已允许重新生成所选的成功项；原视频保留，新任务可能再次收费。进行中或结果待确认项仍不会重复提交。' : '已恢复默认去重：相同的成功任务会跳过。');
  };
  const manualTail = useOneClickVideoTail({
    project, tools: tailFrameTools,
    scopeKey: JSON.stringify([project.id, planId, sequenceFingerprint, connectionScope, parameterText, languages,
      [...selectedKeys].sort(), rows.map((row) => [row.segmentId, row.zh?.draft, row.en?.draft,
        row.zh?.referenceFingerprint, row.en?.referenceFingerprint]), automaticTails, tailCharacterModes,
      baseRows.map((row) => characterSourceFingerprint(row))]),
    onBusyChange: setTailSelecting, onNotice: setNotice, onError: setError,
    onApply: (references, context) => {
      copyReferences(context.segmentId, references);
      setPreviewSegmentId(context.segmentId); setPreviewPane('references');
    },
  });
  const usePreviousTail = (row: VideoBatchRow, candidate: VideoBatchChoiceCandidate) => {
    if (interactionLocked) return;
    setError(''); setConfirmation(undefined);
    try {
      candidate = baseRows.find((entry) => entry.segmentId === row.segmentId)?.[candidate.language] || candidate;
      if (!tailFrameTools?.available || !tailFrameTools.extract) throw new Error('本地视频抽帧工具暂不可用，请检查视频处理工具。');
      const locator = lookupPreviousSequenceSegment(project, { sequencePlanId: planId, segmentId: row.segmentId });
      if (!locator.previousSegment) throw new Error(locator.reason || '无法确定准确的上一段。');
      const placements = getVideoTailReferencePlacements({ ...usageContextForDraft(candidate.draft), references: candidate.draft.references });
      const placement = oneClickVideoTailReferencePlacement(placements.options, candidate.draft.references);
      if (!placement) throw new Error(placements.reason || '当前连接没有可用的衔接图片槽。');
      const predecessor = locator.previousSegment;
      const predecessorSelected = selected.some((item) => item.segmentId === predecessor.id && item.segmentIndex === predecessor.index);
      const existing = lookupPreviousSegmentVideos(project, { sequencePlanId: planId, segmentId: row.segmentId });
      if (!predecessorSelected && existing.versions.length) {
        void manualTail.select({ sequencePlanId: planId, segmentId: row.segmentId, prompt: candidate.draft.prompt,
          references: candidate.draft.references }, placement);
        return;
      }
      setTailCharacterModes((current) => { const next = { ...current }; delete next[row.segmentId]; return next; });
      setAutomaticTails((value) => ({ ...value, [row.segmentId]: {
        predecessorSegmentId: predecessor.id, predecessorSegmentIndex: predecessor.index,
        placement: structuredClone(placement), connectionScope, sequenceFingerprint,
      } }));
      setNotice(`第 ${row.segmentIndex} 段已启用本地末帧衔接，等待准确的第 ${predecessor.index} 段。${placement.label}；原资产保留。${predecessorSelected ? '' : '生成前请同时选中上一段。'}不调用文本或视觉AI，不重新生成视频提示词，尚未提交视频。`);
    } catch (cause) { setError(formatUserFacingError(cause)); }
  };
  const prepareAutomaticBulk = () => {
    if (interactionLocked || !selected.length) return;
    setError(''); setConfirmation(undefined);
    try {
      if (!tailFrameTools?.available || !tailFrameTools.extract) throw new Error('本地视频抽帧工具暂不可用，请检查视频处理工具。');
      const entries = buildOneClickVideoTailEntries({ project, sequencePlanId: planId,
        selected: selected.map((candidate) => ({ ...(baseRows.find((row) => row.segmentId === candidate.segmentId)?.[candidate.language] || candidate), title: candidate.choice.label })), backend, workflow, api });
      const enabled = entries.filter((entry) => entry.placementId && !entry.keepManual);
      setAutomaticTails(applyAutomaticVideoTailEntries({ current: automaticTails, entries,
        connectionScope, sequenceFingerprint, confirmed: true }));
      setTailCharacterModes((current) => { const next = { ...current }; entries.forEach((entry) => { delete next[entry.segmentId]; }); return next; });
      const skipped = entries.filter((entry) => !entry.keepManual && !entry.placementId)
        .map((entry) => `第 ${entry.segmentIndex} 段：${entry.reason || '没有可用图片槽'}`);
      setNotice(`已一键设置 ${enabled.length} 段本地末帧衔接；起始段保留原选图，其他原资产保留。不调用文本或视觉AI，不重新生成视频提示词，尚未提交视频。${skipped.join('；')}`);
    } catch (cause) { setError(formatUserFacingError(cause)); }
  };
  const prepareTailCharacters = (row: VideoBatchRow, candidate: VideoBatchChoiceCandidate) => {
    if (!tailFrameTools?.available || !tailFrameTools.extract) throw new Error('本地视频抽帧工具暂不可用，请检查视频处理工具。');
    const original = baseRows.find((entry) => entry.segmentId === row.segmentId);
    const prepared = characterDrafts.get(candidate.key);
    if (!original || !prepared || prepared.issue) throw new Error(prepared?.issue || '本段稿件已变化，请重新选择。');
    const locator = lookupPreviousSequenceSegment(project, { sequencePlanId: planId, segmentId: row.segmentId });
    if (!locator.previousSegment) throw new Error(locator.reason || '无法确定准确的上一段。');
    const resolved = getVideoTailCharacterPlacement({ ...usageContextForDraft(candidate.draft), references: prepared.draft.references });
    if (!resolved.placement) throw new Error(resolved.reason || '当前连接没有足够的本地末帧＋参考图图片槽。');
    return { prepared, placement: resolved.placement, predecessor: locator.previousSegment,
      mode: { kind: 'automatic' as const, connectionScope, sequenceFingerprint, sourceFingerprint: characterSourceFingerprint(original), editedReferences: hasEditedTailReferences(row.segmentId) ? true as const : undefined } };
  };
  const useTailWithCharacters = (row: VideoBatchRow, candidate: VideoBatchChoiceCandidate) => {
    if (interactionLocked) return;
    setError(''); setConfirmation(undefined);
    try {
      const { prepared, placement, predecessor, mode } = prepareTailCharacters(row, candidate);
      const predecessorSelected = selected.some((item) => item.segmentId === predecessor.id && item.segmentIndex === predecessor.index);
      const existing = lookupPreviousSegmentVideos(project, { sequencePlanId: planId, segmentId: row.segmentId });
      if (!predecessorSelected && existing.versions.length) {
        setNotice(`正在本地提取第 ${predecessor.index} 段成片的真实最后一帧；仅同步图片引用编号，不重新生成视频提示词，不调用文本或视觉AI，原选图和模式尚未改动。`);
        void manualTail.select({ sequencePlanId: planId, segmentId: row.segmentId, prompt: prepared.draft.prompt,
          references: prepared.draft.references }, placement, (references, frame) => {
          if (!mountedRef.current || connectionScopeRef.current !== connectionScope) return;
          const staticMode = { ...mode, kind: 'static' as const,
            tailAssetId: references[0].assetId, tailRole: references[0].role,
            tailFingerprint: selectedTailFingerprint(references[0], [frame]) };
          setAutomaticTails((current) => { const next = { ...current }; delete next[row.segmentId]; return next; });
          setTailCharacterModes((current) => ({ ...current, [row.segmentId]: staticMode }));
        });
        return;
      }
      setTailCharacterModes((current) => ({ ...current, [row.segmentId]: mode }));
      setAutomaticTails((current) => ({ ...current, [row.segmentId]: {
        predecessorSegmentId: predecessor.id, predecessorSegmentIndex: predecessor.index,
        placement: structuredClone(placement), connectionScope, sequenceFingerprint,
      } }));
      setNotice(`第 ${row.segmentIndex} 段已设置：图片1＝第 ${predecessor.index} 段本地真实末帧，图片2起＝${prepared.draft.references.length} 张参考图；默认选人物图，已手动选择的场景或其它图保留，可在“选择参考图”中修改。仅同步图片引用编号，不重新生成视频提示词，不调用文本或视觉AI。${predecessorSelected ? '' : `生成前请同时选中第 ${predecessor.index} 段。`}尚未提交视频。${placement.warning || ''}${prepared.notices?.join('') || ''}`);
    } catch (cause) { if (mountedRef.current) setError(formatUserFacingError(cause)); }
  };
  const prepareTailCharactersBulk = () => {
    if (interactionLocked || selected.length < 2) return;
    setError(''); setConfirmation(undefined);
    const nextAutomatic = { ...automaticTails }; const nextModes = { ...tailCharacterModes };
    let enabled = 0;
    const ordered = [...selected].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const preparedEntries: Array<{ row: VideoBatchRow; placement: VideoTailReferencePlacement; predecessor: { id: string; index: number }; mode: { kind: 'automatic'; connectionScope: string; sequenceFingerprint: string; sourceFingerprint?: string; editedReferences?: true } }> = [];
    try {
      // Resolve every local slot/dependency first; a missing image, unsupported
      // slot or gap leaves all prior selections and modes untouched.
      ordered.slice(1).forEach((candidate) => {
        const row = rows.find((entry) => entry.segmentId === candidate.segmentId)!;
        const { placement, predecessor, mode } = prepareTailCharacters(row, candidate);
        if (!selected.some((entry) => entry.segmentId === predecessor.id && entry.segmentIndex === predecessor.index)) {
          throw new Error(`请同时选中准确的第 ${predecessor.index} 段；不会自动增选收费段。`);
        }
        preparedEntries.push({ row, placement, predecessor, mode });
      });
      delete nextAutomatic[ordered[0].segmentId];
      if (nextModes[ordered[0].segmentId]?.kind === 'automatic') delete nextModes[ordered[0].segmentId];
      preparedEntries.forEach((entry) => {
        nextModes[entry.row.segmentId] = entry.mode;
        nextAutomatic[entry.row.segmentId] = { predecessorSegmentId: entry.predecessor.id, predecessorSegmentIndex: entry.predecessor.index,
          placement: structuredClone(entry.placement), connectionScope, sequenceFingerprint };
        enabled += 1;
      });
      setAutomaticTails(nextAutomatic); setTailCharacterModes(nextModes);
      setNotice(`已为 ${enabled} 段设置本地末帧＋参考图；第1槽放真实最后一帧，第2槽起默认人物图，已手动选择的场景或其它图及用途保留。仅同步图片引用编号，不重新生成视频提示词，不调用文本或视觉AI。起始段保留静态选图、清除旧依赖；尚未提交视频。`);
    } catch (cause) {
      if (mountedRef.current) setError(formatUserFacingError(cause));
    }
  };
  const prepareConfirmation = () => {
    if (interactionLocked) return;
    setError(''); setNotice('');
    if (!plan || !selected.length || !pending.length) return;
    if (configurationIssue || selectedIssue) { setError(configurationIssue || selectedIssue); return; }
    setFeeConfirmed(false);
    try { setConfirmation({
      input: {
        projectId: project.id,
        label: `${plan.title || plan.sourceStoryTitle} · 批量视频`,
        concurrency: 1,
        items: buildVideoBatchSubmissionItems(selected, regenerateSucceeded,
          (candidate) => resolveAutomaticVideoTailInput(automaticResolution(candidate))),
      },
      candidates: structuredClone(selected), connectionLabel, signature: selectedSignature,
    }); } catch (cause) { setError(formatUserFacingError(cause)); }
  };
  const submitBatch = async () => {
    if (!confirmation || !feeConfirmed || submittingRef.current || tailSelecting || tailFrameTools?.busy) return;
    if (confirmation.input.projectId !== project.id || confirmation.signature !== selectedSignature || configurationIssue || selectedIssue) {
      setConfirmation(undefined); setError('稿件、图片或连接参数已变化，请重新检查本批次。'); return;
    }
    submittingRef.current = true; setSubmitting(true); setError('');
    try {
      const result = await controller.startBatch(confirmation.input);
      if (!mountedRef.current) return;
      setConfirmation(undefined); setNotice(`已建立 ${result.taskIds.length} 个视频任务，跳过 ${result.skipped.length} 个已完成或正在处理的相同任务。`);
      if (result.taskIds.length) onOpenJobs?.();
    } catch (cause) { if (mountedRef.current) { setConfirmation(undefined); setError(formatUserFacingError(cause)); } }
    finally { submittingRef.current = false; if (mountedRef.current) setSubmitting(false); }
  };
  return <section className="vd-batch-panel" aria-label="长剧情批量视频">
    <div className="vd-batch-settings-header">
      <button type="button" className="vd-batch-settings-toggle" aria-label={settingsCollapsed ? '展开批量设置' : '收起批量设置'} aria-expanded={!settingsCollapsed} aria-controls="vd-batch-settings-content" onClick={() => setSettingsCollapsed((current) => !current)}>
        <strong>批量设置</strong><span>{settingsCollapsed ? '展开设置' : '收起设置'}<span aria-hidden="true">{settingsCollapsed ? '▾' : '▴'}</span></span>
      </button>
      {settingsCollapsed && <div className="vd-batch-settings-summary" aria-label="当前批量设置摘要">
        <span>计划：{plan ? `${plan.title || plan.sourceStoryTitle} · ${plan.segments.length} 段` : '尚无已分段计划'}</span>
        <span>{connectionLabel}</span>
        <span className={parameters.issue ? 'vd-batch-settings-wide vd-batch-settings-warning' : 'vd-batch-settings-wide'}>{parameters.issue ? '公共参数 JSON 有误，请展开设置修正；原文本已保留。' : retryEntriesBySegment.size > 0 && parameterText === retryParameterBaselineText ? '失败重试项保留各段原参数；时长与分辨率请在确认清单逐段核对。' : videoOutputParameterSummary(parameters.value, presentationApi) || '时长与分辨率：保留接口 / 工作流原值'}</span>
        {query.trim() && <span className="vd-batch-settings-wide">筛选：“{query.trim()}” · 显示 {visibleRows.length} / {rows.length} 段，已有选择保留</span>}
        {regenerateSucceeded && <span className="vd-batch-settings-wide vd-batch-settings-warning">已开启重新生成已成功项（保留原视频，可能再次收费）</span>}
      </div>}
    </div>
    <div id="vd-batch-settings-content" className="vd-batch-controls" hidden={settingsCollapsed}>
      <div className="vd-batch-configuration">
        <label className="field"><span>全片计划</span><select aria-label="批量全片计划" value={planId} disabled={submitting} onChange={(event) => changePlan(event.target.value)}>{!plans.length && <option value="">尚无已分段计划</option>}{plans.map((item) => <option key={item.id} value={item.id}>{item.title || item.sourceStoryTitle} · {item.segments.length} 段</option>)}</select></label>
        <label className="field"><span>生成方式</span><select aria-label="批量生成方式" value={sourceKind} disabled={submitting} onChange={(event) => { const source = event.target.value as 'api' | 'comfyui' | 'runninghub'; switchParameterConnection({ backend: source === 'comfyui' ? 'comfyui' : 'api', runningHubWorkflowId: source === 'runninghub' ? settings.runningHubVideo?.activeWorkflowId || '__runninghub_unselected__' : undefined, apiProfileId: source === 'runninghub' ? '' : apiProfileId }); }}><option value="api">视频 API</option><option value="comfyui">ComfyUI</option><option value="runninghub">RunningHub 云端</option></select></label>
        <label className="field"><span>{sourceKind === 'runninghub' ? '云端工作流' : backend === 'comfyui' ? '视频工作流' : '视频 API 配置'}</span>{sourceKind === 'runninghub' ? <select aria-label="批量 RunningHub 云端工作流" value={runningHubWorkflowId || '__runninghub_unselected__'} disabled={submitting} onChange={(event) => switchParameterConnection({ runningHubWorkflowId: event.target.value })}>{retryConnection?.api ? <option value={runningHubWorkflowId}>原失败批次云端快照 · {retryConnection.api.model}</option> : <option value="__runninghub_unselected__" disabled>请选择云端工作流</option>}{settings.runningHubVideo?.workflows.filter((item) => !(retryConnection?.api && item.id === runningHubWorkflowId)).map((item) => <option key={item.id} value={item.id} disabled={!isRunningHubVideoWorkflowReady(item)}>{item.name}</option>)}</select> : backend === 'comfyui' ? <select aria-label="批量视频工作流" value={workflowId} disabled={submitting} onChange={(event) => switchParameterConnection({ workflowId: event.target.value })}>{retryConnection?.backend === 'comfyui' && retryConnection.workflow ? <option value={workflowId}>原失败批次快照 · {retryConnection.workflow.name}</option> : <option value="" disabled>请选择工作流</option>}{settings.comfyuiVideo?.workflows.filter((item) => !(retryConnection?.backend === 'comfyui' && item.id === workflowId)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.mapping.images.length} 个图片槽</option>)}</select> : <select aria-label="批量视频 API 配置" value={apiProfileId} disabled={submitting} onChange={(event) => switchParameterConnection({ apiProfileId: event.target.value })}>{retryConnection?.backend === 'api' && retryConnection.api ? <option value={apiProfileId}>原失败批次 API 快照 · {retryConnection.api.model || '未记录模型'}</option> : <option value="">当前视频 API 配置</option>}{settings.videoApiProfiles?.filter((item) => !(retryConnection?.backend === 'api' && item.id === apiProfileId)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</label>
      </div>
      <div className="vd-batch-toolbar">
        <input type="search" aria-label="搜索批量视频段" placeholder="搜索段标题或段号" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="btn small" disabled={submitting || !rows.length} onClick={() => selectAll('zh')}>全选中文</button>
        <button className="btn small" disabled={submitting || !rows.length} onClick={() => selectAll('en')}>全选英文</button>
        <button className="btn small" disabled={submitting || !rows.length} onClick={() => { const eligible = ungeneratedVideoBatchChoiceKeys(rows); setSelectedKeys(new Set(rows.flatMap((row) => { const candidate = rowChoice(row); return candidate && eligible.has(candidate.key) ? [candidate.key] : []; }))); setNotice('已按每段当前语言选择尚未生成、也未进入队列的稿件。'); }}>只选未生成</button>
        <button className="btn small vd-tail-entry" aria-label="已选后续段自动衔接" disabled={interactionLocked || selected.length < 2} onClick={prepareAutomaticBulk}>一键末帧衔接已选后续段</button>
        <button className="btn small vd-tail-entry" aria-label="已选后续段尾帧加参考图" title="第1槽放本地真实最后一帧；其余槽默认人物参考，可选场景或其它参考图，已手动选图保留。不重新生成视频提示词，不调用文本或视觉AI。" disabled={interactionLocked || selected.length < 2} onClick={prepareTailCharactersBulk}>一键末帧＋参考图</button>
        <button className="btn small ghost" disabled={submitting || !selectedKeys.size} onClick={() => setSelectedKeys(new Set())}>清空选择</button>
        <label className="check-row vd-batch-regenerate-success"><input type="checkbox" aria-label="重新生成已成功项" checked={regenerateSucceeded} disabled={submitting} onChange={(event) => setRegeneration(event.target.checked)} />重新生成已成功项（保留原视频，可能再次收费）</label>
      </div>
      <VideoOutputParameters scope="batch" source={sourceKind} parameterText={parameterText} availableKeys={parameterKeys} {...videoOutputParameterPresentation(presentationApi, parameters.value)} requiresMapping={sourceKind !== 'api' || api?.provider === 'runninghub'} disabled={interactionLocked} onChange={updateParameter} onOpenSettings={onOpenSettings} />
      <details className="vd-batch-advanced"><summary>高级公共参数 JSON · 不填写则保持接口 / 工作流原值</summary><div><p>覆盖值用于本批次全部所选段；不会自动改动时长、种子或采样。每段参考图独立，不继承单段草稿选图。</p><textarea aria-label="批量公共参数 JSON" className="vd-code" rows={3} value={parameterText} disabled={submitting} onChange={(event) => setParameterText(event.target.value)} /></div></details>
    </div>
    <div className="vd-batch-responsive-tabs" role="tablist" aria-label="批量工作区域"><button role="tab" aria-selected={compactPane === 'list'} className={`btn small ${compactPane === 'list' ? 'primary' : ''}`} onClick={() => setCompactPane('list')}>分段清单</button><button role="tab" aria-selected={compactPane === 'preview'} className={`btn small ${compactPane === 'preview' ? 'primary' : ''}`} onClick={() => setCompactPane('preview')}>当前段预览</button></div>
    <div className="vd-batch-columns" data-pane={compactPane}>
      <div className="vd-batch-list" aria-label="批量分段清单">
        {visibleRows.map((row) => {
          const candidate = rowChoice(row); const selectedRow = Boolean(candidate && selectedKeys.has(candidate.key));
          const automatic = automaticTails[row.segmentId];
          const characterMode = tailCharacterModes[row.segmentId];
          const previousRow = rows[rows.indexOf(row) - 1]; const previousChoice = previousRow && rowChoice(previousRow);
          const issue = candidate ? referenceIssue(candidate) : '当前语言尚无可用提示词';
          return <article className={`vd-batch-row ${selectedRow ? 'selected' : ''} ${previewRow?.segmentId === row.segmentId ? 'previewing' : ''}`} key={row.segmentId} data-segment-id={row.segmentId}>
            <label className="vd-batch-check"><input type="checkbox" aria-label={`选择第 ${row.segmentIndex} 段`} checked={selectedRow} disabled={!candidate || submitting} onChange={() => { if (!candidate) return; setSelectedKeys((current) => { const next = new Set(current); const other = row[candidate.language === 'zh' ? 'en' : 'zh']; if (other) next.delete(other.key); return toggleVideoBatchChoice(next, candidate.key); }); }} /></label>
            <div className="vd-batch-row-main"><strong title={row.title}>第 {row.segmentIndex} 段 · {row.title}</strong><span>原分段计划 {plan?.segments.find((segment) => segment.id === row.segmentId)?.durationSec ?? row.durationSec} 秒 · {automatic ? '等待上段衔接帧后生成' : candidate?.duplicate && hasAutomaticSelection && selectedRow && !shouldRegenerate(candidate) ? '存在相同任务，待整链核对' : candidate?.duplicate?.kind === 'in-flight' ? '已在队列，将跳过' : candidate?.duplicate?.kind === 'succeeded' ? regenerateSucceeded ? '已生成，将重新生成' : '已生成，将跳过' : candidate?.draft.reuseTaskId ? '失败任务快照，待复核' : '尚未生成'} · {automatic ? '最终参考图' : '参考图'} {candidate ? intendedReferenceCount(candidate) : 0} 张{backend === 'comfyui' ? ` / ${workflow?.mapping.images.length || 0} 个槽` : ''}</span>{candidate && outputSummaryForDraft(candidate.draft) && <small className="vop-request-summary">{outputSummaryForDraft(candidate.draft)}</small>}{automatic && <small className="vd-auto-tail-badge">自动衔接：第 {automatic.predecessorSegmentIndex} 段 → {automatic.selectionMode === 'ai-assisted' ? 'AI 辅助选帧 → ' : '本地末帧 → '}图片槽 {automatic.placement.index + 1} · {automatic.placement.semantics === 'first-frame' ? '首帧输入' : '普通衔接参考（不保证严格首帧）'}</small>}{issue && <small className="vd-error">{issue}</small>}</div>
            <div className="vd-batch-row-tools">
              <div className="vd-batch-language" role="group" aria-label={`第 ${row.segmentIndex} 段稿件语言`}>{(['zh', 'en'] as const).map((language) => <button type="button" key={language} className={`btn small ${rowLanguage(row) === language ? 'primary' : ''}`} title={row[language] ? '只切换已保存的稿件，不翻译或重新生成提示词' : '尚无此语言的已保存稿件，不会自动生成'} aria-pressed={rowLanguage(row) === language} disabled={!row[language] || interactionLocked} onClick={() => selectLanguage(row, language)}>{language === 'zh' ? '中文' : '英文'}</button>)}</div>
              <button type="button" className="btn small" title="查看已有提示词和本次图片，不重新生成提示词" onClick={() => { setPreviewSegmentId(row.segmentId); setCompactPane('preview'); }}>预览</button>
              <button type="button" className="btn small" aria-label={`第 ${row.segmentIndex} 段选择参考图`} title="只选择本段图片和槽位用途，不重新生成提示词" disabled={!candidate || interactionLocked} onClick={() => setImageSegmentId(row.segmentId)}>选择参考图</button>
              <button type="button" className="btn small ghost" aria-label={`第 ${row.segmentIndex} 段复制上一段参考图`} title="仅复制上一段已选择的图片，不抽取视频尾帧，不重新生成提示词" disabled={!candidate || !previousChoice || interactionLocked} onClick={() => { if (previousChoice) { copyReferences(row.segmentId, referencesForCopy(previousChoice), previousChoice.draft.referenceSlotRoles); setNotice(`已将第 ${previousRow.segmentIndex} 段的图片顺序与用途复制到第 ${row.segmentIndex} 段；未提取视频尾帧，不重新生成提示词。${automatic ? '本段自动衔接已取消。' : ''}`); } }}>复制上段选图</button>
              <button type="button" className="btn small vd-tail-entry" aria-label={`第 ${row.segmentIndex} 段用上段尾帧`} title={row.segmentIndex <= 1 ? '第一段没有上一段视频' : '本地提取真实最后一帧：前段在本批次时先配置衔接；否则直接提取前段最新成片的末帧。不调用文本或视觉AI，不重新生成提示词，不弹出设置画面。'} disabled={!candidate || row.segmentIndex <= 1 || interactionLocked} onClick={() => { if (candidate) usePreviousTail(row, candidate); }}>{automatic ? '已启用本地末帧' : '用上段尾帧'}</button>
              <button type="button" className={`btn small vd-tail-entry ${characterMode ? 'primary' : ''}`} aria-label={`第 ${row.segmentIndex} 段本地末帧加参考图`} aria-pressed={Boolean(characterMode)} title={row.segmentIndex <= 1 ? '第一段没有上一段视频' : '第1槽放本地真实最后一帧，第2槽起默认人物参考，可选场景或其它参考图；已手动选图保留。仅同步图片引用编号，不重新生成视频提示词，不调用文本或视觉AI，不提交视频。'} disabled={!candidate || row.segmentIndex <= 1 || interactionLocked} onClick={() => { if (candidate) useTailWithCharacters(row, candidate); }}>本地末帧＋参考图</button>
              {characterMode ? <button type="button" className="btn small ghost" aria-label={`第 ${row.segmentIndex} 段取消尾帧加参考图`} disabled={interactionLocked} onClick={() => { clearAutomaticTails([row.segmentId]); setNotice(`第 ${row.segmentIndex} 段已取消组合参考，恢复原选图和原提示词；已保存的尾帧素材保留。`); }}>恢复原选图</button> : automatic && <button type="button" className="btn small ghost" aria-label={`第 ${row.segmentIndex} 段取消自动衔接`} disabled={interactionLocked} onClick={() => { clearAutomaticTails([row.segmentId]); setNotice(`第 ${row.segmentIndex} 段已取消自动衔接，恢复使用本段原选图。`); }}>取消自动衔接</button>}
              {characterMode && <small className="vd-tail-character-summary">图片1：{characterMode.kind === 'automatic' ? '待本地提取末帧' : '本地真实末帧'}定画面 · 图片2起：默认人物参考，可选场景／其它参考图</small>}
            </div>
          </article>;
        })}
        {!visibleRows.length && <div className="vd-empty">{rows.length ? '没有匹配的分段；已有选择仍保留。' : '请先在提示词导演台完成长剧情分段，并生成各段提示词。全片母版不会作为单段视频提交。'}</div>}
      </div>
      <aside className="vd-batch-preview" aria-label="所选段预览">
        <div className="vd-batch-preview-head"><strong>{previewRow ? `第 ${previewRow.segmentIndex} 段 · ${previewRow.title}` : '分段预览'}</strong><div className="vd-mode-tabs" role="tablist" aria-label="批量段预览内容"><button role="tab" aria-selected={previewPane === 'prompt'} className={`btn small ${previewPane === 'prompt' ? 'primary' : ''}`} onClick={() => setPreviewPane('prompt')}>完整提示词</button><button role="tab" aria-selected={previewPane === 'references'} className={`btn small ${previewPane === 'references' ? 'primary' : ''}`} onClick={() => setPreviewPane('references')}>参考图与用途</button></div></div>
        <div className="vd-batch-preview-body">{previewChoice ? previewPane === 'prompt' ? <><p className="field-hint">{previewChoice.language === 'zh' ? '已有中文稿' : '已有英文描述，对白语言不变'} · {previewChoice.choice.version}{tailCharacterModes[previewChoice.segmentId] ? ' · 本次图片编号已同步，原稿未改动' : ''}</p><pre className="vd-prompt-preview">{previewChoice.draft.prompt}</pre></> : <div className="vd-batch-reference-preview">
          {automaticTails[previewChoice.segmentId] && <p className="vd-notice">待生成衔接帧：等待第 {automaticTails[previewChoice.segmentId].predecessorSegmentIndex} 段保存后，{automaticTails[previewChoice.segmentId].selectionMode === 'ai-assisted' ? '由 AI 从末尾候选画面选择；AI 失败时保留待处理，不改用原尾帧。较早帧可能动作回退，原视频不自动裁剪。' : '本地直接提取真实最后一帧，不调用视觉 API。'}{automaticTails[previewChoice.segmentId].placement.label}。{automaticTails[previewChoice.segmentId].placement.warning || ''}</p>}
          {automaticTails[previewChoice.segmentId]?.placement.mode === 'prepend' && <div className="vd-tail-will-replace" aria-label="图片槽1等待本地真实末帧"><span>1. 等待上一段本地真实末帧<small>画面、构图与动作衔接；人物身份参考后续图片</small></span></div>}
          {tailCharacterModes[previewChoice.segmentId] && <p className="vd-notice">末帧用于开场画面衔接，其它图片按本段用途作为人物、场景或其它参考；类型不匹配仅提示。人物图只固定身份，服装按当前剧情和逐镜状态；原稿未改动。{characterDrafts.get(previewChoice.key)?.notices?.join('')}{tailCharacterModes[previewChoice.segmentId].kind === 'static' ? getVideoTailCharacterPlacement({ ...usageContextForDraft(previewChoice.draft), references: characterDrafts.get(previewChoice.key)?.draft.references || [] }).placement?.warning : ''}</p>}
          {previewChoice.draft.references.map((reference, index) => {
            const asset = referenceAssets(previewChoice).find((image) => image.id === reference.assetId);
            const placement = automaticTails[previewChoice.segmentId]?.placement;
            const offset = placement?.mode === 'prepend' ? 1 : 0;
            const slotIndex = videoReferenceSlotIndex(reference, index) + offset;
            const context = usageContextForDraft(previewChoice.draft);
            const effectiveRole = videoReferenceUsage([{ ...reference, slotIndex }], {
              ...context, slotRoles: offsetVideoReferenceSlotRoles(context.slotRoles, offset),
            })[0].role;
            const replaced = placement?.mode === 'replace-all' || placement?.mode === 'replace' && placement.index === index;
            const staticTail = tailCharacterModes[previewChoice.segmentId]?.kind === 'static' && slotIndex === 0;
            return <div key={reference.assetId} className={replaced ? 'vd-tail-will-replace' : ''}>{asset && assetPreviewUrl(asset) && <img src={assetPreviewUrl(asset)} alt={asset.name} />}<span className="vd-batch-reference-info"><ReferenceImageName name={`${slotIndex + 1}. ${asset?.name || '图片缺失'}`} /><small>{replaced ? '此原图将在生成时被上段尾帧替换；资产保留' : staticTail ? '本地真实末帧 · 画面、构图与动作' : imageRoleLabel(effectiveRole)} · 槽 {slotIndex + 1}{!replaced && asset && effectiveRole !== videoImageRole(asset) ? ` · 原素材：${imageRoleLabel(videoImageRole(asset))}` : ''}</small></span></div>;
          })}
          {!previewChoice.draft.references.length && !automaticTails[previewChoice.segmentId] && <p className="vd-empty">本段未带入参考图。</p>}</div> : <div className="vd-empty">本段还没有当前语言的有效提示词。</div>}</div>
        {previewChoice && <VideoH3ReferenceNotices key={previewChoice.key} project={project} draft={previewChoice.draft} warnings={previewChoice.draft.h3ReferenceWarnings} onRepair={onRepairIdentityBindings} onRepairingChange={setIdentityRepairing} disabled={interactionLocked} />}
        <div className="vd-batch-preview-footer"><button className="btn small" disabled={!previewChoice || !selected.length || interactionLocked} onClick={() => { if (!previewChoice) return; const copied = referencesForCopy(previewChoice); clearAutomaticTails(selected.map((candidate) => candidate.segmentId)); setReferenceOverrides((current) => { const next = { ...current }; selected.forEach((candidate) => { next[candidate.segmentId] = cloneVideoReferences(copied); }); return next; }); setReferenceRoleOverrides((current) => { const next = { ...current }; selected.forEach((candidate) => { next[candidate.segmentId] = videoReferenceSelection(copied, previewChoice.draft.referenceSlotRoles).referenceSlotRoles!; }); return next; }); setNotice(`已将第 ${previewRow.segmentIndex} 段的静态选图应用到全部 ${selected.length} 个已选段；受影响段的自动衔接已清除，需要时请重新设置。`); }}>本段图片应用到全部已选</button><span>仅改变本批次，不改原分镜；不复制待生成的尾帧依赖。</span></div>
      </aside>
    </div>
    <div className="vd-batch-footer">
      <div className="vd-batch-summary"><strong>{hasAutomaticSelection ? `已选 ${selectedKeys.size} 段 · 提交前核对整条依赖链` : `已选 ${selectedKeys.size} 段 · 待提交 ${pending.length} 段 · 跳过 ${selected.length - pending.length} 段`}</strong><span>{connectionLabel} · {hasAutomaticSelection ? '自动衔接：上段完成并落盘 → 抽尾帧 → 提交后段' : '每段独立任务，按段号逐个提交'}</span>{!regenerateSucceeded && completedSelectionCount > 0 && <span>所选 {completedSelectionCount} 段已有视频；需要新版本时可启用重新生成，原视频不会覆盖。</span>}{(error || configurationIssue || selectedIssue) ? <p className="vd-error" role="alert">{error || configurationIssue || selectedIssue}</p> : notice && <p className="vd-success" role="status">{notice}</p>}</div>
      <div className="vd-batch-submit-actions">{configurationIssue && onOpenSettings && <button className="btn small" disabled={interactionLocked} onClick={onOpenSettings}>连接设置</button>}{!regenerateSucceeded && completedSelectionCount > 0 && <button type="button" className="btn small" disabled={interactionLocked} onClick={() => setRegeneration(true)}>允许重新生成已完成项</button>}<button type="button" className="btn primary" disabled={interactionLocked || !pending.length || Boolean(configurationIssue || selectedIssue)} onClick={prepareConfirmation}>{submitting ? '正在建立批次…' : `检查并生成 ${hasAutomaticSelection ? selected.length : pending.length} 段视频`}</button></div>
    </div>
    {tailSelecting && <div className="vd-tail-inline-progress" role="status"><span>{tailFrameTools?.progress?.message || '正在本地提取上一段真实最后一帧…'}</span><button type="button" className="btn small" onClick={() => { void manualTail.cancel(); }}>取消末帧提取</button></div>}
    {imageRow && imageChoice && <VideoBatchImagePicker key={imageRow.segmentId} project={project} row={imageRow} references={tailCharacterModes[imageRow.segmentId] && !characterDrafts.get(imageChoice.key)?.issue ? characterDrafts.get(imageChoice.key)!.draft.references : imageChoice.draft.references} referenceSlotRoles={tailCharacterModes[imageRow.segmentId] ? characterDrafts.get(imageChoice.key)?.draft.referenceSlotRoles : imageChoice.draft.referenceSlotRoles} images={referenceAssets(imageChoice)} workflow={backend === "comfyui" ? usageContextForDraft(imageChoice.draft).workflow : undefined} usageContext={usageContextForDraft(imageChoice.draft)} slotOffset={tailCharacterModes[imageRow.segmentId] ? 1 : 0} onApply={(references, roles) => applyBatchReferenceSelection(imageRow, imageChoice, references, roles)} onClose={() => setImageSegmentId("")} />}
    {confirmation && <VideoPickerDialog title="确认批量生成视频" className="vd-batch-confirm-dialog" closeDisabled={submitting} onClose={() => { if (!submittingRef.current) setConfirmation(undefined); }}>
      <div className="vd-batch-dialog-body"><p>{confirmation.connectionLabel} · 计划：{plan?.title || plan?.sourceStoryTitle}</p><p className="field-hint">逐段建立独立任务；自动衔接段必须等待上一段生成并落盘、准备好衔接帧后才提交。其他选图、用途及提示词保持下表快照。{hasAutomaticSelection ? '启动前会核对整条依赖链：未授权重生成的完全重复批次不再提交；只有部分任务重复时整批停止并提示。有进行中或待确认任务时也须整链核对，不会跳过该段直接衔接，不擅自套用历史成片或重复收费。' : '相同任务会跳过；进行中或结果待确认的任务不会重复提交。'}</p>{confirmation.input.items.some((item) => item.previousTail?.selectionMode === 'ai-assisted') && <p className="vd-notice">本批次包含 AI 辅助选帧：由 AI 分析末尾候选帧，遇到可恢复错误最多自动重试3次，含首次最多4次视觉API调用，每次均可能收费。仍失败或遇到不可重试错误时显示原因并暂停，不改用原尾帧；不做人物语义硬拦截。允许选择较早帧，可能动作回退，原视频不自动裁剪；不能保证人物一致。</p>}<div className="vd-batch-confirm-list">{confirmation.candidates.map((candidate) => {
        const inputItem = confirmation.input.items.find((item) => item.itemKey === candidate.key);
        const dependency = inputItem?.previousTail;
        const predecessor = dependency && confirmation.candidates.find((item) => item.key === dependency.predecessorItemKey);
        const original = dependency?.placement.replacedAssetId ? referenceAssets(candidate).find((asset) => asset.id === dependency.placement.replacedAssetId) : undefined;
        const semantics = automaticTails[candidate.segmentId]?.placement;
        return <div key={candidate.key}><strong>第 {candidate.segmentIndex} 段 · {candidate.choice.label}</strong><span>{candidate.language === 'zh' ? '中文' : '英文描述'} · 原分段计划 {plan?.segments.find((segment) => segment.id === candidate.segmentId)?.durationSec ?? candidate.choice.durationSec} 秒 · {intendedReferenceCount(candidate)} 张图 · {videoBatchConfirmationItemStatus(candidate, inputItem, hasAutomaticSelection)}</span>
          <span className="vop-request-summary">{outputSummaryForDraft(inputItem?.draft || candidate.draft) || '请求时长与分辨率：保留工作流 / 接口原值'}</span>
          {dependency && <><span className="vd-auto-tail-badge">第 {predecessor?.segmentIndex} 段（{predecessor?.language === 'en' ? '英文稿' : '中文稿'}）完成并保存 → {dependency.selectionMode === 'ai-assisted' ? 'AI 辅助选帧' : '本地提取真实末帧'} → 本段图片槽 {dependency.placement.index + 1}</span><span>{dependency.placement.mode === 'prepend' ? '图片1使用衔接帧；已选人物、场景或其它参考图顺延至图片2起，各自用途保留，提示词图片编号同步。原选图和原稿保留。' : dependency.placement.mode === 'replace-all' ? `本段全部 ${dependency.placement.replacedReferences?.length} 张参考图替换为 1 张上段衔接帧；原资产保留。` : dependency.placement.mode === 'replace' ? `将替换：${original?.name || dependency.placement.replacedAssetId || '原参考图'}；原资产保留。` : '追加衔接帧，其他参考图位置不变。'}{semantics?.semantics === 'first-frame' ? '作为首帧输入。' : '仅作普通衔接参考，不保证严格从该帧开始。'}</span></>}
          {!dependency && tailCharacterModes[candidate.segmentId]?.kind === 'static' && <span>图片1：已选本地真实末帧；图片2起：本段已选人物、场景或其它参考图，按各自用途使用。原选图和原稿保留。{getVideoTailCharacterPlacement({ ...usageContextForDraft(candidate.draft), references: characterDrafts.get(candidate.key)?.draft.references || [] }).placement?.warning}</span>}
        </div>;
      })}</div><details className="vd-details"><summary>本批次公共参数覆盖</summary><pre className="vd-code">{parameterText}</pre></details></div>
      <div className="vd-modal-footer"><label className="check-row"><input type="checkbox" aria-label="确认批量生成费用" checked={feeConfirmed} disabled={submitting} onChange={(event) => setFeeConfirmed(event.target.checked)} />我已核对所选段、参考图与自动衔接替换，确认启动后按依赖生成，理解接口可能产生费用。</label><button type="button" className="btn primary" disabled={!feeConfirmed || submitting} onClick={() => { void submitBatch(); }}>{submitting ? '正在保存批次…' : hasAutomaticSelection && confirmation.candidates.some((candidate) => candidate.duplicate?.kind === 'in-flight') ? `确认核对 ${confirmation.candidates.length} 段衔接` : `确认生成 ${hasAutomaticSelection ? confirmation.candidates.length : videoBatchConfirmationPendingCount(confirmation.candidates, confirmation.input.items)} 段`}</button></div>
    </VideoPickerDialog>}
  </section>;
}

export function VideoDirectorView(props: VideoDirectorViewProps) {
  const chapterId = props.chapterId || activeChapter(props.project)?.id;
  // The controller remains outside this keyed view. Leaving a chapter unmounts
  // only its editor; a late form callback cannot edit another chapter's draft.
  return <ChapterVideoDirectorView key={videoDirectorChapterKey(props.project.id, chapterId)} {...props} chapterId={chapterId} />;
}

function ChapterVideoDirectorView({ project, chapterId, chapterDraft, onChapterDraftChange, settings, controller, tailFrameTools, launchRequest, onOpenSettings, onOpenPrompt, onOpenVideoAssets, onOpenJobs, onChangeExecution, onRepairIdentityBindings }: VideoDirectorViewProps) {
  const draftScope = videoDirectorChapterKey(project.id, chapterId);
  const initial = readVideoDirectorChapterDraft(chapterDraft || (chapterId ? chapterWorkspace(project, chapterId)?.videoDirector : undefined)) || draftCache.get(draftScope);
  const [generationMode, setGenerationMode] = useState<'single' | 'batch'>(initial?.generationMode || 'single');
  const [batchDraft, setBatchDraft] = useState<VideoDirectorBatchDraft | undefined>(initial?.batch);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [identityRepairing, setIdentityRepairing] = useState(false);
  const [identityRepairResult, setIdentityRepairResult] = useState<{ projectId: string; storyboardId: string; language: 'zh' | 'en'; prompt: string; canRefresh: boolean }>();
  const [draft, setDraft] = useState<VideoGenerationDraft>(() => initial?.draft || emptyVideoDraft(settings));
  const [parameterText, setParameterText] = useState(initial?.parameterText || JSON.stringify(initial?.draft.parameters || {}, null, 2));
  const parameterDrafts = useRef(new Map(initial?.parameterDrafts));
  const [picker, setPicker] = useState<'prompt' | 'images' | undefined>();
  const [promptQuery, setPromptQuery] = useState('');
  const [promptLanguage, setPromptLanguage] = useState<'all' | 'zh' | 'en'>('all');
  const [pickedPromptId, setPickedPromptId] = useState('');
  const [includeReferences, setIncludeReferences] = useState(true);
  const [imageQuery, setImageQuery] = useState('');
  const [imageFilter, setImageFilter] = useState('all');
  const [pickedSelection, setPickedSelection] = useState<VideoReferenceSelection>({ references: [] });
  const pickedAssetIds = pickedSelection.references.map((reference) => reference.assetId);
  const [previewAsset, setPreviewAsset] = useState<ReferenceAsset>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const projectIdRef = useRef(project.id);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const choices = useMemo(() => videoPromptChoices(project, chapterId), [project, chapterId]);
  const images = useMemo(() => project.assets.filter(isVideoDirectorImage), [project.assets]);
  const reusedSnapshot = draft.reuseTaskId ? findReusableVideoTask(project, draft.reuseTaskId)?.videoJob?.snapshot : undefined;
  const reusedConnection = reusedSnapshot?.connection.backend === draft.backend && reusedSnapshot.draft.runningHubWorkflowId === draft.runningHubWorkflowId ? reusedSnapshot.connection : undefined;
  const activeWorkflow = reusedConnection?.workflow || settings.comfyuiVideo?.workflows.find((workflow) => workflow.id === (draft.workflowId || settings.comfyuiVideo?.activeWorkflowId)) || (!draft.workflowId ? settings.comfyuiVideo?.workflows[0] : undefined);
  const sourceKind = videoDraftSource(draft);
  // Read capabilities independently of task overrides so invalid/unmapped values never hide their editing controls.
  const apiState = useMemo(() => videoConfiguredApiState(settings, { ...draft, parameters: {} }, reusedConnection?.api), [settings, draft, reusedConnection]);
  const activeApi = apiState.api;
  const referenceUsageContext = useMemo(() => ({ backend: draft.backend, workflow: activeWorkflow, api: activeApi, slotRoles: draft.referenceSlotRoles }), [draft.backend, draft.referenceSlotRoles, activeWorkflow, activeApi]);
  const effectiveReferences = videoReferenceUsage(draft.references, referenceUsageContext);
  const delivery = useMemo(() => prepareVideoH3ReferenceDraft(project, { ...draft,
    references: videoReferenceUsage(draft.references, referenceUsageContext) }, referenceUsageContext), [project, draft, referenceUsageContext]);
  const sourceStale = !draft.reuseTaskId && Boolean(
    project.storyboards.find((board) => board.id === draft.source?.storyboardId)?.sourceStale
    || project.sequencePlans.find((plan) => plan.id === draft.source?.sequencePlanId)?.sourceStale,
  );
  const repairSingleIdentityBindings: VideoDirectorViewProps['onRepairIdentityBindings'] = onRepairIdentityBindings ? async (storyboardId, language, characterIds) => {
    const board = project.storyboards.find((item) => item.id === storyboardId);
    const sourcePrompt = language === 'en' ? board?.officialPromptEn : board?.officialPromptZh;
    const canRefresh = draft.prompt === sourcePrompt || Boolean(draft.h3ReferenceBinding
      && draft.h3ReferenceBinding.basePrompt === sourcePrompt && draft.prompt === draft.h3ReferenceBinding.renderedPrompt);
    await onRepairIdentityBindings(storyboardId, language, characterIds);
    if (!mountedRef.current) return;
    setIdentityRepairResult({ projectId: project.id, storyboardId, language, prompt: draft.prompt, canRefresh });
  } : undefined;
  useEffect(() => {
    if (!identityRepairResult) return;
    const result = identityRepairResult;
    setIdentityRepairResult(undefined);
    if (result.projectId !== project.id) return;
    const board = project.storyboards.find((item) => item.id === result.storyboardId);
    const prompt = result.language === 'en' ? board?.officialPromptEn : board?.officialPromptZh;
    if (result.canRefresh && prompt) {
      setDraft((current) => current.source?.storyboardId === result.storyboardId
        && (current.source.language || 'zh') === result.language && current.prompt === result.prompt
        ? { ...current, prompt, h3ReferenceBinding: undefined, h3ReferenceWarnings: undefined } : current);
      setNotice('人物图片绑定已修复，已刷新本次提示词；本次选图与参数保留，尚未提交视频。');
    } else setNotice('源稿的人物图片绑定已修复；本次手动编辑的正文已保留，可重新选择源稿带入修复结果。');
  }, [identityRepairResult, project]);
  const referenceSlotLabels = videoReferenceSlotLabels(draft.references, referenceUsageContext, 0, draft.referenceSlotRoles);
  const pickedImageDraft = useMemo(() => ({ ...draft, ...pickedSelection, reuseTaskId: undefined }), [draft, pickedSelection]);
  const pickedImageApi = videoConfiguredApiState(settings, { ...pickedImageDraft, parameters: {} }).api;
  // The per-segment reference picker must not borrow a ComfyUI workflow while
  // the draft is using another backend (RunningHub / generic API).  Doing so
  // makes the picker show the wrong number of physical slots and can produce
  // misleading role warnings.  ComfyUI is the only backend whose slot layout
  // is defined by this workflow mapping; other backends derive their layout
  // from the selected API (or the draft's explicit slot-role array below).
  const pickedImageWorkflow = draft.backend === 'comfyui'
    ? settings.comfyuiVideo?.workflows.find((entry) => entry.id === (pickedImageDraft.workflowId || settings.comfyuiVideo?.activeWorkflowId))
      || (!pickedImageDraft.workflowId ? settings.comfyuiVideo?.workflows[0] : undefined)
    : undefined;
  const pickedUsageContext = { backend: draft.backend, workflow: pickedImageWorkflow, api: pickedImageApi, slotRoles: pickedSelection.referenceSlotRoles };
  // Keep every already-selected physical slot visible, even when the current
  // connection advertises fewer slots.  The picker can then show the exact
  // offending slot and its per-segment purpose; capacity checks remain a
  // separate warning/preflight concern and never silently hide a selected
  // image or compact the other slots.
  const pickedConfiguredSlotCount = pickedImageWorkflow?.mapping.images.length
    ?? (pickedImageApi?.provider === 'runninghub' ? pickedImageApi.runningHubImageRoles?.length : undefined)
    ?? 0;
  const pickedSlotCount = Math.max(
    pickedConfiguredSlotCount,
    videoReferenceSlotSpan(pickedSelection.references),
    pickedSelection.referenceSlotRoles?.length || 0,
  );
  const pickedSlotLabels = videoReferenceSlotLabels(pickedImageDraft.references, pickedUsageContext, 0, pickedSelection.referenceSlotRoles);
  const parsedParameters = useMemo(() => readVideoParameterText(parameterText), [parameterText]);
  const presentationApi = useMemo(() => videoConfiguredApiState(settings, { ...draft, parameters: parsedParameters.value }, reusedConnection?.api).api || activeApi,
    [settings, draft, parsedParameters.value, reusedConnection, activeApi]);
  const patchDraft = (patch: Partial<VideoGenerationDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const switchParameterConnection = (patch: Partial<VideoGenerationDraft>) => {
    const next = { ...draft, ...patch };
    const currentKey = videoParameterConnectionKey(draft);
    const nextKey = videoParameterConnectionKey(next);
    let nextText = parameterText;
    if (currentKey !== nextKey) {
      parameterDrafts.current.set(currentKey, parameterText);
      nextText = parameterDrafts.current.get(nextKey) ?? '{}';
    }
    setDraft({ ...next, parameters: readVideoParameterText(nextText).value });
    setParameterText(nextText); setError(''); setNotice('');
  };
  const draftChangeRef = useRef(onChapterDraftChange);
  draftChangeRef.current = onChapterDraftChange;
  const persistedSignature = useRef('');
  useEffect(() => {
    const next: VideoDirectorChapterDraft = { draft, parameterText, parameterDrafts: [...parameterDrafts.current], generationMode, batch: batchDraft };
    const signature = JSON.stringify(next);
    if (signature === persistedSignature.current) return;
    persistedSignature.current = signature;
    draftCache.set(draftScope, next);
    if (chapterId) draftChangeRef.current?.(project.id, chapterId, next);
  }, [draftScope, project.id, chapterId, draft, parameterText, generationMode, batchDraft]);
  useEffect(() => {
    if (!launchRequest || consumedLaunchIds.has(launchRequest.id)) return;
    const launchChapterId = chapterIdForVideoLaunch(project, launchRequest);
    if (launchChapterId && launchChapterId !== chapterId) return;
    consumedLaunchIds.add(launchRequest.id);
    if (launchRequest.batchTaskIds?.length) {
      setGenerationMode('batch');
      setPicker(undefined);
      setError('');
      setNotice('失败项已送到长剧情批量页复核；确认清单和费用后才会重新提交。');
      return;
    }
    setGenerationMode('single');
    let next = draftCache.get(draftScope)?.draft || emptyVideoDraft(settings);
    if (launchRequest.taskId) {
      const task = findReusableVideoTask(project, launchRequest.taskId);
      const saved = task && draftFromVideoTask(task);
      if (saved) next = saved;
      else { setError('该旧任务没有完整的原始参数快照，不能按原设置复用。已有草稿没有改动；可在任务记录中恢复查询或仅下载。'); return; }
    }
    if (launchRequest.storyboardId) {
      const choice = choices.find((entry) => entry.storyboardId === launchRequest.storyboardId && entry.language === (launchRequest.language || 'zh'));
      if (choice) next = applyVideoPromptChoice({ ...next, reuseTaskId: undefined }, choice, project, true);
      else { setError(launchRequest.language === 'en' ? '所选段还没有可用的当前英文描述，或旧英语稿改变了对白语言。已有草稿没有改动，请在提示词导演台生成当前英文描述后再选择。' : '所选提示词还没有可用稿件，请从提示词导演台生成后再选择。'); return; }
    }
    if (launchRequest.assetIds?.length) next = addVideoDraftAssets({ ...next, reuseTaskId: undefined }, launchRequest.assetIds, project.assets);
    next = applyVideoReferenceRoleOverrides(next, launchRequest.referenceRoleOverrides);
    setDraft(next); setParameterText(JSON.stringify(next.parameters, null, 2));
    setNotice('内容已带入本次生成草稿；确认并点击“生成视频”后才会提交任务。');
  }, [launchRequest, project, chapterId, draftScope, choices, settings]);
  const updateParameter = (key: string, text: string) => {
    const next = changeVideoParameterText(parameterText, key, text);
    if (next.issue) { setError(next.issue); return; }
    patchDraft({ parameters: next.value }); setParameterText(next.text); setError('');
  };
  const singleTail = useOneClickVideoTail({
    project, tools: tailFrameTools,
    scopeKey: JSON.stringify([project.id, chapterId, generationMode, draft, parameterText, activeWorkflow, activeApi ? { ...activeApi, runningHubParameterControls: undefined } : undefined,
      draft.source?.sequencePlanId ? videoTailSequenceFingerprint(project, draft.source.sequencePlanId) : '',
      draft.references.map((reference) => { const asset = videoDraftReferenceAsset(project, reference, reusedSnapshot);
        return [reference.assetId, asset?.relativePath, asset?.checksum, asset?.missing]; })]),
    onNotice: setNotice, onError: setError,
    onApply: (references) => patchDraft({ references }),
  });
  const useSinglePreviousTail = () => {
    if (submitting || batchSubmitting || singleTail.busy || tailFrameTools?.busy) return;
    setError('');
    const source = draft.source;
    if (!source?.sequencePlanId || !source.segmentId) { setError('请先选择带有全片分段来源的提示词，以确定准确的上一段。'); return; }
    const placements = getVideoTailReferencePlacements({ backend: draft.backend, workflow: activeWorkflow, api: activeApi, references: draft.references });
    const placement = oneClickVideoTailReferencePlacement(placements.options, draft.references);
    if (!placement) { setError(placements.reason || '当前连接没有可用的衔接图片槽。'); return; }
    void singleTail.select({ sequencePlanId: source.sequencePlanId, segmentId: source.segmentId,
      prompt: draft.prompt, references: draft.references }, placement);
  };
  const generate = async () => {
    if (submitting || batchSubmitting || singleTail.busy || tailFrameTools?.busy) return;
    if (sourceStale) { setError('本章原文已更新，请更新来源提示词后再生成。历史稿保留，可查看原稿。'); return; }
    setError(''); setNotice('');
    const parsed = readVideoParameterText(parameterText);
    if (parsed.issue) { setError(parsed.issue); return; }
    const parameters = parsed.value;
    const requestedProjectId = project.id;
    setSubmitting(true);
    try {
      await controller.start({ ...delivery.draft,
        source: { ...delivery.draft.source, chapterId },
        references: effectiveReferences, workflowId: draft.backend === 'comfyui' ? activeWorkflow?.id || draft.workflowId : draft.workflowId, parameters });
      if (mountedRef.current && projectIdRef.current === requestedProjectId) { patchDraft({ parameters }); setNotice('任务已建立。请到“生成任务”查看进度；切换页面或章节不会停止后台追踪，完成后自动存入视频资产库。'); }
    } catch (cause) { if (mountedRef.current && projectIdRef.current === requestedProjectId) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mountedRef.current && projectIdRef.current === requestedProjectId) setSubmitting(false); }
  };
  const visibleChoices = choices.filter((choice) => (promptLanguage === 'all' || choice.language === promptLanguage) && `${choice.label} ${choice.segmentIndex ? `第${choice.segmentIndex}段 第 ${choice.segmentIndex} 段` : '单段'} ${choice.prompt}`.toLocaleLowerCase('zh-CN').includes(promptQuery.trim().toLocaleLowerCase('zh-CN')));
  const pickedChoice = choices.find((choice) => choice.id === pickedPromptId);
  const visibleImages = images.filter((asset) => (imageFilter === 'all' || asset.type === imageFilter) && `${asset.name} ${asset.fileName || ''} ${asset.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(imageQuery.trim().toLocaleLowerCase('zh-CN')));
  const parameterKeys = availableVideoParameterKeys(sourceKind, activeApi, activeWorkflow);
  const slotMismatch = draft.backend === 'comfyui' && activeWorkflow && videoReferenceSlotSpan(draft.references) > activeWorkflow.mapping.images.length;

  const generationModeTabs = <div className="vd-mode-tabs vd-generation-mode" role="tablist" aria-label="视频生成模式">
      <button type="button" role="tab" aria-selected={generationMode === 'single'} aria-controls="vd-single-generation-panel" className={`btn ${generationMode === 'single' ? 'primary' : ''}`} disabled={submitting || batchSubmitting || identityRepairing || singleTail.busy || tailFrameTools?.busy} onClick={() => setGenerationMode('single')}>单段生成</button>
      <button type="button" role="tab" aria-selected={generationMode === 'batch'} aria-controls="vd-batch-generation-panel" className={`btn ${generationMode === 'batch' ? 'primary' : ''}`} disabled={submitting || batchSubmitting || identityRepairing || singleTail.busy || tailFrameTools?.busy} onClick={() => setGenerationMode('batch')}>长剧情批量</button>
    </div>;

  return <div className="video-director-view" data-mode={generationMode}>
    <div className="section-heading"><div><h1>视频导演台</h1><p>直接选择已有提示词和图片资产，生成后自动存入视频资产库。这里的编辑不会改动原分镜或原提示词。</p></div>{generationMode === 'batch' && generationModeTabs}<div className="vd-toolbar">{onOpenSettings && <button className="btn" type="button" onClick={onOpenSettings}>视频连接设置</button>}{onOpenVideoAssets && <button className="btn" type="button" onClick={onOpenVideoAssets}>视频资产库</button>}{onOpenJobs && <button className="btn" type="button" onClick={onOpenJobs}>查看生成任务</button>}</div></div>
    {chapterId && <p className="field-hint vd-chapter-context">当前章节：{project.sourceDocuments.find((chapter) => chapter.id === chapterId)?.name || '未命名章节'} · 提示词和分段按本章显示，参考图片全项目共用。</p>}
    {sourceStale && <p className="vd-notice">本章原文已更新，当前历史提示词需要重新生成后才能提交；已提交的视频任务继续运行。</p>}
    {generationMode === 'single' && generationModeTabs}
    {onChangeExecution && <VideoExecutionControls settings={settings} onChange={onChangeExecution} />}
    {generationMode === 'batch' && <div id="vd-batch-generation-panel" role="tabpanel" className="vd-batch-host"><VideoBatchPanel key={`${draftScope}:${launchRequest?.batchTaskIds?.length ? launchRequest.id : 'standard-batch'}`} project={project} chapterId={chapterId} savedBatch={batchDraft} onBatchDraftChange={setBatchDraft} settings={settings} controller={controller} tailFrameTools={tailFrameTools} initialDraft={draft} initialParameterText={parameterText} retryTaskIds={launchRequest?.batchTaskIds} onOpenSettings={onOpenSettings} onOpenJobs={onOpenJobs} onSubmittingChange={setBatchSubmitting} onRepairIdentityBindings={onRepairIdentityBindings} /></div>}
    <div id="vd-single-generation-panel" role="tabpanel" className="vd-layout" hidden={generationMode !== 'single'}><div className="vd-stack">
      <section className="card vd-prompt-card"><div className="card-title"><h2>1. 本次视频提示词</h2><button className="btn small" type="button" onClick={() => { setPicker('prompt'); setPickedPromptId(draft.source?.storyboardId ? `${draft.source.storyboardId}:${draft.source.language || 'zh'}` : ''); }}>从提示词导演台选择</button></div>
        <label className="field"><span>视频名称</span><input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="为本次生成的视频命名" /></label>
        {draft.source ? <div className="vd-source"><span>来源：{draft.source.label || '提示词导演台'} · {draft.source.language === 'en' ? '已有英文描述' : '中文提示词'}</span>{onOpenPrompt && draft.source.storyboardId && <button className="btn small ghost" type="button" onClick={() => onOpenPrompt(draft.source!.storyboardId!, draft.source)}>查看原稿</button>}<button className="btn small ghost" type="button" onClick={() => patchDraft({ source: undefined })}>解除来源关联</button></div> : <p className="field-hint">也可以直接粘贴或手动输入提示词，无需先创建分镜。</p>}
        <label className="field"><span>本次生成使用的完整提示词</span><textarea aria-label="本次生成使用的完整提示词" className="vd-prompt-editor" value={delivery.draft.prompt} onChange={(event) => patchDraft({ prompt: event.target.value, h3ReferenceBinding: undefined })} placeholder="选择已有中文 / 英文描述，或在这里填写完整提示词。不会重新扩写、翻译对白或裁剪字数。" /></label>
        <button className="btn small" type="button" onClick={() => { void navigator.clipboard.writeText(delivery.draft.prompt).then(() => setNotice('已复制本次实际提交提示词。'), () => setError('复制失败，请选中提示词手动复制。')); }}>复制本次提示词</button>
        <VideoH3ReferenceNotices key={`${project.id}:${draft.source?.storyboardId}:${draft.source?.language}`} project={project} draft={delivery.draft} warnings={delivery.warnings} onRepair={repairSingleIdentityBindings} onRepairingChange={setIdentityRepairing} disabled={submitting || batchSubmitting || identityRepairing} />
        <p className="field-hint">长剧情一次选择一个视频段；选择英文仅带入已有英文描述，不自动把中文对白翻译为英文。</p>
      </section>
      <section className="card vd-reference-card"><div className="card-title"><h2>2. 本次参考图片 · {draft.references.length} 张</h2><button type="button" className="btn small vd-tail-entry" aria-label="单段用上段尾帧" disabled={submitting || singleTail.busy || tailFrameTools?.busy || !draft.source?.sequencePlanId || !draft.source?.segmentId || draft.source?.segmentIndex === 1} onClick={useSinglePreviousTail}>{singleTail.busy ? '末帧提取中…' : '用上段尾帧'}</button><button className="btn small" type="button" onClick={() => { setPickedSelection(useCurrentVideoDraftImages(draft, draft.references.map((reference) => reference.assetId), images)); setPicker('images'); }}>从图片资产库选择</button></div>
        <p className="field-hint">用上段尾帧会在本地提取准确前一段最新成片的真实最后一帧并应用，不调用视觉 API、不提交视频生成。优先使用支持的首帧槽，原资产保留；普通参考槽不保证严格首帧。</p>
        {singleTail.busy && <div className="vd-tail-inline-progress" role="status"><span>{tailFrameTools?.progress?.message || '正在本地提取上一段真实最后一帧…'}</span><button type="button" className="btn small" onClick={() => { void singleTail.cancel(); }}>取消末帧提取</button></div>}
        {reusedSnapshot && <div className="vd-notice"><span>这里显示原任务保存的图片，不受资产库后续替换或删除影响。选择当前资产库图片会解除原任务快照，提示词和种子保留。</span><button type="button" className="btn small" onClick={() => { patchDraft({ reuseTaskId: undefined }); setPreviewAsset(undefined); setNotice('已解除原任务快照，改用当前图片及连接设置；提示词和本次参数保持不变。'); }}>改用当前图片（解除原快照）</button></div>}
        {draft.references.length ? <ol className="vd-reference-list">{draft.references.map((reference, index) => {
          const asset = videoDraftReferenceAsset(project, reference, reusedSnapshot);
          const slotIndex = videoReferenceSlotIndex(reference, index);
          const slot = draft.backend === 'comfyui' ? activeWorkflow?.mapping.images[slotIndex] : undefined;
          const boundaryRole = mappedBoundaryRole(referenceUsageContext, slotIndex);
          const assetRoleWarning = assetRoleMismatchNotice(asset, effectiveReferences[index]?.role);
          return <li className="vd-reference-row" key={reference.assetId}><span className="vd-reference-order">{slotIndex + 1}</span><button type="button" className="vd-reference-thumb" onClick={() => asset && setPreviewAsset(asset)} aria-label={`预览 ${asset?.name || '缺失图片'}`}>{asset && assetPreviewUrl(asset) ? <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /> : <span>图片缺失</span>}</button><div className="vd-reference-info"><ReferenceImageName name={asset?.name || reference.assetId} /><small className="vd-image-slot-badge">{referenceSlotLabels[index]}</small>{(!asset || asset.missing) && <span className="vd-error">{reusedSnapshot ? '原任务图片快照缺失，请明确重新选择图片' : '原文件缺失，请替换此图'}</span>}{boundaryRole && boundaryRole !== effectiveReferences[index].role && <small className="vd-reference-usage-warning">提示：旧工作流把此槽标为{imageRoleLabel(boundaryRole)}，当前分段用途为{imageRoleLabel(effectiveReferences[index].role)}；仅提示，不阻止生成。</small>}{assetRoleWarning && <small className="vd-reference-usage-warning">{assetRoleWarning}</small>}{slot && <small>工作流槽 {slotIndex + 1}：{slot.nodeId}.{slot.inputName}</small>}</div><div className="vd-reference-actions"><button type="button" className="btn small" aria-label={`移除图片 ${slotIndex + 1}`} onClick={() => patchDraft(removeVideoReference(draft, reference.assetId, effectiveReferences[index]?.role))}>移除</button></div></li>;
        })}</ol> : <div className="vd-empty">{activeApi?.provider === 'runninghub' ? '尚未选图。所有映射图片槽将明确清空；云端工作流需支持无图生成，不会沿用旧图。' : '尚未选图。支持纯文本生成的接口可以不选；ComfyUI 工作流未替换的图片槽保留原值。'}</div>}
        <VideoReferenceVacancies selection={draft} usageContext={referenceUsageContext} />
        <p className="field-hint">在“从图片资产库选择”的“槽位用途”栏中按本段设置用途；不修改原分镜或素材分类。用途不匹配只提示，不阻止生成。</p>
      </section>
    </div><div className="vd-stack">
      <section className="card vd-settings-card"><div className="card-title"><h2>3. 生成方式与参数</h2></div><div className="vd-backend-switch">{([['api', '视频 API'], ['comfyui', 'ComfyUI'], ['runninghub', 'RunningHub 云端']] as const).map(([value, label]) => <button type="button" key={value} className={`btn ${sourceKind === value ? 'primary' : ''}`} aria-pressed={sourceKind === value} onClick={() => { if (sourceKind !== value) switchParameterConnection(videoSourceDraftPatch(value, settings)); }}>{label}</button>)}</div>
        {sourceKind === 'runninghub' ? <><label className="field"><span>RunningHub 云端工作流</span><select aria-label="RunningHub 云端工作流" value={draft.runningHubWorkflowId || '__runninghub_unselected__'} onChange={(event) => switchParameterConnection({ runningHubWorkflowId: event.target.value, reuseTaskId: undefined })}>{reusedConnection?.api ? <option value={draft.runningHubWorkflowId}>原任务云端快照 · {reusedConnection.api.model}</option> : <option value="__runninghub_unselected__" disabled>请选择已保存的云端工作流</option>}{settings.runningHubVideo?.workflows.filter((item) => !(reusedConnection?.api && item.id === draft.runningHubWorkflowId)).map((item) => <option key={item.id} value={item.id} disabled={!isRunningHubVideoWorkflowReady(item)}>{item.name}</option>)}</select></label><p className="field-hint">{activeApi?.model || '尚未选择工作流'} · {activeApi?.runningHubImageRoles?.length || 0} 个图片槽；仅替换已绑定的提示词、图片和明确参数。</p>{!activeApi?.enabled && <p className="vd-notice">请在独立 RunningHub 设置中启用连接并选择工作流。</p>}{apiState.issue && <p className="vd-error">{apiState.issue}</p>}</> : draft.backend === 'api' ? <><label className="field"><span>视频 API 配置</span><select aria-label="视频 API 配置" value={reusedConnection?.api ? '__saved' : draft.apiProfileId || ''} onChange={(event) => { if (event.target.value !== '__saved') switchParameterConnection({ apiProfileId: event.target.value || undefined, reuseTaskId: undefined }); }}>{reusedConnection?.api && <option value="__saved">原任务视频 API 快照</option>}<option value="">当前视频 API 配置</option>{settings.videoApiProfiles?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><p className="field-hint">模型：{activeApi?.model || '未填写'} · {activeApi?.provider === 'minimax' ? 'MiniMax 官方协议' : '通用视频 API'}</p>{!activeApi?.enabled && <p className="vd-notice">请在视频连接设置启用此接口。</p>}{activeApi?.provider === 'minimax' && <p className="vd-notice">官方模式仅接收首帧 / 尾帧用途，不能用它代替多人物参考图。参考图不会被偷偷丢弃或改为首帧。</p>}</> : <><label className="field"><span>ComfyUI 视频工作流</span><select aria-label="ComfyUI 视频工作流" value={reusedConnection?.workflow ? '__saved' : activeWorkflow?.id || ''} onChange={(event) => { if (event.target.value !== '__saved') switchParameterConnection({ workflowId: event.target.value, reuseTaskId: undefined }); }}>{reusedConnection?.workflow && <option value="__saved">{reusedConnection.workflow.name} · 原任务工作流快照</option>}<option value="" disabled>请选择已导入的视频工作流</option>{settings.comfyuiVideo?.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label><p className="field-hint">{reusedConnection?.comfyui?.baseUrl || settings.comfyuiVideo?.baseUrl || '尚未设置连接'}<br />已绑定 {activeWorkflow?.mapping.images.length || 0} 个图片输入 · 最终输出节点 {activeWorkflow?.mapping.outputNodeId || '未绑定'}</p>{slotMismatch && <p className="vd-error">已选 {draft.references.length} 张图，但工作流只有 {activeWorkflow.mapping.images.length} 个图片槽。请调整选图或映射；不会丢掉多选的图。</p>}</>}
        {reusedConnection && <p className="vd-notice">使用原任务保存的连接与工作流快照，当前设置的修改不会影响它。主动切换上方配置后才使用新设置。</p>}
        <VideoOutputParameters scope="single" source={sourceKind} parameterText={parameterText} availableKeys={parameterKeys} {...videoOutputParameterPresentation(presentationApi, parsedParameters.value)} requiresMapping={sourceKind !== 'api' || activeApi?.provider === 'runninghub'} disabled={submitting || batchSubmitting} onChange={updateParameter} onOpenSettings={onOpenSettings} />
        <details className="vd-details"><summary>可选参数覆盖（不填保持原值）</summary><div className="vd-stack"><p className="field-hint">高级参数：默认不覆盖种子、采样、尺寸和音频连接。只填写你要改变的值；留空恢复工作流 / 接口默认值。</p><div className="vd-parameter-grid">{parameterKeys.filter((key) => !isVideoOutputParameterKey(key)).map((key) => <label className="field" key={key}><span>{{ seed: '种子', steps: '采样步数', cfg: 'CFG', fps: '帧率' }[key] || key}</span><input value={videoParameterInputText(parsedParameters.value[key])} disabled={Boolean(parsedParameters.issue)} placeholder="保留原值" onChange={(event) => updateParameter(key, event.target.value)} /></label>)}</div><label className="field"><span>额外参数 JSON（仅显式覆盖字段）</span><textarea aria-label="本次额外参数 JSON" className="vd-code" rows={5} value={parameterText} onChange={(event) => setParameterText(event.target.value)} onBlur={() => { const parsed = readVideoParameterText(parameterText); if (!parsed.issue) patchDraft({ parameters: parsed.value }); }} /></label><button type="button" className="btn small" onClick={() => { patchDraft({ parameters: {} }); setParameterText('{}'); }}>清除本次参数覆盖</button></div></details>
        <details className="vd-tracking-note"><summary>任务追踪说明</summary><p>不设置等待超时。界面只显示后端提供的真实进度和已耗时，切换页面仍继续追踪。</p></details>
        <button className="btn primary vd-generate-button" type="button" disabled={submitting || batchSubmitting || identityRepairing || singleTail.busy || tailFrameTools?.busy || sourceStale || !draft.prompt.trim() || Boolean(slotMismatch)} onClick={() => { void generate(); }}>{submitting ? '正在建立任务…' : '生成视频'}</button><p className="field-hint">点击才会提交生成，API 可能产生费用；不会自动重复提交结果不明的任务。</p>
        {error && <p className="vd-error" role="alert">{formatUserFacingError(error)}</p>}{notice && <p className="vd-success" role="status">{notice}</p>}
      </section>
    </div></div>
    {picker === 'prompt' && <VideoPickerDialog title="从提示词导演台选择提示词" className="vd-prompt-selection-dialog" onClose={() => setPicker(undefined)}>
      <div className="vd-prompt-selection-toolbar">
        <div className="vd-toolbar"><span className="field-hint">当前为单段选择；多个视频段请进入批量清单。</span><button type="button" className="btn small" onClick={() => { setPicker(undefined); setGenerationMode('batch'); }}>长剧情批量</button></div>
        <div className="vd-toolbar"><label className="field vd-grow"><span>搜索剧情、场景或段号</span><input type="search" value={promptQuery} onChange={(event) => setPromptQuery(event.target.value)} placeholder="名称、段号、提示词内容" /></label><label className="field"><span>描述语言</span><select aria-label="描述语言" value={promptLanguage} onChange={(event) => setPromptLanguage(event.target.value as 'all' | 'zh' | 'en')}><option value="all">全部已有稿件</option><option value="zh">中文</option><option value="en">英文描述</option></select></label></div>
      </div>
      <div className="vd-prompt-picker"><div className="vd-choice-list">{visibleChoices.length ? visibleChoices.map((choice) => <button type="button" className={`vd-choice ${pickedPromptId === choice.id ? 'selected' : ''}`} aria-pressed={pickedPromptId === choice.id} key={choice.id} onClick={() => setPickedPromptId(choice.id)}><strong>{choice.label}</strong><span>{choice.segmentIndex ? `长剧情 · 第 ${choice.segmentIndex} 段` : '单段'} · {choice.durationSec} 秒 · {choice.language === 'zh' ? '中文' : '英文描述'}</span><small>{choice.version} · {new Date(choice.updatedAt).toLocaleString('zh-CN')}</small></button>) : <div className="vd-empty">当前章节没有符合条件的已有提示词。</div>}</div><div className="vd-choice-preview">{pickedChoice ? <><h3>{pickedChoice.label}{pickedChoice.segmentIndex ? ` · 第 ${pickedChoice.segmentIndex} 段` : ''}</h3><pre className="vd-prompt-preview">{pickedChoice.prompt}</pre></> : <div className="vd-empty">选择一项预览完整提示词。</div>}</div></div>
      <div className="vd-modal-footer"><label className="check-row"><input type="checkbox" checked={includeReferences} onChange={(event) => setIncludeReferences(event.target.checked)} />一并带入该提示词已有的图片参考（保留当前选图）</label><button className="btn primary" type="button" disabled={!pickedChoice} onClick={() => { if (pickedChoice) { setDraft((current) => applyVideoPromptChoice(includeReferences ? { ...current, reuseTaskId: undefined } : current, pickedChoice, project, includeReferences)); setNotice('已复制所选单段提示词；一并带入的图片使用当前资产。原稿和对白未改动，也没有提交生成。'); setPicker(undefined); } }}>使用这段提示词</button></div>
    </VideoPickerDialog>}
    {picker === 'images' && <VideoPickerDialog title="从图片资产库选择生成参考图" className="vd-reference-picker-dialog" onClose={() => setPicker(undefined)}>
      <VideoReferencePickerPanels images={<>
      <div className="vd-toolbar vd-reference-picker-search"><label className="field vd-grow"><span>搜索图片资产</span><input type="search" value={imageQuery} onChange={(event) => setImageQuery(event.target.value)} placeholder="名称、文件名、标签" /></label><label className="field"><span>图片分类</span><select value={imageFilter} onChange={(event) => setImageFilter(event.target.value)}><option value="all">全部图片</option><option value="character">人物</option><option value="location">场景</option><option value="prop">道具</option><option value="reference">普通参考图</option><option value="grid">九宫格</option><option value="first-frame">首帧</option><option value="last-frame">尾帧</option><option value="clay-render">Clay Render</option></select></label></div>
      <div className="vd-batch-dialog-body">
      {reusedSnapshot && <p className="vd-notice">这里预览当前资产库图片。点击“使用所选图片”将解除原任务快照并使用当前连接，提示词和种子不变；关闭窗口则仍保留原图。</p>}
      <VideoReferenceVacancies selection={pickedSelection} usageContext={pickedUsageContext} />
      <div className="vd-image-picker-grid">{visibleImages.length ? visibleImages.map((asset) => { const selected = pickedAssetIds.includes(asset.id); const slotIndex = pickedImageDraft.references.findIndex((reference) => reference.assetId === asset.id); return <div className={`vd-image-choice ${selected ? 'selected' : ''}`} key={asset.id}><button className="vd-image-pick" type="button" aria-pressed={selected} aria-label={`${selected ? '取消选择' : '选择'}图片 ${asset.name}`} disabled={asset.missing && !selected} onClick={() => setPickedSelection((current) => selected ? removeVideoReference(current, asset.id, videoReferenceUsage(current.references, pickedUsageContext)[slotIndex]?.role) : addVideoReference(current, { assetId: asset.id, role: videoImageRole(asset) }))}>{assetPreviewUrl(asset) ? <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /> : <span>无预览</span>}<ReferenceImageName name={asset.name} /><span>{selected ? `已选 · 图片槽 ${videoReferenceSlotIndex(pickedImageDraft.references[slotIndex], slotIndex) + 1}` : asset.missing ? '原文件缺失' : `${asset.width || '?'} × ${asset.height || '?'}`}</span>{selected && slotIndex >= 0 && <span className="vd-image-slot-badge" aria-label={`图片 ${asset.name} 占用槽位`}>{pickedSlotLabels[slotIndex]}</span>}</button><button type="button" className="btn small ghost" onClick={() => setPreviewAsset(asset)}>放大预览</button></div>; }) : <div className="vd-empty">没有符合条件的图片，可先到图片资产库导入。</div>}</div>
      </div>
      </>} slots={<div className="vd-batch-dialog-body">
        <VideoReferenceSlotUsageEditor selection={pickedSelection} images={images} slotCount={pickedSlotCount} slotOffset={0} usageContext={pickedUsageContext} workflow={pickedImageWorkflow} segmentLabel="本段" project={project} onCharacterChange={(assetId, characterIds) => setPickedSelection((current) => ({ ...current, references: current.references.map((reference) => reference.assetId === assetId ? { ...reference, characterIds } : reference) }))} onRoleChange={(physicalSlot, role) => setPickedSelection((current) => { const next = videoReferenceSelection(current.references, current.referenceSlotRoles); const roles = [...(next.referenceSlotRoles || [])]; roles[physicalSlot] = role; const references = next.references.map((reference, index) => videoReferenceSlotIndex(reference, index) === physicalSlot ? { ...reference, role } : reference); return { references, referenceSlotRoles: roles }; })} onRemove={(assetId, role) => setPickedSelection((current) => removeVideoReference(current, assetId, role))} onPreview={setPreviewAsset} />
      </div>} />
      <div className="vd-modal-footer"><span>已选 {pickedAssetIds.length} 张 · 图片和槽位用途一起保存，仅用于本段</span><button className="btn primary" type="button" onClick={() => { setDraft((current) => ({ ...current, ...pickedSelection, reuseTaskId: undefined })); setNotice('已使用本段选图与用途；仅同步有明确依据的图片引用，剧情、对白、镜头时间和参数不变，不调用文本 AI。'); setPicker(undefined); }}>使用所选图片</button></div></VideoPickerDialog>}
    {previewAsset && <VideoPickerDialog title={`图片预览 · ${previewAsset.name}`} onClose={() => setPreviewAsset(undefined)}><img className="vd-full-image" src={assetPreviewUrl(previewAsset)} alt={previewAsset.name} /><p className="field-hint">{previewAsset.width || '?'} × {previewAsset.height || '?'} · {previewAsset.fileName || previewAsset.name}</p></VideoPickerDialog>}
  </div>;
}
