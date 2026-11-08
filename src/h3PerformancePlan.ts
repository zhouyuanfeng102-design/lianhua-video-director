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
  /** Keep a score only when this request asked for one, or a repair must
   * retain a score already confirmed in the source prompt. */
  keepScore?: boolean;
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
const dialogueLanguageTag = (value: string): string => {
  const token = value.trim();
  if (/^(chinese|zh|zh-cn|中文)$/iu.test(token)) return '中文';
  if (/^(english|en)$/iu.test(token)) return 'English';
  return token || '中文';
};
const bodyChainSentence = (text: string, en: boolean): string | undefined => {
  if (!/头|脸|颈|脖子|近景|特写|close-?up|close view|\bhead\b|\bface\b|\bneck\b/iu.test(text)) return undefined;
  const chain = en
    ? 'The head remains on this neck, the neck remains on these shoulders, the torso remains on these hips, and the foot remains on this ankle.'
    : '头留在这截脖子上，脖子留在这对肩膀上，躯干留在这截腰上，脚留在这截脚踝上。';
  const surface = /发带|金带|金丝|蒙眼|ribbon|blindfold|头发|\bhair\b/iu.test(text)
    ? (en
      ? ' Hair, ribbon, and any cloth over the eyes remain on the surface of the head, across the back of the head.'
      : '头发、发带和蒙眼布留在头的表面上，绕在后脑的表面上。')
    : '';
  return chain + surface;
};
const bracedHandsSentence = (text: string, en: boolean): string | undefined => {
  if (!/跪伏|趴跪|俯撑|kneeling bent over|kneels bent over/iu.test(text)) return undefined;
  if (/双手|手撑|撑在|掌心|手掌|双掌|背后|举高|举起|拿着|握住|palms|hands behind|hands raised|holding/iu.test(text)) return undefined;
  return en
    ? 'Both palms remain on the support in front of the shoulders, the forearms run from the shoulders to those palms, the elbows stay outside the ribs, and the fingers stay on the palms.'
    : '双掌留在肩膀前方的支撑面上，前臂从肩膀连到这双掌，肘留在肋骨外侧，手指留在掌上。';
};
const lowPoseSentence = (text: string, en: boolean): string | undefined => (
  /床底|桌下|柜内|柜里|门后|躲|钻进|藏在|趴在|伏在/u.test(text)
    ? (en
      ? 'The torso remains below the covering, knees and hips bent. The person does not stand or lie on top of it.'
      : '躯干留在遮挡物下面，膝和髋是弯的，不在遮挡物上面站直或躺平。')
    : undefined
);
const scoreMention = /配乐|背景音乐|非叙事音乐|BGM|underscore|soundtrack|non-diegetic|配器|旋律|节拍|弦乐|钢琴|\bpiano\b|\bviolin\b|\bstrings\b|\borchestra\b|\bscore\b|no music|no bgm|不要配乐|禁止配乐|不要背景音乐|without music|without a score|without bgm/iu;
const denialMusic = (value: string): boolean => {
  const compact = value.trim().replace(/[。.\s]/gu, '');
  if (!compact) return true;
  if (/^(?:n\/a|none|无|无配乐|无背景音乐|silence|nomusic|nobgm|不要配乐|禁止配乐|不要背景音乐)$/iu.test(compact)) return true;
  return /不要配乐|禁止配乐|不要背景音乐|无配乐|no music|no bgm/iu.test(value) && !/钢琴|弦乐|piano|violin|配器|旋律/iu.test(value);
};
/** A saved line is a score only when it names music and is not a refusal. */
export const h3KeepsScore = (value: string | undefined): boolean => {
  const text = (value || '').trim();
  return Boolean(text) && !denialMusic(text) && scoreMention.test(text);
};
/** User wording in this request. Style, category and story mood do not count. */
export const h3MusicRequested = (value: string | undefined): boolean => {
  const text = value || '';
  if (/不要配乐|禁止配乐|无配乐|不要背景音乐|no music|no bgm/iu.test(text)) return false;
  return /配乐|背景音乐|\bBGM\b|配器/u.test(text);
};
const musicLine = (value: string | undefined, keep: boolean): string => {
  const text = (value || '').trim();
  if (!keep || denialMusic(text)) return 'N/A';
  return text;
};
const dropUnauthorizedScore = (text: string): string => {
  const blocks: string[] = [];
  const masked = text.replace(/<d>[\s\S]*?<\/d>/gu, (block) => {
    blocks.push(block);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const kept = masked.split(/(?<=[。！？.!?])\s*|\n+/u).filter((part) => {
    const visible = part.replace(/\u0000\d+\u0000/gu, '').trim();
    return Boolean(visible) && !scoreMention.test(visible);
  });
  return kept.join(' ').replace(/\u0000(\d+)\u0000/gu, (_, index) => blocks[Number(index)] ?? '').replace(/[ \t]{2,}/gu, ' ').trim();
};
/** Chinese shots stay in Chinese. English example sentences copied into a
 * Chinese plan are left for the English page. Dialogue tags stay intact. */
const keepChineseShotText = (text: string): string => {
  const blocks: string[] = [];
  const masked = text.replace(/<d>[\s\S]*?<\/d>/gu, (block) => {
    blocks.push(block);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const kept = masked.split(/(?<=[。！？.!?])\s+|\n+/u).filter((part) => {
    const visible = part.replace(/\u0000\d+\u0000/gu, '');
    if (!visible.trim()) return true;
    if (/[\u3400-\u9fff]/u.test(visible)) return true;
    return !/[A-Za-z]{3,}/u.test(visible);
  });
  return kept.join('').replace(/\u0000(\d+)\u0000/gu, (_, index) => blocks[Number(index)]).replace(/[ \t]{2,}/gu, ' ').trim();
};
const sentence = (text: string, language: 'zh' | 'en'): string => {
  const body = text.trim();
  return !body || /[.!?。！？：:;；]$/u.test(body) ? body : `${body}${language === 'en' ? '.' : '。'}`;
};

/** Identity anchors are metadata locators, not repeated scene prose. Keep the
 * first authored occurrence and remove later exact copies emitted by a model
 * or carried in an older definitions block. */
const deduplicateIdentityAnchors = (prompt: string, anchors: readonly string[]): string => {
  let result = prompt;
  for (const anchor of anchors) {
    if (!anchor) continue;
    const positions: number[] = [];
    let at = result.indexOf(anchor);
    while (at >= 0) {
      positions.push(at);
      at = result.indexOf(anchor, at + anchor.length);
    }
    for (const start of positions.slice(1).sort((left, right) => right - left)) {
      result = result.slice(0, start) + result.slice(start + anchor.length);
    }
  }
  return result;
};

/** Construct only adopted visual performance and authored voice events. It
 * never merges the preceding free-text H3 back into this new body. */
export const renderH3PerformancePlan = (input: RenderH3PerformancePlanInput): RenderH3PerformancePlanResult => {
  const plan = normalizeH3PerformancePlan(input.plan);
  const language = input.language;
  plan.descriptionLanguage = language;
  const en = language === 'en';
  const authored = (text: string): string => en ? text : keepChineseShotText(text);
  if (!en) plan.overallSoundscape = keepChineseShotText(plan.overallSoundscape || '');
  const spokenLines = plan.shots.flatMap((shot) => shot.events.flatMap((event) => event.kind === 'speech' ? [event.text.trim()] : []));
  let soundscape = plan.overallSoundscape;
  for (const line of spokenLines) if (line.length >= 2) soundscape = soundscape.split(line).join('');
  soundscape = soundscape.replace(/<d>[\s\S]*?<\/d>/gu, '').replace(/台词\s*[:：]\s*无|Dialogue:\s*none/giu, '').replace(/[ \t]{2,}/gu, ' ').trim();
  const keepScore = input.keepScore === true;
  if (!keepScore) {
    soundscape = dropUnauthorizedScore(soundscape);
    for (const shot of plan.shots) shot.visualDescription = dropUnauthorizedScore(shot.visualDescription);
  }
  plan.overallSoundscape = soundscape || (input.audioMode === 'none' ? 'N/A'
    : en ? H3_EXISTING_SOUND_SUMMARY_EN : H3_EXISTING_SOUND_SUMMARY_ZH);
  plan.nonDiegeticMusic = musicLine(plan.nonDiegeticMusic, keepScore);
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
    const offscreen = descriptions.get(entry.characterId)?.presence === 'offscreen';
    if (offscreen) {
      if (explicit) subjects.set(entry.characterId, explicit);
      return;
    }
    {
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
    const offscreenPresence = descriptions.get(entry.characterId)?.presence === 'offscreen';
    const description = offscreenPresence ? '' : authored((descriptions.get(entry.characterId)?.visualDescription || '').replace(/\s*\(S\d+(?:\s*,\s*S\d+)*\)/gu, '').trim());
    const speakerToken = speakerTokens.get(entry.characterId);
    const pictures = input.characterPictures?.get(entry.characterId) || [];
    const pictureText = pictures.map((number) => `<Picture ${number}>`).join(', ');
    const audio = input.characterAudio?.get(entry.characterId) || [];
    const audioText = offscreenPresence && audio.length ? `${en ? ', referenced from ' : '，声音参考为'}${audio.map((number) => `<Audio ${number}>`).join(', ')}` : '';
    const voiceOnly = offscreenPresence
      ? sentence(`${subjects.has(entry.characterId) ? `${subjects.get(entry.characterId)} ${en ? 'is the voice of' : '是'}` : (en ? 'Voice identity:' : '声音身份：')} ${entry.name}${audioText}${en ? ', remaining outside the frame' : '，留在画面外'}`, language)
      : '';
    const referenceAnchor = voiceOnly || (fullReference && subjects.has(entry.characterId)
      ? sentence(`${subjects.get(entry.characterId)} ${en ? 'is' : '是'} ${entry.name}${pictureText ? `${en ? ', visually referenced from ' : '，视觉参考为'}${pictureText}` : ''}${description ? `${en ? ': ' : '：'}${description}` : ''}`, language)
      : sentence(`${en ? 'Identity' : '人物身份'}: ${entry.name}${description ? `${en ? ': ' : '：'}${description}` : ''}`, language));
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
  let lastSpeechIds: string[] = [];
  const speakerKey = (ids: readonly string[]): string => unique(ids).slice().sort().join('\0');
  const mouthsClosed = (ids: readonly string[]): string => en
    ? `${names(ids)} keeps their mouth closed.`
    : `${names(ids)}的嘴保持闭合。`;
  const voicePreface = (ids: readonly string[]): string => {
    const voices = unique(ids).map((id) => descriptions.get(id)?.voiceDescription?.trim()).filter((value): value is string => Boolean(value));
    const audio = unique(ids).flatMap((id) => input.characterAudio?.get(id) || []);
    const voice = voices.length ? (en ? `, ${voices.join(' and ')}` : `，${voices.join('、')}`) : '';
    const heard = audio.length ? (en ? `, with the voice referenced from ${audio.map((number) => `<Audio ${number}>`).join(', ')}` : `，声音参考为${audio.map((number) => `<Audio ${number}>`).join('、')}`) : '';
    return `${voice}${heard}`;
  };
  const cutToMouth = (ids: readonly string[], listeners: readonly string[]): string => {
    const who = names(ids);
    const framing = en
      ? `The camera cuts to a close view of ${who}'s mouth. The authored body action continues.`
      : `镜头切到${who}能看清的嘴，已经写好的身体动作继续。`;
    const facing = listeners.length
      ? (en
        ? ` ${who} keeps the chest and eyes toward ${names(listeners)}. The camera stays beside the line between them.`
        : `${who}的胸口和眼睛留在${names(listeners)}身上，摄影机在两人连线的侧面。`)
      : '';
    return framing + facing;
  };
  const lastOnScreenSpeech = new Map<string, string>();
  for (const shot of plan.shots) for (const event of shot.events) {
    if (event.kind === 'speech' && event.channel === 'on-screen') lastOnScreenSpeech.set(speakerKey(event.speakerCharacterIds), event.eventId);
  }
  const said = new Set<string>();
  const renderEvent = (event: H3PerformanceEvent, shot: H3PerformancePlan['shots'][number]): string => {
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

    const narration = event.channel === 'voiceover';
    const unseen = narration || event.channel === 'off-screen' || event.channel === 'inner-voice';
    const spokenNames = (ids: readonly string[]): string => {
      const tokens = unique(ids).map((id) => speakerTokens.get(id)).filter((token): token is string => Boolean(token));
      const who = unique(ids).map(name).join(en ? ' and ' : '与');
      return `${who}${tokens.length ? ` (${tokens.map((token) => token.slice(1, -1)).join(',')})` : ''}`;
    };
    const speakers = unseen ? spokenNames(event.speakerCharacterIds) : voiceLabel(event.speakerCharacterIds);
    const listenerIds = unique(event.listenerCharacterIds || []).filter((id) => !event.speakerCharacterIds.includes(id));
    const verb = narration ? 'says in an off-screen voiceover' : 'says';
    const closedMouths = listenerIds.length
      ? (en ? `${names(listenerIds)} keep their mouths closed.` : `${names(listenerIds)}的嘴保持闭合。`)
      : (en ? 'The mouths already in the picture stay closed.' : '画面里已有的嘴保持闭合。');
    if (event.kind === 'speech') {
      const dialogue = `<d>[${dialogueLanguageTag(event.language)}] ${event.continuesFromPreviousShot ? '<scenetrans>' : ''}${event.text}${event.continuesInNextShot ? '<scenetrans>' : ''}</d>`;
      const changedSpeaker = lastSpeechIds.length > 0 && speakerKey(lastSpeechIds) !== speakerKey(event.speakerCharacterIds);
      if (!unseen && listenerIds.length) output.push(mouthsClosed(listenerIds));
      if (!unseen && changedSpeaker) {
        const stillSpeaking = lastSpeechIds.filter((id) => !listenerIds.includes(id));
        if (stillSpeaking.length) output.push(mouthsClosed(stillSpeaking));
      }
      const alreadySaid = said.has(event.text.trim()) && !event.continuesFromPreviousShot;
      if (!alreadySaid && !unseen) output.push(cutToMouth(event.speakerCharacterIds, listenerIds));
      const preface = voicePreface(event.speakerCharacterIds);
      const comma = preface ? (en ? ',' : '，') : '';
      if (!alreadySaid) {
        output.push(`${time(event)}${speakers}${preface}${comma}${en ? ' ' : ''}${verb}: ${dialogue}`);
        said.add(event.text.trim());
      }
      if (unseen) {
        output.push(en ? `${names(event.speakerCharacterIds)} remains outside this shot.` : `${names(event.speakerCharacterIds)}留在这一镜的画面外。`);
        output.push(closedMouths);
      }
      if (!unseen) lastSpeechIds = [...event.speakerCharacterIds];
      if (event.continuesFromPreviousShot || event.continuesInNextShot) output.push(en
        ? `${speakers} keeps the same continuous voice across the authored cut, without restarting or repeating words.`
        : `${speakers}跨越既有切镜时保持声音连续，不重起或重复原话。`);
    } else {
      const position = event.channel === 'on-screen' ? (en ? 'on-screen' : '画内') : (en ? 'off-screen' : '画外');
      const vocal = authored(event.vocalDescription || '');
      if (vocal) output.push(sentence(`${time(event)}${speakers}${en ? ` makes the authored ${position} non-verbal vocal sound` : `发出原定${position}非语言人声`}: ${vocal}`, language));
      if (unseen) {
        output.push(en ? `${names(event.speakerCharacterIds)} remains outside this shot.` : `${names(event.speakerCharacterIds)}留在这一镜的画面外。`);
        output.push(closedMouths);
      }
    }
    if (event.delivery?.trim()) {
      const delivery = authored(event.delivery);
      if (delivery) output.push(sentence(delivery, language));
    }
    if (!unseen && event.speakerAction?.trim()) {
      const action = authored(event.speakerAction);
      if (action) output.push(sentence(action, language));
      const pose = lowPoseSentence(event.speakerAction, en);
      if (pose) output.push(pose);
    }
    output.push(...reactions(event));
    if (event.kind === 'speech' && !unseen && lastOnScreenSpeech.get(speakerKey(event.speakerCharacterIds)) === event.eventId) {
      output.push(en ? 'That mouth closes.' : '这张嘴重新闭合。');
    }
    const rendered = output.join(en ? ' ' : '');
    events.push({ eventId: event.eventId, kind: 'dialogue', ...(event.kind === 'speech' ? { dialogueId: event.dialogueId } : {}),
      ...(event.speakerCharacterIds.length === 1 ? { speakerCharacterId: event.speakerCharacterIds[0] } : {}),
      ...(event.listenerCharacterIds ? { listenerCharacterIds: [...event.listenerCharacterIds] } : {}), referenceAnchor: rendered });
    return rendered;
  };

  const voiceOnlyDefinitions = (plan.characters || []).filter((entry) => !entries.has(entry.characterId) && speakerTokens.has(entry.characterId))
    .map((entry) => {
      const audio = input.characterAudio?.get(entry.characterId) || [];
      return sentence(`${en ? 'Voice identity' : '声音身份'}: ${name(entry.characterId)}${audio.length ? `${en ? ', referenced from ' : '，声音参考为'}${audio.map((number) => `<Audio ${number}>`).join(', ')}` : ''}`, language);
    });
  const preamble = authored(plan.preamble?.trim() || '');
  const integratedOpening = !fullReference ? [...renderedCharacters.map((entry) => entry.referenceAnchor), ...voiceOnlyDefinitions, preamble].filter(Boolean).join('\n') : '';
  const spokenByEvents = (shot: H3PerformancePlan['shots'][number]): Set<string> => new Set(shot.events.flatMap((event) => event.kind === 'speech' ? [event.text.trim()] : []));
  const dialogueText = (tag: string): string => tag.replace(/<\/?d>/gu, '').replace(/^\s*\[[^\]]+\]\s*/u, '').trim();
  const outsideDialogue = (text: string, edit: (value: string) => string): string => {
    const blocks: string[] = [];
    const masked = text.replace(/<d>[\s\S]*?<\/d>/gu, (block) => {
      blocks.push(block);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    return edit(masked).replace(/\u0000(\d+)\u0000/gu, (_token, index) => blocks[Number(index)] ?? '');
  };
  const releaseHeldFraming = (text: string): string => text.split(/(?<=[。！？.!?])\s+|\n+/u).map((part) => part
    .replace(/It stays at this distance(?: through (?:her|his|their|the) line)?[.]?/giu, '')
    .replace(/\b(?:and )?does not move\b\.?/giu, '')
    .replace(/\bdo not move\b\.?/giu, '')
    .replace(/The camera holds this frame[^.]{0,80}\./giu, '')
    .replace(/through (?:her|his|their|the) line/giu, '')
    .replace(/镜头在[^。]{0,12}这句[^。]{0,24}(?:保持|停在)[^。]{0,40}。/gu, '')
    .replace(/(?:说话期间|这句进行时|保持这个距离|不再移动|不再动)[^。]{0,40}。/gu, '')
    .replace(/这句开始时，刚才的机位结束。/gu, '')
    .replace(/这个画面在这句开始前结束。/gu, '')
    .replace(/When this line starts, that framing ends\.\s*/giu, '')
    .replace(/This view ends before the line\.\s*/giu, '')
    .replace(/\s{2,}/gu, ' ').trim()).filter((part) => part.trim()).join(' ');
  const dropSilenceLabel = (text: string, speaking: boolean): string => {
    const had = /台词\s*[:：]\s*无|Dialogue:\s*none/iu.test(text);
    const stripped = text.replace(/台词\s*[:：]\s*无[。.]?|Dialogue:\s*none[.]?/giu, '').replace(/[ \t]{2,}/gu, ' ').trim();
    if (speaking || !had) return stripped;
    const closed = en ? 'Every visible mouth stays closed.' : '画面里能看见的嘴保持闭合。';
    if (/嘴保持闭合|mouth stays closed|mouths stay closed|Every visible mouth stays closed/iu.test(stripped)) return stripped;
    return `${stripped} ${closed}`.trim();
  };
  const liftBuriedDialogue = (visual: string, shot: H3PerformancePlan['shots'][number]): { before: string; after: string; lines: string[] } => {
    const known = spokenByEvents(shot);
    const lines: string[] = [];
    for (const match of visual.matchAll(/<d>[\s\S]*?<\/d>/gu)) {
      if (known.has(dialogueText(match[0]))) continue;
      const beforeTag = visual.slice(Math.max(0, (match.index ?? 0) - 80), match.index ?? 0);
      const namedMatches = [...beforeTag.matchAll(/((?:[\u3400-\u9fff]{1,8}|[A-Za-z]+)(?:[ ·](?:[\u3400-\u9fff]{1,8}|[A-Za-z]+)){0,3})\s*\(S(\d+)\)/gu)];
      const named = namedMatches[namedMatches.length - 1];
      const who = named?.[1] || (en ? 'The declared voice source' : '已声明声源');
      const token = named ? ` (S${named[2]})` : '';
      const says = `${who}${token} says: ${match[0]}`;
      if (said.has(dialogueText(match[0]))) continue;
      said.add(dialogueText(match[0]));
      const closed = en ? 'The other mouths already in the picture stay closed.' : '画面里其他人的嘴保持闭合。';
      const camera = en
        ? `The camera cuts to a close view of ${who}'s mouth. The authored body action continues.`
        : `镜头切到${who}能看清的嘴，已经写好的身体动作继续。`;
      lines.push([closed, camera, says, en ? 'That mouth closes.' : '这张嘴重新闭合。'].join(en ? ' ' : ''));
    }
    const firstTag = visual.search(/<d>/u);
    const speakingShot = shot.events.some((event) => event.kind === 'speech' && event.channel === 'on-screen') || /<d>/u.test(visual);
    const strip = (text: string): string => {
      const unmarked = outsideDialogue(text, (value) => value.replace(/\s*\(S\d+(?:\s*,\s*S\d+)*\)/gu, ''));
      const framed = speakingShot ? releaseHeldFraming(unmarked) : unmarked;
      return dropSilenceLabel(framed, speakingShot)
        .replace(/<d>[\s\S]*?<\/d>/gu, '')
        .replace(/Her mouth opens and her lips move with the words\.?/giu, '')
        .replace(/[\u3400-\u9fffA-Za-z·]{1,16}\s*\(S\d+\)[^。\n]{0,24}说[:：]\s*$/u, '')
        .replace(/[\u3400-\u9fff]{1,16}说[:：]\s*$/u, '');
    };
    return {
      before: strip(firstTag >= 0 ? visual.slice(0, firstTag) : visual),
      after: strip(firstTag >= 0 ? visual.slice(firstTag) : ''),
      lines,
    };
  };
  plan.shots.forEach((shot, index) => {
    const windowStart = shot.startSec;
    const windowEnd = plan.shots[index + 1]?.startSec;
    const timed = shot.events.filter((event) => (event.startSec ?? windowStart) < windowStart - 0.001);
    if (timed.length) {
      const spans = timed.map((event) => Math.max(0.4, (event.endSec ?? event.startSec ?? windowStart) - (event.startSec ?? windowStart)));
      const available = windowEnd !== undefined ? Math.max(0.4 * timed.length, windowEnd - windowStart) : spans.reduce((sum, span) => sum + span, 0);
      const total = spans.reduce((sum, span) => sum + span, 0) || available;
      const scale = total > available ? available / total : 1;
      let cursor = windowStart;
      timed.forEach((event, eventIndex) => {
        const length = Math.max(0.2, spans[eventIndex] * scale);
        const end = windowEnd === undefined ? cursor + length : Math.min(windowEnd, cursor + length);
        event.startSec = Number(cursor.toFixed(3));
        event.endSec = Number(end.toFixed(3));
        cursor = event.endSec;
      });
    }
    let proseCursor = windowStart;
    const moveRange = (startText: string, endText: string, write: (from: number, to: number) => string): string => {
      const start = Number(startText);
      const end = Number(endText);
      if (!(start < windowStart - 0.001)) return '';
      const span = Math.max(0.2, end - start);
      const room = windowEnd !== undefined ? Math.max(0.2, windowEnd - proseCursor) : span;
      const length = Math.min(span, room);
      const from = proseCursor;
      const to = Number((from + length).toFixed(2));
      proseCursor = to;
      return write(from, to);
    };
    shot.visualDescription = shot.visualDescription
      .replace(/本段\s*(\d+(?:\.\d+)?)\s*[–\-到至]\s*(\d+(?:\.\d+)?)\s*秒/gu, (whole, startText, endText) => moveRange(startText, endText, (from, to) => `本段${from.toFixed(2)}–${to.toFixed(2)}秒`) || whole)
      .replace(/From\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+seconds of this clip/giu, (whole, startText, endText) => moveRange(startText, endText, (from, to) => `From ${from.toFixed(2)} to ${to.toFixed(2)} seconds of this clip`) || whole);
  });
  const shots = plan.shots.map((shot, index) => {
    const marker = `[Shot ${shot.shotIndex}]${index ? ` At ${cutTime(shot.startSec)}` : ''}`;
    const visual = shot.visualDescription.replace(/behind the brain/giu, 'across the back of the head');
    const lifted = liftBuriedDialogue(visual, shot);
    const pose = lowPoseSentence(visual, en);
    const chain = bodyChainSentence(visual, en);
    const hands = bracedHandsSentence(visual, en);
    const shownBefore = authored(lifted.before);
    const shownAfter = authored(lifted.after);
    return [marker, !index ? integratedOpening : '', shownBefore ? sentence(shownBefore, language) : '', pose, chain, hands, ...lifted.lines, ...shot.events.map((event) => renderEvent(event, shot)), shownAfter ? sentence(shownAfter, language) : ''].filter(Boolean).join('\n');
  });
  const body = [fullReference ? preamble : '', ...shots]
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
  const prompt = deduplicateIdentityAnchors(renderH3DeliverySections({ body, subjectDefinitions: definitions.join('\n'),
    summary: /^\[reference generation[^\]]*\]/u.test(summary) ? summary : `[reference generation] ${summary}`,
    retentionAnalysis: retention, overallSoundscape: plan.overallSoundscape, nonDiegeticMusic: plan.nonDiegeticMusic,
  }, { mode: fullReference ? 'full-reference' : 'integrated', language }), renderedCharacters.map((entry) => entry.referenceAnchor));
  return { prompt, body, plan, speakerTokens, characters: renderedCharacters, events };
};
