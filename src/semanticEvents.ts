export type SemanticStoryBeatKind =
  | 'visible-action'
  | 'dialogue'
  | 'state-change'
  | 'exposition'
  | 'internal-thought';

export type SemanticStoryBeatStrategy = 'faithful' | 'compact';

export interface SemanticStoryBeatExtractionOptions {
  /**
   * `compact` keeps the existing de-duplicated planning behavior. `faithful`
   * preserves repeated semantic boundaries while both strategies retain every
   * source character in their contiguous spans.
   */
  strategy?: SemanticStoryBeatStrategy;
}

export interface SemanticStoryBeat {
  id: string;
  index: number;
  /** Compact source excerpt for prompt generation; punctuation is presentation, not an event boundary. */
  text: string;
  /** UTF-16 source range start, inclusive. */
  sourceStart: number;
  /** UTF-16 source range end, exclusive. */
  sourceEnd: number;
  /** Stable, punctuation-insensitive action identity used for counting and de-duplication. */
  actionSignature: string;
  /** Stable timing/planning category derived from meaning rather than length. */
  kind: SemanticStoryBeatKind;
  /** Relative timing weight. Punctuation never contributes to this value. */
  weight: number;
}

type KineticStage = '蓄力' | '传力' | '释放' | '反作用' | '收势';

const KINETIC_STAGES: readonly KineticStage[] = ['蓄力', '传力', '释放', '反作用', '收势'];

/**
 * Longest terms come first so a semantic action is counted once (for example,
 * `侧身闪避` must not also become a second `闪避` event).
 */
const SEMANTIC_EVENT_TERMS = [
  '冲上前去', '拔出长剑',
  '屈膝分开',
  '脱泳装', '脱衣服', '脱内衣', '脱内裤', '脱裤子',
  '反作用', '控制权反转', '行为结果落地', '产生位移', '产生形变',
  '推开', '拉开', '打开', '关上', '关闭', '踹开', '破门',
  '抬头', '低头', '回头', '转身', '看见', '看到', '发现', '凝视', '望向', '看向',
  '走到', '走进', '进入', '走出', '离开', '冲向', '扑向', '扑下', '追击', '追逐',
  '奔跑', '跑向', '跃起', '跳起', '落地', '落下', '坠落', '倒下', '停住', '停下',
  '举枪', '拔枪', '开火', '射击', '挥剑', '拔剑', '劈向', '刺向', '砸向',
  '击中', '击退', '击飞', '格挡', '闪避', '躲开', '避开', '抓住', '握住',
  '递出', '接过', '拿起', '放下', '吹过', '吹灭', '点燃', '点亮', '爆炸', '碎裂', '坍塌',
  '脱下', '脱掉', '褪下', '摘下', '解下', '穿上', '解开', '掀开',
  '屈膝', '弯腰', '俯身', '仰卧', '俯卧', '侧卧', '躺下', '坐下', '跪下',
  '掰开', '扒开', '分开', '并拢', '合拢', '露出', '显露', '漏出', '遮住', '盖住',
  '张开', '苏醒', '爬出', '踏裂', '昂首咆哮', '咆哮', '卷住', '拖出', '盘绕', '蜿蜒',
  '振翼', '俯冲', '掠过', '甩尾', '抽击', '转过身', '举起', '伸出',
  '低声说', '大声喊', '说道', '问道', '回答', '拒绝', '承认', '决定',
  '亮起', '响起', '熄灭', '出现', '消失', '漆黑',
  // Narrative actions and visible state changes. These are deliberately
  // semantic signals rather than punctuation rules, so prose and dialogue can
  // be timed even when the author writes one long sentence.
  '正式打响', '打响', '化作', '接到', '调转方向', '调转', '杀了过去', '杀向',
  '坐着', '采购', '赶去', '支援', '分析出', '潜伏', '展开袭击', '袭击',
  '握着', '吼道', '遭受', '攻击', '堵在', '帮助', '帮忙', '解围', '消灭',
  '付出', '前进', '弥漫', '伫立', '注意到', '流露出', '流露', '想到',
  '守住', '守护', '直奔', '涌向', '留下', '保护', '发出呼唤', '呼唤',
  '需要', '派出', '增援', '伤到', '思索', '安慰', '出手', '满意',
  '安定', '投入', '感觉到', '感觉', '支撑', '崩溃', '冲击', '伤亡',
  '发出', '哀嚎', '下定决心', '淹没', '战斗', '对抗', '去守', '防守',
  '移动', '嗅闻', '寻找',
  ...KINETIC_STAGES,
] as const;

const ORDERED_SEMANTIC_EVENT_TERMS = [...new Set(SEMANTIC_EVENT_TERMS)]
  .sort((left, right) => [...right].length - [...left].length);

/**
 * Only independently filmable actions split one sentence into several beats.
 * Broader narrative markers remain useful for identifying a sentence-level
 * event, but words such as “需要/帮助/支撑” must not each manufacture a shot.
 */
const MULTI_EVENT_SPLIT_TERMS = new Set<string>([
  '冲上前去', '屈膝分开', '脱泳装', '脱衣服', '脱内衣', '脱内裤', '脱裤子',
  '推开', '拉开', '打开', '关上', '关闭', '踹开', '破门',
  '抬头', '低头', '回头', '转身', '看见', '看到', '发现', '凝视', '望向', '看向',
  '走到', '走进', '进入', '走出', '离开', '冲向', '扑向', '扑下', '追击', '追逐',
  '奔跑', '跑向', '跃起', '跳起', '落地', '落下', '坠落', '倒下', '停住', '停下',
  '举枪', '拔枪', '开火', '射击', '挥剑', '拔剑', '拔出长剑', '劈向', '刺向', '砸向',
  '击中', '击退', '击飞', '格挡', '闪避', '躲开', '避开', '抓住', '握住',
  '递出', '接过', '拿起', '放下', '吹过', '吹灭', '点燃', '点亮', '爆炸', '碎裂', '坍塌',
  '脱下', '脱掉', '褪下', '摘下', '解下', '穿上', '解开', '掀开',
  '屈膝', '弯腰', '俯身', '仰卧', '俯卧', '侧卧', '躺下', '坐下', '跪下',
  '掰开', '扒开', '分开', '并拢', '合拢', '露出', '显露', '漏出', '遮住', '盖住',
  '张开', '苏醒', '爬出', '踏裂', '昂首咆哮', '咆哮', '卷住', '拖出',
  '盘绕', '蜿蜒', '振翼', '俯冲', '掠过', '甩尾', '抽击', '转过身', '举起', '伸出',
  '调转方向', '调转', '杀了过去', '杀向', '直奔', '涌向',
  '采购', '赶去', '展开袭击', '分析出', '亮起', '响起', '熄灭', '移动', '嗅闻', '寻找',
  ...KINETIC_STAGES,
]);

const EVENT_TERM_PATTERN = new RegExp(
  ORDERED_SEMANTIC_EVENT_TERMS
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|'),
  'gu',
);

const NON_SEMANTIC_PATTERN = /[\s，,。！？!?；;：:、…—·“”"'‘’（）()【】\[\]{}《》〈〉「」『』]/gu;
const EVENT_CONNECTOR_PATTERN = /(?:然后|随后|接着|继而|同时|并且|并|于是|终于|立刻|随即|转而)/u;
const PREPARATION_FILLER_PATTERN = /(?:伸出?手|抬起手|开始|正在|试图|尝试|猛然|突然|迅速|快速|缓缓|慢慢|立刻|随即|用力|一下|径直)/gu;

const stripLegacyContinuityLabels = (value: string): string => String(value || '')
  .replace(
    /^\s*(?:(?:承接上一段|本段结束状态|交接下一段)\s*[：:]\s*)+/u,
    '',
  )
  .replace(
    /([；;\r\n])\s*(?:承接上一段|本段结束状态|交接下一段)\s*[：:]\s*/gu,
    '$1',
  )
  .replace(/[\s，,；;]*(?:交接下一段)\s*[。！？!?]?\s*$/u, '')
  .trim();

const GENERIC_ARROW_STAGE_PATTERN = /(?:继续推进|身体反应|身体重心|动作结果|自然停住|稳定停住|保持动作结果|重心微移|动作停稳)/u;

/**
 * A rendered three-stage action chain may end in reusable camera-friendly
 * fallback stages.  Semantic identity comes from the first real stage, not
 * from a shared tail such as “动作结果自然停住”.
 */
const primarySemanticClause = (value: string): string => {
  const clean = stripLegacyContinuityLabels(value).replace(/；镜头重点表现.*$/u, '');
  const clauses = clean.split('→').map((clause) => clause.trim()).filter(Boolean);
  const primary = clauses[0] || clean.trim();
  const primaryCompact = compactSemanticText(primary);
  const match = findCanonicalVerb(primaryCompact) || findGenericSemanticVerb(primaryCompact);
  if (!match || canonicalTarget(primaryCompact.slice(match.index + match.source.length))) {
    return primary;
  }

  // Some generated action chains can place the direct target in the next
  // arrow slot (for example “涌向了→母巢→…”).  Reattach only a short nominal
  // slot; a real follow-up action or a reusable motion stage remains separate.
  const arrowTarget = compactSemanticText(clauses[1] || '');
  if (
    !arrowTarget
    || [...arrowTarget].length > 16
    || GENERIC_ARROW_STAGE_PATTERN.test(arrowTarget)
    || findCanonicalVerb(arrowTarget)
    || findGenericSemanticVerb(arrowTarget)
    || !canonicalTarget(arrowTarget)
  ) {
    return primary;
  }
  return `${primary}${clauses[1]}`;
};

const compactSemanticText = (value: string): string => String(value || '')
  .replace(NON_SEMANTIC_PATTERN, '')
  .trim();

const canonicalTarget = (value: string): string => {
  let target = compactSemanticText(value)
    .split(EVENT_CONNECTOR_PATTERN, 1)[0]
    .replace(/^(?:了|着|向|朝着|朝|对着|对|那扇|这扇|一扇)/u, '')
    .replace(/(?:了|着|起来|开来|下去|出去|进去)$/u, '')
    .replace(/^(?:厚重|沉重|破旧|老旧|木制|铁制|金属制|关闭的|面前的)+/u, '');

  // Material/location modifiers do not turn the same door operation into a
  // different semantic event.
  target = target.replace(/(?:舱门|木门|铁门|房门|大门|门扇)/gu, '门');
  if (target.startsWith('门')) return '门';
  return [...target].slice(0, 16).join('');
};

interface CanonicalVerbMatch {
  index: number;
  source: string;
  verb: string;
}

const CANONICAL_VERBS: ReadonlyArray<{ variants: readonly string[]; verb: string }> = [
  { variants: ['侧身闪避', '转身闪避', '闪避', '躲开', '避开', '闪开'], verb: '闪避' },
  { variants: ['伸手推开', '推开', '踹开', '破门', '推门'], verb: '推开' },
  { variants: ['拉开', '打开', '开启'], verb: '打开' },
  { variants: ['关上', '关闭', '合上'], verb: '关闭' },
  { variants: ['抬起头', '抬头'], verb: '抬头' },
  { variants: ['低下头', '低头'], verb: '低头' },
  { variants: ['转过身', '转身', '回头'], verb: '转身' },
  { variants: ['看见', '看到', '发现'], verb: '发现' },
  { variants: ['凝视', '望向', '看向'], verb: '注视' },
  { variants: ['走进', '进入'], verb: '进入' },
  { variants: ['走出', '离开'], verb: '离开' },
  { variants: ['冲向', '冲上前去'], verb: '冲向' },
  { variants: ['扑向', '扑下'], verb: '扑向' },
  { variants: ['追击', '追逐'], verb: '追击' },
  { variants: ['奔跑', '跑向'], verb: '奔跑' },
  { variants: ['跃起', '跳起'], verb: '跃起' },
  { variants: ['落地', '坠落'], verb: '落地' },
  { variants: ['倒下'], verb: '倒下' },
  { variants: ['停住', '停下'], verb: '停下' },
  { variants: ['举起枪', '举枪', '拔枪'], verb: '举枪' },
  { variants: ['开火', '射击'], verb: '射击' },
  { variants: ['拔出长剑', '拔剑'], verb: '拔剑' },
  { variants: ['挥剑'], verb: '挥剑' },
  { variants: ['劈向'], verb: '劈向' },
  { variants: ['刺向'], verb: '刺向' },
  { variants: ['砸向'], verb: '砸向' },
  { variants: ['击中'], verb: '击中' },
  { variants: ['击退', '击飞'], verb: '击退' },
  { variants: ['格挡'], verb: '格挡' },
  { variants: ['抓住'], verb: '抓住' },
  { variants: ['握住'], verb: '握住' },
  { variants: ['递出'], verb: '递出' },
  { variants: ['接过'], verb: '接过' },
  { variants: ['拿起'], verb: '拿起' },
  { variants: ['放下'], verb: '放下' },
  { variants: ['脱泳装', '脱衣服', '脱内衣', '脱内裤', '脱裤子', '脱下', '脱掉', '褪下'], verb: '脱下' },
  { variants: ['摘下', '解下'], verb: '摘下' },
  { variants: ['穿上'], verb: '穿上' },
  { variants: ['解开'], verb: '解开' },
  { variants: ['掀开'], verb: '掀开' },
  { variants: ['屈膝分开', '掰开', '扒开', '分开'], verb: '分开' },
  { variants: ['屈膝'], verb: '屈膝' },
  { variants: ['弯腰', '俯身'], verb: '俯身' },
  { variants: ['仰卧'], verb: '仰卧' },
  { variants: ['俯卧'], verb: '俯卧' },
  { variants: ['侧卧'], verb: '侧卧' },
  { variants: ['躺下'], verb: '躺下' },
  { variants: ['坐下'], verb: '坐下' },
  { variants: ['跪下'], verb: '跪下' },
  { variants: ['并拢', '合拢'], verb: '合拢' },
  { variants: ['露出', '显露', '漏出'], verb: '露出' },
  { variants: ['遮住', '盖住'], verb: '遮住' },
  { variants: ['吹灭'], verb: '吹灭' },
  { variants: ['点燃'], verb: '点燃' },
  { variants: ['爆炸'], verb: '爆炸' },
  { variants: ['碎裂'], verb: '碎裂' },
  { variants: ['坍塌'], verb: '坍塌' },
  { variants: ['昂首咆哮', '咆哮'], verb: '咆哮' },
  { variants: ['亮起'], verb: '亮起' },
  { variants: ['熄灭'], verb: '熄灭' },
  { variants: ['出现'], verb: '出现' },
  { variants: ['消失'], verb: '消失' },
  { variants: ['漆黑'], verb: '变暗' },
  { variants: ['说道', '低声说'], verb: '说话' },
  { variants: ['问道'], verb: '询问' },
  { variants: ['大声喊'], verb: '喊叫' },
  { variants: ['回答'], verb: '回答' },
  { variants: ['拒绝'], verb: '拒绝' },
  { variants: ['承认'], verb: '承认' },
  { variants: ['决定'], verb: '决定' },
];

const findCanonicalVerb = (value: string): CanonicalVerbMatch | undefined => {
  let earliest: CanonicalVerbMatch | undefined;
  CANONICAL_VERBS.forEach(({ variants, verb }) => {
    variants.forEach((variant) => {
      const index = value.indexOf(variant);
      if (index < 0) return;
      if (
        !earliest
        || index < earliest.index
        || (index === earliest.index && [...variant].length > [...earliest.source].length)
      ) {
        earliest = { index, source: variant, verb };
      }
    });
  });
  return earliest;
};

const findGenericSemanticVerb = (value: string): CanonicalVerbMatch | undefined => {
  let earliest: CanonicalVerbMatch | undefined;
  ORDERED_SEMANTIC_EVENT_TERMS.forEach((term) => {
    const index = value.indexOf(term);
    if (index < 0) return;
    if (
      !earliest
      || index < earliest.index
      || (index === earliest.index && [...term].length > [...earliest.source].length)
    ) {
      earliest = { index, source: term, verb: term };
    }
  });
  return earliest;
};

const kineticStageOf = (value: string): KineticStage | undefined => (
  KINETIC_STAGES.find((stage) => value.includes(stage))
);

const explicitActorOf = (value: string): string | undefined => {
  let compact = compactSemanticText(primarySemanticClause(value));
  if (!compact) return undefined;
  KINETIC_STAGES.forEach((stage) => {
    compact = compact.replace(stage, '');
  });
  const match = findCanonicalVerb(compact) || findGenericSemanticVerb(compact);
  if (!match || match.index <= 0) return undefined;

  let actor = compact.slice(0, match.index)
    .replace(/^(?:(?:然后|随后|接着|继而|同时|并且|于是|终于|立刻|随即|转而|此时|这时))+/u, '')
    .replace(PREPARATION_FILLER_PATTERN, '')
    .replace(/(?:把|将)[^把将]{1,18}$/u, '')
    .replace(/^(?:镜头中|画面中)/u, '')
    .replace(/^(?:在[^里中内外前旁]{1,12}[里中内外前旁])/u, '')
    .replace(/^(?:向前|朝前|上前|回身)/u, '')
    .trim();

  if (!actor || actor.endsWith('被') || /(?:把|将)/u.test(actor)) return undefined;
  if ([...actor].length > 12) return undefined;
  return actor;
};

/**
 * Produce a stable identity for a visual action. It removes presentation-only
 * punctuation and preparatory filler, canonicalises common verb synonyms and
 * object-before-verb `把/将` syntax, while preserving kinetic action phases.
 */
export const normalizeSemanticAction = (value: string): string => {
  let compact = compactSemanticText(primarySemanticClause(value));
  if (!compact) return '';
  const stage = kineticStageOf(compact);
  if (stage) compact = compact.replace(stage, '');
  compact = compact.replace(PREPARATION_FILLER_PATTERN, '');
  compact = compact.replace(
    /(?:把|将)([^把将]{1,18}?)(推开|拉开|打开|关上|关闭|踹开|拿起|放下)/u,
    (_match, target: string, verb: string) => `${verb}${target}`,
  );

  const match = findCanonicalVerb(compact) || findGenericSemanticVerb(compact);
  if (!match) {
    const state = [...compact].slice(0, 24).join('');
    return `${stage ? `${stage}|` : ''}状态:${state}`;
  }
  const target = canonicalTarget(compact.slice(match.index + match.source.length));
  return `${stage ? `${stage}|` : ''}${match.verb}${target ? `:${target}` : ''}`;
};

const signatureParts = (signature: string): { stage: string; verb: string; target: string } => {
  const [stageOrVerb = '', remainder = ''] = signature.split('|', 2);
  const stage = remainder ? stageOrVerb : '';
  const action = remainder || stageOrVerb;
  const separator = action.indexOf(':');
  return separator < 0
    ? { stage, verb: action, target: '' }
    : { stage, verb: action.slice(0, separator), target: action.slice(separator + 1) };
};

const semanticSignaturesEquivalent = (
  normalizedLeft: string,
  normalizedRight: string,
): boolean => {
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftParts = signatureParts(normalizedLeft);
  const rightParts = signatureParts(normalizedRight);
  if (leftParts.stage !== rightParts.stage && (leftParts.stage || rightParts.stage)) return false;
  if (leftParts.verb !== rightParts.verb) return false;
  if (!leftParts.target || !rightParts.target) return true;
  return leftParts.target.includes(rightParts.target) || rightParts.target.includes(leftParts.target);
};

/** Compare two action phrases by actor + semantic action, not shot ID or word order. */
export const semanticActionsEquivalent = (left: string, right: string): boolean => {
  const cleanLeft = stripLegacyContinuityLabels(left);
  const cleanRight = stripLegacyContinuityLabels(right);
  const leftActor = explicitActorOf(cleanLeft);
  const rightActor = explicitActorOf(cleanRight);
  if (leftActor && rightActor && leftActor !== rightActor) return false;
  return semanticSignaturesEquivalent(
    normalizeSemanticAction(cleanLeft),
    normalizeSemanticAction(cleanRight),
  );
};

const EXPOSITION_CONTEXT_PATTERN = /(?:背景说明|世界观|设定中|史书|史官|后世评论|后世评价|据记载|传说中|历法|谱牒|学者|评价)/u;
const INTERNAL_THOUGHT_PATTERN = /(?:心想|心里|心中|内心|脑海|暗想|想到|想着|思索|盘算|琢磨|犹豫|担心|害怕|感觉到?|觉得|意识到|认为|猜想|怀疑|希望|后悔|决定)/u;
const STATE_CHANGE_PATTERN = /(?:变得|变成|化作|转为|恢复为|开了|关了|暗了|亮了|红了|白了|黑了|碎了|塌了|静了|空了|满了|消散了?|凝固了?)/u;
const DIALOGUE_VERBS = new Set([
  '说话', '询问', '喊叫', '回答', '说道', '问道', '低声说', '大声喊', '吼道', '呼唤', '发出呼唤',
]);
const INTERNAL_THOUGHT_VERBS = new Set([
  '想到', '思索', '感觉', '感觉到', '分析出', '决定', '下定决心',
]);
const STATE_CHANGE_VERBS = new Set([
  '亮起', '响起', '熄灭', '出现', '消失', '变暗', '点燃', '吹灭', '爆炸', '碎裂', '坍塌', '苏醒',
]);
const ABSTRACT_NARRATIVE_VERBS = new Set([
  '状态', '需要', '派出', '增援', '帮助', '帮忙', '支撑',
]);

const classifySemanticBeat = (text: string, actionSignature: string): SemanticStoryBeatKind => {
  const clean = stripLegacyContinuityLabels(text);
  const verb = signatureParts(actionSignature).verb;
  if (EXPOSITION_CONTEXT_PATTERN.test(clean)) return 'exposition';
  if (dialogueTurnRanges(clean).length > 0 || DIALOGUE_VERBS.has(verb)) return 'dialogue';
  if (INTERNAL_THOUGHT_PATTERN.test(clean) || INTERNAL_THOUGHT_VERBS.has(verb)) {
    return 'internal-thought';
  }
  if (STATE_CHANGE_VERBS.has(verb) || STATE_CHANGE_PATTERN.test(clean)) return 'state-change';
  if (verb && !ABSTRACT_NARRATIVE_VERBS.has(verb)) return 'visible-action';
  return 'exposition';
};

const roundToTwo = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const semanticWeight = (text: string, signature: string): number => {
  const characters = [...compactSemanticText(text)].length;
  const kineticBoost = KINETIC_STAGES.some((stage) => signature.startsWith(`${stage}|`)) ? 0.25 : 0;
  return roundToTwo(Math.max(1, characters / 14 + kineticBoost));
};

const makeBeat = (text: string, index: number, sourceStart: number): SemanticStoryBeat => {
  const actionSignature = normalizeSemanticAction(text);
  return {
    id: `semantic_beat_${index + 1}`,
    index: index + 1,
    text,
    sourceStart,
    sourceEnd: sourceStart + text.length,
    actionSignature,
    kind: classifySemanticBeat(text, actionSignature),
    weight: semanticWeight(text, actionSignature),
  };
};

const mergeSymbolOnlyParts = (parts: string[]): string[] => {
  const merged: string[] = [];
  let pendingPrefix = '';
  parts.forEach((part) => {
    if (compactSemanticText(part)) {
      merged.push(pendingPrefix + part);
      pendingPrefix = '';
    } else if (merged.length > 0) {
      merged[merged.length - 1] += part;
    } else {
      pendingPrefix += part;
    }
  });
  if (pendingPrefix && merged.length > 0) merged[merged.length - 1] += pendingPrefix;
  return merged;
};

interface ClosedQuoteRange {
  open: number;
  closeEnd: number;
}

const SOURCE_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
  '"': '"',
};

const SPEECH_VOICE_MANNER = '(?:用|以)[^，,。！？!?；;：:\\n]{1,16}(?:声音|语气|口吻|口气|腔调|声线)';
export const SOURCE_SPEECH_CUE_PATTERN = `(?:(?:${SPEECH_VOICE_MANNER}|低声|柔声|轻声|沉声|厉声|怒声|高声|大声)(?:回答道|回答|说道|说|问道|问|答道|喊道|喊)|(?:低声|柔声|轻声|沉声|厉声|怒声|高声|大声)?(?:骂(?:了句|道)?|喝道|斥道)|低声说道|低声说|大声吼道|用威严的声音回答|补充道|补充|说道|回答道|回答|答道|询问|问道|吼道|喊道|说|问|喊|发出(?:了)?呼唤)`;

const SOURCE_SPEAKER_NAME_PATTERN = '[\\u4e00-\\u9fffA-Za-z0-9·]{2,12}?';
const SOURCE_SPEECH_CUE_TAIL = new RegExp(
  `${SOURCE_SPEECH_CUE_PATTERN}[：:，,。！？!?\\s]*$`,
  'u',
);
const SOURCE_SPEAKER_CUE_TAIL = new RegExp(
  `(?:^|[，,。！？!?；;”"’」』]\\s*)(${SOURCE_SPEAKER_NAME_PATTERN})(?:在[^，,。！？!?；;]{1,24})?(?:(?:对|朝着|朝|向)${SOURCE_SPEAKER_NAME_PATTERN})?${SOURCE_SPEECH_CUE_PATTERN}[：:，,。！？!?\\s]*$`,
  'u',
);
const SOURCE_SPEAKER_CUE_HEAD = new RegExp(
  `^[”"’，,。！？!?\\s]*(${SOURCE_SPEAKER_NAME_PATTERN})(?:在[^，,。！？!?；;]{1,24})?(?:(?:对|朝着|朝|向)${SOURCE_SPEAKER_NAME_PATTERN})?${SOURCE_SPEECH_CUE_PATTERN}`,
  'u',
);

/** Speech delivery is not a person's name, including when the cue omits its subject. */
export const cleanSourceSpeechSpeakerCandidate = (value: string): string => {
  const candidate = value
    .replace(/^(?:随后|然后|接着|紧接着|这时|此时|随即)/u, '')
    .replace(/(?:又|再)$/u, '')
    .trim();
  return /^(?:低声|柔声|轻声|沉声|厉声|怒声|高声|大声)$/u.test(candidate)
    || /^(?:(?:他们|她们|它们|他|她|它|祂))?(?:用|以).*(?:声音|语气|口吻|口气|腔调|声线)$/u.test(candidate)
    ? ''
    : candidate;
};

export interface QuotedSpeechContext {
  isDialogue: boolean;
  speakerCandidate: string;
}

/** Shared quote classifier for prompt rendering and continuity cleanup. */
export const classifyQuotedSpeechContext = (
  source: string,
  quoteStart: number,
  quoteEnd: number,
  previousDialogueEnd = -1,
  previousSpeaker = '',
): QuotedSpeechContext => {
  const spoken = source.slice(quoteStart + 1, quoteEnd - 1).trim();
  if (!spoken) return { isDialogue: false, speakerCandidate: '' };
  const prefix = source.slice(0, quoteStart);
  const suffix = source.slice(quoteEnd);
  const beforeSpeaker = cleanSourceSpeechSpeakerCandidate(
    prefix.match(SOURCE_SPEAKER_CUE_TAIL)?.[1] || '',
  );
  const afterSpeaker = cleanSourceSpeechSpeakerCandidate(
    suffix.match(SOURCE_SPEAKER_CUE_HEAD)?.[1] || '',
  );
  const postposedCueHasSpeechBoundary = /[。！？!?…]\s*$/u.test(spoken)
    || /^[，,。！？!?；;\s]/u.test(suffix);
  const acceptedAfterSpeaker = postposedCueHasSpeechBoundary ? afterSpeaker : '';
  const hasCue = SOURCE_SPEECH_CUE_TAIL.test(prefix) || Boolean(acceptedAfterSpeaker);
  const continuesDialogue = previousDialogueEnd >= 0
    && /^[\s，,。！？!?；;：:]*$/u.test(source.slice(previousDialogueEnd, quoteStart));
  const isStandaloneDialogue = !prefix.trim()
    && /[。！？!?…]\s*$/u.test(spoken)
    && (!suffix.trim() || /^[，,。；;\s]*(?:镜头重点表现|动作与信息)/u.test(suffix));
  const isDialogue = hasCue || continuesDialogue || isStandaloneDialogue;
  return {
    isDialogue,
    speakerCandidate: isDialogue
      ? beforeSpeaker || acceptedAfterSpeaker || (continuesDialogue ? previousSpeaker : '')
      : '',
  };
};

const sourceCharacterIsEscaped = (source: string, index: number): boolean => {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

/** Record only confirmed, closed quote spans; an orphan opening quote must not
 * absorb the rest of the story and disable later semantic boundaries. */
const closedQuoteRanges = (source: string): ClosedQuoteRange[] => {
  const stack: Array<{ open: number; close: string }> = [];
  const ranges: ClosedQuoteRange[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const top = stack[stack.length - 1];
    if (top && character === top.close && !sourceCharacterIsEscaped(source, index)) {
      stack.pop();
      ranges.push({ open: top.open, closeEnd: index + 1 });
      continue;
    }
    const close = SOURCE_QUOTE_PAIRS[character];
    if (close && !sourceCharacterIsEscaped(source, index)) {
      stack.push({ open: index, close });
    }
  }
  return ranges;
};

export const DEFAULT_FIRST_PERSON_SUBJECT = '无名主角';

const outermostClosedQuoteRanges = (source: string): ClosedQuoteRange[] => {
  const ranges = closedQuoteRanges(source);
  return ranges.filter((range, index) => !ranges.some((outer, outerIndex) => (
    outerIndex !== index
    && outer.open < range.open
    && range.closeEnd < outer.closeEnd
  ))).sort((left, right) => left.open - right.open);
};

/** First-person rewriting has a stricter preservation contract than general
 * story segmentation: once dialogue opens, even a truncated/unclosed quote
 * remains authored speech through the end of the available source. */
const firstPersonProtectedQuoteRanges = (source: string): ClosedQuoteRange[] => {
  const stack: Array<{ open: number; close: string }> = [];
  const ranges: ClosedQuoteRange[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const top = stack[stack.length - 1];
    if (top && character === top.close && !sourceCharacterIsEscaped(source, index)) {
      stack.pop();
      ranges.push({ open: top.open, closeEnd: index + 1 });
      continue;
    }
    const close = SOURCE_QUOTE_PAIRS[character];
    if (close && !sourceCharacterIsEscaped(source, index)) {
      stack.push({ open: index, close });
    }
  }
  stack.forEach((entry) => ranges.push({ open: entry.open, closeEnd: source.length }));
  return ranges.filter((range, index) => !ranges.some((outer, outerIndex) => (
    outerIndex !== index
    && outer.open < range.open
    && range.closeEnd <= outer.closeEnd
  ))).sort((left, right) => left.open - right.open);
};

const mapOutsideFirstPersonQuotes = (
  source: string,
  transform: (value: string) => string,
): string => {
  const ranges = firstPersonProtectedQuoteRanges(source);
  if (!ranges.length) return transform(source);
  let cursor = 0;
  let result = '';
  ranges.forEach((range) => {
    result += transform(source.slice(cursor, range.open));
    result += source.slice(range.open, range.closeEnd);
    cursor = range.closeEnd;
  });
  return result + transform(source.slice(cursor));
};

/** Return only prose outside quote spans, including a trailing incomplete
 * dialogue span. Keep a separator so opposite sides cannot join by accident. */
const textOutsideFirstPersonQuotes = (source: string): string => {
  const ranges = firstPersonProtectedQuoteRanges(source);
  if (!ranges.length) return source;
  let cursor = 0;
  let result = '';
  ranges.forEach((range) => {
    result += source.slice(cursor, range.open);
    result += ' ';
    cursor = range.closeEnd;
  });
  return result + source.slice(cursor);
};

const FIRST_PERSON_ACTOR_AFTER = /^(?:已经|正在|曾经|曾|将要|将|会|要|可以|必须|刚刚|刚|才|也|却|仍|还|就|都|不再|不|没有|没|校准|校对|校验|校正|看过|看|读过|读|完成|通过|拔|走|跑|推|拉|抬|低|转|握|抓|冲|站|坐|说|问|回答|掐|翻|侧身|伸手)/u;
const FIRST_PERSON_OBJECT_CUE_AT_END = /(?:朝着|朝向|走向|转向|看向|望向|面向|移向|靠向|跑向|飞向|爬向|迈向|指向|瞄向|投向|挥向|刺向|劈向|砸向|踢向|伸向|抓向|扑向|冲向|奔向|为了|围着|绕着|跟着|朝|向|对|给|跟|替|(?<!因)为|冲|发现|看见|看到|盯着|望着|看着|告诉|让|把|将)\s*$/u;
const FIRST_PERSON_OBJECT_ACTOR_AT_START = /^(他们|她们|它们|祂们|他|她|它|祂|[\p{L}\p{N}·]{0,8}(?:女子|男子|少女|少年|姑娘|女人|男人|老人|老者|妇人|女孩|男孩|主角|说话者|弟子|师父|师姐|师妹|侍女|守卫|士兵|玩家|道人|和尚|剑客|刺客|掌柜|蛇妖|妖女|对手|敌人))/u;
const FIRST_PERSON_OBJECT_CLAUSE_LEAD = /^(?:(?:随后|然后|接着|这时|此时|于是|忽然|不料|下一刻|但|而|可|只见|院中|庭中|林间|屋内|房中|门外|树后|远处|近处)[，,]?\s*)+/u;
const FIRST_PERSON_OBJECT_ACTOR_GAP = /^(?:(?:忽然|突然|猛然|蓦地|骤然|缓缓|立刻|随即|径直|悄然|迅速|飞快|慢慢|很快|终于|早已|又|再|正|正在|已经|低声|大声|冷冷|直直|狠狠|猛地|飞快地|慢慢地|一步步|一眼|转身|侧身|抬手|伸手|挥手|抬头|抬眼|抬眸|回头|扭头|低头|咬牙|俯身|起身|迈步|快步|疾步|缓步|抬脚|定睛|凝神|怒目)\s*){0,4}$/u;
const FIRST_PERSON_OBJECT_CONTINUATION_AFTER = /^(?:冲|走|跑|扑|刺|劈|砍|抓|挥|砸|踢|撞|射|飞|爬|逼|靠|接近|抬|伸|拔|转|回|退|闪|跃|跳|攻|袭)/u;

const firstPersonObjectActorBefore = (
  before: string,
  after: string,
  actorCandidates: readonly string[],
): string => {
  const cue = before.match(FIRST_PERSON_OBJECT_CUE_AT_END);
  if (!cue || cue.index === undefined) return '';
  const actorContext = (before
    .slice(0, cue.index)
    .split(/[，,。！？!?；;]/u)
    .pop() || '')
    .replace(FIRST_PERSON_OBJECT_CLAUSE_LEAD, '')
    .trim();
  if (!actorContext) return '';
  const cueText = cue[0].trim();
  const directionalContinuation = (
    /(?:向|朝|对|着)$/u.test(cueText)
    && FIRST_PERSON_OBJECT_CONTINUATION_AFTER.test(after)
  );
  const validActorGap = (gap: string): boolean => (
    FIRST_PERSON_OBJECT_ACTOR_GAP.test(gap)
    || (
      directionalContinuation
      && gap.length <= 12
      && !/(?:的|方向|方位|位置|区域|附近|一带|左侧|右侧|上方|下方|前方|后方)/u.test(gap)
    )
  );
  const groundedCandidate = actorCandidates
    .map((candidate) => String(candidate || '').replace(/^@/u, '').trim())
    .filter((name) => name.length >= 2)
    .sort((left, right) => right.length - left.length)
    .find((name) => (
      actorContext.startsWith(name)
      && validActorGap(actorContext.slice(name.length))
    ));
  if (groundedCandidate) return groundedCandidate;
  const roleActor = actorContext.match(FIRST_PERSON_OBJECT_ACTOR_AT_START)?.[1] || '';
  return roleActor && validActorGap(actorContext.slice(roleActor.length)) ? roleActor : '';
};

/** Chinese has several fixed words containing “我”. Classify the complete
 * lexical phrase instead of blacklisting one adjacent character, otherwise
 * real narration such as “我校准…” or “这本我已经…” is lost. */
const isLexicalFirstPersonOccurrence = (
  source: string,
  index: number,
): boolean => {
  const before = source.slice(0, index);
  const after = source.slice(index + 1);
  if (/^(?:国|市)/u.test(after)) return true;
  if (/^校(?!准|对|验|正|阅|勘|订)/u.test(after)) return true;
  if (/^司(?=今日|昨日|明日|将|已|拟|发布|公告|公司|员工|业务|项目)/u.test(after)) return true;
  if (/^院(?=师生|学生|教师|医护|患者|领导|今日|将|已|发布|公告)/u.test(after)) return true;
  if (/^省(?=降雨|天气|气温|居民|政府|全境|多地|今日|将|已)/u.test(after)) return true;
  if (/^县(?=政府|居民|城区|全境|今日|将|已)/u.test(after)) return true;
  if (/^区(?=政府|居民|城区|全境|今日|将|已)/u.test(after)) return true;
  const preceding = before.slice(-1);
  if (/[忘自唯无]/u.test(preceding)) return true;
  if (/[超本]/u.test(preceding)) {
    return !FIRST_PERSON_ACTOR_AFTER.test(after);
  }
  return false;
};

interface NarrativeFirstPersonOccurrence {
  token: '我' | '我们' | '咱们' | '我方';
  index: number;
}

const narrativeFirstPersonOccurrences = (source: string): NarrativeFirstPersonOccurrence[] => (
  Array.from(source.matchAll(/我们|咱们|我方|我/gu))
    .map((match) => ({
      token: match[0] as NarrativeFirstPersonOccurrence['token'],
      index: match.index,
    }))
    .filter((occurrence) => (
      occurrence.token !== '我'
      || !isLexicalFirstPersonOccurrence(source, occurrence.index)
    ))
);

/** True only for first-person prose outside quoted speech or visible labels. */
export const hasNarrativeFirstPersonReference = (value: string): boolean => (
  narrativeFirstPersonOccurrences(
    textOutsideFirstPersonQuotes(String(value || '')),
  ).length > 0
);

export const resolveNarrativeFirstPersonObjectActor = (
  value: string,
  actorCandidates: readonly string[] = [],
): string => {
  const prose = textOutsideFirstPersonQuotes(String(value || ''));
  for (const occurrence of narrativeFirstPersonOccurrences(prose)) {
    const before = prose.slice(0, occurrence.index);
    const after = prose.slice(occurrence.index + occurrence.token.length);
    const startsActorClause = /(?:^|[，,。！？!?；;])\s*(?:(?:随后|然后|接着|这时|此时|于是|忽然|不料|下一刻|但|而|可|只见)\s*)?$/u.test(before);
    if (startsActorClause) continue;
    const actor = firstPersonObjectActorBefore(before, after, actorCandidates);
    if (actor) return actor;
  }
  return '';
};

/** Distinguish a visible first-person performer from an object such as
 * “朝我面门刺来”. Quoted dialogue never establishes the camera subject. */
export const hasNarrativeFirstPersonActor = (
  value: string,
  actorCandidates: readonly string[] = [],
): boolean => {
  const prose = textOutsideFirstPersonQuotes(String(value || ''));
  return narrativeFirstPersonOccurrences(prose).some((occurrence) => {
    const before = prose.slice(0, occurrence.index);
    const after = prose.slice(occurrence.index + occurrence.token.length);
    const startsActorClause = /(?:^|[，,。！？!?；;])\s*(?:(?:随后|然后|接着|这时|此时|于是|忽然|不料|下一刻|但|而|可|只见)\s*)?$/u.test(before);
    if (startsActorClause) return true;
    if (firstPersonObjectActorBefore(before, after, actorCandidates)) return false;
    return FIRST_PERSON_ACTOR_AFTER.test(after);
  });
};

const FIRST_PERSON_NAME_DECLARATION = /(?:我叫|我名叫|我的名字是|我乃)([\p{L}\p{N}·]{2,12})(?=[，,。！？!?；;\s]|$)/u;
const FIRST_PERSON_SPEECH_CUE_TAIL = new RegExp(
  `(?:^|[，,。！？!?；;”"'’」』]\\s*)(?:我|我们|咱们)(?:又|再|低声|轻声|沉声|厉声|高声|大声)*${SOURCE_SPEECH_CUE_PATTERN}[：:，,。！？!?\\s]*$`,
  'u',
);

const validDeclaredFirstPersonName = (value: string): string => {
  const name = String(value || '').trim();
  return name && !/^(?:我们|咱们|无名|一个|一名|一位)/u.test(name) ? name : '';
};

const selfDeclaredNameInsideDialogue = (source: string): string => {
  for (const range of outermostClosedQuoteRanges(source)) {
    const prefix = source.slice(0, range.open);
    if (!FIRST_PERSON_SPEECH_CUE_TAIL.test(prefix)) continue;
    const open = source[range.open];
    const expectedClose = SOURCE_QUOTE_PAIRS[open];
    const hasClosingQuote = source[range.closeEnd - 1] === expectedClose;
    const dialogue = source.slice(range.open + 1, hasClosingQuote ? range.closeEnd - 1 : range.closeEnd);
    const name = validDeclaredFirstPersonName(dialogue.match(FIRST_PERSON_NAME_DECLARATION)?.[1] || '');
    if (name) return name;
  }
  return '';
};

/** Resolve an explicitly named first-person performer when the source states
 * one; otherwise use one stable visible identity instead of an @我 phrase. */
export const resolveFirstPersonSubject = (
  source: string,
  candidateNames: readonly string[] = [],
): string => {
  if (!hasNarrativeFirstPersonReference(source)) return '';
  const prose = textOutsideFirstPersonQuotes(String(source || ''));
  const declared = validDeclaredFirstPersonName(prose.match(FIRST_PERSON_NAME_DECLARATION)?.[1] || '');
  if (declared) return declared;
  const dialogueDeclared = selfDeclaredNameInsideDialogue(String(source || ''));
  if (dialogueDeclared) return dialogueDeclared;
  const namedIdentity = candidateNames
    .map((name) => String(name || '').trim())
    .filter((name) => name.length >= 2 && name.length <= 12)
    .find((name) => (
      prose.includes(`我是${name}`)
      || prose.includes(`我便是${name}`)
      || prose.includes(`我就是${name}`)
    ));
  return namedIdentity || DEFAULT_FIRST_PERSON_SUBJECT;
};

/** Replace narrative-person pronouns while preserving every closed quoted
 * span byte-for-byte so original dialogue such as “我不会退” is untouched. */
export const rewriteNarrativeFirstPersonReferences = (
  value: string,
  subject = DEFAULT_FIRST_PERSON_SUBJECT,
): string => {
  const stableSubject = String(subject || '').trim() || DEFAULT_FIRST_PERSON_SUBJECT;
  return mapOutsideFirstPersonQuotes(String(value || ''), (part) => part
    .replace(
      /(?:我叫|我名叫|我的名字是|我乃)([\p{L}\p{N}·]{2,12})(?=[，,。！？!?；;\s]|$)/gu,
      (_declaration, declaredName: string) => (
        declaredName === stableSubject
          ? `${stableSubject}自报姓名`
          : `${stableSubject}自报姓名为${declaredName}`
      ),
    )
    .replace(/我们|咱们|我方|我/gu, (token: string, offset: number, sourcePart: string) => {
      if (token === '我方') return `${stableSubject}一方`;
      if (token === '我们' || token === '咱们') return `${stableSubject}一行人`;
      return isLexicalFirstPersonOccurrence(sourcePart, offset)
        ? token
        : stableSubject;
    }));
};

const dialogueTurnRanges = (source: string): ClosedQuoteRange[] => {
  const outermost = outermostClosedQuoteRanges(source);
  const dialogueRanges: ClosedQuoteRange[] = [];
  let previousDialogueEnd = -1;
  let previousSpeaker = '';
  outermost.forEach((range) => {
    const context = classifyQuotedSpeechContext(
      source,
      range.open,
      range.closeEnd,
      previousDialogueEnd,
      previousSpeaker,
    );
    if (!context.isDialogue) {
      previousDialogueEnd = -1;
      previousSpeaker = '';
      return;
    }
    dialogueRanges.push(range);
    previousDialogueEnd = range.closeEnd;
    previousSpeaker = context.speakerCandidate;
  });
  return dialogueRanges;
};

/**
 * Remove only confirmed spoken quote spans while preserving quoted names,
 * labels and other visual source text. Continuity hand-offs use this so a
 * line already spoken in the final shot is not spoken again by the next
 * generated segment.
 */
export const stripDialogueTurns = (source: string): string => {
  const ranges = dialogueTurnRanges(String(source || ''))
    .sort((left, right) => left.open - right.open);
  if (!ranges.length) return source;

  let cursor = 0;
  const parts: string[] = [];
  ranges.forEach((range) => {
    parts.push(source.slice(cursor, range.open));
    cursor = range.closeEnd;
  });
  parts.push(source.slice(cursor));
  return parts.join('');
};

const rangeContainsOffset = (range: ClosedQuoteRange, offset: number): boolean => (
  range.open < offset && offset < range.closeEnd
);

const partsAtOffsets = (source: string, offsets: Iterable<number>): string[] => {
  const boundaries = Array.from(new Set([0, ...offsets, source.length]))
    .filter((offset) => Number.isInteger(offset) && offset >= 0 && offset <= source.length)
    .sort((left, right) => left - right);
  return mergeSymbolOnlyParts(boundaries.slice(0, -1).map((start, index) => (
    source.slice(start, boundaries[index + 1])
  )));
};

const semanticVerbOfTerm = (term: string): string => (
  signatureParts(normalizeSemanticAction(term)).verb
);

const termCanStartFilmableSentence = (term: string): boolean => {
  if (MULTI_EVENT_SPLIT_TERMS.has(term)) return true;
  const verb = semanticVerbOfTerm(term);
  return Boolean(
    verb
    && !ABSTRACT_NARRATIVE_VERBS.has(verb)
    && !INTERNAL_THOUGHT_VERBS.has(verb)
    && !DIALOGUE_VERBS.has(verb),
  );
};

/**
 * Add mandatory boundaries for complete dialogue turns and for a new sentence
 * that contains a visible/state event. Punctuation only locates the beginning
 * of an already-detected semantic event; it never creates an event by itself.
 */
const addCompleteSemanticBoundaries = (
  source: string,
  rawParts: string[],
  matches: RegExpMatchArray[],
): string[] => {
  const offsets: number[] = [];
  let rawOffset = 0;
  rawParts.slice(0, -1).forEach((part) => {
    rawOffset += part.length;
    offsets.push(rawOffset);
  });

  const quoteRanges = closedQuoteRanges(source);
  const dialogueRanges = dialogueTurnRanges(source);
  dialogueRanges.forEach((range) => {
    if (compactSemanticText(source.slice(range.closeEnd))) offsets.push(range.closeEnd);
  });

  matches.forEach((match) => {
    const matchStart = match.index || 0;
    if (quoteRanges.some((range) => rangeContainsOffset(range, matchStart))) return;
    const matchEnd = matchStart + match[0].length;
    const verb = semanticVerbOfTerm(match[0]);
    const dialogueFollows = DIALOGUE_VERBS.has(verb) && dialogueRanges.some((range) => (
      range.open >= matchEnd
      && /^[\s，,。！？!?；;：:、…—道着地得]*$/u.test(source.slice(matchEnd, range.open))
    ));
    if (!termCanStartFilmableSentence(match[0]) && !dialogueFollows) return;

    const delimiter = lastMatch(source.slice(0, matchStart), /[。！？!?；;\n]\s*/gu);
    if (delimiter?.index === undefined) return;
    const boundary = delimiter.index + delimiter[0].length;
    if (boundary > 0 && boundary < source.length) offsets.push(boundary);
  });

  return partsAtOffsets(source, offsets);
};

/**
 * Action-anchor splitting can propose a cut inside dialogue. Move such
 * boundaries after the matching closing quote, using UTF-16 offsets so the
 * result can be rebuilt losslessly with String.slice.
 */
const moveSemanticBoundariesOutsideClosedQuotes = (
  source: string,
  rawParts: string[],
): string[] => {
  if (rawParts.length < 2) return rawParts;
  const quoteRanges = closedQuoteRanges(source);
  if (!quoteRanges.length) return rawParts;

  let offset = 0;
  const rawBoundaries = rawParts.slice(0, -1).map((part) => {
    offset += part.length;
    return offset;
  });
  const protectedBoundaries = rawBoundaries.map((boundary) => quoteRanges.reduce(
    (safeBoundary, range) => (
      range.open < boundary && boundary < range.closeEnd
        ? Math.max(safeBoundary, range.closeEnd)
        : safeBoundary
    ),
    boundary,
  ));
  const boundaries = Array.from(new Set([0, ...protectedBoundaries, source.length]))
    .sort((left, right) => left - right);
  return mergeSymbolOnlyParts(boundaries.slice(0, -1).map((start, index) => (
    source.slice(start, boundaries[index + 1])
  )));
};

const SUBJECT_BEFORE_ACTION_TERMS = new Set<string>([
  '抬头', '低头', '回头', '转身', '转过身',
]);

const lastMatch = (value: string, pattern: RegExp): RegExpMatchArray | undefined => {
  const matches = [...value.matchAll(pattern)];
  return matches[matches.length - 1];
};

/**
 * Turn action anchors into disjoint source spans. The spans cover the source
 * exactly once; punctuation is attached to a neighbour but never becomes an
 * event of its own.
 */
const exactPartsForVisibleMatches = (
  source: string,
  matches: RegExpMatchArray[],
): string[] => {
  const boundaries = [0];
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const previousEnd = (previous.index || 0) + previous[0].length;
    const currentStart = matches[index].index || previousEnd;
    const prefix = source.slice(previousEnd, currentStart);
    let boundary = SUBJECT_BEFORE_ACTION_TERMS.has(previous[0])
      ? previousEnd
      : currentStart;
    const connector = lastMatch(prefix, /(?:然后|随后|接着|继而|同时|并且|于是|终于|立刻|随即|转而|重新|又|并(?!没有|未|不))/gu);
    if (connector?.index !== undefined) {
      boundary = previousEnd + connector.index;
    }
    if (boundary === currentStart) {
      const delimiter = lastMatch(prefix, /[。！？!?；;，,\n]\s*/gu);
      if (delimiter?.index !== undefined) {
        const actorOrModifier = prefix.slice(delimiter.index + delimiter[0].length).trim();
        if (actorOrModifier) {
          boundary = previousEnd + delimiter.index + delimiter[0].length;
        }
      }
    }
    if (boundary === currentStart) {
      const currentEnd = currentStart + matches[index][0].length;
      const nextStart = matches[index + 1]?.index ?? source.length;
      const previousTargetAndActor = compactSemanticText(prefix).replace(/^(?:了|着)/u, '');
      const currentTarget = compactSemanticText(source.slice(currentEnd, nextStart)).replace(/^(?:了|着)/u, '');
      if (currentTarget && previousTargetAndActor.startsWith(currentTarget)) {
        const actorTail = previousTargetAndActor.slice(currentTarget.length);
        if (
          /^[\p{L}\p{N}·]{1,12}$/u.test(actorTail)
          && !/^(?:又|并|重新|继续|再次|接着|随后|然后)$/u.test(actorTail)
        ) {
          boundary = currentStart - actorTail.length;
        }
      }
    }
    if (boundary === currentStart) {
      if (/^(?:推开|拉开|打开|关上|关闭|踹开|破门)$/u.test(previous[0])) {
        const doorTarget = prefix.match(/^(?:(?:了|着|那扇|这扇|一扇|厚重|沉重|破旧|老旧|木制|铁制|金属制|关闭的|面前的))*?(?:舱门|木门|铁门|房门|大门|门扇|门)/u);
        if (doorTarget && doorTarget[0].length < prefix.length) {
          boundary = previousEnd + doorTarget[0].length;
        }
      }
      const objectMarkerIndex = Math.max(prefix.lastIndexOf('把'), prefix.lastIndexOf('将'));
      if (boundary === currentStart && objectMarkerIndex >= 0) {
        const beforeObject = prefix.slice(0, objectMarkerIndex);
        const preparation = beforeObject.match(/(?:伸出?手|抬起手|用力|猛然|迅速|缓缓|慢慢)$/u);
        boundary = preparation?.index === undefined
          ? previousEnd
          : previousEnd + preparation.index;
      }
    }
    boundaries.push(Math.max(boundaries[boundaries.length - 1], boundary));
  }
  boundaries.push(source.length);
  return mergeSymbolOnlyParts(boundaries.slice(0, -1).map((start, index) => (
    source.slice(start, boundaries[index + 1])
  )));
};

const selectSemanticEventAnchors = (matches: RegExpMatchArray[]): RegExpMatchArray[] => (
  matches.filter((match, index) => {
    if (MULTI_EVENT_SPLIT_TERMS.has(match[0])) return true;
    return index === 0;
  })
);

/**
 * Extract visual/narrative events from actual action and state-change signals.
 * Commas, colons, semicolons and line breaks are discarded as presentation;
 * adding them cannot create events or increase timing weight.
 */
export const extractSemanticStoryBeats = (
  story: string,
  options: SemanticStoryBeatExtractionOptions = {},
): SemanticStoryBeat[] => {
  const source = String(story || '');
  if (!compactSemanticText(source)) return [];
  const strategy: SemanticStoryBeatStrategy = options.strategy === 'faithful'
    ? 'faithful'
    : 'compact';

  EVENT_TERM_PATTERN.lastIndex = 0;
  const matches = [...source.matchAll(EVENT_TERM_PATTERN)];
  const anchors = selectSemanticEventAnchors(matches);
  const anchoredParts = anchors.length > 1
    ? exactPartsForVisibleMatches(source, anchors)
    : [source];
  const completeParts = addCompleteSemanticBoundaries(source, anchoredParts, matches);
  const parts = moveSemanticBoundariesOutsideClosedQuotes(source, completeParts);

  let sourceOffset = 0;
  const beats = parts.map((part, index) => {
    const beat = makeBeat(part, index, sourceOffset);
    sourceOffset += part.length;
    return beat;
  });
  const deduplicated: SemanticStoryBeat[] = [];
  beats.forEach((beat) => {
    const previous = deduplicated[deduplicated.length - 1];
    if (
      strategy === 'compact'
      && previous
      && semanticActionsEquivalent(previous.text, beat.text)
    ) {
      previous.text += beat.text;
      previous.sourceEnd = beat.sourceEnd;
      return;
    }
    const index = deduplicated.length + 1;
    deduplicated.push({ ...beat, id: `semantic_beat_${index}`, index });
  });
  return deduplicated;
};
