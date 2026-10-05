import type {
  AutofillGenerationTask,
  GenerationTask,
  ImageGenerationTask,
  VideoGenerationTask,
} from './types';
import { applyOwnedProjectUpdate } from './appEffects';
import { isGenerationTaskRevoked } from './generationTaskCancellation';
import { videoTaskDeletionBlocked } from './videoTaskDeletionSafety';

export {
  GenerationTaskCancelledError,
  isGenerationTaskCancelledError,
  isGenerationTaskRevoked,
  revokeQueuedGenerationTask,
} from './generationTaskCancellation';

type NewImageGenerationTask = Omit<
  ImageGenerationTask,
  'kind' | 'status' | 'resultUrl' | 'resultAssetId' | 'error' | 'createdAt' | 'updatedAt'
>;

export type ImageGenerationTaskPatch = Partial<Pick<
  ImageGenerationTask,
  | 'status'
  | 'prompt'
  | 'resultUrl'
  | 'resultAssetId'
  | 'error'
  | 'bindingWarning'
  | 'imagePromptRuleSetId'
  | 'imagePromptRuleSetName'
  | 'imagePromptRuleSetVersion'
  | 'imagePromptPresetId'
  | 'imagePromptPresetName'
  | 'imagePromptPresetVersion'
  | 'imagePromptFormat'
>>;

export type ImageGenerationTaskSettlement = ImageGenerationTaskPatch & {
  status: 'succeeded' | 'failed';
};

type NewAutofillGenerationTask = Omit<
  AutofillGenerationTask,
  'kind' | 'status' | 'result' | 'bindingWarning' | 'error' | 'createdAt' | 'updatedAt'
>;

export type AutofillGenerationTaskPatch = Partial<Pick<
  AutofillGenerationTask,
  'status' | 'result' | 'error' | 'bindingWarning'
>>;

export type AutofillGenerationTaskSettlement = AutofillGenerationTaskPatch & {
  status: 'succeeded' | 'failed';
};

export interface AutofillBindingIdentity {
  projectId: string;
  assetKind: AutofillGenerationTask['assetKind'];
  selectedEntityId: string;
  targetEpoch: number;
  taskId: string;
}

export interface AutofillTargetChange {
  selectedEntityId: string;
  fieldKey?: string;
  previousValue?: string;
  nextValue?: string;
  targetReplaced?: boolean;
}

/**
 * Unsaved manual records have no entity ID, so their name and reset actions
 * define target identity. Ordinary field completion remains within the same
 * target and must not invalidate an in-flight result.
 */
export const advanceAutofillTargetEpoch = (
  currentEpoch: number,
  change: AutofillTargetChange,
): number => {
  const manualNameChanged = (
    !change.selectedEntityId
    && change.fieldKey === 'name'
    && String(change.previousValue ?? '') !== String(change.nextValue ?? '')
  );
  return change.targetReplaced || manualNameChanged
    ? currentEpoch + 1
    : currentEpoch;
};

/** Compare explicit request facts, not their meaning. Other form fields can
 * still be filled while AI runs; missing-field merging preserves those edits. */
const IMAGE_AUTOFILL_BASIS_FIELDS = new Set([
  'name', 'race', 'morphology', 'bodyPlan', 'gender', 'age', 'actualAge',
  'height', 'appearance', 'anchor',
]);

export const imageAutofillBasisFieldChanged = (
  field: string,
  previous: string | undefined,
  next: string | undefined,
): boolean => IMAGE_AUTOFILL_BASIS_FIELDS.has(field)
  && String(previous || '').trim() !== String(next || '').trim();

export const imageAutofillBasisChanged = (
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): boolean => [...IMAGE_AUTOFILL_BASIS_FIELDS].some((field) => (
  imageAutofillBasisFieldChanged(field, previous[field], next[field])
));

export const AUTOFILL_BASIS_CHANGED_WARNING =
  '种族、外貌形态或身体结构等资料依据已修改，旧补齐结果仅保留在任务记录中，未回填资料。请按新资料重新补齐。';

type GenerationTaskOwningProject = {
  id: string;
  updatedAt: number;
  generationTasks: GenerationTask[];
};

type GenerationTaskOwningState<TProject extends GenerationTaskOwningProject> = {
  project: TProject;
  projects: TProject[];
  activeProjectId: string;
};

export const AUTOFILL_RESULT_NOT_APPLIED_WARNING =
  'AI 补齐已完成，但因项目、资料对象或工作台会话已切换，结果未自动应用。请返回原资料重新执行补齐。';

export const isImageGenerationTask = (
  task: GenerationTask,
): task is ImageGenerationTask => task.kind === 'image';

export const isAutofillGenerationTask = (
  task: GenerationTask,
): task is AutofillGenerationTask => task.kind === 'autofill';

export const isVideoGenerationTask = (
  task: GenerationTask,
): task is VideoGenerationTask => task.kind == null || task.kind === 'video';

/** Display only. Controllers and provenance lookups must retain all records. */
export const isVisibleGenerationTask = (task: GenerationTask): boolean => (
  !isVideoGenerationTask(task) || task.historyOnly !== true || videoTaskDeletionBlocked(task)
);

export const createImageGenerationTask = (
  input: NewImageGenerationTask,
  timestamp = Date.now(),
  status: ImageGenerationTask['status'] = 'running',
): ImageGenerationTask => ({
  ...input,
  kind: 'image',
  status,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const patchImageGenerationTask = (
  tasks: readonly GenerationTask[],
  taskId: string,
  patch: ImageGenerationTaskPatch,
  timestamp = Date.now(),
): GenerationTask[] => tasks.map((task) => (
  task.id === taskId && isImageGenerationTask(task) && task.status !== 'cancelled'
    ? {
        ...task,
        ...patch,
        id: task.id,
        kind: 'image',
        createdAt: task.createdAt,
        updatedAt: timestamp,
      }
    : task
));

/**
 * Persist a terminal worker result even when undo removed its queued task.
 * The settled record prevents redo from reviving a permanently-running copy
 * and keeps any non-binding warning visible in the task center.
 */
export const settleImageGenerationTask = (
  tasks: readonly GenerationTask[],
  originalTask: ImageGenerationTask,
  patch: ImageGenerationTaskSettlement,
  timestamp = Date.now(),
  projectId?: string,
): GenerationTask[] => {
  if (projectId && isGenerationTaskRevoked(projectId, originalTask)) return [...tasks];
  const settledTask: ImageGenerationTask = {
    ...originalTask,
    ...patch,
    id: originalTask.id,
    kind: 'image',
    createdAt: originalTask.createdAt,
    updatedAt: timestamp,
  };
  let replaced = false;
  const nextTasks = tasks.map((task) => {
    if (task.id !== originalTask.id || !isImageGenerationTask(task)) return task;
    replaced = true;
    if (task.status === 'cancelled' || task.createdAt !== originalTask.createdAt) return task;
    return {
      ...task,
      ...settledTask,
      createdAt: task.createdAt,
    };
  });
  return replaced ? nextTasks : [settledTask, ...nextTasks];
};

export interface GenerationTaskRemovalResult {
  tasks: GenerationTask[];
  removed: boolean;
  blocked: boolean;
}

export interface GenerationTaskCancellationResult {
  tasks: GenerationTask[];
  cancelled: boolean;
  blocked: boolean;
}

/** Only queued local work can be cancelled without risking an in-flight billable request. */
export const cancelQueuedGenerationTask = (
  tasks: GenerationTask[],
  taskId: string,
  timestamp = Date.now(),
): GenerationTaskCancellationResult => {
  const target = tasks.find((task) => task.id === taskId);
  if (!target) return { tasks, cancelled: false, blocked: false };
  if ((!isImageGenerationTask(target) && !isAutofillGenerationTask(target)) || target.status !== 'queued') {
    return { tasks, cancelled: false, blocked: target.status !== 'cancelled' };
  }
  return {
    tasks: tasks.map((task) => task === target ? {
      ...target, status: 'cancelled', error: undefined, bindingWarning: undefined, updatedAt: timestamp,
    } : task),
    cancelled: true,
    blocked: false,
  };
};

/** Keep executing workers addressable; queued tasks may be revoked and deleted immediately. */
export const removeGenerationTask = (
  tasks: GenerationTask[],
  taskId: string,
  activeLocalTaskId = '',
): GenerationTaskRemovalResult => {
  const target = tasks.find((task) => task.id === taskId);
  if (!target) return { tasks, removed: false, blocked: false };
  const localWorkInFlight = (
    target.id === activeLocalTaskId
    || (isVideoGenerationTask(target) && target.status === 'submitting')
    || (
      (isImageGenerationTask(target) || isAutofillGenerationTask(target))
      && target.status === 'running'
    )
  );
  if (localWorkInFlight) return { tasks, removed: false, blocked: true };
  return {
    tasks: tasks.filter((task) => task.id !== taskId),
    removed: true,
    blocked: false,
  };
};

export const createAutofillGenerationTask = (
  input: NewAutofillGenerationTask,
  timestamp = Date.now(),
  status: AutofillGenerationTask['status'] = 'running',
): AutofillGenerationTask => ({
  ...input,
  kind: 'autofill',
  status,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const patchAutofillGenerationTask = (
  tasks: readonly GenerationTask[],
  taskId: string,
  patch: AutofillGenerationTaskPatch,
  timestamp = Date.now(),
): GenerationTask[] => tasks.map((task) => (
  task.id === taskId && isAutofillGenerationTask(task) && task.status !== 'cancelled'
    ? {
        ...task,
        ...patch,
        id: task.id,
        kind: 'autofill',
        createdAt: task.createdAt,
        updatedAt: timestamp,
      }
    : task
));

/** Preserve a terminal AI-autofill record even when undo removed its running task. */
export const settleAutofillGenerationTask = (
  tasks: readonly GenerationTask[],
  originalTask: AutofillGenerationTask,
  patch: AutofillGenerationTaskSettlement,
  timestamp = Date.now(),
  projectId?: string,
): GenerationTask[] => {
  if (projectId && isGenerationTaskRevoked(projectId, originalTask)) return [...tasks];
  const settledTask: AutofillGenerationTask = {
    ...originalTask,
    ...patch,
    id: originalTask.id,
    kind: 'autofill',
    createdAt: originalTask.createdAt,
    updatedAt: timestamp,
  };
  let replaced = false;
  const nextTasks = tasks.map((task) => {
    if (task.id !== originalTask.id || !isAutofillGenerationTask(task)) return task;
    replaced = true;
    if (task.status === 'cancelled' || task.createdAt !== originalTask.createdAt) return task;
    return {
      ...task,
      ...settledTask,
      createdAt: task.createdAt,
    };
  });
  return replaced ? nextTasks : [settledTask, ...nextTasks];
};

export const addAutofillGenerationTaskToOwningProject = <
  TProject extends GenerationTaskOwningProject,
  TState extends GenerationTaskOwningState<TProject>,
>(
  current: TState,
  requestedProjectId: string,
  task: AutofillGenerationTask,
  timestamp = Date.now(),
): TState => applyOwnedProjectUpdate(
  current,
  requestedProjectId,
  (project) => ({
    ...project,
    generationTasks: [task, ...(project.generationTasks || [])],
  }),
  timestamp,
);

export const patchAutofillGenerationTaskForOwningProject = <
  TProject extends GenerationTaskOwningProject,
  TState extends GenerationTaskOwningState<TProject>,
>(
  current: TState,
  requestedProjectId: string,
  taskId: string,
  patch: AutofillGenerationTaskPatch,
  timestamp = Date.now(),
): TState => applyOwnedProjectUpdate(
  current,
  requestedProjectId,
  (project) => ({
    ...project,
    generationTasks: patchAutofillGenerationTask(
      project.generationTasks || [],
      taskId,
      patch,
      timestamp,
    ),
  }),
  timestamp,
);

export const completeAutofillGenerationTaskForOwningProject = <
  TProject extends GenerationTaskOwningProject,
  TState extends GenerationTaskOwningState<TProject>,
>(
  current: TState,
  requestedProjectId: string,
  taskId: string,
  result: Record<string, string>,
  appliedToForm: boolean,
  timestamp = Date.now(),
): TState => patchAutofillGenerationTaskForOwningProject(
  current,
  requestedProjectId,
  taskId,
  {
    status: 'succeeded',
    result,
    error: undefined,
    bindingWarning: appliedToForm ? undefined : AUTOFILL_RESULT_NOT_APPLIED_WARNING,
  },
  timestamp,
);

export const canApplyAutofillResult = (
  requested: AutofillBindingIdentity,
  current: AutofillBindingIdentity,
  workbenchMounted: boolean,
): boolean => Boolean(
  workbenchMounted
  && requested.projectId === current.projectId
  && requested.assetKind === current.assetKind
  && requested.selectedEntityId === current.selectedEntityId
  && requested.targetEpoch === current.targetEpoch
  && requested.taskId === current.taskId
);

export const imageGenerationStatusLabel = (
  status: ImageGenerationTask['status'],
): string => ({
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
})[status];

export const autofillGenerationStatusLabel = (
  status: AutofillGenerationTask['status'],
): string => ({
  queued: '排队中',
  running: '补齐中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
})[status];

export const imageAssetKindLabel = (
  kind: ImageGenerationTask['assetKind'],
): string => ({
  character: '人物角色',
  location: '场景',
  prop: '物品',
  grid: '九宫格',
  storyboard: '剧情分镜',
})[kind];
