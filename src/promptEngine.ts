import type {
  AiStoryboardPlan,
  Character,
  ConverterPreset,
  GridVisualState,
  InputMode,
  Location,
  Pace,
  Prop,
  ReferenceAsset,
  RuleSet,
  Scene,
  ShotRecommendation,
  Storyboard,
  StylePreset,
  PromptValidationReport,
  ImageVariant,
  NsfwPrivatePart,
  VideoShot,
  Workflow
} from './types';
import { createId } from './storage';
import { getImageVariantGenerationSpec, imagePromptOutputSpecificationRule, resolveExplicitImageCharacterMorphology, type ImagePromptOutputSpecification } from './imageGeneration';
import { buildLandscapeImageSource, isLandscapeImageRequest } from './imageLocationScope';
import {
  classifyQuotedSpeechContext,
  cleanSourceSpeechSpeakerCandidate,
  extractSemanticStoryBeats,
  hasNarrativeFirstPersonActor,
  resolveFirstPersonSubject,
  resolveNarrativeFirstPersonObjectActor,
  rewriteNarrativeFirstPersonReferences,
  semanticActionsEquivalent,
  SOURCE_SPEECH_CUE_PATTERN,
} from './semanticEvents';
import { extractStoryBeats } from './storySegmentation';
import {
  hasNsfwDetailSignal,
  sanitizeNsfwGenerationControls,
  stripAutomaticAgeMetadata,
} from './promptConstraints';
import { resolveVisualStylePrompt } from './visualStyles';
import { assertCanonicalPromptRelativeSoundCueTimes, canonicalDialogueField, protectedTextQuoteSpans, topLevelCanonicalFieldLocations } from './masterTimeline';
import { normalizeShotAmbientSound } from './audioPromptPolicy';
import { normalizeStoryboardSubject, storyboardSubjectValidationError } from './storyboardSubject';
import {
  hasExplicitClothingStateChange,
  inferNsfwShotContinuityState,
  resolveNsfwShotContinuityBoundaries,
  type NsfwShotContinuityState,
  type NsfwShotContinuityBoundary,
} from './continuity';
import { isNsfwPrivateProfileAsset } from './nsfwPrivateAssets';
import { publicVideoContinuityLock } from './videoPrivateScope';
import {
  getMorphologyPromptLocks,
} from './characterMorphology';
import {
  characterVariantAliases,
  characterVariantBaseName,
  characterVariantDisplayName,
  characterVariantFormLabel,
  characterVariantMatches,
  characterVariantPromptFacts,
} from './characterVariants';
import { normalizeFemaleCharacterVocabularyRecord } from './characterVocabulary';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export const workflowLabels: Record<Workflow, string> = {
  drama: '智能叙事',
  action: '智能动作',
  grid: '九宫格'
};

export interface DirectorDecision {
  workflow: 'drama' | 'action';
  reason: string;
  actionScore: number;
  narrativeScore: number;
}

/**
 * Decide the internal converter from the actual story and the user's extra
 * direction.  The UI never asks the user to label a scene as 文戏 or 武戏;
 * those are implementation rules selected from observable story signals.
 */
export const inferDirectorWorkflow = (story: string, extra = ''): DirectorDecision => {
  const text = `${story}\n${extra}`.replace(/\s+/g, ' ').trim();
  const actionWords = [
    '战斗', '交手', '打斗', '搏斗', '追击', '追逐', '冲向', '拔剑', '挥剑', '出拳', '开枪',
    '爆炸', '闪避', '格挡', '砍', '刺', '劈', '踢', '撞', '坠落', '厮杀', '突袭', '奔跑',
    '翻滚', '破门', '逃亡', '动作', '高速', '攻防', '决斗', '战役', '混战', '爆破'
  ];
  const narrativeWords = [
    '对视', '沉默', '低声', '说', '问', '回答', '承认', '拒绝', '原谅', '背叛', '告别',
    '秘密', '回忆', '犹豫', '决定', '等待', '信', '敲门', '抬眼', '凝视', '情绪', '关系',
    '谈判', '误会', '和解', '离开', '发现', '真相', '对白', '独白', '克制'
  ];
  const score = (words: string[]) => words.reduce((sum, word) => sum + (text.includes(word) ? Math.min(3, Math.max(1, Math.floor(text.split(word).length - 1))) : 0), 0);
  const actionScore = score(actionWords);
  const narrativeScore = score(narrativeWords);
  const workflow = actionScore > narrativeScore + 1 ? 'action' : 'drama';
  const reason = workflow === 'action'
    ? `剧情识别到${actionScore}个动作/空间变化信号，智能导演将提高动作密度、切点清晰度和受力结果。`
    : `剧情识别到${narrativeScore}个关系/情绪变化信号，智能导演将优先保证表演、信息触发和行为结果。`;
  return { workflow, reason, actionScore, narrativeScore };
};

export const inputModeLabels = {
  text: '纯文字',
  reference: '单张/多张参考图',
  text_reference: '图片 + 故事'
} as const;

export const paceLabels: Record<Pace, string> = {
  slow: '舒缓',
  standard: '标准',
  tight: '紧凑',
  fast: '高速'
};

const tokenizeStory = (content: string): string[] => content
  .replace(/\r/g, '')
  // Keep closing quotation marks with the spoken sentence so dialogue is not
  // torn into `“line` and `”next action` across adjacent shots.
  .split(/\n{2,}|(?<=[。！？!?][”"』])|(?<=[。！？!?])(?![”"』])/u)
  .map((item) => item.replace(/^\s*(?:[-*#]|第[一二三四五六七八九十百千0-9]+[章节回].*?)\s*/u, '').trim())
  .filter((item) => item.length >= 5);

/** Prompt generation and duration estimation share this semantic event source.
 * Adjacent paraphrases are one event; punctuation alone can never add a beat. */
const tokenizeActionBeats = (content: string): string[] => {
  const unique: string[] = [];
  extractSemanticStoryBeats(content).forEach((beat) => {
    const text = beat.text.replace(/[。！？!?，；;,.]+$/u, '').trim();
    if (!text) return;
    if (unique.length && semanticActionsEquivalent(unique[unique.length - 1], text)) return;
    unique.push(text);
  });
  return unique;
};

const uniqueByName = <T extends { name: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.name.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const CHARACTER_ROLE_PATTERN = /(?:主角|少年|少女|男人|女人|男子|女子|掌柜|剑客|刺客|将军|姑娘|师兄|师姐|师父|公子|小姐|守卫)/gu;
const LOCAL_CHARACTER_CUE_PATTERN = /(?:正在|缓缓|缓慢|慢慢|迅速|快速|突然|立刻|位于|躺在|坐在|站在|落后|停(?=在|下|住|留)|走(?=在|到|进|向|去|来|开|过)|抱(?=在|着|住)|挡(?=在|住|下|开)|取出|清点|横跨|在|仰卧|俯卧|侧卧|躺下|坐下|跪下|说|问|喊|抬头|低头|看向|望向|朝着|朝向|走到|走进|走向|跑向|转身|回头|低声|冷笑|沉默|拔剑|举枪|挥拳|冲向|扑向|脱泳装|脱衣|脱下|脱掉|摘下|穿上|屈膝|弯腰|俯身|掰开|扒开|露出|漏出)/u;
const LOCAL_CHARACTER_CONTEXT_PREFIX = /^(?:(?:清晨|凌晨|早晨|上午|中午|下午|傍晚|黄昏|夜晚|深夜|此时|这时|随后|然后|接着|镜头中|画面中)[，,：:\s]*)+/u;
const INVALID_LOCAL_CHARACTER_NAME = /^(?:我|我们|咱们|我方|你|你们|您|他|她|它|祂|他们|她们|它们|有人|一人|众人|大家|故事|剧情|画面|镜头|场景|环境|身体|目光|视线|声音|光线|阳光|雨水|风声|夜色|弯腰|俯身|起身|转身|回头|抬头|低头|伸手|屈膝|仰卧|俯卧|侧卧|躺下|坐下|跪下|脱泳装|脱衣|脱下|脱掉|摘下|穿上|掰开|扒开|分开|并拢|合拢|露出|显露|漏出|双腿|双手)$/u;
const INVALID_LOCAL_CHARACTER_PREFIX = /^(?:我|我们|咱们|我方|你|你们|您|他|她|它|祂|他们|她们|它们|一部分|另一部分|那群|这些|那些|不过|但是|然而|于是|因为|虽然|原本|就在|刚才|此刻|整个|更别|将(?!军))/u;
const INVALID_LOCAL_CHARACTER_FRAGMENT = /(?:就|将|都|仍|也|又|已|正|才|便|却|还|再|更|最|堵|伫立)$/u;
const INVALID_LOCAL_CHARACTER_SUBJECT_PREFIX = /^(?:没有|无|用|以|把|被|让|给|从|由|沿着|顺着|朝着|朝|向|往|面容|脸庞|目光|视线|眼神|眼眸|瞳孔|指尖|手指|手掌|双手|手臂|小臂|肩背|身子|身体|衣袖|袖中|街面|街道|道路|地面|摊位|光线|灯光|声音)/u;
const INVALID_LOCAL_CHARACTER_OBJECT_SUFFIX = /(?:纸|符|剑|刀|枪|鞘|针|瓶|罐|盒|灯|石|砂|门|窗|桌|椅|衣|袖|鞋|靴|绳|牌|秤)$/u;
const LOCAL_CHARACTER_NAME_SHAPE = /^[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·]{1,11}$/u;

const extractNames = (content: string): string[] => {
  const roleCandidates = content.match(CHARACTER_ROLE_PATTERN) || [];
  const namedCandidates = content
    .split(/[，,。！？!?；;\n]/u)
    .flatMap((rawClause) => {
      const clause = rawClause.replace(/^[“”"'‘’「」『』\s]+/u, '').trim();
      if (INVALID_LOCAL_CHARACTER_PREFIX.test(clause)) return [];
      const cueIndex = clause.search(LOCAL_CHARACTER_CUE_PATTERN);
      if (cueIndex <= 0) return [];
      let prefix = clause.slice(0, cueIndex)
        .replace(LOCAL_CHARACTER_CONTEXT_PREFIX, '')
        .replace(/^(?:一名|一位|一个|这名|这位|这个)/u, '')
        .replace(/(?:一起|同时)$/u, '')
        .trim();
      if (prefix.includes('的')) {
        const describedName = prefix.match(/^(?:年轻|中年|年迈)的(.+)$/u)?.[1]?.trim() || '';
        if (!describedName) return [];
        prefix = describedName;
      }
      return prefix
        .split(/\s*(?:与|和|及|、|&)\s*/u)
        .map((candidate) => candidate
          .replace(/^(?:年轻|中年|年迈)/u, '')
          .replace(/^(?:主角|少年|少女|男人|女人|男子|女子|掌柜|剑客|刺客|将军|姑娘|师兄|师姐|师父|公子|小姐|守卫)(?=.{2,}$)/u, '')
          .trim())
        .filter((candidate) => (
          LOCAL_CHARACTER_NAME_SHAPE.test(candidate)
          && !INVALID_LOCAL_CHARACTER_NAME.test(candidate)
          && !INVALID_LOCAL_CHARACTER_FRAGMENT.test(candidate)
          && !INVALID_LOCAL_CHARACTER_SUBJECT_PREFIX.test(candidate)
          && !INVALID_LOCAL_CHARACTER_OBJECT_SUFFIX.test(candidate)
        ));
    });
  const standaloneRoleCandidates = roleCandidates.filter((role) => (
    !namedCandidates.some((name) => content.includes(`${role}${name}`))
  ));
  const firstPersonSubject = hasNarrativeFirstPersonActor(content, namedCandidates)
    ? resolveFirstPersonSubject(content, namedCandidates)
    : '';
  const candidates = [firstPersonSubject, ...standaloneRoleCandidates, ...namedCandidates]
    .filter(Boolean);
  return uniqueByName(candidates.map((name) => ({ name: name.replace(/[“”"：:]/g, '') })))
    .map((item) => item.name)
    .slice(0, 8);
};

const LOCAL_LOCATION_NOUN = /(?:市|城|区|防区|环线|号线|集市|市场|摊|摊位|巷|巷口|街|长街|路|道路|院|院子|院落|庭院|房|房间|屋|室|厅|堂|殿|寺|庙|塔|桥|门|港|港口|码头|广场|车站|站台|山|山谷|树林|林间|河岸|湖边|海边|床上)$/u;
const normalizeLocalLocationCandidate = (value: string): string => {
  const source = value.replace(/^[“"']|[”"']$/gu, '').trim();
  const genericPrefix = source.match(/^(?:一处|一座|一间|一个|一片|一条|这处|这座|这间|这个|那处|那座|那间|那个)/u)?.[0] || '';
  const withoutPrefix = source.slice(genericPrefix.length).replace(/(?:方向)$/u, '').trim();
  return genericPrefix
    ? withoutPrefix.replace(/(?<=(?:摊|摊位|店|铺|馆|楼|院|房|屋|厅|堂|殿|寺|庙|塔|桥|门|巷|街|路))(?:前|后|旁|边|附近)$/u, '')
    : withoutPrefix;
};

const isConcreteLocalLocation = (value: string): boolean => {
  const core = value.replace(/(?:前|后|旁|边|里|内|外|附近)$/u, '');
  return LOCAL_LOCATION_NOUN.test(value) || LOCAL_LOCATION_NOUN.test(core);
};

const findLocationName = (content: string): string => {
  const explicitMatch = content.match(
    /(?:位于|来到|走进|进入|进了|离开|回到|奔赴|赶去|朝着|朝向|直奔|揉碎了|笼罩着|覆盖了|整个|就在|在)\s*[“"']*((?:[\p{L}\p{N}·]{1,8}?(?:市|城)|[\p{L}\p{N}·]{2,8}?区|(?:\d{1,4}号|第?\d{1,4})防区|[\p{L}\p{N}·]{1,8}?环线|[\p{L}\p{N}·]{1,8}?号线))/u,
  );
  if (explicitMatch?.[1]) return explicitMatch[1].trim();

  const relativeMatches = content.matchAll(
    /(?:在|位于|来到|走进|进入|离开|回到)\s*([^，。！？\s]{1,12}?)(?=(?:正在|全裸|裸体|裸露|赤裸|一丝不挂|躺|坐|站|走|跑|等待|停留|脱|摘|穿|屈膝|弯腰|俯身|仰卧|俯卧|侧卧|露出|漏出|拔剑|拔刀|拔出|举剑|挥剑|看|说|问|喊|[，。！？\s]|$))/gu,
  );
  const temporalOrGeneric = /^(?:刚才|方才|此前|之前|之后|随后|现在|当前|此刻|当时|这里|那里|这儿|那儿|战区|区域|地区)$/u;
  for (const match of relativeMatches) {
    const candidate = normalizeLocalLocationCandidate(match[1] || '');
    if (
      candidate
      && !temporalOrGeneric.test(candidate)
      && isConcreteLocalLocation(candidate)
    ) return candidate;
  }

  const directedMatches = content.matchAll(
    /(?:朝着|朝向|朝|走向|跑向|转向|面向|往|向)\s*([^，。！？\s]{1,12}?)(?=(?:方向)?(?:走|跑|去|前进|移动|[，。！？\s]|$))/gu,
  );
  for (const match of directedMatches) {
    let candidate = normalizeLocalLocationCandidate(match[1] || '');
    if (!candidate || temporalOrGeneric.test(candidate) || !isConcreteLocalLocation(candidate)) continue;
    if (/巷$/u.test(candidate)) candidate = `${candidate}口`;
    const preceding = content.slice(0, match.index || 0);
    const directions = Array.from(preceding.matchAll(/(?:往|朝着?|向)(东|西|南|北)(?:侧|边|面|方)?/gu));
    const direction = directions.length ? directions[directions.length - 1][1] : '';
    if (direction && !/^[东西南北](?:侧|边|面|方)/u.test(candidate)) {
      candidate = `${direction}侧${candidate}`;
    }
    return candidate;
  }
  return '';
};

const buildSummary = (content: string): string => {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= 110) return compact;
  return `${compact.slice(0, 108)}…`;
};

export interface LocalAnalysis {
  summary: string;
  beatCount: number;
  eventKeywords: string[];
  characterNames: string[];
  locationName: string;
}

export const analyzeTextLocally = (content: string): LocalAnalysis => {
  const semanticBeats = tokenizeActionBeats(content);
  const keywords = ['发现', '看见', '敲门', '拔剑', '追击', '受击', '转身', '停下', '抬头', '回头', '交出', '拒绝', '承认', '离开', '爆炸', '倒下', '吹灭', '开火', '冲向']
    .filter((word) => content.includes(word));
  return {
    summary: buildSummary(content),
    beatCount: Math.max(1, semanticBeats.length),
    eventKeywords: keywords,
    characterNames: extractNames(content),
    locationName: findLocationName(content)
  };
};

export const splitIntoScenes = (content: string): Array<{ title: string; content: string; summary: string }> => {
  const source = content.trim();
  if (!source) return [];
  const blocks = source
    .replace(/\r/g, '')
    .split(/\n\s*\n|(?=^第[一二三四五六七八九十百千0-9]+[章节回])/gmu)
    .map((item) => item.trim())
    .filter(Boolean);
  const usable = blocks.length > 1 ? blocks : tokenizeStory(source).reduce<string[]>((acc, item, index) => {
    const group = Math.floor(index / 3);
    acc[group] = `${acc[group] ? `${acc[group]} ` : ''}${item}`;
    return acc;
  }, []);
  return usable.map((block, index) => ({
    title: block.match(/^第[^\s，。]{1,12}[章节回]/u)?.[0] || `场景 ${index + 1}`,
    content: block,
    summary: buildSummary(block)
  }));
};

const formatSeconds = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  if (value < 0.1) return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (value < 1) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(1);
};

const DIALOGUE_LEAD_SEC = 0.18;
const DIALOGUE_TAIL_SEC = 0.28;
const DIALOGUE_CHARS_PER_SEC = 4.5;

const QUOTED_SPAN_PATTERN = /(?:“([^”\r\n]+)”|‘([^’\r\n]+)’|「([^」\r\n]+)」|『([^』\r\n]+)』|"([^"\r\n]+)")/gu;
const SPEECH_CUE_TAIL = new RegExp(`${SOURCE_SPEECH_CUE_PATTERN}[：:，,。！？!?\\s]*$`, 'u');
const SPEAKER_NAME_SOURCE = '[\\u4e00-\\u9fffA-Za-z0-9·]{2,12}?';
const SPEAKER_CUE_TAIL = new RegExp(
  `(?:^|[，,。！？!?；;”"’」』]\\s*)(${SPEAKER_NAME_SOURCE})(?:在[^，,。！？!?；;]{1,24})?(?:(?:对|朝着|朝|向)${SPEAKER_NAME_SOURCE})?${SOURCE_SPEECH_CUE_PATTERN}[：:，,。！？!?\\s]*$`,
  'u',
);
const SPEAKER_CUE_HEAD = new RegExp(
  `^[”"’，,。！？!?\\s]*(${SPEAKER_NAME_SOURCE})(?:在[^，,。！？!?；;]{1,24})?(?:(?:对|朝着|朝|向)${SPEAKER_NAME_SOURCE})?${SOURCE_SPEECH_CUE_PATTERN}`,
  'u',
);

export interface SourceDialogue {
  text: string;
  speakerCandidate: string;
  /** Original UTF-16 utterance span (including outer quotes when present). */
  sourceStart: number;
  sourceEnd: number;
}

const cleanSpeechSpeakerCandidate = cleanSourceSpeechSpeakerCandidate;

const NON_DIALOGUE_FIELD = /^(?:场景\d*|场次|场景名|时间|地点|位置|环境|背景|背景信息|剧情|故事|原文|小说|描述|动作|镜头|光影|声音|音效|配乐|人物|角色|出场人物|任务|目标|要求|说明|提示|标题|名称|名字|代号|台词|对白|原对白|字幕|文字|标牌|招牌|标签|caption|label|title|scene|location|time|action|description)$/iu;
const labeledDialogueSpeaker = (prefix: string): string => {
  const match = prefix.match(/(?:^|[\n，,。！？!?；;”"’」』])\s*@?([\p{L}\p{N}_·•-]{1,24})(?:[（(][^\n（）()]{1,24}[）)])?\s*[：:]\s*$/u);
  const candidate = cleanSpeechSpeakerCandidate(match?.[1] || '');
  return NON_DIALOGUE_FIELD.test(candidate) ? '' : candidate;
};

/** One source of truth for novel speech and prepared speaker-labelled lines.
 * Never trim inside an utterance, deduplicate repeats, or turn signs into speech. */
export const extractSourceDialogues = (value: string): SourceDialogue[] => {
  // Prepared prose may put the first speaker after “对白：” on the same line.
  // Mask only that envelope, preserving UTF-16 offsets and every spoken word.
  const source = String(value || '').replace(
    /^[\t ]*(?:对白|台词|原对白)[：:][\t ]*(?=@?[\p{L}\p{N}_·•-]{1,24}(?:[（(][^()（）\r\n]*[）)])?\s*[:：])/gmu,
    (prefix) => ' '.repeat(prefix.length),
  );
  const dialogues: SourceDialogue[] = [];
  let previousDialogueEnd = -1;
  let previousSpeaker = '';
  for (const match of source.matchAll(QUOTED_SPAN_PATTERN)) {
    const text = match.slice(1).find((part) => typeof part === 'string') || '';
    if (!text.trim() || match.index === undefined) continue;
    const quoteEnd = match.index + match[0].length;
    const context = classifyQuotedSpeechContext(
      source,
      match.index,
      quoteEnd,
      previousDialogueEnd,
      previousSpeaker,
    );
    const prefix = source.slice(0, match.index);
    const labeledSpeaker = SPEECH_CUE_TAIL.test(prefix) ? '' : labeledDialogueSpeaker(prefix);
    if (!context.isDialogue && !labeledSpeaker) {
      previousDialogueEnd = -1;
      previousSpeaker = '';
      continue;
    }
    const continuesSpeaker = previousDialogueEnd >= 0
      && /^[\s，,。！？!?；;：:]*$/u.test(source.slice(previousDialogueEnd, match.index));
    const speakerCandidate = labeledSpeaker
      || (continuesSpeaker ? previousSpeaker : '')
      || context.speakerCandidate;
    dialogues.push({ text, speakerCandidate, sourceStart: match.index, sourceEnd: quoteEnd });
    previousDialogueEnd = quoteEnd;
    previousSpeaker = speakerCandidate;
  }
  // Bare dialogue is accepted only on its own speaker-labelled line. Keeping
  // the line boundary avoids absorbing later narration as additional speech.
  for (const match of source.matchAll(/^[\t ]*@?([\p{L}\p{N}_·•-]{1,24})(?:[（(][^\n（）()]{1,24}[）)])?[\t ]*[：:][\t ]*([^\r\n]+)$/gmu)) {
    const speakerCandidate = cleanSpeechSpeakerCandidate(match[1]);
    const text = match[2].trimEnd();
    if (!text || NON_DIALOGUE_FIELD.test(speakerCandidate) || /^[“‘「『"]/u.test(text)) continue;
    const sourceStart = match.index! + match[0].lastIndexOf(match[2]);
    const sourceEnd = sourceStart + text.length;
    if (dialogues.some((dialogue) => dialogue.sourceStart < sourceEnd && dialogue.sourceEnd > sourceStart)) continue;
    dialogues.push({ text, speakerCandidate, sourceStart, sourceEnd });
  }
  return dialogues.sort((left, right) => left.sourceStart - right.sourceStart);
};

const sourceDialoguesFromText = extractSourceDialogues;

const quotedDialogue = (value: string): string => {
  const match = [...normalizeProse(value).matchAll(QUOTED_SPAN_PATTERN)][0];
  return match?.slice(1).find((part) => typeof part === 'string')?.trim() || '';
};

const dialogueUnits = (value: string): number => {
  const text = String(value || '').replace(/[\s，。！？、；：…—,.!?;:]/gu, '');
  const chinese = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+/gu) || []).length;
  const other = Math.max(0, text.length - chinese - (text.match(/[A-Za-z0-9]/gu) || []).length);
  return chinese + latinWords * 1.6 + other * 0.25;
};

/** Estimated speaking time for a dialogue line, excluding the visual lead/tail. */
export const estimateDialogueSpeechSec = (value: string): number => {
  const text = quotedDialogue(value) || String(value || '').trim();
  if (!text) return 0;
  return Math.max(0.45, dialogueUnits(text) / DIALOGUE_CHARS_PER_SEC);
};

export const dialogueCapacityForDuration = (durationSec: number): number => {
  const speechBudget = Math.max(0, Number(durationSec) - DIALOGUE_LEAD_SEC - DIALOGUE_TAIL_SEC);
  return Math.max(0, Math.floor(speechBudget * DIALOGUE_CHARS_PER_SEC));
};

/** Minimum shot window: a short acting beat before speech, speech, and a tail. */
export const estimateDialogueWindowSec = (value: string): number => {
  const speech = estimateDialogueSpeechSec(value);
  return speech ? speech + DIALOGUE_LEAD_SEC + DIALOGUE_TAIL_SEC : 0;
};

const dialogueTextsFromActions = (actions: string[]): string[] => actions
  .flatMap((action) => sourceDialoguesFromText(action).map((dialogue) => dialogue.text));

const dialogueHintsForTimeline = (scene: Scene, count: number): string[] => {
  const beats = extractStoryBeats(scene.content || '');
  if (!beats.length || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const assignedBeats = storyBeatsForShot(beats, count, index);
    return assignedBeats
      .flatMap((beat) => sourceDialoguesFromText(beat.text).map((dialogue) => dialogue.text))
      .join('');
  });
};

export const recommendShotCount = (params: {
  durationSec: number;
  workflow: Workflow;
  pace: Pace;
  story: string;
  beatCount?: number;
}): ShotRecommendation => {
  const duration = clamp(Number(params.durationSec) || 15, 1, 300);
  const semanticBeats = tokenizeActionBeats(params.story);
  const beatCount = Math.max(semanticBeats.length, 1);
  const paceMultiplier: Record<Pace, number> = { slow: 0.78, standard: 1, tight: 1.22, fast: 1.5 };
  const densityBase = params.workflow === 'drama'
    ? duration / 3.1
    : params.workflow === 'action'
      ? duration / 1.45
      : 9;
  const beatBonus = params.workflow === 'grid' ? 0 : Math.min(4, Math.max(0, beatCount - 3) * 0.35);
  const raw = params.workflow === 'grid'
    ? 9
    : densityBase * paceMultiplier[params.pace] + beatBonus;
  // A single kinetic event may be shown as genuine preparation/transfer/
  // release/reaction/recovery stages. Multi-event stories and all narrative
  // stories receive at most one automatic shot per distinct semantic event.
  const semanticShotCapacity = params.workflow === 'grid'
    ? 9
    : params.workflow === 'action' && beatCount === 1
      ? 5
      : beatCount;
  const unconstrainedMin = params.workflow === 'grid'
    ? 9
    : clamp(Math.floor(raw - (params.workflow === 'action' ? 2 : 1)), 1, Math.max(1, Math.ceil(duration * 2)));
  const min = Math.min(semanticShotCapacity, unconstrainedMin);
  const unconstrainedMax = params.workflow === 'grid'
    ? 9
    : clamp(Math.ceil(raw + (params.workflow === 'action' ? 2 : 1)), min, Math.max(min, Math.ceil(duration * 2.5)));
  const max = Math.max(min, Math.min(semanticShotCapacity, unconstrainedMax));
  const dialogueWindows = dialogueTextsFromActions(tokenizeStory(params.story))
    .map(estimateDialogueWindowSec)
    .filter((value) => value > 0);
  const longestDialogue = dialogueWindows.length ? Math.max(...dialogueWindows) : 0;
  const maxShotsForDialogue = longestDialogue > 0
    ? Math.max(1, Math.floor(Math.max(0, duration - longestDialogue) / 0.35) + 1)
    : max;
  const dialogueConstrainedMax = params.workflow === 'grid' ? max : Math.min(max, maxShotsForDialogue);
  const dialogueConstrainedMin = Math.min(min, dialogueConstrainedMax);
  const count = clamp(Math.min(Math.round(raw), semanticShotCapacity, dialogueConstrainedMax), dialogueConstrainedMin, dialogueConstrainedMax);
  const breakdown = [
    `${duration} 秒时长`,
    `${workflowLabels[params.workflow]}流程`,
    `${paceLabels[params.pace]}节奏`,
    `识别到 ${beatCount} 个去重后的语义事件节拍`,
    ...(longestDialogue > 0 ? [`最长对白预计需要 ${formatSeconds(longestDialogue)} 秒`] : [])
  ];
  if (params.workflow === 'grid') breakdown.push('九宫格保留 9 个核心状态');
  const reason = params.workflow === 'grid'
    ? '九宫格阶段默认一格对应一个核心视觉状态，因此推荐 9 镜。'
    : `${workflowLabels[params.workflow]}在${duration}秒、${paceLabels[params.pace]}节奏下，结合${beatCount}个去重后的语义事件${longestDialogue > 0 ? '并优先保证对白可自然说完' : ''}，建议 ${count} 镜，可在 ${dialogueConstrainedMin}—${dialogueConstrainedMax} 镜之间微调；标点和同义复述不会增加镜头。`;
  return { count, min: dialogueConstrainedMin, max: dialogueConstrainedMax, reason, breakdown };
};

export const allocateTimeline = (
  durationSec: number,
  count: number,
  workflow: Workflow,
  dialogueActions: string[] = []
): Array<{ startSec: number; endSec: number }> => {
  const duration = clamp(Number(durationSec) || 15, 1, 300);
  // Keep the requested count for normal use. The UI allows up to 900 shots;
  // a 0.001-second floor prevents pathological requests from creating an
  // impossible timeline while still preserving the exact count whenever it
  // can be represented meaningfully.
  const maxRepresentable = Math.max(1, Math.floor(duration * 1000));
  const safeCount = clamp(Math.floor(Number(count) || 1), 1, Math.min(900, maxRepresentable));
  const weights = Array.from({ length: safeCount }, (_, index) => {
    if (workflow === 'drama') return index === 0 || index === safeCount - 1 ? 1.2 : 1;
    if (workflow === 'action') return index === safeCount - 1 ? 1.25 : index === 0 ? 0.8 : 1;
    return 1;
  });
  const dialogueWindows = dialogueActions.slice(0, safeCount).map(estimateDialogueWindowSec);
  const hasDialogueTiming = dialogueWindows.some((value) => value > 0);
  if (!hasDialogueTiming) {
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const minimumStep = Math.min(0.001, duration / safeCount);
    const distributable = Math.max(0, duration - minimumStep * safeCount);
    let cursor = 0;
    return weights.map((weight, index) => {
      const start = cursor;
      cursor = index === safeCount - 1 ? duration : cursor + minimumStep + distributable * weight / totalWeight;
      return { startSec: start, endSec: cursor };
    });
  }
  const minimums = dialogueWindows.map((window) => window || 0.35);
  const reserved = minimums.reduce((sum, value) => sum + value, 0);
  const scale = reserved > duration ? duration / reserved : 1;
  const scaledMinimums = minimums.map((value) => value * scale);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const distributable = Math.max(0, duration - scaledMinimums.reduce((sum, value) => sum + value, 0));
  let cursor = 0;
  return weights.map((weight, index) => {
    const start = cursor;
    cursor = index === safeCount - 1
      ? duration
      : cursor + scaledMinimums[index] + distributable * weight / totalWeight;
    return { startSec: start, endSec: cursor };
  });
};

const dramaPurposes = ['建立关系与空间', '证据或信息出现', '对方回应与情绪变化', '主角消化并做出决定', '行为结果与情绪余波'];
const actionPurposes = ['进入战斗轴线', '先手与第一次交换', '受力与环境互动', '控制权反转', '终结动作与结果落地'];
const gridPurposes = ['建立', '触发', '升级', '第一次变化', '中段状态', '第二次升级', '高潮形成', '接近完成', '最终状态'];

type SubjectMotionClass = 'human' | 'humanoid' | 'quadruped' | 'winged' | 'serpentine' | 'tentacled' | 'insectoid' | 'amorphous' | 'mechanical' | 'unknown-nonhuman';

const inferSubjectMotionClass = (value: string): SubjectMotionClass => {
  const text = normalizeProse(value);
  if (/(?:触手|触肢|触腕|腕足)/u.test(text)) return 'tentacled';
  if (/(?:无定形|胶质|黏液体|流体生物|史莱姆)/u.test(text)) return 'amorphous';
  if (/(?:昆虫|虫型|虫族|甲虫|螳螂|蜘蛛|节肢|多足|六足|八足|甲壳巨兽)/u.test(text)) return 'insectoid';
  if (/(?:双翼|翼膜|翅膀|飞龙|巨龙|鸟类|飞行兽|振翼)/u.test(text)) return 'winged';
  if (/(?:蛇形|巨蛇|蟒|蛟|蜿蜒|无足长躯)/u.test(text)) return 'serpentine';
  if (/(?:四足|狼|虎|豹|犬|猫科|熊|兽爪|蹄足)/u.test(text)) return 'quadruped';
  if (/(?:机器人|机械兽|机甲|仿生机械|液压|履带)/u.test(text)) return 'mechanical';
  const rejectsHumanShape = /(?:禁止|拒绝|不是|并非|非)(?:人形|类人|拟人|双足直立)/u.test(text)
    || /(?:禁止人类手臂|禁止人形|非人类|非人形)/u.test(text);
  if (!rejectsHumanShape && /(?:拟人化|类人形态|人形生物|双足直立)/u.test(text)) return 'humanoid';
  if (!rejectsHumanShape && /(?:奥特曼|类人战士|人形战士|人形机甲)/u.test(text)) return 'humanoid';
  if (/(?:怪兽|巨兽|异兽|魔兽|非人|外星生物|未知生物)/u.test(text)) return 'unknown-nonhuman';
  return 'human';
};

interface SubjectActionTargetRelation {
  actor: string;
  verb: string;
  target: string;
}

const RELATION_ACTION_SOURCE = '(?:(?:发射|释放)[^，。！？；]{0,12}?(?:消灭|击中|击退|轰击|攻击|射向)|挥拳击打|挥拳打向|挥拳击向|冲撞|撞向|撞倒|冲向|扑向|追击|攻击|袭击|迎战|对抗|格挡|抓住|抓向|卷住|缠住|压制|踢向|踢|击打|击中|击退|击飞|打向|打倒|打飞|打|砸向|砸|劈向|劈|刺向|刺|推开|推倒|掀翻|射向|射击|消灭)';
const relationActionAtStart = new RegExp(`^(?:猛然|突然|迅速|立刻|随即|径直|用[^，。！？；]{1,12})*(?:(?:从|由|沿|自)[^，。！？；]{1,12})?(${RELATION_ACTION_SOURCE})([^，。！？；]{1,28})`, 'u');
const relationActionInClause = new RegExp(`^([^，。！？；]{2,18}?)(?:猛然|突然|迅速|立刻|随即|径直|用[^，。！？；]{1,12})*(${RELATION_ACTION_SOURCE})([^，。！？；]{1,28})`, 'u');

// Quantity words are not part of an actor's identity.  Keeping them in the
// relation parser makes a phrase such as “一群敌人冲向夏提雅” look like an
// anonymous action and prevents the target from being carried into the
// rendered direction/space fields.
const RELATION_QUANTITY_PREFIX = /^(?:一群|成群(?:的)?|数(?:名|位|个|头|只|条|匹)?|多(?:名|位|个|头|只|条|匹)?|若干(?:名|位|个|头|只|条|匹)?|几(?:名|位|个|头|只|条|匹)?|一(?:名|位|个|头|只|条|匹))/u;

const stripRelationQuantity = (value: string): string => value.replace(RELATION_QUANTITY_PREFIX, '').trim();

const cleanRelationEntity = (value: string): string => value
  .replace(/^[\s“”"'，。！？；：]+|[\s“”"'，。！？；：]+$/gu, '')
  .replace(/^(?:一名|一位|一个|一头|一只|一条|一群|数名|数位|数个|数头|数只|数条|几名|几位|几只|几头|多名|多人|若干名|成群(?:的)?|这名|这位|这个|这头|这只|这条)/u, '')
  .replace(/^(?:向|朝着|朝|对着|对)/u, '')
  .replace(/^(?:了|着)/u, '')
  .replace(/(?:并|随后|然后|同时)$/u, '')
  .trim();

const relationActorComparableName = (value: string): string => stripRelationQuantity(cleanRelationEntity(value))
  .replace(/们$/u, '')
  .trim();

const relationActorNamesMatch = (left: string, right: string): boolean => {
  const normalizedLeft = relationActorComparableName(left);
  const normalizedRight = relationActorComparableName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
};

const actionStartsWithRelationActor = (action: string, actor: string): boolean => {
  const source = normalizeProse(action).replace(/^[，。！？；：\s]+/u, '');
  const normalizedActor = relationActorComparableName(actor);
  if (!source || !normalizedActor) return false;
  const withoutQuantity = stripRelationQuantity(source);
  return source.startsWith(actor)
    || source.startsWith(normalizedActor)
    || withoutQuantity.startsWith(normalizedActor)
    || relationActorComparableName(source.slice(0, Math.min(source.length, actor.length + 8))).startsWith(normalizedActor);
};

const parseSubjectActionTarget = (
  value: string,
  actorCandidates: readonly string[] = [],
): SubjectActionTargetRelation | undefined => {
  const clause = value.replace(/[“"][^”"]*[”"]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!clause) return undefined;
  const candidates = [...actorCandidates]
    .map(cleanRelationEntity)
    .filter((item) => item.length >= 2)
    .sort((left, right) => {
      const leftAt = clause.indexOf(left);
      const rightAt = clause.indexOf(right);
      if (leftAt !== rightAt) return (leftAt < 0 ? Number.MAX_SAFE_INTEGER : leftAt) - (rightAt < 0 ? Number.MAX_SAFE_INTEGER : rightAt);
      return right.length - left.length;
    });
  for (const actor of candidates) {
    const actorAt = clause.indexOf(actor);
    if (actorAt < 0) continue;
    const match = clause.slice(actorAt + actor.length).match(relationActionAtStart);
    const target = cleanRelationEntity(match?.[2] || '');
    if (match && target) return { actor, verb: match[1], target };
  }
  const match = clause.match(relationActionInClause);
  if (!match) return undefined;
  const actor = cleanRelationEntity(match[1]);
  const target = cleanRelationEntity(match[3]);
  if (actor.length < 2 || actor.length > 14 || !target) return undefined;
  return { actor, verb: match[2], target };
};

type KineticPhase = 'anticipation' | 'transfer' | 'release' | 'reaction' | 'recovery';
const kineticPhases: readonly KineticPhase[] = ['anticipation', 'transfer', 'release', 'reaction', 'recovery'];

const kineticPhasesForShot = (index: number, count: number): KineticPhase[] => {
  const safeCount = Math.max(1, count);
  if (safeCount <= kineticPhases.length) {
    const start = Math.round(index * kineticPhases.length / safeCount);
    const end = Math.max(start + 1, Math.round((index + 1) * kineticPhases.length / safeCount));
    return kineticPhases.slice(start, end);
  }
  return [kineticPhases[Math.min(kineticPhases.length - 1, Math.floor(index * kineticPhases.length / safeCount))]];
};

const kineticPhaseQualifier = (phase: KineticPhase, index: number, count: number): string => {
  if (count <= kineticPhases.length) return '';
  const peers = Array.from({ length: count }, (_, candidate) => candidate)
    .filter((candidate) => kineticPhases[Math.min(kineticPhases.length - 1, Math.floor(candidate * kineticPhases.length / count))] === phase);
  if (peers.length <= 1) return '';
  const position = peers.indexOf(index);
  return position === 0 ? '初段' : position === peers.length - 1 ? '末段' : `推进${position + 1}`;
};

const visibleKineticTarget = (sourceAction: string): string => {
  const action = normalizeProse(sourceAction);
  if (/(?:奔跑|跑|冲刺|前进|行进|走|追赶)/u.test(action)) return '画面纵深';
  if (/(?:跳|跃|腾空|飞跃|落地)/u.test(action)) return '前方落地点';
  if (/(?:抬头|仰望|举起|上举)/u.test(action)) return '上方可见位置';
  if (/(?:低头|俯身|踩|踏|跪|蹲)/u.test(action)) return '地面接触点';
  if (/(?:脱|穿|拉|扯|解开|扣住)/u.test(action)) return '手部与衣物接触点';
  if (/(?:转身|回头|旋转|挥|摆)/u.test(action)) return '动作轨迹前方';
  return '画面纵深中的可见接触点';
};

const kineticPhaseTriplet = (
  motionClass: SubjectMotionClass,
  phase: KineticPhase,
  sourceAction: string,
  relation: SubjectActionTargetRelation | undefined,
  qualifier = '',
): [string, string, string] => {
  const target = relation?.target || visibleKineticTarget(sourceAction);
  const event = relation ? `${relation.verb}${relation.target}` : sourceAction.replace(/[。！？!?]+$/u, '');
  const stage = qualifier ? `${qualifier}` : '';
  const targetResponse = relation
    ? `${target}沿受力方向产生可见位移或形变`
    : '接触点产生可见位移或形变';
  const humanLike = motionClass === 'human' || motionClass === 'humanoid';
  if (humanLike) {
    const anticipation: [string, string, string] = qualifier === '初段'
      ? [`蓄力初段视线先锁定${target}`, '支撑脚压地', '膝髋开始下沉']
      : qualifier === '末段'
        ? ['蓄力末段后脚持续承重', '核心收紧并带动躯干预旋', `肩带朝${target}形成预张力`]
        : qualifier
          ? [`蓄力${stage}重心继续移动`, '躯干预旋幅度增加', `末端肢体朝${target}逐步到位`]
          : ['蓄力支撑脚压地', '膝髋微屈并降低重心', `重心朝${target}移动形成预备姿态`];
    const map: Record<KineticPhase, [string, string, string]> = {
      anticipation,
      transfer: [`传力${stage}支撑脚蹬地`, '重心前移并带动骨盆与躯干旋转', '肩带和末端肢体依次传力'],
      release: [`释放${stage}重心越过支撑面`, '躯干将力量传至末端肢体', `${event}并形成清晰接触`],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击回传使支撑腿加压', '关节屈伸并带动躯干自然回弹'],
      recovery: [`收势${stage}让余势继续通过全身`, '对侧肢体与衣摆延迟跟随', '双脚重新落稳并自然回稳'],
    };
    return map[phase];
  }
  const maps: Record<Exclude<SubjectMotionClass, 'human' | 'humanoid'>, Record<KineticPhase, [string, string, string]>> = {
    quadruped: {
      anticipation: [`蓄力${stage}四足降低支撑面`, '后肢屈曲压地', '脊背与尾部调整平衡'],
      transfer: [`传力${stage}后足蹬地`, '力量沿后肢进入脊柱连续传力', `前躯朝${target}加速`],
      release: [`释放${stage}前躯越过支撑点`, `${event}并形成清晰接触`, '足爪沿原轨迹跟进'],
      reaction: [`反作用${stage}使${targetResponse}`, '前肢屈曲吸收冲击', '脊背弹性回弹并保持四足轴线'],
      recovery: [`收势${stage}后肢顺势跟进`, '尾部反向摆动抵消余势', '四足重新停稳'],
    },
    winged: {
      anticipation: [`蓄力${stage}翼根收紧`, '躯干调整迎角', `尾部朝${target}反向配平`],
      transfer: [`传力${stage}翼根先发力`, '力量沿翼骨传至翼尖', '躯干与尾部连续修正轨迹'],
      release: [`释放${stage}翼膜完全受力`, `${event}并掠过接触点`, '气流沿翼尖脱离'],
      reaction: [`反作用${stage}使${targetResponse}`, '翼膜顺势形变卸载', '躯干轻微回摆'],
      recovery: [`收势${stage}双翼分级收拢`, '尾部抵消剩余偏航', '恢复稳定飞行姿态'],
    },
    serpentine: {
      anticipation: [`蓄力${stage}长躯盘紧`, '接地段增加摩擦支点', `头部轴线锁定${target}`],
      transfer: [`传力${stage}波动从尾段启动`, '力量沿连续躯干向前传递', '前段逐节加速'],
      release: [`释放${stage}前段脱离盘绕`, `${event}并形成清晰接触`, '后段继续推送余力'],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击沿鳞片与躯干回传', '尾段反向摆动缓冲'],
      recovery: [`收势${stage}前段回到运动轴线`, '躯干波幅逐级减小', '尾部收束停稳'],
    },
    tentacled: {
      anticipation: [`蓄力${stage}触肢卷束固定支点`, '胶质核心向内收缩', `质量朝${target}预移`],
      transfer: [`传力${stage}近端触肢先收紧`, '张力沿触肢向远端传递', '核心质量连续前移'],
      release: [`释放${stage}远端触肢甩出`, `${event}并形成清晰接触`, '其余触肢维持支撑'],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击沿触肢回传', '胶质核心形变并由支撑触肢缓冲'],
      recovery: [`收势${stage}触肢依次回卷`, '核心质量重新居中', '接触支点恢复稳定'],
    },
    insectoid: {
      anticipation: [`蓄力${stage}多足分级压低`, '后侧节肢锁紧支点', `甲壳轴线朝${target}对准`],
      transfer: [`传力${stage}后足依次蹬地`, '力量经节肢与胸腹甲壳向前传递', '前足腾空准备接触'],
      release: [`释放${stage}前侧节肢展开`, `${event}并形成清晰接触`, '后足继续推进'],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击经前足回传', '节肢关节分级屈曲并带动甲壳回摆'],
      recovery: [`收势${stage}多足按次序重新落地`, '腹部与尾节抵消余势', '节肢交替支撑停稳'],
    },
    amorphous: {
      anticipation: [`蓄力${stage}表面向内收缩`, '核心质量后移形成压差', `前缘朝${target}聚拢`],
      transfer: [`传力${stage}压差从核心向外扩散`, '质量沿内部流动连续前移', '前缘逐步加速'],
      release: [`释放${stage}前缘快速伸展`, `${event}并形成清晰接触`, '后部质量继续跟进'],
      reaction: [`反作用${stage}使${targetResponse}`, '胶质结构扩散吸收冲击', '核心产生延迟回弹'],
      recovery: [`收势${stage}边缘逐步回收`, '核心质量重新聚拢', '表面波动减弱并稳定'],
    },
    mechanical: {
      anticipation: [`蓄力${stage}承重关节锁定`, '驱动器逐级增压', `机体轴线对准${target}`],
      transfer: [`传力${stage}主驱动器先启动`, '扭矩沿机械骨架向执行端传递', '辅助关节依次跟进'],
      release: [`释放${stage}执行端达到目标速度`, `${event}并形成清晰接触`, '驱动器维持短暂输出'],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击沿机械骨架回传', '阻尼关节分级吸收并带动执行端回弹'],
      recovery: [`收势${stage}执行器逐级卸压`, '辅助关节回到承重位置', '机械结构重新停稳'],
    },
    'unknown-nonhuman': {
      anticipation: [`蓄力${stage}非人支撑结构压低`, '主要驱动部位收紧', `躯体轴线对准${target}`],
      transfer: [`传力${stage}力量沿自身解剖链传递`, '躯体质量连续前移', '末端结构逐步加速'],
      release: [`释放${stage}末端结构沿轴线展开`, `${event}并形成清晰接触`, '主体结构保持非人运动方式'],
      reaction: [`反作用${stage}使${targetResponse}`, '冲击沿非人结构回传', '可弯曲部位顺势吸收并产生结构回弹'],
      recovery: [`收势${stage}驱动部位逐级卸力`, '平衡结构抵消余势', '非人躯体重新稳定'],
    },
  };
  return maps[motionClass as Exclude<SubjectMotionClass, 'human' | 'humanoid'>][phase];
};

const kineticActionForShot = (
  motionClass: SubjectMotionClass,
  sourceAction: string,
  relation: SubjectActionTargetRelation | undefined,
  index: number,
  count: number,
): string => {
  const phases = kineticPhasesForShot(index, count);
  const summaries = phases.map((phase) => kineticPhaseTriplet(
    motionClass,
    phase,
    sourceAction,
    relation,
    kineticPhaseQualifier(phase, index, count),
  ));
  if (summaries.length === 1) return summaries[0].join('→');
  const compact = summaries.map((triplet) => `${triplet[0]}并${triplet[1]}并${triplet[2]}`);
  if (compact.length === 2) return `${compact[0]}→${compact[1]}→${summaries[1][2]}`;
  if (compact.length === 3) return compact.join('→');
  return `${compact.slice(0, 2).join('并')}→${compact.slice(2, -1).join('并')}→${compact[compact.length - 1]}`;
};

const gridPurposeForShot = (index: number, shotCount: number): string => {
  const safeCount = Math.max(1, shotCount);
  const start = Math.min(8, Math.floor(index * 9 / safeCount));
  const end = Math.min(9, Math.max(start + 1, Math.floor((index + 1) * 9 / safeCount)));
  return gridPurposes.slice(start, end).join(' → ') || gridPurposes[start];
};

const pickSubject = (scene: Scene, characters: Character[], locations: Location[], props: Prop[]): string => {
  const names = scene.characterIds.map((id) => characters.find((item) => item.id === id)?.name).filter(Boolean);
  const locationIds = scene.locationIds?.length ? scene.locationIds : scene.locationId ? [scene.locationId] : [];
  const location = locationIds.map((id) => locations.find((item) => item.id === id)?.name).filter(Boolean).join('、');
  const propNames = scene.propIds.map((id) => props.find((item) => item.id === id)?.name).filter(Boolean);
  // A place describes the staging space; it must not be appended to a named
  // performer and accidentally become part of the canonical @subject.
  const candidate = names.length ? names.join('与') : (propNames[0] || location);
  return candidate && !invalidTimelineSubject(candidate) ? candidate : '环境主体';
};

const storyBeatsForShot = <T>(
  beats: readonly T[],
  shotCount: number,
  storyIndex: number,
): T[] => {
  if (!beats.length) return [];
  const safeShotCount = Math.max(1, shotCount);
  const safeStoryIndex = Math.max(0, storyIndex);
  if (beats.length > safeShotCount) {
    const start = Math.floor(safeStoryIndex * beats.length / safeShotCount);
    const end = Math.max(
      start + 1,
      Math.floor((safeStoryIndex + 1) * beats.length / safeShotCount),
    );
    return beats.slice(start, end);
  }
  const beatIndex = safeShotCount <= 1
    ? 0
    : Math.round(safeStoryIndex * Math.max(0, beats.length - 1) / Math.max(1, safeShotCount - 1));
  return [beats[Math.min(beats.length - 1, beatIndex)]];
};

const actionForShot = (
  workflow: Workflow,
  index: number,
  scene: Scene,
  shotCount = 1,
  storyIndex = index,
  motionClass: SubjectMotionClass = 'human',
  assignedSourceBeatTexts?: readonly string[],
): string => {
  const text = scene.content.replace(/\s+/g, ' ').trim();
  const beats = assignedSourceBeatTexts?.length
    ? assignedSourceBeatTexts.map((beat) => beat.replace(/\s+/g, ' ').trim()).filter(Boolean)
    : tokenizeActionBeats(text);
  const sourceBeats = assignedSourceBeatTexts?.length
    ? beats
    : storyBeatsForShot(beats, shotCount, storyIndex);
  const excerpt = (sourceBeats.length ? sourceBeats.join('，') : text)
    .replace(/[。！？!?，；;,.]+$/u, '');
  const visibleAnalysis = visibleInformationAnalysisFor(
    informationAnalysisContextForBeat(excerpt, scene.content),
  );
  if (visibleAnalysis) {
    return INFORMATION_ANALYSIS_SIGNAL.test(excerpt)
      ? visibleAnalysis.action
      : visibleAnalysis.observationAction;
  }
  if (workflow === 'action' && tokenizeActionBeats(text).length === 1 && excerpt) {
    return kineticActionForShot(
      motionClass,
      excerpt,
      parseSubjectActionTarget(excerpt),
      Math.max(0, storyIndex),
      Math.max(1, shotCount),
    );
  }
  const nonHuman = motionClass !== 'human' && motionClass !== 'humanoid';
  if (nonHuman && workflow !== 'grid') return excerpt || '主体以符合自身解剖结构的方式完成当前动作';
  if (workflow === 'drama') {
    const actions = ['人物在同一空间中保持克制的观察和对视', '关键道具进入画面并改变双方的注意力', '一方抬眼、停顿或收回未完成的动作', '人物缩短或拉开距离，做出明确决定', '行为结果落地，留下可见的情绪余波'];
    return excerpt ? `${excerpt}；镜头重点表现${actions[index % actions.length]}` : actions[index % actions.length];
  }
  if (workflow === 'action') {
    const actions = ['主角快速进入攻击距离，锁定对手和接触点', '攻击被格挡，受力带动双方改变站位', '角色借助墙面、地面或道具完成位移', '控制权反转，下一招沿着上一招余势启动', '终结动作命中，对手产生明确物理反应，主角卸力停住'];
    return excerpt ? `${excerpt}；镜头重点表现${actions[index % actions.length]}` : actions[index % actions.length];
  }
  return `${gridPurposeForShot(index, shotCount)}状态清晰进入画面，主体姿态、核心道具和运动方向与前后状态保持可见关联${excerpt ? `，故事线索：${excerpt}` : ''}`;
};

const normalizeContinuityState = (
  value: string,
  kind: 'entry' | 'exit',
): string => {
  const withoutLabel = value.replace(
    kind === 'entry'
      ? /^\s*承接上一段\s*[：:]\s*/u
      : /^\s*本段结束状态\s*[：:]\s*/u,
    '',
  );
  const withoutHandoff = kind === 'exit'
    ? withoutLabel.replace(/[，,；;]?\s*交接下一段\s*$/u, '')
    : withoutLabel;
  return withoutHandoff.replace(/[\r\n]+/gu, ' ').trim();
};

const continuityFieldPhrases: Readonly<Record<string, string>> = {
  主体: '主体状态为',
  空间: '空间状态为',
  光影: '光影状态为',
  镜头: '镜头状态为',
  台词: '台词内容为',
  音效: '音效内容为',
};

/**
 * Preserve hand-off meaning without allowing user/AI continuity prose to
 * impersonate the canonical six-field timeline grammar.
 */
export const sanitizeContinuityState = (
  value: string,
  kind: 'entry' | 'exit',
): string => normalizeContinuityState(value, kind)
  .replace(/(主体|空间|光影|镜头|台词|音效)\s*[：:]/gu, (match, label: string) => (
    continuityFieldPhrases[label] || match
  ))
  .replace(/[；;|｜]+/gu, '，')
  .replace(/[\[【{]/gu, '（')
  .replace(/[\]】}]/gu, '）')
  .replace(/[<>`]/gu, '')
  .replace(/\s*→\s*/gu, '，随后')
  .replace(/[，,]{2,}/gu, '，')
  .replace(/\s+/gu, ' ')
  .replace(/^[，,。\s]+|[，,。\s]+$/gu, '')
  .trim();

export interface GlobalLockOptions {
  /** Omit inferred character-card age metadata from model-facing NSFW locks. */
  omitApparentAge?: boolean;
}

export const buildGlobalLock = (
  scene: Scene,
  characters: Character[],
  locations: Location[],
  props: Prop[],
  assets: ReferenceAsset[],
  continuityIn = '',
  options: GlobalLockOptions = {},
): string => {
  const currentClothingStateWins = hasExplicitClothingStateChange(
    `${scene.content}\n${continuityIn}`,
  );
  const characterLocks = scene.characterIds.map((id) => {
    const item = characters.find((character) => character.id === id);
    if (!item) return '';
    const asset = item.assetIds
      .map((assetId) => assets.find((candidate) => candidate.id === assetId))
      .find((candidate): candidate is ReferenceAsset => Boolean(
        candidate
        && !isNsfwPrivateProfileAsset(candidate)
        && (!candidate.sourceEntityId || candidate.sourceEntityId === item.id),
      ));
    const detail = [
      ...characterVariantPromptFacts(item),
      item.gender ? `性别设定：${item.gender}` : '',
      options.omitApparentAge || !item.apparentAge ? '' : `外观年龄：${item.apparentAge}`,
      item.height ? `身高/高度：${item.height}` : '',
      item.race,
      item.appearance,
      !currentClothingStateWins && item.outfit ? `默认衣橱/身份服装基底：${item.outfit}` : '',
      currentClothingStateWins && item.outfit ? `衣橱基底（不是本镜着装指令）：${item.outfit}` : '',
      item.signatureProps ? `稳定长期装备/辨识物：${item.signatureProps}` : '',
      item.motionHabits,
      currentClothingStateWins ? '' : item.anchor,
      currentClothingStateWins ? '' : item.negativeContinuity,
    ].filter(Boolean).join('，');
    if (!asset && detail.length < 8) return '';
    const displayName = characterVariantDisplayName(item) || item.name;
    return `${displayName}${asset ? `（已绑定参考资产“${asset.name}”）` : ''}：${detail || assetDescription(asset!)}`;
  }).filter(Boolean);
  const locationIds = scene.locationIds?.length ? scene.locationIds : scene.locationId ? [scene.locationId] : [];
  const sceneLocations = locationIds.map((id) => locations.find((item) => item.id === id)).filter((item): item is Location => Boolean(item));
  const propLocks = scene.propIds.map((id) => props.find((item) => item.id === id)?.name).filter(Boolean);
  const entryState = sanitizeContinuityState(continuityIn, 'entry');
  const lock = [
    currentClothingStateWins
      ? '动态衣物优先：当前衣着以已确认入口和逐镜状态为准；仅执行剧情明确的衣着变化，未涉及的衣物保持原状；已有离身衣物保持位置，只有剧情明确穿回时才恢复对应着装。'
      : '',
    entryState ? `承接上一段：${entryState}` : '',
    characterLocks.length ? `固定人物：${characterLocks.join('；')}` : '',
    sceneLocations.length === 1 ? `固定场景：${sceneLocations[0].name}，${sceneLocations[0].description}，${sceneLocations[0].timeWeather}，${sceneLocations[0].lighting}，${sceneLocations[0].anchor}` : '',
    sceneLocations.length > 1 ? `场景序列：${sceneLocations.map((item) => `${item.name}（${[item.description, item.timeWeather, item.lighting, item.anchor].filter(Boolean).join('，')}）`).join('；')}。仅在剧情明确发生地点变化时切换场景，每个地点内部的空间布局、陈设、光向和色彩保持稳定` : '',
    propLocks.length ? `本场景道具候选：${propLocks.join('、')}；仅在当前镜头剧情明确可见时呈现，按持有、交接、放下、使用或消耗状态保持外形、材质、方向和状态连续` : '',
    currentClothingStateWins
      ? '同一镜头组中的人物身份、稳定身体特征、长期装备/辨识物、空间轴线和主光源保持连续；本场景临时道具只按当前镜头剧情状态出现；当前衣物与裸露状态逐镜继承，只由明确的穿脱动作改变。'
      : '同一镜头组中的人物身份、默认衣橱/身份服装基底、长期装备/辨识物、空间轴线和主光源保持连续；本场景临时道具只按当前镜头剧情状态出现；剧情明确发生性别、外貌、物种或身体形态转化时，按本镜对应的形态人物资料与参考资产切换，不混用转化前后资料；其余只改变明确指定的动作、表情、视线、站位和镜头。',
  ].filter(Boolean).join('\n');
  return options.omitApparentAge ? stripAutomaticAgeMetadata(lock) : lock;
};

/** Resolve the visible performer from the exact source beats assigned to one
 * shot. A scene-level fallback is deliberately not used here: doing so makes
 * every shot inherit the first character found anywhere in a long story. */
const precedingNarrativeSubject = (
  sourceText: string,
  scene: Scene,
  characters: Character[],
): string => {
  const sourceIndex = scene.content.indexOf(sourceText);
  if (sourceIndex <= 0) return '';
  const candidates = timelineActorCandidates(scene, characters);
  const precedingClauses = scene.content
    .slice(Math.max(0, sourceIndex - 480), sourceIndex)
    .split(/(?<=[。！？!?；;\n])/u)
    .map((part) => normalizeProse(part))
    .filter(Boolean)
    .reverse();
  for (const clause of precedingClauses) {
    const subjectClause = clause.split(/[，,]/u)[0] || '';
    if (/(?:市中心的)?母巢/u.test(subjectClause)) return '母巢';
    const named = candidates.find((name) => subjectClause.includes(name));
    if (named) return named;
    const creature = creatureNameFromText(subjectClause);
    if (creature && !invalidTimelineSubject(creature)) return creature;
    const actor = actorNameFromClause(subjectClause);
    if (actor && !invalidTimelineSubject(actor)) return actor;
  }
  return '';
};

const strongNarrativeSubject = (
  sourceText: string,
  scene: Scene,
  characters: Character[],
): string => {
  const clean = normalizeProse(sourceText).replace(
    /(?:“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\r\n]*")/gu,
    '',
  );
  const roleCandidates = (scene.content.match(
    /(?:[\p{L}\p{N}·]{0,8}(?:兵团|军团|车队|队伍)|[\p{L}\p{N}·]{0,6}(?:玩家|士兵|人群))/gu,
  ) || []).map(normalizeTimelineSubject);
  const directRelation = parseSubjectActionTarget(
    clean,
    characters.map((character) => character.name),
  );
  const directActor = directRelation ? normalizeTimelineSubject(directRelation.actor) : '';
  const cleanWithoutArticle = clean.replace(/^(?:一名|一位|一个|一头|一只|一条|这名|这位|这个|这头|这只|这条)/u, '');
  const groundedFirstPersonObjectActor = normalizeTimelineSubject(
    resolveNarrativeFirstPersonObjectActor(
      clean,
      characters.map((character) => character.name),
    ),
  );
  if (groundedFirstPersonObjectActor && !invalidTimelineSubject(groundedFirstPersonObjectActor)) {
    return groundedFirstPersonObjectActor;
  }
  if (
    directActor
    && !invalidTimelineSubject(directActor)
    && cleanWithoutArticle.startsWith(directActor)
  ) {
    return directActor;
  }
  const creature = creatureNameFromText(clean);
  if (creature && !invalidTimelineSubject(creature)) return creature;
  const candidates = Array.from(new Set([
    ...characters.map((character) => normalizeTimelineSubject(character.name)),
    '母巢',
    ...roleCandidates,
    ...timelineActorCandidates(scene, characters),
    creature,
  ].filter((name) => name && !invalidTimelineSubject(name))));
  const subjectPredicate = /^(?:的(?:情绪|目光|身体|声音|神情|动作|孩子们))?(?:(?:稍稍|逐渐|重新|再次|已经|也|就)\s*)*(?:显然|陡然|短暂|已经|正在|正|仍|也|便有|立刻|随即|缓缓|猛然|低声|大声|不可能|拥有|坐着|站|伫立|注意|发现|感觉|想到|思索|回答|说道|说|问|吼道|喊道|发出|递|握|抓|冲|跑|走|涌|调转|接到|采购|赶去|守住|保护|需要|派出|投入|流露|安定|满意|能|将)/u;
  for (const candidate of candidates) {
    let searchFrom = 0;
    while (searchFrom < clean.length) {
      const at = clean.indexOf(candidate, searchFrom);
      if (at < 0) break;
      const prefix = clean.slice(Math.max(0, at - 10), at);
      const suffix = clean.slice(at + candidate.length);
      const usedAsObject = /(?:对抗|攻击|袭击|消灭|支援|帮助|直奔|涌向|保护|发现|分析出|守|向|朝着|朝)$/u.test(prefix);
      if (!usedAsObject && subjectPredicate.test(suffix)) return candidate;
      searchFrom = at + candidate.length;
    }
  }
  return '';
};

interface VisibleInformationAnalysis {
  subject: string;
  observationAction: string;
  action: string;
}

const INFORMATION_ANALYSIS_SIGNAL = /(?:分析出|研判出|定位到|锁定|识别出|推算出|标记出)/u;
const OBSERVATION_SOURCE_SIGNAL = /(?:观测站(?:点)?|无人机|雷达|卫星|传感器|天文望远镜|望远镜|探测器|遥感平台)/u;

const informationAnalysisContextForBeat = (sourceText: string, fullStory: string): string => {
  const source = String(sourceText || '').trim();
  const hasAnalysis = INFORMATION_ANALYSIS_SIGNAL.test(source);
  const hasObservationSource = OBSERVATION_SOURCE_SIGNAL.test(source);
  if ((hasAnalysis && hasObservationSource) || (!hasAnalysis && !hasObservationSource)) return source;
  const at = fullStory.indexOf(source);
  if (at < 0) return source;
  if (hasAnalysis) {
    const boundary = Math.max(
      fullStory.lastIndexOf('。', at - 1),
      fullStory.lastIndexOf('！', at - 1),
      fullStory.lastIndexOf('？', at - 1),
      fullStory.lastIndexOf('\n', at - 1),
    );
    return fullStory.slice(boundary + 1, at + source.length).trim();
  }
  const sourceEnd = at + source.length;
  const followingBoundaries = ['。', '！', '？', '\n']
    .map((boundary) => fullStory.indexOf(boundary, sourceEnd))
    .filter((position) => position >= 0);
  const sentenceEnd = followingBoundaries.length
    ? Math.min(...followingBoundaries) + 1
    : sourceEnd;
  const context = fullStory.slice(at, sentenceEnd).trim();
  return INFORMATION_ANALYSIS_SIGNAL.test(context) ? context : source;
};

/** Turn remote analysis/positioning prose into one filmable evidence chain.
 * The located entity is the information target, never the visible performer. */
const visibleInformationAnalysisFor = (value: string): VisibleInformationAnalysis | undefined => {
  const source = normalizeProse(value);
  const hasAnalysis = INFORMATION_ANALYSIS_SIGNAL.test(source);
  const hasObservationSource = OBSERVATION_SOURCE_SIGNAL.test(source);
  if (!hasAnalysis || !hasObservationSource) return undefined;

  const analysisMatch = source.match(INFORMATION_ANALYSIS_SIGNAL);
  const analysisAt = analysisMatch?.index ?? -1;
  const beforeAnalysis = analysisAt >= 0 ? source.slice(0, analysisAt) : source;
  const explicitOperator = beforeAnalysis.match(
    /(?:^|[，。；])\s*((?:[^，。；]{2,28}?))(?=通过|利用|借助)/u,
  )?.[1]
    ?.replace(/^(?:不过|但|而|同时|与此同时|就在刚才|刚才|随后|然后|接着|于是|此时|这时)\s*/u, '')
    .replace(/的/gu, '')
    .trim() || '';
  const observationSources = [
    /观测站(?:点)?/u.test(source) ? '各观测站' : '',
    /无人机/u.test(source) ? '无人机' : '',
    /雷达/u.test(source) ? '雷达' : '',
    /卫星/u.test(source) ? '卫星' : '',
    /传感器/u.test(source) ? '分布式传感器' : '',
    /天文望远镜/u.test(source) ? '天文望远镜' : !/天文望远镜/u.test(source) && /望远镜/u.test(source) ? '望远镜' : '',
    /探测器/u.test(source) ? '探测器' : '',
    /遥感平台/u.test(source) ? '遥感平台' : '',
  ].filter(Boolean).join('与') || '观测设备';
  const fallbackOperator = observationSources.split('与')[0] || '观测';
  const subjectBase = explicitOperator || fallbackOperator;
  const subject = /(?:系统|平台)$/u.test(subjectBase)
    ? subjectBase
    : `${subjectBase}观测系统`;
  const conclusion = analysisAt >= 0
    ? source
        .slice(analysisAt + (analysisMatch?.[0].length || 0))
        .replace(/^了/u, '')
        .replace(/[“”‘’「」『』"]/gu, '')
        .replace(/(可能(?:潜伏|出现|抵达|经过|发生|存在))的(?=位置|区域)/u, '$1')
        .replace(/[，。！？；,!?;]+$/u, '')
        .trim()
    : '';
  const explicitEvidence = beforeAnalysis.match(
    /(?:根据|依据)([^，。；]{2,64}?)(?:已经|已)?\s*$/u,
  )?.[1]?.trim() || '';
  const conclusionObject = conclusion.match(
    /^([^，。；]{1,24}?)(?=可能|所在|的位置|位置|区域|轨迹|异常|数值|$)/u,
  )?.[1]?.trim() || '';
  const evidence = explicitEvidence || (conclusionObject ? `${conclusionObject}观测数据` : `${observationSources}观测数据`);
  const visibleConclusion = conclusion || `${evidence}形成的分析结论`;

  return {
    subject,
    observationAction: `${observationSources}采集${evidence}→${evidence}持续回传分析终端`,
    action: `${observationSources}回传${evidence}→${evidence}在分析终端汇聚→${visibleConclusion}被高亮标记`,
  };
};

const subjectForAssignedSourceBeats = (
  sourceText: string,
  scene: Scene,
  characters: Character[],
  previousSubject: string,
): string => {
  const clean = normalizeProse(sourceText);
  const characterNames = characters.map((character) => character.name);
  const visibleAnalysis = visibleInformationAnalysisFor(
    informationAnalysisContextForBeat(clean, scene.content),
  );
  if (visibleAnalysis) return visibleAnalysis.subject;
  const pureEnvironmentBeat = (
    !hasNarrativeFirstPersonActor(clean, characterNames)
    && sourceDialoguesFromText(clean).length === 0
    && !characters.some((character) => (
      character.name.trim() && clean.includes(character.name.trim())
    ))
    && (
      /^(?:(?:此时|这时|随后|然后|接着|镜头切到|画面转向)[，,]?\s*)?(?:山风|夜风|冷风|风声|风|雨水|雨幕|雨滴|雨声|雪|雾|云层|阳光|月光|日光|光线|雷声|闪电|水面|海浪|潮水|河水|树影|枝叶|落叶|尘土|烟尘|火焰|灯光|木门|门窗|帘幕|天空|地面|山谷|谷口|树林|房间|街道|建筑)(?:穿过|掠过|吹过|卷起|落下|升起|散开|涌动|摇晃|闪动|照亮|熄灭|回荡|震动|保持|只剩|空无|在风里)/u.test(clean)
      || /^(?:远处|近处|山中|庭中|院中)?(?:传来|响起|回荡着?)(?:钟声|风声|雨声|雷声)/u.test(clean)
      || /^(?:院中|庭中|林间|街边|地面上?)(?:的)?(?:落叶|枝叶|尘土|烟尘)(?:翻卷|卷起|飘动|滚动|飞散)/u.test(clean)
      || /^(?:镜头|画面)(?:缓缓)?(?:扫过|掠过|移过|越过)(?:空庭|空院|空房|空房间|无人街道|空无一人的场景)/u.test(clean)
      || /^(?:画面|镜头)(?:只|仅)?(?:保留|呈现|转向).*(?:空无一人|无人|空房间|环境|风声|雨声)/u.test(clean)
      || /^(?:空无一人|无人|空荡)(?:的)?(?:山谷|谷口|树林|房间|街道|建筑)/u.test(clean)
    )
  );
  if (pureEnvironmentBeat) return '环境主体';
  const candidates = timelineActorCandidates(scene, characters);
  const dialogue = sourceDialoguesFromText(clean)[0];
  const cueSpeaker = dialogue
    ? normalizeTimelineSubject(dialogue.speakerCandidate)
    : '';
  if (cueSpeaker && !invalidTimelineSubject(cueSpeaker)) {
    return candidates.find((name) => (
      name === cueSpeaker || name.includes(cueSpeaker) || cueSpeaker.includes(name)
    )) || cueSpeaker;
  }

  const firstPersonSubject = resolveFirstPersonSubject(
    scene.content,
    characterNames,
  );
  if (firstPersonSubject && hasNarrativeFirstPersonActor(clean, characterNames)) {
    return firstPersonSubject;
  }

  // A cue such as “祂……回答道” refers to the established performer. Resolve
  // it before the permissive scene-wide dialogue fallback can select the most
  // recently mentioned dialogue character instead.
  const leadingPronoun = clean
    .replace(/^[“”"'‘’「」『』，。！？；：\s]+/u, '')
    .match(/^(?:此时|这时|随后|然后|接着)?(他|她|它|祂|他们|她们|它们)(?:又|也|已经|正在|短暂|立刻|随即|缓缓|猛然)?/u)?.[1];
  if (leadingPronoun) {
    if (previousSubject && !invalidTimelineSubject(previousSubject)) {
      return normalizeTimelineSubject(previousSubject);
    }
    const antecedent = normalizeTimelineSubject(
      precedingNarrativeSubject(sourceText, scene, characters),
    );
    if (antecedent && !invalidTimelineSubject(antecedent)) return antecedent;
  }

  const strongSubject = strongNarrativeSubject(sourceText, scene, characters);
  if (strongSubject) return strongSubject;

  if (dialogue) {
    const contextualSpeaker = normalizeTimelineSubject(
      dialogueSpeakerFromScene(scene, dialogue.text, characters),
    );
    if (contextualSpeaker && !invalidTimelineSubject(contextualSpeaker)) {
      return contextualSpeaker;
    }
    return '无名说话者';
  }

  if (previousSubject && !invalidTimelineSubject(previousSubject)) {
    return normalizeTimelineSubject(previousSubject);
  }
  if (characters.length === 1) {
    const onlyCharacter = normalizeTimelineSubject(characters[0].name);
    if (onlyCharacter && !invalidTimelineSubject(onlyCharacter)) return onlyCharacter;
  }
  return '环境主体';
};

export const buildShots = (params: {
  scene: Scene;
  characters: Character[];
  locations: Location[];
  props: Prop[];
  assets: ReferenceAsset[];
  workflow: Workflow;
  durationSec: number;
  shotMode: 'auto' | 'exact';
  shotCount: number;
  pace: Pace;
  camera: string;
  lighting: string;
  style: StylePreset;
  extra: string;
  gridStates?: GridVisualState[];
  /** Complete model-authored plan used by automatic mode. */
  aiPlan?: AiStoryboardPlan;
}): VideoShot[] => {
  const referenceAssetIdsForShot = (subject = '', action = ''): string[] => {
    // Dossier images are not current-shot instructions. Never auto-promote
    // them from scene keywords or let them displace ordinary wardrobe refs.
    const eligible = params.assets.filter((asset) => (
      ['character', 'scene', 'prop', 'grid', 'first-frame', 'last-frame', 'style', 'composition'].includes(asset.role)
      && !isNsfwPrivateProfileAsset(asset)
    ));
    const evidence = `${subject} ${action}`.trim();
    const concreteFormCharacters = params.characters.filter((character) => (
      characterVariantFormLabel(character)
      && evidence.includes(characterVariantDisplayName(character))
    ));
    const cast = params.characters.filter((character) => {
      const display = characterVariantDisplayName(character);
      const aliases = characterVariantAliases(character);
      const base = characterVariantBaseName(character);
      if (!characterVariantFormLabel(character) && concreteFormCharacters.some((variant) => (
        characterVariantBaseName(variant) === base
      ))) return false;
      // Exact decorated names are authoritative. A base-name-only mention is
      // accepted only when this cast contains one form, preventing the
      // original card from stealing a transformed character's reference.
      if (display && evidence.includes(display)) return true;
      if (aliases.some((alias) => alias && alias !== characterVariantBaseName(character) && evidence.includes(alias))) return true;
      return Boolean(base && evidence.includes(base)
        && params.characters.filter((candidate) => characterVariantBaseName(candidate) === base).length === 1);
    });
    const castIds = new Set(cast.map((character) => character.id));
    // With no resolvable cast, retain the historical selected-reference
    // behavior. Once a variant is resolvable, omit sibling-form assets so the
    // video model receives the correct gender/species appearance card.
    const selected = cast.length
      ? eligible.filter((asset) => asset.role !== 'character' || !asset.sourceEntityId || castIds.has(asset.sourceEntityId))
      : eligible;
    return selected.slice(0, 6).map((asset) => asset.id);
  };
  if (params.aiPlan) {
    const sourceStoryBeats = extractStoryBeats(params.scene.content);
    let sourceSearchCursor = 0;
    return params.aiPlan.shots.map((plannedShot, index) => {
      const sourceExcerpt = plannedShot.sourceExcerpt.trim();
      const exactSourceRange = plannedShot.sourceLocationStatus !== 'unlocated'
        && sourceExcerpt && Number.isInteger(plannedShot.sourceStart) && Number.isInteger(plannedShot.sourceEnd)
        && plannedShot.sourceStart! >= 0 && plannedShot.sourceEnd! > plannedShot.sourceStart!
        && plannedShot.sourceEnd! <= params.scene.content.length
        && params.scene.content.slice(plannedShot.sourceStart, plannedShot.sourceEnd).trim() === sourceExcerpt;
      let sourceStart = exactSourceRange ? plannedShot.sourceStart! : -1;
      if (sourceStart < 0 && sourceExcerpt && plannedShot.sourceLocationStatus !== 'unlocated') {
        sourceStart = params.scene.content.indexOf(sourceExcerpt, sourceSearchCursor);
        if (sourceStart < 0) sourceStart = params.scene.content.indexOf(sourceExcerpt);
      }
      const located = sourceStart >= 0;
      const excerptSourceEnd = exactSourceRange ? plannedShot.sourceEnd! : sourceStart + sourceExcerpt.length;
      if (located) sourceSearchCursor = Math.max(sourceSearchCursor, excerptSourceEnd);
      const assignedSourceBeats = located ? sourceStoryBeats.filter(
        (beat) => beat.sourceEnd > sourceStart && beat.sourceStart < excerptSourceEnd,
      ) : [];
      const sourceBeatIds = assignedSourceBeats.map((beat) => beat.id);
      const sourceEnd = !exactSourceRange && assignedSourceBeats.length > 0
        ? Math.max(...assignedSourceBeats.map((beat) => beat.sourceEnd))
        : excerptSourceEnd;
      sourceStart = !exactSourceRange && assignedSourceBeats.length > 0
        ? Math.min(...assignedSourceBeats.map((beat) => beat.sourceStart))
        : sourceStart;
      const subject = normalizeStoryboardSubject(plannedShot.subject);
      if (!subject) throw new Error(`AI 分镜第 ${index + 1} 镜缺少可读取的主体字段`);
      const action = plannedShot.action.trim();
      const referenceAssetIds = referenceAssetIdsForShot(subject, action);
      return {
        id: createId('shot'),
        index: index + 1,
        startSec: plannedShot.startSec,
        endSec: plannedShot.endSec,
        purpose: plannedShot.purpose.trim(),
        subject,
        action,
        camera: plannedShot.camera.trim(),
        transition: plannedShot.transition.trim(),
        lighting: plannedShot.lighting.trim(),
        sound: plannedShot.sound.trim(),
        result: plannedShot.result.trim(),
        authoredBy: 'text-api',
        ...(plannedShot.visiblePrivatePartsByCharacter ? {
          visiblePrivatePartsByCharacter: Object.fromEntries(Object.entries(plannedShot.visiblePrivatePartsByCharacter)
            .map(([characterId, parts]) => [characterId, [...parts]])),
        } : {}),
        ...Object.fromEntries(['space', 'performance', 'direction', 'dialogue']
          .filter((field) => typeof plannedShot[field as keyof typeof plannedShot] === 'string')
          .map((field) => [field, String(plannedShot[field as keyof typeof plannedShot]).trim()])),
        sourceExcerpt,
        sourceBeatIds,
        ...(located ? { sourceStart, sourceEnd, ...(plannedShot.sourceLocationStatus ? { sourceLocationStatus: 'located' as const } : {}) } : { sourceLocationStatus: 'unlocated' as const }),
        referenceAssetIds,
        prompt: '',
        locked: false,
      };
    });
  }
  const sourceStoryBeats = extractStoryBeats(params.scene.content);
  const firstPersonSubject = resolveFirstPersonSubject(
    params.scene.content,
    params.characters.map((character) => character.name),
  );
  const semanticBeatCount = Math.max(1, sourceStoryBeats.length);
  const automaticCapacity = params.workflow === 'grid'
    ? 9
    : params.workflow === 'action' && semanticBeatCount === 1
      ? 5
      : semanticBeatCount;
  const effectiveShotCount = params.shotMode === 'auto'
    ? Math.min(Math.max(1, Math.floor(params.shotCount)), automaticCapacity)
    : params.shotCount;
  const timeline = allocateTimeline(
    params.durationSec,
    effectiveShotCount,
    params.workflow,
    dialogueHintsForTimeline(params.scene, effectiveShotCount),
  );
  const linkedCharacters = params.characters.filter((item) => params.scene.characterIds.includes(item.id));
  const narrativeCharacters = params.characters.filter((item) => (
    params.scene.characterIds.includes(item.id)
    || (item.name.trim() && params.scene.content.includes(item.name.trim()))
  ));
  const actorRelation = tokenizeActionBeats(params.scene.content)
    .map((beat) => parseSubjectActionTarget(beat, linkedCharacters.map((item) => item.name)))
    .find((item): item is SubjectActionTargetRelation => Boolean(item));
  const subject = actorRelation?.actor && !invalidTimelineSubject(actorRelation.actor)
    ? actorRelation.actor
    : pickSubject(params.scene, params.characters, params.locations, params.props);
  const primaryCharacter = actorRelation
    ? linkedCharacters.find((item) => item.name === actorRelation.actor || actorRelation.actor.includes(item.name) || item.name.includes(actorRelation.actor))
    : undefined;
  const motionEvidence = actorRelation
    ? [
        subject,
        primaryCharacter?.race,
        primaryCharacter?.appearance,
        primaryCharacter?.motionHabits,
        primaryCharacter?.negativeContinuity,
      ]
    : [
        subject,
        params.scene.content,
        params.scene.summary,
        ...linkedCharacters.flatMap((item) => [item.race, item.appearance, item.motionHabits, item.negativeContinuity]),
      ];
  const subjectMotionClass = inferSubjectMotionClass(motionEvidence.filter(Boolean).join('，'));
  const purposes = params.workflow === 'drama' ? dramaPurposes : params.workflow === 'action' ? actionPurposes : gridPurposes;
  let previousSourceSubject = '';
  return timeline.map((range, index) => {
    const assignedSourceBeats = storyBeatsForShot(sourceStoryBeats, timeline.length, index);
    const sourceBeatIds = assignedSourceBeats.map((beat) => beat.id);
    const sourceStart = assignedSourceBeats.length
      ? Math.min(...assignedSourceBeats.map((beat) => beat.sourceStart))
      : undefined;
    const sourceEnd = assignedSourceBeats.length
      ? Math.max(...assignedSourceBeats.map((beat) => beat.sourceEnd))
      : undefined;
    const sourceBeatSubject = subjectForAssignedSourceBeats(
      assignedSourceBeats.map((beat) => beat.text).join(''),
      params.scene,
      narrativeCharacters,
      previousSourceSubject,
    );
    previousSourceSubject = sourceBeatSubject;
    const stageIndex = params.workflow === 'grid'
      ? index
      : timeline.length <= 1
        ? purposes.length - 1
        : Math.round(index * (purposes.length - 1) / (timeline.length - 1));
    const mappedGridStates = params.workflow === 'grid' && params.gridStates?.length
      ? params.gridStates.slice(
          Math.min(params.gridStates.length - 1, Math.floor(index * params.gridStates.length / timeline.length)),
          Math.max(Math.min(params.gridStates.length, Math.floor((index + 1) * params.gridStates.length / timeline.length)), Math.min(params.gridStates.length, Math.floor(index * params.gridStates.length / timeline.length) + 1))
        )
      : [];
    const gridState = mappedGridStates[0];
    const purpose = gridState
      ? `九宫格 ${mappedGridStates.map((item) => item.index).join('—')} 格：${mappedGridStates.map((item) => item.subject || `状态${item.index}`).join(' → ')}`
      : params.workflow === 'grid' ? gridPurposeForShot(index, timeline.length) : purposes[stageIndex];
    const rawAction = gridState?.action || actionForShot(
      params.workflow,
      stageIndex,
      params.scene,
      timeline.length,
      index,
      subjectMotionClass,
      assignedSourceBeats.map((beat) => beat.text),
    );
    const action = firstPersonSubject
      ? rewriteNarrativeFirstPersonReferences(rawAction, firstPersonSubject)
      : rawAction;
    const paceDirection: Record<Pace, string> = {
      slow: '动作完整展开，切换留有观察和情绪余韵',
      standard: '动作与信息按清晰因果推进',
      tight: '减少停顿，在动作结果或信息触发点迅速切换',
      fast: '高密度推进，切点短促但必须保留动作结果'
    };
    const camera = gridState?.camera || (index === 0 ? `建立镜头，${params.camera}，${paceDirection[params.pace]}` : `${params.camera}，${paceDirection[params.pace]}，保持动作主体和接触点清晰`);
    const transition = gridState?.transition || (index === 0 ? '从环境或主体状态进入' : params.workflow === 'action' ? '在接触、遮挡、落地或方向匹配处切换' : '由新信息、视线、道具状态或行为决定触发切换');
    const lighting = gridState?.lighting || params.lighting || params.style.lighting;
    const sound = params.style.sound;
    const result = gridState?.result || (index === timeline.length - 1 ? '结尾保留可见行为结果或表情余波，不在高潮动作刚开始时结束' : '为下一镜保留明确的动作余势、视线目标或道具状态');
    const effectiveSubject = gridState?.subject || sourceBeatSubject;
    const refs = referenceAssetIdsForShot(effectiveSubject, action);
    return {
      id: createId('shot'),
      index: index + 1,
      startSec: range.startSec,
      endSec: range.endSec,
      purpose,
      subject: effectiveSubject,
      action,
      camera,
      transition,
      lighting,
      sound,
      result,
      sourceBeatIds,
      sourceStart,
      sourceEnd,
      referenceAssetIds: refs,
      prompt: '',
      locked: false
    };
  });
};

/** Build the transient reference-asset order from first use in shots. */
export const orderReferencedAssets = (shots: Array<Pick<VideoShot, 'referenceAssetIds'>>, assets: ReferenceAsset[]): ReferenceAsset[] => {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const seen = new Set<string>();
  const ordered: ReferenceAsset[] = [];
  shots.forEach((shot) => {
    shot.referenceAssetIds.forEach((id) => {
      const asset = byId.get(id);
      if (asset && !seen.has(id)) {
        seen.add(id);
        ordered.push(asset);
      }
    });
  });
  return ordered;
};

const stripTerminalPunctuation = (value: string): string => value.trim().replace(/[。！？!?；;]+$/u, '');

const normalizeProse = (value: string): string => value
  .replace(/(?:剧情|动作|故事)线索[：:]\s*/gu, '')
  .replace(/额外要求[：:]\s*/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

const directorTimestampPrecision = (shots: Array<Pick<VideoShot, 'startSec' | 'endSec'>>): number => (
  shots.some((shot) => shot.endSec - shot.startSec < 0.02) ? 3 : 2
);

const formatDirectorTimestamp = (value: number, precision = 2): string => (
  Math.abs(value) < 0.0005 ? '0' : Math.max(0, value).toFixed(precision)
);

const stripObsoleteReferenceSyntax = (value: string): string => value
  .replace(/（?@图片\d+）?/gu, '')
  .replace(/已绑定参考资产[“"][^”"]+[”"]/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

const internalPromptLine = /(?:^|\s)(?:场景：\s*剧情原文|本次没有参考图|本次参考图绑定|项目资料|固定连续性|固定人物：|固定场景：|固定道具：|本场景道具候选：|场景序列：|同一镜头组中的人物身份|画面执行重点|生成规则|内部匹配规则|执行顺序与自定义约束|制作说明|模型判断|转换器规则|导演模式|输入方式|时间线：)/u;

const promptBodyStart = /^(?:【\d|生成一段|总时长：|For the target video,|How the reference pictures align with the target video|integrated_multimodal_description:|subject_definitions:)/u;

/** Remove UI/debug metadata that must never be sent as the model-facing prompt. */
export const cleanVideoPrompt = (value: string): string => {
  let lines = String(value || '')
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*```(?:text|markdown)?\s*$/iu.test(line));
  const bodyIndex = lines.findIndex((line) => promptBodyStart.test(line.trim()));
  if (bodyIndex >= 0) lines = lines.slice(bodyIndex);
  return lines
    // A word such as “项目资料” inside an actual shot can be a prop, sign,
    // or dialogue. Metadata cleanup must never erase that entire AI shot.
    .filter((line) => /^\s*【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】/u.test(line) || !internalPromptLine.test(line))
    .filter((line) => !/^\s*(?:以下是|最终提示词如下|说明[:：]|备注[:：])/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
};

export const INVALID_TIMELINE_SUBJECT_PREFIX = /^(?:我|我们|咱们|我方|你|你们|您|各个|手中|原本|他们|她们|它们|就在|不过|此刻|那些|一部分|之前|于是|整个|当前|剧情|画面|镜头|这时|随后|突然|虽然|因为|如果|那是|它能|一方|更别|他|她|它|祂|的|着|人物|行为|主角|攻击|控制权|终结动作|角色|背部|头部|尾部|前爪|后爪|双腿|双手|低伏|俯身|弯腰|昂首|甩尾|踏裂|抬头|低头|冲向|爬出)/u;

/** The Chinese performance parentheses delimit the rendered subject. Spaces
 * and punctuation inside an explicit name are not word boundaries. */
const subjectFromTimelinePromptLine = (value: string): string => {
  const body = value.replace(/^【[^】]+】\s*/u, '');
  if (!body.startsWith('主体：@')) return '';
  const nameAndPerformance = body.slice('主体：@'.length);
  const directionAt = nameAndPerformance.indexOf('[朝向：');
  // Match the performance parentheses backwards from the structural marker,
  // allowing balanced parentheses inside either the name or performance.
  if (directionAt > 0 && nameAndPerformance[directionAt - 1] === '）') {
    let depth = 0;
    for (let index = directionAt - 1; index >= 0; index -= 1) {
      if (nameAndPerformance[index] === '）') depth += 1;
      if (nameAndPerformance[index] === '（') depth -= 1;
      if (depth === 0) return normalizeStoryboardSubject(nameAndPerformance.slice(0, index));
    }
  }
  return normalizeStoryboardSubject(nameAndPerformance.match(/^[^（；\r\n]+/u)?.[0] || '');
};

export const needsTimelinePromptMigration = (
  value: string,
  _ruleSet?: Pick<RuleSet, 'mode'>,
  _shots?: readonly Pick<VideoShot, 'authoredBy'>[],
): boolean => {
  const prompt = String(value || '').trim();
  return Boolean(prompt) && !/^【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】\s*主体：/u.test(prompt);
};

export interface StoryboardPromptValidationOptions {
  /** Retained for compatibility; content semantics are reviewed by the AI. */
  strictConversion?: boolean;
  /** Exact local prompt sent to the converter before it returned the candidate. */
  previousFinalPrompt?: string;
}

/** Validate only the editable timeline's technical contract. Character names,
 * narrative viewpoint, dialogue meaning and source coverage belong to the AI
 * and must not become local errors or warnings for any authoring source. */
export const validateStoryboardPrompt = (
  board: Pick<Storyboard, 'durationSec' | 'workflow' | 'inputMode' | 'shots' | 'finalPrompt' | 'ruleSetId'>
    & Partial<Pick<Storyboard, 'shotMode'>>,
  assets: ReferenceAsset[],
  _ruleSet?: Pick<RuleSet, 'mode'>,
  _options: StoryboardPromptValidationOptions = {},
): PromptValidationReport => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const shots = board.shots || [];
  if (!Number.isFinite(board.durationSec) || board.durationSec <= 0) errors.push('目标时长无效。');
  if (!shots.length) errors.push('没有可输出的镜头。');
  if (shots.length) {
    shots.forEach((shot, index) => {
      if (!Number.isFinite(shot.startSec) || !Number.isFinite(shot.endSec) || shot.endSec <= shot.startSec) errors.push(`第 ${index + 1} 镜时长无效。`);
    });
    const first = shots[0].startSec;
    const last = shots[shots.length - 1].endSec;
    if (Math.abs(first) > 0.01 || Math.abs(last - board.durationSec) > 0.01) errors.push('时间线没有从 0 秒完整覆盖到目标时长。');
    shots.slice(1).forEach((shot, index) => {
      const previous = shots[index];
      if (Math.abs(previous.endSec - shot.startSec) > 0.02) errors.push(`第 ${index + 1} 镜与第 ${index + 2} 镜之间存在时间缺口或重叠。`);
    });
  }
  if (board.workflow === 'grid') {
    const gridAssets = assets.filter((asset) => asset.role === 'grid' && shots.some((shot) => shot.referenceAssetIds.includes(asset.id)));
    if (!gridAssets.length) errors.push('九宫格模式没有绑定实际九宫格图片。');
    if (gridAssets.length && !gridAssets.some((asset) => asset.gridStates?.length === 9)) warnings.push('九宫格未完成 1—9 格视觉状态解析，当前使用通用状态模板。');
  }
  if (board.inputMode !== 'text' && !orderReferencedAssets(shots, assets).length) errors.push('参考图模式没有有效图片绑定。');
  const prompt = String(board.finalPrompt || '').replace(/\r\n?/gu, '\n').trim();
  if (!prompt.trim()) errors.push('最终提示词为空。');
  const timestampMatches = Array.from(prompt.matchAll(/^【(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s】\s*/gmu));
  const timestampPrecision = directorTimestampPrecision(shots);
  const exactTimestampTolerance = 10 ** (-(timestampPrecision + 1));
  if (shots.length && timestampMatches.length !== shots.length) errors.push(`提示词包含 ${timestampMatches.length} 个结构化时间段，但时间线共有 ${shots.length} 镜。`);
  timestampMatches.forEach((match, index) => {
    // Keep existing severity for numeric cue diagnostics; removing semantic
    // checks must not add a new hard gate to model-authored sound timelines.
    const cueTimeNotices = shots[index]?.authoredBy === 'text-api' ? warnings : errors;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) errors.push(`第 ${index + 1} 镜的起止时间无效。`);
    if (index === 0 && Math.abs(start) > 0.001) errors.push('第一镜必须从 0 秒开始。');
    if (index > 0) {
      const previousEnd = Number(timestampMatches[index - 1][2]);
      if (Math.abs(previousEnd - start) > 0.002) errors.push(`第 ${index} 镜与第 ${index + 1} 镜的时间戳存在缺口或重叠。`);
    }
    if (shots[index]) {
      const expectedStart = Number(formatDirectorTimestamp(shots[index].startSec, timestampPrecision));
      const expectedEnd = Number(formatDirectorTimestamp(shots[index].endSec, timestampPrecision));
      if (
        Math.abs(start - expectedStart) > exactTimestampTolerance
        || Math.abs(end - expectedEnd) > exactTimestampTolerance
      ) {
        errors.push(`第 ${index + 1} 镜的提示词时间边界必须与分镜卡片精确一致（应为 ${formatSeconds(expectedStart)}s-${formatSeconds(expectedEnd)}s）。`);
      }
    }
    const bodyStart = (match.index || 0) + match[0].length;
    const bodyEnd = timestampMatches[index + 1]?.index ?? prompt.length;
    const body = prompt.slice(bodyStart, bodyEnd).trim();
    const fields = ['主体：', '空间：', '光影：', '镜头：', '台词：', '音效：'];
    const fieldLocations = topLevelCanonicalFieldLocations(body);
    const indexes = fields.map((field) => fieldLocations.find((location) => location.field === field)?.start ?? -1);
    if (indexes.some((value) => value < 0) || indexes.some((value, fieldIndex) => fieldIndex > 0 && value <= indexes[fieldIndex - 1])) errors.push(`第 ${index + 1} 镜没有按顺序包含主体、空间、光影、镜头、台词、音效。`);
    const subjectField = body.slice(0, indexes[1] >= 0 ? indexes[1] : body.length);
    const subjectStructure = subjectField.match(/正在\s*\[([^\]]*)\]/u);
    const actionStages = (subjectStructure?.[1] || '').split('→').map((stage) => stage.trim());
    if (
      !subjectStructure
      || actionStages.length < 1
      || actionStages.some((stage) => !stage)
    ) {
      errors.push(`第 ${index + 1} 镜的主体字段缺少可解析的“正在 [可见动作]”结构。`);
    }
    if (body.includes('音效：')) {
      try {
        assertCanonicalPromptRelativeSoundCueTimes(
          body,
          end - start,
          `第 ${index + 1} 镜音效`,
        );
      } catch (error) {
        cueTimeNotices.push(error instanceof Error ? error.message : String(error));
      }
    }
    const dialogueField = canonicalDialogueField(body);
    let previousQuoteEnd = 0;
    const dialogueMatches = protectedTextQuoteSpans(dialogueField).flatMap((quote) => {
      const prefixStart = previousQuoteEnd;
      previousQuoteEnd = quote.end;
      const prefix = dialogueField.slice(prefixStart, quote.start);
      const cue = prefix.match(/(?:^|[|｜；;\n])\s*(?:第(-?\d+(?:\.\d+)?)\s*(?:s|秒)\s*)?@?([\p{L}\p{N}_·•-]{1,40})(?:[（(][^\n（）()]*[）)])?\s*[:：]\s*$/u);
      if (!cue) return [];
      return [{ offset: cue[1] === undefined ? undefined : Number(cue[1]), speakerCandidate: cue[2], text: quote.content }];
    });
    dialogueMatches.forEach((renderedDialogue) => {
      const localDuration = end - start;
      const offset = renderedDialogue.offset;
      if (offset !== undefined && (offset < 0 || offset > localDuration + 0.002)) {
        cueTimeNotices.push(`第 ${index + 1} 镜台词开始时刻超出本镜相对时间 0–${formatSeconds(localDuration)}s，应按剧情在本镜内安排。`);
      }
    });
  });
  if (timestampMatches.length && Math.abs(Number(timestampMatches[timestampMatches.length - 1][2]) - board.durationSec) > 0.002) errors.push('最后一镜没有准确结束在目标总时长。');
  if (board.shots.length && board.finalPrompt && board.shots.some((shot) => shot.endSec > board.durationSec + 0.01)) errors.push('镜头结束时间超过目标时长。');
  return { valid: !errors.length, errors: Array.from(new Set(errors)), warnings: Array.from(new Set(warnings)) };
};

const assetDescription = (asset: ReferenceAsset): string => {
  const detail = stripObsoleteReferenceSyntax(normalizeProse(asset.visualAnchor || asset.prompt || asset.tags.join('、')));
  return (detail || `保持“${asset.name}”在参考图中的身份、外观、材质、色彩和辨识特征`).slice(0, 260);
};

const assetRoleName = (asset: ReferenceAsset): string => {
  const roles: Record<ReferenceAsset['role'], string> = {
    character: '角色',
    scene: '场景环境',
    prop: '关键道具',
    grid: '分镜构图与连续状态',
    style: '视觉风格',
    'first-frame': '首帧画面',
    'last-frame': '尾帧画面',
    motion: '运动与动作轨迹',
    audio: '声音与节奏',
    composition: '构图与镜位'
  };
  return roles[asset.role];
};

export const referenceAssetManifest = (shots: Array<Pick<VideoShot, 'referenceAssetIds'>>, assets: ReferenceAsset[]): string => orderReferencedAssets(shots, assets)
  .map((asset) => `${asset.name}（${assetRoleName(asset)}锚定）`)
  .join('\n');

export interface VideoPromptRenderParams {
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audioMode: 'stereo' | 'none';
  workflow: Workflow;
  inputMode: InputMode;
  scene: Scene;
  globalLock: string;
  shots: VideoShot[];
  assets: ReferenceAsset[];
  style: StylePreset;
  ruleSet: RuleSet;
  converter: ConverterPreset;
  extra: string;
  directorStyleName?: string;
  directorStyleSummary?: string;
  cameraTerms?: string[];
  lightingTerms?: string[];
  visualStyle?: string;
  smartDirectorReason?: string;
  continuityIn?: string;
  continuityOut?: string;
  characters?: Character[];
  locations?: Location[];
  props?: Prop[];
}

export interface TimelineEntitySource {
  characters?: readonly Character[];
  locations?: readonly Location[];
  props?: readonly Prop[];
  /** Optional selected visual style used by one-shot previews and copies. */
  visualStyle?: string;
  /** Style-preset name used when a legacy board has no visualStyle field. */
  visualStyleFallback?: string;
  /** Editable StylePreset.visual body used by one-shot previews and copies. */
  styleVisual?: string;
}

/**
 * Intermediate representation for a model-facing prompt.
 *
 * The six-field timeline remains the canonical text output.  The IR keeps
 * generation parameters and user constraints alongside that text so adapters
 * can target different video models without reparsing prose.
 */
export interface PromptPlan {
  canonicalPrompt: string;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audioMode: 'stereo' | 'none';
  workflow: Workflow;
  inputMode: InputMode;
  shotIds: string[];
  referenceAssetIds: string[];
  constraints: string[];
  trace: {
    ruleSetId: string;
    converterId: string;
    styleId?: string;
    directorStyle?: string;
  };
}

const safeContextClause = (value: unknown, max = 120): string => String(value || '')
  .replace(/[\r\n]+/gu, ' ')
  .replace(/[{}<>`]/gu, '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max)
  .replace(/[，、；：:。,.\s]+$/u, '');

const formatProtectedTimelineAtom = (label: string, value: string): string => {
  const prefix = `${label}〔`;
  const suffix = '〕';
  const resolved = safeContextClause(value, 600 - prefix.length - suffix.length);
  if (!resolved) return '';
  const fieldSafe = resolved
    .replace(/【/gu, '〈')
    .replace(/】/gu, '〉')
    .replace(/\[/gu, '［')
    .replace(/\]/gu, '］')
    .replace(/(^|[，,；;]\s*)(主体|空间|光影|镜头|台词|音效)[：:]/gu, '$1$2·')
    .replace(/[，,；;]+/gu, '｜')
    .replace(/\s+/gu, '、');
  return `${prefix}${fieldSafe}${suffix}`;
};

const formatTimelineVisualStylePrompt = (value: string): string =>
  formatProtectedTimelineAtom('视觉风格锚点', resolveVisualStylePrompt(value));

const formatTimelinePresetVisualPrompt = (value: string): string =>
  formatProtectedTimelineAtom('风格预设视觉', value);

const globalLockForPromptContext = (
  globalLock: string,
  continuityIn = '',
): string => {
  const publicLock = publicVideoContinuityLock(globalLock);
  if (!sanitizeContinuityState(continuityIn, 'entry')) return publicLock;
  return publicLock
    .split(/\r?\n/u)
    .filter((line) => !/^\s*承接上一段\s*[：:]/u.test(line))
    .join('\n')
    .trim();
};

const promptContext = (params: VideoPromptRenderParams): string[] => {
  const nsfwDetail = usesNsfwDetailMode(params.scene.content, params.extra);
  const publicExtra = sanitizeNsfwGenerationControls(params.extra);
  const rawConstraintGlobalLock = globalLockForPromptContext(
    params.globalLock,
    params.continuityIn,
  );
  const constraintGlobalLock = nsfwDetail
    ? stripAutomaticAgeMetadata(rawConstraintGlobalLock)
    : rawConstraintGlobalLock;
  const constraints = [
    params.aspectRatio && `画幅${safeContextClause(params.aspectRatio, 20)}`,
    params.resolution && `分辨率${safeContextClause(params.resolution, 20)}`,
    params.directorStyleName && `导演风格${safeContextClause(params.directorStyleName, 28)}`,
    params.directorStyleSummary && `导演说明：${safeContextClause(params.directorStyleSummary, 220)}`,
    params.cameraTerms?.length ? `镜头偏好：${params.cameraTerms.map((item) => safeContextClause(item, 60)).filter(Boolean).join('、')}` : '',
    params.lightingTerms?.length ? `光影偏好：${params.lightingTerms.map((item) => safeContextClause(item, 60)).filter(Boolean).join('、')}` : '',
    publicExtra && `制作要求：${safeContextClause(publicExtra, 320)}`,
    constraintGlobalLock && `连续性锚点：${safeContextClause(constraintGlobalLock, 600)}`,
  ];
  return constraints.filter((item): item is string => Boolean(item));
};

const normalizedClause = (value: string): string => stripTerminalPunctuation(normalizeProse(value))
  .replace(/^[”"』]+|[“"『]+$/gu, '')
  .trim();

const compactClause = (value: string, max = 46): string => {
  const clean = normalizedClause(value);
  return clean.length > max ? `${clean.slice(0, max).replace(/[，、；：:\s]+$/u, '')}` : clean;
};

interface TimelineRenderContext {
  scene: Scene;
  assets: readonly ReferenceAsset[];
  characters: readonly Character[];
  locations: readonly Location[];
  props: readonly Prop[];
}

interface TimelineShotEntities {
  character?: Character;
  location?: Location;
  prop?: Prop;
}

interface TimelineMotionContext {
  kind: SubjectMotionClass;
  identityAnchor: string;
  genderAnchor: string;
}

const buildTimelineRenderContext = (
  scene: Scene,
  assets: readonly ReferenceAsset[],
  characters: readonly Character[] = [],
  locations: readonly Location[] = [],
  props: readonly Prop[] = [],
): TimelineRenderContext => ({ scene, assets, characters, locations, props });

const resolveTimelineShotEntities = (
  shot: VideoShot,
  context: TimelineRenderContext,
): TimelineShotEntities => {
  const referencedAssets = shot.referenceAssetIds
    .map((id) => context.assets.find((asset) => asset.id === id))
    .filter((asset): asset is ReferenceAsset => Boolean(asset));
  const text = `${shot.subject}${shot.action}`;
  const referencedEntity = <T extends { id: string; name: string }>(
    kind: NonNullable<ReferenceAsset['sourceEntityKind']>,
    entries: readonly T[],
  ): T | undefined => {
    const entityId = referencedAssets.find((asset) => asset.sourceEntityKind === kind)?.sourceEntityId;
    return entityId
      ? entries.find((entry) => entry.id === entityId && !storyboardSubjectValidationError(entry.name))
      : undefined;
  };
  const mentionedEntity = <T extends { name: string }>(entries: readonly T[]): T | undefined => entries
    .filter((entry) => !storyboardSubjectValidationError(entry.name))
    .sort((left, right) => right.name.length - left.name.length)
    .find((entry) => text.includes(entry.name));
  const locationIds = new Set(
    context.scene.locationIds?.length
      ? context.scene.locationIds
      : context.scene.locationId
        ? [context.scene.locationId]
        : [],
  );
  const linkedLocations = context.locations.filter((entry) => locationIds.has(entry.id));
  const linkedProps = context.props.filter((entry) => context.scene.propIds.includes(entry.id));
  const characterByName = (value: string): Character | undefined => {
    const name = normalizeStoryboardSubject(value);
    if (storyboardSubjectValidationError(name)) return undefined;
    const characters = context.characters.filter((entry) => !storyboardSubjectValidationError(entry.name));
    // Prefer an exact form-aware identity.  A transformed character must not
    // fall back to the original card merely because both records share a
    // narrative base name.
    const exact = characters.find((entry) => characterVariantMatches(entry, name));
    if (exact) return exact;
    const sameBase = characters.filter((entry) => (
      characterVariantBaseName(entry) === name
    ));
    if (sameBase.length === 1) return sameBase[0];
    // Legacy prose may include a longer subject phrase. Only accept an alias
    // when it resolves to one card; ambiguous forms remain unresolved until
    // the shot's explicit referenceAssetId supplies the identity.
    const fuzzy = characters.filter((entry) => characterVariantAliases(entry).some((alias) => (
      name.includes(alias) || alias.includes(name)
    )));
    if (fuzzy.length === 1) return fuzzy[0];
    // A relation may use a quantity-bearing surface form ("一群敌人") while
    // the character card stores the reusable group name ("敌人们"). Resolve
    // that form only when it maps to one card, so a plural actor cannot steal
    // another character's identity through a broad substring match.
    const quantityNormalized = characters.filter((entry) => relationActorNamesMatch(entry.name, name));
    return quantityNormalized.length === 1 ? quantityNormalized[0] : undefined;
  };
  const relation = parseSubjectActionTarget(shot.action, context.characters.map((entry) => entry.name));
  const relationCharacter = characterByName(relation?.actor || '');
  const dialogueCharacter = characterByName(sourceDialoguesFromText(shot.action)[0]?.speakerCandidate || '');
  const localNarrativeCharacter = characterByName(
    strongNarrativeSubject(shot.action, context.scene, [...context.characters])
      || actorNameFromClause(shot.action),
  );
  const declaredSubject = normalizeStoryboardSubject(shot.subject);
  const subjectCharacter = characterByName(declaredSubject);
  const hasSpecificDeclaredSubject = Boolean(
    declaredSubject
    && !storyboardSubjectValidationError(declaredSubject)
    && !/^(?:环境主体|剧情主体|当前场景)$/u.test(declaredSubject),
  );
  const declaredSubjectIsConcreteVariant = Boolean(
    subjectCharacter && characterVariantFormLabel(subjectCharacter),
  );
  return {
    character: declaredSubjectIsConcreteVariant
      ? subjectCharacter
      : relationCharacter
      || dialogueCharacter
      || localNarrativeCharacter
      || subjectCharacter
      // Merely being mentioned is only a local actor-extraction hint. Keep
      // its legacy prose filter; exact declared names above are authoritative.
      || (!hasSpecificDeclaredSubject ? mentionedEntity(context.characters.filter((entry) => !invalidTimelineSubject(entry.name))) : undefined)
      || (!hasSpecificDeclaredSubject ? referencedEntity('character', context.characters) : undefined),
    location: referencedEntity('location', context.locations)
      || mentionedEntity(context.locations)
      || (linkedLocations.length === 1 ? linkedLocations[0] : undefined),
    prop: referencedEntity('prop', context.props)
      || mentionedEntity(context.props)
      || (linkedProps.length === 1 ? linkedProps[0] : undefined),
  };
};

const motionContextForTimeline = (
  shot: VideoShot,
  context: TimelineRenderContext,
  entities: TimelineShotEntities,
  subject: string,
): TimelineMotionContext => {
  // An action performer can be present while the selected visual subject is
  // a portrait, place, object or group. Only identity facts belonging to the
  // final rendered subject may become that subject's anatomy/gender anchors.
  const normalizedSubject = normalizeStoryboardSubject(subject);
  const exactCharacter = context.characters.find((entry): entry is Character => Boolean(
    entry
    && !storyboardSubjectValidationError(entry.name)
    && characterVariantMatches(entry, normalizedSubject),
  ));
  // The reference binding is authoritative when a legacy shot still uses the
  // shared base name. It is safe to use it only after checking the explicit
  // subject; otherwise the original and transformed cards could be merged.
  const subjectIsGeneric = !normalizedSubject
    || /^(?:环境主体|剧情主体|当前场景)$/u.test(normalizedSubject);
  const character = exactCharacter
    || (subjectIsGeneric ? entities.character : undefined)
    || context.characters.find((entry) => (
      characterVariantBaseName(entry) === normalizedSubject
        && context.characters.filter((candidate) => characterVariantBaseName(candidate) === normalizedSubject).length === 1
    ));
  const characterAsset = shot.referenceAssetIds
    .map((id) => context.assets.find((asset) => asset.id === id))
    .find((asset) => asset?.role === 'character' && (
      normalizeStoryboardSubject(asset.name) === normalizedSubject
      || character && asset.sourceEntityKind === 'character' && asset.sourceEntityId === character.id
    ));
  const actorEvidence = [
    subject,
    ...characterVariantPromptFacts(character || entities.character || {}),
    character?.gender,
    character?.race,
    character?.appearance,
    character?.motionHabits,
    character?.negativeContinuity,
    characterAsset?.visualAnchor,
    characterAsset?.prompt,
  ].filter(Boolean).join('，');
  const evidence = actorEvidence && !/^(?:环境主体|剧情主体|当前场景)$/u.test(subject)
    ? actorEvidence
    : [actorEvidence, shot.subject, shot.action, context.scene.summary, context.scene.content].filter(Boolean).join('，');
  const kind = inferSubjectMotionClass(evidence);
  const variantAnchor = characterVariantPromptFacts(character || entities.character || {}).join('，');
  const morphologyAnchor = kind === 'human' || kind === 'humanoid'
    ? ''
    : [
        character?.race,
        character?.appearance,
        character?.motionHabits,
        characterAsset?.visualAnchor,
      ].filter(Boolean).join('，') || subject;
  const identityAnchor = compactClause(
    [variantAnchor, morphologyAnchor].filter(Boolean).join('，'),
    110,
  );
  const genderAnchor = compactClause(character?.gender || '', 40);
  // The AI-authored shot already carries any necessary visible detail. A
  // profile-wide anchor must not become a new action or exposure instruction.
  return { kind, identityAnchor, genderAnchor };
};

const normalizeTimelineSubject = (value: string): string => {
  let name = value
    .replace(/^@/u, '')
    .replace(/^(?:一头|一只|一条|一匹|一群|这头|这只|这条)/u, '')
    .replace(/^(?:(?:对(?!手|方)|将(?!军)|向(?!阳)|朝(?!歌|阳|夕))|[着把被给从于在往])+/u, '')
    .trim();
  name = name.replace(/的$/u, '').trim();
  const canonicalRole = name.match(/([\u4e00-\u9fffA-Za-z0-9·]{0,10}(?:兵团|军团|车队|队伍|玩家们|士兵们|人群))$/u)?.[1];
  if (canonicalRole) name = canonicalRole;
  if (name.includes('的')) {
    const suffix = name.split('的').pop()?.trim() || '';
    if (suffix.length >= 2 && suffix.length <= 12) name = suffix;
  }
  name = name.replace(/^(.{2,8})在兵团$/u, '$1');
  return name.replace(/^(?:狂热|惊恐|愤怒|年轻|中年|当前|主要)+/u, '').trim();
};

const creatureNameFromText = (value: string): string => {
  const match = normalizeProse(value).match(
    /(?:一头|一只|一条|一匹|一群|这头|这只|这条)?([^，。！？；\s]{1,16}?(?:甲壳巨兽|触手怪兽|机械巨兽|飞行巨兽|怪兽|巨兽|异兽|魔兽|巨龙|飞龙|恶龙|机械兽))(?=从|在|向|朝|由|沿|用|猛|缓|骤|突|冲|爬|飞|走|跑|扑|，|。|！|？|；|\s|$)/u,
  )?.[1] || '';
  return normalizeTimelineSubject(match);
};

export const invalidTimelineSubject = (value: string): boolean => {
  const name = normalizeTimelineSubject(value);
  return !name
    || name.length < 2
    || name.length > 12
    || INVALID_TIMELINE_SUBJECT_PREFIX.test(name)
    || /(?:装备|计划中|观测|同一时间|方向|区域|时候|声音|一方|夜晚|动作|结果落地|攻击距离|被格挡|反转|命中)$/u.test(name);
};

const actorNameFromClause = (value: string): string => {
  const clean = normalizeProse(value).replace(/[“"][^”"]*[”"]/gu, '').replace(/^[，。！？；：\s]+/u, '').trim();
  const relation = parseSubjectActionTarget(clean);
  if (relation && !invalidTimelineSubject(relation.actor)) return normalizeTimelineSubject(relation.actor);
  const creature = creatureNameFromText(clean);
  if (creature && !invalidTimelineSubject(creature)) return creature;
  const head = clean.split(/[，。！？；：]/u)[0] || clean;
  const carried = head.match(/(?:载着|坐着|站着|聚集着)([^，；。]{2,10}们)(?=冲|跑|走|抓|吼|喊|挥|站|扑|涌)/u)?.[1];
  if (carried) return normalizeTimelineSubject(carried);
  const beforeAction = head.split(/(?=猛然|猛(?=砸|抓|打|推|扯|撞|冲)|骤然|缓慢|突然|轻轻|低声|大声|用威严|惊恐|愤怒|暴怒|朝|向|抬|低|看|望|转|握|抓|冲|跑|走|站|跪|倒|伸|扭|砸|说|问|吼|喊|回答|发出|鼓胀|破土|刺入|涌向)/u)[0]
    .replace(/的(?:巨型|手中|声音|目光|身体|指尖|面部).*$/u, '').trim();
  if (!invalidTimelineSubject(beforeAction)) return normalizeTimelineSubject(beforeAction);
  return '';
};

const timelineActorCandidates = (scene: Scene, characters: Character[]): string[] => {
  const linkedIds = new Set(scene.characterIds);
  const story = scene.content || '';
  const names = characters
    .filter((item) => linkedIds.has(item.id) || story.includes(item.name))
    .map((item) => item.name || '')
    .filter((name) => !invalidTimelineSubject(name));
  const roleMatches = (story.match(/[\u4e00-\u9fffA-Za-z0-9·]{0,10}(?:兵团|军团|车队|队伍|玩家们|士兵们|人群)/gu) || []).map(normalizeTimelineSubject);
  const creatureMatches = story
    .split(/[。！？!?；;]/u)
    .map(creatureNameFromText)
    .filter((name) => !invalidTimelineSubject(name));
  const namedActions = (story.match(/[\u4e00-\u9fffA-Za-z0-9·]{2,8}(?=(?:猛然|骤然|低声|大声|朝着|朝|向|抬|看|望|转|握|抓|冲|跑|走|站|跪|倒|说|问|吼|喊|回答|发出呼唤|鼓胀|破土))/gu) || []).map(normalizeTimelineSubject);
  const spoken = story.split(/[。！？!?]/u).flatMap((sentence) => sentence.split(/[，,]/u)).map((clause) => {
    const verbIndex = clause.search(/(?:低声说道|低声说|大声吼道|说道|回答道|回答|答道|问道|吼道|喊道|说|问|喊|发出呼唤)/u);
    if (verbIndex < 0) return '';
    const prefix = clause.slice(0, verbIndex).replace(/^[“”"'\s]+/u, '').trim();
    return prefix.split(/(?:在|朝着|朝|向|用|低声|大声|手中)/u)[0]?.trim() || '';
  }).filter((name) => !invalidTimelineSubject(name));
  return Array.from(new Set([...names, ...creatureMatches, ...roleMatches, ...namedActions, ...spoken].map(normalizeTimelineSubject).filter((name) => !invalidTimelineSubject(name))));
};

const dialogueSpeakerFromScene = (scene: Scene, dialogue: string, characters: Character[] = []): string => {
  const source = scene.content || '';
  const index = source.indexOf(dialogue);
  if (index < 0) return '';
  const prefix = source.slice(Math.max(0, index - 100), index);
  const suffix = source.slice(index + dialogue.length, index + dialogue.length + 80);
  const before = cleanSpeechSpeakerCandidate(prefix.match(SPEAKER_CUE_TAIL)?.[1] || '');
  const after = cleanSpeechSpeakerCandidate(suffix.match(SPEAKER_CUE_HEAD)?.[1] || '');
  const directCandidate = normalizeTimelineSubject(before || after);
  if (!invalidTimelineSubject(directCandidate)) return directCandidate;
  const fullPrefix = source.slice(0, index);
  // A pronoun-led reply inherits the preceding narrative performer, not the
  // last person who happens to be present in the character library. Resolve
  // this only with a real speech cue so reaction shots/other speakers remain independent.
  const pronounCue = fullPrefix.match(new RegExp(
    `(?:^|[。！？!?；;\\n])\\s*((?:他们|她们|它们|他|她|它|祂)[^。！？!?；;\\n]*?(?:${SOURCE_SPEECH_CUE_PATTERN}))[：:，,。！？!?\\s“”"'‘’「」『』]*$`,
    'u',
  ));
  if (pronounCue && pronounCue.index !== undefined) {
    const beforeCue = source.slice(0, pronounCue.index);
    const withoutQuotedSpeech = protectedTextQuoteSpans(beforeCue).reduceRight(
      (text, quote) => text.slice(0, quote.start)
        + ' '.repeat(quote.end - quote.start - 1)
        + (/[。！？!?]\s*$/u.test(quote.content) ? '。' : ' ')
        + text.slice(quote.end),
      beforeCue,
    );
    const clauses = withoutQuotedSpeech.split(/[。！？!?；;\n]/u).map(normalizeProse).filter(Boolean).reverse();
    for (const clause of clauses) {
      if (/^(?:他们|她们|它们|他|她|它|祂)/u.test(clause)) continue;
      const antecedent = strongNarrativeSubject(clause, scene, characters) || actorNameFromClause(clause);
      if (antecedent && !invalidTimelineSubject(antecedent)) return normalizeTimelineSubject(antecedent);
    }
  }
  const knownSpeaker = characters
    .map((item) => ({ name: normalizeTimelineSubject(item.name), at: fullPrefix.lastIndexOf(item.name) }))
    .filter((item) => item.at >= 0 && !invalidTimelineSubject(item.name))
    .sort((a, b) => b.at - a.at)[0];
  if (knownSpeaker && index - knownSpeaker.at <= 220) return knownSpeaker.name;
  return '';
};

const subjectNameForTimeline = (
  shot: VideoShot,
  context: TimelineRenderContext,
  entities: TimelineShotEntities,
  previousSubject = '',
): string => {
  const action = normalizeProse(shot.action);
  const declaredSubject = normalizeStoryboardSubject(shot.subject);
  if (shot.authoredBy === 'text-api' && declaredSubject) return declaredSubject;
  const declaredSubjectIsGeneric = /^(?:环境主体|剧情主体|当前场景)$/u.test(declaredSubject);
  const declaredSubjectError = storyboardSubjectValidationError(declaredSubject);
  // Older local drafts occasionally stored a whole action as the subject.
  // This narrow recovery does not classify real names such as 人物画像 by a
  // shared prefix, or shorten an explicit group/object/environment focus.
  const legacyNarrativeSubject = /^(?:人物|角色)(?:正在|完成|进行|缩短|拉开)/u.test(declaredSubject);
  if (!declaredSubjectError && !declaredSubjectIsGeneric && !legacyNarrativeSubject) {
    const namedDeclaredCharacter = context.characters.find((entry) => (
      characterVariantMatches(entry, declaredSubject)
    )) || (() => {
      const baseMatches = context.characters.filter((entry) => characterVariantBaseName(entry) === declaredSubject);
      return baseMatches.length === 1 ? baseMatches[0] : undefined;
    })();
    const localCharacter = entities.character;
    const actionRelation = parseSubjectActionTarget(action, context.characters.map((entry) => entry.name));
    const relationActor = actionRelation?.actor || '';
    const relationCharacter = relationActor
      ? context.characters.find((entry) => relationActorNamesMatch(entry.name, relationActor))
      : undefined;
    const explicitLocalActor = relationCharacter || localCharacter;
    // Preserve the existing stale-character correction only when the declared
    // subject is one known character and another known character explicitly
    // performs the action. Quantity words ("一群", "数名") and plural
    // endings are surface grammar, not a reason to lose the actor. Reference
    // ordering and object mentions cannot win.
    const explicitActorStartsAction = Boolean(
      explicitLocalActor
      && (actionStartsWithRelationActor(action, explicitLocalActor.name)
        || action.startsWith(normalizeStoryboardSubject(explicitLocalActor.name))),
    );
    if (namedDeclaredCharacter && explicitLocalActor && explicitLocalActor.id !== namedDeclaredCharacter.id
      && !characterVariantFormLabel(namedDeclaredCharacter)
      && (relationActor ? relationActorNamesMatch(explicitLocalActor.name, relationActor) : explicitActorStartsAction)
      && explicitActorStartsAction
      && !storyboardSubjectValidationError(explicitLocalActor.name)) {
      return characterVariantDisplayName(explicitLocalActor) || normalizeStoryboardSubject(explicitLocalActor.name);
    }
    return declaredSubject;
  }
  const characterAsset = shot.referenceAssetIds
    .map((id) => context.assets.find((asset) => asset.id === id))
    .find((asset) => asset?.role === 'character');
  if (entities.character?.name && !storyboardSubjectValidationError(entities.character.name)) {
    return characterVariantDisplayName(entities.character) || normalizeStoryboardSubject(entities.character.name);
  }
  if (characterAsset?.name && !storyboardSubjectValidationError(characterAsset.name)) {
    return normalizeStoryboardSubject(characterAsset.name);
  }
  const candidates = timelineActorCandidates(context.scene, [...context.characters]);
  const dialogue = sourceDialoguesFromText(action)[0];
  const cueSpeaker = dialogue ? normalizeTimelineSubject(dialogue.speakerCandidate) : '';
  if (cueSpeaker && !invalidTimelineSubject(cueSpeaker)) return cueSpeaker;
  if (dialogue && !declaredSubjectError && !legacyNarrativeSubject) {
    return declaredSubject;
  }
  const contextualDialogueSpeaker = dialogue
    ? normalizeTimelineSubject(
        dialogueSpeakerFromScene(context.scene, dialogue.text, [...context.characters]),
      )
    : '';
  if (contextualDialogueSpeaker && !invalidTimelineSubject(contextualDialogueSpeaker)) {
    return contextualDialogueSpeaker;
  }
  const locallyGroundedSubject = strongNarrativeSubject(
    action,
    context.scene,
    [...context.characters],
  );
  if (locallyGroundedSubject) return locallyGroundedSubject;
  if (declaredSubjectIsGeneric) return declaredSubject;
  if (/^(?:他|她|它|祂|他们|她们|它们|其次|原本|于是)/u.test(action) && previousSubject && !storyboardSubjectValidationError(previousSubject)) {
    return normalizeStoryboardSubject(previousSubject);
  }
  const relation = parseSubjectActionTarget(action, candidates);
  const relationActor = relation && !invalidTimelineSubject(relation.actor)
    ? normalizeTimelineSubject(relation.actor)
    : '';
  const knownRelationActor = relationActor
    ? candidates.find((name) => name === relationActor || name.includes(relationActor) || relationActor.includes(name))
    : undefined;
  if (knownRelationActor) return knownRelationActor;
  if (relationActor && !previousSubject) return relationActor;
  const direct = candidates.find((name) => action.includes(name));
  if (direct) return direct;
  if (/枪|火炮|卡车|冲锋|阵地|步枪|手雷|战役|队伍|军团|兵团/u.test(action)) {
    const group = candidates.find((name) => /(?:兵团|军团|车队|队伍|玩家们|士兵们|人群|团队)/u.test(name));
    if (group) return group;
  }
  // An action-only continuation such as “背部骨刺张开” or “低伏冲向…”
  // has no new actor. Keep the established subject instead of promoting a
  // body part, posture, or adverb returned by the permissive local parser.
  if (previousSubject && !storyboardSubjectValidationError(previousSubject)) {
    return normalizeStoryboardSubject(previousSubject);
  }
  const actor = actorNameFromClause(action);
  const matchedActor = actor
    ? candidates.find((name) => name === actor || name.includes(actor) || actor.includes(name))
    : undefined;
  if (matchedActor) return matchedActor;
  return !declaredSubjectError && !legacyNarrativeSubject
    ? declaredSubject
    : '环境主体';
};

const performanceForTimeline = (
  shot: VideoShot,
  motion: TimelineMotionContext,
  includeIdentity: boolean,
): string => {
  const text = `${shot.purpose}${shot.action}${shot.result}`;
  const humanLike = motion.kind === 'human' || motion.kind === 'humanoid';
  let state = '专注';
  if (!humanLike) {
    const states: Record<Exclude<SubjectMotionClass, 'human' | 'humanoid'>, string> = {
      quadruped: /冲|扑|攻击/u.test(text) ? '脊背压低，足爪蓄力' : '四足受力稳定',
      winged: /冲|扑|攻击|俯冲/u.test(text) ? '翼膜绷紧' : '双翼保持张力',
      serpentine: /冲|攻击|缠/u.test(text) ? '长躯盘紧' : '躯干连续波动',
      tentacled: /冲|攻击|卷|拖/u.test(text) ? '触肢绷紧' : '触肢缓慢收缩',
      insectoid: /冲|攻击|撞|踏/u.test(text) ? '多足压低，甲壳起伏' : '节肢交替支撑',
      amorphous: /冲|攻击|拖/u.test(text) ? '表面收缩，质量前移' : '胶质表面缓慢起伏',
      mechanical: /冲|攻击|撞/u.test(text) ? '关节蓄力，驱动器增压' : '机械关节稳定运转',
      'unknown-nonhuman': /冲|攻击|撞/u.test(text) ? '非人躯体蓄力' : '非人解剖结构保持稳定',
    };
    state = states[motion.kind as Exclude<SubjectMotionClass, 'human' | 'humanoid'>];
  } else if (/威严|压迫/u.test(text)) state = '威严';
  else if (/吼道|怒吼|猛砸|砸车|砸钢|暴怒|愤怒|嘶吼|狂怒|咆哮/u.test(text)) state = '暴怒';
  else if (/我需要.{0,6}帮助|望向北方|仍然不安|不安|疑虑|惴惴|怀疑|警觉/u.test(text)) state = '不安';
  else if (/惊恐|惊慌|恐惧|颤抖|危机/u.test(text)) state = '惊恐';
  else if (/悲伤|不舍|哀伤|失去/u.test(text)) state = '悲痛';
  else if (/决绝|冲锋|攻击|终结|反击/u.test(text)) state = '决绝';
  else if (/震惊|发现|真相/u.test(text)) state = '震惊';
  else if (/平静|克制|观察|沉默/u.test(text)) state = '克制';
  const identity = [
    motion.genderAnchor ? `性别设定〔${motion.genderAnchor}〕` : '',
    includeIdentity && motion.identityAnchor ? motion.identityAnchor : '',
  ].filter(Boolean);
  if (!identity.length) return state;
  if (!identity.some((item) => item.includes(state))) identity.push(state);
  return identity.join('，');
};

const isObservationAnalysisTimeline = (value: string): boolean => (
  /(?:分析终端|观测数据|观测轨迹)/u.test(value)
  && /(?:回传|汇聚|标记|分析)/u.test(value)
);

/** Resolve the directional relation that must survive into the video prompt.
 * Local kinetic stages often omit the actor name because it is already the
 * `主体`, so relation parsing first checks the full actor→target form and then
 * recovers a target from a verb such as “冲向夏提雅”. */
const relationForTimelineShot = (
  shot: VideoShot,
  subject: string,
  actorCandidates: readonly string[] = [],
): SubjectActionTargetRelation | undefined => {
  const source = actionWithoutDialogue(shot.action);
  const parsed = parseSubjectActionTarget(source, actorCandidates.length ? actorCandidates : (subject ? [subject] : []));
  if (parsed?.target) return parsed;
  const targetMatch = source.match(new RegExp(`(${RELATION_ACTION_SOURCE})([^，。！？；→]{1,28})`, 'u'));
  const target = cleanRelationEntity(targetMatch?.[2] || '');
  if (!target || !targetMatch?.[1]) return undefined;
  return {
    actor: subject || '主体',
    verb: targetMatch[1],
    target,
  };
};

const directionForTimeline = (
  shot: VideoShot,
  motion: TimelineMotionContext,
  subject = '',
  actorCandidates: readonly string[] = [],
): string => {
  const text = `${shot.action}${shot.camera}`;
  const humanLike = motion.kind === 'human' || motion.kind === 'humanoid';
  if (isObservationAnalysisTimeline(text)) {
    const conclusion = shot.action.match(/→([^→]{1,48}?)被(?:高亮)?标记/u)?.[1]?.trim();
    return `观测视轴聚焦${conclusion || '分析终端的结论标记'}`;
  }
  const relation = relationForTimelineShot(shot, subject, actorCandidates);
  if (relation) {
    const orientation = humanLike ? '面朝' : '躯体运动轴线指向';
    return `${orientation}${relation.target}（动作关系：${relation.actor}${relation.verb}${relation.target}）`;
  }
  const direction = /画面?右|向右/u.test(text) ? '画右'
    : /画面?左|向左/u.test(text) ? '画左'
      : /后方|回头|身后/u.test(text) ? '后方'
        : /上方|抬头|仰望/u.test(text) ? '上方'
          : /下方|低头|俯视/u.test(text) ? '下方'
            : /前方|向前|冲锋|追击/u.test(text) ? '前方'
              : '画面纵深';
  return humanLike ? `面朝${direction}` : `躯体运动轴线指向${direction}`;
};

/**
 * Keep dialogue in the untouched shot.action for dialogueForTimeline, while
 * removing only cue-backed speech from the visible physical action chain.
 * Quoted entity names, signs and labels remain visible evidence. Closing
 * dialogue fragments are discarded through their final orphan closer;
 * opening fragments are discarded from their first orphan opener onward.
 */
const actionWithoutDialogue = (value: string): string => {
  const source = normalizeProse(value);
  let action = '';
  let cursor = 0;
  let previousDialogueEnd = -1;
  let previousSpeaker = '';
  for (const match of source.matchAll(QUOTED_SPAN_PATTERN)) {
    if (match.index === undefined) continue;
    const quoteEnd = match.index + match[0].length;
    const text = match.slice(1).find((part) => typeof part === 'string')?.trim() || '';
    const context = classifyQuotedSpeechContext(
      source,
      match.index,
      quoteEnd,
      previousDialogueEnd,
      previousSpeaker,
    );
    action += source.slice(cursor, match.index);
    action += context.isDialogue ? '。' : text;
    cursor = quoteEnd;
    if (context.isDialogue) {
      previousDialogueEnd = quoteEnd;
      previousSpeaker = context.speakerCandidate;
    } else {
      previousDialogueEnd = -1;
      previousSpeaker = '';
    }
  }
  action += source.slice(cursor);

  const orphanClosers = [...action.matchAll(/[”’」』]/gu)];
  const finalOrphanCloser = orphanClosers[orphanClosers.length - 1];
  if (finalOrphanCloser?.index !== undefined) {
    const beforeCloser = action.slice(0, finalOrphanCloser.index);
    const afterCloser = action.slice(finalOrphanCloser.index + finalOrphanCloser[0].length);
    const hasVisibleInscription = /(?:门牌|路牌|标牌|招牌|木牌|告示|标语|标签|屏幕|终端|仪表|地图|墙面|纸条).{0,24}(?:写着|刻着|印着|标着|显示着?|标有|题有)/u.test(beforeCloser)
      || /(?:写着|刻着|印着|标着|显示着?|标有|题有)[^，。；]{1,32}$/u.test(beforeCloser);
    const hasDialogueTailEvidence = /[。！？!?]\s*$/u.test(beforeCloser)
      || /(?:对讲机|通讯频道|电话|回答|说道|吼道|喊道|问道|大声说|低声说)/u.test(`${beforeCloser}${afterCloser}`);
    action = hasDialogueTailEvidence && !hasVisibleInscription
      ? afterCloser
      : `${beforeCloser}${afterCloser}`;
  }
  const orphanOpenerIndex = action.search(/[“‘「『]/u);
  if (orphanOpenerIndex >= 0) action = action.slice(0, orphanOpenerIndex);

  // A lone ASCII quote is directionally ambiguous. Speech cues and a leading
  // quote identify an opener; sentence punctuation immediately before it
  // identifies a closing dialogue fragment. Otherwise neutralise the quote.
  const asciiQuoteIndex = action.indexOf('"');
  if (asciiQuoteIndex >= 0) {
    const before = action.slice(0, asciiQuoteIndex);
    const after = action.slice(asciiQuoteIndex + 1);
    if (!before.trim() || SPEECH_CUE_TAIL.test(before)) action = before;
    else if (/[。！？!?]\s*$/u.test(before)) action = after;
    else action = `${before} ${after}`;
  }

  return action
    .replace(/[“”"‘’「」『』]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const actionChainForTimeline = (shot: VideoShot, _motion: TimelineMotionContext, subject: string): string => {
  const escapedSubject = escapeRegExp(subject);
  const actor = new RegExp(`^(?:一头|一只|一条|一匹|一群)?${escapedSubject}`, 'u').test(normalizeProse(shot.action))
    ? subject
    : '';
  const actionSource = actionWithoutDialogue(shot.action);
  const action = normalizedClause(actionSource)
    .replace(/(?:低声说道|低声说|大声吼道|用威严的声音回答|说道|回答道|回答|答道|询问|问道|吼道|喊道|说|问|喊|发出呼唤)[：:，,。！？!?]?/gu, '')
    .replace(/；镜头重点表现.*$/u, '')
    .replace(/^[^，；]{0,18}(?:剧情发展为|动作发展为)/u, '')
    .trim();
  const sourceParts = action.split(/[→；，。]/u)
    .map((item) => normalizedClause(item)
      .replace(actor ? new RegExp(`^(?:一头|一只|一条|一匹|一群)?${escapeRegExp(actor)}`, 'u') : /$^/u, '')
      .replace(/^的/u, '')
      .trim())
    .filter((item) => {
      const speechAttributionResidue = new RegExp(
        `^(?:(?:随后|然后|接着|紧接着)\\s*)?${escapedSubject}(?:又|再)?(?:对[^，；。\\s]{1,12})?$`,
        'u',
      );
      return (
      item.length >= 2
      && !/^(?:惊恐地|愤怒地|暴怒地|低声地|大声地|镜头重点表现|动作与信息|剧情)$/u.test(item)
      && !/^(?:对|朝着|朝|向)[^，；。\s]{1,12}$/u.test(item)
      && !speechAttributionResidue.test(item)
      );
    });

  // The canonical grammar accepts one to three stages. Fold every source
  // clause into at most three ordered stages without truncating any clause.
  const parts = sourceParts.length > 3
    ? [0, 1, 2].map((stage) => sourceParts
        .filter((_item, index) => Math.min(2, Math.floor(index * 3 / sourceParts.length)) === stage)
        .join('，随后'))
    : [...sourceParts];

  return parts.length ? parts.join('→') : '无额外可见动作';
};

const narrativeRoleForTimeline = (shot: VideoShot, index: number): string => {
  if (index === 0) return '开篇情绪奠基';
  if (/信息|证据|发现/u.test(shot.purpose)) return '信息触发';
  if (/反转|变化|回应/u.test(shot.purpose)) return '推动情绪转折';
  if (/结果|余波|结束|终结/u.test(shot.purpose)) return '完成结果收束';
  return '承接前镜并推进剧情';
};

const spaceForTimeline = (
  shot: VideoShot,
  context: TimelineRenderContext,
  entities: TimelineShotEntities,
  subject: string,
): string => {
  const sceneAsset = shot.referenceAssetIds.map((id) => context.assets.find((asset) => asset.id === id)).find((asset) => asset?.role === 'scene');
  const propAsset = shot.referenceAssetIds.map((id) => context.assets.find((asset) => asset.id === id)).find((asset) => asset?.role === 'prop');
  const sceneText = `${context.scene.title}${context.scene.summary}${context.scene.content}${shot.action}`;
  const locationDescription = entities.location
    ? [entities.location.name, entities.location.description, entities.location.anchor].filter(Boolean).join('，')
    : '';
  const propDescription = entities.prop
    ? [entities.prop.name, entities.prop.appearance, entities.prop.material].filter(Boolean).join('，')
    : '';
  const isObservationAnalysis = isObservationAnalysisTimeline(`${subject}${shot.action}`);
  const cleanInferredLocation = (value: string): string => {
    const location = value.trim();
    return /(?:画面|镜头|动作|注意力|重点表现|主要区域|观测)$/u.test(location) ? '' : location;
  };
  const localLocation = cleanInferredLocation(findLocationName(shot.action));
  const storyLocation = cleanInferredLocation(findLocationName(context.scene.content));
  const usableSceneTitle = /^(?:剧情原文|原始剧情|故事原文|当前场景|未命名场景|场景\s*\d+|第\s*\d+\s*段(?:\s*[·：:].*)?)$/u.test(context.scene.title.trim())
    ? ''
    : context.scene.title.trim();
  const analysisBase = subject.replace(/观测系统$/u, '') || '综合';
  const analysisEnvironment = isObservationAnalysis
    ? `${analysisBase}观测中心`
    : '';
  const semanticEnvironment = /车|卡车|公路/u.test(shot.action)
    ? `${localLocation || usableSceneTitle || storyLocation || '战区公路'}的武装车队行进路段`
    : /孢子|菌毯|菌丝/u.test(shot.action)
      ? `${localLocation || usableSceneTitle || storyLocation || '孢子云笼罩的战区'}的可见地貌`
      : /枪|火炮|阵地|冲锋|战役/u.test(shot.action)
        ? `${localLocation || usableSceneTitle || storyLocation || '交战区'}的阵地纵深`
        : `${subject}所在的实景空间`;
  const resolvedEnvironment = compactClause(
    sceneAsset?.visualAnchor
      || sceneAsset?.prompt
      || locationDescription
      || analysisEnvironment
      || localLocation
      || usableSceneTitle
      || storyLocation
      || semanticEnvironment,
    40,
  ) || '当前事件所在的实景空间';
  const foreground = compactClause(propAsset?.visualAnchor || propAsset?.name || propDescription || (/车|卡车|公路|车壁|对讲机/u.test(shot.action) ? '车辆金属结构与近景遮挡' : /雨/u.test(sceneText) ? '掠过镜前的雨滴' : /雾|孢子|菌/u.test(sceneText) ? '掠过镜前的悬浮颗粒' : '近景遮挡物与地面材质'), 24);
  const analysisEvidence = shot.action.match(/→([^→]{1,48}?)在分析终端汇聚/u)?.[1]?.trim();
  const middle = isObservationAnalysis
    ? `@${subject}、分析终端与${analysisEvidence || '多源观测数据'}投影`
    : `@${subject}与可见动作接触点`;
  const background = `${resolvedEnvironment}的可见纵深`;
  const relation = relationForTimelineShot(shot, subject, context.characters.map((entry) => entry.name));
  const directedRelation = relation
    ? `；定向动作关系：${relation.actor}从动作起点向${relation.target}收敛，${relation.target}位于运动轴终点；摄影机不作为动作目标`
    : '';
  return `前景-${foreground} 中景-${middle} 背景-${background}${directedRelation}`;
};

const lightingForTimeline = (shot: VideoShot, entities: TimelineShotEntities): string => {
  const light = compactClause(shot.lighting || entities.location?.lighting || '', 62) || '主光源明确，环境反射自然';
  const context = `${shot.action}${shot.purpose}${light}`;
  const kelvin = /烛|火|暖|夕阳|金色|猩红|红光/u.test(context) ? '3200K' : /冷白|车灯/u.test(context) ? '4500K' : /月|冷|蓝|雪|阴天/u.test(context) ? '6500K' : '4500K';
  const direction = /逆光|背光/u.test(light) ? '后侧' : /顶光|顶部/u.test(light) ? '顶部' : /底光|下方/u.test(light) ? '下方' : /右/u.test(light) ? '右侧' : '左侧';
  return `${direction}${kelvin}${/柔/u.test(light) ? '柔光' : '硬光'}塑造主体，${light}，明暗比4:1`;
};

const cameraForTimeline = (shot: VideoShot, index: number, motion: TimelineMotionContext): string => {
  const cameraParts = normalizeProse(shot.camera).split(/[，、；]/u).map((item) => compactClause(item, 30)).filter((item) => item && !/动作与信息|保持动作主体|清晰因果|接触点/u.test(item));
  const source = cameraParts[Math.min(cameraParts.length - 1, index % Math.max(1, cameraParts.length))] || '稳定跟拍';
  const humanLike = motion.kind === 'human' || motion.kind === 'humanoid';
  const stage = /巨型|群体|大范围|坍塌|爆裂/u.test(shot.action)
    ? '中近景，升降镜头逐步展露动作规模'
    : /说|问|回答|吼|喊|瞳孔|目光|不安|惊恐/u.test(`${shot.action}${shot.purpose}`)
      ? humanLike ? '近景，推轨聚焦面部与关键动作' : '近景，推轨聚焦头部结构与发声动作'
      : index === 0 ? '全景，手持镜头随主体运动推进' : '中景，跟拍主体动作';
  const camera = `${stage}，${source}`;
  const view = /惊恐|瞳孔/u.test(`${shot.action}${shot.purpose}`) ? '微俯拍' : /俯|鸟瞰/u.test(source) ? '俯拍视角' : /仰|低机位/u.test(source) ? '微仰拍' : '平视';
  const axis = /左|右|方向|轴线/u.test(camera)
    ? ''
    : index === 0
      ? '（轴线：建立当前主体运动方向）'
      : '（轴线：与前一镜保持主体运动方向连续）';
  return `${camera}，${view}${axis}`;
};

const dialogueForTimeline = (shot: VideoShot, subject: string, scene: Scene, characters: Character[]): string => {
  const sourceDialogues = sourceDialoguesFromText(shot.action);
  if (!sourceDialogues.length) return '无';
  const localDuration = Math.max(0, shot.endSec - shot.startSec);
  const lead = Math.min(DIALOGUE_LEAD_SEC, localDuration * 0.08);
  const tail = Math.min(DIALOGUE_TAIL_SEC, localDuration * 0.08);
  const gap = Math.min(DIALOGUE_LEAD_SEC, localDuration / (sourceDialogues.length * 10));
  const speechWeights = sourceDialogues.map((dialogue) => estimateDialogueSpeechSec(dialogue.text));
  const speechBudget = Math.max(0, localDuration - lead - tail - gap * (sourceDialogues.length - 1));
  const scale = Math.min(1, speechBudget / speechWeights.reduce((sum, value) => sum + value, 0));
  let cursor = lead;
  // These are draft cues, not fixed speaking quotas. The API can arrange
  // delivery from the plot, but a local duration estimate must never delete,
  // shorten or replace authored speech before the API sees it.
  const rendered = sourceDialogues.map((sourceDialogue, index) => {
    const cueSpeaker = normalizeTimelineSubject(sourceDialogue.speakerCandidate);
    const speaker = (!invalidTimelineSubject(cueSpeaker) ? cueSpeaker : '')
      || dialogueSpeakerFromScene(scene, sourceDialogue.text, characters)
      || (!invalidTimelineSubject(subject) ? subject : '')
      || '环境主体';
    const offset = cursor;
    cursor += speechWeights[index] * scale + gap;
    return `第${formatDirectorTimestamp(offset, localDuration < 0.02 ? 3 : 2)}s @${speaker}："${sourceDialogue.text}"`;
  });
  return rendered.join('｜');
};

const soundForTimeline = (
  shot: VideoShot,
  audioMode: 'stereo' | 'none',
  entities: TimelineShotEntities,
  motion: TimelineMotionContext,
): string => {
  if (audioMode === 'none') return '环境层-[无] 动作层-[无] 情绪层-[无]';
  const authoredSound = normalizeShotAmbientSound(shot.sound).trim();
  if (/(?:环境|动作|情绪)层\s*-\s*\[/u.test(authoredSound)) {
    const layer = (name: string, fallback: string): string => authoredSound.match(
      new RegExp(`${name}层\\s*-\\s*\\[([^\\]]*)\\]`, 'u'),
    )?.[1]?.trim() || fallback;
    return `环境层-[${layer('环境', '无')}] 动作层-[${layer('动作', '无')}] 情绪层-[${layer('情绪', '无配乐')}]`;
  }
  // Route existing events, not optional style hints, to the action layer.
  // Score cues stay separate; timestamps inside lyrics/titles are opaque.
  const quotedSounds: string[] = [];
  const soundClauses = authoredSound.replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》/gu, (quote) => {
    quotedSounds.push(quote);
    return `\uE000${quotedSounds.length - 1}\uE001`;
  }).split(/[；;｜|\n]+|[，,]\s*(?=(?:第\s*\d|at\s+\d))/iu);
  const timedCues: string[] = [];
  const scoreCues: string[] = [];
  const styleCues: string[] = [];
  for (const clause of soundClauses) {
    const opaque = clause.trim();
    if (!opaque) continue;
    const text = opaque.replace(/\uE000(\d+)\uE001/gu, (_, index: string) => quotedSounds[Number(index)]);
    const scoreText = opaque.replace(/(?:无|没有|不要|禁止)(?:背景)?(?:音乐|配乐)|\b(?:no|without)\s+(?:background\s+)?(?:music|score)\b/giu, '');
    if (/背景音乐|配乐|\b(?:bgm|background\s+music|non[-\s]+diegetic\s+(?:music|score)|musical\s+score)\b/iu.test(scoreText)) {
      scoreCues.push(text);
    } else if (/(?:第\s*\d+(?:\.\d+)?\s*(?:s|秒)|\bat\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b)/iu.test(opaque)) {
      timedCues.push(text);
    } else {
      styleCues.push(text);
    }
  }
  const timedSound = timedCues.join('；');
  const presetSound = formatProtectedTimelineAtom('风格预设声音', styleCues.join('；'));
  const propEffect = compactClause(entities.prop?.effect || '', 40);
  const text = `${shot.action}${shot.lighting}${propEffect}`;
  // Location/lighting alone is not an authored audio event. Do not invent a
  // continuous ambient bed to fill quiet shots; explicit cues come from the
  // canonical sound layer and keep their own timing in the H3 compiler.
  const environment = '无';
  const speciesSound: Record<Exclude<SubjectMotionClass, 'human' | 'humanoid'>, string> = {
    quadruped: '足爪着地、脊背起伏与尾部扫动声',
    winged: '翼膜振动、羽翼破风与气流声',
    serpentine: '鳞片摩擦、长躯滑动与尾部抽击声',
    tentacled: '触肢卷束、湿润表面摩擦与液体扰动声',
    insectoid: '节肢交替着地、甲壳摩擦与螯肢开合声',
    amorphous: '胶质表面收缩、质量移动与黏液摩擦声',
    mechanical: '驱动器、液压关节与金属结构共振声',
    'unknown-nonhuman': '非人躯体运动、结构摩擦与地面受力声',
  };
  const humanLike = motion.kind === 'human' || motion.kind === 'humanoid';
  const action = timedSound || propEffect || (/破土|地层|路面(?:开裂|爆裂)/u.test(text)
    ? '地表破裂与碎片摩擦声'
    : /枪|开火/u.test(text)
      ? '枪械连射与金属震动'
      : !humanLike
        ? speciesSound[motion.kind as Exclude<SubjectMotionClass, 'human' | 'humanoid'>]
        : /走|跑|冲|追|跨|踏/u.test(text)
          ? /击|撞|砸|爆|格挡|拍打|重拍/u.test(text)
            ? '脚步声与接触碰撞声'
            : '脚步声'
          : /击|撞|砸|爆|格挡|拍打|重拍/u.test(text)
            ? '接触碰撞声'
            : /菌丝|孢子/u.test(text)
              ? '菌丝运动与孢子破裂声'
              : '无');
  const emotion = scoreCues.join('；') || '无配乐';
  return `环境层-[${environment}] 动作层-[${action}] 情绪层-[${emotion}${presetSound ? `｜${presetSound}` : ''}]`;
};

/** Only escape the delimiters of the single-line timeline container. Keep
 * every authored clause, including quotations and time-like prose. The
 * unescaped original continues to live in the shot's own fields. */
const authoredTimelineAtom = (value: string | undefined): string => String(value || '')
  .replace(/[\r\n\t]+/gu, ' ')
  .replace(/\[/gu, '［').replace(/\]/gu, '］')
  .replace(/【/gu, '〈').replace(/】/gu, '〉')
  .trim();

/** AI shot fields are a finished model decision, not raw material for the
 * old local director templates. Missing optional presentation fields get
 * neutral pointers, never an inferred speaker, camera, emotion or sound. */
const renderModelAuthoredTimelineShot = (
  shot: VideoShot,
  start: string,
  end: string,
  audioMode: 'stereo' | 'none',
  visualStyle: string,
  context: TimelineRenderContext,
  continuityIn: string,
  continuityOut: string,
): string => {
  const subject = normalizeStoryboardSubject(shot.subject);
  const character = context.characters.find((entry) => characterVariantMatches(entry, subject))
    || (() => {
      const matches = context.characters.filter((entry) => characterVariantBaseName(entry) === subject);
      return matches.length === 1 ? matches[0] : undefined;
    })();
  const identity = character ? [
    ...characterVariantPromptFacts(character),
    character.gender ? `性别设定〔${authoredTimelineAtom(character.gender)}〕` : '',
    character.race ? `物种设定〔${authoredTimelineAtom(character.race)}〕` : '',
  ].filter(Boolean) : [];
  const performance = [...identity, authoredTimelineAtom(shot.performance) || '按本镜动作呈现'].join('；');
  const action = [
    continuityIn ? `承接上一段〔${authoredTimelineAtom(continuityIn)}〕` : '',
    authoredTimelineAtom(shot.action),
    continuityOut ? `交接下一段〔${authoredTimelineAtom(continuityOut)}〕` : '',
  ].filter(Boolean).join('；');
  const space = authoredTimelineAtom(shot.space) || '沿用本镜动作中的地点与空间关系';
  const direction = authoredTimelineAtom(shot.direction) || '按本镜动作与摄影描述';
  const lighting = [authoredTimelineAtom(shot.lighting), visualStyle].filter(Boolean).join(' ');
  const camera = [authoredTimelineAtom(shot.camera), shot.transition ? `切换〔${authoredTimelineAtom(shot.transition)}〕` : ''].filter(Boolean).join('；');
  const dialogue = audioMode === 'none' ? '无'
    : authoredTimelineAtom(shot.dialogue) || '未单列；沿用本镜动作与声音中的原对白，不新增或改写';
  // Keep authored sound layers and their original timestamps verbatim; no
  // ambient-noise regex, inferred foley, clamping, or local music selection.
  const sound = audioMode === 'none' ? '无（按用户静音设置）' : shot.sound.replace(/[\r\n\t]+/gu, ' ').trim();
  const purpose = [authoredTimelineAtom(shot.purpose), shot.result ? `镜尾状态〔${authoredTimelineAtom(shot.result)}〕` : ''].filter(Boolean).join('；');
  return `【${start}s-${end}s】 主体：@${subject}（${performance}）[朝向：${direction}] 正在 [${action}]（${purpose}）；空间：[${space}]；光影：[${lighting}]；镜头：[${camera}]；台词：${dialogue}；音效：${sound}`;
};

const renderTimelineShot = (
  shot: VideoShot,
  shotIndex: number,
  durationSec: number,
  precision: number,
  audioMode: 'stereo' | 'none',
  visualStyle: string,
  context: TimelineRenderContext,
  previousSubject = '',
  continuityIn = '',
  continuityOut = '',
  isFinalShot = false,
  resolvedNsfwBoundary?: NsfwShotContinuityBoundary,
): string => {
  const start = formatDirectorTimestamp(shot.startSec, precision);
  const end = formatDirectorTimestamp(Math.min(durationSec, shot.endSec), precision);
  if (shot.authoredBy === 'text-api') {
    return renderModelAuthoredTimelineShot(
      shot, start, end, audioMode, visualStyle, context,
      shotIndex === 0 ? continuityIn : '',
      isFinalShot ? continuityOut : '',
    );
  }
  const entities = resolveTimelineShotEntities(shot, context);
  const subject = subjectNameForTimeline(shot, context, entities, previousSubject);
  const motion = motionContextForTimeline(shot, context, entities, subject);
  const entryState = shotIndex === 0
    ? safeContextClause(sanitizeContinuityState(continuityIn, 'entry'), 140)
    : '';
  const exitState = isFinalShot
    ? safeContextClause(sanitizeContinuityState(continuityOut, 'exit'), 140)
    : '';
  const continuityLead = entryState ? `承接上一段：${entryState}；` : '';
  const continuityTail = exitState
    ? `；本段结束状态：${exitState}，交接下一段`
    : '';
  const inferredState = inferNsfwShotContinuityState(shot);
  const boundary = resolvedNsfwBoundary || (inferredState ? { entry: inferredState, end: inferredState } : undefined);
  const stateAtoms = (state: NsfwShotContinuityState | undefined, boundarySide: '入镜' | '镜尾'): string => state
    ? [
        state.nudity ? `${boundarySide}裸露状态〔${safeContextClause(state.nudity, 160)}〕` : '',
        state.clothingState ? `${boundarySide}衣物状态〔${safeContextClause(state.clothingState, 300)}〕` : '',
        state.contact ? `${boundarySide}关键接触〔${safeContextClause(state.contact, 300)}〕` : '',
        state.actionStage ? `${boundarySide}动作阶段〔${safeContextClause(state.actionStage, 160)}〕` : '',
        state.residue ? `${boundarySide}残留状态〔${safeContextClause(state.residue, 240)}〕` : '',
      ].filter(Boolean).join('；')
    : '';
  const entryStatePrefix = stateAtoms(boundary?.entry, '入镜');
  const endStateSuffix = boundary?.end
    && JSON.stringify(boundary.end) !== JSON.stringify(boundary.entry)
      ? stateAtoms(boundary.end, '镜尾')
      : '';
  const visiblePerformance = [
    performanceForTimeline(shot, motion, shotIndex === 0),
    entryStatePrefix,
  ].filter(Boolean).join('；');
  const lighting = [lightingForTimeline(shot, entities), visualStyle].filter(Boolean).join(' ');
  const statefulAction = [actionChainForTimeline(shot, motion, subject), endStateSuffix]
    .filter(Boolean)
    .join('；');
  return `【${start}s-${end}s】 主体：@${subject}（${visiblePerformance}）[朝向：${directionForTimeline(shot, motion, subject, context.characters.map((entry) => entry.name))}] 正在 [${continuityLead}${statefulAction}${continuityTail}]（${narrativeRoleForTimeline(shot, shotIndex)}）；空间：${spaceForTimeline(shot, context, entities, subject)}；光影：${lighting}；镜头：${cameraForTimeline(shot, shotIndex, motion)}；台词：${dialogueForTimeline(shot, subject, context.scene, [...context.characters])}；音效：${soundForTimeline(shot, audioMode, entities, motion)}`;
};

export const usesNsfwDetailMode = (content: string, extra = ''): boolean => (
  hasNsfwDetailSignal(content, extra)
);

const compactActionCoverage = (value: string): string => normalizeProse(value)
  .replace(/[^\p{L}\p{N}]/gu, '');

const restoreNsfwSourceDetail = (
  shot: VideoShot,
  sourceBeats: readonly { id: string; text: string }[],
  shotCount: number,
  shotIndex: number,
): VideoShot => {
  if (shot.locked || shot.authoredBy === 'text-api') return shot;
  const sourceBeatIds = new Set(shot.sourceBeatIds || []);
  const tracedSourceBeats = sourceBeatIds.size
    ? sourceBeats.filter((beat) => sourceBeatIds.has(beat.id))
    : storyBeatsForShot(sourceBeats, shotCount, shotIndex);
  const sourceDetail = tracedSourceBeats
    .map((beat) => beat.text)
    .join('，')
    .replace(/[。！？!?，；;,.]+$/u, '')
    .trim();
  if (!sourceDetail) return shot;
  const sourceEvidence = compactActionCoverage(sourceDetail);
  const shotEvidence = compactActionCoverage(shot.action);
  if (sourceEvidence && shotEvidence.includes(sourceEvidence)) return shot;
  const genericAction = /^(?:人物|角色|主体|主角)?(?:正在)?(?:完成|执行|进行|继续|保持)(?:当前|该)?动作(?:与可见结果)?$/u
    .test(normalizeProse(shot.action));
  return {
    ...shot,
    action: genericAction || !shot.action.trim()
      ? sourceDetail
      : `${sourceDetail}；${shot.action}`,
  };
};

const renderTimelinePrompt = (params: VideoPromptRenderParams): string => {
  const precision = directorTimestampPrecision(params.shots);
  const visualStylePrompt = formatTimelineVisualStylePrompt(
    params.visualStyle || params.style.name || '电影写实',
  );
  const presetVisualPrompt = formatTimelinePresetVisualPrompt(params.style.visual);
  const visualStyleBundle = [presetVisualPrompt, visualStylePrompt].filter(Boolean).join('｜');
  const nsfwDetail = usesNsfwDetailMode(params.scene.content, params.extra);
  const publicExtra = sanitizeNsfwGenerationControls(params.extra);
  const nsfwSourceBeats = nsfwDetail
    ? extractStoryBeats(params.scene.content)
    : [];
  const visualParts = [
    params.directorStyleName,
    params.aspectRatio && `画幅${params.aspectRatio}`,
    params.resolution && `分辨率${params.resolution}`,
    params.audioMode === 'none' ? '无声输出' : '保留立体声层次',
    params.directorStyleSummary,
    publicExtra,
    params.cameraTerms?.length ? `镜头偏好：${params.cameraTerms.join('、')}` : '',
    params.lightingTerms?.length ? `光影偏好：${params.lightingTerms.join('、')}` : '',
  ].map((item) => safeContextClause(item, 100)).filter(Boolean);
  const visual = stripTerminalPunctuation(
    [...visualParts, visualStyleBundle].filter(Boolean).join('，'),
  );
  const context = buildTimelineRenderContext(
    params.scene,
    params.assets,
    params.characters,
    params.locations,
    params.props,
  );
  let previousSubject = '';
  // Restore any source detail the draft omitted before deriving entry/end
  // state. Otherwise a recovered removal or nudity beat would be visible in
  // the action text but absent from the continuity boundary beside it.
  const renderedShots = params.shots.map((shot, index) => nsfwDetail
    ? restoreNsfwSourceDetail(shot, nsfwSourceBeats, params.shots.length, index)
    : shot);
  const resolvedNsfwBoundaries = resolveNsfwShotContinuityBoundaries(renderedShots);
  const lines = renderedShots.map((renderedShot, index) => {
    const line = renderTimelineShot(
      renderedShot,
      index,
      params.durationSec,
      precision,
      params.audioMode,
      index === params.shots.length - 1 ? visual : '',
      context,
      previousSubject,
      params.continuityIn,
      params.continuityOut,
      index === params.shots.length - 1,
      resolvedNsfwBoundaries[index],
    );
    previousSubject = subjectFromTimelinePromptLine(line) || previousSubject;
    return line;
  });
  return cleanVideoPrompt(lines.join('\n'));
};

export const renderFinalPrompt = (params: VideoPromptRenderParams): string => {
  return renderTimelinePrompt(params);
};

/** Build the reusable prompt IR used by model adapters and export manifests. */
export const buildPromptPlan = (params: VideoPromptRenderParams): PromptPlan => {
  const canonicalPrompt = renderTimelinePrompt(params);
  return {
    canonicalPrompt,
    durationSec: params.durationSec,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    audioMode: params.audioMode,
    workflow: params.workflow,
    inputMode: params.inputMode,
    shotIds: params.shots.map((shot) => shot.id),
    referenceAssetIds: orderReferencedAssets(params.shots, params.assets).map((asset) => asset.id),
    constraints: promptContext(params),
    trace: {
      ruleSetId: params.ruleSet.id,
      converterId: params.converter.id,
      styleId: params.style.id,
      directorStyle: params.directorStyleName,
    },
  };
};

/** Build one canonical plan and render from it in a single deterministic pass. */
export const renderPromptPlan = (params: VideoPromptRenderParams): PromptPlan => buildPromptPlan(params);

export const renderShotPrompt = (
  shot: VideoShot,
  durationSec: number,
  assets: ReferenceAsset[],
  allShots: VideoShot[] = [shot],
  audioMode: 'stereo' | 'none' = 'stereo',
  _ruleSet?: Pick<RuleSet, 'mode'>,
  entitySource: TimelineEntitySource = {},
): string => {
  const shotIndex = Math.max(0, allShots.findIndex((item) => item.id === shot.id));
  const scene: Scene = { id: 'shot_preview', title: normalizeProse(shot.subject) || '当前场景', content: normalizeProse(shot.action), summary: normalizeProse(shot.action), characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 0, updatedAt: 0 };
  const context = buildTimelineRenderContext(scene, assets, entitySource.characters, entitySource.locations, entitySource.props);
  const visualStylePrompt = formatTimelineVisualStylePrompt(
    entitySource.visualStyle || entitySource.visualStyleFallback || '电影写实',
  );
  const presetVisualPrompt = formatTimelinePresetVisualPrompt(entitySource.styleVisual || '');
  return renderTimelineShot(
    shot,
    shotIndex,
    durationSec,
    directorTimestampPrecision(allShots),
    audioMode,
    [presetVisualPrompt, visualStylePrompt].filter(Boolean).join('｜'),
    context,
    '',
    '',
    '',
    false,
    resolveNsfwShotContinuityBoundaries(allShots)[shotIndex],
  );
};

const PRIVATE_PROMPT_AGE_METADATA = /(?:外观)?年龄(?:设定)?\s*[：:]?\s*[^，,；;。\n]*|(?:年满|已满)?\s*(?:\d{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:周岁|岁|years?\s*old)|\b\d{1,3}\s*[- ]?year[- ]old\b|(?:明确)?(?:成年(?:人|男性|女性|男子|女子|人物|角色)?|未成年(?:人|人物|角色)?|少年|少女|青少年|儿童|幼儿|婴儿)|\b(?:adult|minor|child|teen(?:ager)?)\b/giu;
const PRIVATE_PROMPT_NEGATIVE_CONTROL = /(?:负面|反向|negative)\s*(?:提示词|prompt)|(?:禁止|不得|不要|不能|不可|严禁|避免|排除|忽略|省略|删除)/iu;

/** Private image facts are sent to local models as positive visual facts only.
 * Historic age gates and negative-prompt prose are metadata, not appearance. */
const sanitizePrivateImageFact = (value: unknown): string => String(value || '')
  .split(/[；;\r\n]+/u)
  .map((fragment) => fragment.trim())
  .filter((fragment) => fragment && !PRIVATE_PROMPT_NEGATIVE_CONTROL.test(fragment))
  .map((fragment) => fragment
    .replace(PRIVATE_PROMPT_AGE_METADATA, '')
    .replace(/\s{2,}/gu, ' ')
    .replace(/^[\s，,、：:]+|[\s，,、：:]+$/gu, '')
    .trim())
  .filter(Boolean)
  .join('；');

interface ImageCharacterMorphologyContext {
  /** True only for an explicitly selected/saved human-like body plan. */
  humanLike: boolean;
  /** Anthropomorphic characters have an explicit mixed body plan: retain
   * their non-human identity locks, but do not prohibit authored upright
   * limbs/stance as if they were a true animal or creature. */
  anthropomorphic: boolean;
  strictlyNonHuman: boolean;
  summary: string;
  bodyPlan: string;
  positiveLocks: string;
  negativeLocks: string;
}

/** Follow a concrete morphology selected by the user/AI. Free-form races,
 * occupations, anatomy and unknown/auto values remain authored facts rather
 * than inputs to a second local species classification. */
const imageCharacterMorphology = (
  fields: Record<string, string>,
): ImageCharacterMorphologyContext => {
  const resolved = resolveExplicitImageCharacterMorphology(fields);
  const locks = resolved ? getMorphologyPromptLocks(resolved) : undefined;
  const text = (value: unknown): string => String(value || '').replace(/\s+/gu, ' ').trim();
  return {
    humanLike: resolved?.family === 'human-like',
    anthropomorphic: resolved?.family === 'anthropomorphic',
    strictlyNonHuman: resolved?.family === 'nonhuman',
    summary: text(resolved?.summary) || text(fields.morphology),
    bodyPlan: text(fields.bodyPlan) || text(resolved?.bodyPlan),
    positiveLocks: text(locks?.positiveText),
    negativeLocks: text(locks?.negativeText),
  };
};

const morphologyPromptText = (
  _fields: Record<string, string>,
  morphology: ImageCharacterMorphologyContext,
): string[] => [
  morphology.summary ? `物种形态：${morphology.summary}` : '',
  morphology.bodyPlan ? `身体结构：${morphology.bodyPlan}` : '',
  morphology.positiveLocks ? `物种结构正向锁：${morphology.positiveLocks}` : '',
  morphology.negativeLocks ? `物种结构防漂移：${morphology.negativeLocks}` : '',
  !morphology.positiveLocks
    ? '身体结构与外貌由 AI 根据完整资料和剧情判断，保留已明确的人物设定。'
    : '',
].filter(Boolean);

export const buildImagePrompt = (
  kind: 'character' | 'location' | 'prop' | 'grid',
  fields: Record<string, string>,
  variant?: ImageVariant,
  nsfwPrivatePart?: NsfwPrivatePart,
  outputSpecification?: ImagePromptOutputSpecification,
): string => {
  if (kind === 'character') fields = normalizeFemaleCharacterVocabularyRecord(fields);
  const direction = variant ? getImageVariantGenerationSpec(variant).direction : '';
  const appendDirection = (prompt: string): string => [
    direction ? `${prompt} ${direction}` : prompt,
    imagePromptOutputSpecificationRule(outputSpecification, variant),
  ].filter(Boolean).join('\n');
  const characterMorphology = kind === 'character'
    ? imageCharacterMorphology(fields)
    : undefined;
  const privateVariant = variant === 'private-full-body'
    || variant === 'private-five-view'
    || variant === 'private-turnaround'
    || variant === 'private-four-in-one'
    || variant === 'private-close-up';
  if (privateVariant || nsfwPrivatePart) {
    if (kind !== 'character') {
      throw new Error('私密资料图只能由人物资料生成。');
    }
    if (!privateVariant || !nsfwPrivatePart) {
      throw new Error('私密资料图必须同时指定私密图片变体和具体部位。');
    }
    if (variant === 'private-full-body' && nsfwPrivatePart !== 'full-body') {
      throw new Error('私密全身图只能使用私密全身外貌资料。');
    }
    if (variant === 'private-turnaround' && nsfwPrivatePart !== 'full-body') {
      throw new Error('私密四视图只能使用私密全身外貌资料。');
    }
    if (variant === 'private-five-view' && nsfwPrivatePart !== 'full-body') {
      throw new Error('私密五视图只能使用私密全身外貌资料。');
    }
    if (variant === 'private-four-in-one' && nsfwPrivatePart !== 'full-body') {
      throw new Error('私密三/四合一只能从私密全身外貌资料入口生成。');
    }
    if (variant === 'private-close-up' && nsfwPrivatePart === 'full-body') {
      throw new Error('私密部位特写必须指定一个具体部位。');
    }
    const privateFields: Readonly<Record<NsfwPrivatePart, { formKey: string; label: string }>> = {
      'full-body': { formKey: 'nsfwFullBody', label: '私密全身' },
      breasts: { formKey: 'nsfwBreasts', label: '胸部' },
      vulva: { formKey: 'nsfwVulva', label: '外阴' },
      anus: { formKey: 'nsfwAnus', label: '后庭' },
      penis: { formKey: 'nsfwPenis', label: '男性外生殖器' },
      scrotum: { formKey: 'nsfwScrotum', label: '阴囊' },
    };
    const privateProfileText = (part: NsfwPrivatePart): string => {
      if (part !== 'penis') return sanitizePrivateImageFact(fields[privateFields[part].formKey]);
      return [...new Set([
        sanitizePrivateImageFact(fields.nsfwPenis),
        sanitizePrivateImageFact(fields.nsfwScrotum),
      ].filter(Boolean))].join('；');
    };
    const gender = sanitizePrivateImageFact(fields.gender);
    const female = /(?:女|雌|\bfemale\b)/iu.test(gender);
    const male = /(?:男|雄|\bmale\b)/iu.test(gender);
    const privateFourInOneParts = (): NsfwPrivatePart[] => {
      if (female && !male) return ['full-body', 'breasts', 'vulva', 'anus'];
      if (male && !female) return ['full-body', 'penis', 'anus'];
      const filled = (['breasts', 'vulva', 'anus', 'penis'] as NsfwPrivatePart[])
        .filter((part) => privateProfileText(part));
      return ['full-body', ...filled.slice(0, 3)];
    };
    if (variant === 'private-four-in-one') {
      const parts = privateFourInOneParts();
      const sheetLabel = parts.length === 3 ? '私密三合一' : '私密四合一';
      const auxiliaryCount = parts.length - 1;
      const regionCountText = parts.length === 3 ? '三个' : '四个';
      const auxiliaryCountText = auxiliaryCount === 2 ? '两个' : '三个';
      if (parts.length < 3) {
        throw new Error(`${sheetLabel}至少需要“私密全身”以及${auxiliaryCountText}私密部位外貌资料。`);
      }
      const missing = parts
        .filter((part) => !privateProfileText(part))
        .map((part) => `“${privateFields[part].label}外貌”`);
      if (missing.length) {
        throw new Error(`缺少${missing.join('、')}资料，不能生成${sheetLabel}资料图。`);
      }
      const identity = [
        `名称：${fields.name || '当前角色'}`,
        gender ? `性别设定：${gender}` : '',
        sanitizePrivateImageFact(fields.race) ? `物种/族裔：${sanitizePrivateImageFact(fields.race)}` : '',
        ...(characterMorphology && !characterMorphology.humanLike
          ? morphologyPromptText(fields, characterMorphology)
          : []),
        sanitizePrivateImageFact(fields.height) ? `身高/高度比例：${sanitizePrivateImageFact(fields.height)}` : '',
        sanitizePrivateImageFact(fields.appearance) ? `身份外观：${sanitizePrivateImageFact(fields.appearance)}` : '',
      ].filter(Boolean).join('；');
      const panelFacts = parts
        .map((part, index) => {
          const label = privateFields[part].label;
          const slot = index === 0 ? '主画面' : ['辅助窗一', '辅助窗二', '辅助窗三'][index - 1] || `辅助窗${index}`;
          return `${slot}${label}：${privateProfileText(part)}`;
        })
        .join('；');
      return appendDirection(
        `角色${sheetLabel}资料图；${identity}；固定${regionCountText}区域槽位资料：${panelFacts}；私密全身为主画面且只使用私密全身资料，全身主体只出现一次，${auxiliaryCountText}私密部位仅作为较小辅助窗，辅助窗按顺序只使用各自绑定的部位资料，各辅助部位辅助窗各出现一次且互不重复；男性外生殖器作为一个合并槽位，阴茎与阴囊资料共同归入同一个辅助窗；每个槽位只绘制一次，所有槽位属于同一人物、同一身体锚点、同一体表与体型结构，静态资料姿态符合其物种，背景简洁，焦点清晰。`,
      );
    }
    const selected = privateFields[nsfwPrivatePart];
    const selectedProfile = privateProfileText(nsfwPrivatePart);
    if (!selectedProfile) {
      throw new Error(`缺少“${selected.label}外貌”资料，不能生成对应私密资料图。`);
    }
    const closeUpVariant = variant === 'private-close-up';
    const identity = [
      closeUpVariant ? '' : `名称：${fields.name || '当前角色'}`,
      sanitizePrivateImageFact(fields.gender) ? `性别设定：${sanitizePrivateImageFact(fields.gender)}` : '',
      sanitizePrivateImageFact(fields.race) ? `物种/族裔：${sanitizePrivateImageFact(fields.race)}` : '',
      ...(characterMorphology && !characterMorphology.humanLike
        ? morphologyPromptText(fields, characterMorphology)
        : []),
      !closeUpVariant && sanitizePrivateImageFact(fields.height) ? `身高/高度比例：${sanitizePrivateImageFact(fields.height)}` : '',
      !closeUpVariant && sanitizePrivateImageFact(fields.appearance) ? `身份外观：${sanitizePrivateImageFact(fields.appearance)}` : '',
      variant === 'private-five-view' && sanitizePrivateImageFact(fields.style) ? `视觉风格：${sanitizePrivateImageFact(fields.style)}` : '',
    ].filter(Boolean).join('；');
    const composition = variant === 'private-five-view'
      ? '横向3:2私密五视图资料板，左侧上下两个头肩特写与右侧三个全身视图组成同一人物的五个参考区域；只有右侧三个全身视图保持同尺度、同水平基线，左侧头肩特写独立放大'
      : variant === 'private-turnaround'
      ? '横向3:2私密四视图资料板，同一主体裸体全身正面、严格90度左侧面、背面、45度前侧三分之四视图并列展示，四个视图保持同一身体比例、同一水平基线、同一私密身体锚点'
      : nsfwPrivatePart === 'full-body'
      ? '一幅连续的单主体裸体全身画面，从头到脚完整可见，整体身体比例与局部资料保持同一套锚点'
      : `一幅连续的${selected.label}近景或微距画面，当前部位占据画面主体，紧邻皮肤提供解剖方位，稳定形状、比例、颜色与纹理完整可见`;
    const privateIdentityContinuity = closeUpVariant
      ? characterMorphology?.anthropomorphic || characterMorphology?.strictlyNonHuman
        ? '当前部位的体表材质、肤色、纹理、比例与物种身体锚点保持一致'
        : '当前部位的肤色、肤质、体表纹理与比例保持同一人物的一致身体锚点'
      : characterMorphology?.humanLike
        ? '人物脸部、发型、肤色、体型与稳定辨识特征保持一致'
        : characterMorphology?.anthropomorphic
          ? '原文明确的人形躯干、直立部位与非人头部、体表和附肢同时保持一致，不把非人身份替换成人类外貌'
        : characterMorphology?.strictlyNonHuman
          ? '头部/感知结构、躯干、肢体与附肢数量、体表材质和稳定辨识特征保持一致，不添加人形结构'
          : '完整保留资料指定的头部、体表、躯干、肢体与稳定辨识特征，未明确的部分由 AI 结合完整资料判断';
    return appendDirection(
      `角色私密外貌资料图；${identity}；当前私密资料（${selected.label}）：${selectedProfile}；${composition}；私密身体档案作为本次画面状态，${privateIdentityContinuity}；静态资料姿态符合其物种，主体明确，焦点清晰，背景简洁。`,
    );
  }
  if (kind === 'character') {
    const morphology = characterMorphology!;
    // Keep the direct source compact and model-friendly.  The converter
    // contract carries the full human-anatomy prohibition; this source adds a
    // species-safe reminder without forcing legacy models to parse a rule
    // document as visible prose.
    const nonHumanMorphologyLines = morphologyPromptText(fields, morphology)
      .map((value) => value
        // The full negative contract is supplied to the converter separately;
        // keep this source focused on drawable structure and avoid leaking a
        // long prohibition list into legacy field-based converters.
        .replace(/物种结构防漂移：[^；。]+(?:；[^；。]+)*/u, '')
        .replace(/人类头部/gu, '类人头部')
        .replace(/人类脸型/gu, '类人脸型')
        .replace(/人类皮肤/gu, '类人皮肤')
        .replace(/人类/g, '类人')
        .replace(/人体比例/gu, '人形比例')
        .replace(/人体/gu, '人形体')
        .replace(/脸型/gu, '面部轮廓')
        .replace(/发型/gu, '头部毛发样式'));
    if (variant === 'turnaround' || variant === 'five-view') {
      const viewLabel = variant === 'five-view' ? '五视图' : '四视图';
      if (morphology.strictlyNonHuman) {
        const identity = [
          `名称：${fields.name || '未命名角色'}`,
          fields.race ? `物种/族群：${fields.race}` : '',
          ...nonHumanMorphologyLines,
          fields.age ? `外观年龄或生命周期阶段：${fields.age}` : '',
          fields.height ? `高度/体长/翼展（尺度锚点）：${fields.height}` : '',
          fields.appearance
            ? `详细结构外观：${fields.appearance}`
            : '详细结构外观：依据物种资料补足头部/感知结构、躯干、肢体与附肢、体表材质和辨识特征',
          fields.outfit ? `外覆结构或装备：${fields.outfit}` : '',
          fields.props ? `稳定长期装备/辨识物：${fields.props}` : '',
          fields.personality ? `整体气质：${fields.personality}` : '',
          fields.motion ? `自然运动方式：${fields.motion}` : '',
          fields.anchor ? `连续性锚点：${fields.anchor}` : '连续性锚点：保持物种结构、头部轮廓、肢体与附肢数量、表面纹理、配色和装备完全一致',
          fields.style || '电影级清晰设定稿质感',
        ].filter(Boolean).join('；');
        return appendDirection(
          `非人/异种角色${viewLabel}身份设定，${identity}。所有画面均为同一主体的静态技术展示，姿态符合该物种真实生理结构；不得将其改写为类人头部、类人面部、头部毛发样式、手掌、双足直立或人形比例，不增加原设定之外的肢体、服装、道具或动作。`,
        );
      }
      const identity = [
        `名称：${fields.name || '未命名角色'}`,
        fields.gender ? `性别设定：${fields.gender}` : '',
        fields.age ? `外观年龄（按此绘制）：${fields.age}` : '',
        fields.height ? `身高/高度（比例锚点）：${fields.height}` : '',
        fields.race ? `物种/族裔：${fields.race}` : '',
        ...morphologyPromptText(fields, morphology),
        `详细外观：${fields.appearance || '依据角色资料补足符合其物种的头部、躯干、肢体、附肢、表面材质和辨识特征'}`,
        fields.outfit ? `服装或外覆结构：${fields.outfit}` : variant === 'five-view' && morphology.humanLike ? '服装：与题材匹配的常驻服装，保持穿着状态' : '',
        fields.props ? `稳定长期装备/辨识物：${fields.props}` : '',
        fields.personality ? `整体气质：${fields.personality}` : '',
        `连续性锚点：${fields.anchor || '保持物种结构、头部轮廓、肢体与附肢数量、表面纹理、配色和装备完全一致'}`,
        fields.style || '电影级清晰设定稿质感',
      ].filter(Boolean).join('；');
      const turnaroundContinuity = morphology.anthropomorphic
        ? '拟人非人角色必须同时保留原文明确的非人头部/感知结构、体表材质、尾翼/爪等附肢与人形躯干、直立肢体或姿态；两类结构不可互相替换，不能简化成纯人类或纯动物。'
        : '所有视图必须同时保持资料指定的头部/感知结构、体表材质、躯干、肢体与附肢数量及连接方式；未明确的部分由 AI 结合完整资料与剧情判断。';
      return appendDirection(
        `角色${viewLabel}身份设定，${identity}。所有画面均为同一主体的静态技术展示，姿态符合该物种的真实生理结构，${turnaroundContinuity}不增加原设定之外的肢体、服装、道具或动作。`,
      );
    }
    if (morphology.strictlyNonHuman) {
      const identity = [
        `名称：${fields.name || '未命名角色'}`,
        fields.race ? `物种/族群：${fields.race}` : '',
        ...nonHumanMorphologyLines,
        fields.gender ? `性别或雌雄设定：${fields.gender}` : '',
        fields.age ? `生命周期阶段：${fields.age}` : '',
        fields.height ? `高度/体长/翼展（尺度锚点）：${fields.height}` : '',
        fields.appearance
          ? `详细结构外观：${fields.appearance}`
          : '详细结构外观：根据物种资料补足头部/感知结构、躯干、肢体与附肢、体表材质和辨识标记',
        fields.outfit ? `外覆结构或装备：${fields.outfit}` : '外覆结构：无额外服装，保持资料指定体表材质',
        fields.props ? `稳定长期装备/辨识物：${fields.props}` : '',
        fields.personality ? `整体气质：${fields.personality}` : '',
        fields.motion ? `自然运动方式：${fields.motion}` : '自然运动方式：符合其身体结构的自然姿态',
        fields.anchor ? `连续性锚点：${fields.anchor}` : '连续性锚点：保持物种、头部/感知结构、躯干、肢体与附肢数量、体表纹理、配色和装备稳定',
        fields.style || '电影级清晰质感',
      ].filter(Boolean).join('；');
      return appendDirection(
        `单个非人/异种角色参考图，${identity}。单一主体、干净构图，适合作为后续视频参考图；严格保持真实物种结构，不擅自添加类人头部、类人面部、头部毛发样式、类人皮肤、手掌、五指、双足直立或人形比例，不加入无依据服装、肢体、道具、文字、Logo、水印和无关人物。`,
      );
    }
    return appendDirection(`单个角色参考图，名称：${fields.name || '未命名角色'}，${fields.gender ? `性别设定：${fields.gender}，` : ''}${fields.age ? `外观年龄（按此绘制）：${fields.age}，` : ''}${fields.height ? `身高/高度（比例锚点）：${fields.height}，` : ''}${fields.race ? `物种/族裔：${fields.race}，` : ''}${morphologyPromptText(fields, morphology).join('；')}，详细外观：${fields.appearance || '根据资料补足符合物种设定的头部、躯干、肢体、表面特征和辨识标记'}，服装：${fields.outfit || '与题材匹配的常驻服装'}，稳定长期装备/辨识物：${fields.props || '无'}，性格气质：${fields.personality || '符合剧情身份'}，动作习惯：${fields.motion || '符合其身体结构的自然静态姿态'}，连续性锚点：${fields.anchor || '保持身份、性别设定、身体结构、外观、服装和稳定长期装备稳定'}。临时购买后食用的食物及容器、短暂借用或交接物、单次动作手持物不应固化为人物参考图身份；按全文中的归属、持续性和叙事功能判断，不按物品类别一刀切，保留真正的长期装备与身份标志；${fields.style || '电影级清晰质感'}，单个主体干净构图，适合作为后续视频参考图。${morphology.anthropomorphic ? '拟人非人角色必须同时保留原文明确的人形躯干/直立部位与非人头部、体表、附肢；禁止把非人头部和体表替换成人类外貌。' : ''}只按外观年龄控制年龄感，按身高/高度稳定身体比例，禁止把其他设定转换成老化外貌，禁止改变既定性别或物种特征，禁止多余文字、Logo、水印和无关人物。`);
  }
  if (kind === 'location') {
    if (isLandscapeImageRequest(kind, variant)) return [buildLandscapeImageSource(fields), imagePromptOutputSpecificationRule(outputSpecification, variant)].filter(Boolean).join('\n');
    return appendDirection(`视频场景参考图，${fields.name || '未命名场景'}，空间结构与建筑材质：${fields.description || '根据剧情建立空间布局'}，${fields.weather || '符合剧情的时间和天气'}，主光源：${fields.lighting || '明确主光源'}，${fields.palette || '统一色彩母题'}，固定陈设：${fields.fixedProps || '符合剧情的关键陈设'}，场景锚点：${fields.anchor || '保持空间布局、光向和色彩连续'}，${fields.style?.trim() ? `视觉风格：${fields.style.trim()}，` : ''}空间结构清晰，适合作为视频首帧或场景参考，不加入文字、Logo和水印。`);
  }
  if (kind === 'prop') {
    return appendDirection(`单个剧情道具参考图，${fields.name || '未命名道具'}，类别：${fields.category || '剧情道具'}，材质：${fields.material || '具体材质'}，详细外观：${fields.appearance || '清晰轮廓、颜色、纹理、尺寸和磨损细节'}，剧情作用与效果：${fields.effect || '无'}，状态连续性：${fields.stateRules || '保持形状、磨损和关键细节一致'}，细节清楚，适合作为视频中的关键道具参考，不加入文字、Logo和水印。`);
  }
  return appendDirection(`九宫格视觉母版提示词：1:1 方形母版，3×3 等大画格，从左到右、从上到下展示同一主体的九个连续关键状态；主体身份、服装、材质、核心道具和色彩贯穿九格，镜位、景别、动作和姿态明显变化；细而整洁的中性分隔线，无多余文字、Logo和水印。故事内容：${fields.story || '根据当前场景生成一条完整的视觉发展线'}。`);
};
