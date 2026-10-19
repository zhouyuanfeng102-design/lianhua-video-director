import type { AppSettings, Project, Storyboard } from './types';
import { chapterIdForStoryboard, chapterWorkspace } from './chapters';
import { emptyVideoDraft, readVideoDirectorChapterDraft } from './videoDirectorDraft';
import { videoConfiguredApiState } from './videoGenerationSource';
import { buildVideoPromptExecutionContext } from './videoPromptExecutionContext';

/** Describe the already selected destination; authoring never probes or changes it. */
export function videoPromptExecutionForStoryboard(project: Project, settings: AppSettings, board?: Storyboard,
  scope?: { chapterId?: string; sequencePlanId?: string }) {
  const chapterId = scope?.chapterId || (board && chapterIdForStoryboard(project, board)) || project.activeChapterId;
  const saved = readVideoDirectorChapterDraft(chapterWorkspace(project, chapterId).videoDirector);
  const batch = saved?.generationMode === 'batch' && saved.batch?.planId === (scope?.sequencePlanId || board?.sequencePlanId) ? saved.batch : undefined;
  const draft = batch ? { ...emptyVideoDraft(settings), backend: batch.backend, workflowId: batch.workflowId,
    apiProfileId: batch.apiProfileId, runningHubWorkflowId: batch.runningHubWorkflowId }
    : saved?.draft || emptyVideoDraft(settings);
  let parameters = draft.parameters;
  const parameterText = batch ? batch.parameterText : saved?.parameterText;
  if (parameterText) {
    try {
      const parsed: unknown = JSON.parse(parameterText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parameters = parsed as Record<string, unknown>;
    } catch { /* An unfinished form value does not replace saved request parameters. */ }
  }
  const task = draft.reuseTaskId ? project.generationTasks.find((entry) => entry.id === draft.reuseTaskId) : undefined;
  const snapshot = task && (!task.kind || task.kind === 'video') ? task.videoJob?.snapshot : undefined;
  const frozen = snapshot?.projectId === project.id && snapshot.connection.backend === draft.backend
    && snapshot.draft.workflowId === draft.workflowId && snapshot.draft.apiProfileId === draft.apiProfileId
    && snapshot.draft.runningHubWorkflowId === draft.runningHubWorkflowId ? snapshot.connection : undefined;
  const api = videoConfiguredApiState(settings, draft, frozen?.backend === 'api' ? frozen.api : undefined).api;
  const workflow = frozen?.backend === 'comfyui' ? frozen.workflow : settings.comfyuiVideo?.workflows.find((entry) =>
    entry.id === (draft.workflowId || settings.comfyuiVideo?.activeWorkflowId));
  return buildVideoPromptExecutionContext({ backend: draft.backend, api, workflow, parameters });
}
