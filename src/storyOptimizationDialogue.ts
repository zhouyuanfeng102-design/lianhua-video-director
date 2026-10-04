/** Conservative dialogue extraction used only by video-ready story optimization.
 * Spans always point into the caller's original string, so accepted formatting
 * changes can be replaced with the source's exact words without rewriting prose.
 */
export interface OptimizationDialogueLine {
  utterance: string;
  speaker: string;
  start: number;
  end: number;
}

export interface OptimizationDialogueMismatch {
  index: number;
  kind: 'missing' | 'extra' | 'text' | 'speaker';
  expected?: { utterance: string; speaker: string };
  actual?: { utterance: string; speaker: string };
}

interface QuoteSpan {
  open: number;
  start: number;
  end: number;
  close: number;
}

interface SpeakerAttribution {
  speaker: string;
  valid: boolean;
  speechCue: boolean;
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'",
};
const RESERVED_LABEL = /^(?:标题|剧情|原文|正文|梗概|要求|说明|地点|场景|时间|人物|角色|主体|空间|光影|镜头|景别|机位|运镜|台词|对白|独白|背景信息|出场人物|音效|道具|道具名|物品|名称|术语|风格|备注|任务|标牌|标签|书名)$/u;
const IMPLICIT_SPEAKER = /^(?:我|我们|本人|你|你们|他|她|它|祂|他们|她们|它们|祂们|其|此人|那人|对方|来人|众人|有人|说话人不明|说话人未明|未知说话人|未明确说话人|第一人称叙述者|叙述者)$/u;
// Match complete speech verbs before considering the plain "姓名：" form.
// In particular, 应道 must never be frozen as part of the narrator's name.
const SPEECH_VERB_SOURCE = '(?:笑盈盈道|低声道|轻声道|高声道|大声道|柔声道|冷声道|厉声道|沉声道|颤声道|回答道|回应道|提醒道|解释道|补充道|询问道|反问道|低语道|嘀咕道|喃喃道|说道|问道|答道|喊道|叫道|应道|回道|笑道|叹道|喝问|喝道|回应|回答|提醒|命令|嘀咕|喃喃|开口|求饶|质问|争辩|解释|补充|询问|反问|低语|接话|说|问|答|喊|叫)';
const SUFFIX_SPEECH_VERB = new RegExp(`${SPEECH_VERB_SOURCE}(?:着)?$`, 'u');
const FOLLOWING_SPEECH_VERB = new RegExp(`^(.{1,64}?)(${SPEECH_VERB_SOURCE}|应得|应声|答得)(?:[\\s\\S]*)$`, 'u');
const DELIVERY_SUFFIX = /(?:用|以|带着|压着|放低|提高)[^，。！？!?；;：:\n]{0,48}(?:声音|嗓音|语气|口吻|声线)$/u;
const DELIVERY_WORD_SUFFIX = /(?:愣了一下才|愣了愣才|停顿了一下才|顿了顿才|想了想才|笑了笑才|笑了笑|咬了咬牙|挑了挑眉|皱了皱眉|愣了一下|愣了愣|挑眉|皱眉|扬眉|点头|摇头|咬牙|低声|高声|大声|轻声|厉声|沉声|冷声|急声|颤声|柔声|低低|轻轻|冷冷|淡淡|连忙|缓缓|忽然|突然|再次|随即|立刻|终于|抬头|转身|回头|俯身|笑着|哭着|喘着|忍不住|接着|继续|才|又)$/u;
const DIRECTED_DELIVERY_SUFFIX = /(?:对|向|冲|朝|跟)(?:着)?(?:我|你|他|她|它|祂|我们|你们|他们|她们|众人|大家)$/u;
const EXPLICIT_DIRECTED_DELIVERY = /^(.{1,32}?)(?:对|向|冲|朝|跟)(?:着)?([A-Za-z0-9_@·\p{Script=Han}-]{1,16})$/u;
const VOICE_ANNOTATION = /^[（(](?:轻声|低声|高声|大声|厉声|沉声|冷声|柔声|急声|颤声|低语|耳语|小声|平静|疑惑|惊讶|愤怒|笑着|哭着|喘着|咬牙|旁白|画外音|内心独白|OS|VO)(?:[^（）()\n]{0,16})[）)]$/iu;
const NARRATIVE_RESIDUE = /(?:写着|写有|写下|显示|标注|标记|标题|标牌|叫作|称作|称为|看到|看见|看向|望向|看着|听见|还没|没有|并未|从未|不曾|不肯|拒绝|并不|压根|怎么|为何|已经|正在|然后|忽然|突然|愣了|转过|回过|走到|走向|站在|站到|坐在|靠在|靠近|凑近|凑到|伸出|伸手|低下|抬起|抬手|的声音|的语气|面无表情|一脸|面带|露出|告诉|认为|准备|想要|必须|不要|不许|不能|还未|尚未|似乎|仿佛|接到|收到|得到|下达|发布)/u;
const IMPLICIT_WITH_NARRATIVE = /^(?:我|你|他|她|它|祂|我们|你们|他们|她们)(?:还|也|就|便|才|却|正|仍|又|先|一边|不由|不禁|忍不住|应得|应声|答得)/u;
const WRITTEN_QUOTE_PREFIX = /(?:写着|写有|写的是|写下|印着|标着|标注为|标记为|显示着|显示为|显示|题为|名为|叫作|称作|称为|所谓|标题为|标题是|书名|术语|标签)[^。！？!?\n]{0,24}$/u;
const SENTENCE_END = /[。！？!?…]$/u;
const NON_PERSON_LABEL = /^(?:只|只是|只好|只得|仅|仅仅|便|就|又|还|也|却|才|于是|随后|接着|继续|低声|轻声|高声|大声|柔声|冷声|厉声|沉声|颤声|笑盈盈)$/u;

const isApostrophe = (text: string, index: number): boolean => (
  text[index] === "'"
  && /[\p{Script=Latin}\p{N}]/u.test(text[index - 1] || '')
  && /[\p{Script=Latin}\p{N}]/u.test(text[index + 1] || '')
);

/** Balanced scanning removes the old 240-character/newline limits and retains
 * nested quoted words inside their enclosing utterance. */
const scanQuotes = (text: string): QuoteSpan[] => {
  const spans: QuoteSpan[] = [];
  const stack: Array<{ opening: string; closing: string; index: number }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (isApostrophe(text, index)) continue;
    const current = stack[stack.length - 1];
    if (current && character === current.closing) {
      stack.pop();
      if (!stack.length) spans.push({ open: current.index, start: current.index + 1, end: index, close: index + 1 });
      continue;
    }
    const closing = QUOTE_PAIRS[character];
    if (character === "'" && /[\p{Script=Latin}\p{N}]/u.test(text[index - 1] || '')) continue;
    if (closing) stack.push({ opening: character, closing, index });
  }
  return spans;
};

const removeVoiceAnnotations = (value: string): string => value.replace(/[（(][^（）()\n]{1,32}[）)]/gu, (annotation) => (
  VOICE_ANNOTATION.test(annotation) ? '' : annotation
));

const removeExplicitSpeechRecipient = (value: string): string => {
  const match = value.match(EXPLICIT_DIRECTED_DELIVERY);
  if (!match) return value;
  const subject = match[1].trim();
  const recipient = match[2].trim();
  // Only a short, explicit noun/pronoun recipient is recognized. In particular,
  // do not truncate a name such as 李朝阳 into 李 + 朝 + 阳.
  if ((!IMPLICIT_SPEAKER.test(subject) && !/^[A-Za-z0-9_@·\p{Script=Han}-]{2,16}$/u.test(subject))
    || (!IMPLICIT_SPEAKER.test(recipient) && recipient.length < 2)
    || NARRATIVE_RESIDUE.test(subject) || NARRATIVE_RESIDUE.test(recipient)) return value;
  return subject;
};

const parseSpeaker = (value: string): SpeakerAttribution => {
  let name = removeVoiceAnnotations(value.trim()).trim();
  const speechVerb = name.match(SUFFIX_SPEECH_VERB);
  const speechCue = Boolean(speechVerb);
  if (speechVerb) name = name.slice(0, speechVerb.index).trim();
  if (speechCue) {
    // Strip only recognized delivery phrases, not arbitrary prefixes/substrings.
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const previous = name;
      name = name.replace(DELIVERY_SUFFIX, '').replace(DELIVERY_WORD_SUFFIX, '')
        .replace(DIRECTED_DELIVERY_SUFFIX, '').trim();
      name = removeExplicitSpeechRecipient(name);
      if (name === previous) break;
    }
  }
  if (!name || RESERVED_LABEL.test(name)) return { speaker: '', valid: false, speechCue };
  if (NON_PERSON_LABEL.test(name) || /^(?:语气|声音|嗓音|声线|口吻)/u.test(name)) return { speaker: '', valid: false, speechCue };
  if (IMPLICIT_SPEAKER.test(name)) return { speaker: '', valid: true, speechCue };
  if (!/^[A-Za-z0-9_@·\p{Script=Han}-]{1,32}$/u.test(name)
    || NARRATIVE_RESIDUE.test(name) || IMPLICIT_WITH_NARRATIVE.test(name)
    || /(?:用|以|带着|压着|放低|提高).*(?:声音|嗓音|语气|口吻|声线)/u.test(name)) {
    return { speaker: '', valid: false, speechCue };
  }
  return { speaker: name, valid: true, speechCue };
};

const prefixAttribution = (text: string, open: number): SpeakerAttribution => {
  const prefix = text.slice(Math.max(0, open - 256), open).trimEnd();
  const hadColon = /[：:]$/u.test(prefix);
  const withoutColon = prefix.replace(/[：:]$/u, '').trimEnd();
  // A clock immediately before a quoted event is not a numeric speaker label;
  // do not reinterpret the minute component in "10:30：‘集合。’" as person 30.
  if (/(?:^|[^\d])(?:[01]?\d|2[0-3])[：:][0-5]\d(?:[：:][0-5]\d)?$/u.test(withoutColon)) {
    return { speaker: '', valid: false, speechCue: false };
  }
  const clause = withoutColon.split(/[。！？!?，,；;：:\n\r”’」』"]/u).pop()?.trim() || '';
  const attribution = parseSpeaker(clause);
  return attribution.speechCue || hadColon ? attribution : { speaker: '', valid: false, speechCue: false };
};

const suffixAttribution = (text: string, close: number): SpeakerAttribution => {
  // A full stop outside the closing quote starts a new sentence, not an
  // attribution. Only whitespace/comma may precede an immediate speech verb.
  const suffix = text.slice(close, close + 128).replace(/^[ \t，,]+/u, '');
  const clause = suffix.split(/[。！？!?，,；;：:\n\r“‘「『"]/u)[0];
  const match = clause.match(FOLLOWING_SPEECH_VERB);
  if (!match) return { speaker: '', valid: false, speechCue: false };
  const afterVerb = suffix.slice(match[1].length + match[2].length);
  if (/^\s*[：:]?\s*[“‘「『"']/u.test(afterVerb)) {
    return { speaker: '', valid: false, speechCue: false };
  }
  const suffixVerb = /^(?:应得|应声|答得)$/u.test(match[2]) ? '说' : match[2];
  return parseSpeaker(`${match[1]}${suffixVerb}`);
};

const trimmedSpan = (text: string, start: number, end: number): { start: number; end: number } => {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { start, end };
};

const lineAt = (text: string, start: number, end: number, speaker: string): OptimizationDialogueLine | undefined => {
  const span = trimmedSpan(text, start, end);
  if (span.start === span.end) return undefined;
  return { utterance: text.slice(span.start, span.end), speaker, ...span };
};

interface ColonMarker { start: number; contentStart: number; attribution: SpeakerAttribution }

const findColonMarkers = (text: string, quotes: QuoteSpan[], dialogueField: boolean): ColonMarker[] => {
  const markers: ColonMarker[] = [];
  const markerPattern = /(^|[\s。！？!?；;，,”’」』"])([A-Za-z0-9_@·\p{Script=Han}-]{1,32}(?:[（(][^（）()\n]{1,32}[）)])?)[：:]/gu;
  for (const match of text.matchAll(markerPattern)) {
    const start = match.index! + match[1].length;
    if (quotes.some((quote) => start >= quote.open && start < quote.close)) continue;
    const attribution = parseSpeaker(match[2]);
    if (!attribution.valid && !attribution.speechCue) continue;
    if (!dialogueField) {
      const label = match[2];
      const following = text.slice(match.index! + match[0].length);
      if (/^\d{1,2}$/u.test(label) && Number(label) <= 23 && /^[0-5]\d(?!\d)/u.test(following)) continue;
      // In prose, arbitrary comma/space-delimited clauses ending in a colon
      // are not speaker labels. Keep the old sentence/line boundary for bare
      // labels; real speech cues and quoted attributions are handled separately.
      if (!attribution.valid) continue;
      if (!attribution.speechCue && (
        !/(?:^|[。！？!?\n\r”’」』"'])[ \t]*$/u.test(text.slice(0, start))
        || /(?:任务|命令|通知|计划|目标|内容|说明|要求|备注|标牌|提示|标语|指令)$/u.test(match[2])
      )) continue;
    }
    markers.push({ start, contentStart: match.index! + match[0].length, attribution });
  }
  return markers;
};

export const extractOptimizationDialogueLines = (
  text: string,
  options: { dialogueField?: boolean } = {},
): OptimizationDialogueLine[] => {
  const dialogueField = Boolean(options.dialogueField);
  const quotes = scanQuotes(text);
  const markers = findColonMarkers(text, quotes, dialogueField);
  const dialogue: OptimizationDialogueLine[] = [];
  const consumed: Array<{ start: number; end: number }> = [];
  for (const [index, marker] of markers.entries()) {
    const nextMarker = markers[index + 1]?.start ?? text.length;
    const nextNewline = text.indexOf('\n', marker.contentStart);
    const end = dialogueField || nextNewline < 0 ? nextMarker : Math.min(nextMarker, nextNewline);
    const content = trimmedSpan(text, marker.contentStart, end);
    if (content.start === content.end) continue;
    const wrappingQuote = quotes.find((quote) => quote.open === content.start);
    if (wrappingQuote) {
      // Quoted narrative and quoted field entries are handled by the same
      // scanner; do not also add their raw "姓名：" region as a second line.
      continue;
    }
    if (QUOTE_PAIRS[text[content.start]]) continue; // malformed/incomplete quote is not a bare utterance
    const line = lineAt(text, content.start, content.end, marker.attribution.speaker);
    if (line) {
      dialogue.push(line);
      consumed.push(content);
    }
  }
  for (const quote of quotes) {
    if (consumed.some((range) => quote.open >= range.start && quote.close <= range.end)) continue;
    const prefix = prefixAttribution(text, quote.open);
    const suffix = suffixAttribution(text, quote.close);
    const utterance = text.slice(quote.start, quote.end).trim();
    const context = text.slice(Math.max(0, quote.open - 96), quote.open).trimEnd();
    const writtenQuote = !prefix.speechCue && !suffix.speechCue && WRITTEN_QUOTE_PREFIX.test(context);
    if (!dialogueField && (writtenQuote || !(prefix.valid || prefix.speechCue || suffix.speechCue || SENTENCE_END.test(utterance)))) continue;
    // An explicit preceding attribution is not displaced by the following
    // sentence (which may already introduce the next person's turn).
    const speaker = prefix.speaker || suffix.speaker;
    const line = lineAt(text, quote.start, quote.end, speaker);
    if (line) dialogue.push(line);
  }
  return dialogue.sort((left, right) => left.start - right.start);
};

export interface OptimizationSpeakerLabelConcern {
  rawLabel: string;
  speaker: string;
  utterance: string;
  start: number;
  end: number;
}

/** Retain the raw label for advisory UI even when conservative parsing leaves
 * both source and candidate identities unresolved. This prevents a bad label
 * such as "只" from silently becoming an authoritative person's name. */
export const extractOptimizationSpeakerLabelConcerns = (text: string): OptimizationSpeakerLabelConcern[] => {
  const quotes = scanQuotes(text);
  const markers = [...text.matchAll(/(^|[\s。！？!?；;，,”’」』"])([A-Za-z0-9_@·\p{Script=Han}-]{1,32}(?:[（(][^（）()\n]{1,32}[）)])?)[：:]/gu)];
  const concerns: OptimizationSpeakerLabelConcern[] = [];
  for (const [index, marker] of markers.entries()) {
    const start = marker.index! + marker[1].length;
    if (quotes.some((quote) => start >= quote.open && start < quote.close) || RESERVED_LABEL.test(marker[2])) continue;
    const rawLabel = marker[2];
    const attribution = parseSpeaker(rawLabel);
    const cleanLabel = removeVoiceAnnotations(rawLabel).trim();
    const simpleAttribution = cleanLabel.replace(/(?:说(?:道)?|问(?:道)?|答(?:道)?|喊(?:道)?|回答(?:道)?|回应(?:道)?)$/u, '');
    const suspicious = !attribution.valid || Boolean(attribution.speaker && cleanLabel !== attribution.speaker && simpleAttribution !== attribution.speaker);
    if (!suspicious || IMPLICIT_SPEAKER.test(cleanLabel)) continue;
    const contentStart = marker.index! + marker[0].length;
    const nextMarker = markers[index + 1];
    const end = nextMarker ? nextMarker.index! + nextMarker[1].length : text.length;
    const content = trimmedSpan(text, contentStart, end);
    const quote = quotes.find((item) => item.open === content.start);
    const span = quote ? trimmedSpan(text, quote.start, quote.end) : content;
    concerns.push({ rawLabel, speaker: attribution.speaker, utterance: text.slice(span.start, span.end), ...span });
  }
  return concerns;
};

const FORMAT_PUNCTUATION: Readonly<Record<string, string>> = {
  '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':',
  '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
  '“': '"', '”': '"', '‘': '"', '’': '"', '「': '"', '」': '"', '『': '"', '』': '"', "'": '"',
};

const spaceDelimitedCharacter = (value: string): boolean => (
  /[\p{L}\p{N}]/u.test(value)
  && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
);

/** No fuzzy matching, punctuation deletion, paraphrase tolerance, or case fold.
 * English word boundaries survive wrapping: "now here" never equals "nowhere". */
const comparableUtterance = (value: string): string => {
  const characters = Array.from(value.trim());
  // String tokens represent literal characters; numeric zero is a distinct
  // standard-ellipsis token and can never collide with literal story text.
  const normalized: Array<string | 0> = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '.' || character === '…') {
      let run = character;
      while (index + 1 < characters.length && /[.…]/u.test(characters[index + 1])) run += characters[++index];
      if (run === '……' || run === '...' || run === '......') normalized.push(0);
      else normalized.push(...Array.from(run));
    } else if (/\s/u.test(character)) {
      const previous = characters[index - 1] || '';
      while (index + 1 < characters.length && /\s/u.test(characters[index + 1])) index += 1;
      const next = characters[index + 1] || '';
      if (spaceDelimitedCharacter(previous) && spaceDelimitedCharacter(next)) normalized.push(' ');
    } else if ((character === "'" || character === '’')
      && spaceDelimitedCharacter(characters[index - 1] || '')
      && spaceDelimitedCharacter(characters[index + 1] || '')) {
      // An apostrophe inside a word is not a nested dialogue quotation.
      normalized.push("'");
    } else normalized.push(FORMAT_PUNCTUATION[character] || character);
  }
  return JSON.stringify(normalized);
};

export const compareOptimizationDialogue = (
  source: readonly OptimizationDialogueLine[],
  candidate: readonly OptimizationDialogueLine[],
): OptimizationDialogueMismatch[] => {
  const mismatches: OptimizationDialogueMismatch[] = [];
  const describe = (line: OptimizationDialogueLine) => ({ utterance: line.utterance, speaker: line.speaker });
  for (let index = 0; index < Math.max(source.length, candidate.length); index += 1) {
    const expected = source[index];
    const actual = candidate[index];
    if (!expected) {
      mismatches.push({ index: index + 1, kind: 'extra', actual: describe(actual) });
      continue;
    }
    if (!actual) {
      mismatches.push({ index: index + 1, kind: 'missing', expected: describe(expected) });
      continue;
    }
    if (comparableUtterance(expected.utterance) !== comparableUtterance(actual.utterance)) {
      mismatches.push({ index: index + 1, kind: 'text', expected: describe(expected), actual: describe(actual) });
    }
    if (expected.speaker && expected.speaker !== actual.speaker) {
      mismatches.push({ index: index + 1, kind: 'speaker', expected: describe(expected), actual: describe(actual) });
    }
  }
  return mismatches;
};
