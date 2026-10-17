import type { H3IdentityBindings, H3IdentityEventBinding, SemanticSegmentSource } from './types';
import { getPromptVisibleTextSpans } from './promptDialogueLanguage';

export interface PromptTranslationSourceCharacter {
  id: string;
  name: string;
  aliases?: readonly string[];
  relationship?: string;
}

export interface PromptTranslationCharacter {
  characterId: string;
  name: string;
  aliases: string[];
  subjectToken?: string;
  speakerToken?: string;
  relationship?: string;
}

interface SourceRange { sourceStart: number; sourceEnd: number }

export interface PromptTranslationLiteral extends SourceRange {
  kind: 'literal';
  /** Every literal comes from the source or its already declared name dictionary. */
  text: string;
  literalKind: 'entity' | 'dialogue' | 'visible-text' | 'protocol' | 'number' | 'layout';
  characterId?: string;
}

export interface PromptTranslationSlot extends SourceRange {
  kind: 'slot';
  id: string;
  sourceText: string;
  /** Read-only surrounding source; these strings are never returned for translation. */
  before: string;
  after: string;
  /** Translate every slot in this complete line together, not as isolated words. */
  groupId: string;
  groupSourceText: string;
  /** Explicit source events covering this fragment; no roles are inferred from prose. */
  eventIds?: string[];
}

export interface PromptTranslationGroup extends SourceRange {
  id: string;
  sourceText: string;
  slotIds: string[];
}

export interface PromptTranslationSourceDialogue {
  id?: string;
  text: string;
  speakerCharacterId?: string;
  listenerCharacterIds?: readonly string[];
  addressedCharacterIds?: readonly string[];
}

export interface PromptTranslationUtterance extends SourceRange {
  id: string;
  text: string;
  /** Absent when the source does not explicitly identify a unique speaker. */
  speakerCharacterId?: string;
  speakerToken?: string;
  listenerCharacterIds?: string[];
  addressedCharacterIds?: string[];
}

export interface PromptTranslationIdentityAnchor extends SourceRange {
  characterId: string;
}

export interface PromptTranslationEventAnchor extends SourceRange {
  eventIndex: number;
  eventId: string;
}

export type PromptTranslationSourceEvent = SemanticSegmentSource['events'][number];

export interface PromptTranslationDocument {
  version: 1;
  sourcePrompt: string;
  characters: PromptTranslationCharacter[];
  atoms: Array<PromptTranslationLiteral | PromptTranslationSlot>;
  slots: PromptTranslationSlot[];
  groups: PromptTranslationGroup[];
  utterances: PromptTranslationUtterance[];
  events: H3IdentityEventBinding[];
  sourceEvents?: PromptTranslationSourceEvent[];
  identityBindings?: H3IdentityBindings;
  identityAnchors: PromptTranslationIdentityAnchor[];
  eventAnchors: PromptTranslationEventAnchor[];
}

export interface BuildPromptTranslationDocumentInput {
  sourcePrompt: string;
  identityBindings?: H3IdentityBindings;
  sourceCharacters?: readonly PromptTranslationSourceCharacter[];
  /** Explicit source facts only. Text matching never inspects a form of address. */
  sourceDialogues?: readonly PromptTranslationSourceDialogue[];
  sourceEvents?: readonly PromptTranslationSourceEvent[];
}

export interface RenderPromptTranslationDocumentResult {
  prompt: string;
  identityBindings?: H3IdentityBindings;
  deliveryWarnings: string[];
}

interface OpaqueRange extends SourceRange { dialogue: boolean; content: string; visibleText?: boolean }
interface NameReference { value: string; name: string; characterId?: string }
interface FixedRange extends PromptTranslationLiteral { priority: number }

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const latinWord = /[\p{Script=Latin}\p{N}_]/u;
const voiceIds = '[SＳ][0-9０-９]+(?:\\s*[,，]\\s*[SＳ][0-9０-９]+)*';
const canonicalVoiceToken = (ids: string): string => `(${ids.normalize('NFKC').replace(/\s*[,，]\s*/gu, ',').trim()})`;
const sourceVoiceToken = (value: string): string => canonicalVoiceToken(value.replace(/^[（(]\s*|\s*[）)]$/gu, ''));
const speechVerb = '(?:低声说道|回答道|回答|回应|说道|问道|答道|喊道|吼道|补充道|低语|耳语|说|问|答|喊|吼|念|says?|said|asks?|asked|replies|replied|speaks?|whispers?|shouts?|calls?|sings?)';
const isEscaped = (source: string, index: number): boolean => {
  let count = 0;
  for (let at = index - 1; at >= 0 && source[at] === '\\'; at -= 1) count += 1;
  return count % 2 === 1;
};

/** Literal quotes mask protocol-looking examples even when they are not speech. */
const opaqueRanges = (source: string, names: readonly NameReference[]): OpaqueRange[] => {
  const ranges: OpaqueRange[] = [];
  const visibleQuotes = getPromptVisibleTextSpans(source);
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" };
  for (let index = 0; index < source.length; index += 1) {
    const tagged = source.slice(index).match(/^<d>[\s\S]*?<\/d>/iu);
    if (tagged) {
      ranges.push({ sourceStart: index, sourceEnd: index + tagged[0].length,
        dialogue: true, content: tagged[0].replace(/^<d>|<\/d>$/giu, '') });
      index += tagged[0].length - 1;
      continue;
    }
    const open = source[index];
    const close = pairs[open];
    if (!close || isEscaped(source, index)
      || (open === "'" && /[\p{L}\p{N}]/u.test(source[index - 1] || '') && /[\p{L}\p{N}]/u.test(source[index + 1] || ''))) continue;
    let end = index + 1;
    for (; end < source.length; end += 1) if (source[end] === close && !isEscaped(source, end)) break;
    if (end === source.length) continue;
    const prefix = source.slice(Math.max(0, index - 180), index);
    const visibleText = visibleQuotes.some((quote) => quote.start === index && quote.end === end + 1);
    const dialogue = !visibleText && (new RegExp(`(?:${speechVerb})[^。！？!?；;\\n]{0,70}[:：]?\\s*$`, 'iu').test(prefix)
      || /(?:台词|对白|旁白|dialogue|speech)\s*[:：]\s*$/iu.test(prefix)
      || /(?:[（(][SＳ][0-9０-９]+(?:\s*[,，]\s*[SＳ][0-9０-９]+)*[）)]|<Subject\s+\d+>)\s*[:：]\s*$/u.test(prefix)
      || names.some((name) => new RegExp(`@?${escapePattern(name.value)}(?:\\s*[（(]${voiceIds}[）)])?(?:[（(][^()（）\\n]*[）)])?\\s*[:：]\\s*$`, 'u').test(prefix)));
    ranges.push({ sourceStart: index, sourceEnd: end + 1, dialogue, content: source.slice(index + 1, end), ...(visibleText ? { visibleText: true } : {}) });
    index = end;
  }
  return ranges;
};

const buildCharacters = (input: BuildPromptTranslationDocumentInput): PromptTranslationCharacter[] => {
  const characters = new Map<string, PromptTranslationCharacter>();
  for (const character of input.sourceCharacters || []) if (character.id && character.name) {
    characters.set(character.id, { characterId: character.id, name: character.name,
      aliases: [...new Set(character.aliases?.filter(Boolean) || [])],
      ...(character.relationship ? { relationship: character.relationship } : {}) });
  }
  for (const binding of input.identityBindings?.characters || []) {
    const existing = characters.get(binding.characterId);
    characters.set(binding.characterId, { characterId: binding.characterId, name: binding.name,
      aliases: [...new Set([...(existing?.aliases || []), ...(existing && existing.name !== binding.name ? [existing.name] : [])])],
      ...(binding.subjectToken ? { subjectToken: binding.subjectToken } : {}),
      ...(binding.speakerToken ? { speakerToken: binding.speakerToken } : {}),
      ...(binding.relationship || existing?.relationship ? { relationship: binding.relationship || existing?.relationship } : {}) });
  }
  return [...characters.values()];
};

const nameReferences = (characters: readonly PromptTranslationCharacter[]): NameReference[] => {
  const byValue = new Map<string, PromptTranslationCharacter[]>();
  for (const character of characters) for (const value of new Set([character.name, ...character.aliases])) {
    if (!value) continue;
    byValue.set(value, [...(byValue.get(value) || []), character]);
  }
  return [...byValue].map(([value, owners]) => owners.length === 1
    ? { value, name: owners[0].name, characterId: owners[0].characterId }
    // A shared title is kept verbatim rather than assigned to an arbitrary ID.
    : { value, name: value }).sort((left, right) => right.value.length - left.value.length);
};

const matchesNameBoundary = (source: string, start: number, value: string): boolean => (
  !(latinWord.test(value[0] || '') && latinWord.test(source[start - 1] || ''))
  && !(latinWord.test(value[value.length - 1] || '') && latinWord.test(source[start + value.length] || ''))
);

/** Official legacy Subject definitions are explicit name declarations, not inferred cast. */
const declaredSubjectNames = (source: string): Array<{ name: string; subjectToken: string }> => [...source.matchAll(
  /^(<Subject\s+\d+>)\s+(?:is\s+|是\s*|为\s*)(.+?)(?=\s+(?:referenced from\s+<|defined by\b)|\s*[:：])/gmu,
)].map((match) => ({ subjectToken: match[1], name: match[2].replace(/^@/u, '').trim() })).filter((entry) => entry.name.length > 0 && entry.name.length <= 100);

/** Read only explicit cue grammar/declared IDs; the addressed name in <d> is never inspected. */
const explicitSpeaker = (
  prefix: string, characters: readonly PromptTranslationCharacter[], names: readonly NameReference[],
): Pick<PromptTranslationUtterance, 'speakerCharacterId' | 'speakerToken'> => {
  prefix = prefix.replace(/\[Shot[\t ]*\d+\]/gu, '\n');
  const endIds = prefix.match(new RegExp(`[（(](${voiceIds})[）)]\\s*[:：]?\\s*$`, 'u'))?.[1];
  const tokenAtEnd = endIds ? canonicalVoiceToken(endIds) : undefined;
  if (tokenAtEnd) {
    const owners = characters.filter((character) => character.speakerToken && sourceVoiceToken(character.speakerToken) === tokenAtEnd);
    if (owners.length === 1) return { speakerCharacterId: owners[0].characterId, speakerToken: tokenAtEnd };
  }
  // H3 also embeds the source ID inside a delivery annotation, for example
  // Name (S2，女性发声身份，自然发声). This is the same explicit voice declaration,
  // not a nearby character mention. A line with several owners stays unknown.
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const annotated = names.flatMap((name) => {
    if (!name.characterId) return [];
    const pattern = new RegExp(`${escapePattern(name.value)}\\s*[（(]\\s*(${voiceIds})(?:\\s*[,，][^()（）\\n]*)?[）)]`, 'gu');
    return [...line.matchAll(pattern)].map((match) => ({ speakerCharacterId: name.characterId, speakerToken: canonicalVoiceToken(match[1]) }));
  });
  const uniqueAnnotations = [...new Map(annotated.map((entry) => [`${entry.speakerCharacterId}:${entry.speakerToken}`, entry])).values()];
  if (uniqueAnnotations.length === 1) return uniqueAnnotations[0];
  // The already declared voice ID can be repeated next to its explicit owner
  // with delivery prose before <d>. Only one such declaration in the current
  // clause establishes ownership; no nearest-mention fallback is used.
  const declared = names.flatMap((name) => {
    if (!name.characterId) return [];
    const cue = new RegExp(`${escapePattern(name.value)}\\s*([（(]${voiceIds}[）)])([^。！？!?；;\\n]*)$`, 'u');
    const match = prefix.match(cue);
    if (!match || !new RegExp(`${speechVerb}|[:：]\\s*$`, 'iu').test(match[2])) return [];
    return [{ speakerCharacterId: name.characterId, speakerToken: sourceVoiceToken(match[1]) }];
  });
  if (declared.length === 1) return declared[0];
  const listener = names.length ? `(?:${names.map((name) => escapePattern(name.value)).join('|')})` : '(?!)';
  for (const name of names) {
    if (!name.characterId) continue;
    // A speaker starts a clause (possibly after its existing time cue), and may
    // explicitly address another named person before the speech verb.
    const cue = new RegExp(`(?:^|[。！？!?；;\\n，,])\\s*(?:(?:第|At\\s+|From\\s+)?[\\d.:–—~～\\-\\s]+(?:秒|s|seconds?)?[：:,，]?\\s*)?@?${escapePattern(name.value)}\\s*([（(]${voiceIds}[）)])?(?:[（(][^()（）\\n]*[）)])?\\s*(?:(?:对|向|朝着|朝)\\s*${listener}\\s*)?(?:${speechVerb})[^。！？!?；;\\n]*$`, 'iu');
    const match = prefix.match(cue);
    if (match) return { speakerCharacterId: name.characterId,
      ...(match[1] ? { speakerToken: sourceVoiceToken(match[1]) } : {}) };
  }
  // An explicit source-labelled speaker can omit a speech verb: Name (S1): <d>.
  for (const name of names) {
    if (!name.characterId) continue;
    const cue = new RegExp(`(?:^|[。！？!?；;\\n，,])\\s*@?${escapePattern(name.value)}\\s*([（(]${voiceIds}[）)])?\\s*[:：]\\s*$`, 'u');
    const match = prefix.match(cue);
    if (match) return { speakerCharacterId: name.characterId, ...(match[1] ? { speakerToken: sourceVoiceToken(match[1]) } : {}) };
  }
  return tokenAtEnd ? { speakerToken: tokenAtEnd } : {};
};

/** Build a source-ordered translation document. No model output participates in its literals. */
export const buildPromptTranslationDocument = (input: BuildPromptTranslationDocumentInput): PromptTranslationDocument => {
  const source = input.sourcePrompt;
  const characters = buildCharacters(input);
  const declarations = declaredSubjectNames(source);
  for (const character of characters) if (!character.subjectToken) {
    const matches = declarations.filter((entry) => entry.name === character.name || character.aliases.includes(entry.name));
    if (matches.length === 1) character.subjectToken = matches[0].subjectToken;
  }
  const names = [...nameReferences(characters)];
  for (const declaration of declarations) if (!names.some((entry) => entry.value === declaration.name)) {
    names.push({ value: declaration.name, name: declaration.name });
  }
  names.sort((left, right) => right.value.length - left.value.length);
  const speakerNames = [...names, ...characters.filter((character) => character.subjectToken)
    .map((character) => ({ value: character.subjectToken!, name: character.name, characterId: character.characterId }))];
  const opaque = opaqueRanges(source, names);
  const insideOpaque = (start: number, end: number): boolean => opaque.some((range) => start < range.sourceEnd && end > range.sourceStart);
  const fixed: FixedRange[] = [];
  const add = (start: number, end: number, literalKind: PromptTranslationLiteral['literalKind'], priority: number, text = source.slice(start, end), characterId?: string): void => {
    if (end > start) fixed.push({ kind: 'literal', sourceStart: start, sourceEnd: end, text, literalKind, priority, ...(characterId ? { characterId } : {}) });
  };
  for (const range of opaque) if (range.dialogue) add(range.sourceStart, range.sourceEnd, 'dialogue', 5);
  else if (range.visibleText) add(range.sourceStart, range.sourceEnd, 'visible-text', 5);
  const patterns = [
    /^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[\t ]*:/gmu,
    /\[Shot[\t ]*\d+\]|<(?:Subject|Picture|Video|Audio)\s+\d+>|\bAt\s+\d{2}:\d{2}(?:\.\d+)?|<\/?(?:scenetrans|cutoff|sound)>/gu,
    /[（(][SＳ][0-9０-９]+(?:\s*[,，]\s*[SＳ][0-9０-９]+)*[）)]|(?<![\p{L}\p{N}_])[SＳ][0-9０-９]+(?:\s*[,，]\s*[SＳ][0-9０-９]+)*|\bN\/A\b|\bfully_preserved\b/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    if (!insideOpaque(start, start + match[0].length)) add(start, start + match[0].length, 'protocol', 4);
  }
  if (names.length) {
    const pattern = new RegExp(names.map((name) => escapePattern(name.value)).join('|'), 'gu');
    for (const match of source.matchAll(pattern)) {
      const start = match.index!;
      if (!matchesNameBoundary(source, start, match[0]) || opaque.some((range) => range.dialogue && start < range.sourceEnd && start + match[0].length > range.sourceStart)) continue;
      const entry = names.find((name) => name.value === match[0])!;
      add(start, start + match[0].length, 'entity', 3, entry.name, entry.characterId);
    }
  }
  // Numeric source facts are rendered from their original text, including every
  // existing time digit. Their surrounding units remain ordinary translation.
  for (const match of source.matchAll(/\p{Nd}+(?:[.:]\p{Nd}+)*/gu)) if (!insideOpaque(match.index!, match.index! + match[0].length)) {
    add(match.index!, match.index! + match[0].length, 'number', 1);
  }
  const identityAnchors: PromptTranslationIdentityAnchor[] = [];
  for (const entry of input.identityBindings?.characters || []) {
    const start = entry.referenceAnchor ? source.indexOf(entry.referenceAnchor) : -1;
    if (start >= 0) identityAnchors.push({ characterId: entry.characterId, sourceStart: start, sourceEnd: start + entry.referenceAnchor.length });
  }
  const events = structuredClone(input.identityBindings?.events || []);
  const eventAnchors: PromptTranslationEventAnchor[] = [];
  for (const [eventIndex, event] of events.entries()) {
    const start = event.referenceAnchor ? source.indexOf(event.referenceAnchor) : -1;
    // An absent or repeated excerpt remains unlocated; never choose a nearby
    // actor, speaker or a similarly worded event to fill missing source facts.
    if (start >= 0 && source.indexOf(event.referenceAnchor!, start + 1) < 0) {
      eventAnchors.push({ eventIndex, eventId: event.eventId, sourceStart: start, sourceEnd: start + event.referenceAnchor!.length });
    }
  }
  // Select the enclosing source literal, never a tag/name apparently inside it.
  const selected: FixedRange[] = [];
  for (const range of fixed.sort((left, right) => right.priority - left.priority || left.sourceStart - right.sourceStart || right.sourceEnd - left.sourceEnd)) {
    if (!selected.some((other) => range.sourceStart < other.sourceEnd && range.sourceEnd > other.sourceStart)) selected.push(range);
  }
  selected.sort((left, right) => left.sourceStart - right.sourceStart);
  const atoms: PromptTranslationDocument['atoms'] = [];
  const slots: PromptTranslationSlot[] = [];
  const groups: PromptTranslationGroup[] = [];
  const lineRanges: SourceRange[] = [];
  let lineStart = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/gu)) if (!insideOpaque(match.index!, match.index! + match[0].length)) {
    lineRanges.push({ sourceStart: lineStart, sourceEnd: match.index! });
    lineStart = match.index! + match[0].length;
  }
  lineRanges.push({ sourceStart: lineStart, sourceEnd: source.length });
  const groupFor = (start: number): PromptTranslationGroup => {
    const range = lineRanges.find((line) => line.sourceStart <= start && start <= line.sourceEnd) || { sourceStart: start, sourceEnd: source.length };
    const existing = groups.find((group) => group.sourceStart === range.sourceStart && group.sourceEnd === range.sourceEnd);
    if (existing) return existing;
    const group: PromptTranslationGroup = { ...range, id: `group-${String(groups.length + 1).padStart(4, '0')}`,
      sourceText: source.slice(range.sourceStart, range.sourceEnd), slotIds: [] };
    groups.push(group);
    return group;
  };
  const anchorBoundaries = [...new Set([...identityAnchors, ...eventAnchors].flatMap((range) => [range.sourceStart, range.sourceEnd]))];
  const appendGap = (start: number, end: number): void => {
    const boundaries = [start, ...anchorBoundaries.filter((at) => at > start && at < end).sort((left, right) => left - right), end];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const begin = boundaries[index];
      const finish = boundaries[index + 1];
      const gap = source.slice(begin, finish);
      // Newlines stay source layout; punctuation-only gaps need no model work.
      let cursor = begin;
      for (const line of gap.split(/(\r\n|\r|\n)/u)) {
        const leading = line.match(/^\s*/u)?.[0] || '';
        const trailing = line.slice(leading.length).match(/\s*$/u)?.[0] || '';
        const body = line.slice(leading.length, line.length - trailing.length);
        if (leading) atoms.push({ kind: 'literal', sourceStart: cursor, sourceEnd: cursor + leading.length, text: leading, literalKind: 'layout' });
        const bodyStart = cursor + leading.length;
        if (body) {
          if (/[\p{L}]/u.test(body)) {
            const group = groupFor(bodyStart);
            const slot: PromptTranslationSlot = { kind: 'slot', id: `slot-${String(slots.length + 1).padStart(4, '0')}`,
              sourceStart: bodyStart, sourceEnd: bodyStart + body.length, sourceText: body,
              before: source.slice(Math.max(0, bodyStart - 100), bodyStart), after: source.slice(bodyStart + body.length, bodyStart + body.length + 100),
              groupId: group.id, groupSourceText: group.sourceText,
              ...(eventAnchors.some((event) => event.sourceStart < bodyStart + body.length && event.sourceEnd > bodyStart)
                ? { eventIds: eventAnchors.filter((event) => event.sourceStart < bodyStart + body.length && event.sourceEnd > bodyStart).map((event) => event.eventId) } : {}) };
            group.slotIds.push(slot.id);
            slots.push(slot); atoms.push(slot);
          } else atoms.push({ kind: 'literal', sourceStart: bodyStart, sourceEnd: bodyStart + body.length, text: body, literalKind: 'layout' });
        }
        if (trailing) atoms.push({ kind: 'literal', sourceStart: bodyStart + body.length, sourceEnd: cursor + line.length, text: trailing, literalKind: 'layout' });
        cursor += line.length;
      }
    }
  };
  let cursor = 0;
  for (const range of selected) {
    appendGap(cursor, range.sourceStart);
    const { priority: _priority, ...literal } = range;
    atoms.push(literal);
    cursor = range.sourceEnd;
  }
  appendGap(cursor, source.length);
  let previousDialogueEnd = 0;
  const usedSourceDialogues = new Set<number>();
  const utterances = opaque.filter((range) => range.dialogue).map((range, index): PromptTranslationUtterance => {
    const prefix = source.slice(previousDialogueEnd, range.sourceStart);
    previousDialogueEnd = range.sourceEnd;
    const spokenText = range.content.replace(/^\s*\[[^\]\r\n]+\]\s*/u, '').trim();
    const factIndex = input.sourceDialogues?.findIndex((dialogue, at) => !usedSourceDialogues.has(at) && dialogue.text.trim() === spokenText) ?? -1;
    const fact = factIndex >= 0 ? input.sourceDialogues?.[factIndex] : undefined;
    if (fact) usedSourceDialogues.add(factIndex);
    const declared = explicitSpeaker(prefix, characters, speakerNames);
    const boundEvents = eventAnchors.filter((event) => event.sourceStart <= range.sourceStart && event.sourceEnd >= range.sourceEnd)
      .map((event) => events[event.eventIndex]).filter((event) => event.speakerCharacterId !== undefined);
    const boundEvent = boundEvents.length === 1 ? boundEvents[0] : undefined;
    const speakerCharacterId = boundEvent?.speakerCharacterId || fact?.speakerCharacterId;
    const factCharacter = speakerCharacterId ? characters.find((character) => character.characterId === speakerCharacterId) : undefined;
    return { id: boundEvent?.dialogueId || fact?.id || `utterance-${String(index + 1).padStart(4, '0')}`, sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd, text: range.content, ...declared,
      ...(speakerCharacterId ? { speakerCharacterId,
        ...(factCharacter?.speakerToken ? { speakerToken: factCharacter.speakerToken } : {}) } : {}),
      ...(boundEvent?.listenerCharacterIds || fact?.listenerCharacterIds ? { listenerCharacterIds: [...(boundEvent?.listenerCharacterIds || fact!.listenerCharacterIds!)] } : {}),
      ...(boundEvent?.addressedCharacterIds || fact?.addressedCharacterIds ? { addressedCharacterIds: [...(boundEvent?.addressedCharacterIds || fact!.addressedCharacterIds!)] } : {}) };
  });
  return { version: 1, sourcePrompt: source, characters, atoms, slots, groups, utterances, events,
    ...(input.sourceEvents ? { sourceEvents: structuredClone([...input.sourceEvents]) } : {}),
    ...(input.identityBindings ? { identityBindings: structuredClone(input.identityBindings) } : {}), identityAnchors, eventAnchors };
};

const translationValues = (response: unknown): Map<string, string> => {
  let value = response;
  if (typeof value === 'string') {
    try { value = JSON.parse(value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); }
    catch { return new Map(); }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'slots' in value) value = (value as { slots: unknown }).slots;
  const values = new Map<string, string>();
  if (Array.isArray(value)) for (const item of value) {
    if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string') values.set(item.id, item.text);
  }
  else if (value && typeof value === 'object') for (const [id, text] of Object.entries(value)) if (typeof text === 'string') values.set(id, text);
  return values;
};

/** Assemble only the requested prose slots; source literals cannot be replaced by a response. */
export const renderPromptTranslationDocument = (
  document: PromptTranslationDocument, translations: unknown,
): RenderPromptTranslationDocumentResult => {
  const values = translationValues(translations);
  const missing: string[] = [];
  const rendered = document.atoms.map((atom) => {
    if (atom.kind === 'literal') return atom.text;
    const value = values.get(atom.id);
    if (value === undefined) { missing.push(atom.id); return atom.sourceText; }
    return value;
  });
  // Join translated English prose naturally around fixed names/tokens without
  // changing either the source literals or source-only fallback fragments.
  document.atoms.forEach((atom, index) => {
    if (atom.kind !== 'slot' || missing.includes(atom.id)) return;
    const previous = index > 0 ? rendered[index - 1] : '';
    const next = rendered[index + 1] || '';
    if (/[\p{L}\p{N}>\])]$/u.test(previous) && /^[\p{Script=Latin}\p{N}]/u.test(rendered[index])) rendered[index] = ' ' + rendered[index];
    if (/[\p{Script=Latin}\p{N}]$/u.test(rendered[index]) && /^[\p{L}\p{N}<(@]/u.test(next)) rendered[index] += ' ';
  });
  const prompt = rendered.join('');
  const deliveryWarnings = missing.length ? [`英文翻译有 ${missing.length} 个描述片段未返回，已在原位置保留来源文字；原对白和人物绑定保持。`] : [];
  const identityBindings = document.identityBindings ? structuredClone(document.identityBindings) : undefined;
  const renderRange = (anchor: SourceRange): string => document.atoms.map((atom, index) => {
    if (atom.sourceEnd <= anchor.sourceStart || atom.sourceStart >= anchor.sourceEnd) return '';
    if (atom.sourceStart >= anchor.sourceStart && atom.sourceEnd <= anchor.sourceEnd) return rendered[index];
    return document.sourcePrompt.slice(Math.max(atom.sourceStart, anchor.sourceStart), Math.min(atom.sourceEnd, anchor.sourceEnd));
  }).join('');
  if (identityBindings) for (const binding of identityBindings.characters) {
    const anchor = document.identityAnchors.find((entry) => entry.characterId === binding.characterId);
    if (!anchor) {
      deliveryWarnings.push(`人物“${binding.name}”的来源身份句未定位，已保留原绑定资料。`);
      continue;
    }
    binding.referenceAnchor = renderRange(anchor);
  }
  for (const anchor of document.eventAnchors) {
    const event = identityBindings?.events?.[anchor.eventIndex];
    if (event) event.referenceAnchor = renderRange(anchor);
  }
  return { prompt, ...(identityBindings ? { identityBindings } : {}), deliveryWarnings };
};
