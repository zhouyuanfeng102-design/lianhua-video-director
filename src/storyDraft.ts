import type { Project, StoryDraft } from './types';

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
  project: Pick<Project, 'sourceDocuments' | 'storyDraft'>,
): StoryEditorDraft => {
  const draft = normalizeStoryDraft(project.storyDraft);
  const source = project.sourceDocuments[0];
  return {
    storyInput: draft?.content ?? source?.content ?? '',
    storyName: draft?.name ?? source?.name ?? '剧情原文',
  };
};

/** Preserve an exact, possibly empty draft without touching source-derived
 * scenes, plans, boards, media or their confirmation/revision metadata. */
export const withProjectStoryDraft = <T extends Pick<Project, 'sourceDocuments' | 'storyDraft'>>(
  project: T,
  draft: StoryEditorDraft,
  now = Date.now(),
): T => {
  const source = project.sourceDocuments[0];
  if (draft.storyInput === (source?.content ?? '')
    && draft.storyName === (source?.name ?? '剧情原文')) {
    if (project.storyDraft === undefined) return project;
    const { storyDraft: _draft, ...withoutDraft } = project;
    return withoutDraft as T;
  }
  if (project.storyDraft?.content === draft.storyInput
    && project.storyDraft.name === draft.storyName) return project;
  return { ...project, storyDraft: { name: draft.storyName, content: draft.storyInput, updatedAt: now } };
};

export const storyDraftIdentity = (draft: StoryEditorDraft): string => (
  JSON.stringify([draft.storyName, draft.storyInput])
);
