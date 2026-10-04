type BackgroundProject = {
  id: string;
  updatedAt: number;
  backgroundSuspended?: boolean;
};

type BackgroundWorkspace = {
  project: BackgroundProject;
  projects: BackgroundProject[];
  activeProjectId: string;
};

/** Only mark the latest owner record. Captured project objects must never
 * replace newer background task results or assets when a button is clicked. */
export const setProjectBackgroundSuspended = <TState extends BackgroundWorkspace>(
  current: TState,
  projectId: string,
  suspended: boolean,
  updatedAt = Date.now(),
): TState => {
  if (!projectId) return current;
  const owner = current.project.id === projectId
    ? current.project
    : current.projects.find((project) => project.id === projectId);
  if (!owner || Boolean(owner.backgroundSuspended) === suspended) return current;
  const nextOwner = { ...owner, backgroundSuspended: suspended, updatedAt };
  let replaced = false;
  const projects = current.projects.map((project) => {
    if (project.id !== projectId) return project;
    replaced = true;
    return nextOwner;
  });
  if (!replaced) projects.push(nextOwner);
  return {
    ...current,
    project: current.project.id === projectId ? nextOwner : current.project,
    projects,
  };
};

/** Open an existing project and clear its workspace marker. The caller first
 * applies the current editor draft; this operation keeps both projects' latest
 * data by reference and has no worker, cancellation, persistence or API effects. */
export const openProjectWorkspace = <TState extends BackgroundWorkspace>(
  current: TState,
  projectId: string,
  updatedAt = Date.now(),
): TState => {
  if (!projectId) return current;
  const target = current.project.id === projectId
    ? current.project
    : current.projects.find((project) => project.id === projectId);
  if (!target) return current;
  if (target === current.project && current.activeProjectId === projectId) {
    return setProjectBackgroundSuspended(current, projectId, false, updatedAt);
  }
  const opened = target.backgroundSuspended
    ? { ...target, backgroundSuspended: false, updatedAt }
    : target;
  const projects = new Map(current.projects.map((project) => [project.id, project]));
  // The visible project is authoritative even if its library mirror predates
  // the latest task completion or editor draft update.
  projects.set(current.project.id, current.project);
  projects.set(projectId, opened);
  return { ...current, project: opened, activeProjectId: projectId, projects: [...projects.values()] };
};
