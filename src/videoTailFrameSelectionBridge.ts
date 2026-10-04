import { applyOwnedProjectUpdate } from './appEffects';
import { lookupPreviousSegmentVideos } from './videoTailReference';
import { extractVideoTailFrameSelection, type VideoTailFrameSelectionDesktop } from './videoFrameSelection';
import type { AppState, Project, ReferenceAsset } from './types';
import type { WorkbenchMediaSource } from './videoWorkbenchTypes';
import type { TailFrameSelectionContext, TailFrameSelectionResult } from './components/PreviousVideoTailDialog';

export interface ProjectTailFrameSelectionInput {
  projectId: string;
  jobId: string;
  source: WorkbenchMediaSource;
  context: TailFrameSelectionContext;
  desktop: VideoTailFrameSelectionDesktop;
  signal: AbortSignal;
  getState: () => AppState;
  setState: (update: (current: AppState) => AppState) => void;
  persistState: () => Promise<void>;
  onProgress?: (message: string) => void;
}

const cancelled = () => Object.assign(new Error('AI 辅助选帧已取消，未应用到本段。'), { name: 'AbortError' });

/** Manual selection saves derived candidates, never modifies the source video or the draft. */
export const selectProjectVideoTailFrame = async (
  input: ProjectTailFrameSelectionInput,
  select = extractVideoTailFrameSelection,
): Promise<TailFrameSelectionResult> => {
  const { projectId, source, signal, context } = input;
  let expectedAssociation: string | undefined;
  const checkSource = (): Project => {
    if (signal.aborted) throw cancelled();
    const current = input.getState();
    if (current.project.id !== projectId) throw new Error('项目已切换，本次选帧不会应用到其他项目。');
    const video = current.project.assets.find((asset) => asset.id === source.assetId);
    if (!video || video.missing || video.relativePath !== source.relativePath || (video.checksum || '') !== (source.expectedChecksum || '')) {
      throw new Error('上一段成片已改变或丢失，请重新选择；未应用迟到的选帧结果。');
    }
    const lookup = lookupPreviousSegmentVideos(current.project, context);
    const version = lookup.versions.find((entry) => entry.asset.id === source.assetId);
    if (!version || !lookup.previousSegment) throw new Error('成片已不再属于准确的上一段，未应用迟到的选帧结果。');
    const association = JSON.stringify([lookup.previousSegment.id, version.task?.id, video.sourceStoryboardId, video.sourceVideoTaskId]);
    if (expectedAssociation !== undefined && association !== expectedAssociation) throw new Error('上一段成片的来源关系已改变，未应用迟到的选帧结果。');
    expectedAssociation = association;
    return current.project;
  };
  const project = checkSource();
  const lookup = lookupPreviousSegmentVideos(project, context);
  const version = lookup.versions.find((entry) => entry.asset.id === source.assetId);
  if (!version || !lookup.previousSegment) throw new Error('所选视频已不再属于准确的上一段，请重新选择成片。');
  const plan = project.sequencePlans.find((entry) => entry.id === context.sequencePlanId);
  const next = plan?.segments.find((entry) => entry.id === context.segmentId);
  const previousBoard = project.storyboards.find((entry) => entry.id === lookup.previousSegment!.storyboardId);
  const previousPrompt = version.task?.videoJob?.snapshot.draft.prompt
    || previousBoard?.officialPromptZh || previousBoard?.finalPrompt || lookup.previousSegment.content;
  const config = { ...input.getState().settings.visionApi };
  const result = await select({
    desktop: input.desktop, jobId: input.jobId, projectId, source: { ...source }, config, signal,
    previousPrompt, nextPrompt: context.prompt,
    requireAiSelection: context.requireAiSelection,
    storyContext: JSON.stringify({
      fullStory: plan?.sourceStoryContent || '', previousSegment: lookup.previousSegment.content,
      nextSegment: next?.content || '', characters: project.characters.filter((character) => !character.dossier?.archivedIntoCharacterId),
      references: context.references.map((reference) => ({ role: reference.role, name: project.assets.find((asset) => asset.id === reference.assetId)?.name || '' })),
    }),
    onProgress: input.onProgress,
    onBeforeAI: async () => { checkSource(); },
  });
  checkSource();
  if (context.requireAiSelection && result.selection.source !== 'ai') throw new Error('AI 未返回选帧结果，未应用原尾帧；请重试 AI 选帧。');
  const savedAt = Date.now();
  const candidates = result.candidates.map((candidate): TailFrameSelectionResult['candidates'][number] => {
    const frame = candidate.frame;
    const asset: ReferenceAsset = {
      ...frame, id: `${input.jobId}_${candidate.id}`,
      name: `${version.asset.name} · ${candidate.isLastFrame ? '真实尾帧' : '衔接候选'} ${candidate.timeSec.toFixed(3)} 秒`,
      type: candidate.isLastFrame ? 'last-frame' : 'reference',
      role: candidate.isLastFrame ? 'last-frame' : 'composition',
      referenceRole: candidate.isLastFrame ? 'last-frame' : 'composition', source: 'derived',
      sourceVideoAssetId: source.assetId, sourceVideoChecksum: source.expectedChecksum,
      sourceTimeSec: candidate.timeSec, sourceFrameIndex: frame.frameIndex,
      tags: ['视频抽帧', 'AI 辅助选帧'], createdAt: savedAt, updatedAt: savedAt,
    };
    return { id: candidate.id, timeSec: candidate.timeSec, isLastFrame: candidate.isLastFrame, asset };
  });
  const chosen = candidates.find((candidate) => candidate.id === result.selection.selectedId);
  if (!chosen) throw new Error('选帧结果没有对应的本地图片，未改动参考图。');
  const ids = new Set(candidates.map((candidate) => candidate.asset.id));
  input.setState((current) => {
    if (signal.aborted || current.project.id !== projectId) return current;
    const currentSource = current.project.assets.find((asset) => asset.id === source.assetId);
    if (!currentSource || currentSource.missing || currentSource.relativePath !== source.relativePath || (currentSource.checksum || '') !== (source.expectedChecksum || '')) return current;
    return applyOwnedProjectUpdate(current, projectId, (owner) => ({ ...owner,
      assets: [...candidates.map((candidate) => candidate.asset), ...owner.assets.filter((asset) => !ids.has(asset.id))],
    }));
  });
  checkSource();
  await input.persistState();
  const saved = checkSource();
  if (!saved.assets.some((asset) => asset.id === chosen.asset.id && asset.checksum === chosen.asset.checksum)) throw new Error('选帧图片尚未保存，未改动本段参考图。');
  return { frame: chosen.asset, candidates, selection: result.selection };
};
