import type {
  H3IdentityBindings, H3IdentityEventBinding, H3PerformanceEvent, H3PerformancePlan,
  H3PerformanceReaction, H3PerformanceVoiceEvent,
} from './types';
import { H3_EXISTING_SOUND_SUMMARY_EN, H3_EXISTING_SOUND_SUMMARY_ZH, renderH3DeliverySections } from './h3DeliverySections';

const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const optionalTime = (value: unknown): boolean => value === undefined || finite(value);
const optionalStrings = (value: unknown): boolean => value === undefined || strings(value);

const readableReaction = (value: unknown): value is H3PerformanceReaction => object(value)
  && typeof value.characterId === 'string' && typeof value.description === 'string'
  && (value.presence === undefined || value.presence === 'visible' || value.presence === 'offscreen');

const readableEvent = (value: unknown): value is H3PerformanceEvent => {
  if (!object(value) || typeof value.eventId !== 'string' || !optionalString(value.sourceFact)
    || !optionalTime(value.startSec) || !optionalTime(value.endSec)) return false;
  if (value.kind === 'visual') return typeof value.description === 'string'
    && optionalStrings(value.silentCharacterIds) && optionalString(value.soundDescription);
  if (value.kind !== 'speech' && value.kind !== 'vocal') return false;
  if (!strings(value.speakerCharacterIds) || !optionalStrings(value.listenerCharacterIds)
    || !['on-screen', 'off-screen', 'voiceover', 'inner-voice'].includes(String(value.channel))
    || !optionalString(value.delivery) || !optionalString(value.speakerAction)
    || !(value.reactions === undefined || Array.isArray(value.reactions) && value.reactions.every(readableReaction))) return false;
  if (value.kind === 'vocal') return typeof value.vocalDescription === 'string';
  return typeof value.dialogueId === 'string' && typeof value.text === 'string' && typeof value.language === 'string'
    && (value.continuesFromPreviousShot === undefined || typeof value.continuesFromPreviousShot === 'boolean')
    && (value.continuesInNextShot === undefined || typeof value.continuesInNextShot === 'boolean');
};

/** Read optional transport data only. An absent/unknown shape takes the old
 * compatible path; no content judgement, rejection, repair or model call. */
export const parseH3PerformancePlan = (value: unknown): H3PerformancePlan | undefined => {
  if (!object(value) || value.version !== 1 || !['shot', 'clip'].includes(String(value.timeBase))
    || !(value.descriptionLanguage === undefined || value.descriptionLanguage === 'zh' || value.descriptionLanguage === 'en')
    || !optionalString(value.preamble) || !optionalString(value.summary) || !optionalString(value.retentionAnalysis)
    || typeof value.overallSoundscape !== 'string' || typeof value.nonDiegeticMusic !== 'string'
    || !Array.isArray(value.shots) || !value.shots.length) return undefined;
  if (value.characters !== undefined && (!Array.isArray(value.characters) || !value.characters.every((entry) => object(entry)
    && typeof entry.characterId === 'string' && typeof entry.visualDescription === 'string'
    && optionalString(entry.name) && (entry.presence === undefined || entry.presence === 'visible' || entry.presence === 'offscreen')
    && optionalString(entry.voiceDescription)))) return undefined;
  if (!value.shots.every((shot) => object(shot) && finite(shot.shotIndex) && finite(shot.startSec)
    && typeof shot.visualDescription === 'string' && Array.isArray(shot.events) && shot.events.every(readableEvent))) return undefined;
  return normalizeH3PerformancePlan(value as unknown as H3PerformancePlan);
};

const copyEvent = (event: H3PerformanceEvent, offset: number): H3PerformanceEvent => ({
  ...event,
  ...(event.startSec !== undefined ? { startSec: Number((event.startSec + offset).toFixed(6)) } : {}),
  ...(event.endSec !== undefined ? { endSec: Number((event.endSec + offset).toFixed(6)) } : {}),
  ...(event.kind === 'visual'
    ? { ...(event.silentCharacterIds ? { silentCharacterIds: [...event.silentCharacterIds] } : {}) }
    : { speakerCharacterIds: [...event.speakerCharacterIds],
      ...(event.listenerCharacterIds ? { listenerCharacterIds: [...event.listenerCharacterIds] } : {}),
      ...(event.reactions ? { reactions: event.reactions.map((reaction) => ({ ...reaction })) } : {}) }),
});

/** A declared shot clock is converted once; a saved clip clock is idempotent.
 * No number is parsed from prose and no historical prompt is rewritten. */
export const normalizeH3PerformancePlan = (plan: H3PerformancePlan): H3PerformancePlan => ({
  ...plan, timeBase: 'clip',
  ...(plan.characters ? { characters: plan.characters.map((entry) => ({ ...entry })) } : {}),
  shots: plan.shots.map((shot) => ({ ...shot,
    events: shot.events.map((event) => copyEvent(event, plan.timeBase === 'shot' ? shot.startSec : 0)),
  })),
});

/** Source order breaks equal-time ties, including explicitly simultaneous
 * speakers. Visual subjects and uploaded pictures do not participate. */
export const h3PerformanceSpeakerTokens = (source: H3PerformancePlan): Map<string, string> => {
  const plan = normalizeH3PerformancePlan(source);
  const events = plan.shots.flatMap((shot) => shot.events.map((event) => ({ event, time: event.startSec ?? shot.startSec })))
    .filter((entry): entry is { event: Exclude<H3PerformanceEvent, { kind: 'visual' }>; time: number } => entry.event.kind !== 'visual')
    .sort((left, right) => left.time - right.time);
  const speakers = new Map<string, string>();
  events.forEach(({ event }) => event.speakerCharacterIds.forEach((id) => {
    if (!speakers.has(id)) speakers.set(id, `(S${speakers.size + 1})`);
  }));
  return speakers;
};

export interface RenderH3PerformancePlanInput {
  plan: H3PerformancePlan;
  characters: H3IdentityBindings['characters'];
  language: 'zh' | 'en';
  audioMode?: string;
  mode?: 'integrated' | 'full-reference';
  subjectTokens?: ReadonlyMap<string, string>;
  characterPictures?: ReadonlyMap<string, readonly number[]>;
  /** Only explicitly authored audio references, independent of picture slots. */
  characterAudio?: ReadonlyMap<string, readonly number[]>;
  pictureUses?: readonly { number: number; role: string }[];
  /** Extra non-character definitions only. Character definitions and their
   * anchors are emitted from the paired plan by this renderer. */
  subjectDefinitions?: string;
  summary?: string;
  retentionAnalysis?: string;
}

export interface RenderH3PerformancePlanResult {
  prompt: string;
  body: string;
  plan: H3PerformancePlan;
  speakerTokens: Map<string, string>;
  characters: H3IdentityBindings['characters'];
  events: H3IdentityEventBinding[];
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];
const seconds = (value: number): string => value.toFixed(2);
const cutTime = (value: number): string => {
  const milliseconds = Math.round(value * 1000);
  const minutes = Math.floor(milliseconds / 60000);
  return `${String(minutes).padStart(2, '0')}:${((milliseconds % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
};
const sentence = (text: string, language: 'zh' | 'en'): string => {
  const body = text.trim();
  return !body || /[.!?。！？：:;；]$/u.test(body) ? body : `${body}${language === 'en' ? '.' : '。'}`;
};

/** Construct only adopted visual performance and authored voice events. It
 * never merges the preceding free-text H3 back into this new body. */
export const renderH3PerformancePlan = (input: RenderH3PerformancePlanInput): RenderH3PerformancePlanResult => {
  const plan = normalizeH3PerformancePlan(input.plan);
  const language = input.language;
  plan.descriptionLanguage = language;
  const en = language === 'en';
  plan.overallSoundscape = plan.overallSoundscape.trim() || (input.audioMode === 'none' ? 'N/A'
    : en ? H3_EXISTING_SOUND_SUMMARY_EN : H3_EXISTING_SOUND_SUMMARY_ZH);
  plan.nonDiegeticMusic = plan.nonDiegeticMusic.trim() || 'N/A';
  const fullReference = input.mode === 'full-reference';
  const speakerTokens = h3PerformanceSpeakerTokens(plan);
  const entries = new Map(input.characters.map((entry) => [entry.characterId, entry]));
  const descriptions = new Map((plan.characters || []).map((entry) => [entry.characterId, entry]));
  const subjects = new Map<string, string>();
  const usedSubjects = new Set([
    ...[...(input.subjectDefinitions || '').matchAll(/<Subject\s+(\d+)>/gu)].map((match) => Number(match[1])),
    ...input.characters.flatMap((entry) => {
      const token = input.subjectTokens?.get(entry.characterId) || entry.subjectToken;
      const number = token?.match(/<Subject\s+(\d+)>/u)?.[1];
      return number ? [Number(number)] : [];
    }),
  ]);
  if (fullReference) input.characters.forEach((entry) => {
    const explicit = input.subjectTokens?.get(entry.characterId) || entry.subjectToken;
    if (descriptions.get(entry.characterId)?.presence !== 'offscreen' || explicit
      || input.characterPictures?.get(entry.characterId)?.length) {
      let number = 1;
      while (usedSubjects.has(number)) number += 1;
      const subject = explicit || `<Subject ${number}>`;
      if (!explicit) usedSubjects.add(number);
      subjects.set(entry.characterId, subject);
    }
  });
  const name = (id: string): string => entries.get(id)?.name || descriptions.get(id)?.name
    || (speakerTokens.has(id) ? (en ? 'The declared voice source' : '已声明声源') : (en ? 'The declared character' : '已声明人物'));
  const label = (id: string): string => `${subjects.get(id) ? `${subjects.get(id)} ` : ''}${name(id)}`;
  const names = (ids: readonly string[]): string => unique(ids).map(label).join(en ? ' and ' : '与');
  const voiceLabel = (ids: readonly string[]): string => {
    const tokens = unique(ids).map((id) => speakerTokens.get(id)).filter((token): token is string => Boolean(token));
    return `${names(ids)}${tokens.length ? ` (${tokens.map((token) => token.slice(1, -1)).join(',')})` : ''}`;
  };
  const time = (event: H3PerformanceEvent): string => {
    if (event.startSec !== undefined && event.endSec !== undefined) return en
      ? `From ${seconds(event.startSec)} to ${seconds(event.endSec)} seconds of this clip, `
      : `本段${seconds(event.startSec)}–${seconds(event.endSec)}秒，`;
    if (event.startSec !== undefined) return en ? `At ${seconds(event.startSec)} seconds of this clip, ` : `本段${seconds(event.startSec)}秒，`;
    if (event.endSec !== undefined) return en ? `Until ${seconds(event.endSec)} seconds of this clip, ` : `至本段${seconds(event.endSec)}秒，`;
    return '';
  };
  const renderedCharacters = input.characters.map((entry) => {
    const { speakerToken: _oldVoice, subjectToken: _oldSubject, referenceAnchor: _oldAnchor, ...identity } = entry;
    const description = descriptions.get(entry.characterId)?.visualDescription.trim() || '';
    const speakerToken = speakerTokens.get(entry.characterId);
    const pictures = input.characterPictures?.get(entry.characterId) || [];
    const pictureText = pictures.map((number) => `<Picture ${number}>`).join(', ');
    const audio = speakerToken ? input.characterAudio?.get(entry.characterId) || [] : [];
    const audioText = audio.length ? `${en ? ', with the voice referenced from ' : '，声音参考为'}${audio.map((number) => `<Audio ${number}>`).join(', ')}` : '';
    const referenceAnchor = fullReference && subjects.has(entry.characterId)
      ? sentence(`${subjects.get(entry.characterId)} ${en ? 'is' : '是'} ${entry.name}${speakerToken ? ` ${speakerToken}` : ''}${pictureText ? `${en ? ', visually referenced from ' : '，视觉参考为'}${pictureText}` : ''}${audioText}${description ? `${en ? ': ' : '：'}${description}` : ''}`, language)
      : sentence(`${descriptions.get(entry.characterId)?.presence === 'offscreen' ? (en ? 'Voice identity' : '声音身份') : (en ? 'Identity' : '人物身份')}: ${entry.name}${speakerToken ? ` ${speakerToken}` : ''}${audioText}${description ? `${en ? ': ' : '：'}${description}` : ''}`, language);
    return { ...identity, ...(subjects.has(entry.characterId) ? { subjectToken: subjects.get(entry.characterId)! } : {}),
      ...(speakerToken ? { speakerToken } : {}), referenceAnchor };
  });
  const events: H3IdentityEventBinding[] = [];

  const reactions = (event: H3PerformanceVoiceEvent): string[] => {
    const output: string[] = [];
    const listeners = unique(event.listenerCharacterIds || []).filter((id) => !event.speakerCharacterIds.includes(id));
    for (const id of listeners) {
      const reaction = event.reactions?.find((item) => item.characterId === id);
      const noLip = reaction?.presence === 'visible'
        ? (en ? ', with no speaking lip movement' : '，没有说话口型') : '';
      output.push(en ? `${label(id)} listens without speaking${noLip}.` : `${label(id)}保持倾听、不发话${noLip}。`);
    }
    for (const reaction of event.reactions || []) {
      if (!reaction.description.trim()) continue;
      const speaker = event.speakerCharacterIds.includes(reaction.characterId);
      const state = speaker ? '' : (en ? ' remains silent' : '保持静默');
      output.push(sentence(`${label(reaction.characterId)}${state}: ${reaction.description}`, language));
    }
    return output;
  };
  const renderEvent = (event: H3PerformanceEvent): string => {
    const output: string[] = [];
    if (event.kind === 'visual') {
      if (event.description.trim()) output.push(sentence(time(event) + event.description, language));
      if (event.silentCharacterIds?.length) output.push(en
        ? `${names(event.silentCharacterIds)} remains silent during this action, without dialogue, voiceover, internal speech or speaking lip movements; natural expressions and the authored physical action continue.`
        : `${names(event.silentCharacterIds)}在此动作期间保持静默，没有对白、旁白、内心配音或说话口型，保留自然表情及原定动作。`);
      if (event.soundDescription?.trim()) output.push(sentence(event.soundDescription, language));
      const rendered = output.join(en ? ' ' : '');
      events.push({ eventId: event.eventId, kind: 'action', referenceAnchor: rendered });
      return rendered;
    }

    const speakers = voiceLabel(event.speakerCharacterIds);
    const listenerIds = unique(event.listenerCharacterIds || []).filter((id) => !event.speakerCharacterIds.includes(id));
    const target = listenerIds.length ? (en ? ` to ${names(listenerIds)}` : `面向${names(listenerIds)}`) : '';
    const channel = {
      'on-screen': en ? 'speaks on-screen' : '在画内发话',
      'off-screen': en ? 'speaks from off-screen' : '从画外发话',
      voiceover: en ? 'says in an off-screen voiceover' : '以明确的画外旁白发话',
      'inner-voice': en ? 'is heard in an explicitly authored inner voice' : '以原定的内心声音发话',
    }[event.channel];
    const voiceDescriptions = unique(event.speakerCharacterIds).flatMap((id) => {
      const voice = descriptions.get(id)?.voiceDescription?.trim();
      return voice ? [sentence(`${label(id)}${en ? ' retains the authored voice' : '沿用已确认声线'}: ${voice}`, language)] : [];
    });
    if (event.kind === 'speech') {
      const dialogue = `<d>[${event.language}] ${event.continuesFromPreviousShot ? '<scenetrans>' : ''}${event.text}${event.continuesInNextShot ? '<scenetrans>' : ''}</d>`;
      const simultaneous = unique(event.speakerCharacterIds).length > 1 ? (en ? ' in unison' : '共同同步') : '';
      output.push(`${time(event)}${speakers}${en ? ' ' : ''}${channel}${simultaneous}${target}: ${dialogue}`);
      if (event.channel === 'on-screen') output.push(en
        ? `${names(event.speakerCharacterIds)} produces the speaking lip movements for these words.`
        : `${names(event.speakerCharacterIds)}产生本句对应的说话口型。`);
      else if (event.channel === 'voiceover' || event.channel === 'inner-voice') output.push(en
        ? 'This voice does not assign speaking lip movements to an on-screen character.'
        : '这段声音不安排画内人物张口代说。');
      if (event.continuesFromPreviousShot || event.continuesInNextShot) output.push(en
        ? `${speakers} keeps the same continuous voice across the authored cut, without restarting or repeating words.`
        : `${speakers}跨越既有切镜时保持声音连续，不重起或重复原话。`);
    } else {
      const position = event.channel === 'on-screen' ? (en ? 'on-screen' : '画内') : (en ? 'off-screen' : '画外');
      output.push(sentence(`${time(event)}${speakers}${en ? ` makes the authored ${position} non-verbal vocal sound` : `发出原定${position}非语言人声`}: ${event.vocalDescription}`, language));
    }
    output.push(...voiceDescriptions);
    if (event.delivery?.trim()) output.push(sentence(`${names(event.speakerCharacterIds)}${en ? ' delivers this voice' : '本次发声表演'}: ${event.delivery}`, language));
    if (event.speakerAction?.trim()) output.push(sentence(`${names(event.speakerCharacterIds)}${en ? ' performs the authored action' : '执行本次动作'}: ${event.speakerAction}`, language));
    output.push(...reactions(event));
    const rendered = output.join(en ? ' ' : '');
    events.push({ eventId: event.eventId, kind: 'dialogue', ...(event.kind === 'speech' ? { dialogueId: event.dialogueId } : {}),
      ...(event.speakerCharacterIds.length === 1 ? { speakerCharacterId: event.speakerCharacterIds[0] } : {}),
      ...(event.listenerCharacterIds ? { listenerCharacterIds: [...event.listenerCharacterIds] } : {}), referenceAnchor: rendered });
    return rendered;
  };

  const voiceOnlyDefinitions = (plan.characters || []).filter((entry) => !entries.has(entry.characterId) && speakerTokens.has(entry.characterId))
    .map((entry) => {
      const audio = input.characterAudio?.get(entry.characterId) || [];
      return sentence(`${en ? 'Voice identity' : '声音身份'}: ${name(entry.characterId)} ${speakerTokens.get(entry.characterId)}${audio.length ? `${en ? ', referenced from ' : '，声音参考为'}${audio.map((number) => `<Audio ${number}>`).join(', ')}` : ''}`, language);
    });
  const integratedOpening = !fullReference ? [...renderedCharacters.map((entry) => entry.referenceAnchor), ...voiceOnlyDefinitions, plan.preamble?.trim()].filter(Boolean).join('\n') : '';
  const shots = plan.shots.map((shot, index) => {
    const marker = `[Shot ${shot.shotIndex}]${index ? ` At ${cutTime(shot.startSec)}` : ''}`;
    return [marker, !index ? integratedOpening : '', sentence(shot.visualDescription, language), ...shot.events.map(renderEvent)].filter(Boolean).join('\n');
  });
  const body = [fullReference ? plan.preamble?.trim() : '', ...shots]
    .filter(Boolean).join('\n\n');
  const definitions = [...renderedCharacters.map((entry) => entry.referenceAnchor), ...voiceOnlyDefinitions];
  if (input.subjectDefinitions?.trim()) definitions.push(input.subjectDefinitions.trim());
  const pictureRoles: Record<string, string> = {
    'first-frame': en ? 'opening composition reference' : '开场构图参考',
    'last-frame': en ? 'ending composition reference' : '结尾构图参考',
    'middle-frame': en ? 'intermediate composition and continuity reference' : '中间构图与衔接参考',
    scene: en ? 'environment layout and lighting reference' : '环境布局与光影参考',
    prop: en ? 'prop appearance reference' : '道具外观参考',
    style: en ? 'visual style reference' : '视觉风格参考',
    motion: en ? 'action pose reference' : '动作姿态参考',
    composition: en ? 'composition reference' : '构图参考',
    camera: en ? 'camera composition reference' : '镜头构图参考',
    'clay-render': en ? 'form and spatial structure reference' : '形体与空间结构参考',
    creative: en ? 'visual concept reference' : '视觉概念参考',
  };
  for (const use of input.pictureUses || []) {
    const role = pictureRoles[use.role];
    const declared = new RegExp(`^<Picture ${use.number}>\\s+(?:is\\b|用于|是|为)`, 'mu').test(definitions.join('\n'));
    if (role && !declared) definitions.push(sentence(`<Picture ${use.number}> ${en ? 'is the' : '用于'} ${role}`, language));
  }
  const summary = (input.summary ?? plan.summary)?.trim() || (en ? 'The authored scene unfolds in the following shots.' : '按下列镜头展开已确认的场景表演。');
  const retention = (input.retentionAnalysis ?? plan.retentionAnalysis)?.trim() || (en
    ? 'Keep the referenced identities and the authored scene relationships.' : '保留参考身份与已确认的场景关系。');
  const prompt = renderH3DeliverySections({ body, subjectDefinitions: definitions.join('\n'),
    summary: /^\[reference generation[^\]]*\]/u.test(summary) ? summary : `[reference generation] ${summary}`,
    retentionAnalysis: retention, overallSoundscape: plan.overallSoundscape, nonDiegeticMusic: plan.nonDiegeticMusic,
  }, { mode: fullReference ? 'full-reference' : 'integrated', language });
  return { prompt, body, plan, speakerTokens, characters: renderedCharacters, events };
};
