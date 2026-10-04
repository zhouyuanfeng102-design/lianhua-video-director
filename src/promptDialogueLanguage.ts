/** Dialogue language is independent from the language of a video prompt's
 * descriptions. This module is pure: it never rewrites a stored storyboard. */
export interface PromptQuoteSpan {
  start: number;
  end: number;
  value: string;
  content: string;
}

export interface PromptDialogue extends PromptQuoteSpan {
  quoteIndex: number;
  speaker: string;
  relativeTime?: number;
  shot: string;
  translateToEnglish: boolean;
}

const QUOTED = /“(?:\\.|[^”])*”|‘(?:\\.|[^’])*’|「(?:\\.|[^」])*」|『(?:\\.|[^』])*』|"(?:\\.|[^"\\])*"/gu;
const DIALOGUE_TOKEN = /__LH_DIALOGUE_\d+__/gu;
const SPEECH_PREFIX = /(?:原对白|对白|台词|旁白|original\s+(?:dialogue|line|utterance)|dialogue|speech)(?:\s+in\s+[A-Za-z -]+)?\s*[:：]|(?:吼道|喊道|说道|问道|答道|回答|回应|喊|吼|说|问|答|念|低语|耳语|\b(?:says?|said|shouts?|yells?|asks?|replies|whispers?|speaks?))[^。；;\n]*[:：。.!?\s]*$/iu;
const NON_SPEECH_PREFIX = /(?:写着|刻着|印着|标牌|招牌|标签|标题|名字|名称|代号|图案|提示词|字幕|文字|\b(?:sign|label|title|caption|inscription|printed|written))[^。；;\n]*[:：\s]*$/iu;
const SPEAKER_LABEL = /^(?:原|原对白|对白|台词|旁白|声音|动作层|环境层|情绪层|说话人|说|说道|喊|喊道|吼|吼道|问|问道|答|回答|回应|讲|念|英语|英文|中文|汉语|普通话|dialogue|speech|original|line|utterance|speaker|in|English|Mandarin|Chinese|says?|said)$/iu;
const ENGLISH_SPEECH_REQUEST = /(?:用|使用|以)\s*(?:英语|英文)\s*(?:(?:大声|低声|轻声|小声)\s*)?(?:说|讲|喊|念|回答|对白|台词|发言)|(?:英语|英文)\s*(?:原对白|对白|台词|配音)|(?:对白|台词)(?:语言)?\s*[:：=]?\s*(?:英文|英语)|\b(?:say|speak|reply|dialogue|line|utterance)\b[^.;\n]{0,32}\bin\s+English\b/iu;
const NEGATED_ENGLISH_SPEECH = /(?:不要|不得|不许|禁止|不用|无需|不需要|不能|不使用|无)\s*[^，,。；;\n]{0,10}(?:英文|英语)|\b(?:not|no|never|without|do\s+not)\b[^.;\n]{0,24}\bEnglish\b/iu;
const META_ENGLISH = /(?:用|使用|以)\s*(?:英语|英文)\s*(?:写|描述|生成|输出|翻译|整理|优化)(?:[^，,。；;\n]{0,10})(?:提示词|描述|正文)|(?:学习|学|练习)\s*(?:英语|英文)/u;

export const getPromptQuoteSpans = (source: string): PromptQuoteSpan[] => Array.from(source.matchAll(QUOTED), (match) => ({
  start: match.index!, end: match.index! + match[0].length, value: match[0], content: match[0].slice(1, -1),
}));

export const getPromptSpeakerNames = (source: string): string[] => [...new Set([
  ...(source.match(/@[\p{L}\p{N}_·•-]+/gu) || []).map((name) => name.slice(1)),
  ...Array.from(source.matchAll(/^<(?:Subject|Picture|Video|Audio)\s+\d+>\s+is\s+(.+?)(?=\s+(?:referenced from\s+<|defined by\b)|\s*[:：])/gmu), (match) => match[1].replace(/^@/u, '').trim())
    .filter((name) => !/^the referenced .+ source$/iu.test(name)),
])].filter(Boolean).sort((left, right) => right.length - left.length);

const normalizeSpeaker = (speaker: string): string => speaker.replace(/^@/u, '').trim();
const lastShot = (source: string, start: number): string => Array.from(source.slice(0, start).matchAll(/\[Shot\s+\d+\]|【[^】]+】/gu)).slice(-1)[0]?.[0] || '';
const ANNOTATED_SPEAKER_NAME = '(?:@?[\\p{L}\\p{N}_·•-]{1,40}|<Subject\\s+\\d+>)';
const ANNOTATED_SPEAKER_FIELD = /^(?:主体|空间|光影|镜头|声音|音效|台词|对白|旁白|scene|camera|lighting|sound|dialogue|speech)$/iu;
const annotatedCueTail = new RegExp(`(?:^|[\\s；;|｜，,：:])(${ANNOTATED_SPEAKER_NAME})(?:\\s*[（(][^()（）\\r\\n]*[）)])+\\s*[:：]\\s*$`, 'u');
const annotatedCueOpening = new RegExp(`(?:^|[\\s；;|｜，,：:])(${ANNOTATED_SPEAKER_NAME})(?:\\s*[（(][^()（）\\r\\n]*[）)])*\\s*[（(][^()（）\\r\\n]*$`, 'u');
const quotedSpeakerAnnotation = (source: string, quote: PromptQuoteSpan): boolean => {
  const opening = source.slice(0, quote.start).match(annotatedCueOpening);
  return Boolean(opening && !ANNOTATED_SPEAKER_FIELD.test(opening[1].replace(/^@/u, ''))
    && /^[^()（）\r\n]*[）)](?:\s*[（(][^()（）\r\n]*[）)])*\s*[:：]/u.test(source.slice(quote.end)));
};
const localPrefix = (source: string, quote: PromptQuoteSpan, previousEnd: number): string => {
  const annotated = source.slice(0, quote.start).match(annotatedCueTail);
  if (annotated && !ANNOTATED_SPEAKER_FIELD.test(annotated[1].replace(/^@/u, ''))) {
    const cueStart = annotated.index!;
    if (previousEnd > cueStart) {
      // The previous quotation can be a delivery note inside this very cue.
      // Rewind only to the preceding real quote and keep the whole annotated
      // speaker prefix (including any language cue and original timestamp).
      const priorQuoteEnd = getPromptQuoteSpans(source.slice(0, cueStart)).slice(-1)[0]?.end || 0;
      const beforeCue = source.slice(priorQuoteEnd, cueStart).split(/[\n；;]/u).filter((part) => part.trim()).slice(-1)[0] || '';
      return `${beforeCue}${source.slice(cueStart, quote.start)}`.trim();
    }
  }
  const between = source.slice(previousEnd, quote.start);
  // Keep the last nonempty clause, including a speech lead on the preceding
  // line. Quoted dialogue itself never contributes a language instruction.
  const clauses = between.split(/[\n；;]/u).filter((part) => part.trim());
  return clauses.slice(-1)[0]?.trim() || '';
};
const relativeTime = (prefix: string): number | undefined => {
  const marked = Array.from(prefix.matchAll(/(?:第\s*|\b(?:at|from|starting\s+at|beginning\s+at)\s+)(\d+(?:\.\d+)?)\s*(?:seconds?|s|秒)/giu)).slice(-1)[0];
  const bareEnglish = Array.from(prefix.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/giu)).slice(-1)[0];
  const value = marked?.[1] ?? bareEnglish?.[1];
  return value === undefined ? undefined : Number(value);
};
const speakerFor = (prefix: string, names: readonly string[]): string => {
  const labels = [...names, ...(prefix.match(/<Subject\s+\d+>/gu) || [])].filter(Boolean);
  let selected = '';
  let selectedIndex = -1;
  for (const name of labels) {
    const index = prefix.lastIndexOf(name);
    if (index > selectedIndex) { selected = name; selectedIndex = index; }
  }
  if (selected) return normalizeSpeaker(selected);
  const stripped = prefix.replace(/第\s*\d+(?:\.\d+)?\s*(?:s|秒)(?:起)?/giu, ' ')
    .replace(/(?:用|使用|以)(?:英语|英文)(?=(?:说|讲|喊|念|回答))/gu, '');
  const matched = stripped.match(/(?:^|[：:，,\[\]\s])(@?[\p{L}\p{N}_·•-]{1,40}?)(?:原对白|对白|台词|吼道|喊道|说道|问道|答道|回答|回应|低语|耳语|说|问|答|喊|吼)?\s*[:：。.!?\s]*$/u)?.[1] || '';
  return SPEAKER_LABEL.test(matched) ? '' : normalizeSpeaker(matched);
};

const describeQuote = (source: string, quote: PromptQuoteSpan, quoteIndex: number, previousEnd: number, names: readonly string[]): PromptDialogue & { isSpeech: boolean } => {
  const prefix = localPrefix(source, quote, previousEnd);
  const speaker = speakerFor(prefix, names);
  const directSpeaker = Boolean(speaker) && /[:：]\s*$/u.test(prefix);
  const isSpeech = !quotedSpeakerAnnotation(source, quote) && !NON_SPEECH_PREFIX.test(prefix) && (SPEECH_PREFIX.test(prefix) || directSpeaker);
  const explicitEnglish = ENGLISH_SPEECH_REQUEST.test(prefix)
    && !NEGATED_ENGLISH_SPEECH.test(prefix) && !META_ENGLISH.test(prefix);
  // Existing English/Latin-script dialogue is already the requested wording;
  // an English annotation is not permission to paraphrase it.
  const nonLatinSpeech = Array.from(quote.content).some((char) => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char));
  return { ...quote, quoteIndex, speaker, relativeTime: relativeTime(prefix), shot: lastShot(source, quote.start), translateToEnglish: explicitEnglish && nonLatinSpeech, isSpeech };
};

export const getPromptDialogues = (source: string): PromptDialogue[] => {
  const quotes = getPromptQuoteSpans(source);
  const names = getPromptSpeakerNames(source);
  return quotes.map((quote, index) => describeQuote(source, quote, index, quotes[index - 1]?.end || 0, names))
    .filter((quote) => quote.isSpeech);
};

/** Used for saved-English freshness as well as live translation validation.
 * Original-language utterances are compared byte-for-byte and in source
 * order; English is allowed only for that source utterance's explicit cue. */
export const isDialogueLanguagePreserved = (sourcePrompt: string, candidateEnglish: string): boolean => {
  const originals = getPromptDialogues(sourcePrompt);
  if (!originals.length) return true;
  const sourceQuotes = getPromptQuoteSpans(sourcePrompt);
  const candidates = getPromptQuoteSpans(candidateEnglish);
  if (candidates.length !== sourceQuotes.length || /__LH_DIALOGUE_/u.test(candidateEnglish)) return false;
  const names = [...new Set([...getPromptSpeakerNames(sourcePrompt), ...originals.map((line) => line.speaker)])].filter(Boolean);
  return originals.every((original) => {
    const candidate = candidates[original.quoteIndex];
    const details = describeQuote(candidateEnglish, candidate, original.quoteIndex, candidates[original.quoteIndex - 1]?.end || 0, names);
    if (!details.isSpeech || details.shot !== original.shot || details.relativeTime !== original.relativeTime
      || original.speaker && normalizeSpeaker(details.speaker) !== normalizeSpeaker(original.speaker)) return false;
    if (!original.translateToEnglish) {
      // Retaining Chinese quote bytes while relabelling the speech "in
      // English" would still tell the video model to change the spoken language.
      return !details.translateToEnglish && candidate.content === original.content;
    }
    return /[A-Za-z]/u.test(candidate.content)
      && !Array.from(candidate.content).some((char) => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char));
  });
};

/** Opaque per-occurrence dialogue tokens use the existing full-prompt token
 * protocol. Quote indices keep identical lines with different language cues
 * distinct; a raw original line or mixed raw/token response is accepted. */
export const buildPromptDialogueProtection = (source: string) => {
  const quotes = getPromptQuoteSpans(source);
  const dialogues = getPromptDialogues(source);
  const preserved = dialogues.filter((dialogue) => !dialogue.translateToEnglish).map((dialogue, index) => ({
    ...dialogue, token: `__LH_DIALOGUE_${String(index + 1).padStart(3, '0')}__`,
  }));
  const protect = (text: string): string => {
    const parts: Array<{ start: number; end: number; content?: string; token?: string }> = [
      ...getPromptQuoteSpans(text),
      ...Array.from(text.matchAll(DIALOGUE_TOKEN), (match) => ({ start: match.index!, end: match.index! + match[0].length, token: match[0] })),
    ].sort((left, right) => left.start - right.start);
    if (parts.length !== quotes.length) return text;
    let result = text;
    for (const dialogue of [...preserved].sort((left, right) => right.quoteIndex - left.quoteIndex)) {
      const candidate = parts[dialogue.quoteIndex];
      if (candidate.token === dialogue.token || candidate.content === dialogue.content) {
        result = result.slice(0, candidate.start) + dialogue.token + result.slice(candidate.end);
      }
    }
    return result;
  };
  const withoutDialogue = (text: string): string => {
    const candidateQuotes = getPromptQuoteSpans(text);
    return [...dialogues].sort((left, right) => right.quoteIndex - left.quoteIndex).reduce((body, dialogue) => {
      const quote = candidateQuotes[dialogue.quoteIndex];
      return quote ? body.slice(0, quote.start) + body.slice(quote.end) : body;
    }, text);
  };
  return { dialogues, preserved, protect, withoutDialogue };
};
