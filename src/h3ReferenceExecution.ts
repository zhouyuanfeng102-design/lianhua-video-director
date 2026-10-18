import type { H3IdentityBindings, ReferenceRole } from './types';
import { buildPromptTranslationDocument } from './promptTranslationDocument';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';
import { renderH3PerformancePlan } from './h3PerformancePlan';

type Identity = H3IdentityBindings['characters'][number];
type Event = NonNullable<H3IdentityBindings['events']>[number];
interface Edit { start: number; end: number; text: string }
interface Section { name: string; start: number; bodyStart: number; end: number; body: string; raw: string }

export interface H3ReferenceExecutionCharacter {
  characterId: string;
  name: string;
  subjectToken: string;
  speakerToken?: string;
  pictureNumbers: number[];
}
export interface H3ReferenceExecutionResult {
  prompt: string;
  identities: H3IdentityBindings;
  characters: H3ReferenceExecutionCharacter[];
}
export interface H3ReferenceExecutionInput {
  prompt: string;
  identities: H3IdentityBindings;
  characterPictures: ReadonlyMap<string, readonly number[]>;
  pictureUses?: ReadonlyArray<{ number: number; role: ReferenceRole }>;
  language?: 'zh' | 'en';
  mode?: 'integrated' | 'full-reference';
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const mask = maskVideoPictureReferenceLiterals;
const applyEdits = (source: string, edits: readonly Edit[]): string => [...edits]
  .sort((left, right) => right.start - left.start || right.end - left.end)
  .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
const sectionsOf = (source: string): Section[] => {
  const matches = [...mask(source).matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu)];
  return matches.map((match, index) => {
    const start = match.index!; const bodyStart = start + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    return { name: match[1], start, bodyStart, end, body: source.slice(bodyStart, end), raw: source.slice(start, end) };
  });
};
const voiceKey = (value: string): string | undefined => {
  const digits = value.match(/[SＳ]([0-9０-９]+)/u)?.[1];
  return digits ? `S${digits.replace(/[０-９]/gu, (digit) => String(digit.charCodeAt(0) - 0xff10))}` : undefined;
};
const uniqueAnchorStart = (source: string, anchor: string | undefined): number => {
  if (!anchor) return -1;
  const start = source.indexOf(anchor);
  return start >= 0 && source.indexOf(anchor, start + 1) < 0 ? start : -1;
};

/** Literal payloads are never searched for identities, source IDs or sections. */
const renderNames = (source: string, characters: readonly H3ReferenceExecutionCharacter[]): string => {
  const visible = mask(source);
  const ordered = [...characters].sort((left, right) => right.name.length - left.name.length);
  const edits: Edit[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const start = visible[index] === '@' ? index + 1 : index;
    const entry = ordered.find((character) => {
      if (!character.name || !visible.startsWith(character.name, start)) return false;
      const end = start + character.name.length;
      return (!/[A-Za-z0-9_]/u.test(character.name[0]) || !/[\p{L}\p{N}_]/u.test(visible[start - 1] || ''))
        && (!/[A-Za-z0-9_]/u.test(character.name[character.name.length - 1] || '') || !/[\p{L}\p{N}_]/u.test(visible[end] || ''));
    });
    if (!entry) continue;
    const preceding = visible.slice(0, index).match(/(<Subject\s+\d+>)[ \t]*$/u)?.[1];
    edits.push({ start: index, end: start + entry.name.length,
      text: preceding === entry.subjectToken ? entry.name : `${entry.subjectToken} ${entry.name}` });
    index = start + entry.name.length - 1;
  }
  return applyEdits(source, edits);
};

const renderVoiceTokens = (source: string, tokens: ReadonlyMap<string, string>): string => {
  const edits: Edit[] = [];
  for (const match of mask(source).matchAll(/[（(][ \t]*[SＳ][0-9０-９]+(?:[ \t]*[,，][ \t]*[SＳ][0-9０-９]+)*(?=[ \t]*[）),，])/gu)) {
    const text = match[0].replace(/[SＳ][0-9０-９]+/gu, (token) => tokens.get(voiceKey(token) || '') || token);
    if (text !== match[0]) edits.push({ start: match.index!, end: match.index! + match[0].length, text });
  }
  return applyEdits(source, edits);
};

/** A proven identity anchor owns its own declaration. A missing voice on a
 * silent identity must not leave a stale token that aliases another speaker
 * after the remaining sources are numbered. Literal dialogue is never edited. */
const clearSilentIdentityVoices = (
  source: string, identities: H3IdentityBindings, characters: readonly H3ReferenceExecutionCharacter[],
): string => {
  const visible = mask(source);
  const edits: Edit[] = [];
  for (const entry of identities.characters) {
    if (characters.find((character) => character.characterId === entry.characterId)?.speakerToken) continue;
    const at = uniqueAnchorStart(source, entry.referenceAnchor);
    if (at < 0) continue;
    const anchor = visible.slice(at, at + entry.referenceAnchor.length);
    const pattern = new RegExp(`${escaped(entry.name)}([ \\t]*[（(][ \\t]*[SＳ][0-9０-９]+[ \\t]*[）)])`, 'gu');
    for (const match of anchor.matchAll(pattern)) {
      const start = at + match.index! + entry.name.length;
      edits.push({ start, end: start + match[1].length, text: '' });
    }
  }
  return applyEdits(source, edits);
};

const eventSpeaker = (source: string, start: number, end: number, events: readonly Event[]): string | undefined => {
  const matches = events.filter((event) => {
    const at = uniqueAnchorStart(source, event.referenceAnchor);
    return event.speakerCharacterId && at >= 0 && at <= start && end <= at + event.referenceAnchor!.length;
  });
  const ids = unique(matches.map((event) => event.speakerCharacterId!));
  return ids.length === 1 ? ids[0] : undefined;
};

const nonverbalSources = (source: string, identities: H3IdentityBindings): Array<{ at: number; id: string }> => {
  const visible = mask(source); const sections = sectionsOf(source);
  const definitions = sections.find((section) => section.name === 'subject_definitions');
  const vocal = /(?:笑出声|轻笑|低笑|大笑|笑了一声|笑声|叹息|叹气|喘息|呻吟|悲鸣|呜咽|啜泣|哭泣|哭声|尖叫|低吼|嘶吼|哼唱|歌唱|咳嗽|\b(?:laughs?|chuckles?|sighs?|gasps?|groans?|sobs?|cries|weeps?|screams?|yelps?|hums?|sings?|grunts?|coughs?|laughter|chuckle|sigh|gasp|groan|sob|cry)\b)/iu;
  const found: Array<{ at: number; id: string }> = [];
  for (const match of visible.matchAll(/[（(][ \t]*[SＳ][0-9０-９]+[^()（）\r\n]*[）)]/gu)) {
    const at = match.index!;
    if (definitions && definitions.start <= at && at < definitions.end) continue;
    const owners = identities.characters.filter((entry) => entry.speakerToken && voiceKey(entry.speakerToken) === voiceKey(match[0]));
    if (owners.length !== 1) continue;
    const end = at + match[0].length;
    const tail = visible.slice(end).split(/[。；;\r\n]|\.(?!\d)/u)[0];
    if (/^[ \t]*[,，:]?[ \t]*(?:是|为|\bis\b|\bidentity\b)/iu.test(tail)) continue;
    const sound = source.slice(end).match(/^[ \t]*[:：,，]?[ \t]*<sound>([\s\S]*?)<\/sound>/iu)?.[1];
    const actual = vocal.exec(tail) || (sound ? vocal.exec(sound) : null);
    if (!actual || /(?:不再|没有|未曾|禁止|不得|不许|\b(?:not|no|never|without)\b)[^，,。；;]{0,24}$/iu.test((sound || tail).slice(0, actual.index))) continue;
    found.push({ at, id: owners[0].characterId });
  }
  return found;
};

/** Recompile proven declarations; an unknown legacy speaker is not guessed. */
const speakerAssignments = (source: string, identities: H3IdentityBindings): Map<string, string> => {
  const utterances = buildPromptTranslationDocument({ sourcePrompt: source, identityBindings: identities }).utterances;
  const known = new Set(identities.characters.map((entry) => entry.characterId));
  const spoken = utterances.map((utterance) => ({ at: utterance.sourceStart,
    id: eventSpeaker(source, utterance.sourceStart, utterance.sourceEnd, identities.events || []) || utterance.speakerCharacterId }));
  spoken.push(...nonverbalSources(source, identities));
  // A sound-only event can explicitly declare an actual vocal source as well.
  for (const event of identities.events || []) {
    const at = uniqueAnchorStart(source, event.referenceAnchor);
    if (event.speakerCharacterId && at >= 0) spoken.push({ at, id: event.speakerCharacterId });
  }
  if (spoken.some((entry) => !entry.id || !known.has(entry.id))) return new Map(identities.characters
    .flatMap((entry) => entry.speakerToken ? [[entry.characterId, entry.speakerToken] as const] : []));
  const ids = unique(spoken.sort((left, right) => left.at - right.at).flatMap((entry) => entry.id ? [entry.id] : []));
  if (!ids.length) return new Map(identities.characters.flatMap((entry) => entry.speakerToken ? [[entry.characterId, entry.speakerToken] as const] : []));
  const assigned = new Map(ids.map((id, index) => [id, `(S${index + 1})`]));
  // Keep explicitly declared non-dialogue sources, without making silent cast speak.
  for (const entry of identities.characters) if (entry.speakerToken && !assigned.has(entry.characterId)) {
    assigned.set(entry.characterId, `(S${assigned.size + 1})`);
  }
  return assigned;
};

const eventContextPrefix = (
  event: Event, characters: readonly H3ReferenceExecutionCharacter[], language?: 'zh' | 'en',
): string => {
  if (!event.referenceAnchor) return '';
  const explicit = mask(renderNames(event.referenceAnchor, characters));
  const actor = characters.find((character) => character.characterId === event.actorCharacterId);
  const missingActor = actor && !explicit.includes(actor.subjectToken) ? actor : undefined;
  const missingTargets = unique(event.targetCharacterIds || []).flatMap((id) => {
    const target = characters.find((character) => character.characterId === id);
    return target && !explicit.includes(target.subjectToken) ? [target] : [];
  });
  const label = (character: H3ReferenceExecutionCharacter): string => `${character.subjectToken} ${character.name}`;
  if (!missingTargets.length) return missingActor ? `${label(missingActor)}: ` : '';
  const facts = [
    ...(missingActor ? [`${language === 'en' ? 'Action actor' : '行动者'}: ${label(missingActor)}`] : []),
    `${language === 'en' ? 'Action target' : '作用对象'}: ${missingTargets.map(label).join(', ')}`,
  ];
  return `${facts.join('; ')}. `;
};

const eventContextEdits = (
  source: string, events: readonly Event[], characters: readonly H3ReferenceExecutionCharacter[], language?: 'zh' | 'en',
): Edit[] => {
  const edits: Edit[] = [];
  for (const event of events) {
    const start = uniqueAnchorStart(source, event.referenceAnchor);
    if (start < 0 || !event.referenceAnchor || /\[Shot\s+\d+\]|\bAt\s+\d{2}:/u.test(mask(event.referenceAnchor))) continue;
    const text = eventContextPrefix(event, characters, language);
    // Explicit actor and target facts ground pronominal source spans. Neither
    // is inferred from the speaker, listener, form of address or screen side.
    if (text && !edits.some((edit) => edit.start === start)) edits.push({ start, end: start, text });
  }
  return edits;
};

const speakerLabelEdits = (
  source: string, identities: H3IdentityBindings, characters: readonly H3ReferenceExecutionCharacter[],
): { edits: Edit[]; labels: Array<{ token: string; text: string }> } => {
  const edits: Edit[] = []; const labels: Array<{ token: string; text: string }> = [];
  const utterances = buildPromptTranslationDocument({ sourcePrompt: source, identityBindings: identities }).utterances;
  let previousEnd = 0;
  for (const utterance of utterances) {
    const id = eventSpeaker(source, utterance.sourceStart, utterance.sourceEnd, identities.events || []) || utterance.speakerCharacterId;
    const entry = characters.find((character) => character.characterId === id);
    const prefix = mask(source.slice(previousEnd, utterance.sourceStart)).split(/\r?\n/u).slice(-1)[0];
    previousEnd = utterance.sourceEnd;
    if (!entry || prefix.includes(entry.name) || prefix.includes(entry.subjectToken)) continue;
    let token = `__LH_H3_EXEC_SPEAKER_${labels.length}__`;
    while (source.includes(token)) token += '_';
    labels.push({ token, text: `${entry.subjectToken} ${entry.name}${entry.speakerToken ? ` ${entry.speakerToken}` : ''}: ` });
    edits.push({ start: utterance.sourceStart, end: utterance.sourceStart, text: token });
  }
  return { edits, labels };
};
const restoreSpeakerLabels = (source: string, labels: ReadonlyArray<{ token: string; text: string }>): string =>
  labels.reduce((text, label) => text.replace(label.token, label.text), source);

const renderRetention = (source: string, characters: readonly H3ReferenceExecutionCharacter[]): string => {
  const seen = new Set<string>();
  const lines = source.trim() ? source.trim().split(/\r?\n/u).map((line) => {
    const visible = mask(line);
    const labels = unique([...visible.matchAll(/<Subject\s+\d+>/gu)].map((match) => match[0]));
    const entry = characters.find((character) => labels.length === 1 && labels[0] === character.subjectToken);
    if (!entry) return line;
    seen.add(entry.characterId);
    const pictures = entry.pictureNumbers.map((number) => `<Picture ${number}>`).join(', ');
    const pictureGroups = [...visible.matchAll(/<Picture\s+\d+>(?:[ \t]*[,，、][ \t]*<Picture\s+\d+>)*/gu)];
    if (pictureGroups.length) return applyEdits(line, pictureGroups.map((match) => ({ start: match.index!, end: match.index! + match[0].length, text: pictures })));
    return pictures ? `${line} reference ${pictures}.` : line;
  }) : [];
  for (const entry of characters) if (!seen.has(entry.characterId)) lines.push(`${entry.subjectToken}: fully_preserved - ${entry.name}${entry.pictureNumbers.length
    ? `; reference ${entry.pictureNumbers.map((number) => `<Picture ${number}>`).join(', ')}` : ''}.`);
  return lines.join('\n');
};

/**
 * Compile actual multi-reference identities and event mentions into one H3
 * document. Undefined means this old document lacks sufficient provenance;
 * callers retain its existing compatible path, never reject or regenerate it.
 */
export const renderH3ReferenceExecution = (input: H3ReferenceExecutionInput): H3ReferenceExecutionResult | undefined => {
  const { identities } = input;
  let prompt = input.prompt;
  if (identities.performance) {
    const sections = sectionsOf(prompt);
    const originalDefinitions = sections.find((section) => section.name === 'subject_definitions')?.body || '';
    const uses = new Set((input.pictureUses || []).map((entry) => entry.number));
    const characterAudio = new Map<string, number[]>();
    for (const entry of identities.characters) {
      const definition = originalDefinitions.split(/\r?\n/u).find((line) => entry.subjectToken
        ? line.trimStart().startsWith(`${entry.subjectToken} `) : entry.referenceAnchor && line.includes(entry.referenceAnchor));
      const numbers = [...(definition || entry.referenceAnchor).matchAll(/<Audio\s+(\d+)>/gu)].map((match) => Number(match[1]));
      if (numbers.length) characterAudio.set(entry.characterId, unique(numbers));
    }
    const voiceOnlyLines = new Set<string>();
    for (const entry of identities.performance.characters || []) {
      if (!entry.name || identities.characters.some((character) => character.characterId === entry.characterId)) continue;
      const declaration = new RegExp(`^(?:Voice identity|声音身份): ${escaped(entry.name)} \\(S\\d+\\)(?=[,.。 ，]|$)`, 'u');
      for (const line of originalDefinitions.split(/\r?\n/u)) if (declaration.test(line.trim())) {
        voiceOnlyLines.add(line);
        const numbers = [...line.matchAll(/<Audio\s+(\d+)>/gu)].map((match) => Number(match[1]));
        if (numbers.length) characterAudio.set(entry.characterId, unique(numbers));
      }
    }
    // The adopted plan owns character definitions and the complete performance.
    // Retain only separately authored scene/prop definitions from the envelope.
    const extraDefinitions = originalDefinitions.split(/\r?\n/u).filter((line) => {
      if (voiceOnlyLines.has(line)) return false;
      if (identities.characters.some((entry) => entry.subjectToken
        ? line.trimStart().startsWith(`${entry.subjectToken} `)
        : entry.referenceAnchor && line.includes(entry.referenceAnchor))) return false;
      const picture = /^\s*<Picture\s+(\d+)>\s+(?:is the|用于)\s/u.exec(line);
      return !picture || !uses.has(Number(picture[1]));
    }).join('\n').trim();
    const rendered = renderH3PerformancePlan({ plan: identities.performance, characters: identities.characters,
      language: input.language || identities.performance.descriptionLanguage || 'zh',
      mode: input.mode || 'full-reference', characterPictures: input.characterPictures, characterAudio, pictureUses: input.pictureUses,
      subjectDefinitions: extraDefinitions,
      summary: identities.performance.summary ?? sections.find((section) => section.name === 'summary')?.body.trim(),
      retentionAnalysis: identities.performance.retentionAnalysis ?? sections.find((section) => section.name === 'retention_analysis')?.body.trim(),
    });
    return { prompt: rendered.prompt, identities: { ...identities, characters: rendered.characters,
      events: rendered.events, performance: rendered.plan },
    characters: rendered.characters.flatMap((entry) => entry.subjectToken ? [{ characterId: entry.characterId,
      name: entry.name, subjectToken: entry.subjectToken, ...(entry.speakerToken ? { speakerToken: entry.speakerToken } : {}),
      pictureNumbers: [...(input.characterPictures.get(entry.characterId) || [])] }] : []) };
  }
  if (!identities.characters.length) return undefined;
  const previousAssociations: Edit[] = [];
  for (const entry of identities.characters) {
    const pattern = new RegExp(` Visual identity reference for ${escaped(entry.name)}: <Picture \\d+>(?:, <Picture \\d+>)*\\.`, 'gu');
    for (const match of mask(prompt).matchAll(pattern)) previousAssociations.push({ start: match.index!, end: match.index! + match[0].length, text: '' });
  }
  prompt = applyEdits(prompt, previousAssociations);
  const sections = sectionsOf(prompt);
  const detailed = sections.find((section) => section.name === 'detailed_description')
    || sections.find((section) => section.name === 'integrated_multimodal_description');
  const soundscape = sections.find((section) => section.name === 'overall_soundscape');
  const music = sections.find((section) => section.name === 'non_diegetic_music');
  if (!detailed || sections.filter((section) => section.name === detailed.name).length !== 1) return undefined;
  if (new Set(identities.characters.map((entry) => entry.characterId)).size !== identities.characters.length
    || new Set(identities.characters.map((entry) => entry.name)).size !== identities.characters.length) return undefined;
  if (identities.characters.some((entry) => !entry.name || /[<>\r\n]/u.test(entry.name)
    || uniqueAnchorStart(prompt, entry.referenceAnchor) < 0)) return undefined;

  const definitions = sections.find((section) => section.name === 'subject_definitions');
  const usedSubjects = new Set([
    ...[...mask(prompt).matchAll(/<Subject\s+(\d+)>/gu)].map((match) => Number(match[1])),
    ...identities.characters.flatMap((entry) => entry.subjectToken ? [Number(entry.subjectToken.match(/\d+/u)?.[0])] : []),
  ]);
  const assignedSubjects = new Set<string>();
  const originalDefinitions = definitions?.body || '';
  const assignments = speakerAssignments(prompt, identities);
  const characters: H3ReferenceExecutionCharacter[] = [];
  for (const entry of identities.characters) {
    let subject = entry.subjectToken;
    const at = uniqueAnchorStart(originalDefinitions, entry.referenceAnchor);
    const lineStart = at < 0 ? -1 : originalDefinitions.lastIndexOf('\n', at) + 1;
    const declared = lineStart < 0 ? undefined : mask(originalDefinitions.slice(lineStart, at + entry.referenceAnchor.length))
      .match(/^[ \t]*(<Subject\s+\d+>)/u)?.[1];
    if (subject && declared && subject !== declared) return undefined;
    if (!subject) subject = declared;
    const namedDefinitions = [...mask(originalDefinitions).matchAll(new RegExp(`^[ \\t]*(<Subject\\s+\\d+>)[ \\t]+(?:is|是|为)[ \\t]+${escaped(entry.name)}(?=[ \\t(:：,，]|$)`, 'gmu'))];
    if (!subject && namedDefinitions.length === 1) subject = namedDefinitions[0][1];
    if (subject && assignedSubjects.has(subject)) return undefined;
    if (subject) {
      const ownedLines = [...mask(originalDefinitions).matchAll(new RegExp(`^[ \\t]*${escaped(subject)}[^\\r\\n]*`, 'gmu'))];
      if (ownedLines.length > 1 || ownedLines.length === 1 && !ownedLines[0][0].includes(entry.name)
        && !(at >= ownedLines[0].index! && at < ownedLines[0].index! + ownedLines[0][0].length)) return undefined;
    }
    if (!subject) {
      let number = 1; while (usedSubjects.has(number)) number += 1;
      usedSubjects.add(number); subject = `<Subject ${number}>`;
    }
    assignedSubjects.add(subject);
    characters.push({ characterId: entry.characterId, name: entry.name, subjectToken: subject,
      ...(assignments.get(entry.characterId) ? { speakerToken: assignments.get(entry.characterId) } : {}),
      pictureNumbers: unique((input.characterPictures.get(entry.characterId) || []).filter((number) => Number.isSafeInteger(number) && number > 0)) });
  }
  const voiceTokens = new Map<string, string>();
  for (const entry of identities.characters) {
    const old = entry.speakerToken && voiceKey(entry.speakerToken);
    const next = assignments.get(entry.characterId);
    if (!old || !next) continue;
    if (voiceTokens.has(old) && voiceTokens.get(old) !== voiceKey(next)) return undefined;
    voiceTokens.set(old, voiceKey(next)!);
  }

  const definitionEdits: Edit[] = [];
  const bodyEdits: Edit[] = eventContextEdits(detailed.body, identities.events || [], characters, input.language);
  const speakerLabels = speakerLabelEdits(detailed.body, identities, characters);
  bodyEdits.push(...speakerLabels.edits);
  const extraDefinitions: string[] = [];
  const renderedIdentities: Identity[] = [];
  for (const [index, entry] of identities.characters.entries()) {
    const character = characters[index];
    const anchorAt = uniqueAnchorStart(originalDefinitions, entry.referenceAnchor);
    const declaration = new RegExp(`^[ \\t]*${escaped(character.subjectToken)}[^\\r\\n]*`, 'mu').exec(mask(originalDefinitions));
    const at = anchorAt >= 0 ? anchorAt : declaration?.index ?? -1;
    // A legacy locator can be a dialogue/action span. Only definitions that
    // already live in subject_definitions supply definition prose; detailed
    // source text always stays at its original shot and time.
    let description = '';
    let range: { start: number; end: number } | undefined;
    if (at >= 0) {
      const start = originalDefinitions.lastIndexOf('\n', at) + 1;
      const newline = originalDefinitions.indexOf('\n', anchorAt >= 0 ? at + entry.referenceAnchor.length : at);
      const end = newline < 0 ? originalDefinitions.length : newline;
      const line = originalDefinitions.slice(start, end);
      if ([...mask(line).matchAll(/<Subject\s+\d+>/gu)].length > 1) return undefined;
      const header = new RegExp(`^[ \\t]*${escaped(character.subjectToken)}[ \\t]+(?:is|是|为)[\\s\\S]*?[:：]`, 'u').exec(mask(line));
      if (header) description = line.slice(header[0].length).trim();
      else if (/^\s*<Subject\s+\d+>/u.test(mask(line))) {
        const compactHeader = new RegExp(`^[ \\t]*${escaped(character.subjectToken)}[ \\t]+(?:is|是|为)[ \\t]+${escaped(entry.name)}(?:[ \\t]*[（(][^\\r\\n）)]*[）)])?[,，]?[ \\t]*`, 'u').exec(mask(line));
        if (!compactHeader) return undefined;
        description = line.slice(compactHeader[0].length).trim();
        if (/^(?:referenced from <Picture\s+\d+>(?:, <Picture\s+\d+>)*|defined by the authored prompt)[.。]?$/u.test(description)) description = '';
      }
      range = { start, end };
    }
    const pureAnchor = renderVoiceTokens(description, voiceTokens);
    const pictures = character.pictureNumbers.map((number) => `<Picture ${number}>`).join(', ');
    const source = pictures ? ` referenced from ${pictures}` : ' defined by the authored prompt';
    const definition = `${character.subjectToken} is ${entry.name}${character.speakerToken ? ` ${character.speakerToken}` : ''}${source}${pureAnchor ? `: ${pureAnchor}` : '.'}`;
    if (range) definitionEdits.push({ ...range, text: definition }); else extraDefinitions.push(definition);
    const { speakerToken: _previousSpeaker, ...identityWithoutVoice } = entry;
    renderedIdentities.push({ ...identityWithoutVoice, subjectToken: character.subjectToken,
      ...(character.speakerToken ? { speakerToken: character.speakerToken } : {}), referenceAnchor: definition });
  }
  let body = clearSilentIdentityVoices(applyEdits(detailed.body, bodyEdits), identities, characters);
  // Remove only our old generated identity association, never authored payloads.
  const legacyEdits: Edit[] = [];
  for (const entry of identities.characters) {
    const pattern = new RegExp(` Visual identity reference for ${escaped(entry.name)}: <Picture \\d+>(?:, <Picture \\d+>)*\\.`, 'gu');
    for (const match of mask(body).matchAll(pattern)) legacyEdits.push({ start: match.index!, end: match.index! + match[0].length, text: '' });
  }
  body = restoreSpeakerLabels(renderNames(renderVoiceTokens(applyEdits(body, legacyEdits), voiceTokens), characters), speakerLabels.labels);
  let definitionBody = [applyEdits(originalDefinitions, definitionEdits).trim(), ...extraDefinitions].filter(Boolean).join('\n');
  const uses: Partial<Record<ReferenceRole, string>> = { 'first-frame': 'opening composition reference', 'last-frame': 'ending composition reference',
    scene: 'environment layout and lighting reference', prop: 'prop appearance reference', style: 'visual style reference', motion: 'action pose reference',
    composition: 'composition reference', camera: 'camera composition reference', 'clay-render': 'form and spatial structure reference', creative: 'visual concept reference',
    'middle-frame': 'intermediate composition and continuity reference' };
  for (const use of input.pictureUses || []) {
    const purpose = uses[use.role];
    if (!purpose || !Number.isSafeInteger(use.number) || use.number < 1
      || new RegExp(`^<Picture ${use.number}>[ \\t]+(?:is|是|为)\\b`, 'mu').test(mask(definitionBody))) continue;
    definitionBody += `\n<Picture ${use.number}> is the ${purpose}.`;
  }
  const summary = sections.find((section) => section.name === 'summary');
  const retention = sections.find((section) => section.name === 'retention_analysis');
  const labels = characters.map((entry) => entry.subjectToken).join(', ');
  const authoredSummary = summary?.body.trim() || (input.language === 'en' ? `Referenced characters: ${labels}.` : `本段人物身份沿用 ${labels}。`);
  const summaryBody = /^\[reference generation(?:[^\]]*)\]/u.test(authoredSummary) ? authoredSummary : `[reference generation] ${authoredSummary}`;
  const retentionBody = renderRetention(retention?.body || '', characters);
  const bodyTail = /[\r\n]$/u.test(body) ? body : `${body}\n`;
  // Some saved H3 bodies predate the explicit global sound fields. Do not
  // promote their local effects into a global bed or ask a model to invent it.
  const soundText = soundscape ? soundscape.raw + (!music && !/[\r\n]$/u.test(soundscape.raw) ? '\n' : '') : 'overall_soundscape:\nN/A\n\n';
  const musicText = music?.raw || 'non_diegetic_music:\nN/A';
  const rendered = `subject_definitions:\n${definitionBody}\n\nsummary:\n${renderVoiceTokens(summaryBody, voiceTokens)}\n\nretention_analysis:\n${renderVoiceTokens(retentionBody, voiceTokens)}\n\ndetailed_description:${bodyTail}${soundText}${musicText}`;
  const renderedEvents = identities.events?.map((event) => {
    if (!event.referenceAnchor) return { ...event };
    const context = eventContextEdits(detailed.body, [event], characters, input.language)[0]?.text || '';
    const labels = speakerLabelEdits(event.referenceAnchor, { ...identities, events: [event] }, characters);
    const text = context + applyEdits(event.referenceAnchor, labels.edits);
    return { ...event, referenceAnchor: restoreSpeakerLabels(renderNames(renderVoiceTokens(text, voiceTokens), characters), labels.labels) };
  });
  return { prompt: rendered, identities: { ...identities, characters: renderedIdentities,
    ...(renderedEvents ? { events: renderedEvents } : {}) }, characters };
};
