import type { AppSettings, Project, ReferenceAsset, ReferenceRole, Storyboard, StoryboardImageFrameMetadata, VideoGenerationTask } from './types';
import type { VideoGenerationDraft, VideoGenerationRuntime, VideoImageReference } from './videoGenerationTypes';
import { addVideoReference, moveVideoReference, removeVideoReference, videoReferenceSelection } from './videoReferenceSlots';
import { hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt, isOfficialH3TargetId } from './officialPrompt';
import { officialH3ContextForStoryboard } from './officialH3Context';
import { videoH3BindingForPrompt } from './videoH3ReferenceBinding';
import {
  canUseNsfwPrivateProfileAssetForStoryboardShot,
  isNsfwPrivateProfileAsset,
} from './nsfwPrivateAssets';

export interface VideoDirectorLaunchRequest {
  id: string;
  storyboardId?: string;
  language?: 'zh' | 'en';
  assetIds?: string[];
  /** Workbench frame roles apply to this launch only, never mutate the image asset. */
  referenceRoleOverrides?: Record<string, ReferenceRole>;
  taskId?: string;
  /** Failed members of one prior batch to review in the long-story batch UI.
   * This is only a navigation/prefill request; it must never submit by itself. */
  batchTaskIds?: string[];
}

export interface VideoPromptChoice {
  id: string;
  storyboardId: string;
  label: string;
  language: 'zh' | 'en';
  prompt: string;
  durationSec: number;
  updatedAt: number;
  segmentIndex?: number;
  version: string;
}

const isVideoDirectorVisualAsset = (asset: ReferenceAsset): boolean => (
  asset.mediaType !== 'video' && asset.mediaType !== 'audio'
  && asset.type !== 'video' && asset.type !== 'audio'
  && !asset.mimeType?.startsWith('video/') && !asset.mimeType?.startsWith('audio/')
);

/** Manual video references should match the image asset library surface. */
export const isVideoDirectorImage = (asset: ReferenceAsset): boolean => isVideoDirectorVisualAsset(asset);

export const videoImageRole = (asset: ReferenceAsset): ReferenceRole => {
  if (asset.referenceRole && !['unknown', 'audio', 'dialogue'].includes(asset.referenceRole)) return asset.referenceRole;
  if (asset.role === 'grid') return 'composition';
  if (asset.role !== 'audio') return asset.role;
  return 'general';
};

export const videoPromptChoices = (project: Project): VideoPromptChoice[] => (
  [...project.storyboards].sort((left, right) => right.updatedAt - left.updatedAt).flatMap((board) => {
    const label = board.sourceStoryTitle || project.scenes.find((scene) => scene.id === board.sceneId)?.title || '未命名剧情';
    const revision = board.revisions?.find((item) => item.id === board.activeRevisionId);
    const h3 = isOfficialH3TargetId(board.targetModelId);
    const context = officialH3ContextForStoryboard(project, board);
    const currentH3 = h3 && hasCurrentOfficialH3Prompt(board, context);
    // An H3 board is only selectable when its saved official delivery is
    // current.  Falling back to finalPrompt here silently sends the ordinary
    // six-field/canonical source text through an H3 workflow, where it is not
    // a valid H3 artifact.  Manual text entry and historical task snapshots
    // do not use this picker and remain untouched.
    const zh = h3 ? currentH3 ? board.officialPromptZh : undefined : board.officialPromptZh || board.finalPrompt;
    const matchesSource = (source: string | undefined, candidate: string | undefined, fingerprint?: string): candidate is string => Boolean(
      source?.trim() && candidate?.trim() && (!fingerprint || fingerprint === source),
    );
    const en = h3 ? hasCurrentOfficialH3EnglishPrompt(board, context) ? board.officialPromptEn : undefined
      : matchesSource(board.officialPromptZh, board.officialPromptEn, board.officialPromptEnSource) ? board.officialPromptEn
        : matchesSource(board.finalPrompt, board.englishPrompt, board.englishPromptSource) && matchesSource(zh, board.englishPrompt) ? board.englishPrompt : undefined;
    const version = `${revision?.label || (revision?.revision ? `版本 ${revision.revision}` : '当前版本')}${h3 && !currentH3 ? ' · 结构化原稿（H3 交付稿需更新）' : ''}`;
    return ([['zh', zh], ['en', en]] as const).filter(([, prompt]) => Boolean(prompt?.trim())).map(([language, prompt]) => ({
      id: `${board.id}:${language}`,
      storyboardId: board.id,
      label,
      language,
      prompt: prompt!,
      durationSec: board.durationSec,
      updatedAt: board.updatedAt,
      segmentIndex: board.segmentIndex,
      version,
    }));
  })
);

export const emptyVideoDraft = (settings: AppSettings): VideoGenerationDraft => ({
  name: '', prompt: '', backend: settings.videoBackend || 'api', references: [], parameters: {},
  ...(settings.videoSource === 'runninghub' ? { backend: 'api' as const, runningHubWorkflowId: settings.runningHubVideo?.activeWorkflowId || '__runninghub_unselected__' } : {}),
  apiProfileId: settings.activeVideoApiProfileId || undefined,
  workflowId: settings.comfyuiVideo?.activeWorkflowId || undefined,
});

export const addVideoDraftAssets = (
  draft: VideoGenerationDraft, assetIds: string[], assets: ReferenceAsset[],
): VideoGenerationDraft => {
  let selection = videoReferenceSelection(draft.references, draft.referenceSlotRoles);
  for (const assetId of assetIds) {
    if (selection.references.some((reference) => reference.assetId === assetId)) continue;
    const asset = assets.find((candidate) => candidate.id === assetId);
    if (asset && isVideoDirectorImage(asset)) selection = addVideoReference(selection, { assetId, role: videoImageRole(asset) });
  }
  return { ...draft, ...selection };
};

export const applyVideoReferenceRoleOverrides = (
  draft: VideoGenerationDraft, overrides: Record<string, ReferenceRole> | undefined,
): VideoGenerationDraft => {
  if (!overrides || !Object.keys(overrides).length) return draft;
  const boundaryRoles = new Set(Object.values(overrides).filter((role) => role === 'first-frame' || role === 'last-frame'));
  let selection = videoReferenceSelection(draft.references, draft.referenceSlotRoles);
    // A new start-frame replaces only a former start-frame slot, not character
    // or composition references. The original source board remains untouched.
  for (const reference of draft.references) {
    if (!Object.prototype.hasOwnProperty.call(overrides, reference.assetId) && boundaryRoles.has(reference.role as 'first-frame' | 'last-frame')) selection = removeVideoReference(selection, reference.assetId);
  }
  selection = videoReferenceSelection(selection.references.map((reference) => ({ ...reference, role: overrides[reference.assetId] || reference.role })), selection.referenceSlotRoles);
  return { ...draft, reuseTaskId: undefined, ...selection };
};

const addScopedVideoDraftAssets = (
  draft: VideoGenerationDraft,
  assetIds: readonly string[],
  assets: readonly ReferenceAsset[],
  scopedPrivateAssetIds: ReadonlySet<string>,
): VideoGenerationDraft => {
  let selection = videoReferenceSelection(draft.references, draft.referenceSlotRoles);
  for (const assetId of assetIds) {
    if (selection.references.some((reference) => reference.assetId === assetId)) continue;
    const asset = assets.find((candidate) => candidate.id === assetId);
    if (!asset || !isVideoDirectorVisualAsset(asset)) continue;
    if (isNsfwPrivateProfileAsset(asset) && !scopedPrivateAssetIds.has(asset.id)) continue;
    selection = addVideoReference(selection, { assetId, role: videoImageRole(asset) });
  }
  return { ...draft, ...selection };
};

const hasCustomStoryboardFrameSlot = (image: StoryboardImageFrameMetadata): boolean => (
  Number.isInteger(image.imageFrameIndex) && (image.imageFrameIndex || 0) > 0
  && Number.isInteger(image.imageFrameCount) && (image.imageFrameCount || 0) >= (image.imageFrameIndex || 0)
);

/** Custom still batches are storyboard outputs, not automatic video inputs.
 * A batch id alone is not enough: ordinary per-shot runs also carry one.
 * Keep legacy/ordinary references when their custom-output provenance is unknown. */
const automaticCustomStoryboardImageIds = (board: Storyboard, project: Project): Set<string> => {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const ids = new Set(project.assets.filter((asset) => (
    asset.source === 'generated' && asset.sourceStoryboardId === board.id
    && asset.imageVariant === 'storyboard-frame' && hasCustomStoryboardFrameSlot(asset)
  )).map((asset) => asset.id));
  // Some historical/imported assets lack frame metadata; a successful task can
  // prove their exact origin. Never override conflicting asset provenance.
  for (const task of project.generationTasks || []) {
    if (task.kind !== 'image' || task.status !== 'succeeded' || task.assetKind !== 'storyboard'
      || task.imageVariant !== 'storyboard-frame' || task.sourceStoryboardId !== board.id
      || !task.resultAssetId || !hasCustomStoryboardFrameSlot(task)) continue;
    const asset = assetsById.get(task.resultAssetId);
    if (!asset || (asset.source && asset.source !== 'generated')
      || (asset.sourceStoryboardId && asset.sourceStoryboardId !== board.id)
      || (asset.imageVariant && asset.imageVariant !== 'storyboard-frame')
      || asset.sourceEntityId || asset.sourceEntityKind) continue;
    ids.add(asset.id);
  }
  return ids;
};

/** Copies one saved segment, never rewrites its text or mutates the storyboard. */
export const applyVideoPromptChoice = (
  draft: VideoGenerationDraft, choice: VideoPromptChoice, project: Project, includeReferences: boolean,
): VideoGenerationDraft => {
  const board = project.storyboards.find((item) => item.id === choice.storyboardId);
  if (!board) return draft;
  const label = `${choice.label}${choice.segmentIndex ? ` · 第 ${choice.segmentIndex} 段` : ''}`;
  const next: VideoGenerationDraft = {
    ...draft, name: label, prompt: choice.prompt, h3ReferenceBinding: undefined,
    source: {
      storyboardId: board.id, sequencePlanId: board.sequencePlanId, segmentId: board.segmentId,
      segmentIndex: board.segmentIndex, language: choice.language,
      promptVersion: board.activeRevisionId || board.updatedAt, label,
    },
  };
  next.h3ReferenceBinding = videoH3BindingForPrompt(project, next);
  if (!includeReferences) return next;
  const explicitReferenceIds = new Set([
    ...(board.globalReferenceAssetIds || []),
    ...(board.firstFrameAssetId ? [board.firstFrameAssetId] : []),
    ...(board.lastFrameAssetId ? [board.lastFrameAssetId] : []),
  ]);
  const automaticCustomImageIds = automaticCustomStoryboardImageIds(board, project);
  const referenceIds = [
    ...(board.globalReferenceAssetIds || []), ...(board.promptPlan?.referenceAssetIds || []),
    ...(board.promptTrace?.referenceAssetIds || []),
    ...board.shots.flatMap((shot) => shot.referenceAssetIds || []),
    ...(board.firstFrameAssetId ? [board.firstFrameAssetId] : []),
    ...(board.lastFrameAssetId ? [board.lastFrameAssetId] : []),
  ].filter((id) => explicitReferenceIds.has(id) || !automaticCustomImageIds.has(id));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const scopedPrivateAssetIds = new Set<string>();
  const allowPrivateForShot = (assetId: string, shot: Storyboard['shots'][number] | undefined) => {
    if (!shot) return;
    const asset = assetsById.get(assetId);
    if (!asset || !isNsfwPrivateProfileAsset(asset)) return;
    if (canUseNsfwPrivateProfileAssetForStoryboardShot(
      asset,
      board,
      shot,
      project.characters,
    )) scopedPrivateAssetIds.add(assetId);
  };
  board.shots.forEach((shot) => shot.referenceAssetIds.forEach((id) => allowPrivateForShot(id, shot)));
  allowPrivateForShot(board.firstFrameAssetId || '', board.shots[0]);
  allowPrivateForShot(board.lastFrameAssetId || '', board.shots[board.shots.length - 1]);
  const withReferences = addScopedVideoDraftAssets(
    next,
    referenceIds,
    project.assets,
    scopedPrivateAssetIds,
  );
  // Explicit storyboard boundary bindings are copied as-is; other references keep their own role.
  withReferences.references = withReferences.references.map((reference) => (
    reference.assetId === board.firstFrameAssetId ? { ...reference, role: 'first-frame' }
      : reference.assetId === board.lastFrameAssetId ? { ...reference, role: 'last-frame' } : reference
  ));
  withReferences.referenceSlotRoles = videoReferenceSelection(
    withReferences.references,
    withReferences.referenceSlotRoles,
  ).referenceSlotRoles;
  return withReferences;
};

export const reorderVideoReference = (references: VideoImageReference[], index: number, delta: number): VideoImageReference[] => {
  return moveVideoReference(references, index, delta);
};

export const draftFromVideoTask = (task: VideoGenerationTask): VideoGenerationDraft | undefined => {
  if (task.videoJob?.legacyMetadataIncomplete) return undefined;
  const draft = task.videoJob?.snapshot.draft;
  if (!draft) return undefined;
  return {
    ...draft, reuseTaskId: task.id, source: draft.source ? { ...draft.source } : undefined,
    references: structuredClone(draft.references),
    h3ReferenceBinding: draft.h3ReferenceBinding ? structuredClone(draft.h3ReferenceBinding) : undefined,
    parameters: JSON.parse(JSON.stringify(draft.parameters)) as Record<string, unknown>,
  };
};

export const videoStoryboardLabel = (board: Storyboard): string => (
  `${board.sourceStoryTitle || '提示词'}${board.segmentIndex ? ` · 第 ${board.segmentIndex} 段` : ''}`
);

export const formatVideoElapsed = (milliseconds: number): string => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}小时 ${minutes}分 ${seconds}秒` : `${minutes}分 ${seconds}秒`;
};

/** Execution-only duration. A queued task has no duration until startedAt is
 * observed; successful generation freezes when the backend output appears. */
export const videoExecutionElapsedMs = (
  runtime: Pick<VideoGenerationRuntime, 'startedAt' | 'generatedAt' | 'completedAt'> | undefined,
  now: number,
  terminalAt?: number,
): number | undefined => {
  if (typeof runtime?.startedAt !== 'number' || !Number.isFinite(runtime.startedAt)) return undefined;
  const end = runtime.generatedAt ?? runtime.completedAt ?? terminalAt ?? now;
  return Math.max(0, end - runtime.startedAt);
};
