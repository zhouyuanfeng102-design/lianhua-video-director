import { canonicalDialogueField, protectedTextQuoteSpans, replaceCanonicalDialogueField } from './masterTimeline';
import { extractSourceDialogues } from './promptEngine';
import { getPromptDialogues } from './promptDialogueLanguage';

interface SpokenUnit { text: string; speaker: string; key: string; start: number; end: number }
const coverageKey = (value: string): string => value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
const silence = /^(?:无|无对白|无台词|没有对白|none|n\/?a)(?:\s*[（(][^()（）]*[）)])?[。.!！\s]*$/iu;
const timeLead = '(?:第\\s*-?\\d+(?:\\.\\d+)?\\s*(?:s|秒)(?:起|开始)?\\s*)?';
const speakerLead = '@?([\\p{L}\\p{N}_·•-]{1,40}|<Subject\\s+\\d+>)';
const speakerAnnotation = '(?:\\s*[（(][^()（）\\r\\n]*[）)])*';

/** Compatibility for the old formatter's exact artifact:
 * 「“utterance”第6s」 @speaker: -> “utterance”第6s @speaker:
 * Only unwrap when one complete inner quote is followed solely by a timestamp
 * and the next item is a speaker without its own timestamp. Never strip
 * timestamp words from actual authored speech or arbitrary nested quotations.
 */
const repairQuotedNextSpeakerTimes = (field: string): string => {
  const nextSpeaker = new RegExp(`^[\\s｜|；;]*${speakerLead}${speakerAnnotation}\\s*[:：]`, 'u');
  const trailingTime = /^\s*第\s*-?\d+(?:\.\d+)?\s*(?:s|秒)(?:起|开始)?\s*$/iu;
  return protectedTextQuoteSpans(field).reduceRight((result, outer) => {
    const inner = protectedTextQuoteSpans(outer.content);
    if (inner.length !== 1 || outer.content.slice(0, inner[0].start).trim()
      || !trailingTime.test(outer.content.slice(inner[0].end))
      || !nextSpeaker.test(field.slice(outer.end))) return result;
    return result.slice(0, outer.start) + outer.content + result.slice(outer.end);
  }, field);
};

const fieldSpeakerHeaders = (field: string): Array<{ start: number; end: number; speaker: string }> => {
  const quotes = protectedTextQuoteSpans(field);
  // A cue may immediately follow a closing quote: ”第6s @甲：. Do not
  // consume the closing quote, or leave 第6s attached to the previous speech.
  return [...field.matchAll(new RegExp(`(?:^|(?<=[\\s｜|；;，,。！？!?”’」』"']))${timeLead}${speakerLead}${speakerAnnotation}\\s*[:：]\\s*`, 'gmu'))]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length, speaker: match[1].replace(/^@/u, '') }))
    .filter((header) => !quotes.some((quote) => header.start > quote.start && header.start < quote.end));
};

/** Work only inside the spoken field. Stage directions in a speaker's
 * parentheses are part of the cue prefix, never extra quoted dialogue. */
const spokenFieldUnits = (field: string): Array<{ text: string; speaker: string }> => {
  field = repairQuotedNextSpeakerTimes(field);
  if (!field.trim() || silence.test(field.trim())) return [];
  const headers = fieldSpeakerHeaders(field);
  const units: Array<{ text: string; speaker: string }> = [];
  const readBody = (body: string, speaker = '') => {
    const quoted = protectedTextQuoteSpans(body);
    const append = (text: string) => { if (coverageKey(text)) units.push({ text, speaker }); };
    if (!quoted.length) {
      append(body.replace(new RegExp(`^\\s*${timeLead}`, 'iu'), ''));
      return;
    }
    let cursor = 0;
    const outsideSpeech = (text: string): string => text.replace(/[（(][^()（）]*[）)]/gu, '')
      .replace(new RegExp(`^\\s*${timeLead}[:：，,；;\\s]*$`, 'iu'), '');
    for (const quote of quoted) {
      // Allow genuinely mixed bare/quoted wording, while quoted speech itself
      // is never stripped of meaningful parentheses or literal field names.
      const gap = outsideSpeech(body.slice(cursor, quote.start));
      append(gap);
      append(quote.content);
      cursor = quote.end;
    }
    append(outsideSpeech(body.slice(cursor)));
  };
  if (!headers.length) readBody(field);
  else {
    readBody(field.slice(0, headers[0].start));
    headers.forEach((header, index) => readBody(field.slice(header.end, headers[index + 1]?.start), header.speaker));
  }
  return units;
};

const canonicalSpokenUnits = (canonicalPrompt: string): SpokenUnit[] => {
  let offset = 0;
  return canonicalPrompt.split(/(?=^【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】)/mu)
    .flatMap((line) => spokenFieldUnits(canonicalDialogueField(line)))
    .map(({ text, speaker }) => { const key = coverageKey(text); const start = offset; offset += key.length; return { text, speaker, key, start, end: offset }; });
};

const missingCoverage = (
  required: Array<{ text: string; englishAllowed?: boolean }>,
  spoken: SpokenUnit[],
): string[] => {
  const available = spoken.map((unit) => unit.key).join('');
  const used = new Uint8Array(available.length);
  const free = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) if (used[index]) return false;
    return true;
  };
  const claim = (key: string): boolean => {
    if (!key) return true;
    for (let found = available.indexOf(key); found >= 0; found = available.indexOf(key, found + 1)) {
      if (!free(found, found + key.length)) continue;
      used.fill(1, found, found + key.length);
      return true;
    }
    return false;
  };
  const items = required.map((dialogue, index) => ({
    ...dialogue, index, key: coverageKey(dialogue.text),
    englishAllowed: Boolean(dialogue.englishAllowed),
  }));
  const missing = new Set<number>();
  // Reserve normal original-language speech first. Otherwise an English-
  // authorized duplicate could consume the only required Chinese occurrence.
  const sorted = [...items].sort((left, right) => Number(left.englishAllowed) - Number(right.englishAllowed) || right.key.length - left.key.length || left.index - right.index);
  for (const item of sorted) {
    if (claim(item.key)) continue;
    const translated = item.englishAllowed ? spoken.find((unit) => (
      unit.key && free(unit.start, unit.end) && /[A-Za-z]/u.test(unit.text)
      && !Array.from(unit.text).some((letter) => /\p{L}/u.test(letter) && !/\p{Script=Latin}/u.test(letter))
    )) : undefined;
    if (translated) used.fill(1, translated.start, translated.end);
    else missing.add(item.index);
  }
  return required.filter((_item, index) => missing.has(index)).map((item) => item.text);
};

/** Lightweight word coverage, not a shot-order, punctuation, tempo or wording
 * style grade. No generated text is changed and no repair is requested here. */
export const missingStoryDialogues = (source: string, canonicalPrompt: string): string[] => {
  // Prepared stories sometimes start the first speaker on the same line as
  // “对白：”. Padding keeps source offsets valid for the per-line English opt-in.
  const preparedSource = source.replace(/^[\t ]*(?:对白|台词|原对白)[：:][\t ]*(?=@?[\p{L}\p{N}_·•-]{1,24}(?:[（(][^()（）\r\n]*[）)])?\s*[:：])/gmu, (prefix) => ' '.repeat(prefix.length));
  const required = extractSourceDialogues(preparedSource);
  if (!required.length) return [];
  const explicitEnglish = getPromptDialogues(source).filter((line) => line.translateToEnglish);
  return missingCoverage(required.map((dialogue) => ({
    text: dialogue.text,
    englishAllowed: explicitEnglish.some((line) => line.start === dialogue.sourceStart && line.end === dialogue.sourceEnd),
  })), canonicalSpokenUnits(canonicalPrompt));
};

/** Confirmed/local canonical speech uses the same reader as its replacement.
 * This protects timed bare utterances without fixing their old shot or time. */
export const missingCanonicalDialogues = (sourceCanonical: string, candidateCanonical: string): string[] => (
  missingCoverage(canonicalSpokenUnits(sourceCanonical), canonicalSpokenUnits(candidateCanonical))
);

const quoteBareSpokenBody = (body: string): string => {
  const first = body.search(/\S/u);
  if (first < 0) return body;
  const end = body.length - (body.match(/[\s|｜；;]*$/u)?.[0].length || 0);
  const text = body.slice(first, end);
  if (!coverageKey(text)) return body;
  const quotes = protectedTextQuoteSpans(text);
  if (quotes.length) {
    let cursor = 0;
    let outside = '';
    for (const quote of quotes) { outside += text.slice(cursor, quote.start); cursor = quote.end; }
    outside += text.slice(cursor);
    if (!coverageKey(outside.replace(/[（(][^()（）]*[）)]/gu, ''))) return body;
  }
  const pair = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']].find(([open, close]) => !text.includes(open) && !text.includes(close));
  if (!pair) return body;
  return body.slice(0, first) + pair[0] + text + pair[1] + body.slice(end);
};

/** Add only outer speech quotes for the existing H3/English protection path.
 * Authored words, speaker headers, times and all other fields stay unchanged. */
export const normalizeCanonicalDialogueQuotes = (prompt: string): string => prompt
  .split(/(?=^【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】)/mu)
  .map((line) => replaceCanonicalDialogueField(line, (field) => {
    if (!field.trim() || silence.test(field.trim())) return field;
    field = repairQuotedNextSpeakerTimes(field);
    const headers = fieldSpeakerHeaders(field);
    if (!headers.length) {
      const timing = field.match(/^\s*第\s*-?\d+(?:\.\d+)?\s*(?:s|秒)(?:起|开始)?\s*[:：]?\s*/iu)?.[0] || '';
      return timing + quoteBareSpokenBody(field.slice(timing.length));
    }
    let result = field;
    for (let index = headers.length - 1; index >= 0; index -= 1) {
      const start = headers[index].end;
      const end = headers[index + 1]?.start ?? field.length;
      result = result.slice(0, start) + quoteBareSpokenBody(field.slice(start, end)) + result.slice(end);
    }
    return result;
  })).join('');
