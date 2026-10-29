import { isVideoGenerationTask } from './generationTasks';
import type { AppState } from './types';
import { videoTaskHasUnresolvedSubmission, videoTaskStoppedLocally } from './videoGenerationQueue';

/**
 * Count work that should block closing the app.
 *
 * A locally stopped video task no longer blocks closing. Its remote identity
 * and unresolved status remain available for history/recovery, but the user
 * explicitly ended local tracking and should not be forced to account for it
 * again at exit.
 */
export const countOpenGenerationTasks = (
  source: Pick<AppState, 'project' | 'projects'>,
): number => {
  const seen = new Set<string>();
  let count = 0;
  for (const project of [source.project, ...(source.projects || [])]) {
    if (!project?.id || seen.has(project.id)) continue;
    seen.add(project.id);
    for (const task of project.generationTasks || []) {
      if (isVideoGenerationTask(task)) {
        if (!videoTaskStoppedLocally(task) && videoTaskHasUnresolvedSubmission(task)) count += 1;
      } else if (task.status === 'queued' || task.status === 'running') {
        count += 1;
      }
    }
  }
  return count;
};
