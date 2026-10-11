import type { StoryVisualActionPlan, StoryVisualParagraph } from '../src/storyVisualAction';

export interface CapturedStoryRequest {
  messages: Array<{ role: string; content: string }>;
  thinking?: unknown;
  response_format?: unknown;
}
export interface StoryVisualRequestData extends Record<string, unknown> {
  stage: 'understanding' | 'visualizing' | 'rewriting';
  sourceTextOrRequirement: string;
  sourceParagraphs?: Array<{ id: string; text: string }>;
  focusParagraphIds?: string[];
  focusEvents?: StoryVisualActionPlan['events'];
  previousParagraph?: StoryVisualParagraph;
}

export const readStoryVisualData = (request: CapturedStoryRequest): StoryVisualRequestData => {
  const user = request.messages.find((message) => message.role === 'user')?.content || '';
  const serialized = user.match(/<story_visual_data>\s*([\s\S]*?)\s*<\/story_visual_data>/u)?.[1];
  if (!serialized) throw new Error('No story visual transport data');
  return JSON.parse(serialized) as StoryVisualRequestData;
};

/** Transport fixtures only. These deterministic event tables do not simulate
 * or establish the quality of a real text model's narrative understanding. */
export const fixturePlan = (data: StoryVisualRequestData): Omit<StoryVisualActionPlan, 'sourceParagraphs'> => ({
  version: 1, summary: '保留原文事件顺序、动作对象与未知信息。',
  events: (data.sourceParagraphs || []).map((paragraph, index) => ({
    id: `e${index + 1}`, sourceParagraphIds: [paragraph.id], evidence: paragraph.text,
    actor: '', target: '', action: paragraph.text.slice(0, 100), result: '', uncertainties: [],
  })),
});

export const fixtureParagraphs = (data: StoryVisualRequestData, body?: string): { paragraphs: StoryVisualParagraph[] } => ({
  paragraphs: body === undefined ? (data.sourceParagraphs || []).map((paragraph, index) => ({
    id: `v${index + 1}`, sourceParagraphIds: [paragraph.id],
    eventIds: (data.focusEvents || []).filter((event) => event.sourceParagraphIds.includes(paragraph.id)).map((event) => event.id),
    text: paragraph.text, stagingAdditions: [],
  })) : [{ id: 'v1', sourceParagraphIds: data.focusParagraphIds || [],
    eventIds: (data.focusEvents || []).map((event) => event.id), text: body, stagingAdditions: [] }],
});
