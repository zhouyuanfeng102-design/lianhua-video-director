/** Use creation time only. Save times must never move a library row. */
export const projectCreationTime = (project: { createdAt?: unknown }): number => {
  const value = project.createdAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : 0;
};

/** Sort a copy; equal/unknown dates retain their stable library order. */
export const sortProjectsByCreation = <T extends { createdAt?: unknown }>(projects: readonly T[]): T[] =>
  [...projects].sort((left, right) => projectCreationTime(right) - projectCreationTime(left));

export const projectCreationLabel = (project: { createdAt?: unknown }): string => {
  const timestamp = projectCreationTime(project);
  if (!timestamp) return '创建时间未知';
  return `创建于 ${new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })}`;
};
