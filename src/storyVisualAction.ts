import type { StoryPreparationWarning } from './storyPreparationReview';
import { normalizeBattleSceneStaging, type BattleSceneStaging } from './battleScenePlanning';
import { normalizeSceneStaging, normalizeSceneStagingList, type SceneStaging } from './sceneStaging';

export const STORY_VISUAL_ENGINE_VERSION = 'story-action-3.1';
export type StoryVisualDetailMode = 'faithful' | 'detailed';

export interface StoryVisualActionPlan {
  version: 1;
  sourceParagraphs: Array<{ id: string; text: string }>;
  events: Array<{
    id: string;
    sourceParagraphIds: string[];
    evidence: string;
    actor: string;
    target: string;
    action: string;
    phases?: string[];
    result: string;
    uncertainties: string[];
  }>;
  summary: string;
  sceneStaging?: SceneStaging[];
}

export interface StoryVisualParagraph {
  id: string;
  sourceParagraphIds: string[];
  eventIds: string[];
  text: string;
  stagingAdditions: string[];
  /** Adopted scene choreography, separate from original event facts. */
  battleStaging?: BattleSceneStaging;
  /** Shared world and event phases; also applies to ordinary non-battle scenes. */
  sceneStaging?: SceneStaging;
}

const object = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];

/** Only paragraph boundaries and display IDs are local. AI identifies events,
 * speakers and causality; the app does not certify those claims. */
export const storyVisualSourceParagraphs = (source: string): StoryVisualActionPlan['sourceParagraphs'] => {
  const paragraphs = source.replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n+/u).filter((item) => item.trim());
  return paragraphs.map((paragraph, index) => ({ id: `p${index + 1}`, text: paragraph.trim() }));
};

export const normalizeStoryVisualActionPlan = (value: unknown, sourceText?: string): StoryVisualActionPlan | undefined => {
  const raw = object(value);
  if (!raw) return undefined;
  const sourceParagraphs = sourceText !== undefined ? storyVisualSourceParagraphs(sourceText)
    : Array.isArray(raw.sourceParagraphs) ? raw.sourceParagraphs.flatMap((item) => {
      const paragraph = object(item);
      return paragraph && text(paragraph.id) && text(paragraph.text)
        ? [{ id: text(paragraph.id), text: text(paragraph.text) }] : [];
    }) : [];
  // Read optional model fields for display and downstream context. Evidence,
  // identities and paragraph references remain model claims, without local
  // source matching, semantic approval or an all-or-nothing metadata gate.
  const events: StoryVisualActionPlan['events'] = [];
  for (const [index, entry] of (Array.isArray(raw.events) ? raw.events : []).entries()) {
    const event = object(entry);
    if (!event) continue;
    const sourceParagraphIds = strings(event.sourceParagraphIds);
    const evidence = text(event.evidence);
    events.push({
      id: text(event.id) || `e${index + 1}`, sourceParagraphIds, evidence,
      actor: text(event.actor), target: text(event.target), action: text(event.action),
      ...(strings(event.phases).length ? { phases: strings(event.phases) } : {}),
      result: text(event.result), uncertainties: strings(event.uncertainties),
    });
  }
  const sceneStaging = normalizeSceneStagingList(raw.sceneStaging);
  return { version: 1, sourceParagraphs, events, summary: text(raw.summary),
    ...(sceneStaging.length ? { sceneStaging } : {}) };
};

export const normalizeStoryVisualParagraphs = (value: unknown, _plan?: StoryVisualActionPlan): StoryVisualParagraph[] => {
  if (!Array.isArray(value)) return [];
  const paragraphs: StoryVisualParagraph[] = [];
  const usedDisplayIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const paragraph = object(entry);
    if (!paragraph || !text(paragraph.text)) continue;
    const sourceParagraphIds = strings(paragraph.sourceParagraphIds);
    const eventIds = strings(paragraph.eventIds);
    const modelId = text(paragraph.id) || `v${index + 1}`;
    let id = modelId;
    for (let suffix = 2; usedDisplayIds.has(id); suffix += 1) id = `${modelId}-${suffix}`;
    usedDisplayIds.add(id);
    const battleStaging = normalizeBattleSceneStaging(paragraph.battleStaging);
    const sceneStaging = normalizeSceneStaging(paragraph.sceneStaging);
    paragraphs.push({ id, sourceParagraphIds, eventIds, text: text(paragraph.text), stagingAdditions: strings(paragraph.stagingAdditions),
      ...(battleStaging ? { battleStaging } : {}), ...(sceneStaging ? { sceneStaging } : {}) });
  }
  return paragraphs;
};

/** Kept for old callers. Content checks belong to the model's source rules. */
export const reviewStoryVisualAction = (
  _source: string, _body: string, _plan: StoryVisualActionPlan, _paragraphs: readonly StoryVisualParagraph[],
): StoryPreparationWarning[] => [];
