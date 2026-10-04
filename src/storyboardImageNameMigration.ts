import type { Project, ReferenceAsset, Storyboard } from './types';
import {
  buildStoryboardImageBaseName,
  createStoryboardImageNameAllocator,
} from './storyboardImageNames';

const LEGACY_IMAGE_NAME = /^(.+) · (第 (\d+) 镜分镜图片|首帧|尾帧)$/u;
const CURRENT_IMAGE_NAME_PREFIX = / · 方案 [A-Z0-9]{6,8}(?: · 第 \d+ 段)?$/iu;
const storyboardImageVariants = new Set(['storyboard-frame', 'first-frame', 'last-frame']);

// Match the legacy renderer's automatic filename sanitization without importing
// storage (which owns this migration's call site).
const automaticFileStem = (name: string): string => (
  name.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_').trim().slice(0, 180)
);
const fileStem = (fileName: string): string => fileName.replace(/\.[^.]+$/u, '');
const mimeExtension = (mimeType: string | undefined): string | undefined => ({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
} as Record<string, string>)[(typeof mimeType === 'string' ? mimeType : '').split(';', 1)[0].trim().toLowerCase()];

const renamedAutomaticFileName = (asset: ReferenceAsset, nextName: string): string | undefined => {
  if (asset.fileName !== undefined && typeof asset.fileName !== 'string') return asset.fileName;
  if (!asset.fileName) {
    const extension = mimeExtension(asset.mimeType);
    return extension ? `${automaticFileStem(nextName)}${extension}` : asset.fileName;
  }
  const legacyStems = new Set([
    asset.name,
    automaticFileStem(asset.name),
    // The desktop image store additionally capped legacy stems at 160.
    automaticFileStem(asset.name).slice(0, 160),
  ]);
  if (legacyStems.has(asset.fileName)) return automaticFileStem(nextName);
  const extension = asset.fileName.match(/(\.[^./\\\r\n]+)$/u)?.[1] || '';
  const stem = extension ? asset.fileName.slice(0, -extension.length) : asset.fileName;
  if (!legacyStems.has(stem)) return asset.fileName;
  return `${automaticFileStem(nextName)}${extension}`;
};

interface LegacyImageCandidate {
  asset: ReferenceAsset;
  index: number;
  oldPrefix: string;
  shotIndex: number;
  purpose: 'first-frame' | 'last-frame' | 'storyboard-shot';
}

/** Repair only ambiguous legacy auto-names; never touch media, bindings or
 * uniquely named/user-named assets. Pure and safe to run on every load/import. */
export const migrateLegacyStoryboardImageNames = (project: Project): Project => {
  const nameCounts = new Map<string, number>();
  for (const asset of project.assets) {
    if (typeof asset.name === 'string') {
      nameCounts.set(asset.name, (nameCounts.get(asset.name) || 0) + 1);
    }
  }
  const candidates: LegacyImageCandidate[] = [];
  project.assets.forEach((asset, index) => {
    if (
      asset.source !== 'generated'
      || typeof asset.sourceStoryboardId !== 'string'
      || !asset.sourceStoryboardId.trim()
      || !storyboardImageVariants.has(asset.imageVariant || '')
      || typeof asset.name !== 'string'
      || (nameCounts.get(asset.name) || 0) < 2
    ) return;
    const match = LEGACY_IMAGE_NAME.exec(asset.name);
    // `$` also accepts a trailing newline. Old automatic names never had one.
    if (!match || match[0] !== asset.name || CURRENT_IMAGE_NAME_PREFIX.test(match[1])) return;
    const purpose = match[2] === '首帧' ? 'first-frame'
      : match[2] === '尾帧' ? 'last-frame'
        : 'storyboard-shot';
    // A user may rename a boundary frame with a numbered-shot title (or vice
    // versa). That is not proof of an old automatic name for this asset.
    const expectedVariant = purpose === 'storyboard-shot' ? 'storyboard-frame' : purpose;
    if (asset.imageVariant !== expectedVariant) return;
    const shotIndex = purpose === 'storyboard-shot' ? Number(match[3]) : 1;
    if (!Number.isSafeInteger(shotIndex)) return;
    candidates.push({ asset, index, oldPrefix: match[1], shotIndex, purpose });
  });
  if (!candidates.length) return project;

  // Keep both display names and export stems reserved, including a filename
  // that the user customized independently of the visible asset name.
  const allocateName = createStoryboardImageNameAllocator([
    ...project.assets.flatMap((asset) => [
      typeof asset.name === 'string' ? asset.name : '',
      typeof asset.fileName === 'string' ? fileStem(asset.fileName) : '',
    ]),
    ...project.generationTasks.map((task) => 'name' in task && typeof task.name === 'string' ? task.name : ''),
  ]);
  const boards = new Map<string, Storyboard>(project.storyboards.map((board) => [board.id, board]));
  const byIndex = new Map<number, ReferenceAsset>();
  const renamedAssets = new Map<string, { oldName: string; name: string }>();
  const createdAt = (asset: ReferenceAsset): number => (
    Number.isFinite(asset.createdAt) ? asset.createdAt : 0
  );
  candidates.sort((left, right) => (
    createdAt(left.asset) - createdAt(right.asset)
    || (left.asset.id < right.asset.id ? -1 : left.asset.id > right.asset.id ? 1 : 0)
    || left.index - right.index
  ));
  for (const candidate of candidates) {
    const { asset } = candidate;
    const storyboardId = asset.sourceStoryboardId!;
    const name = allocateName(buildStoryboardImageBaseName(
      boards.get(storyboardId) || { id: storyboardId },
      candidate.shotIndex,
      candidate.purpose,
      candidate.oldPrefix,
    ));
    const fileName = renamedAutomaticFileName(asset, name);
    byIndex.set(candidate.index, {
      ...asset,
      name,
      ...(fileName !== asset.fileName ? { fileName } : {}),
    });
    renamedAssets.set(asset.id, { oldName: asset.name, name });
  }
  return {
    ...project,
    assets: project.assets.map((asset, index) => byIndex.get(index) || asset),
    generationTasks: project.generationTasks.map((task) => {
      if (task.kind !== 'image' || !task.resultAssetId) return task;
      const renamed = renamedAssets.get(task.resultAssetId);
      return renamed && task.name === renamed.oldName ? { ...task, name: renamed.name } : task;
    }),
  };
};
