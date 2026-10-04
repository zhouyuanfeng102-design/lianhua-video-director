import type { Storyboard, StoryboardImageFrameMetadata } from './types';

const cleanName = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const MAX_IMAGE_NAME_LENGTH = 140;
const clipName = (value: string, length: number): string => value.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');

// Match the case-insensitive, sanitized filename used by Windows exports too.
const nameKey = (value: string): string => cleanName(value)
  .normalize('NFKC')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
  .replace(/[. ]+$/gu, '')
  .toUpperCase();

/** Reserve names before the batch starts, including existing assets and tasks. */
export const createStoryboardImageNameAllocator = (existingNames: readonly string[]) => {
  const occupied = new Set(existingNames.map(nameKey));
  return (requestedName: string): string => {
    const base = cleanName(requestedName) || '分镜图片';
    let version = 1;
    let candidate: string;
    do {
      const suffix = version === 1 ? '' : ` · 第 ${version} 版`;
      candidate = `${clipName(base, MAX_IMAGE_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
      version += 1;
    } while (occupied.has(nameKey(candidate)));
    occupied.add(nameKey(candidate));
    return candidate;
  };
};

/** Stable across edits/reloads; timestamps or shot numbers alone can collide. */
export const storyboardImageBoardLabel = (storyboardId: string): string => {
  const generatedSuffix = storyboardId.match(/^storyboard_[a-z0-9]+_([a-z0-9]{6})$/iu)?.[1];
  if (generatedSuffix) return `方案 ${generatedSuffix.toUpperCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < storyboardId.length; index += 1) {
    hash = Math.imul(hash ^ storyboardId.charCodeAt(index), 0x01000193);
  }
  return `方案 ${(hash >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
};

export const buildStoryboardImageBaseName = (
  storyboard: Pick<Storyboard, 'id' | 'sourceStoryTitle' | 'segmentIndex'>,
  shotIndex: number,
  purpose: 'first-frame' | 'last-frame' | 'storyboard-shot',
  projectName?: string,
  customFrame?: Pick<StoryboardImageFrameMetadata, 'imageFrameIndex' | 'imageFrameCount'>,
): string => {
  // Leave room for the source/shot/version suffix in managed filenames.
  const title = clipName(cleanName(projectName || '') || cleanName(storyboard.sourceStoryTitle || '') || '视频剧情', 60);
  const segment = Number.isInteger(storyboard.segmentIndex) && (storyboard.segmentIndex || 0) > 0
    ? `第 ${storyboard.segmentIndex} 段`
    : '';
  const frame = purpose === 'first-frame' ? '首帧'
    : purpose === 'last-frame' ? '尾帧'
      : customFrame?.imageFrameIndex && customFrame.imageFrameCount
        ? `第 ${shotIndex} 镜 · 第 ${customFrame.imageFrameIndex}/${customFrame.imageFrameCount} 张分镜图片`
      : `第 ${shotIndex} 镜分镜图片`;
  return [title, storyboardImageBoardLabel(storyboard.id), segment, frame].filter(Boolean).join(' · ');
};
