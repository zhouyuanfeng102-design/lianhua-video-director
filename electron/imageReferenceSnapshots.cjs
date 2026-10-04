const safeSnapshotPath = (value) => {
  if (typeof value !== 'string') return '';
  const relativePath = value.trim().replace(/\\/gu, '/');
  if (!relativePath || /^(?:\/|[a-z]:|[a-z]+:)/iu.test(relativePath)
    || /[\u0000-\u001f]/u.test(relativePath)
    || !relativePath.split('/').every((part) => part && part !== '.' && part !== '..')) return '';
  return relativePath;
};

/** Task/result-owned originals remain exportable after source tasks and image
 * cards are removed. Collect local locators, never URLs, pixels or secrets. */
const collectImageReferenceSnapshotsForExport = (state) => {
  const projects = [state?.project, ...(Array.isArray(state?.projects) ? state.projects : [])];
  const byPath = new Map();
  for (const project of projects) {
    const sources = [
      ...(Array.isArray(project?.generationTasks) ? project.generationTasks : [])
        .filter((task) => task?.kind === 'image' && task.imageGenerationMode === 'image-to-image'),
      ...(Array.isArray(project?.assets) ? project.assets : [])
        .filter((asset) => asset?.imageGenerationMode === 'image-to-image' && asset.imageRegenerationSnapshot?.version === 1)
        .map((asset) => ({ id: asset.id, referenceAssetSnapshots: asset.imageRegenerationSnapshot.referenceAssetSnapshots })),
    ];
    for (const source of sources) {
      for (const snapshot of Array.isArray(source.referenceAssetSnapshots) ? source.referenceAssetSnapshots : []) {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        const relativePath = safeSnapshotPath(snapshot.relativePath);
        const checksum = typeof snapshot.checksum === 'string' ? snapshot.checksum.trim().toLowerCase() : '';
        if (!relativePath || !/^[a-f0-9]{64}$/u.test(checksum)) continue;
        const existing = byPath.get(relativePath);
        if (existing && existing.checksum !== checksum) {
          throw new Error(`图生图参考图快照存在冲突，不能用新图片覆盖原图导出：${relativePath}`);
        }
        if (existing) continue;
        byPath.set(relativePath, {
          id: typeof snapshot.id === 'string' && snapshot.id.trim()
            ? snapshot.id.trim() : `image-reference:${String(source.id || '')}:${byPath.size + 1}`,
          relativePath, checksum,
        });
      }
    }
  }
  return [...byPath.values()];
};

module.exports = { collectImageReferenceSnapshotsForExport };
