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
  /** Selected picture style only. Director category is not a picture style. */
  pictureStyle?: string;
  /** Fixed clip length used by the official first/last-frame alignment line. */
  durationSec?: number;
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
/** Color, material, light and texture only. A custom name with no such clauses stays whole. */
export const h3PictureStyleLine = (value: string | undefined, en: boolean): string => {
  const raw = (value || '').trim().replace(/^(?:画面风格|视觉风格|Picture style)\s*[:：]\s*/u, '');
  if (!raw) return '';
  const parts = raw.split(/[；;]/u).map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => /^(?:色彩|材质|光影|质感)\s*[:：]/u.test(part));
  const body = (kept.length ? kept.join('；') : raw).replace(/[。．]\s*$/u, '');
  return en ? `Picture style: ${body}.` : `画面风格：${body}。`;
};
const quoteVisibleText = (text: string): string => text.replace(/<d>[\s\S]*?<\/d>/gu, (block) => `\u0000${block}\u0000`)
  .replace(/(招牌|标牌|字幕|霓虹字?|横幅|标签)([^。\n]{0,16}?)[「『“"]([^」』”"]+)[」』”"]/gu, '$1$2"$3"')
  .replace(/(招牌|标牌|字幕|霓虹字?|横幅|标签)\s*[:：]\s*([^"。\n]{1,24})/gu, '$1: "$2"')
  .replace(/\u0000(<d>[\s\S]*?<\/d>)\u0000/gu, '$1');
const authoredPartFraming = (text: string): boolean => /特写|近景|镜头对着[^。\n]{0,8}(?:嘴|脸|头|腰|腿|臀|髋|下半身)|close-up of|close view of/iu.test(text);
const bodyChainSentence = (text: string, en: boolean): string | undefined => {
  if (!authoredPartFraming(text)) return undefined;
  const chain = en
    ? 'This torso remains connected from these shoulders to these hips. The chest and shoulders remain on this torso when they are outside the top of the frame. The head remains on this neck, the neck remains on these shoulders, each foot remains on its own ankle, and both arms remain on these shoulders.'
    : '这一条躯干从这对肩膀连到这截腰。胸和肩在画面上沿之外，也留在这条躯干上。头留在这截脖子上，脖子留在这对肩膀上。每只脚留在自己的脚踝上。两条手臂留在这对肩膀上。';
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
    ? 'Both palms remain on the support on the side this face points. The forearms run from these shoulders to those palms, the elbows stay outside the ribs, and the fingers stay on the palms.'
    : '双掌留在这张脸所朝一侧的支撑面上，前臂从肩膀连到这双掌，肘留在肋骨外侧，手指留在掌上。';
};
type RearKind = 'entry' | 'follow' | 'hands' | 'door' | 'hold' | 'kiss';
type RearAxis = { actor: string; host: string; kind: RearKind; part?: string };
const escapeName = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** The person who acts and the person who receives it come from one sentence.
 * Character-list order is not a role. A missing role is left unstated. */
const rearAxisOf = (text: string, names: readonly string[]): RearAxis | undefined => {
  const known = names.filter((name) => name).sort((left, right) => right.length - left.length);
  const lastName = (fragment: string): string | undefined => {
    let found: { name: string; index: number } | undefined;
    for (const name of known) {
      const index = fragment.lastIndexOf(name);
      if (index >= 0 && (!found || index > found.index || (index === found.index && name.length > found.name.length))) found = { name, index };
    }
    return found?.name;
  };
  const pronounHost = (sentence: string, actor: string, token: string): string | undefined => {
    if (token !== '她' && token !== '他') return lastName(token);
    const others = known.filter((name) => name !== actor && sentence.includes(name));
    return others.length === 1 ? others[0] : undefined;
  };
  const pair = (actor: string | undefined, host: string | undefined, kind: RearKind): RearAxis | undefined => (
    actor && host && actor !== host ? { actor, host, kind } : undefined
  );
  for (const sentence of text.split(/(?<=[。！？!?\n])/u)) {
    for (const name of known) {
      if (!sentence.includes(name)) continue;
      const fromBehind = sentence.match(new RegExp(`${escapeName(name)}从(她|他|[\\u3400-\\u9fffA-Za-z·]{0,16}?)(?:的)?(?:屁股|臀|背|身)?后`, 'u'));
      const followed = fromBehind ? pair(name, pronounHost(sentence, name, fromBehind[1]), 'entry') : undefined;
      if (followed) return followed;
      const trailing = sentence.match(new RegExp(`${escapeName(name)}(?:跟在|跟着|跟随|留在)(她|他|[\\u3400-\\u9fffA-Za-z·]{1,16}?)(?:的)?(?:身|背)?后`, 'u'));
      const behindLeader = trailing ? pair(name, pronounHost(sentence, name, trailing[1]), 'follow') : undefined;
      if (behindLeader) return behindLeader;
      if (new RegExp(`${escapeName(name)}(?:的)?(?:双手|两手|手掌|手)[^。\\n]{0,8}背后`, 'u').test(sentence)) return { actor: name, host: name, kind: 'hands' };
      if (new RegExp(`${escapeName(name)}站在[^。\\n]{0,6}门后`, 'u').test(sentence)) return { actor: name, host: name, kind: 'door' };
    }
    const waist = sentence.match(/扶在([\u3400-\u9fffA-Za-z·]{1,16})(?:的)?(腰|髋|臀)/u);
    if (waist && !/滑进|滑入|插入|进入|抽插|抽送|抵上/u.test(sentence)) {
      const host = lastName(waist[1]);
      const before = sentence.slice(0, sentence.indexOf(waist[0]));
      const leading = host ? lastName(before) : undefined;
      const others = host ? known.filter((name) => name !== host && sentence.includes(name)) : [];
      const actor = leading && leading !== host ? leading : others.length === 1 ? others[0] : undefined;
      const placed = pair(actor, host, 'hold');
      if (placed) return { ...placed, part: waist[2] === '腰' ? '腰' : '髋' };
    }
    const into = sentence.match(/(?:滑进|滑入|插入|进入|抽插|抽送|抵上)([\u3400-\u9fffA-Za-z·]{1,16})/u);
    if (into && /臀|髋|屁股|腰|阴道|穴|身后|背后|后面/u.test(sentence)) {
      const host = lastName(into[1]);
      const before = sentence.slice(0, sentence.indexOf(into[0]));
      const leading = host ? lastName(before) : undefined;
      const others = host ? known.filter((name) => name !== host && sentence.includes(name)) : [];
      const actor = leading && leading !== host ? leading : others.length === 1 ? others[0] : undefined;
      const placed = pair(actor, host, 'entry');
      if (placed) return placed;
    }
    if (!/滑进|滑入|插入|进入|抽插|抽送|抵上/u.test(sentence)) {
      const hold = sentence.match(/(握住|抓住|按在|扶在)([\u3400-\u9fffA-Za-z·]{1,16})(?:的)?(手腕|手|腰)/u);
      if (hold) {
        const host = lastName(hold[2]);
        const before = sentence.slice(0, sentence.indexOf(hold[0]));
        const leading = host ? lastName(before) : undefined;
        const others = host ? known.filter((name) => name !== host && sentence.includes(name)) : [];
        const actor = leading && leading !== host ? leading : others.length === 1 ? others[0] : undefined;
        const placed = pair(actor, host, 'hold');
        if (placed) return { ...placed, part: hold[3] === '腰' ? '腰' : '手腕' };
      }
      const kiss = sentence.match(/(?:吻上|亲上|嘴唇贴着|嘴贴着)([\u3400-\u9fffA-Za-z·]{1,16})/u);
      if (kiss) {
        const host = lastName(kiss[1]);
        const actor = host ? lastName(sentence.slice(0, sentence.indexOf(kiss[0]))) : undefined;
        const placed = pair(actor, host, 'kiss');
        if (placed) return placed;
      }
    }
  }
  return undefined;
};
const rearAxisSentence = (axis: RearAxis, en: boolean, wide: boolean): string => {
  const actor = axis.actor || (en ? 'The other person' : '另一人');
  const rawHost = axis.host || (en ? 'her' : '她');
  const host = en && (rawHost === '她' || rawHost === 'her') ? 'her' : en && (rawHost === '他' || rawHost === 'him') ? 'him' : rawHost;
  if (axis.kind === 'hands') {
    const who = axis.actor || (en ? 'This person' : '这个人');
    return en
      ? `${who}'s face points one way and ${who}'s back points the opposite way. Both hands remain on the back side of that line.`
      : `${who}的脸朝向一个方向，背朝向相反方向。双手留在这背的这一侧。`;
  }
  if (axis.kind === 'hold') {
    const part = axis.part === '腰' ? '腰' : axis.part === '髋' ? '髋' : '手腕';
    const partEn = part === '腰' ? 'waist' : part === '髋' ? 'hip' : 'wrist';
    return en
      ? `${actor}'s hand remains on ${host}'s ${partEn}. That contact remains on that ${partEn}.`
      : `${actor}的手留在${host}的${part}上。这一下仍留在这${part === '手腕' ? '只手腕' : part === '腰' ? '截腰' : '截髋'}上。`;
  }
  if (axis.kind === 'kiss') {
    return en
      ? `${actor}'s mouth remains on ${host}'s mouth.`
      : `${actor}的嘴留在${host}的嘴上。`;
  }
  if (axis.kind === 'door') {
    const who = axis.actor || (en ? 'This person' : '这个人');
    return en
      ? `${who}'s face points one way. ${who} remains on the opposite side of the door from that face.`
      : `${who}的脸朝向一个方向。${who}留在门朝向这张脸的相反一侧。`;
  }
  const owned = host === 'her' || host === 'him' ? host : `${host}'s`;
  const face = host === 'her' ? 'Her face' : host === 'him' ? 'His face' : `${host}'s face`;
  const together = wide ? (en
    ? ` Both people remain in the frame, from ${actor}'s shoulders to ${actor}'s hips and from ${host === 'her' || host === 'him' ? host : `${host}'s`} face to the hips.`
    : `画面里留着两个人。从${actor}的肩到${actor}的髋，从${host}的脸到${host}的髋，都能看见。`) : '';
  if (axis.kind === 'follow') {
    return en
      ? `${face} points one way and the back points the opposite way. ${actor} remains on the back side of that line, with the chest toward ${owned} back and the face toward the back of the head.${together}`
      : `${host}的脸朝向一个方向，背朝向相反方向。${actor}留在${host}背的这一侧，胸口对着${host}的背，脸对着${host}的后脑。${together}`;
  }
  return en
    ? `${face} points one way and the hips point the opposite way. ${actor} remains on the hip side of that line. ${actor}'s penis enters from behind ${host}'s hips and remains inside ${host}'s vagina. During each thrust, that penis remains inside that vagina. ${actor}'s chest stays toward the back, and ${actor}'s face stays toward the back of the head.${together}`
    : `${host}的脸朝向一个方向，髋朝向相反方向。${actor}留在${host}髋的这一侧，从${host}屁股后面进入，${actor}的阴茎留在${host}的阴道里。前后抽送时，${actor}的阴茎仍留在这阴道里。${actor}的胸口对着${host}的背，脸对着${host}的后脑。${together}`;
};
const lowPoseSentence = (text: string, en: boolean): string | undefined => (
  /床底|桌下|柜内|柜里|门后|躲|钻进|藏在|趴在|伏在/u.test(text)
    ? (en
      ? 'The torso remains below the covering, knees and hips bent. The person does not stand or lie on top of it.'
      : '躯干留在遮挡物下面，膝和髋是弯的，不在遮挡物上面站直或躺平。')
    : undefined
);
const scoreMention = /配乐|背景音乐|非叙事音乐|音乐|伴奏|鼓点|旋律|配器|乐器|节拍|弦乐|钢琴|吉他|BGM|underscore|soundtrack|non-diegetic|\bpiano\b|\bviolin\b|\bstrings\b|\borchestra\b|\bguitar\b|\bscore\b|\bmusic\b|no music|no bgm|不要配乐|禁止配乐|不要背景音乐|without music|without a score|without bgm/iu;
const diegeticMusic = /收音机|广播|哼唱|哼着|现场演奏|在唱|唱歌|歌声|弹琴|拉琴|吹奏|\bradio\b|\bhums?\b|\bsinging\b|plays the/iu;
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
    return Boolean(visible) && !(scoreMention.test(visible) && !diegeticMusic.test(visible));
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
    for (const shot of plan.shots) {
      shot.visualDescription = dropUnauthorizedScore(shot.visualDescription);
      for (const event of shot.events) {
        if (event.kind === 'visual') {
          event.description = dropUnauthorizedScore(event.description);
          if (event.soundDescription) event.soundDescription = dropUnauthorizedScore(event.soundDescription);
        } else if (event.kind === 'speech' && event.speakerAction) event.speakerAction = dropUnauthorizedScore(event.speakerAction);
        else if (event.kind === 'vocal') event.vocalDescription = dropUnauthorizedScore(event.vocalDescription);
      }
    }
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
  const pairedHandsSentence = (visual: string, shot: H3PerformancePlan['shots'][number]): string | undefined => {
    const involved = unique(shot.events.flatMap((event) => [
      ...('speakerCharacterIds' in event ? event.speakerCharacterIds : []),
      ...('listenerCharacterIds' in event ? event.listenerCharacterIds || [] : []),
      ...('silentCharacterIds' in event ? event.silentCharacterIds || [] : []),
      ...('reactions' in event ? (event.reactions || []).map((reaction) => reaction.characterId) : []),
    ]));
    const named = input.characters.filter((entry) => entry.name && visual.includes(entry.name)).map((entry) => entry.characterId);
    const people = unique([...involved, ...named]);
    if (people.length < 2 || !/手|掌|扶|摸|抱|贴|握|按|腰|胸|背|髋|臀|hands|palms|hold|touch|waist|chest|\bback\b|hip/iu.test(visual)) return undefined;
    const [first, second] = people.slice(0, 2).map(name);
    return en
      ? `${first}'s hands remain on ${first}'s wrists. ${second}'s hands remain on ${second}'s wrists.`
      : `${first}的双手留在${first}的手腕上，${second}的双手留在${second}的手腕上。`;
  };
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
  let shotRear = false;
  let shotMouthCloseUp = false;
  const cutToMouth = (ids: readonly string[], listeners: readonly string[]): string => {
    const who = names(ids);
    const framing = shotMouthCloseUp
      ? (en
        ? `The camera shows a readable view of ${who}'s mouth. This torso remains connected from these shoulders to these hips.`
        : `镜头能看清${who}的嘴。这条躯干仍从这对肩膀连到这截腰。`)
      : '';
    const facing = !shotRear && listeners.length
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
  const joinSpoken = (parts: string[]): string => parts.reduce((acc, part, index) => {
    if (!index) return part;
    const prev = parts[index - 1];
    const afterLine = prev.endsWith('</d>');
    if (afterLine) return `${acc}\n${part}`;
    if (en) return `${acc} ${part}`;
    return `${acc}${part}`;
  }, '');
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
      if (!unseen) output.push(cutToMouth(event.speakerCharacterIds, listenerIds));
      const preface = voicePreface(event.speakerCharacterIds);
      const comma = preface ? (en ? ',' : '，') : '';
      output.push(`${time(event)}${speakers}${preface}${comma}${en ? ' ' : ''}${verb}: ${dialogue}`);
      said.add(event.text.trim());
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
      output.push(en ? 'That mouth stays closed.' : '这张嘴保持闭合。');
    }
    const rendered = joinSpoken(output);
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
      said.add(dialogueText(match[0]));
      const closed = en ? 'The other mouths already in the picture stay closed.' : '画面里其他人的嘴保持闭合。';
      const camera = authoredPartFraming(visual) && /嘴|mouth/iu.test(visual)
        ? (en
          ? `The camera shows a readable view of ${who}'s mouth. This torso remains connected from these shoulders to these hips.`
          : `镜头能看清${who}的嘴。这条躯干仍从这对肩膀连到这截腰。`)
        : '';
      lines.push([closed, camera, says].filter(Boolean).join(en ? ' ' : ''));
      lines.push(en ? 'That mouth stays closed.' : '这张嘴保持闭合。');
    }
    const firstTag = visual.search(/<d>/u);
    const speakingShot = shot.events.some((event) => event.kind === 'speech' && event.channel === 'on-screen') || /<d>/u.test(visual);
    const spokenLines = shot.events.filter((event) => event.kind === 'speech').map((event) => event.text.trim()).filter(Boolean);
    const dropRetoldLine = (value: string): string => {
      if (!spokenLines.length) return value;
      return value.split(/(?<=[。！？])/u).filter((part) => {
        const compact = part.replace(/\s/gu, '');
        return !spokenLines.some((line) => {
          const words = line.replace(/\s/gu, '');
          return Boolean(words) && (compact.includes(`说：${words}`) || compact.includes(`说:${words}`) || compact.includes(`说道：${words}`) || compact === words || compact === `${words}。`);
        });
      }).join('');
    };
    const strip = (text: string): string => {
      const unmarked = outsideDialogue(text, (value) => value.replace(/\s*\(S\d+(?:\s*,\s*S\d+)*\)/gu, ''));
      const framed = speakingShot ? releaseHeldFraming(unmarked) : unmarked;
      return dropRetoldLine(dropSilenceLabel(framed, speakingShot))
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
  });
  const clipEnd = Number.isFinite(input.durationSec) && (input.durationSec || 0) > 0 ? Number(input.durationSec) : undefined;
  if (clipEnd) {
    const timedEvents = plan.shots.flatMap((shot) => shot.events.filter((event) => event.startSec !== undefined || event.endSec !== undefined));
    const lastSpoken = Math.max(0, ...timedEvents.map((event) => event.endSec ?? event.startSec ?? 0));
    if (lastSpoken > clipEnd + 0.001) {
      const scale = clipEnd / lastSpoken;
      for (const event of timedEvents) {
        if (event.startSec !== undefined) event.startSec = Number((event.startSec * scale).toFixed(3));
        if (event.endSec !== undefined) event.endSec = Number((Math.min(clipEnd, event.endSec * scale)).toFixed(3));
      }
      for (const shot of plan.shots) {
        shot.visualDescription = shot.visualDescription
          .replace(/本段\s*(\d+(?:\.\d+)?)\s*[–\-到至]\s*(\d+(?:\.\d+)?)\s*秒/gu, (_whole, startText, endText) => {
            const from = Math.min(clipEnd, Number(startText) * scale);
            const to = Math.min(clipEnd, Number(endText) * scale);
            return `本段${from.toFixed(2)}–${to.toFixed(2)}秒`;
          })
          .replace(/From\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+seconds of this clip/giu, (_whole, startText, endText) => {
            const from = Math.min(clipEnd, Number(startText) * scale);
            const to = Math.min(clipEnd, Number(endText) * scale);
            return `From ${from.toFixed(2)} to ${to.toFixed(2)} seconds of this clip`;
          });
      }
    }
  }
  plan.shots.forEach((shot, index) => {
    const windowStart = shot.startSec;
    const windowEnd = plan.shots[index + 1]?.startSec;
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
  let carriedRear: RearAxis | undefined;
  const styleLine = h3PictureStyleLine(input.pictureStyle, en);
  const pictureStyle = !keepScore ? dropUnauthorizedScore(styleLine) : styleLine;
  if (pictureStyle && plan.shots[0] && !/画面风格|Picture style/u.test(plan.shots[0].visualDescription)) {
    plan.shots[0].visualDescription = `${pictureStyle}${plan.shots[0].visualDescription}`;
  }
  const shots = plan.shots.map((shot, index) => {
    const marker = `[Shot ${shot.shotIndex}]${index ? ` At ${cutTime(shot.startSec)}` : ''}`;
    const visual = quoteVisibleText(shot.visualDescription).replace(/behind the brain/giu, 'across the back of the head');
    const eventText = shot.events.map((event) => [
      event.kind === 'visual' ? event.description : '',
      'speakerAction' in event ? event.speakerAction || '' : '',
    ].join(' ')).join('\n');
    const corpus = `${visual}\n${eventText}`;
    const detectedRear = rearAxisOf(corpus, input.characters.map((entry) => entry.name));
    const faceToFace = /面对面|对视|走到[^。\n]{0,8}面前|face each other/iu.test(corpus);
    const closerBody = /近景|特写|臀|髋|屁股|\bhips?\b|\bbutt/iu.test(corpus);
    const bothNamed = Boolean(carriedRear?.actor && carriedRear.host && corpus.includes(carriedRear.actor) && corpus.includes(carriedRear.host));
    const axis = detectedRear || (!faceToFace && carriedRear && (closerBody || bothNamed) ? carriedRear : undefined);
    if (detectedRear) carriedRear = detectedRear;
    else if (faceToFace) carriedRear = undefined;
    shotRear = Boolean(axis && (axis.kind === 'entry' || axis.kind === 'follow'));
    shotMouthCloseUp = authoredPartFraming(visual) && /嘴|mouth/iu.test(visual);
    const lifted = liftBuriedDialogue(visual, shot);
    const pose = lowPoseSentence(visual, en);
    const chain = bodyChainSentence(visual, en);
    const hands = bracedHandsSentence(visual, en);
    const pairedHands = pairedHandsSentence(visual, shot);
    const axisLine = axis ? rearAxisSentence(axis, en, !authoredPartFraming(visual)) : '';
    const mouthsQuiet = (input.characters.some((entry) => entry.name && visual.includes(entry.name)) || shot.events.some((event) => event.kind === 'speech'))
      ? (en ? 'When nobody is speaking a line, the mouths in the frame stay closed.' : '没有人说台词时，画面里的嘴保持闭合。')
      : '';
    const shownBefore = authored(lifted.before);
    const shownAfter = authored(lifted.after);
    return [marker, !index ? integratedOpening : '', shownBefore ? sentence(shownBefore, language) : '', mouthsQuiet, pose, chain, hands, pairedHands, axisLine, ...lifted.lines, ...shot.events.map((event) => renderEvent(event, shot)), shownAfter ? sentence(shownAfter, language) : ''].filter(Boolean).join('\n');
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
  const duration = Number.isFinite(input.durationSec) ? Math.max(0, input.durationSec || 0)
    : Math.max(0, ...plan.shots.map((shot) => shot.startSec), ...plan.shots.flatMap((shot) => shot.events.map((event) => event.endSec ?? event.startSec ?? 0)));
  const firstFrame = (input.pictureUses || []).find((use) => use.role === 'first-frame');
  const lastFrame = (input.pictureUses || []).find((use) => use.role === 'last-frame');
  const shotCount = plan.shots.length || 1;
  const end = duration.toFixed(2);
  const alignment = fullReference ? '' : firstFrame && lastFrame
    ? `How the reference pictures align with the target video — Picture ${firstFrame.number} (from Shot 1) aligns with the 0.00-second mark of the target video; Picture ${lastFrame.number} (from Shot ${shotCount}) aligns with the ${end}-second mark of the target video.`
    : firstFrame
      ? `For the target video, at 0.00 seconds into the target video, <Picture ${firstFrame.number}> (from [Shot 1]) is fully referenced.`
      : lastFrame
        ? `How the reference pictures align with the target video — <Picture ${lastFrame.number}> (from [Shot ${shotCount}]) aligns with the ${end}-second mark of the target video.`
        : '';
  const prompt = deduplicateIdentityAnchors(renderH3DeliverySections({ body, subjectDefinitions: definitions.join('\n'),
    summary: /^\[reference generation[^\]]*\]/u.test(summary) ? summary : `[reference generation] ${summary}`,
    retentionAnalysis: retention, overallSoundscape: plan.overallSoundscape, nonDiegeticMusic: plan.nonDiegeticMusic,
  }, { mode: fullReference ? 'full-reference' : 'integrated', language }), renderedCharacters.map((entry) => entry.referenceAnchor));
  return { prompt: alignment ? `${alignment}\n\n${prompt}` : prompt, body, plan, speakerTokens, characters: renderedCharacters, events };
};
