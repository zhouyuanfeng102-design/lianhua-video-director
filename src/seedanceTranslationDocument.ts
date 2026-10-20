import { getPromptDialogues, getPromptVisibleTextSpans } from './promptDialogueLanguage';
import type { PromptTranslationSourceCharacter } from './promptTranslationDocument';

type Section = 'specification' | 'references' | 'subjects' | 'summary' | 'timeline' | 'constraints' | 'body';
type LiteralKind = 'name' | 'dialogue' | 'visible-text' | 'reference' | 'time' | 'number';
interface Range { start: number; end: number }
export interface SeedanceTranslationLiteral extends Range {
  id: string;
  kind: LiteralKind;
  sourceText: string;
  text: string;
}
export interface SeedanceTranslationUnit {
  id: string;
  section: Section;
  sourceText: string;
  literals: SeedanceTranslationLiteral[];
  slotIds: string[];
}
export interface SeedanceTranslationSlot {
  id: string;
  groupId: string;
  sourceText: string;
  groupSourceText: string;
  /** Complete source context around this existing description position. */
  before: string;
  after: string;
}
export interface SeedanceTranslationDocument {
  sourcePrompt: string;
  units: SeedanceTranslationUnit[];
  slots: SeedanceTranslationSlot[];
  layout: Array<{ text: string } | { slotId: string }>;
}

/** An unreadable delivery is a serialization failure, not a content judgement. */
export class SeedanceTranslationSerializationError extends Error {
  readonly retryable = false;
  readonly code = 'invalid_response';
  constructor(detail: string) {
    super(`Seedance 英文交付序列化失败：${detail}；中文稿已保留。`);
    this.name = 'SeedanceTranslationSerializationError';
  }
}

const headings: Array<{ section: Section; source: RegExp; english: string }> = [
  { section: 'specification', source: /^(?:视频规格|Video specification)[ \t]*[:：]/iu, english: 'Video specification:' },
  { section: 'references', source: /^(?:参考素材与职责|参考素材及职责|References and responsibilities)[ \t]*[:：]/iu, english: 'References and responsibilities:' },
  { section: 'subjects', source: /^(?:主体连续性|Subject continuity)[ \t]*[:：]/iu, english: 'Subject continuity:' },
  { section: 'summary', source: /^(?:一句话概述|一句话概要|One[- ]sentence summary)[ \t]*[:：]/iu, english: 'One-sentence summary:' },
  { section: 'timeline', source: /^(?:连续时间轴|Continuous timeline)(?=[ \t:：（(]|$)/iu, english: 'Continuous timeline' },
  { section: 'constraints', source: /^(?:全局约束|Global constraints)[ \t]*[:：]/iu, english: 'Global constraints:' },
];
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const overlap = (a: Range, b: Range): boolean => a.start < b.end && a.end > b.start;
const timeNumber = '(?:(?:\\d{1,2}:){0,2}\\d+(?:\\.\\d+)?)';
const timeRangePattern = new RegExp(
  `(?<![\\d.:])(?:第\\s*)?${timeNumber}\\s*(seconds?|secs?|秒|s)?\\s*(?:[-–—~～至到]|\\bto\\b)\\s*(?:第\\s*)?${timeNumber}\\s*(seconds?|secs?|秒|s)?(?![\\da-z]|[.:]\\d)`, 'giu',
);
const timePointPattern = new RegExp(`(?<![\\d.:])(?:第\\s*)?${timeNumber}\\s*(?:seconds?|secs?|秒|s)(?![\\da-z])`, 'giu');
const renderTime = (value: string): string => value.replace(/第\s*/gu, '').replace(/秒/gu, 's').replace(/[至到～~]/gu, '–');
const enclosedTime = (source: string, start: number, end: number): Range => {
  let before = start;
  let after = end;
  while (before > 0 && /[\t ]/u.test(source[before - 1])) before -= 1;
  while (after < source.length && /[\t ]/u.test(source[after])) after += 1;
  const pair: Record<string, string> = { '【': '】', '[': ']', '（': '）', '(': ')' };
  return before > 0 && pair[source[before - 1]] === source[after]
    ? { start: before - 1, end: after + 1 } : { start, end };
};
const speechLead = /(?:原对白|对白|台词|旁白|吼道|喊道|说道|问道|答道|回答|回应|喊|吼|说出|开口|说|问|答|念|低语|耳语|\b(?:says?|said|shouts?|yells?|asks?|replies|whispers?|speaks?))[^。！？!?；;\n]*[:：\s]*$/iu;
const nonSpeechLead = /(?:写着|刻着|印着|标牌|招牌|标签|标题|名字|名称|代号|图案|提示词|字幕|文字|\b(?:sign|label|title|caption|inscription|printed|written))[^。！？!?；;\n]*[:：\s]*$/iu;

const quoteRanges = (text: string): Array<Range & { content: string }> => {
  const result: Array<Range & { content: string }> = [];
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" };
  for (let start = 0; start < text.length; start += 1) {
    const close = pairs[text[start]];
    if (!close || (text[start] === "'" && /[\p{L}\p{N}]/u.test(text[start - 1] || '') && /[\p{L}\p{N}]/u.test(text[start + 1] || ''))) continue;
    let end = start + 1;
    for (; end < text.length; end += 1) {
      if (text[end] === '\\') { end += 1; continue; }
      if (text[end] === close) break;
    }
    if (end >= text.length) continue;
    result.push({ start, end: end + 1, content: text.slice(start + 1, end) });
    start = end;
  }
  return result;
};

/** Use explicit declarations and supplied identity records only, never a guessed speaker. */
const sourceNames = (source: string, characters: readonly PromptTranslationSourceCharacter[]): string[] => {
  const names = new Set(characters.flatMap((character) => [character.name, ...(character.aliases || [])]).filter((name) => name && source.includes(name)));
  for (const match of source.matchAll(/@([\p{L}\p{N}_·•-]+)/gu)) {
    if (!/^(?:Image|Video|Audio|Clay|Render)$/iu.test(match[1])) names.add(match[1]);
  }
  let inSubjects = false;
  for (const line of source.split(/\r\n|\r|\n/u)) {
    const heading = headings.find((item) => item.source.test(line.trimStart()));
    if (heading) inSubjects = heading.section === 'subjects';
    if (!inSubjects) continue;
    const body = line.replace(/^\s*(?:主体连续性|Subject continuity)\s*[:：]\s*/iu, '');
    for (const match of body.matchAll(/(?:^|[；;\n])\s*([^\s，,：:；;。]{1,40})\s*[,，:：]\s*(?:男|女|男性|女性|male\b|female\b|adult\b)/giu)) names.add(match[1]);
  }
  return [...names].sort((a, b) => b.length - a.length);
};

const literalsFor = (source: string, section: Section, names: readonly string[]): SeedanceTranslationLiteral[] => {
  const selected: Array<Omit<SeedanceTranslationLiteral, 'id'> & { priority: number }> = [];
  const add = (start: number, end: number, kind: LiteralKind, priority: number, text = source.slice(start, end)): void => {
    selected.push({ start, end, sourceText: source.slice(start, end), text, kind, priority });
  };
  const quotes = quoteRanges(source);
  const visibleText = getPromptVisibleTextSpans(source);
  const legacyDialogues = getPromptDialogues(source);
  for (const [index, quote] of quotes.entries()) {
    const prefix = source.slice(quotes[index - 1]?.end || 0, quote.start);
    const explicit = legacyDialogues.find((line) => line.start === quote.start);
    const namedCue = names.some((name) => new RegExp(`${escapePattern(name)}(?:\\s*[（(][^()（）\\n]*[）)])*\\s*[:：]\\s*$`, 'u').test(prefix));
    const speakerAnnotation = /[（(][^()（）\n]*$/u.test(prefix)
      && /^[^()（）\n]*[）)](?:\s*[（(][^()（）\n]*[）)])*\s*[:：]/u.test(source.slice(quote.end));
    const actualSpeech = (section === 'timeline' || section === 'body')
      && !speakerAnnotation && !nonSpeechLead.test(prefix) && (speechLead.test(prefix) || namedCue || Boolean(explicit));
    if (visibleText.some((range) => range.start === quote.start && range.end === quote.end)) {
      add(quote.start, quote.end, 'visible-text', 6);
    } else if (actualSpeech && !explicit?.translateToEnglish) {
      add(quote.start, quote.end, 'dialogue', 6);
    }
  }
  for (const match of source.matchAll(/@(?:Image|Video|Audio|Clay Render)\s+\d+/gu)) add(match.index!, match.index! + match[0].length, 'reference', 5);
  for (const match of source.matchAll(timeRangePattern)) {
    if (match[1] || match[2] || match[0].includes(':')) {
      const range = enclosedTime(source, match.index!, match.index! + match[0].length);
      add(range.start, range.end, 'time', 4, renderTime(source.slice(range.start, range.end)));
    }
  }
  for (const match of source.matchAll(timePointPattern)) add(match.index!, match.index! + match[0].length, 'time', 3, renderTime(match[0]));
  if (names.length) {
    for (const match of source.matchAll(new RegExp(names.map(escapePattern).join('|'), 'gu'))) {
      const at = match.index!;
      // Preserve source aliases as written; Latin names must not match longer words.
      if (/[\p{Script=Latin}\p{N}_]/u.test(match[0][0]) && /[\p{Script=Latin}\p{N}_]/u.test(source[at - 1] || '')) continue;
      if (/[\p{Script=Latin}\p{N}_]/u.test(match[0].slice(-1)) && /[\p{Script=Latin}\p{N}_]/u.test(source[at + match[0].length] || '')) continue;
      add(source[at - 1] === '@' ? at - 1 : at, at + match[0].length, 'name', 2);
    }
  }
  for (const match of source.matchAll(/\p{Nd}+(?:[.:]\p{Nd}+)*/gu)) add(match.index!, match.index! + match[0].length, 'number', 1);
  const ranges: typeof selected = [];
  for (const range of selected.sort((a, b) => b.priority - a.priority || a.start - b.start || b.end - a.end)) {
    if (!ranges.some((existing) => overlap(existing, range))) ranges.push(range);
  }
  return ranges.sort((a, b) => a.start - b.start).map(({ priority: _priority, ...range }, index) => ({
    ...range, id: `literal-${String(index + 1).padStart(3, '0')}`,
  }));
};

/**
 * Current accepted Seedance prose is the sole content source. Model data holds
 * paragraph context and description slots, never mutable literal references.
 */
export const buildSeedanceTranslationDocument = (
  sourcePrompt: string,
  characters: readonly PromptTranslationSourceCharacter[] = [],
): SeedanceTranslationDocument => {
  const units: SeedanceTranslationUnit[] = [];
  const slots: SeedanceTranslationSlot[] = [];
  const layout: SeedanceTranslationDocument['layout'] = [];
  const names = sourceNames(sourcePrompt, characters);
  let section: Section = 'body';
  const append = (sourceText: string): void => {
    if (!sourceText) return;
    const leading = sourceText.match(/^\s*/u)![0];
    const trailing = sourceText.slice(leading.length).match(/\s*$/u)![0];
    const body = sourceText.slice(leading.length, sourceText.length - trailing.length);
    if (leading) layout.push({ text: leading });
    if (body) {
      const literals = literalsFor(body, section, names);
      const id = `unit-${String(units.length + 1).padStart(3, '0')}`;
      const unit: SeedanceTranslationUnit = { id, section, sourceText: body, literals, slotIds: [] };
      const appendDescription = (start: number, end: number): void => {
        const text = body.slice(start, end);
        if (!text) return;
        if (!/[\p{L}]/u.test(text)) {
          layout.push({ text: text.replace(/，/gu, ', ').replace(/；/gu, '; ').replace(/。/gu, '. ').replace(/：/gu, ': ').replace(/、/gu, ', ') });
          return;
        }
        const slotId = `slot-${String(slots.length + 1).padStart(4, '0')}`;
        slots.push({ id: slotId, groupId: id, sourceText: text, groupSourceText: body, before: body.slice(0, start), after: body.slice(end) });
        unit.slotIds.push(slotId); layout.push({ slotId });
      };
      let cursor = 0;
      for (const literal of literals) {
        appendDescription(cursor, literal.start);
        layout.push({ text: literal.text });
        cursor = literal.end;
      }
      appendDescription(cursor, body.length);
      units.push(unit);
    }
    if (trailing) layout.push({ text: trailing });
  };
  const lines = sourcePrompt.split(/(\r\n|\r|\n)/u);
  for (const line of lines) {
    if (/^(?:\r\n|\r|\n)$/u.test(line)) { layout.push({ text: line }); continue; }
    const leading = line.match(/^[\t ]*/u)![0];
    const body = line.slice(leading.length);
    const heading = headings.find((item) => item.source.test(body));
    let remainder = body;
    if (leading) layout.push({ text: leading });
    if (heading) {
      section = heading.section;
      const match = body.match(heading.source)!;
      layout.push({ text: heading.english });
      remainder = body.slice(match[0].length);
      if (section === 'timeline' && /^[：:]/u.test(remainder)) {
        layout.push({ text: ':' }); remainder = remainder.slice(1);
      }
    }
    // Shot boundary prefixes stay in source order outside translated prose.
    if (section === 'timeline') {
      const boundary = Array.from(remainder.matchAll(timeRangePattern))
        .filter((match) => match[1] || match[2] || match[0].includes(':'))
        .map((match) => enclosedTime(remainder, match.index!, match.index! + match[0].length))
        .find((range) => range.start === 0);
      if (boundary) {
        layout.push({ text: renderTime(remainder.slice(boundary.start, boundary.end)) });
        remainder = remainder.slice(boundary.end);
      }
    }
    append(remainder);
  }
  return { sourcePrompt, units, slots, layout };
};

/** Decode the existing one-request English delivery; missing text is never a Chinese fallback. */
export const renderSeedanceTranslationDocument = (
  document: SeedanceTranslationDocument, response: string,
): string => {
  let value: unknown;
  try { value = JSON.parse(response.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); }
  catch { throw new SeedanceTranslationSerializationError('返回内容不是可读取的 JSON 对象'); }
  if (!value || typeof value !== 'object' || !('slots' in value) || !Array.isArray(value.slots)) {
    throw new SeedanceTranslationSerializationError('缺少英文描述单元');
  }
  const rendered = new Map<string, string>();
  for (const item of value.slots) {
    if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim()) {
      rendered.set(item.id, item.text);
    }
  }
  if (document.slots.some((slot) => !rendered.has(slot.id))) throw new SeedanceTranslationSerializationError('英文描述单元未完整返回');
  return document.layout.map((part) => 'text' in part ? part.text : rendered.get(part.slotId)!).join('');
};
