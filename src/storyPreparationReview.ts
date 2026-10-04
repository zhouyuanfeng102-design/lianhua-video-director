import {
  compareOptimizationDialogue,
  extractOptimizationDialogueLines,
  extractOptimizationSpeakerLabelConcerns,
  type OptimizationDialogueLine,
} from './storyOptimizationDialogue';

export interface StoryPreparationWarning {
  id: string;
  kind: 'dialogue-text' | 'dialogue-speaker' | 'dialogue-count' | 'structure' | 'format' | 'language';
  message: string;
  index?: number;
  expected?: { utterance: string; speaker: string };
  actual?: { utterance: string; speaker: string };
}

export interface StoryPreparationResult {
  text: string;
  warnings: StoryPreparationWarning[];
}

const SCENE_HEADER = /^[ \t]*【场景[ \t]*([1-9]\d*)[ \t]*[：:][ \t]*([^【】\n]+)】[ \t]*$/gmu;
const SCENE_FIELD = /^[ \t]*(出场人物|剧情|对白|背景信息)[ \t]*[：:][ \t]*/gmu;
const LOOSE_SCENE_HEADER = /^[ \t]*(?:#{1,6}[ \t]+)?(?:【)?场景[ \t]*[一二三四五六七八九十\d]+[^\n]*$/gmu;
const LOOSE_SCENE_FIELD = /^[ \t]*(?:(?:#{1,6}|[-*+])[ \t]+)?(?:\*\*)?(出场人物|人物|剧情|对白|对话|台词|背景信息)(?:\*\*)?[ \t]*[：:](?:\*\*)?[ \t]*/gmu;
const MARKDOWN = /(?:^|\n)[ \t]*(?:```|~~~|#{1,6}[ \t]|[-*+][ \t]|>[ \t]|\|[^\n]+\||\d+[.)、][ \t])|\*\*[^\n]+\*\*/u;
const BODY_KEYS = ['optimizedStory', 'expandedStory', 'story', 'text', 'content'] as const;

const readable = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

const hasReadableJsonValue = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && readable(item)) return true;
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  return false;
};

const unwrapReadableBody = (candidate: string): { text: string; formatNotes: string[]; dialogueReviewAvailable: boolean } => {
  if (typeof candidate !== 'string') throw new Error('AI 视频化整理未返回可读取的正文，原文保持不变');
  let text = candidate.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (!text) throw new Error('AI 视频化整理返回了空内容，原文保持不变');
  const formatNotes: string[] = [];
  let dialogueReviewAvailable = true;
  // A complete outer fence is transport formatting, not story content. Do not
  // strip headings, emphasis, incomplete fences or fences inside the body.
  const fenced = text.match(/^(`{3,}|~{3,})[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/u);
  if (fenced) text = fenced[2].trim();
  if (!text) throw new Error('AI 视频化整理返回了空内容，原文保持不变');

  if (/^(?:\{|\[|")/u.test(text) || /^(?:null|true|false)$/u.test(text)) {
    let parsed: unknown;
    let parsedSuccessfully = false;
    try {
      parsed = JSON.parse(text);
      parsedSuccessfully = true;
    } catch {
      // Readable malformed JSON remains visible for human review; no repair
      // request and no guessed extraction from a partial string literal.
      if (/^(?:\{|\[)/u.test(text)) formatNotes.push('返回内容带有未完整解析的 JSON 外壳，已保留可读文本供你检查。');
    }
    if (parsedSuccessfully) {
      if (typeof parsed === 'string') text = parsed.replace(/\r\n?/gu, '\n').trim();
      else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>;
        const readableBodyKeys = BODY_KEYS.filter((key) => typeof object[key] === 'string' && Boolean((object[key] as string).trim()));
        const bodyKey = readableBodyKeys[0];
        const errorEnvelope = !bodyKey && (Object.prototype.hasOwnProperty.call(object, 'error')
          || Object.prototype.hasOwnProperty.call(object, 'error_message')
          || Object.prototype.hasOwnProperty.call(object, 'errorMessage')
          || object.success === false || object.ok === false
          || (typeof object.message === 'string' && (typeof object.code === 'number' && object.code >= 400
            || typeof object.status === 'number' && object.status >= 400
            || typeof object.statusCode === 'number' && object.statusCode >= 400
            || /^(?:error|failed|failure)$/iu.test(String(object.status || '')))));
        if (errorEnvelope) throw new Error('AI 视频化整理返回了错误信息，未提供可读取的剧情正文，原文保持不变');
        if (new Set(readableBodyKeys.map((key) => object[key])).size > 1) {
          dialogueReviewAvailable = false;
          formatNotes.push('返回包含多个不同的正文候选，已保留完整 JSON，未替你选择或丢弃其中任何一版。');
        } else if (bodyKey) {
          text = (object[bodyKey] as string).replace(/\r\n?/gu, '\n').trim();
          if (Object.keys(object).length > 1) formatNotes.push('已读取 JSON 中的剧情正文；返回还包含额外字段，请确认正文是否完整。');
        } else {
          if (BODY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(object, key)) || !hasReadableJsonValue(object)) {
            throw new Error('AI 视频化整理未返回可读取的剧情正文，原文保持不变');
          }
          dialogueReviewAvailable = false;
          formatNotes.push('返回为非标准 JSON 结构，已保留可读文本；无法可靠自动比对人物对白，请结合全文检查。');
        }
      } else if (Array.isArray(parsed) && hasReadableJsonValue(parsed)) {
        if (parsed.every((value) => typeof value === 'string')) text = (parsed as string[]).join('\n').trim();
        else dialogueReviewAvailable = false;
        formatNotes.push('返回为列表结构，已保留按原顺序排列的可读内容，采用前请检查正文。');
      } else throw new Error('AI 视频化整理未返回可读取的剧情正文，原文保持不变');
    }
  }
  if (!text || !readable(text)) throw new Error('AI 视频化整理返回了空内容或不可读取的正文，原文保持不变');
  return { text, formatNotes, dialogueReviewAvailable };
};

/** Runtime acceptance: unwrap the response envelope, never grade its story meaning. */
export const normalizeStoryPreparationResult = (candidate: string): StoryPreparationResult => ({
  text: unwrapReadableBody(candidate).text,
  warnings: [],
});

const structureConcern = (text: string): string | undefined => {
  const scenes = [...text.matchAll(SCENE_HEADER)];
  if (!scenes.length) return '结果未采用标准分场景结构；正文仍已返回，可直接检查、编辑或采用。';
  if (text.slice(0, scenes[0].index).trim()) return '场景前包含额外说明或标题，请检查是否需要保留。';
  for (const [index, scene] of scenes.entries()) {
    const start = scene.index! + scene[0].length;
    const body = text.slice(start, scenes[index + 1]?.index ?? text.length);
    const fields = [...body.matchAll(SCENE_FIELD)];
    const expected = fields.length === 4 ? ['出场人物', '剧情', '对白', '背景信息'] : ['出场人物', '剧情', '对白'];
    if (fields.length !== expected.length || body.slice(0, fields[0]?.index ?? body.length).trim()) {
      return `第 ${index + 1} 场的字段可能不完整或含额外文字；结果已保留，请对照检查。`;
    }
    if (fields.some((field, fieldIndex) => field[1] !== expected[fieldIndex]
      || !body.slice(field.index! + field[0].length, fields[fieldIndex + 1]?.index ?? body.length).trim())) {
      return `第 ${index + 1} 场的字段顺序或内容可能不同于标准格式；不会阻止你采用。`;
    }
  }
  return undefined;
};

/** Loose field recognition is for review only. It never rearranges the result
 * and tolerates field-order differences rather than inventing missing fields. */
const reviewDialogueChunks = (text: string): Array<{ start: number; end: number; dialogueField: boolean }> => {
  const fields = [...text.matchAll(LOOSE_SCENE_FIELD)];
  const hasPlot = fields.some((field) => field[1] === '剧情');
  const hasDialogue = fields.some((field) => /^(?:对白|对话|台词)$/u.test(field[1]));
  const sceneHeaders = [...text.matchAll(LOOSE_SCENE_HEADER)];
  if (!(hasDialogue && (hasPlot || sceneHeaders.length))) return [{ start: 0, end: text.length, dialogueField: false }];
  const boundaries = [...fields.map((field) => field.index!), ...sceneHeaders.map((header) => header.index!)].sort((left, right) => left - right);
  return fields.flatMap((field) => {
    if (!/^(?:对白|对话|台词)$/u.test(field[1])) return [];
    const start = field.index! + field[0].length;
    const end = boundaries.find((boundary) => boundary >= start) ?? text.length;
    return [{ start, end, dialogueField: true }];
  });
};

const extractReviewDialogue = (text: string): OptimizationDialogueLine[] => reviewDialogueChunks(text).flatMap(({ start, end, dialogueField }) => (
  extractOptimizationDialogueLines(text.slice(start, end), { dialogueField })
    .map((line) => ({ ...line, start: start + line.start, end: start + line.end }))
));

interface DialogueGroup extends OptimizationDialogueLine { firstIndex: number }

const groupAdjacentKnownSpeakers = (lines: OptimizationDialogueLine[]): DialogueGroup[] => {
  const groups: DialogueGroup[] = [];
  for (const [index, line] of lines.entries()) {
    const previous = groups[groups.length - 1];
    if (line.speaker && previous?.speaker === line.speaker) {
      // Preserve English word boundaries while allowing ordinary CJK wrapping
      // and same-speaker split/merge formatting to compare without false alarms.
      previous.utterance += `\n${line.utterance}`;
      previous.end = line.end;
    } else groups.push({ ...line, firstIndex: index + 1 });
  }
  return groups;
};

/** Review never rejects readable content, repairs a result with another model
 * call, reinserts omitted dialogue, or guesses a person's identity. Warnings
 * are advisory and the returned text is the actual readable model body. */
export const reviewStoryOptimization = (source: string, candidate: string): StoryPreparationResult => {
  const { text, formatNotes, dialogueReviewAvailable } = unwrapReadableBody(candidate);
  const warnings: StoryPreparationWarning[] = [];
  const add = (warning: Omit<StoryPreparationWarning, 'id'>): void => {
    warnings.push({ ...warning, id: `${warning.kind}-${warning.index ?? 0}-${warnings.length + 1}` });
  };
  for (const message of formatNotes) add({ kind: 'format', message });
  const concern = structureConcern(text);
  if (concern) add({ kind: 'structure', message: concern });
  if (MARKDOWN.test(text)) add({ kind: 'format', message: '结果保留了 Markdown 排版，请检查采用后是否需要整理格式。' });
  if (!/\p{Script=Han}/u.test(text)) add({ kind: 'language', message: '返回正文未检测到中文，可能与预期语种不同；内容已保留供你确认。' });
  if (!dialogueReviewAvailable) return { text, warnings };

  const sourceLines = extractReviewDialogue(source);
  const candidateLines = extractReviewDialogue(text);
  for (const chunk of reviewDialogueChunks(text)) {
    for (const label of extractOptimizationSpeakerLabelConcerns(text.slice(chunk.start, chunk.end))) {
      const matchingIndex = candidateLines.findIndex((line) => line.start === chunk.start + label.start);
      const index = matchingIndex >= 0 ? matchingIndex + 1 : undefined;
      add({
        kind: 'dialogue-speaker', index,
        message: `返回中的“${label.rawLabel}”可能是动作、语气或发声描述，不是可靠的人物姓名；请根据完整原文确认，不会自动猜人替换。`,
        actual: { utterance: label.utterance, speaker: label.rawLabel },
      });
    }
  }
  const sourceGroups = groupAdjacentKnownSpeakers(sourceLines);
  const candidateGroups = groupAdjacentKnownSpeakers(candidateLines);
  const mismatches = compareOptimizationDialogue(sourceGroups, candidateGroups);
  if (mismatches.length && sourceLines.length !== candidateLines.length) {
    add({ kind: 'dialogue-count', message: `自动识别到原文 ${sourceLines.length} 条、结果 ${candidateLines.length} 条对白；可能有拆合句、遗漏或新增，请对照确认。` });
  }
  for (const mismatch of mismatches) {
    const index = sourceGroups[mismatch.index - 1]?.firstIndex ?? candidateGroups[mismatch.index - 1]?.firstIndex ?? mismatch.index;
    const kind: StoryPreparationWarning['kind'] = mismatch.kind === 'speaker' ? 'dialogue-speaker'
      : mismatch.kind === 'text' ? 'dialogue-text' : 'dialogue-count';
    const detail = mismatch.kind === 'speaker' ? '说话人可能变化或未能可靠识别'
      : mismatch.kind === 'text' ? '台词文字或出现顺序可能有变化'
        : mismatch.kind === 'missing' ? '可能遗漏原有对白' : '可能出现新增对白';
    add({ kind, index, message: `第 ${index} 条对白${detail}，请对照原文决定是否采用。`, expected: mismatch.expected, actual: mismatch.actual });
  }
  return { text, warnings };
};
