import type { AppState, Project } from './types';
import { withChapterWorkspace } from './chapters';
import type { VideoDirectorChapterDraft } from './videoDirectorDraft';

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const sameFields = (left: object, right: object, ignored: ReadonlySet<string>): boolean => {
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => !ignored.has(key));
  return keys.length === Object.keys(b).filter((key) => !ignored.has(key)).length
    && keys.every((key) => own(b, key) && a[key] === b[key]);
};
const workspaceDraft = new Set(['videoDirector']);
const projectEditor = new Set(['chapterWorkspaces', 'updatedAt']);

/** A video form edit changes its owner, not the source material used by candidates. */
export function sameVideoDirectorContent(left: Project, right: Project): boolean {
  if (left === right) return true;
  if (!sameFields(left, right, projectEditor)) return false;
  const a = left.chapterWorkspaces || {}, b = right.chapterWorkspaces || {};
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) if (a[id] !== b[id] && !sameFields(a[id] || {}, b[id] || {}, workspaceDraft)) return false;
  return true;
}

export function createVideoDirectorProjectSelector() {
  let previous: Project | undefined;
  return (project: Project): Project => {
    if (!previous || !sameVideoDirectorContent(previous, project)) previous = project;
    return previous;
  };
}

export function updateVideoDirectorChapterDraft(state: AppState, projectId: string, chapterId: string, draft: VideoDirectorChapterDraft): AppState {
  const owner = state.project.id === projectId ? state.project : state.projects.find((project) => project.id === projectId);
  if (!owner || owner.chapterWorkspaces?.[chapterId]?.videoDirector === draft) return state;
  const updated = withChapterWorkspace(owner, { videoDirector: draft }, chapterId);
  if (updated === owner) return state;
  return { ...state, project: state.project.id === projectId ? updated : state.project,
    projects: state.projects.map((project) => project.id === projectId ? updated : project) };
}

/** Form drafts are current editor state. Rebase them once on history navigation,
 * rather than rewriting every undo/redo snapshot on each option click. */
export function withCurrentVideoDirectorDrafts(target: AppState, current: AppState): AppState {
  const owners = new Map(current.projects.map((project) => [project.id, project]));
  owners.set(current.project.id, current.project);
  const rebased = new Map<string, Project>();
  const rebase = (project: Project): Project => {
    const cached = rebased.get(project.id);
    if (cached) return cached;
    const owner = owners.get(project.id);
    if (!owner || owner === project) { rebased.set(project.id, project); return project; }
    let next = project;
    for (const chapter of project.sourceDocuments) {
      const workspace = owner.chapterWorkspaces?.[chapter.id];
      if (!workspace || !own(workspace, 'videoDirector')) continue;
      if (next.chapterWorkspaces?.[chapter.id]?.videoDirector !== workspace.videoDirector) {
        next = withChapterWorkspace(next, { videoDirector: workspace.videoDirector }, chapter.id);
      }
    }
    if (own(owner, 'customVideoDraft') && next.customVideoDraft !== owner.customVideoDraft) next = { ...next, customVideoDraft: owner.customVideoDraft };
    rebased.set(project.id, next);
    return next;
  };
  const project = rebase(target.project);
  const projects = target.projects.map(rebase);
  return project === target.project && projects.every((owner, index) => owner === target.projects[index])
    ? target : { ...target, project, projects };
}

/** Only inputs read by task reconciliation participate; no task/asset scan. */
export function createVideoReconcileSelector() {
  let inputs: unknown[] = [];
  let token = {};
  return (state: AppState): object => {
    const projects = new Map(state.projects.map((project) => [project.id, project]));
    projects.set(state.project.id, state.project);
    const next: unknown[] = [state.project.id, state.settings.videoExecutionMode, state.settings.videoExecutionConcurrency];
    for (const [id, project] of projects) next.push(id, project.generationTasks, project.assets);
    if (next.length !== inputs.length || next.some((value, index) => value !== inputs[index])) { inputs = next; token = {}; }
    return token;
  };
}

export type VideoRowMemo<T> = Map<string, { inputs: readonly unknown[]; value: T }>;
export function rememberVideoRow<T>(cache: VideoRowMemo<T>, key: string, inputs: readonly unknown[], build: () => T): T {
  const previous = cache.get(key);
  if (previous && previous.inputs.length === inputs.length && inputs.every((value, index) => value === previous.inputs[index])) return previous.value;
  const value = build();
  cache.set(key, { inputs, value });
  return value;
}
