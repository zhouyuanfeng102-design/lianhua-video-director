import { isVideoGenerationTask, removeGenerationTask } from './generationTasks';
import type { Project, ReferenceAsset, VideoGenerationTask } from './types';
import type { VideoGenerationSnapshot } from './videoGenerationTypes';

type VideoProvenanceProject = Pick<Project, 'id' | 'assets' | 'generationTasks'>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const credentialKey = /^(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|api[_-]?token|client[_-]?secret|secret|password)$/iu;

/** Preserve ordinary text and JSON formatting: normal connections must retain their credential scope. */
const cloneWithoutCredentials = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) return value.map((item) => cloneWithoutCredentials(item));
  if (record(value)) return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !credentialKey.test(name))
    .map(([name, item]) => [name, cloneWithoutCredentials(item, name)]));
  if (typeof value === 'string' && ['workflowJson', 'requestTemplate', 'response', 'requestBody'].includes(key)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!record(parsed) && !Array.isArray(parsed)) return value;
      const safe = cloneWithoutCredentials(parsed);
      return JSON.stringify(safe) === JSON.stringify(parsed) ? value : JSON.stringify(safe);
    } catch { /* Older non-JSON response text remains viewable. */ }
  }
  return value;
};

/** Assets own a deep copy, not a reference to a deletable or subsequently updated task. */
export const snapshotVideoAssetSourceTask = (task: VideoGenerationTask): VideoGenerationTask => (
  cloneWithoutCredentials(task) as VideoGenerationTask
);

const videoAsset = (asset: ReferenceAsset): boolean => (
  asset.type === 'video' || asset.mediaType === 'video' || Boolean(asset.mimeType?.startsWith('video/'))
);

/** Preview the same frozen bytes that will be reused, not today's asset with
 * the same ID. No live fallback may silently show a replacement picture. */
export const frozenVideoReferenceAsset = (
  reference: VideoGenerationSnapshot['images'][number],
): ReferenceAsset => ({
  id: reference.assetId, name: reference.name, type: 'reference', role: 'composition', mediaType: 'image',
  referenceRole: reference.role, fileName: reference.fileName, relativePath: reference.relativePath,
  checksum: reference.checksum, dataUrl: reference.dataUrl,
  url: reference.relativePath
    ? `lianhua-asset://local/${reference.relativePath.replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')}`
    : reference.freezeState === 'frozen' ? undefined : reference.url,
  missing: !reference.relativePath && !reference.dataUrl && !(reference.freezeState !== 'frozen' && reference.url),
  tags: ['视频原始参考'], createdAt: reference.frozenAt || 0, updatedAt: reference.frozenAt || 0,
});

const belongsToProject = (task: VideoGenerationTask, projectId: string): boolean => (
  !task.videoJob || task.videoJob.snapshot?.projectId === projectId
);

const storedAssetTask = (project: VideoProvenanceProject, asset: ReferenceAsset): VideoGenerationTask | undefined => {
  const task = asset.videoSourceTask;
  if (!videoAsset(asset) || !task || !isVideoGenerationTask(task) || !belongsToProject(task, project.id)) return undefined;
  // A replaced/imported asset must not acquire another task's credentials through a stale ID.
  if (asset.sourceVideoTaskId && task.id !== asset.sourceVideoTaskId) return undefined;
  return task;
};

/** Lookup is scoped to one project; archived asset provenance is never put back into the task queue. */
export const findProjectVideoTask = (project: VideoProvenanceProject, taskId: string): VideoGenerationTask | undefined => {
  if (!taskId) return undefined;
  const live = project.generationTasks.find((task): task is VideoGenerationTask => (
    isVideoGenerationTask(task) && task.id === taskId && belongsToProject(task, project.id)
  ));
  if (live) return live;
  for (const asset of project.assets) {
    const stored = storedAssetTask(project, asset);
    if (stored?.id === taskId) return stored;
  }
  return undefined;
};

export const findReusableVideoTask = (project: VideoProvenanceProject, taskId: string): VideoGenerationTask | undefined => {
  const task = findProjectVideoTask(project, taskId);
  return task?.videoJob && !task.videoJob.legacyMetadataIncomplete ? task : undefined;
};

/** Prefer the final snapshot attached to the actual video; old assets can still resolve a live task. */
export const findVideoAssetSourceTask = (project: VideoProvenanceProject, asset: ReferenceAsset): VideoGenerationTask | undefined => {
  if (!videoAsset(asset)) return undefined;
  const stored = storedAssetTask(project, asset);
  if (stored) return stored;
  return project.generationTasks.find((task): task is VideoGenerationTask => (
    isVideoGenerationTask(task) && belongsToProject(task, project.id)
    && (task.id === asset.sourceVideoTaskId || task.resultAssetId === asset.id)
  ));
};

/** Backfill pre-upgrade videos only when their source task is about to be removed. */
export const preserveVideoProvenanceBeforeTaskRemoval = <TProject extends VideoProvenanceProject>(
  project: TProject, taskId: string,
): TProject => {
  const task = project.generationTasks.find((item): item is VideoGenerationTask => (
    isVideoGenerationTask(item) && item.id === taskId && belongsToProject(item, project.id)
  ));
  if (!task) return project;
  let changed = false;
  const assets = project.assets.map((asset) => {
    if (!videoAsset(asset) || (asset.sourceVideoTaskId !== taskId && asset.id !== task.resultAssetId) || storedAssetTask(project, asset)) return asset;
    changed = true;
    return {
      ...asset, sourceVideoTaskId: task.id,
      sourceStoryboardId: asset.sourceStoryboardId || task.videoJob?.snapshot.draft.source?.storyboardId || task.storyboardId || undefined,
      videoSourceTask: snapshotVideoAssetSourceTask(task),
    };
  });
  return changed ? { ...project, assets } : project;
};

/** Removing a task is independent from removing its finished video and provenance. */
export const removeVideoTaskKeepingProvenance = <TProject extends VideoProvenanceProject>(
  project: TProject, taskId: string, activeLocalTaskId = '',
): { project: TProject; removed: boolean; blocked: boolean } => {
  const result = removeGenerationTask(project.generationTasks, taskId, activeLocalTaskId);
  if (!result.removed) return { project, removed: false, blocked: result.blocked };
  const preserved = preserveVideoProvenanceBeforeTaskRemoval(project, taskId);
  return { project: { ...preserved, generationTasks: result.tasks }, removed: true, blocked: false };
};

/** Includes previous prompt versions, but never videos belonging to a different storyboard or project. */
export const relatedVideoAssets = (project: VideoProvenanceProject, storyboardId: string): ReferenceAsset[] => {
  if (!storyboardId) return [];
  return project.assets.filter((asset) => {
    if (!videoAsset(asset)) return false;
    if (asset.videoSourceTask && !belongsToProject(asset.videoSourceTask, project.id)) return false;
    const task = findVideoAssetSourceTask(project, asset);
    return asset.sourceStoryboardId === storyboardId || task?.storyboardId === storyboardId
      || task?.videoJob?.snapshot.draft.source?.storyboardId === storyboardId;
  });
};
