import { isVideoGenerationTask } from './generationTasks';
import { sourceContentHash } from './sourceIntegrity';
import { resolveConfiguredVideoApi } from './runningHubVideo';
import { offsetVideoReferenceSlotRoles, videoReferenceUsage, type VideoReferenceUsageContext } from './videoReferenceUsage';
import { assertVideoReferenceSlots, videoReferenceSlotIndex } from './videoReferenceSlots';
import { prepareVideoH3ReferenceDraft, type VideoH3ReferenceContext } from './videoH3ReferenceBinding';
import type { VideoAudioReference } from './videoAudioTypes';
import type {
  AppState,
  AppSettings,
  Project,
  ReferenceAsset,
  VideoGenerationTask,
  VideoSequencePlan,
} from './types';
import {
  applyVideoPromptChoice,
  emptyVideoDraft,
  videoPromptChoices,
  type VideoPromptChoice,
} from './videoDirectorDraft';
import type {
  VideoGenerationDraft,
  VideoGenerationDesktop,
  VideoImageReference,
  VideoGenerationSnapshot,
  VideoBatchItemInput,
  VideoBatchTailPlacement,
  VideoBatchStartInput,
  VideoPromptFormat,
} from './videoGenerationTypes';

export type VideoPromptChoiceKey = `${string}:zh` | `${string}:en`;
export type VideoBatchLanguageFilter = 'all' | 'zh' | 'en';
export type VideoBatchDuplicateKind = 'in-flight' | 'succeeded';

export interface VideoBatchDuplicateMatch {
  kind: VideoBatchDuplicateKind;
  taskId: string;
  status: VideoGenerationTask['status'];
}

export interface VideoBatchChoiceCandidate {
  key: VideoPromptChoiceKey;
  storyboardId: string;
  sequencePlanId: string;
  segmentId: string;
  segmentIndex: number;
  language: 'zh' | 'en';
  choice: VideoPromptChoice;
  draft: VideoGenerationDraft;
  promptFingerprint: string;
  referenceFingerprint: string;
  requestFingerprint: string;
  duplicate?: VideoBatchDuplicateMatch;
}

export interface VideoBatchRow {
  id: string;
  sequencePlanId: string;
  segmentId: string;
  index: number;
  segmentIndex: number;
  title: string;
  durationSec: number;
  storyboardId?: string;
  zh?: VideoBatchChoiceCandidate;
  en?: VideoBatchChoiceCandidate;
}

export interface VideoBatchBuildOptions {
  promptFormat?: VideoPromptFormat;
  /** Segment-specific format selection, independent of language/connection. */
  promptFormats?: Readonly<Record<string, VideoPromptFormat>>;
  includeStoryboardReferences?: boolean;
  backend?: VideoGenerationDraft['backend'];
  apiProfileId?: string;
  runningHubWorkflowId?: string;
  workflowId?: string;
  parameters?: Record<string, unknown>;
  /** Exact per-language, ordered bindings selected in the batch UI. An empty
   * array explicitly means text-only for that item. */
  referenceOverrides?: Partial<Record<VideoPromptChoiceKey, readonly VideoImageReference[]>>;
}

const projectsInState = (state: Pick<AppState, 'project' | 'projects'>): Project[] => [
  state.project,
  ...state.projects.filter((project) => project.id !== state.project.id),
];

const readableManagedImage = async (
  desktop: Pick<VideoGenerationDesktop, 'readManagedImageDataUrl'>,
  image: { name?: string; relativePath: string; checksum?: string },
  itemIndex: number,
): Promise<void> => {
  let loaded: Awaited<ReturnType<VideoGenerationDesktop['readManagedImageDataUrl']>>;
  try {
    loaded = await desktop.readManagedImageDataUrl({
      relativePath: image.relativePath,
      expectedChecksum: image.checksum,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`批量第 ${itemIndex + 1} 项的托管图片“${image.name || image.relativePath}”无法读取：${detail}`);
  }
  if (!loaded.dataUrl?.startsWith('data:image/')) {
    throw new Error(`批量第 ${itemIndex + 1} 项的托管图片“${image.name || image.relativePath}”不是可用图片。`);
  }
};

/**
 * Read every managed image before the batch engine is allowed to create or
 * submit any task. `missing` is only cached metadata; this check detects a file
 * that disappeared on disk while the asset record still says it exists.
 *
 * Browser-only and remote URL images have no managed-file bridge and remain
 * covered by the engine's normal per-item pixel freeze.
 */
export const preflightVideoBatchManagedReferences = async (
  state: Pick<AppState, 'project' | 'projects' | 'settings'>,
  input: Pick<VideoBatchStartInput, 'projectId' | 'items' | 'force'>,
  desktop?: Pick<VideoGenerationDesktop, 'readManagedImageDataUrl'>,
): Promise<void> => {
  if (!desktop?.readManagedImageDataUrl) return;
  const project = projectsInState(state).find((candidate) => candidate.id === input.projectId);
  if (!project) throw new Error('批量视频所属项目已不存在。');
  const reads = new Map<string, {
    image: { name?: string; relativePath: string; checksum?: string };
    itemIndex: number;
  }>();
  // A dependency batch cannot be classified by any row's standalone hash.
  // Its final request identity includes the exact preceding selected task.
  const hasDependencies = input.items.some((item) => item.previousTail !== undefined);
  input.items.forEach((item, itemIndex) => {
    const draft = item.draft;
    const duplicate = !hasDependencies ? findVideoBatchDuplicate(project, videoBatchRequestFingerprint(
      draft,
      project.assets,
      videoBatchConnectionIdentity(state.settings, draft),
      item.previousTail?.placement.mode === 'prepend' ? 1 : 0,
    )) : undefined;
    if (duplicate?.kind === 'in-flight'
      || duplicate?.kind === 'succeeded' && !(input.force || item.force)) return;
    const reusedTask = draft.reuseTaskId
      ? project.generationTasks.find((candidate): candidate is VideoGenerationTask => (
          isVideoGenerationTask(candidate) && candidate.id === draft.reuseTaskId
        ))
      : undefined;
    const reused = reusedTask?.videoJob?.snapshot;
    const validReuse = reused
      && reused.projectId === project.id
      && reused.connection.backend === draft.backend
      && reused.draft.workflowId === draft.workflowId
      && reused.draft.apiProfileId === draft.apiProfileId
      ? reused
      : undefined;
    const tail = item.previousTail;
    if (tail !== undefined && !validVideoBatchPreviousTail(tail)) throw new Error(`批量第 ${itemIndex + 1} 项自动尾帧配置无效。`);
    const finalReferences = tail ? videoBatchTailReferences(draft.references, tail.placement, '__future-tail__') : draft.references;
    finalReferences.forEach((reference, referenceIndex) => {
      // Only inspect retained inputs. A confirmed one-image replacement must
      // not read stale/missing storyboard selections that will not be sent.
      if (tail && referenceIndex === tail.placement.index) return;
      const frozen = validReuse?.images.find((image) => image.assetId === reference.assetId);
      const image = frozen || project.assets.find((asset) => asset.id === reference.assetId);
      if (!image) throw new Error(`批量第 ${itemIndex + 1} 项所选图片已不存在。`);
      if ('missing' in image && image.missing) {
        throw new Error(`批量第 ${itemIndex + 1} 项的图片“${image.name}”文件丢失，请重新关联素材。`);
      }
      if (!image.relativePath) return;
      const readKey = `${image.relativePath}\n${image.checksum || ''}`;
      if (!reads.has(readKey)) {
        reads.set(readKey, {
          image: {
            name: image.name,
            relativePath: image.relativePath,
            checksum: image.checksum,
          },
          itemIndex,
        });
      }
    });
  });
  // Read sequentially so a long story does not materialize every high-resolution
  // data URL in renderer memory at the same time.
  for (const { image, itemIndex } of reads.values()) {
    await readableManagedImage(desktop, image, itemIndex);
  }
};

type FingerprintAsset = Pick<
  ReferenceAsset,
  'id' | 'checksum' | 'dataUrl' | 'relativePath' | 'url' | 'updatedAt' | 'missing'
>;

const secretKey = /^(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|api[_-]?token|client[_-]?secret|secret|password)$/iu;
const volatileConnectionKey = /^(?:id|name|createdAt|updatedAt|activeWorkflowId)$/u;

const record = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const stableStringify = (value: unknown): string => JSON.stringify(canonicalValue(value));
const fingerprint = (kind: string, value: unknown): string => (
  `${kind}-v1-${sourceContentHash(stableStringify(value)).slice('src-v1-'.length)}`
);

const cloneParameters = (value: Record<string, unknown> | undefined): Record<string, unknown> => (
  value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
);

const removeSecretsAndVolatileMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeSecretsAndVolatileMetadata);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKey.test(key) && !volatileConnectionKey.test(key))
    .map(([key, item]) => [key, removeSecretsAndVolatileMetadata(item)]));
};

const parsedWorkflow = (workflowJson: string | undefined): unknown => {
  if (!workflowJson) return undefined;
  try { return JSON.parse(workflowJson) as unknown; } catch { return workflowJson; }
};

const semanticWorkflow = (workflow: unknown): unknown => {
  if (!record(workflow)) return workflow;
  return {
    workflow: workflow.workflow !== undefined
      ? workflow.workflow
      : parsedWorkflow(typeof workflow.workflowJson === 'string' ? workflow.workflowJson : undefined),
    mapping: workflow.mapping,
  };
};

const semanticConnection = (connection: unknown): unknown => {
  if (!record(connection)) return connection;
  const backend = connection.backend;
  if (backend === 'comfyui') {
    return canonicalValue({
      backend,
      comfyui: removeSecretsAndVolatileMetadata(connection.comfyui),
      workflow: semanticWorkflow(connection.workflow),
    });
  }
  // UI ranges/choices do not change the cloud request or historical identity.
  const api = record(connection.api)
    ? Object.fromEntries(Object.entries(connection.api).filter(([key]) => key !== 'runningHubParameterControls'))
    : connection.api;
  // Empty-slot encoding adds no selected image or new workflow identity.
  // Keep pre-0.7.7 completed/in-flight fingerprints stable so a software
  // upgrade alone cannot turn the same selection into another paid request.
  const semanticApi = record(api) && api.provider === 'runninghub' && Array.isArray(api.runningHubMappedFields)
    ? { ...api, runningHubMappedFields: api.runningHubMappedFields.flatMap((field) => {
      // Automatic application compatibility must not make completed/in-flight
      // selections look new after an upgrade. Actual selected images already
      // participate in the fingerprint; explicit count bindings still differ.
      if (record(field) && field.kind === 'image-count' && field.imageCountSource === 'verified-app') return [];
      if (!record(field) || field.kind !== 'image') return [field];
      const { emptyValue: _emptyValue, ...identity } = field;
      return [identity];
    }) } : api;
  return canonicalValue({
    backend,
    api: removeSecretsAndVolatileMetadata(semanticApi),
  });
};

const assetContentIdentity = (asset: FingerprintAsset | undefined, assetId: string): string => {
  if (!asset) return `missing:${assetId}`;
  if (asset.missing) return `missing:${assetId}`;
  if (asset.checksum?.trim()) return `checksum:${asset.checksum.trim()}`;
  if (asset.dataUrl?.startsWith('data:image/') || asset.dataUrl?.startsWith('data:audio/')) {
    return `data:${sourceContentHash(asset.dataUrl)}`;
  }
  if (asset.relativePath?.trim()) {
    return `path:${asset.relativePath.replace(/\\/gu, '/')}@${asset.updatedAt || 0}`;
  }
  if (asset.url?.trim()) return `url:${asset.url.trim()}@${asset.updatedAt || 0}`;
  return `unreadable:${assetId}@${asset.updatedAt || 0}`;
};

const referenceManifest = (
  references: VideoGenerationDraft['references'],
  assets: readonly FingerprintAsset[],
): Array<{ assetId: string; role: string; content: string; slotIndex?: number }> => {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return references.map((reference, index) => ({
    assetId: reference.assetId,
    role: reference.role,
    content: assetContentIdentity(assetsById.get(reference.assetId), reference.assetId),
    // Continuous explicit slots are semantically identical to legacy drafts.
    // Only displaced references extend the old fingerprint representation.
    ...(videoReferenceSlotIndex(reference, index) !== index ? { slotIndex: videoReferenceSlotIndex(reference, index) } : {}),
  }));
};

const snapshotReferenceManifest = (
  snapshot: VideoGenerationSnapshot,
): Array<{ assetId: string; role: string; content: string; slotIndex?: number }> => {
  const imagesById = new Map(snapshot.images.map((image) => [image.assetId, image]));
  return videoReferenceUsage(snapshot.draft.references, {
    ...snapshot.connection,
    slotRoles: snapshot.draft.referenceSlotRoles,
  }).map((reference, index) => {
    const image = imagesById.get(reference.assetId);
    return {
      assetId: reference.assetId,
      role: reference.role,
      content: assetContentIdentity(image ? {
        id: image.assetId,
        checksum: image.checksum,
        dataUrl: image.dataUrl,
        relativePath: image.relativePath,
        url: image.url,
        updatedAt: image.frozenAt || 0,
        missing: false,
      } : undefined, reference.assetId),
      ...(videoReferenceSlotIndex(reference, index) !== index ? { slotIndex: videoReferenceSlotIndex(reference, index) } : {}),
    };
  });
};

/** Physical audio inputs are independent of image positions. Empty audio
 * selections add no key, preserving all historical image-only identities. */
const audioReferenceManifest = (
  references: readonly VideoAudioReference[],
  assets: readonly FingerprintAsset[],
) => {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return references.map((reference) => ({
    assetId: reference.assetId,
    bindingId: reference.bindingId,
    slotIndex: reference.slotIndex,
    target: reference.target,
    retainMode: reference.retainMode,
    ...(reference.notes !== undefined ? { notes: reference.notes } : {}),
    content: assetContentIdentity(assetsById.get(reference.assetId), reference.assetId),
  })).sort((left, right) => left.slotIndex - right.slotIndex || left.bindingId.localeCompare(right.bindingId));
};

const snapshotAudioManifest = (snapshot: VideoGenerationSnapshot) => (snapshot.audios || [])
  .map((audio) => audioReferenceManifest([audio], [{
    id: audio.assetId, checksum: audio.checksum, dataUrl: audio.dataUrl,
    relativePath: audio.relativePath, url: audio.url, updatedAt: audio.frozenAt || 0,
  }])[0])
  .sort((left, right) => left.slotIndex - right.slotIndex || left.bindingId.localeCompare(right.bindingId));

export const videoPromptChoiceKey = (
  storyboardId: string,
  language: 'zh' | 'en',
  promptFormat?: VideoPromptFormat,
): VideoPromptChoiceKey => promptFormat ? `${storyboardId}:${promptFormat}:${language}` : `${storyboardId}:${language}`;

export const videoBatchPromptFingerprint = (
  choice: Pick<VideoPromptChoice, 'storyboardId' | 'language' | 'prompt' | 'promptFormat'>,
): string => fingerprint('video-prompt', {
  key: videoPromptChoiceKey(choice.storyboardId, choice.language, choice.promptFormat),
  language: choice.language,
  prompt: choice.prompt,
});

export const videoBatchReferenceFingerprint = (
  draft: Pick<VideoGenerationDraft, 'references' | 'audioReferences'>,
  assets: readonly ReferenceAsset[],
): string => fingerprint('video-reference', draft.audioReferences?.length
  ? { images: referenceManifest(draft.references, assets), audios: audioReferenceManifest(draft.audioReferences, assets) }
  : referenceManifest(draft.references, assets));

export const videoBatchConnectionIdentity = (
  settings: AppSettings,
  draft: Pick<VideoGenerationDraft, 'backend' | 'apiProfileId' | 'workflowId' | 'runningHubWorkflowId'> & Partial<Pick<VideoGenerationDraft, 'parameters'>>,
): unknown => {
  if (draft.backend === 'comfyui') {
    const comfyui = settings.comfyuiVideo;
    const workflow = comfyui?.workflows.find((item) => item.id === (
      draft.workflowId || comfyui.activeWorkflowId
    )) || (!draft.workflowId ? comfyui?.workflows[0] : undefined);
    return semanticConnection({
      backend: 'comfyui',
      comfyui: comfyui ? {
        enabled: comfyui.enabled,
        baseUrl: comfyui.baseUrl,
        promptPath: comfyui.promptPath,
      } : undefined,
      workflow,
    });
  }
  if (draft.runningHubWorkflowId !== undefined) {
    try { return semanticConnection({ backend: 'api', api: resolveConfiguredVideoApi(settings, { ...draft, parameters: draft.parameters || {} }) }); }
    catch { return semanticConnection({ backend: 'api', api: { provider: 'runninghub', missingWorkflow: draft.runningHubWorkflowId } }); }
  }
  const api = draft.apiProfileId
    ? settings.videoApiProfiles?.find((item) => item.id === draft.apiProfileId)
    : settings.videoTaskApi;
  return semanticConnection({ backend: 'api', api });
};

export const videoBatchRequestFingerprint = (
  draft: VideoGenerationDraft,
  assets: readonly ReferenceAsset[],
  connectionIdentity: unknown,
  referenceOffset = 0,
): string => fingerprint('video-request', {
  sourceKey: draft.source?.storyboardId
    ? videoPromptChoiceKey(draft.source.storyboardId, draft.source.language || 'zh', draft.source.promptFormat)
    : undefined,
  language: draft.source?.language || 'zh',
  prompt: draft.prompt,
  references: referenceManifest(referenceUsageForConnection(draft, connectionIdentity, referenceOffset), assets),
  ...(draft.audioReferences?.length ? { audios: audioReferenceManifest(draft.audioReferences, assets) } : {}),
  backend: draft.backend,
  connection: semanticConnection(connectionIdentity),
  parameters: draft.parameters,
});

/** The public connection identity retains mappings but may omit workflow
 * metadata. Read only the mapping here; the structural submit checks still
 * validate nodes, image counts, files and the selected connection. */
const referenceUsageForConnection = (
  draft: Pick<VideoGenerationDraft, 'backend' | 'references' | 'referenceSlotRoles'>,
  connectionIdentity: unknown,
  offset: number,
): VideoImageReference[] => {
  const connection = record(connectionIdentity) ? connectionIdentity : {};
  const workflow = record(connection.workflow) && record(connection.workflow.mapping)
    && Array.isArray(connection.workflow.mapping.images) ? connection.workflow : undefined;
  const api = record(connection.api) ? connection.api : undefined;
  return videoReferenceUsage(draft.references, {
    backend: draft.backend,
    workflow: workflow as unknown as VideoReferenceUsageContext['workflow'],
    api: api as VideoReferenceUsageContext['api'],
    slotRoles: offsetVideoReferenceSlotRoles(draft.referenceSlotRoles, offset),
  }, offset);
};

const snapshotRequestFingerprint = (snapshot: VideoGenerationSnapshot): string => fingerprint('video-request', {
  sourceKey: snapshot.draft.source?.storyboardId
    ? videoPromptChoiceKey(snapshot.draft.source.storyboardId, snapshot.draft.source.language || 'zh', snapshot.draft.source.promptFormat)
    : undefined,
  language: snapshot.draft.source?.language || 'zh',
  prompt: snapshot.draft.prompt,
  references: snapshotReferenceManifest(snapshot),
  ...(snapshot.audios?.length ? { audios: snapshotAudioManifest(snapshot) } : {}),
  backend: snapshot.draft.backend,
  connection: semanticConnection(snapshot.connection),
  parameters: snapshot.draft.parameters,
});

export const videoTaskRequestFingerprint = (
  task: VideoGenerationTask,
): string | undefined => {
  const stored = (task as VideoGenerationTask & { requestFingerprint?: unknown }).requestFingerprint;
  if (typeof stored === 'string' && stored.trim()) return stored;
  const snapshot = task.videoJob?.snapshot;
  if (!snapshot?.draft.prompt.trim()) return undefined;
  return snapshotRequestFingerprint(snapshot);
};

/** Keep durable fingerprints and dependency IDs untouched. For a legacy
 * standalone/first-segment snapshot only, the same mapped pixels also match
 * their normalized boundary usage, so upgrading cannot authorize a duplicate
 * paid request. A child dependency must still match its exact stored chain. */
export const videoTaskMatchesRequestFingerprint = (task: VideoGenerationTask, requestFingerprint: string): boolean => {
  if (videoTaskRequestFingerprint(task) === requestFingerprint) return true;
  const snapshot = task.videoJob?.snapshot;
  if (!snapshot?.draft.prompt.trim() || snapshot.previousTail || snapshot.batchPredecessorTaskId) return false;
  const usage = videoReferenceUsage(snapshot.draft.references, {
    ...snapshot.connection,
    slotRoles: snapshot.draft.referenceSlotRoles,
  });
  if (!usage.some((reference, index) => reference.role !== snapshot.draft.references[index].role)) return false;
  return snapshotRequestFingerprint(snapshot) === requestFingerprint;
};

/** A cancelled preparation that never crossed the durable POST boundary is not
 * an in-flight request. It cannot be resumed in place, but a newly confirmed
 * batch is allowed to create a fresh task for the same request. */
export const cancelledVideoBatchTaskBeforePost = (task: VideoGenerationTask): boolean => (
  // Pre-.123 cancellations can retain draft/submitting, but an unknown task
  // is never proof that no billable POST happened (including damaged imports).
  ['failed', 'draft', 'submitting'].includes(task.status)
  && task.videoJob?.batchQueueState === 'cancelled'
  && task.videoJob.preparation?.version === 1
  && task.videoJob.preparation.phase === 'preparing'
  && !task.remoteTaskId
  && task.response === undefined
  && !task.resultUrl
  && !task.resultAssetId
  && !task.videoJob.submittedAt
);

/** Chain intent is part of idempotency: the same prompt and image set must not
 * be reused when it is now required to inherit a different predecessor tail. */
export const videoBatchDependencyFingerprint = (
  requestFingerprint: string,
  dependency: Pick<VideoBatchItemInput, 'previousTail'>['previousTail'] | undefined,
  predecessorRequestFingerprint?: string,
): string => dependency
  ? fingerprint('video-request-chain', {
      requestFingerprint,
      predecessorItemKey: dependency.predecessorItemKey,
      placement: dependency.placement,
      ...(dependency.selectionMode === 'ai-assisted' ? { selectionMode: 'ai-assisted' } : {}),
      ...(dependency.requireAiSelection ? { requireAiSelection: true } : {}),
      ...(predecessorRequestFingerprint ? { predecessorRequestFingerprint } : {}),
    })
  : requestFingerprint;

export const validVideoBatchPreviousTail = (
  value: VideoBatchItemInput['previousTail'],
): value is NonNullable<VideoBatchItemInput['previousTail']> => {
  if (!value || typeof value !== 'object' || !value.placement || typeof value.placement !== 'object') return false;
  return typeof value.predecessorItemKey === 'string'
    && Boolean(value.predecessorItemKey.trim())
    && (value.selectionMode === undefined || value.selectionMode === 'ai-assisted')
    && (value.requireAiSelection === undefined || value.requireAiSelection === true && value.selectionMode === 'ai-assisted')
    && validVideoBatchTailPlacement(value.placement);
};

const validVideoBatchTailPlacement = (placement: VideoBatchTailPlacement): boolean => Boolean(placement)
  && Number.isInteger(placement.index) && placement.index >= 0
  && (placement.slotIndex === undefined || Number.isSafeInteger(placement.slotIndex) && placement.slotIndex >= 0)
  && ['append', 'replace', 'replace-all', 'prepend'].includes(placement.mode)
  && ['first-frame', 'composition', 'general'].includes(placement.role)
  && (placement.mode !== 'prepend' || placement.index === 0 && placement.replacedAssetId === undefined && placement.replacedReferences === undefined)
  && (placement.mode !== 'replace' || typeof placement.replacedAssetId === 'string' && Boolean(placement.replacedAssetId))
  && (placement.mode !== 'replace-all' || placement.index === 0 && Array.isArray(placement.replacedReferences)
    && placement.replacedReferences.length > 1 && placement.replacedReferences.every((reference) => reference
      && typeof reference.assetId === 'string' && Boolean(reference.assetId) && typeof reference.role === 'string'));

/** Shared by UI preflight, managed-file checks, and frozen-task construction.
 * Uses only the selection explicitly reviewed; original assets are untouched. */
export const videoBatchTailReferences = (
  references: readonly VideoImageReference[], placement: VideoBatchTailPlacement, tailAssetId: string,
): VideoImageReference[] => {
  if (!validVideoBatchTailPlacement(placement)) throw new Error('尾帧图片槽已失效，请重新确认。');
  assertVideoReferenceSlots(references);
  const targetSlot = placement.slotIndex ?? (placement.mode === 'replace'
    ? videoReferenceSlotIndex(references[placement.index] || { assetId: '', role: placement.role }, placement.index)
    : placement.index);
  const tail: VideoImageReference = { assetId: tailAssetId, role: placement.role,
    ...(targetSlot === placement.index ? {} : { slotIndex: targetSlot }) };
  if (placement.mode === 'prepend') {
    if (references.some((reference) => reference.assetId === tailAssetId)) throw new Error('该尾帧已在本段选图中，不能重复添加。');
    if (targetSlot !== 0) throw new Error('本地衔接帧必须放在第 1 个图片槽。');
    // The selected additional references are relative to their own first slot.
    // Dense legacy selections still infer positions from their new indices.
    return [tail, ...references.map((reference) => ({ ...reference,
      ...(reference.slotIndex === undefined ? {} : { slotIndex: reference.slotIndex + 1 }) }))];
  }
  if (placement.mode === 'replace-all') {
    if (targetSlot !== 0) throw new Error('尾帧图片槽已失效，请重新确认。');
    if (references.length !== placement.replacedReferences!.length || references.some((reference, index) => {
      const reviewed = placement.replacedReferences![index];
      return reference.assetId !== reviewed.assetId || reference.role !== reviewed.role
        || videoReferenceSlotIndex(reference, index) !== videoReferenceSlotIndex(reviewed, index);
    })) throw new Error('本段参考图已变化，请重新确认整体替换。');
    return [tail];
  }
  if (placement.mode === 'append' ? placement.index !== references.length
    : placement.index >= references.length || references[placement.index]?.assetId !== placement.replacedAssetId
      || targetSlot !== videoReferenceSlotIndex(references[placement.index], placement.index)) {
    throw new Error(placement.mode === 'replace' ? '尾帧替换位置已改变，图片槽已失效，请重新选择。' : '尾帧图片槽已失效，请重新选择。');
  }
  const next = references.map((reference) => ({ ...reference }));
  if (placement.mode === 'append') next.push(tail); else next[placement.index] = tail;
  assertVideoReferenceSlots(next);
  return next;
};

const inFlightVideoTask = (task: VideoGenerationTask): boolean => {
  if (cancelledVideoBatchTaskBeforePost(task) || task.status === 'failed') return false;
  if (task.status === 'succeeded') {
    // Remote success precedes the local save. Until an asset exists, a live
    // download is still in flight and must match the engine's duplicate gate.
    return task.videoJob?.stage === 'downloading' && !task.resultAssetId;
  }
  return ['submitting', 'submitted', 'running', 'unknown'].includes(task.status)
    || Boolean(task.videoJob && [
      'preparing', 'submitting', 'queued', 'running', 'reconnecting', 'downloading',
      'submission-unknown',
    ].includes(task.videoJob.stage));
};

export const findVideoBatchDuplicate = (
  project: Pick<Project, 'generationTasks'>,
  requestFingerprint: string,
): VideoBatchDuplicateMatch | undefined => {
  let succeeded: VideoBatchDuplicateMatch | undefined;
  for (const item of project.generationTasks) {
    if (!isVideoGenerationTask(item)) continue;
    if (!videoTaskMatchesRequestFingerprint(item, requestFingerprint)) continue;
    if (inFlightVideoTask(item)) {
      return { kind: 'in-flight', taskId: item.id, status: item.status };
    }
    if (!succeeded && item.status === 'succeeded') {
      succeeded = { kind: 'succeeded', taskId: item.id, status: item.status };
    }
  }
  return succeeded;
};

const isolatedDraft = (
  settings: AppSettings,
  options: VideoBatchBuildOptions,
): VideoGenerationDraft => {
  const empty = emptyVideoDraft(settings);
  return {
    ...empty,
    name: '',
    prompt: '',
    source: undefined,
    references: [],
    parameters: cloneParameters(options.parameters),
    backend: options.backend || empty.backend,
    apiProfileId: options.apiProfileId === undefined
      ? empty.apiProfileId
      : options.apiProfileId || undefined,
    runningHubWorkflowId: options.runningHubWorkflowId === undefined
      ? options.backend === undefined ? empty.runningHubWorkflowId : undefined
      : options.runningHubWorkflowId || undefined,
    workflowId: options.workflowId === undefined
      ? empty.workflowId
      : options.workflowId || undefined,
    reuseTaskId: undefined,
  };
};

const buildChoiceCandidate = (
  project: Project,
  plan: VideoSequencePlan,
  segment: VideoSequencePlan['segments'][number],
  choice: VideoPromptChoice,
  settings: AppSettings,
  options: VideoBatchBuildOptions,
): VideoBatchChoiceCandidate => {
  let draft = applyVideoPromptChoice(
    isolatedDraft(settings, options),
    choice,
    project,
    options.includeStoryboardReferences !== false,
  );
  draft = {
    ...draft,
    name: `${draft.name || choice.label} · ${choice.language === 'zh' ? '中文' : 'English'}`,
  };
  const override = options.referenceOverrides?.[
    videoPromptChoiceKey(choice.storyboardId, choice.language, choice.promptFormat)
  ];
  if (override) {
    const seen = new Set<string>();
    draft = {
      ...draft,
      references: override.flatMap((reference) => {
        // Preserve an explicitly selected missing/wrong-media ID so the engine's
        // all-items preflight fails loudly instead of silently submitting fewer
        // references than the user reviewed.
        if (seen.has(reference.assetId)) return [];
        seen.add(reference.assetId);
        return [{ ...reference }];
      }),
    };
  }
  draft = prepareVideoH3ReferenceDraft(project, draft, videoBatchConnectionIdentity(settings, draft) as VideoH3ReferenceContext).draft;
  const promptFingerprint = videoBatchPromptFingerprint(choice);
  const referenceFingerprint = videoBatchReferenceFingerprint(draft, project.assets);
  const requestFingerprint = videoBatchRequestFingerprint(
    draft,
    project.assets,
    videoBatchConnectionIdentity(settings, draft),
  );
  return {
    key: videoPromptChoiceKey(choice.storyboardId, choice.language, choice.promptFormat),
    storyboardId: choice.storyboardId,
    sequencePlanId: plan.id,
    segmentId: segment.id,
    segmentIndex: segment.index,
    language: choice.language,
    choice,
    draft,
    promptFingerprint,
    referenceFingerprint,
    requestFingerprint,
    duplicate: findVideoBatchDuplicate(project, requestFingerprint),
  };
};

/** Build one row per real sequence segment. Only the storyboard currently linked
 * by that segment is eligible; the master and orphaned historical boards never
 * enter the batch. Each language starts from its own empty draft. */
export const buildVideoBatchRows = (
  project: Project,
  plan: VideoSequencePlan,
  settings: AppSettings,
  options: VideoBatchBuildOptions = {},
): VideoBatchRow[] => {
  const selectedFormats = new Set<VideoPromptFormat | undefined>([options.promptFormat, ...Object.values(options.promptFormats || {})]);
  const choices = [...selectedFormats].flatMap((format) => videoPromptChoices(project, undefined, format));
  const choicesByKey = new Map(choices.map((choice) => [
    videoPromptChoiceKey(choice.storyboardId, choice.language, choice.promptFormat),
    choice,
  ]));
  const storyboardsById = new Map(project.storyboards.map((board) => [board.id, board]));
  return plan.segments
    .map((segment, originalIndex) => ({ segment, originalIndex }))
    .sort((left, right) => left.segment.index - right.segment.index
      || left.originalIndex - right.originalIndex)
    .map(({ segment }) => {
      const storyboard = segment.storyboardId
        ? storyboardsById.get(segment.storyboardId)
        : undefined;
      const validStoryboard = storyboard
        && storyboard.id !== plan.masterStoryboardId
        && (!storyboard.sequencePlanId || storyboard.sequencePlanId === plan.id)
        && (!storyboard.segmentId || storyboard.segmentId === segment.id)
        ? storyboard
        : undefined;
      const zhChoice = validStoryboard
        ? choicesByKey.get(videoPromptChoiceKey(validStoryboard.id, 'zh', options.promptFormats?.[segment.id] || options.promptFormat))
        : undefined;
      const enChoice = validStoryboard
        ? choicesByKey.get(videoPromptChoiceKey(validStoryboard.id, 'en', options.promptFormats?.[segment.id] || options.promptFormat))
        : undefined;
      return {
        id: segment.id,
        sequencePlanId: plan.id,
        segmentId: segment.id,
        index: segment.index,
        segmentIndex: segment.index,
        title: segment.title,
        durationSec: segment.durationSec,
        storyboardId: validStoryboard?.id,
        zh: zhChoice
          ? buildChoiceCandidate(project, plan, segment, zhChoice, settings, options)
          : undefined,
        en: enChoice
          ? buildChoiceCandidate(project, plan, segment, enChoice, settings, options)
          : undefined,
      };
    });
};

const choicesForLanguage = (
  rows: readonly VideoBatchRow[],
  language: VideoBatchLanguageFilter,
): VideoBatchChoiceCandidate[] => rows.flatMap((row) => (
  language === 'zh' ? row.zh ? [row.zh] : []
    : language === 'en' ? row.en ? [row.en] : []
      : [row.zh, row.en].filter((choice): choice is VideoBatchChoiceCandidate => Boolean(choice))
));

export const allVideoBatchChoiceKeys = (
  rows: readonly VideoBatchRow[],
  language: VideoBatchLanguageFilter = 'all',
): Set<VideoPromptChoiceKey> => new Set(
  choicesForLanguage(rows, language).map((choice) => choice.key),
);

export const ungeneratedVideoBatchChoiceKeys = (
  rows: readonly VideoBatchRow[],
  language: VideoBatchLanguageFilter = 'all',
): Set<VideoPromptChoiceKey> => new Set(
  choicesForLanguage(rows, language)
    .filter((choice) => !choice.duplicate)
    .map((choice) => choice.key),
);

export const toggleVideoBatchChoice = (
  selection: ReadonlySet<VideoPromptChoiceKey>,
  key: VideoPromptChoiceKey,
): Set<VideoPromptChoiceKey> => {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};
