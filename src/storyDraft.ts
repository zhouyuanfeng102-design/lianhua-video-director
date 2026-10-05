import type { Project, StoryDraft } from './types';
import { activeChapter, chapterWorkspace, withChapterWorkspace } from './chapters';

export interface StoryEditorDraft {
  storyInput: string;
  storyName: string;
}

/** A draft is editor state, not a replacement for the confirmed source. */
export const normalizeStoryDraft = (value: unknown): StoryDraft | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const draft = value as Record<string, unknown>;
  if (typeof draft.name !== 'string' || typeof draft.content !== 'string') return undefined;
  return {
    name: draft.name,
    content: draft.content,
    updatedAt: typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
      ? draft.updatedAt : 0,
  };
};

export const readProjectStoryDraft = (
  project: Pick<Project, 'sourceDocuments' | 'storyDraft'> & Partial<Pick<Project, 'activeChapterId' | 'chapterWorkspaces'>>,
): StoryEditorDraft => {
  const draft = normalizeStoryDraft(chapterWorkspace(project).storyDraft ?? project.storyDraft);
  const source = activeChapter(project);
  return {
    storyInput: draft?.content ?? source?.content ?? '',
    storyName: draft?.name ?? source?.name ?? '第 1 章',
  };
};

/** Preserve an exact, possibly empty draft without touching source-derived
 * scenes, plans, boards, media or their confirmation/revision metadata. */
export const withProjectStoryDraft = <T extends Pick<Project, 'sourceDocuments' | 'storyDraft'> & Partial<Pick<Project, 'activeChapterId' | 'chapterWorkspaces'>>>(
  project: T,
  draft: StoryEditorDraft,
  now = Date.now(),
): T => {
  const source = activeChapter(project);
  const currentDraft = chapterWorkspace(project).storyDraft ?? project.storyDraft;
  if (draft.storyInput === (source?.content ?? '')
    && draft.storyName === (source?.name ?? '第 1 章')) {
    if (currentDraft === undefined) return project;
    const { storyDraft: _draft, ...withoutDraft } = project;
    return withChapterWorkspace(withoutDraft as T, { storyDraft: undefined });
  }
  if (currentDraft?.content === draft.storyInput
    && currentDraft.name === draft.storyName) return project;
  const storyDraft = { name: draft.storyName, content: draft.storyInput, updatedAt: now };
  return withChapterWorkspace({ ...project, storyDraft }, { storyDraft });
};

export const storyDraftIdentity = (draft: StoryEditorDraft): string => (
  JSON.stringify([draft.storyName, draft.storyInput])
);
