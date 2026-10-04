const NSFW_MARKER_SOURCE = String.raw`(?:\bnsfw\b|\br-?18\b|成人向|成人内容|\badult\s+content\b)`;
const NSFW_NUDITY_SOURCE = String.raw`(?:
  全裸|赤裸|赤身|裸身|一丝不挂|脱光|裸体|袒胸露乳
  |脱(?:下|掉|去)?[^，。！？；\s]{0,8}(?:全部衣物|所有衣物|身上衣物|内衣|内裤|胸罩|泳装)
  |(?:全身|身体|躯体|上身|下身)(?:完全)?裸露
  |裸露(?:着|出|了|其|的)?(?:全身|身体|躯体|私密部位|私处|胸部|乳房|乳头|下体|阴部|生殖器|臀部|臀缝)
  |\b(?:nude|nudity|naked)\b
)`.replace(/\s+/gu, '');
const NSFW_ANATOMY_SOURCE = String.raw`(?:
  私密部位|私处|性器官|生殖器|外阴|阴部|阴道|阴唇|阴茎|阳具|肉棒|龟头|马眼
  |小穴|阴蒂|穴口|蜜穴|肉穴|处女膜|尿道口|会阴|蜜液|爱液|精液|阴囊|睾丸
  |屁穴|菊穴|后穴|后庭|肛门|臀缝|乳房|乳头|乳尖|乳晕
  |\b(?:breasts?|nipples?|genitals?|penis|vagina|vulva|clitoris|labia|anus|testicles?|semen|cum)\b
)`.replace(/\s+/gu, '');
const NSFW_ACTION_SOURCE = String.raw`(?:
  情色|色情|性爱|性交|性行为|交合|交媾|行房|云雨|床笫|媾合|发生关系
  |自慰|口交|肛交|乳交|足交|骑乘位|后入|勃起|抽插|抽送|内射|射精|性高潮|高潮痉挛|潮吹|强奸|轮奸
  |\bexplicit\s+sex\b|\bsex(?:ual)?\s+intercourse\b|\bsexual\s+activity\b|\bsexual\s+acts?\b
  |\bmasturbat(?:e|es|ed|ing|ion)\b|\boral\s+sex\b|\banal\s+sex\b
  |\bfellatio\b|\bcunnilingus\b|\berection\b|\bpenetration\b|\borgasm\b|\bejaculat(?:e|es|ed|ing|ion)\b
  |\berotic\b|\bporn(?:ographic|ography)?\b
)`.replace(/\s+/gu, '');
const NSFW_INTIMATE_TOUCH_SOURCE = String.raw`(?:
  (?:手|手掌|掌心|手指|指尖)[^，。！？；;\n]{0,16}(?:抚摸|轻抚|爱抚|揉捏|揉搓|揉弄|抓揉)[^，。！？；;\n]{0,10}(?:胸前|胸口|胸部|乳房|乳头|乳晕|私处|下体|阴部|外阴|阴茎|臀缝|肛门)
  |(?:抚摸|轻抚|爱抚|揉捏|揉搓|揉弄|抓揉)[^，。！？；;\n]{0,10}(?:胸前|胸口|胸部|乳房|乳头|乳晕|私处|下体|阴部|外阴|阴茎|臀缝|肛门)
  |(?:胸前|胸口|胸部|乳房|乳头|乳晕|私处|下体|阴部|外阴|阴茎|臀缝|肛门)[^，。！？；;\n]{0,14}(?:抚摸|轻抚|爱抚|揉捏|揉搓|揉弄|抓揉)
)`.replace(/\s+/gu, '');
const NSFW_SIGNAL_SOURCE = `(?:${NSFW_MARKER_SOURCE}|${NSFW_NUDITY_SOURCE}|${NSFW_ANATOMY_SOURCE}|${NSFW_ACTION_SOURCE}|${NSFW_INTIMATE_TOUCH_SOURCE})`;
const NSFW_DETAIL_SIGNAL = new RegExp(NSFW_SIGNAL_SOURCE, 'iu');

const CLINICAL_ANATOMY_SOURCE = String.raw`(?:
  私密部位|私处|性器官|生殖器|外阴|阴部|阴道|阴唇|阴茎|阳具|龟头|马眼|阴蒂
  |处女膜|尿道口|会阴|精液|阴囊|睾丸|肛门|乳房|乳头|乳尖|乳晕
  |\b(?:breasts?|nipples?|genitals?|penis|vagina|vulva|clitoris|labia|anus|testicles?|semen)\b
)`.replace(/\s+/gu, '');
const CLINICAL_CONTEXT_SOURCE = String.raw`(?:
  X光|超声|检查|检验|化验|常规|病理|报告|样本|标本|诊断|治疗|医学|医疗|手术
  |切除|炎症|疾病|感染|影像|实验室|医院|医生|护士|患者|门诊|科室
  |\b(?:medical|clinical|routine|test|exam|examination|sample|specimen|laboratory|lab|diagnosis|treatment|surgery|ultrasound|x-?ray|patient|doctor|nurse|hospital)\b
)`.replace(/\s+/gu, '');
const CLINICAL_NSFW_MENTION = new RegExp(
  `(?:${CLINICAL_ANATOMY_SOURCE}|${NSFW_INTIMATE_TOUCH_SOURCE})[^，。！？；;\\n]{0,32}(?:${CLINICAL_CONTEXT_SOURCE})|(?:${CLINICAL_CONTEXT_SOURCE})[^，。！？；;\\n]{0,32}(?:${CLINICAL_ANATOMY_SOURCE}|${NSFW_INTIMATE_TOUCH_SOURCE})`,
  'giu',
);
const ART_NUDITY_MENTION = /(?:裸体|全裸|赤裸|赤身|裸身)(?:的)?(?:艺术摄影|艺术作品|人体艺术|雕塑|雕像|人体模型|素描|绘画|写生|摄影作品)|(?:艺术摄影|艺术作品|人体艺术|雕塑|雕像|人体模型|素描|绘画|写生|摄影作品)[^，。！？；;\n]{0,8}(?:裸体|全裸|赤裸|赤身|裸身)(?:姿态)?|\b(?:nude|naked|nudity)\s+(?:art|artistic\s+photography|photography|photograph|sculpture|statue|figure\s+drawing|life\s+drawing)\b|\b(?:art|artistic\s+photography|photography|sculpture|statue|figure\s+drawing|life\s+drawing)\b[^.!?;\n]{0,16}\b(?:nude|naked|nudity)\b/giu;
const FIGURATIVE_INTIMATE_TOUCH_MENTION = new RegExp(
  `(?:阳光|月光|晨光|夕阳|微风|清风|晚风|春风|雨丝|雪花|云影|树影|花影|音乐|旋律)[^，。！？；;\\n]{0,36}(?:${NSFW_INTIMATE_TOUCH_SOURCE})`,
  'giu',
);
const DISPLAYED_NSFW_MARKER = new RegExp(
  String.raw`(?:警示牌|标牌|标签|字幕|封面|海报|杂志|书刊|道具|文字|字样|场记板|墙上写着|门上写着|屏幕显示)[^。！？\n]{0,32}(?:${NSFW_MARKER_SOURCE})|(?:${NSFW_MARKER_SOURCE})[^。！？\n]{0,24}(?:警示牌|标牌|标签|字幕|封面|海报|杂志|书刊|道具|文字|字样|场记板)|\b(?:warning\s+sign|sign|label|caption|cover|magazine|poster|prop|on-screen\s+text)\b[^.!?\n]{0,24}(?:${NSFW_MARKER_SOURCE})|(?:${NSFW_MARKER_SOURCE})[^.!?\n]{0,24}\b(?:warning\s+sign|sign|label|caption|cover|magazine|poster|prop|on-screen\s+text)\b`,
  'giu',
);
const NON_SEXUAL_ENGLISH_AMBIGUITY = /\bnaked\s+(?:eye|mole\s+rat|singularity)\b|\b(?:market|armor|armour|soil|water|signal)\s+penetration\b|\bpenetration\s+test(?:ing)?\b/giu;

const CHINESE_NEGATION_BRIDGE = String.raw`(?:出现|包含|含有|展示|呈现|描写|描述|生成|涉及|表现|添加|加入|发生|进行|拍摄|显示|写出|刻画|允许|存在|任何|一切|所有|相关|此类|这类|以下|上述|此处|画面中|镜头中|内容|场景|行为|元素|字样|文字|让|任由|接受|对方|他|她|其|自己|本人|她的|他的|对方的|用|手|手掌|掌心|手指|指尖|覆上|覆在|按在|贴上|贴在|并|再|继续|的|[：:\s])*`;
const NEGATED_CHINESE_NSFW_MENTION = new RegExp(
  `(?:不要|请勿|禁止|不得|不应|不能|不可|不肯|拒绝|阻止|制止|避免|杜绝|排除|去除|屏蔽|不含|不包含|不涉及|不展示|不描写|不描述|不生成|不出现|没有|没|尚未|还未|还没|并未|未曾|从未|并非|不是|绝非|不存在|非)${CHINESE_NEGATION_BRIDGE}(?:${NSFW_SIGNAL_SOURCE})`,
  'giu',
);
const ENGLISH_NEGATION_BRIDGE = String.raw`(?:(?:include|contain|show|display|depict|describe|generate|involve|feature|present|add|allow|have|any|all|the|a|an|depictions?\s+of|content|references?\s+to|scene|activity|material)\s+)*`;
const NEGATED_ENGLISH_NSFW_MENTION = new RegExp(
  `(?:\\b(?:do\\s+not|don't|no|not|without|avoid(?:ing)?|exclude(?:d|ing)?|prohibit(?:ed|ing)?|ban(?:ned|ning)?)\\b\\s+${ENGLISH_NEGATION_BRIDGE}|\\bnon[-\\s]+)(?:${NSFW_SIGNAL_SOURCE})`,
  'giu',
);

const neutralizeNonSexualBodyTerms = (value: string): string => value
  .replace(DISPLAYED_NSFW_MARKER, '')
  .replace(ART_NUDITY_MENTION, '')
  .replace(FIGURATIVE_INTIMATE_TOUCH_MENTION, '')
  .replace(CLINICAL_NSFW_MENTION, '')
  .replace(NON_SEXUAL_ENGLISH_AMBIGUITY, '')
  .replace(NEGATED_CHINESE_NSFW_MENTION, '')
  .replace(NEGATED_ENGLISH_NSFW_MENTION, '');

/** Detect source text that needs faithful, explicit NSFW action detail. */
export const hasNsfwDetailSignal = (...values: unknown[]): boolean => {
  const text = values.map((value) => String(value || '')).join('\n');
  return NSFW_DETAIL_SIGNAL.test(neutralizeNonSexualBodyTerms(text));
};

const NSFW_MODE_LABEL_SOURCE = String.raw`(?:(?:nsfw|r-?18)(?:\s*(?:细节模式|模式))?|(?:成人向|成人内容)\s*模式)`;
const NSFW_CONTROL_PHRASE_SOURCE = String.raw`(?:
  (?:开启|启用|使用)\s*${NSFW_MODE_LABEL_SOURCE}
  |${NSFW_MODE_LABEL_SOURCE}
  |生成(?:逐镜)?详细动作描述
  |详细描述动作
  |动作写详细(?:一些|一点)?
  |最终视频提示词(?:要|需|需要)?生成详细描述的(?:nsfw|r-?18)提示词
  |生成详细(?:描述的)?(?:nsfw|r-?18)提示词
  |不要含蓄替换
  |不概括省略
  |不自行添加原文没有的动作
)`.replace(/\s+/gu, '');
const LEADING_NSFW_CONTROL = new RegExp(
  `^(?:${NSFW_CONTROL_PHRASE_SOURCE})(?:(?:\\s*[，,、:：]\\s*)|(?:\\s*[。.!！]\\s*$)|$)`,
  'iu',
);
const NSFW_CONTROL_ONLY_ATOM = new RegExp(
  `^(?:(?:制作要求|额外要求)\\s*[：:]\\s*)?(?:${NSFW_CONTROL_PHRASE_SOURCE})(?:\\s*[。.!！])?$`,
  'iu',
);

const TOP_LEVEL_BRACKET_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '（': '）',
  '[': ']',
  '【': '】',
  '{': '}',
  '〔': '〕',
  '〈': '〉',
  '《': '》',
};
const TOP_LEVEL_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
  '"': '"',
  "'": "'",
  '`': '`',
};

const isEscapedCharacter = (value: string, index: number): boolean => {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const isAsciiWordCharacter = (value: string | undefined): boolean => (
  Boolean(value) && /[\p{L}\p{N}]/u.test(value || '')
);

const startsQuotedSection = (value: string, index: number): string => {
  const character = value[index];
  if (!character || isEscapedCharacter(value, index)) return '';
  if (
    character === "'"
    && isAsciiWordCharacter(value[index - 1])
    && isAsciiWordCharacter(value[index + 1])
  ) return '';
  return TOP_LEVEL_QUOTE_PAIRS[character] || '';
};

/** Split only on separators outside user-authored quotes and bracketed visible text. */
const splitTopLevel = (
  value: string,
  isSeparator: (character: string) => boolean,
  preserveSeparators = false,
): string[] => {
  const parts: string[] = [];
  const bracketClosers: string[] = [];
  let quoteCloser = '';
  let partStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoteCloser) {
      if (character === quoteCloser && !isEscapedCharacter(value, index)) quoteCloser = '';
      continue;
    }
    const nextQuoteCloser = startsQuotedSection(value, index);
    if (nextQuoteCloser) {
      quoteCloser = nextQuoteCloser;
      continue;
    }
    const bracketCloser = TOP_LEVEL_BRACKET_PAIRS[character];
    if (bracketCloser) {
      bracketClosers.push(bracketCloser);
      continue;
    }
    if (bracketClosers[bracketClosers.length - 1] === character) {
      bracketClosers.pop();
      continue;
    }
    if (bracketClosers.length || !isSeparator(character)) continue;
    parts.push(value.slice(partStart, index));
    if (preserveSeparators) parts.push(character);
    partStart = index + 1;
  }
  parts.push(value.slice(partStart));
  return parts;
};

const removeTopLevelLiteral = (value: string, literal: string): string => {
  const bracketClosers: string[] = [];
  let quoteCloser = '';
  let result = '';
  for (let index = 0; index < value.length;) {
    if (!quoteCloser && bracketClosers.length === 0 && value.startsWith(literal, index)) {
      index += literal.length;
      continue;
    }
    const character = value[index];
    result += character;
    if (quoteCloser) {
      if (character === quoteCloser && !isEscapedCharacter(value, index)) quoteCloser = '';
      index += 1;
      continue;
    }
    const nextQuoteCloser = startsQuotedSection(value, index);
    if (nextQuoteCloser) {
      quoteCloser = nextQuoteCloser;
    } else {
      const bracketCloser = TOP_LEVEL_BRACKET_PAIRS[character];
      if (bracketCloser) bracketClosers.push(bracketCloser);
      else if (bracketClosers[bracketClosers.length - 1] === character) bracketClosers.pop();
    }
    index += 1;
  }
  return result;
};

const sanitizeNsfwControlSegment = (value: string): string => {
  let result = value.trim();
  for (let index = 0; index < 8 && result; index += 1) {
    const match = result.match(LEADING_NSFW_CONTROL);
    if (!match?.[0]) break;
    result = result.slice(match[0].length).trim();
  }
  return result;
};

const sanitizeNsfwControlClause = (value: string): string => {
  let changed = false;
  const parts = splitTopLevel(value, (character) => /[，,、]/u.test(character), true);
  const sanitized = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    const originalAtom = part.trim();
    const strippedAtom = sanitizeNsfwControlSegment(originalAtom);
    const nextAtom = NSFW_CONTROL_ONLY_ATOM.test(strippedAtom.trim())
      ? ''
      : strippedAtom;
    if (nextAtom === originalAtom) return part;
    changed = true;
    return nextAtom;
  });
  if (!changed) return value;
  return sanitized
    .join('')
    .replace(/([，,、])(?:\s*[，,、])+/gu, '$1')
    .replace(/^\s*[，,、]\s*|\s*[，,、]\s*$/gu, '')
    .trim();
};

/** Keep NSFW detection inputs private when an extra requirement contains only generator controls. */
export const sanitizeNsfwGenerationControls = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  return splitTopLevel(source, (character) => /[\r\n；;]/u.test(character))
    .map(sanitizeNsfwControlClause)
    .filter(Boolean)
    .join('；');
};

const LEGACY_NSFW_DETAIL_DIRECTIVE = 'NSFW细节模式：逐镜明确写出原文中的身体部位、裸露状态、姿势、肢体朝向、接触关系、动作顺序、动作幅度和每步可见结果，不含蓄替换、不概括省略、不自行添加原文没有的动作';

/** Remove only the exact internal directive leaked by 0.5.25, preserving story-authored NSFW text. */
export const sanitizeLegacyNsfwPromptLeak = (value: string): string => {
  const source = String(value || '');
  const withoutDirective = removeTopLevelLiteral(source, LEGACY_NSFW_DETAIL_DIRECTIVE);
  const withoutControlAtoms = splitTopLevel(
    withoutDirective,
    (character) => /[\r\n，,、；;]/u.test(character),
    true,
  )
    .map((part) => (
      NSFW_CONTROL_ONLY_ATOM.test(part.trim()) ? '' : part
    ))
    .join('');
  if (withoutControlAtoms === source) return source;
  return withoutControlAtoms
    .replace(/[，,](?:\s*[，,])+/gu, '，')
    .replace(/、(?:\s*、)+/gu, '、')
    .replace(/[；;](?:\s*[；;])+/gu, '；')
    .replace(/[，,、]\s*([；;])/gu, '$1')
    .replace(/([；;])\s*[，,、]/gu, '$1')
    .replace(/^\s*[，,、；;]\s*|\s*[，,、；;]\s*$/gu, '')
    .replace(/[ \t]*\n[ \t]*\n+/gu, '\n')
    .trim();
};

const CHINESE_NUMERIC_AGE = String.raw`(?:外观\s*)?(?:(?:大约|约|年满|已满)\s*)?[零〇一二两三四五六七八九十百]{1,6}\s*(?:多|余|来|左右)?\s*(?:周岁|岁)(?:以上|及以上|以下|及以下|左右)?`;
const ARABIC_NUMERIC_AGE = String.raw`(?:外观\s*)?(?:(?:大约|约|年满|已满)\s*)?\d{1,3}\s*(?:多|余|来|左右)?\s*(?:周岁|岁)(?:以上|及以上|以下|及以下|左右)?`;
const ENGLISH_AGE = String.raw`(?:\b(?:young\s+)?adult(?:s|\s+(?:female|male|woman|man|character))?\b|\bminor(?:s)?\b|\bno\s+minors?\b|\b\d{1,3}\s*(?:years?\s*old|-?year-?old)\b|\baged\s+\d{1,3}\b|\b(?:over|at\s+least)\s*\d{1,3}\b|\d{1,3}\+)`;
const CHINESE_AGE_DESCRIPTOR = String.raw`(?:(?:仅限|限定为|必须为|必须是|排除|不得为|禁止为)?\s*(?:成年人|未成年人|成年|成人|未成年)(?:人物|角色|男性|女性|男子|女子)?|(?:青年|中年|少年|少女|老年|年迈|儿童|幼年)(?:人物|角色|男性|女性|男子|女子)?)`;
const INLINE_CHINESE_AGE_RESTRICTION = String.raw`(?:仅限|限定为|必须为|必须是|排除|不得为|禁止为)?\s*(?:成年人|未成年人|成年|成人|未成年)(?:人物|角色|男性|女性|男子|女子)?`;
const AGE_LABEL = String.raw`(?:外观)?年龄(?:感|设定|限定|限制|要求|阶段|段|为|约|(?=[：:，、；\s]|保持|不变|一致|稳定|$))`;
const AGE_ONLY_METADATA = new RegExp(
  String.raw`^\s*(?:${CHINESE_NUMERIC_AGE}|${ARABIC_NUMERIC_AGE}|${ENGLISH_AGE}|${CHINESE_AGE_DESCRIPTOR})(?:\s*的?\s*(?:人物|角色|男性|女性|男子|女子))?\s*$`,
  'iu',
);
const INLINE_AGE_METADATA_SOURCE = `(?:${CHINESE_NUMERIC_AGE}|${ARABIC_NUMERIC_AGE}|${ENGLISH_AGE}|${INLINE_CHINESE_AGE_RESTRICTION}|${AGE_LABEL})`;
const INLINE_AGE_METADATA_SEQUENCE = String.raw`(?:${INLINE_AGE_METADATA_SOURCE}\s*)+`;
const INLINE_AGE_METADATA = new RegExp(INLINE_AGE_METADATA_SOURCE, 'giu');
const AGE_METADATA_AFTER_GOVERNOR = new RegExp(
  String.raw`((?:保持|锁定|不要改变|不得改变|禁止改变)(?:人物|角色)?(?:的)?)\s*${INLINE_AGE_METADATA_SEQUENCE}[与和、]\s*`,
  'giu',
);
const AGE_METADATA_BEFORE_STATE = new RegExp(
  String.raw`[与和、]\s*${INLINE_AGE_METADATA_SEQUENCE}(?=(?:保持|锁定|不变|一致|稳定))`,
  'giu',
);
const AUTOMATIC_METADATA_CONSTRAINT = /(?:^|\n)\s*(?:连续性锚点|固定人物|人物锚点|角色锚点)\s*[：:]/u;
const USER_REQUIREMENT_CONSTRAINT = /^\s*(?:制作要求|用户要求|额外要求)\s*[：:]/u;

const normalizeConstraintPunctuation = (value: string): string => value
  .replace(/\s*([，、；])\s*/gu, '$1')
  .replace(/[，、；]{2,}/gu, (match) => (match.includes('；') ? '；' : match.includes('，') ? '，' : '、'))
  .replace(/([：:])[，、；]+/gu, '$1')
  .replace(/[，、；]+(?=\s*(?:\n|$))/gu, '')
  .replace(/^\s*[，、；]+/gmu, '')
  .replace(/[与和](?=[，、；\s]|$)/gu, '')
  .replace(/[ \t]{2,}/gu, ' ')
  .trim();

const sanitizeCharacterDetail = (value: string): string => {
  const withoutAgeOnlyClauses = value
    .split(/[，,]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !AGE_ONLY_METADATA.test(clause))
    .join('，');
  return normalizeConstraintPunctuation(
    withoutAgeOnlyClauses
      .replace(AGE_METADATA_AFTER_GOVERNOR, '$1')
      .replace(AGE_METADATA_BEFORE_STATE, '')
      .replace(INLINE_AGE_METADATA, '')
      .replace(/(?:保持|锁定|不要改变|不得改变|禁止改变)(?:人物|角色)?(?:的)?[，、\s]*(?=[，、；]|$)/gu, ''),
  );
};

const fixedPersonSectionEnd = (value: string, start: number): number => {
  const tail = value.slice(start);
  const boundary = tail.search(/\r?\n|[ \t]+(?=(?:固定场景|场景序列|固定道具)\s*[：:]|同一镜头组)/u);
  return boundary < 0 ? value.length : start + boundary;
};

const characterDetailDivider = (entry: string): number => {
  const dividers: number[] = [];
  let nesting = 0;
  let firstComma = entry.length;
  for (let index = 0; index < entry.length; index += 1) {
    const character = entry[index];
    if (/[（(\[【{]/u.test(character)) {
      nesting += 1;
      continue;
    }
    if (/[）)\]】}]/u.test(character)) {
      nesting = Math.max(0, nesting - 1);
      continue;
    }
    if (nesting > 0) continue;
    if (/[，,]/u.test(character) && firstComma === entry.length) firstComma = index;
    if (/[：:]/u.test(character)) dividers.push(index);
  }
  const beforeComma = dividers.filter((index) => index < firstComma);
  if (beforeComma.length) return beforeComma[beforeComma.length - 1];
  return dividers.length ? dividers[dividers.length - 1] : -1;
};

const sanitizeFixedPersonSection = (section: string): string => section
  .split(/；(?=\s*[^；：:\r\n]{1,80}(?:（[^）\r\n]{0,160}）)?\s*[：:])/u)
  .map((entry) => {
    const divider = characterDetailDivider(entry);
    if (divider < 0) return entry;
    const name = entry.slice(0, divider).trim();
    const detail = sanitizeCharacterDetail(entry.slice(divider + 1));
    return detail ? `${name}${entry[divider]}${detail}` : name;
  })
  .join('；');

/**
 * Remove age metadata only from the details inside a generated `固定人物` lock.
 * Character names, story text, scene locks, and user requirements are preserved.
 */
export const stripAutomaticAgeMetadata = (value: string): string => {
  const source = String(value || '');
  const label = source.match(/固定人物\s*[：:]/u);
  if (!label || label.index === undefined) return source.trim();
  const sectionStart = label.index + label[0].length;
  const sectionEnd = fixedPersonSectionEnd(source, sectionStart);
  const sanitizedSection = sanitizeFixedPersonSection(source.slice(sectionStart, sectionEnd));
  return `${source.slice(0, sectionStart)}${sanitizedSection}${source.slice(sectionEnd)}`.trim();
};

/** Sanitize only metadata-origin constraints when NSFW detail mode is active. */
export const sanitizeNsfwAutomaticConstraints = (
  constraints: readonly string[],
  nsfwDetail: boolean,
): string[] => {
  if (!nsfwDetail) return [...constraints];
  return constraints
    .map((constraint) => (
      AUTOMATIC_METADATA_CONSTRAINT.test(constraint)
      && !USER_REQUIREMENT_CONSTRAINT.test(constraint)
        ? stripAutomaticAgeMetadata(constraint)
        : constraint
    ))
    .filter(Boolean);
};
