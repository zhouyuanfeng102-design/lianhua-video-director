import type { Project } from './types';
import type { VideoGenerationDraft } from './videoGenerationTypes';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';
import { sourceContentHash } from './sourceContentHash';

export interface VideoSeedanceReferenceBinding {
  version: 1;
  projectId: string;
  basePrompt: string;
  renderedPrompt: string;
  references: Array<{ token: string; assetId: string }>;
}

/** Only proven image ordinals are serialized. Source prose and dialogue are
 * retained; deleting a source image cannot make its token name another image. */
export const prepareVideoSeedanceReferenceDraft = (
  project: Project, draft: VideoGenerationDraft, plan: { numbers?: number[]; warning?: string },
): { draft: VideoGenerationDraft; warnings: string[]; characterStates: [] } => {
  if (draft.reuseTaskId) return { draft, warnings: draft.h3ReferenceWarnings || [], characterStates: [] };
  const saved = draft.seedanceReferenceBinding;
  const board = project.storyboards.find((item) => item.id === draft.source?.storyboardId);
  const sourcePrompt = draft.source?.language === 'en' ? board?.seedance25Output?.promptEn : board?.seedance25Output?.promptZh;
  const binding = saved?.version === 1 && saved.projectId === project.id
    && (draft.prompt === saved.basePrompt || draft.prompt === saved.renderedPrompt) ? saved
    : !saved && !draft.reuseTaskId && sourcePrompt === draft.prompt ? {
      version: 1 as const, projectId: project.id, basePrompt: draft.prompt, renderedPrompt: draft.prompt,
      references: (board?.seedance25Output?.referenceManifest || []).flatMap((entry) => typeof entry.token === 'string' && typeof entry.id === 'string'
        ? [{ token: entry.token, assetId: entry.id }] : []),
    } : undefined;
  if (!binding) {
    const warnings = /@(?:Image|Video|Audio|Clay Render)\s+\d+/u.test(maskVideoPictureReferenceLiterals(draft.prompt))
      ? ['本次手动 Seedance 正文缺少可证明的参考素材编号清单，未猜测或改写编号；请核对实际上传素材和输入槽。'] : [];
    return { draft: { ...draft, seedanceReferenceBinding: undefined, h3ReferenceWarnings: warnings }, warnings, characterStates: [] };
  }
  const warnings: string[] = [];
  const numbers = new Map(draft.references.map((reference, index) => [reference.assetId, plan.numbers?.[index]]));
  const tokens = new Map(binding.references.map((entry) => [entry.token, entry.assetId]));
  const masked = maskVideoPictureReferenceLiterals(binding.basePrompt);
  let renderedPrompt = binding.basePrompt;
  const edits = [...masked.matchAll(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu)].map((match) => {
    const assetId = tokens.get(match[0]);
    if (!match[0].startsWith('@Image ')) {
      warnings.push(`${match[0]}：本软件当前视频选图只传图片，未配置该类型的专用上传槽；请核对外部平台或工作流的实际媒体输入。`);
      return undefined;
    }
    if (!assetId || !draft.references.some((reference) => reference.assetId === assetId)) {
      warnings.push(`${match[0]} 原参考素材${assetId ? `（${assetId}）` : ''}未选中，已移除旧编号以免指向另一张图片；主体和动作正文保留。`);
      return { start: match.index!, end: match.index! + match[0].length, text: '未绑定参考素材' };
    }
    const number = numbers.get(assetId);
    if (!number) return undefined;
    return { start: match.index!, end: match.index! + match[0].length, text: `@Image ${number}` };
  }).filter((edit): edit is { start: number; end: number; text: string } => Boolean(edit));
  if (!plan.numbers && binding.references.some((entry) => entry.token.startsWith('@Image '))) {
    warnings.push('当前接口未明确 Seedance 图片引用顺序，已保留仍选中的原编号；请核对实际输入槽。');
  }
  for (const edit of edits.reverse()) renderedPrompt = renderedPrompt.slice(0, edit.start) + edit.text + renderedPrompt.slice(edit.end);
  return { draft: { ...draft, prompt: renderedPrompt, h3ReferenceBinding: undefined,
    source: draft.source && { ...draft.source, promptFingerprint: sourceContentHash(renderedPrompt) },
    seedanceReferenceBinding: { ...binding, renderedPrompt }, h3ReferenceWarnings: [...new Set(warnings)] },
    warnings: [...new Set(warnings)], characterStates: [] };
};
