import { useEffect, useRef } from 'react';
import { applyOwnedProjectUpdate } from './appEffects';
import { isGenerationTaskCancelledError, isGenerationTaskRevoked, runImageTask } from './generationTaskCancellation';
import { isImageGenerationTask, settleImageGenerationTask } from './generationTasks';
import { imageApiRegenerationSourceIdentity, resolveImageApiForRegeneration } from './imageApiSelection';
import { readGeneratedImageDimensions } from './imageDimensions';
import { imageReturnedSizeWarning } from './imageOutputSize';
import { requestHttp } from './services/llm';
import { isRunningHubImageObservationLive, observeRunningHubImageTask } from './services/runningHubImage';
import { createId, safeFileName, saveStateAsync } from './storage';
import type { AppState, ImageGenerationTask, ReferenceAsset } from './types';

const resumedObservations = new Set<string>();
const blockedObservations = new Map<string, string>();
const observationKey = (projectId: string, task: ImageGenerationTask): string => (
  `${projectId}\0${task.id}\0${task.createdAt}\0${task.remoteTaskId || ''}`
);
const canResume = (task: ImageGenerationTask): boolean => (
  task.status === 'running' && task.backend === 'runninghub' && Boolean(task.remoteTaskId)
);

export const resumableRunningHubImageKey = (state: AppState): string => state.projects.map((project) => (
  project.generationTasks.flatMap((task) => (
    isImageGenerationTask(task) && canResume(task) ? [observationKey(project.id, task)] : []
  )).join(',')
)).join('|') + `|${state.settings.activeImageApiProfileId || ''}|${state.settings.imageApi.activeRunningHubWorkflowId || ''}|${state.settings.imageApi.baseUrl}`;

/** Persist the accepted id before the next status query. A failed save still leaves it on the live task. */
export const recordRunningHubImageTaskId = (
  update: (updater: (state: AppState) => AppState) => void,
  getState: () => AppState,
  projectId: string,
  task: Pick<ImageGenerationTask, 'id' | 'createdAt' | 'kind'>,
) => async (remoteTaskId: string): Promise<void> => {
  update((current) => applyOwnedProjectUpdate(current, projectId, (project) => ({
    ...project,
    generationTasks: project.generationTasks.map((candidate) => (
      candidate.id === task.id && isImageGenerationTask(candidate) && candidate.createdAt === task.createdAt && candidate.status !== 'cancelled'
        ? { ...candidate, remoteTaskId, updatedAt: Date.now() }
        : candidate
    )),
  })));
  const owner = getState().project.id === projectId ? getState().project : getState().projects.find((project) => project.id === projectId);
  const live = owner?.generationTasks.find((candidate): candidate is ImageGenerationTask => (
    candidate.id === task.id && isImageGenerationTask(candidate) && candidate.createdAt === task.createdAt
  ));
  if (!live || live.status === 'cancelled' || isGenerationTaskRevoked(projectId, task) || live.remoteTaskId !== remoteTaskId) {
    throw Object.assign(new Error('图像任务已停止，没有重新提交。'), { name: 'GenerationTaskCancelledError' });
  }
  const saved = await saveStateAsync(getState(), { coalesce: 'checkpoint' });
  if (!saved.ok) throw new Error(`RunningHub 图像任务号 ${remoteTaskId} 尚未写入本地记录；原云端任务可能仍在运行，没有重新提交。`);
};

const saveObservedImage = (
  update: (updater: (state: AppState) => AppState) => void,
  projectId: string,
  task: ImageGenerationTask,
  result: { url: string; dataUrl?: string },
  managed: { url?: string; fileName?: string; relativePath?: string; checksum?: string; sizeBytes?: number; managed?: boolean } | undefined,
): boolean => {
  let saved = false;
  update((current) => applyOwnedProjectUpdate(current, projectId, (project) => {
    const live = project.generationTasks.find((candidate) => (
      candidate.id === task.id && isImageGenerationTask(candidate) && candidate.createdAt === task.createdAt
    ));
    if (!live || !isImageGenerationTask(live) || live.status !== 'running' || isGenerationTaskRevoked(projectId, live)) return project;
    const dataUrl = managed ? undefined : result.dataUrl;
    const url = managed?.url || result.url;
    if (!dataUrl && !url) return project;
    const actual = readGeneratedImageDimensions(result.dataUrl || '');
    const sizeWarning = imageReturnedSizeWarning(live, actual);
    const storyboardNote = live.assetKind === 'storyboard' ? '云端原任务已完成，图片已保存到资产库。分镜位置请按该任务的镜头确认。' : '';
    const timestamp = Date.now();
    const mimeType = result.dataUrl?.match(/^data:([^;,]+)[;,]/iu)?.[1];
    const roles = { character: 'character', location: 'scene', prop: 'prop', grid: 'grid', storyboard: 'composition', custom: 'composition' } as const;
    const asset: ReferenceAsset = {
      id: createId('asset'),
      name: live.name,
      type: live.imageVariant === 'first-frame' ? 'first-frame' : live.imageVariant === 'last-frame' ? 'last-frame'
        : live.assetKind === 'storyboard' || live.assetKind === 'custom' ? 'reference' : live.assetKind,
      role: live.imageVariant === 'first-frame' ? 'first-frame' : live.imageVariant === 'last-frame' ? 'last-frame' : roles[live.assetKind],
      dataUrl, url, mimeType,
      fileName: managed?.fileName,
      relativePath: managed?.relativePath,
      checksum: managed?.checksum,
      sizeBytes: managed?.sizeBytes,
      managed: Boolean(managed?.managed),
      missing: false,
      mediaType: 'image',
      source: 'generated',
      prompt: live.prompt,
      negativePrompt: live.negativePrompt,
      imageVariant: live.imageVariant,
      referenceScope: live.referenceScope,
      nsfwPrivatePart: live.nsfwPrivatePart,
      sourceStoryboardId: live.sourceStoryboardId,
      sourceShotId: live.sourceShotId,
      sourceEntityId: live.sourceEntityId,
      sourceEntityKind: live.assetKind === 'character' || live.assetKind === 'location' || live.assetKind === 'prop' ? live.assetKind : undefined,
      imageBackend: live.backend,
      width: actual?.width,
      height: actual?.height,
      imageRequestSize: { width: live.width, height: live.height, sizeOverride: live.sizeOverride, resolutionPlan: live.resolutionPlan },
      tags: [live.assetKind, '云端原任务'],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const attach = <T extends { id: string; assetIds: string[] }>(items: T[]): T[] => (
      live.sourceEntityId ? items.map((item) => item.id === live.sourceEntityId ? {
        ...item, assetIds: [asset.id, ...item.assetIds.filter((id) => id !== asset.id)],
      } : item) : items
    );
    saved = true;
    return {
      ...project,
      assets: [asset, ...project.assets],
      ...(live.assetKind === 'character' ? { characters: attach(project.characters) } : {}),
      ...(live.assetKind === 'location' ? { locations: attach(project.locations) } : {}),
      ...(live.assetKind === 'prop' ? { props: attach(project.props) } : {}),
      generationTasks: settleImageGenerationTask(project.generationTasks, live, {
        status: 'succeeded',
        resultAssetId: asset.id,
        resultUrl: url,
        error: undefined,
        bindingWarning: [sizeWarning, storyboardNote].filter(Boolean).join(' ') || undefined,
      }, timestamp, projectId),
    };
  }));
  return saved;
};

export const useRunningHubImageResume = ({
  ready, getState, setState, notify, resumeKey,
}: {
  ready: boolean;
  getState: () => AppState;
  setState: (updater: (state: AppState) => AppState) => void;
  notify: (message: string, tone?: 'normal' | 'error') => void;
  resumeKey: string;
}): void => {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    if (!ready) return;
    const state = getState();
    for (const project of state.projects) {
      for (const candidate of project.generationTasks) {
        if (!isImageGenerationTask(candidate) || !canResume(candidate) || !candidate.remoteTaskId) continue;
        if (isRunningHubImageObservationLive(candidate.remoteTaskId)) continue;
        const key = observationKey(project.id, candidate);
        const identity = imageApiRegenerationSourceIdentity(state.settings, candidate.imageApiSnapshot);
        if (resumedObservations.has(key) || blockedObservations.get(key) === identity) continue;
        resumedObservations.add(key);
        const task = candidate;
        const projectId = project.id;
        const remoteTaskId = candidate.remoteTaskId;
        void (async () => {
          try {
            let config;
            try { config = await resolveImageApiForRegeneration(getState().settings, task.imageApiSnapshot); }
            catch (error) {
              resumedObservations.delete(key);
              blockedObservations.set(key, identity);
              notifyRef.current(error instanceof Error ? error.message : String(error), 'error');
              return;
            }
            if (config.backend !== 'runninghub') {
              resumedObservations.delete(key);
              blockedObservations.set(key, identity);
              notifyRef.current(`原云端任务 ${remoteTaskId} 仍可能在运行。当前配置不是 RunningHub，没有重新提交。`, 'error');
              return;
            }
            const saved = await runImageTask(projectId, task, async (signal) => {
              const result = await observeRunningHubImageTask(config, remoteTaskId, {
                request: (url, init) => requestHttp(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }),
                ...(window.lianhuaDesktop?.downloadImage ? { downloadImage: (url: string) => window.lianhuaDesktop!.downloadImage(url) } : {}),
              }, signal);
              if (signal.aborted || isGenerationTaskRevoked(projectId, task)) return false;
              const managed = result.dataUrl && window.lianhuaDesktop?.storeGeneratedImage
                ? await window.lianhuaDesktop.storeGeneratedImage({ dataUrl: result.dataUrl, fileName: `${safeFileName(task.name)}.png` })
                : undefined;
              if (signal.aborted || isGenerationTaskRevoked(projectId, task)) return false;
              return saveObservedImage(setState, projectId, task, result, managed);
            });
            if (saved) notifyRef.current(`已保存云端原任务图片：${task.name}`);
          } catch (error) {
            if (isGenerationTaskCancelledError(error) || isGenerationTaskRevoked(projectId, task)) return;
            const message = error instanceof Error ? error.message : String(error);
            setState((current) => applyOwnedProjectUpdate(current, projectId, (owner) => {
              const live = owner.generationTasks.find((item) => item.id === task.id && isImageGenerationTask(item) && item.createdAt === task.createdAt);
              if (!live || !isImageGenerationTask(live) || live.status !== 'running' || isGenerationTaskRevoked(projectId, live)) return owner;
              return {
                ...owner,
                generationTasks: settleImageGenerationTask(owner.generationTasks, live, { status: 'failed', error: message }, Date.now(), projectId),
              };
            }));
            notifyRef.current(message, 'error');
          }
        })();
      }
    }
  }, [ready, resumeKey, getState, setState]);
};
