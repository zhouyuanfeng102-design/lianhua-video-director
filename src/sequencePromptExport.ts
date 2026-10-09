import type { Project, VideoSequencePlan } from './types';
import type { VideoPromptFormat } from './videoGenerationTypes';
import { videoPromptChoices, videoPromptFormatLabel, videoPromptReferencePreviews } from './videoDirectorDraft';
import { getVideoPromptInstructionLeak } from './videoPromptInstructionLeak';

export interface SequencePromptExportSelection {
  promptFormat: VideoPromptFormat;
  language: 'zh' | 'en';
}

/** Export the selected saved delivery verbatim. Missing deliveries stay visible
 * as pending segments; exporting never substitutes a different format or calls AI. */
export const buildSelectedSequencePromptText = (
  project: Project,
  plan: VideoSequencePlan,
  selection: SequencePromptExportSelection,
): { text: string; readyCount: number; pendingCount: number; warningCount: number } => {
  const formatLabel = videoPromptFormatLabel(selection.promptFormat);
  const languageLabel = selection.language === 'en' ? 'English' : '中文';
  const choices = videoPromptChoices(project, undefined, selection.promptFormat);
  const previews = videoPromptReferencePreviews(project, undefined, selection.promptFormat);
  const savedByBoard = new Map(choices.filter((choice) => choice.language === selection.language)
    .map((choice) => [choice.storyboardId, { prompt: choice.prompt, warning: '' }]));
  for (const preview of previews) {
    if (preview.language === selection.language && !savedByBoard.has(preview.storyboardId)) {
      savedByBoard.set(preview.storyboardId, { prompt: preview.prompt, warning: preview.referenceNotice });
    }
  }
  const boardsById = new Map(project.storyboards.map((board) => [board.id, board]));
  let readyCount = 0;
  let pendingCount = 0;
  let warningCount = 0;
  const sections = [...plan.segments].sort((left, right) => left.index - right.index).map((segment) => {
    const board = segment.storyboardId ? boardsById.get(segment.storyboardId) : undefined;
    const related = board && (!board.sequencePlanId || board.sequencePlanId === plan.id)
      && (!board.segmentId || board.segmentId === segment.id);
    const saved = board && related ? savedByBoard.get(board.id) : undefined;
    const issue = plan.sourceStale ? '原文已变化，请先更新分段计划及提示词。'
      : segment.status !== 'ready' ? '本段尚未完成或需要更新。'
      : !board ? '本段尚未关联分镜。'
      : !related ? '分镜与当前分段的关联已变化。'
      : !saved?.prompt.trim() ? `尚无当前有效的${formatLabel} ${languageLabel}稿，请先生成或更新。`
      : getVideoPromptInstructionLeak(saved.prompt) ? '当前保存稿含有内部规则内容，请先更新提示词。' : '';
    if (issue) pendingCount += 1;
    else { readyCount += 1; if (saved!.warning) warningCount += 1; }
    return [
      `=== 第 ${segment.index} 段：${segment.title} ===`,
      `全局时间：${segment.globalStartSec}–${segment.globalEndSec} 秒`,
      `本段时长：${segment.durationSec} 秒`,
      `提示词格式：${formatLabel} · ${languageLabel}`,
      `入场状态：${segment.entryState || '无'}`,
      `出场状态：${segment.exitState || '无'}`,
      ...(issue ? [`状态：待生成／待更新`, `[待生成／待更新：${issue}]`]
        : [`状态：已生成`, ...(saved!.warning ? [`参考提示：${saved!.warning}`] : []), '最终提示词：', saved!.prompt]),
    ].join('\n');
  });
  const header = [
    '莲华全片分段提示词',
    `计划：${plan.title || plan.sourceStoryTitle}`,
    `剧情：${plan.sourceStoryTitle}`,
    `全片时长：${plan.totalDurationSec} 秒`,
    `视频段数：${plan.segments.length}`,
    `导出格式：${formatLabel} · ${languageLabel}`,
    `可用 ${readyCount} 段 · 待生成／待更新 ${pendingCount} 段`,
  ].join('\n');
  return { text: [header, ...sections].join('\n\n') + '\n', readyCount, pendingCount, warningCount };
};
