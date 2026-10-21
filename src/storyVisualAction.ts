import type { StoryPreparationWarning } from './storyPreparationReview';
import { normalizeBattleSceneStaging, type BattleSceneStaging } from './battleScenePlanning';
import { normalizeSceneStaging, normalizeSceneStagingList, type SceneStaging } from './sceneStaging';

export const STORY_VISUAL_ENGINE_VERSION = 'story-scene-4.0';
export type StoryVisualDetailMode = 'faithful' | 'detailed';

export interface StoryVisualSourceQuote {
  id: string;
  sourceParagraphId: string;
  /** Exact text inside the quotation marks, without rewriting or trimming. */
  text: string;
  /** UTF-16 offsets in the source paragraph, including the outer marks. */
  sourceStart: number;
  sourceEnd: number;
}

export interface StoryVisualEvent {
  id: string;
  sourceParagraphIds: string[];
  evidence: string;
  actor: string;
  target: string;
  action: string;
  phases?: string[];
  result: string;
  uncertainties: string[];
  sceneId?: string;
  kind?: 'action' | 'dialogue' | 'narration';
  participantIds?: string[];
  speaker?: string;
  dialogue?: string;
  sourceQuoteIds?: string[];
  /** Offsets in the first source paragraph, not in the complete chapter. */
  sourceStart?: number;
  sourceEnd?: number;
}

export interface StoryVisualScene {
  id: string;
  title: string;
  time: string;
  timeRelation: string;
  location: string;
  setting: string;
  participants: Array<{
    id: string;
    name: string;
    aliases?: string[];
    existingEntityId?: string;
    presence: 'present' | 'offscreen' | 'mentioned';
    eventIds?: string[];
  }>;
  eventIds: string[];
  sourceParagraphIds: string[];
}

export interface StoryVisualEventDetail {
  eventId: string;
  text: string;
  stagingAdditions?: string[];
}

export interface StoryVisualActionPlan {
  version: 1;
  sourceParagraphs: Array<{ id: string; text: string }>;
  sourceQuotes?: StoryVisualSourceQuote[];
  events: StoryVisualEvent[];
  scenes?: StoryVisualScene[];
  summary: string;
  sceneStaging?: SceneStaging[];
}

export interface StoryVisualParagraph {
  id: string;
  sourceParagraphIds: string[];
  eventIds: string[];
  text: string;
  stagingAdditions: string[];
  sceneId?: string;
  eventDetails?: StoryVisualEventDetail[];
  /** Adopted scene choreography, separate from original event facts. */
  battleStaging?: BattleSceneStaging;
  /** Shared world and event phases; also applies to ordinary non-battle scenes. */
  sceneStaging?: SceneStaging;
}

const object = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const orderedStrings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  : [];
const strings = (value: unknown): string[] => [...new Set(orderedStrings(value))];
const union = (first: readonly string[], second: readonly string[]): string[] => [...new Set([...first, ...second])];

/** Only paragraph boundaries and display IDs are local. AI identifies events,
 * speakers and causality; the app does not certify those claims. */
export const storyVisualSourceParagraphs = (source: string): StoryVisualActionPlan['sourceParagraphs'] => {
  const paragraphs = source.replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n+/u).filter((item) => item.trim());
  return paragraphs.map((paragraph, index) => ({ id: `p${index + 1}`, text: paragraph.trim() }));
};

/** A lexical quote directory only. A quoted title or concept is not classified
 * as speech: the understanding stage chooses the event kind and quote IDs. */
export const storyVisualSourceQuotes = (
  source: string | StoryVisualActionPlan['sourceParagraphs'],
): StoryVisualSourceQuote[] => {
  const paragraphs = typeof source === 'string' ? storyVisualSourceParagraphs(source) : source;
  const closingMarks: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" };
  return paragraphs.flatMap((paragraph) => {
    const stack: Array<{ close: string; start: number }> = [];
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < paragraph.text.length; index += 1) {
      const mark = paragraph.text[index];
      if ((mark === '"' || mark === "'") && paragraph.text[index - 1] === '\\') {
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && paragraph.text[cursor] === '\\'; cursor -= 1) backslashes += 1;
        if (backslashes % 2) continue;
      }
      if ((mark === "'" || mark === '’') && /[A-Za-z0-9]/u.test(paragraph.text[index - 1] || '')
        && /[A-Za-z0-9]/u.test(paragraph.text[index + 1] || '')) continue;
      const opened = stack[stack.length - 1];
      if (opened?.close === mark) {
        stack.pop();
        ranges.push({ start: opened.start, end: index + 1 });
      } else if (closingMarks[mark]) stack.push({ close: closingMarks[mark], start: index });
    }
    return ranges.sort((left, right) => left.start - right.start).map((range, index) => ({
      id: `${paragraph.id}-q${index + 1}`, sourceParagraphId: paragraph.id,
      text: paragraph.text.slice(range.start + 1, range.end - 1), sourceStart: range.start, sourceEnd: range.end,
    }));
  });
};

/** Repeated batches may continue one scene. Merge only their explicit IDs;
 * this does not infer a new cast, a scene boundary or a missing identity. */
export const normalizeStoryVisualScenes = (value: unknown, events: readonly StoryVisualEvent[] = []): StoryVisualScene[] => {
  if (!Array.isArray(value)) return [];
  const scenes: StoryVisualScene[] = [];
  const sourceOrder = (ids: string[]): string[] => [
    ...events.filter((event) => ids.includes(event.id)).map((event) => event.id),
    ...ids.filter((id) => !events.some((event) => event.id === id)),
  ];
  for (const [index, entry] of value.entries()) {
    const raw = object(entry);
    if (!raw) continue;
    const id = text(raw.id) || `scene-${index + 1}`;
    let scene = scenes.find((item) => item.id === id);
    if (!scene) {
      scene = { id, title: '', time: '', timeRelation: '', location: '', setting: '', participants: [], eventIds: [], sourceParagraphIds: [] };
      scenes.push(scene);
    }
    for (const key of ['title', 'time', 'timeRelation', 'location', 'setting'] as const) {
      if (!scene[key]) scene[key] = text(raw[key]);
    }
    scene.eventIds = union(scene.eventIds, strings(raw.eventIds));
    scene.sourceParagraphIds = union(scene.sourceParagraphIds, strings(raw.sourceParagraphIds));
    for (const [participantIndex, value] of (Array.isArray(raw.participants) ? raw.participants : []).entries()) {
      const participant = object(value);
      if (!participant) continue;
      const participantId = text(participant.id) || text(participant.existingEntityId) || `${id}-person-${participantIndex + 1}`;
      const name = text(participant.name);
      const presence = participant.presence === 'offscreen' || participant.presence === 'mentioned' ? participant.presence : 'present';
      const existingEntityId = text(participant.existingEntityId);
      const aliases = strings(participant.aliases);
      const eventIds = strings(participant.eventIds);
      const previous = scene.participants.find((item) => item.id === participantId
        || Boolean(existingEntityId && item.existingEntityId === existingEntityId));
      if (previous) {
        if (!previous.name) previous.name = name;
        if (!previous.existingEntityId && existingEntityId) previous.existingEntityId = existingEntityId;
        if (aliases.length) previous.aliases = union(previous.aliases || [], aliases);
        if (eventIds.length) previous.eventIds = union(previous.eventIds || [], eventIds);
        if (presence === 'present' || previous.presence === 'mentioned') previous.presence = presence;
      } else scene.participants.push({ id: participantId, name, presence,
        ...(existingEntityId ? { existingEntityId } : {}), ...(aliases.length ? { aliases } : {}), ...(eventIds.length ? { eventIds } : {}) });
    }
  }
  for (const scene of scenes) {
    scene.eventIds = sourceOrder(scene.eventIds);
    for (const participant of scene.participants) if (participant.eventIds) participant.eventIds = sourceOrder(participant.eventIds);
  }
  return scenes;
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
      ...(orderedStrings(event.phases).length ? { phases: orderedStrings(event.phases) } : {}),
      result: text(event.result), uncertainties: strings(event.uncertainties),
      ...(text(event.sceneId) ? { sceneId: text(event.sceneId) } : {}),
      ...(event.kind === 'action' || event.kind === 'dialogue' || event.kind === 'narration' ? { kind: event.kind } : {}),
      ...(Array.isArray(event.participantIds) ? { participantIds: strings(event.participantIds) } : {}),
      ...(typeof event.speaker === 'string' ? { speaker: text(event.speaker) } : {}),
      ...(typeof event.dialogue === 'string' ? { dialogue: event.dialogue } : {}),
      ...(Array.isArray(event.sourceQuoteIds) ? { sourceQuoteIds: strings(event.sourceQuoteIds) } : {}),
      ...(typeof event.sourceStart === 'number' && Number.isFinite(event.sourceStart) ? { sourceStart: event.sourceStart } : {}),
      ...(typeof event.sourceEnd === 'number' && Number.isFinite(event.sourceEnd) ? { sourceEnd: event.sourceEnd } : {}),
    });
  }
  const sceneStaging = normalizeSceneStagingList(raw.sceneStaging);
  const scenes = normalizeStoryVisualScenes(raw.scenes, events);
  const sourceQuotes = sourceText !== undefined ? storyVisualSourceQuotes(sourceParagraphs)
    : Array.isArray(raw.sourceQuotes) ? raw.sourceQuotes.flatMap((item) => {
      const quote = object(item);
      return quote && text(quote.id) && text(quote.sourceParagraphId) && typeof quote.text === 'string'
        ? [{ id: text(quote.id), sourceParagraphId: text(quote.sourceParagraphId), text: quote.text,
          sourceStart: typeof quote.sourceStart === 'number' ? quote.sourceStart : 0,
          sourceEnd: typeof quote.sourceEnd === 'number' ? quote.sourceEnd : 0 }] : [];
    }) : storyVisualSourceQuotes(sourceParagraphs);
  return { version: 1, sourceParagraphs, events, summary: text(raw.summary),
    ...(scenes.length ? { scenes } : {}),
    ...(scenes.length || Array.isArray(raw.sourceQuotes) ? { sourceQuotes } : {}),
    ...(sceneStaging.length ? { sceneStaging } : {}) };
};

export const normalizeStoryVisualParagraphs = (value: unknown, _plan?: StoryVisualActionPlan): StoryVisualParagraph[] => {
  if (!Array.isArray(value)) return [];
  const paragraphs: StoryVisualParagraph[] = [];
  const usedDisplayIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const paragraph = object(entry);
    if (!paragraph) continue;
    const eventDetails: StoryVisualEventDetail[] = Array.isArray(paragraph.eventDetails) ? paragraph.eventDetails.flatMap((entry) => {
      const detail = object(entry);
      return detail && text(detail.eventId) ? [{ eventId: text(detail.eventId), text: text(detail.text),
        ...(Array.isArray(detail.stagingAdditions) ? { stagingAdditions: orderedStrings(detail.stagingAdditions) } : {}) }] : [];
    }) : [];
    const sceneId = text(paragraph.sceneId);
    if (!text(paragraph.text) && !sceneId && !eventDetails.length) continue;
    const sourceParagraphIds = strings(paragraph.sourceParagraphIds);
    const eventIds = strings(paragraph.eventIds);
    const modelId = text(paragraph.id) || `v${index + 1}`;
    let id = modelId;
    for (let suffix = 2; usedDisplayIds.has(id); suffix += 1) id = `${modelId}-${suffix}`;
    usedDisplayIds.add(id);
    const battleStaging = normalizeBattleSceneStaging(paragraph.battleStaging);
    const sceneStaging = normalizeSceneStaging(paragraph.sceneStaging);
    paragraphs.push({ id, sourceParagraphIds, eventIds, text: text(paragraph.text), stagingAdditions: strings(paragraph.stagingAdditions),
      ...(sceneId ? { sceneId } : {}), ...(Array.isArray(paragraph.eventDetails) ? { eventDetails } : {}),
      ...(battleStaging ? { battleStaging } : {}), ...(sceneStaging ? { sceneStaging } : {}) });
  }
  return paragraphs;
};

const renderStoryVisualEvent = (event: StoryVisualEvent, quotes: readonly StoryVisualSourceQuote[], details: readonly StoryVisualEventDetail[]): string => {
  const lines: string[] = [];
  if (event.kind === 'dialogue') {
    const selectedQuotes = quotes.filter((quote) => event.sourceQuoteIds?.includes(quote.id)).map((quote) => quote.text);
    const utterances = selectedQuotes.length ? selectedQuotes : typeof event.dialogue === 'string' ? [event.dialogue] : [];
    // Stage two does not author speech. In particular, quoted concepts in
    // action/narration events never become dialogue merely by having quotes.
    if (event.action) lines.push(event.action);
    for (const utterance of utterances) lines.push(`${event.speaker || event.actor || '说话人未明确'}：“${utterance}”`);
  } else {
    const subject = [event.actor, event.target ? `对象：${event.target}` : ''].filter(Boolean).join('，');
    if (event.action) lines.push(`${subject ? `${subject}：` : ''}${event.action}`);
    if (event.phases?.length) lines.push(`动作过程：${event.phases.join('；')}`);
    for (const detail of details) if (detail.text) lines.push(`过程细化：${detail.text}`);
  }
  if (event.result) lines.push(`结果：${event.result}`);
  if (event.uncertainties.length) lines.push(`未明确：${event.uncertainties.join('；')}`);
  return lines.join('\n');
};

/** A continued scene carries all explicitly identified phases. Later records
 * update the same participant/phase rather than discarding earlier batches;
 * repeated action text with different phase IDs remains separate action. */
const mergeStoryVisualSceneStaging = (sceneId: string, records: unknown[]): SceneStaging | undefined => {
  const staging = normalizeSceneStagingList(records).filter((item) => item.sceneId === sceneId);
  if (!staging.length) return undefined;
  const merged: SceneStaging = { version: 1, sceneId };
  for (const current of staging) {
    if (merged.entryState === undefined && current.entryState !== undefined) merged.entryState = current.entryState;
    if (current.exitState !== undefined) merged.exitState = current.exitState;
    for (const key of ['sourceEventIds', 'worldRelations'] as const) {
      if (current[key] !== undefined) merged[key] = union(merged[key] || [], current[key]!);
    }
    if (current.participants) {
      const participants = merged.participants ||= [];
      for (const participant of current.participants) {
        const index = participants.findIndex((item) => item.id === participant.id);
        if (index >= 0) participants[index] = { ...participants[index], ...participant };
        else participants.push(participant);
      }
    }
    if (current.phases) {
      const phases = merged.phases ||= [];
      for (const phase of current.phases) {
        const index = phases.findIndex((item) => item.id === phase.id);
        if (index < 0) { phases.push(phase); continue; }
        const previous = phases[index];
        phases[index] = { ...previous, ...phase,
          ...(previous.startState !== undefined ? { startState: previous.startState } : {}),
          ...(previous.participantIds || phase.participantIds
            ? { participantIds: union(previous.participantIds || [], phase.participantIds || []) } : {}),
        };
      }
    }
  }
  return merged;
};

/** Compose the authored scene/event record directly. Detail generation can
 * add an event's process, but cannot replace the event, cast, time or dialogue.
 * Reassembling an already rendered result reads only its eventDetails. */
export const assembleStoryVisualSceneParagraphs = (
  plan: StoryVisualActionPlan, detailParagraphs: readonly StoryVisualParagraph[],
): StoryVisualParagraph[] => {
  if (!plan.scenes?.length) return [...detailParagraphs];
  const scenes = normalizeStoryVisualScenes(plan.scenes, plan.events);
  const eventDetails = detailParagraphs.flatMap((paragraph) => paragraph.eventDetails || [])
    .filter((detail) => plan.events.some((event) => event.id === detail.eventId && event.kind !== 'dialogue'));
  const quotes = plan.sourceQuotes || storyVisualSourceQuotes(plan.sourceParagraphs);
  const assigned = new Set<StoryVisualEvent>();
  const sceneEvents = scenes.map((scene) => plan.events.filter((event) => {
    const owner = scenes.find((candidate) => candidate.id === event.sceneId)
      || scenes.find((candidate) => candidate.eventIds.includes(event.id));
    if (owner?.id !== scene.id) return false;
    assigned.add(event);
    return true;
  }));
  const remainingEvents = plan.events.filter((event) => !assigned.has(event));
  // Keep explicitly returned but unassigned events readable without guessing
  // their place/time or silently losing them while composing known scenes.
  if (remainingEvents.length) {
    scenes.push({ id: 'unassigned-source-events', title: '未分场剧情', time: '', timeRelation: '', location: '', setting: '',
      participants: [], eventIds: remainingEvents.map((event) => event.id), sourceParagraphIds: [] });
    sceneEvents.push(remainingEvents);
  }
  return scenes.map((scene, index) => {
    const events = sceneEvents[index];
    const ids = events.map((event) => event.id);
    const details = eventDetails.filter((detail) => ids.includes(detail.eventId));
    const sourceParagraphIds = union(scene.sourceParagraphIds, events.flatMap((event) => event.sourceParagraphIds));
    const sceneDetails = detailParagraphs.filter((paragraph) => paragraph.sceneId === scene.id
      || paragraph.eventIds.some((id) => ids.includes(id)) || paragraph.eventDetails?.some((detail) => ids.includes(detail.eventId)));
    const stagingAdditions = [...sceneDetails.flatMap((paragraph) => paragraph.stagingAdditions),
      ...details.flatMap((detail) => detail.stagingAdditions || [])];
    const participants = scene.participants.filter((participant) => participant.presence !== 'mentioned')
      .map((participant) => `${participant.name || '姓名未明确'}${participant.presence === 'offscreen' ? '（画外）' : ''}`);
    const time = [scene.time, scene.timeRelation].filter(Boolean).join('；');
    const body = events.map((event) => renderStoryVisualEvent(event, quotes, details.filter((detail) => detail.eventId === event.id))).filter(Boolean).join('\n\n');
    const sceneStaging = mergeStoryVisualSceneStaging(scene.id, [
      ...(plan.sceneStaging || []), ...sceneDetails.map((paragraph) => paragraph.sceneStaging),
    ]);
    const battleStaging = sceneDetails.find((paragraph) => paragraph.battleStaging)?.battleStaging;
    return { id: `scene-${scene.id}`, sceneId: scene.id, sourceParagraphIds, eventIds: ids,
      text: [`【场景 ${index + 1}${scene.title ? `：${scene.title}` : ''}】`,
        `时间：${time || '原文未明确'}`, `地点：${scene.location || '原文未明确'}`,
        `人物：${participants.join('、') || '原文未明确'}`, `场景：${scene.setting || '原文未明确'}`, `剧情：\n${body}`].join('\n'),
      eventDetails: details.map((detail) => ({ ...detail, ...(detail.stagingAdditions ? { stagingAdditions: [...detail.stagingAdditions] } : {}) })),
      stagingAdditions: strings(stagingAdditions), ...(sceneStaging ? { sceneStaging } : {}), ...(battleStaging ? { battleStaging } : {}) };
  });
};

export const renderStoryVisualScenes = (plan: StoryVisualActionPlan, paragraphs: readonly StoryVisualParagraph[]): string => (
  assembleStoryVisualSceneParagraphs(plan, paragraphs).map((paragraph) => paragraph.text).join('\n\n')
);

/** Kept for old callers. Content checks belong to the model's source rules. */
export const reviewStoryVisualAction = (
  _source: string, _body: string, _plan: StoryVisualActionPlan, _paragraphs: readonly StoryVisualParagraph[],
): StoryPreparationWarning[] => [];
