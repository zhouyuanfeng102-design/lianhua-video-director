import type { Project, ReferenceAsset, ReferenceRole } from './types';
import type { WorkbenchFrameRequest, WorkbenchMediaSource, WorkbenchRenderRequest, WorkbenchVideoProbe, WorkbenchExtractedFrame, WorkbenchRenderResult } from './videoWorkbenchTypes';

export interface VideoWorkbenchClip {
  id: string;
  sourceAssetId: string;
  sourceChecksum?: string;
  inSec: number;
  outSec: number;
  volume: number;
  transitionAfter: { type: 'cut' | 'crossfade'; durationSec: number };
}
export interface VideoWorkbenchDraft {
  id: string;
  name: string;
  clips: VideoWorkbenchClip[];
  output: Required<NonNullable<WorkbenchRenderRequest['output']>>;
  audio: { bgmAssetId?: string; bgmChecksum?: string; bgmVolume: number; ducking: boolean; fadeInSec: number; fadeOutSec: number };
  sequencePlanId?: string;
  createdAt: number;
  updatedAt: number;
}
export type VideoWorkbenchFrameOptions = Omit<WorkbenchFrameRequest, 'jobId' | 'projectId' | 'source'>;
export interface VideoWorkbenchJob {
  id: string;
  projectId: string;
  kind: 'extract' | 'render' | 'boundaries';
  name: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  resultAssetIds: string[];
  error?: string;
  sourceAssetId?: string;
  sourceChecksum?: string;
  frameOptions?: VideoWorkbenchFrameOptions;
  draft?: VideoWorkbenchDraft;
}
export interface VideoWorkbenchState { draft: VideoWorkbenchDraft; jobs: VideoWorkbenchJob[] }

export const workbenchId = (prefix: string): string => `${prefix}_${globalThis.crypto.randomUUID()}`;
export const emptyVideoWorkbenchDraft = (projectId = '', now = Date.now()): VideoWorkbenchDraft => ({
  id: `video-edit-${projectId || now}`, name: '长剧情剪辑', clips: [],
  output: { width: 1920, height: 1080, fps: 30, fileName: '长剧情成片', fadeInSec: 0, fadeOutSec: 0 },
  audio: { bgmVolume: 0.12, ducking: true, fadeInSec: 0.12, fadeOutSec: 0.12 },
  createdAt: now, updatedAt: now,
});
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;

/** New fields are optional for old projects. Never rewrite media or existing prompts. */
export const normalizeVideoWorkbenchState = (value: unknown, projectId: string): VideoWorkbenchState | undefined => {
  if (!object(value)) return undefined;
  const fallback = emptyVideoWorkbenchDraft(projectId, 0);
  const raw = object(value.draft) ? value.draft : {};
  const output = object(raw.output) ? raw.output : {};
  const audio = object(raw.audio) ? raw.audio : {};
  const clips: VideoWorkbenchClip[] = (Array.isArray(raw.clips) ? raw.clips : []).filter(object).map((clip, index) => {
    const transition = object(clip.transitionAfter) ? clip.transitionAfter : {};
    return { id: string(clip.id, `clip-${index}`), sourceAssetId: string(clip.sourceAssetId), sourceChecksum: string(clip.sourceChecksum) || undefined,
      inSec: number(clip.inSec, 0), outSec: number(clip.outSec, 0), volume: number(clip.volume, 1),
      transitionAfter: { type: transition.type === 'crossfade' ? 'crossfade' : 'cut', durationSec: number(transition.durationSec, 0.3) } };
  });
  const draft: VideoWorkbenchDraft = { id: string(raw.id, fallback.id), name: string(raw.name, fallback.name), clips,
    output: { width: number(output.width, 1920), height: number(output.height, 1080), fps: number(output.fps, 30), fileName: string(output.fileName, '长剧情成片'), fadeInSec: number(output.fadeInSec, 0), fadeOutSec: number(output.fadeOutSec, 0) },
    audio: { bgmAssetId: string(audio.bgmAssetId) || undefined, bgmChecksum: string(audio.bgmChecksum) || undefined, bgmVolume: number(audio.bgmVolume, 0.12), ducking: audio.ducking !== false, fadeInSec: number(audio.fadeInSec, 0.12), fadeOutSec: number(audio.fadeOutSec, 0.12) },
    sequencePlanId: string(raw.sequencePlanId) || undefined, createdAt: number(raw.createdAt, 0), updatedAt: number(raw.updatedAt, 0) };
  const jobs = (Array.isArray(value.jobs) ? value.jobs : []).filter((job): job is Record<string, unknown> => object(job) && typeof job.id === 'string'
    && ['extract', 'render', 'boundaries'].includes(string(job.kind))).map((job) => ({
      id: string(job.id), kind: job.kind, name: string(job.name, '导入的工作台任务'), error: string(job.error) || undefined,
      createdAt: number(job.createdAt, 0), updatedAt: number(job.updatedAt, 0), sourceAssetId: string(job.sourceAssetId) || undefined,
      sourceChecksum: string(job.sourceChecksum) || undefined,
      draft: object(job.draft) ? normalizeVideoWorkbenchState({ draft: job.draft, jobs: [] }, projectId)?.draft : undefined,
      frameOptions: object(job.frameOptions) && ['first', 'last', 'time', 'frame', 'uniform', 'boundaries'].includes(string(job.frameOptions.mode))
        ? { mode: job.frameOptions.mode,
          ...Object.fromEntries(['timeSec', 'frameIndex', 'count', 'inSec', 'outSec'].flatMap((key) => typeof (job.frameOptions as Record<string, unknown>)[key] === 'number' && Number.isFinite((job.frameOptions as Record<string, unknown>)[key]) ? [[key, (job.frameOptions as Record<string, unknown>)[key]]] : [])),
          fileName: string(job.frameOptions.fileName) || undefined } : undefined,
      projectId, status: ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(string(job.status)) ? job.status : 'interrupted',
      resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds.filter((id) => typeof id === 'string') : [],
    } as unknown as VideoWorkbenchJob));
  return { draft, jobs };
};
export const workbenchVideoAsset = (asset: ReferenceAsset): boolean => asset.mediaType === 'video' || asset.type === 'video' || Boolean(asset.mimeType?.startsWith('video/'));
export const workbenchAudioAsset = (asset: ReferenceAsset): boolean => asset.mediaType === 'audio' || asset.type === 'audio' || Boolean(asset.mimeType?.startsWith('audio/'));
/** Selection is metadata-only. Actual file/checksum/codec validation still runs before append. */
export const selectableWorkbenchVideo = (asset: ReferenceAsset): boolean => workbenchVideoAsset(asset) && !asset.missing && Boolean(asset.relativePath?.trim());
export interface WorkbenchVideoSelection { projectId: string; assetIds: string[] }
export const normalizeWorkbenchVideoSelection = (selection: WorkbenchVideoSelection, projectId: string, assets: readonly ReferenceAsset[]): WorkbenchVideoSelection => {
  if (selection.projectId !== projectId) return { projectId, assetIds: [] };
  const available = new Set(assets.filter(selectableWorkbenchVideo).map((asset) => asset.id));
  const assetIds = [...new Set(selection.assetIds)].filter((id) => available.has(id));
  return assetIds.length === selection.assetIds.length && assetIds.every((id, index) => id === selection.assetIds[index]) ? selection : { projectId, assetIds };
};
/** Covers the entire filtered list, never just the current pagination slice. */
export const selectWorkbenchVideoResults = (selection: WorkbenchVideoSelection, projectId: string, assets: readonly ReferenceAsset[], filteredIds: readonly string[], checked: boolean): WorkbenchVideoSelection => {
  const normalized = normalizeWorkbenchVideoSelection(selection, projectId, assets);
  const available = new Set(assets.filter(selectableWorkbenchVideo).map((asset) => asset.id));
  const ids = new Set(normalized.assetIds);
  filteredIds.forEach((id) => { if (checked && available.has(id)) ids.add(id); else if (!checked) ids.delete(id); });
  return { projectId, assetIds: [...ids] };
};
/** Appending follows the visible collection's global order (newest first in the UI). */
export const orderedWorkbenchSelection = (selection: WorkbenchVideoSelection, projectId: string, orderedAssets: readonly ReferenceAsset[]): string[] => {
  const selected = new Set(normalizeWorkbenchVideoSelection(selection, projectId, orderedAssets).assetIds);
  return [...new Set(orderedAssets.filter((asset) => selected.has(asset.id)).map((asset) => asset.id))];
};
export interface WorkbenchSelectionAppendResult {
  requestedIds: string[];
  addedIds: string[];
  failed: Array<{ assetId: string; name: string; message: string }>;
  unattemptedIds: string[];
  cancelled: boolean;
}
/** One atomic per-asset append at a time, retaining successful clips and an exact
 * retry list when another file cannot be decoded. No global draft array is captured. */
export const appendWorkbenchVideoSelection = async ({ assetIds, getAssets, isCurrent, addAsset, onProgress }: {
  assetIds: readonly string[];
  getAssets: () => readonly ReferenceAsset[];
  isCurrent: () => boolean;
  addAsset: (assetId: string) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
}): Promise<WorkbenchSelectionAppendResult> => {
  const requestedIds = [...new Set(assetIds)];
  const result: WorkbenchSelectionAppendResult = { requestedIds, addedIds: [], failed: [], unattemptedIds: [], cancelled: false };
  let nextIndex = 0;
  for (; nextIndex < requestedIds.length; nextIndex += 1) {
    if (!isCurrent()) { result.cancelled = true; break; }
    const assetId = requestedIds[nextIndex];
    const asset = getAssets().find((candidate) => candidate.id === assetId);
    try {
      if (!asset || !selectableWorkbenchVideo(asset)) throw new Error('视频已删除、文件缺失或尚未保存到本地，未添加。');
      await addAsset(assetId);
      result.addedIds.push(assetId);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') { result.cancelled = true; break; }
      result.failed.push({ assetId, name: asset?.name || assetId, message: cause instanceof Error ? cause.message : String(cause) });
    }
    onProgress?.(result.addedIds.length + result.failed.length, requestedIds.length);
  }
  result.unattemptedIds = requestedIds.slice(nextIndex);
  return result;
};
export const workbenchSource = (asset: ReferenceAsset | undefined): WorkbenchMediaSource => {
  if (!asset) throw new Error('来源素材已不存在，请重新选择。');
  if (asset.missing) throw new Error(`素材“${asset.name}”文件缺失，请先在资产库重连。`);
  if (!asset.relativePath) throw new Error(`素材“${asset.name}”尚未保存为本地托管文件，请先下载或导入。`);
  return { assetId: asset.id, relativePath: asset.relativePath, expectedChecksum: asset.checksum };
};
export const createWorkbenchClip = (asset: ReferenceAsset, probe: WorkbenchVideoProbe): VideoWorkbenchClip => ({
  id: workbenchId('clip'), sourceAssetId: asset.id, sourceChecksum: asset.checksum,
  inSec: 0, outSec: probe.durationSec, volume: 1, transitionAfter: { type: 'cut', durationSec: 0.3 },
});
export const videoWorkbenchDuration = (draft: VideoWorkbenchDraft): number => Math.max(0, draft.clips.reduce((sum, clip, index) => (
  sum + Math.max(0, clip.outSec - clip.inSec) - (index < draft.clips.length - 1 && clip.transitionAfter.type === 'crossfade' ? Math.max(0, clip.transitionAfter.durationSec) : 0)
), 0));

/**
 * Editing operations below only change the draft's clip array. They deliberately
 * do not touch source assets or the render/audio settings, so callers can use
 * them from functional state updates and keep the original videos intact.
 */
export interface VideoWorkbenchRange {
  /** Source-media time in seconds, rather than the clip's position on the timeline. */
  startSec: number;
  endSec: number;
}
export type VideoWorkbenchEditRange = VideoWorkbenchRange;

export type VideoWorkbenchInsertPosition = number | {
  /** Insert at a clip-array boundary. 0 inserts before the first clip. */
  index: number;
} | {
  /** Insert relative to a clip. offsetSec, when supplied, is source-media time. */
  clipId: string;
  side?: 'before' | 'after';
  offsetSec?: number;
};

export interface VideoWorkbenchReplaceRangeOptions {
  /** If supplied, the replacement is inserted at a timeline boundary instead of the removed range. */
  position?: VideoWorkbenchInsertPosition;
}

const cutTransition = (): VideoWorkbenchClip['transitionAfter'] => ({ type: 'cut', durationSec: 0 });
const clipLength = (clip: VideoWorkbenchClip): number => Math.max(0, clip.outSec - clip.inSec);
const cloneClip = (clip: VideoWorkbenchClip): VideoWorkbenchClip => ({
  ...clip,
  transitionAfter: { ...clip.transitionAfter },
});
const draftWithClips = (draft: VideoWorkbenchDraft, clips: VideoWorkbenchClip[]): VideoWorkbenchDraft => ({
  ...draft,
  output: { ...draft.output },
  audio: { ...draft.audio },
  clips,
});

/** Keep crossfades valid after an edit and force newly-created seams to hard cuts. */
const normalizeWorkbenchTransitions = (clips: readonly VideoWorkbenchClip[], forceCutAfter = new Set<number>()): VideoWorkbenchClip[] => clips.map((clip, index) => {
  const next = clips[index + 1];
  if (!next || forceCutAfter.has(index) || clip.transitionAfter.type !== 'crossfade') {
    return { ...cloneClip(clip), transitionAfter: cutTransitionIfNeeded(clip, next, forceCutAfter.has(index)) };
  }
  const maximum = Math.min(clipLength(clip), clipLength(next)) / 2;
  if (!Number.isFinite(maximum) || maximum <= 0) return { ...cloneClip(clip), transitionAfter: cutTransition() };
  const durationSec = Math.min(Math.max(0, clip.transitionAfter.durationSec), maximum);
  return { ...cloneClip(clip), transitionAfter: durationSec > 0 ? { type: 'crossfade', durationSec } : cutTransition() };
});

const cutTransitionIfNeeded = (clip: VideoWorkbenchClip, next: VideoWorkbenchClip | undefined, forceCut: boolean): VideoWorkbenchClip['transitionAfter'] => {
  if (forceCut || !next) return cutTransition();
  if (clip.transitionAfter.type !== 'crossfade') return { ...clip.transitionAfter };
  const maximum = Math.min(clipLength(clip), clipLength(next)) / 2;
  const durationSec = Math.min(Math.max(0, clip.transitionAfter.durationSec), maximum);
  return durationSec > 0 ? { type: 'crossfade', durationSec } : cutTransition();
};

/** Normalize an externally edited draft without mutating it. */
export const normalizeWorkbenchClipTransitions = (draft: VideoWorkbenchDraft): VideoWorkbenchDraft => draftWithClips(draft, normalizeWorkbenchTransitions(draft.clips));

const assertFiniteRange = (range: VideoWorkbenchRange): void => {
  if (!Number.isFinite(range.startSec) || !Number.isFinite(range.endSec) || range.startSec >= range.endSec) {
    throw new Error('剪辑范围必须是有效的开始和结束时间，且结束时间大于开始时间。');
  }
};

const assertClipRange = (clip: VideoWorkbenchClip, range: VideoWorkbenchRange): void => {
  assertFiniteRange(range);
  if (range.startSec < clip.inSec || range.endSec > clip.outSec) {
    throw new Error(`剪辑范围必须位于片段 ${clip.inSec.toFixed(3)}–${clip.outSec.toFixed(3)} 秒内。`);
  }
};

const uniqueClipId = (clips: readonly VideoWorkbenchClip[], requested: string): string => {
  if (requested && !clips.some((clip) => clip.id === requested)) return requested;
  let id = workbenchId('clip');
  while (clips.some((clip) => clip.id === id)) id = workbenchId('clip');
  return id;
};

interface DeleteRangeResult {
  clips: VideoWorkbenchClip[];
  /** Boundary at which the removed range began, useful to replacement. */
  insertionIndex: number;
}

const deleteWorkbenchClipRangeInternal = (draft: VideoWorkbenchDraft, clipId: string, range: VideoWorkbenchRange): DeleteRangeResult => {
  const index = draft.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new Error('要剪辑的片段不存在。');
  const clip = draft.clips[index];
  assertClipRange(clip, range);
  const hasPrefix = range.startSec > clip.inSec;
  const hasSuffix = range.endSec < clip.outSec;
  const replacement: VideoWorkbenchClip[] = [];
  if (hasPrefix) replacement.push({ ...cloneClip(clip), outSec: range.startSec, transitionAfter: hasSuffix ? cutTransition() : { ...clip.transitionAfter } });
  if (hasSuffix) replacement.push({ ...cloneClip(clip), id: hasPrefix ? uniqueClipId(draft.clips, `${clip.id}-tail`) : clip.id, inSec: range.endSec, transitionAfter: { ...clip.transitionAfter } });
  const clips = [...draft.clips.slice(0, index), ...replacement, ...draft.clips.slice(index + 1)].map(cloneClip);
  // A removed interval always creates a new seam. If the clip disappears, the
  // previous clip now joins the following clip at the same boundary.
  const seamIndex = hasPrefix ? index : index - 1;
  const forceCuts = new Set<number>();
  if (seamIndex >= 0 && seamIndex < clips.length - 1) forceCuts.add(seamIndex);
  return { clips: normalizeWorkbenchTransitions(clips, forceCuts), insertionIndex: index + (hasPrefix ? 1 : 0) };
};

/** Delete a source-time range inside one clip and close the gap. */
export const deleteWorkbenchClipRange = (draft: VideoWorkbenchDraft, clipId: string, range: VideoWorkbenchRange): VideoWorkbenchDraft => {
  const result = deleteWorkbenchClipRangeInternal(draft, clipId, range);
  return draftWithClips(draft, result.clips);
};

/** Alias matching the wording used by the timeline UI. */
export const removeWorkbenchClipRange = deleteWorkbenchClipRange;
export const deleteWorkbenchRange = deleteWorkbenchClipRange;

/** Trim a clip to a source-time range while preserving its identity. */
export const trimWorkbenchClipRange = (draft: VideoWorkbenchDraft, clipId: string, range: VideoWorkbenchRange): VideoWorkbenchDraft => {
  const index = draft.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new Error('要裁剪的片段不存在。');
  const clip = draft.clips[index];
  assertClipRange(clip, range);
  const clips = draft.clips.map((item, itemIndex) => itemIndex === index ? { ...cloneClip(item), inSec: range.startSec, outSec: range.endSec } : cloneClip(item));
  return draftWithClips(draft, normalizeWorkbenchTransitions(clips));
};

const resolveInsertBoundary = (draft: VideoWorkbenchDraft, position: VideoWorkbenchInsertPosition): { index: number; split?: { clipIndex: number; offsetSec: number } } => {
  if (typeof position === 'number') return { index: position };
  if ('index' in position) return { index: position.index };
  const clipIndex = draft.clips.findIndex((clip) => clip.id === position.clipId);
  if (clipIndex < 0) throw new Error('插入位置对应的片段不存在。');
  if (position.offsetSec !== undefined) {
    const clip = draft.clips[clipIndex];
    if (!Number.isFinite(position.offsetSec) || position.offsetSec < clip.inSec || position.offsetSec > clip.outSec) throw new Error('插入时间必须位于目标片段的入点和出点之间。');
    if (position.offsetSec > clip.inSec && position.offsetSec < clip.outSec) return { index: clipIndex + 1, split: { clipIndex, offsetSec: position.offsetSec } };
    return { index: position.offsetSec <= clip.inSec ? clipIndex : clipIndex + 1 };
  }
  return { index: position.side === 'before' ? clipIndex : clipIndex + 1 };
};

/** Insert a clip before/after a clip, at an array boundary, or at source time inside a clip. */
export const insertWorkbenchClip = (draft: VideoWorkbenchDraft, clip: VideoWorkbenchClip, position: VideoWorkbenchInsertPosition = draft.clips.length): VideoWorkbenchDraft => {
  if (!Number.isFinite(clip.inSec) || !Number.isFinite(clip.outSec) || clip.inSec < 0 || clip.outSec <= clip.inSec) throw new Error('插入片段的入点和出点无效。');
  const resolved = resolveInsertBoundary(draft, position);
  if (!Number.isInteger(resolved.index) || resolved.index < 0 || resolved.index > draft.clips.length) throw new Error('插入位置无效。');
  const inserted = { ...cloneClip(clip), id: uniqueClipId(draft.clips, clip.id), transitionAfter: cutTransition() };
  let clips: VideoWorkbenchClip[];
  let forceCuts = new Set<number>();
  if (resolved.split) {
    const { clipIndex, offsetSec } = resolved.split;
    const target = draft.clips[clipIndex];
    // Include the inserted clip when allocating the split tail id: a caller is
    // allowed to supply an id such as "clip-tail", and duplicate React keys
    // would otherwise be created by this one operation.
    const tailId = uniqueClipId([...draft.clips, inserted], `${target.id}-tail`);
    const tail = { ...cloneClip(target), id: tailId, inSec: offsetSec, transitionAfter: { ...target.transitionAfter } };
    const head = { ...cloneClip(target), outSec: offsetSec, transitionAfter: cutTransition() };
    clips = [...draft.clips.slice(0, clipIndex), head, inserted, tail, ...draft.clips.slice(clipIndex + 1)].map(cloneClip);
    forceCuts = new Set([clipIndex, clipIndex + 1]);
  } else {
    clips = [...draft.clips.slice(0, resolved.index), inserted, ...draft.clips.slice(resolved.index)].map(cloneClip);
    forceCuts = new Set([resolved.index - 1, resolved.index]);
  }
  return draftWithClips(draft, normalizeWorkbenchTransitions(clips, forceCuts));
};
export const insertWorkbenchClipAt = insertWorkbenchClip;

/** Replace a source-time range by inserting a new clip at the resulting seam. */
export const replaceWorkbenchClipRange = (draft: VideoWorkbenchDraft, clipId: string, range: VideoWorkbenchRange, replacement: VideoWorkbenchClip, options: VideoWorkbenchReplaceRangeOptions = {}): VideoWorkbenchDraft => {
  const deleted = deleteWorkbenchClipRangeInternal(draft, clipId, range);
  const position = options.position ?? deleted.insertionIndex;
  return insertWorkbenchClip({ ...draft, clips: deleted.clips }, replacement, position);
};
export const replaceWorkbenchRange = replaceWorkbenchClipRange;

export const buildWorkbenchRenderRequest = (project: Project, draft: VideoWorkbenchDraft, jobId: string): WorkbenchRenderRequest => {
  if (!draft.clips.length) throw new Error('请先添加要剪辑的视频。');
  if (draft.clips.length > 100) throw new Error('单个剪辑方案最多 100 个片段，请分段导出。');
  const clips = draft.clips.map((clip, index) => {
    const asset = project.assets.find((item) => item.id === clip.sourceAssetId);
    const source = workbenchSource(asset);
    if (!workbenchVideoAsset(asset!)) throw new Error(`第 ${index + 1} 个片段不是视频。`);
    if (clip.sourceChecksum && source.expectedChecksum !== clip.sourceChecksum) throw new Error(`第 ${index + 1} 段的原视频内容已改变，请重新添加该素材。`);
    if (![clip.inSec, clip.outSec, clip.volume].every(Number.isFinite) || clip.inSec < 0 || clip.outSec <= clip.inSec || clip.volume < 0 || clip.volume > 2) throw new Error(`第 ${index + 1} 段的入点、出点或音量无效。`);
    if (asset!.durationSec && clip.outSec > asset!.durationSec + 0.05) throw new Error(`第 ${index + 1} 段出点超过视频时长。`);
    if (index < draft.clips.length - 1 && clip.transitionAfter.type === 'crossfade') {
      const duration = clip.transitionAfter.durationSec;
      const next = draft.clips[index + 1];
      if (!Number.isFinite(duration) || duration <= 0 || duration > 10 || duration > Math.min(clip.outSec - clip.inSec, next.outSec - next.inSec) / 2) throw new Error(`第 ${index + 1} 段转场不能超过相邻短片的一半或 10 秒。`);
    }
    return { source, inSec: clip.inSec, outSec: clip.outSec, volume: clip.volume,
      transitionAfter: index < draft.clips.length - 1 ? { ...clip.transitionAfter } : { type: 'cut' as const, durationSec: 0 } };
  });
  const { width, height, fps, fadeInSec, fadeOutSec } = draft.output;
  if (![width, height].every((size) => Number.isInteger(size) && size >= 256 && size <= 3840 && size % 2 === 0) || width * height > 3840 * 2160) throw new Error('输出宽高须为 256–3840 范围内的偶数，总像素不超过 3840×2160。');
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error('输出帧率须为 1–60。');
  const duration = videoWorkbenchDuration(draft);
  if (duration <= 0 || duration > 3600) throw new Error('剪辑总时长须在 0–3600 秒之间。');
  if (![fadeInSec, fadeOutSec, draft.audio.fadeInSec, draft.audio.fadeOutSec].every((value) => Number.isFinite(value) && value >= 0 && value <= Math.min(30, duration / 2))) throw new Error('淡入淡出时长不能小于零，或超过总片长的一半/30秒。');
  if (!Number.isFinite(draft.audio.bgmVolume) || draft.audio.bgmVolume < 0 || draft.audio.bgmVolume > 0.5) throw new Error('背景音乐音量须在 0–50% 之间。');
  const bgm = draft.audio.bgmAssetId ? project.assets.find((asset) => asset.id === draft.audio.bgmAssetId) : undefined;
  if (draft.audio.bgmAssetId && (!bgm || !workbenchAudioAsset(bgm))) throw new Error('背景音乐素材缺失或不是音频。');
  if (draft.audio.bgmChecksum && bgm?.checksum !== draft.audio.bgmChecksum) throw new Error('原背景音乐内容已改变，请重新选择后生成新任务。');
  return { jobId, projectId: project.id, clips, output: { ...draft.output, fileName: draft.output.fileName.trim() || draft.name || '剪辑成片' },
    audio: { bgm: bgm ? workbenchSource(bgm) : undefined, bgmVolume: draft.audio.bgmVolume, ducking: draft.audio.ducking,
      fadeInSec: draft.audio.fadeInSec, fadeOutSec: draft.audio.fadeOutSec } };
};

/** Select one take for each segment. Never silently borrow a different segment or project. */
export const sequenceWorkbenchAssets = (project: Project, planId: string): { assets: ReferenceAsset[]; missingSegments: number[] } => {
  const plan = project.sequencePlans.find((item) => item.id === planId);
  if (!plan) throw new Error('长剧情计划不存在。');
  const result: ReferenceAsset[] = []; const missingSegments: number[] = [];
  for (const segment of [...plan.segments].sort((a, b) => a.index - b.index)) {
    const candidates = project.assets.filter((asset) => {
      if (!workbenchVideoAsset(asset) || asset.missing || !asset.relativePath) return false;
      const task = asset.videoSourceTask || project.generationTasks.find((item) => (item.kind === 'video' || item.kind == null)
        && (item.id === asset.sourceVideoTaskId || item.resultAssetId === asset.id));
      if (!task || !(task.kind === 'video' || task.kind == null)) return false;
      if (task.videoJob && task.videoJob.snapshot.projectId !== project.id) return false;
      const source = task.videoJob?.snapshot.draft.source;
      return (task.sequencePlanId || source?.sequencePlanId) === planId
        && (task.segmentId || source?.segmentId) === segment.id;
    }).sort((a, b) => b.createdAt - a.createdAt);
    if (candidates[0]) result.push(candidates[0]); else missingSegments.push(segment.index);
  }
  return { assets: result, missingSegments };
};

export const frameWorkbenchAsset = (frame: WorkbenchExtractedFrame, source: ReferenceAsset, job: VideoWorkbenchJob, clip?: VideoWorkbenchClip): ReferenceAsset => {
  const role = frame.role === 'custom-frame' ? 'composition' : frame.role;
  return { ...frame, id: workbenchId('frame'), name: frame.fileName.replace(/\.[^.]+$/u, ''), mediaType: 'image', type: role === 'composition' ? 'reference' : role,
    role, referenceRole: role, source: 'derived', sourceVideoAssetId: source.id, sourceVideoChecksum: source.checksum,
    sourceTimeSec: frame.timeSec, sourceFrameIndex: frame.frameIndex, sourceVideoEditId: job.draft?.id, sourceClipId: clip?.id,
    sourceStoryboardId: source.sourceStoryboardId, referenceScope: source.referenceScope, nsfwPrivatePart: source.nsfwPrivatePart,
    tags: ['视频抽帧', frame.role === 'first-frame' ? '首帧' : frame.role === 'last-frame' ? '尾帧' : '自定义帧'],
    createdAt: Date.now(), updatedAt: Date.now() };
};
export const renderedWorkbenchAsset = (result: WorkbenchRenderResult, job: VideoWorkbenchJob): ReferenceAsset => ({
  ...result, ...result.probe, id: workbenchId('edited-video'), name: result.fileName.replace(/\.[^.]+$/u, ''), type: 'video', role: 'motion',
  mediaType: 'video', referenceRole: 'motion', source: 'derived', sourceVideoEditId: job.draft?.id, videoEditDraft: job.draft ? structuredClone(job.draft) : undefined,
  tags: ['剪辑成片', '本地处理'], createdAt: Date.now(), updatedAt: Date.now(),
});

export const frameReferenceRoleOverrides = (ids: string[], role: ReferenceRole): Record<string, ReferenceRole> => Object.fromEntries(ids.map((id) => [id, role]));
