import { normalizeStoryVisualParagraphs, type StoryVisualActionPlan, type StoryVisualDetailMode, type StoryVisualParagraph } from './storyVisualAction';

/** Retained for reading historical preparation results. New conversion results
 * do not produce local content, dialogue or format warnings. */
export interface StoryPreparationWarning {
  id: string;
  kind: 'dialogue-text' | 'dialogue-speaker' | 'dialogue-count' | 'structure' | 'format' | 'language' | 'facts' | 'continuity' | 'near-copy';
  message: string;
  index?: number;
  expected?: { utterance: string; speaker: string };
  actual?: { utterance: string; speaker: string };
}

export interface StoryPreparationResult {
  text: string;
  warnings: StoryPreparationWarning[];
  actionPlan?: StoryVisualActionPlan;
  paragraphs?: StoryVisualParagraph[];
  engineVersion?: string;
  detailMode?: StoryVisualDetailMode;
}

const BODY_KEYS = ['visualStory', 'visualDescription', 'optimizedStory', 'expandedStory', 'story', 'text', 'content'] as const;
const presentationText = (value: string): string => value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();

/** Read common transport wrappers for display. Unknown formats remain the
 * model's returned text; parsing never grades content or requests a repair. */
export const normalizeStoryPreparationResult = (candidate: string): StoryPreparationResult => {
  let text = presentationText(candidate);
  const fenced = text.match(/^(`{3,}|~{3,})[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/u);
  if (fenced) text = presentationText(fenced[2]);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') text = presentationText(parsed);
    else if (Array.isArray(parsed) && parsed.length && parsed.every((value) => typeof value === 'string')) {
      text = parsed.map(presentationText).join('\n\n');
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      const bodies = BODY_KEYS.flatMap((key) => {
        const body = object[key];
        return typeof body === 'string' && body.trim() ? [body] : [];
      });
      // Keep ambiguous envelopes intact instead of choosing a story for the user.
      if (bodies.length && new Set(bodies).size === 1) text = presentationText(bodies[0]);
    }
  } catch {
    // Plain prose and incomplete wrappers are displayed unchanged.
  }
  return { text, warnings: [] };
};

/** Choose navigable paragraphs from the displayed body. Metadata is used only
 * when it describes that same body; otherwise plain paragraphs remain editable
 * through the user-requested rewrite operation, without a content rejection. */
export const getStoryPreparationParagraphs = (result: StoryPreparationResult): StoryVisualParagraph[] => {
  const paragraphs = normalizeStoryVisualParagraphs(result.paragraphs, result.actionPlan);
  if (paragraphs.length && presentationText(paragraphs.map((paragraph) => paragraph.text).join('\n\n')) === presentationText(result.text)) {
    return paragraphs;
  }
  return presentationText(result.text).split(/\n[ \t]*\n+/u).filter((text) => text.trim())
    .map((text, index) => ({
      id: `paragraph-${index + 1}`, text: text.trim(), sourceParagraphIds: [], eventIds: [], stagingAdditions: [],
    }));
};

/** Compatibility export. Story understanding and correction are AI-owned. */
export const reviewStoryOptimization = (_source: string, candidate: string): StoryPreparationResult => normalizeStoryPreparationResult(candidate);
