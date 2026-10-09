import type { GenerationTask, ImageGenerationTask, Storyboard } from './types';
import { sourceContentHash } from './sourceContentHash';

export type ImagePreparationStage = NonNullable<ImageGenerationTask['preparationStage']>;

export const normalizeImageTaskPreparationStage = (value: unknown): ImagePreparationStage | undefined => (
  value === 'identity' || value === 'reference' || value === 'frame-plan' || value === 'prompt-convert'
    ? value : undefined
);

export const imagePreparationStageLabel = (stage: ImagePreparationStage): string => ({
  identity: '解析人物与资料',
  reference: '读取参考图',
  'frame-plan': '规划分镜图片',
  'prompt-convert': '转换生图提示词',
})[stage];

/** Background preparation must not recreate a cancelled, removed or replaced task. */
export const updateImagePreparationTasks = (
  tasks: readonly GenerationTask[],
  originals: readonly ImageGenerationTask[],
  update: (task: ImageGenerationTask, index: number) => ImageGenerationTask,
): GenerationTask[] => {
  const originalsById = new Map(originals.map((task, index) => [task.id, { task, index }] as const));
  return tasks.map((task) => {
    const original = originalsById.get(task.id);
    if (task.kind !== 'image' || !original
      || task.createdAt !== original.task.createdAt || task.batchId !== original.task.batchId
      || (task.status !== 'queued' && task.status !== 'running')) return task;
    const updated = update(task, original.index);
    return { ...updated, id: task.id, kind: 'image', createdAt: task.createdAt, batchId: task.batchId };
  });
};

export const failImagePreparationTasks = (
  tasks: readonly GenerationTask[],
  originals: readonly ImageGenerationTask[],
  error: string,
  cancelled = false,
): GenerationTask[] => updateImagePreparationTasks(tasks, originals, (task) => ({
  ...task,
  status: cancelled ? 'cancelled' : 'failed',
  preparationStage: undefined,
  error,
  updatedAt: Date.now(),
}));

const stableJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
  return value;
};

/**
 * Only authored story/shot/H3 facts invalidate preparation. Image outputs,
 * reference bindings, translated deliveries and derived reports can change
 * while another batch is preparing; none replace its frozen source request.
 */
export const authoredStoryboardImageSourceFingerprint = (board: Storyboard | undefined): string => {
  if (!board) return 'authored-storyboard-image-v1-missing';
  const source = {
    id: board.id, chapterId: board.chapterId, sceneId: board.sceneId,
    sourceSceneIds: board.sourceSceneIds,
    sourceStoryTitle: board.sourceStoryTitle, sourceStoryContent: board.sourceStoryContent,
    sourceContentHash: board.sourceContentHash,
    sourceSceneSnapshots: board.sourceSceneSnapshots?.map((scene) => ({
      id: scene.id, title: scene.title, content: scene.content, summary: scene.summary,
      sourceContentHash: scene.sourceContentHash, sourceStart: scene.sourceStart, sourceEnd: scene.sourceEnd,
      characterIds: scene.characterIds, locationId: scene.locationId,
      locationIds: scene.locationIds, propIds: scene.propIds,
    })),
    workflow: board.workflow, inputMode: board.inputMode,
    durationSec: board.durationSec, durationPreset: board.durationPreset,
    shotMode: board.shotMode, shotCount: board.shotCount, pace: board.pace,
    aspectRatio: board.aspectRatio, resolution: board.resolution,
    stylePresetId: board.stylePresetId, directorStyleId: board.directorStyleId,
    directorStyleName: board.directorStyleName, directorStyleSummary: board.directorStyleSummary,
    cameraTerms: board.cameraTerms, lightingTerms: board.lightingTerms, visualStyle: board.visualStyle,
    globalLock: board.globalLock, extraRequirement: board.extraRequirement,
    creativeDirection: board.creativeDirection,
    finalPrompt: board.finalPrompt, officialPromptZh: board.officialPromptZh,
    officialPromptSource: board.officialPromptSource,
    h3IdentityBindings: board.h3IdentityBindings, h3CharacterParticipation: board.h3CharacterParticipation,
    continuityIn: board.continuityIn, continuityOut: board.continuityOut,
    shots: board.shots.map((shot) => ({
      id: shot.id, index: shot.index, startSec: shot.startSec, endSec: shot.endSec,
      purpose: shot.purpose, subject: shot.subject, action: shot.action, camera: shot.camera,
      transition: shot.transition, lighting: shot.lighting, sound: shot.sound, result: shot.result,
      sourceBeatIds: shot.sourceBeatIds, sourceStart: shot.sourceStart, sourceEnd: shot.sourceEnd,
      sourceLocationStatus: shot.sourceLocationStatus, sourceExcerpt: shot.sourceExcerpt,
      space: shot.space, performance: shot.performance, direction: shot.direction, dialogue: shot.dialogue,
      prompt: shot.prompt, nsfwContinuity: shot.nsfwContinuity,
      visiblePrivatePartsByCharacter: shot.visiblePrivatePartsByCharacter,
    })),
  };
  return `authored-storyboard-image-v1-${sourceContentHash(JSON.stringify(stableJson(source)))}`;
};
