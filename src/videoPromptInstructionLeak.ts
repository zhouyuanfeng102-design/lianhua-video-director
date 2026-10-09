import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

const internalConstraintLabel = String.raw`(?:规则基础|连续性规则|输出规则|转换器输出|转换器[ \t]+[^：:\r\n]{0,80}|Base[ \t]+rules|Continuity[ \t]+rules|Output[ \t]+rules|Converter[ \t]+output|Converter[ \t]+[^：:\r\n]{0,80})[：:]`;

/** These labels are reserved for PromptPlan's renderer/converter metadata.
 * Product requirements and authored timeline/dialogue remain separate. */
export const isInternalVideoPromptConstraint = (value: string): boolean => new RegExp(
  `^[ \\t]*(?:[-*][ \\t]*)?${internalConstraintLabel}`, 'iu',
).test(value);

const instructionSignals = [
  /\brequiredDialogues\b[^\n]{0,240}(?:逐句保留|原语言|说话人|完整对白|原话|发言记录)/u,
  /(?:只|仅)(?:返回|输出)(?:一个|完整|最终|合法|有效|的|本次约定的|对应)*[ \t]*(?:JSON|json|正文|提示词正文|六字段|交付对象|结构化)/u,
  /(?:不要|不得|禁止)输出[ \t]*(?:规则解释|规则说明|审核说明|代码围栏|说明文字)/u,
  /(?:canonicalPrompt|h3Prompt|shotSourceIds|shotMetadata)[^\n]{0,160}(?:必须|严格|沿用|一对一|原序|同步|对应)/u,
  /\brequiredDialogues\b[^\n]{0,240}\b(?:preserve|keep|original|speaker|dialogue|utterances)\b/iu,
  /\b(?:only\s+(?:return|output)|(?:return|output)\s+only)\b[^\n]{0,100}\b(?:JSON|prompt|body|timeline|object)\b/iu,
  /\b(?:do\s+not|don't|never)\s+(?:return|output)\s+(?:rule\s+(?:explanations|instructions)|review\s+notes|code\s+fences)\b/iu,
];

/** Inspect generated prose, never the whole serialized response envelope.
 * Literal dialogue, sound payloads and quoted on-screen text can intentionally
 * discuss a converter or these field names and are not generation rules. */
export const getVideoPromptInstructionLeak = (value: string): string | undefined => {
  const prose = maskVideoPictureReferenceLiterals(value);
  const labels = [...prose.matchAll(new RegExp(
    `(?:^|\\n|[；;｜|])[ \\t]*(?:[-*][ \\t]*)?${internalConstraintLabel}`, 'giu',
  ))];
  const signals = instructionSignals.filter((signal) => signal.test(prose)).length;
  const bareOutputContract = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:请)?(?:(?:只|仅)(?:返回|输出)(?:一个|完整|最终|合法|有效|的)*[ \t]*(?:JSON|json|正文|提示词正文|六字段|交付对象|结构化)|(?:不要|不得|禁止)输出[ \t]*(?:规则解释|规则说明|审核说明|代码围栏|说明文字))/u.test(prose);
  const englishOutputContract = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:please\s+)?(?:(?:only\s+(?:return|output)|(?:return|output)\s+only)\s+(?:(?:one|a|the|complete|final|valid)\s+)*(?:JSON|prompt|body|timeline|object)\b|(?:do\s+not|don't|never)\s+(?:return|output)\s+(?:rule\s+(?:explanations|instructions)|review\s+notes|code\s+fences)\b)/iu.test(prose);
  const factoryOutputContract = /(?:输出逐镜正文|每镜保留输入时间标题)/u.test(prose)
    && /主体\s*[、，,]\s*空间\s*[、，,]\s*光影\s*[、，,]\s*镜头\s*[、，,]\s*台词\s*[、，,]\s*音效六字段/u.test(prose)
    && /不要输出规则解释/u.test(prose);
  const actionRuleEcho = /\b(?:VIDEO_ACTION_CHOREOGRAPHY(?:_PRESERVE|_TRANSLATE)?_V1|VIDEO_ACTION_CAUSALITY_V1|SEEDANCE_CONTINUOUS_ACTION_V2)\s*[：:]/u.test(prose);
  if (labels.length >= 2 || labels.length && signals || bareOutputContract || englishOutputContract || factoryOutputContract || actionRuleEcho
    || /\brequiredDialogues\b/u.test(prose) && signals >= 2) {
    return '返回内容包含提示词生成规则或转换器输出要求，不能作为视频正文保存；请重新生成对应提示词，原稿已保留。';
  }
  return undefined;
};

export class VideoPromptInstructionLeakError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'VideoPromptInstructionLeakError'; }
}

export const assertVideoPromptHasNoInstructionLeak = (value: string, label = '视频提示词'): void => {
  const issue = getVideoPromptInstructionLeak(value);
  if (issue) throw new VideoPromptInstructionLeakError(`${label}：${issue}`);
};
