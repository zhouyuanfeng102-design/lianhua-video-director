import type { H3IdentityBindings, H3IdentityEventBinding, H3PerformancePlan, SemanticSegmentSource } from './types';
import { getPromptVisibleTextSpans } from './promptDialogueLanguage';
import { renderH3PerformancePlan } from './h3PerformancePlan';

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
  /** One complete paragraph or one owned performance description, never gaps between names/numbers. */
  groupId: string;
  groupSourceText: string;
  /** Explicit source events covering this fragment; no roles are inferred from prose. */
  eventIds?: string[];
  /** Source-owned literals embedded in this complete unit, not separate translation fragments. */
  protectedText?: Array<{ token: string; text: string; kind: PromptTranslationLiteral['literalKind'] }>;
  /** Explicit owner of a delivery/action/reaction; a description cannot reassign this role. */
  ownerCharacterIds?: string[];
  role?: string;
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
  performancePlan?: H3PerformancePlan;
  performanceFields?: Array<{ slotId: string; path: Array<string | number> }>;
  performanceDefinitionAtoms?: Array<PromptTranslationLiteral | PromptTranslationSlot>;
  performanceCharacterPictures?: Array<[string, number[]]>;
  performanceCharacterAudio?: Array<[string, number[]]>;
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
  for (const character of input.identityBindings?.performance?.characters || []) {
    if (character.name && !characters.has(character.characterId)) characters.set(character.characterId, {
      characterId: character.characterId, name: character.name, aliases: [],
    });
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

/** New deliveries translate owned descriptions, then render the event again.
 * The original narrative body is never spliced into the translated event. */
const withPerformanceTranslation = (
  document: PromptTranslationDocument, sourcePlan: H3PerformancePlan,
): PromptTranslationDocument => {
  const plan = structuredClone(sourcePlan);
  const fields: NonNullable<PromptTranslationDocument['performanceFields']> = [];
  const slots: PromptTranslationSlot[] = [];
  const add = (path: Array<string | number>, value: string | undefined, role: string, ownerCharacterIds?: string[], eventId?: string): void => {
    if (!value?.trim() || value.trim() === 'N/A') return;
    // The same complete-unit literal format is used for descriptions. It does
    // not expose the fixed speech skeleton to the translator.
    const prose = buildPromptTranslationDocument({ sourcePrompt: value,
      sourceCharacters: document.characters.map((entry) => ({ id: entry.characterId, name: entry.name, aliases: entry.aliases })) });
    const protectedText: NonNullable<PromptTranslationSlot['protectedText']> = [];
    const keep = (text: string, kind: PromptTranslationLiteral['literalKind']): string => {
      const token = `__H3_KEEP_${String(protectedText.length + 1).padStart(4, '0')}__`;
      protectedText.push({ token, text, kind });
      return token;
    };
    const sourceText = prose.atoms.map((atom) => {
      if (atom.kind === 'literal') return atom.literalKind === 'layout' ? atom.text : keep(atom.text, atom.literalKind);
      const replacements = new Map((atom.protectedText || []).map((literal) => [literal.token, keep(literal.text, literal.kind)]));
      return atom.sourceText.replace(/__H3_[A-Z_]+_\d+__/gu, (token) => replacements.get(token) || token);
    }).join('');
    const id = `performance.${path.join('.')}`;
    slots.push({ kind: 'slot', id, sourceText, sourceStart: 0, sourceEnd: value.length,
      before: '', after: '', groupId: id, groupSourceText: value, protectedText, role,
      ...(ownerCharacterIds ? { ownerCharacterIds } : {}), ...(eventId ? { eventIds: [eventId] } : {}) });
    fields.push({ slotId: id, path });
  };
  add(['preamble'], plan.preamble, 'visual-preamble');
  plan.characters?.forEach((character, index) => {
    add(['characters', index, 'visualDescription'], character.visualDescription, 'visual-identity', [character.characterId]);
    add(['characters', index, 'voiceDescription'], character.voiceDescription, 'voice-identity', [character.characterId]);
  });
  plan.shots.forEach((shot, shotIndex) => {
    add(['shots', shotIndex, 'visualDescription'], shot.visualDescription, 'shot-visual');
    shot.events.forEach((event, eventIndex) => {
      const path = ['shots', shotIndex, 'events', eventIndex];
      if (event.kind === 'visual') {
        add([...path, 'description'], event.description, 'visual-performance', undefined, event.eventId);
        add([...path, 'soundDescription'], event.soundDescription, 'local-sound', undefined, event.eventId);
      } else {
        add([...path, 'delivery'], event.delivery, 'speaker-delivery', event.speakerCharacterIds, event.eventId);
        add([...path, 'speakerAction'], event.speakerAction, 'speaker-action', event.speakerCharacterIds, event.eventId);
        if (event.kind === 'vocal') add([...path, 'vocalDescription'], event.vocalDescription, 'non-verbal-voice', event.speakerCharacterIds, event.eventId);
        event.reactions?.forEach((reaction, index) => add([...path, 'reactions', index, 'description'], reaction.description,
          'listener-reaction', [reaction.characterId], event.eventId));
      }
      // sourceFact, exact speech, roles, channels, clocks and IDs are not fields
      // that a description response can overwrite.
    });
  });
  add(['summary'], plan.summary, 'summary');
  add(['retentionAnalysis'], plan.retentionAnalysis, 'retention-analysis');
  add(['overallSoundscape'], plan.overallSoundscape, 'global-soundscape');
  add(['nonDiegeticMusic'], plan.nonDiegeticMusic, 'music');
  const definitionStart = document.sourcePrompt.match(/^subject_definitions:[\t ]*/mu);
  const start = definitionStart?.index === undefined ? -1 : definitionStart.index + definitionStart[0].length;
  const sectionEnd = start < 0 ? -1 : document.sourcePrompt.slice(start).search(/^summary:/mu);
  const allDefinitionAtoms = start >= 0 && sectionEnd >= 0
    ? document.atoms.filter((atom) => atom.sourceStart >= start && atom.sourceEnd <= start + sectionEnd) : [];
  const characterPictures: Array<[string, number[]]> = [];
  const characterAudio: Array<[string, number[]]> = [];
  const characterDefinitionLines = new Set<string>();
  const definitionLines = start >= 0 && sectionEnd >= 0 ? document.sourcePrompt.slice(start, start + sectionEnd).split(/\r?\n/u) : [];
  for (const character of document.characters) {
    // Voice-only sources need no visual Subject. Match only the renderer's
    // explicit declaration for a unique name in this saved plan; unrelated
    // legacy voices and narrative name mentions remain extra definitions.
    const namedVoice = plan.characters?.filter((entry) => entry.name === character.name);
    const voiceDeclaration = namedVoice?.length === 1 && namedVoice[0].characterId === character.characterId
      ? new RegExp(`^\\s*(?:Voice identity|声音身份):\\s*${escapePattern(character.name)}\\s+\\(S\\d+\\)(?=\\s|[,，.:：。]|$)`, 'u') : undefined;
    const lines = definitionLines.filter((value) => (character.subjectToken && value.trimStart().startsWith(`${character.subjectToken} `))
      || voiceDeclaration?.test(value));
    if (!lines.length) continue;
    lines.forEach((line) => characterDefinitionLines.add(line));
    const pictures = [...new Set(lines.flatMap((line) => [...line.matchAll(/<Picture\s+(\d+)>/gu)].map((match) => Number(match[1]))))];
    if (pictures.length) characterPictures.push([character.characterId, pictures]);
    const audio = [...new Set(lines.flatMap((line) => [...line.matchAll(/<Audio\s+(\d+)>/gu)].map((match) => Number(match[1]))))];
    if (audio.length) characterAudio.push([character.characterId, audio]);
  }
  const definitionAtoms = allDefinitionAtoms.filter((atom) => atom.kind === 'literal'
    ? atom.literalKind === 'layout' : !characterDefinitionLines.has(atom.groupSourceText));
  for (const atom of definitionAtoms) if (atom.kind === 'slot') slots.push(atom);
  return { ...document, slots, groups: slots.map((slot) => ({ id: slot.groupId, sourceStart: slot.sourceStart,
    sourceEnd: slot.sourceEnd, sourceText: slot.groupSourceText, slotIds: [slot.id] })),
  performancePlan: plan, performanceFields: fields, performanceDefinitionAtoms: definitionAtoms,
  performanceCharacterPictures: characterPictures, performanceCharacterAudio: characterAudio };
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
  const appendUnit = (begin: number, end: number): void => {
    const original = source.slice(begin, end);
    // Only the existing protocol prefix and whitespace stay outside a unit.
    // Entity, number and dialogue positions stay INSIDE its complete grammar.
    const prefix = original.match(/^(?:[ \t]*(?:(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[\t ]*:[\t ]*)?)(?:\[Shot[\t ]*\d+\][\t ]*(?:At\s+\d{2}:\d{2}(?:\.\d+)?[,，]?[\t ]*)?)?/u)?.[0] || '';
    const content = original.slice(prefix.length);
    const trailing = content.match(/\s*$/u)?.[0] || '';
    const body = content.slice(0, content.length - trailing.length);
    const bodyStart = begin + prefix.length;
    if (prefix) atoms.push({ kind: 'literal', sourceStart: begin, sourceEnd: bodyStart, text: prefix, literalKind: 'protocol' });
    if (body) {
      const groupId = `group-${String(groups.length + 1).padStart(4, '0')}`;
      const id = `unit-${String(slots.length + 1).padStart(4, '0')}`;
      const ranges = selected.filter((range) => range.sourceStart >= bodyStart && range.sourceEnd <= bodyStart + body.length);
      const protectedText = ranges.map((range, index) => ({
        token: `__H3_${range.literalKind.toUpperCase().replace(/-/gu, '_')}_${String(index + 1).padStart(4, '0')}__`,
        text: range.text, kind: range.literalKind,
      }));
      let sourceText = '';
      let cursor = bodyStart;
      ranges.forEach((range, index) => {
        sourceText += source.slice(cursor, range.sourceStart) + protectedText[index].token;
        cursor = range.sourceEnd;
      });
      sourceText += source.slice(cursor, bodyStart + body.length);
      // Protocol-only/empty descriptions such as N/A have no translation work.
      if (!/[\p{L}]/u.test(ranges.reduce((text, _range, index) => text.replace(protectedText[index].token, ''), sourceText))) {
        atoms.push({ kind: 'literal', sourceStart: bodyStart, sourceEnd: bodyStart + body.length, text: body, literalKind: 'protocol' });
      } else {
        const slot: PromptTranslationSlot = { kind: 'slot', id, sourceStart: bodyStart, sourceEnd: bodyStart + body.length,
          sourceText, before: prefix, after: trailing, groupId, groupSourceText: original,
          protectedText,
          ...(eventAnchors.some((event) => event.sourceStart < bodyStart + body.length && event.sourceEnd > bodyStart)
            ? { eventIds: eventAnchors.filter((event) => event.sourceStart < bodyStart + body.length && event.sourceEnd > bodyStart).map((event) => event.eventId) } : {}) };
        slots.push(slot); atoms.push(slot);
        groups.push({ id: groupId, sourceStart: begin, sourceEnd: end, sourceText: original, slotIds: [id] });
      }
    }
    if (trailing) atoms.push({ kind: 'literal', sourceStart: end - trailing.length, sourceEnd: end, text: trailing, literalKind: 'layout' });
  };
  const appendParagraph = (start: number, end: number): void => {
    // Some legacy deliveries put several complete Identity declarations on
    // one line. Keep each declared sentence whole so its translated anchor
    // cannot expand to include another person's identity.
    const ends = [...new Set(identityAnchors.filter((anchor) => anchor.sourceStart >= start && anchor.sourceEnd < end
      && /[。！？.!?]\s*$/u.test(source.slice(anchor.sourceStart, anchor.sourceEnd))).map((anchor) => anchor.sourceEnd))].sort((a, b) => a - b);
    let cursor = start;
    for (const boundary of [...ends, end]) { appendUnit(cursor, boundary); cursor = boundary; }
  };
  let cursor = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/gu)) if (!insideOpaque(match.index!, match.index! + match[0].length)) {
    appendParagraph(cursor, match.index!);
    atoms.push({ kind: 'literal', sourceStart: match.index!, sourceEnd: match.index! + match[0].length, text: match[0], literalKind: 'layout' });
    cursor = match.index! + match[0].length;
  }
  appendParagraph(cursor, source.length);
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
  const document: PromptTranslationDocument = { version: 1, sourcePrompt: source, characters, atoms, slots, groups, utterances, events,
    ...(input.sourceEvents ? { sourceEvents: structuredClone([...input.sourceEvents]) } : {}),
    ...(input.identityBindings ? { identityBindings: structuredClone(input.identityBindings) } : {}), identityAnchors, eventAnchors };
  return input.identityBindings?.performance ? withPerformanceTranslation(document, input.identityBindings.performance) : document;
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

/** Assemble complete units or render an owned plan; no prose is translated in gaps between facts. */
export const renderPromptTranslationDocument = (
  document: PromptTranslationDocument, translations: unknown,
): RenderPromptTranslationDocumentResult => {
  const values = translationValues(translations);
  const missing: string[] = [];
  const renderAtom = (atom: PromptTranslationLiteral | PromptTranslationSlot): string => {
    if (atom.kind === 'literal') return atom.text;
    const value = values.get(atom.id);
    if (value === undefined) missing.push(atom.id);
    const literals = new Map(atom.protectedText?.map((literal) => [literal.token, literal.text]) || []);
    return (value ?? atom.sourceText).replace(/__H3_[A-Z_]+_\d+__/gu, (token) => literals.get(token) ?? token);
  };
  const warnings = (): string[] => missing.length
    ? [`英文翻译有 ${missing.length} 个完整描述单元未返回，已保留对应来源描述；原对白和人物绑定保持。`] : [];
  if (document.performancePlan && document.identityBindings) {
    const plan = structuredClone(document.performancePlan);
    for (const field of document.performanceFields || []) {
      const slot = document.slots.find((entry) => entry.id === field.slotId);
      if (!slot) continue;
      let owner = plan as unknown as Record<string | number, unknown>;
      for (const key of field.path.slice(0, -1)) owner = owner[key] as Record<string | number, unknown>;
      owner[field.path[field.path.length - 1]] = renderAtom(slot);
    }
    const extraDefinitions = (document.performanceDefinitionAtoms || []).map(renderAtom).join('').trim();
    const fullReference = /^subject_definitions:/mu.test(document.sourcePrompt);
    const result = renderH3PerformancePlan({ plan, language: 'en', characters: document.identityBindings.characters,
      mode: fullReference ? 'full-reference' : 'integrated',
      subjectTokens: new Map(document.characters.filter((entry) => entry.subjectToken).map((entry) => [entry.characterId, entry.subjectToken!])),
      characterPictures: new Map(document.performanceCharacterPictures || []),
      characterAudio: new Map(document.performanceCharacterAudio || []),
      ...(extraDefinitions ? { subjectDefinitions: extraDefinitions } : {}) });
    return { prompt: result.prompt, identityBindings: { ...structuredClone(document.identityBindings),
      characters: result.characters, events: result.events, performance: result.plan }, deliveryWarnings: warnings() };
  }
  const rendered = document.atoms.map(renderAtom);
  const prompt = rendered.join('');
  const deliveryWarnings = warnings();
  const identityBindings = document.identityBindings ? structuredClone(document.identityBindings) : undefined;
  const renderRange = (anchor: SourceRange): string => document.atoms.map((atom, index) => {
    if (atom.sourceEnd <= anchor.sourceStart || atom.sourceStart >= anchor.sourceEnd) return '';
    if (atom.sourceStart >= anchor.sourceStart && atom.sourceEnd <= anchor.sourceEnd) return rendered[index];
    // A legacy anchor may be a subsection of one translated paragraph. Use
    // that complete translated unit as its exact excerpt, never splice a
    // Chinese fragment back into the translated sentence.
    return rendered[index];
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
