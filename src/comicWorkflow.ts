import type { Project, StoryReferenceAnalysis } from './types';
import { beginStoryReferenceRecognition, completeStoryReferenceRecognition, failStoryReferenceRecognition, type StoryReferenceRecognitionRequest } from './storyReferences';
import { comicSourceFingerprint, orderedComicReferences, storeComicStoryDraft } from './comicSources';

export interface ComicRecognitionRequest {
  projectId: string;
  chapterId: string;
  sourceFingerprint: string;
  pages: StoryReferenceRecognitionRequest[];
}

/** Several page/reference records may share one managed original asset. */
export const loadComicReferenceImages = async (
  references: readonly { assetId: string }[],
  load: (assetIds: readonly string[]) => Promise<string[]>,
): Promise<string[]> => {
  const ids = [...new Set(references.map((reference) => reference.assetId))];
  const images = await load(ids);
  if (images.length !== ids.length || images.some((image) => !image)) throw new Error('漫画或身份参考图缺少可读取的图片。');
  const byId = new Map(ids.map((id, index) => [id, images[index]]));
  return references.map((reference) => byId.get(reference.assetId)!);
};

/** One request owns all pages, so a partial or late response cannot mix two readings. */
export const beginComicRecognition = (project: Project, chapterId: string, requestId: string): { project: Project; request: ComicRecognitionRequest } => {
  const references = orderedComicReferences(project, chapterId);
  if (!references.length) throw new Error('请先添加并启用漫画剧情页。');
  const sourceFingerprint = comicSourceFingerprint(project, chapterId);
  let next = project;
  const pages = references.map((reference) => {
    const started = beginStoryReferenceRecognition(next, reference.id, `${requestId}:${reference.id}`, chapterId);
    next = started.project;
    return started.request;
  });
  return { project: next, request: { projectId: project.id, chapterId, sourceFingerprint, pages } };
};

export const completeComicRecognition = (
  project: Project,
  request: ComicRecognitionRequest,
  result: { pages: { referenceId: string; analysis: StoryReferenceAnalysis }[]; storyText: string; model: string },
  now = Date.now(),
): Project => {
  if (project.id !== request.projectId
    || !project.sourceDocuments.some((chapter) => chapter.id === request.chapterId && !chapter.archived)
    || comicSourceFingerprint(project, request.chapterId) !== request.sourceFingerprint) return project;
  if (!result.storyText.trim() || result.pages.length !== request.pages.length
    || new Set(result.pages.map((page) => page.referenceId)).size !== request.pages.length) {
    throw new Error('漫画识别结果缺少完整页资料或剧情正文，本次未采用。');
  }
  let next = project;
  for (const page of request.pages) {
    const response = result.pages.find((item) => item.referenceId === page.referenceId);
    if (!response?.analysis.comic?.panels.length) throw new Error('漫画识别缺少对应页的图格资料，本次未采用。');
    const completed = completeStoryReferenceRecognition(next, page, response.analysis, now);
    if (completed === next) return project;
    next = completed;
  }
  return storeComicStoryDraft(next, {
    storyText: result.storyText.trim(), model: result.model, generatedAt: now,
    sourceFingerprint: comicSourceFingerprint(next, request.chapterId),
  }, request.chapterId);
};

export const failComicRecognition = (project: Project, request: ComicRecognitionRequest, message: string): Project => (
  project.id !== request.projectId ? project : request.pages.reduce(
    (next, page) => failStoryReferenceRecognition(next, page, message), project,
  )
);
