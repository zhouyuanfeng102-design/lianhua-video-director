import type { H3IdentityBindings } from './types';

export const h3Record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export interface H3DeliveryFieldIssue {
  path: string;
  expected: string;
  /** Shape only: never put prompt text, IDs, anchors, or credentials in errors. */
  actual: string;
}

export const h3ValueShape = (value: unknown): string => {
  if (value === undefined) return '字段缺失';
  if (value === null) return '空值';
  if (Array.isArray(value)) return `数组（${value.length}项）`;
  if (typeof value === 'string') return value.trim() ? `字符串（${value.length}字符）` : '空字符串';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? '整数' : '非安全整数的数值';
  if (typeof value === 'boolean') return '布尔值';
  return h3Record(value) ? `对象（${Object.keys(value).length}个字段）` : '非普通数据对象';
};

export const h3FieldIssue = (path: string, expected: string, actual: unknown): H3DeliveryFieldIssue => ({
  path, expected, actual: h3ValueShape(actual),
});

export class H3DeliveryValidationError extends Error {
  readonly code = 'H3_DELIVERY_SCHEMA_INVALID';
  constructor(readonly issues: readonly H3DeliveryFieldIssue[], context = 'AI交付元数据格式无效') {
    const details = issues.slice(0, 6).map((issue) => {
      const shot = issue.path.match(/^(?:shotMetadata|shotSourceIds)\[(\d+)\]/u);
      return `${shot ? `第${Number(shot[1]) + 1}镜，` : ''}字段“${issue.path}”：要求${issue.expected}；实际${issue.actual}`;
    }).join('。');
    super(`${context}（本地交付数据校验）：${details}${issues.length > 6 ? `；另有${issues.length - 6}处字段问题` : ''}。`);
    this.name = 'H3DeliveryValidationError';
  }
}

/** A readable body whose accompanying identity data needs repair. */
export class H3IdentityMetadataError extends Error {
  readonly code = 'H3_IDENTITY_METADATA_INVALID';
  constructor(message: string) { super(message); this.name = 'H3IdentityMetadataError'; }
}

// The same limits and token syntax feed the reader and its model instructions.
export const H3_IDENTITY_SCHEMA = {
  version: 1,
  maxCharacters: 256,
  requiredText: { characterId: 512, name: 1024, referenceAnchor: 32768 },
  optionalTokens: { subjectToken: '^<Subject [1-9]\\d*>$', speakerToken: '^\\(S[1-9]\\d*\\)$' },
} as const;

export const H3_METADATA_SCHEMA = {
  sourceBeatIds: 'string[]',
  sourceExcerpt: 'string',
  sourceLocationStatus: ['located', 'unlocated'],
  locatedCoordinates: 'sourceStart/sourceEnd: safe integers, 0 <= start < end',
  unlocatedCoordinates: 'omit sourceStart/sourceEnd (null also accepted)',
  nsfwContinuity: { nullable: true, optionalStringKeys: ['nudity', 'clothingState', 'contact', 'actionStage', 'residue'] },
  visiblePrivatePartsByCharacter: { type: 'record of arrays', items: ['full-body', 'breasts', 'vulva', 'anus', 'penis', 'scrotum'] },
} as const;

export const H3_IDENTITY_SCHEMA_RULE = [
  `identityBindings的读取规格：${JSON.stringify(H3_IDENTITY_SCHEMA)}。version输出数字1；characters必须为数组。requiredText每个字段都必须是非空字符串，其数值为最大字符数。`,
  'optionalTokens只在正文确实声明对应编号时填写，不使用时省略该字段。可选编号的null、空字符串仅等价于未声明，不能用它清除已有编号；必填ID、姓名、身份句不得为空。无实际绑定时才用{"version":1,"characters":[]}，已有绑定不能清空。',
  '结构示例：{"version":1,"characters":[{"characterId":"输入资料中的实际ID","name":"实际原名","referenceAnchor":"逐字复制当前H3中的唯一身份句"}]}。示例是字段形状，不是可直接使用的绑定或身份句。',
].join('\n');

export const H3_METADATA_SCHEMA_RULE = [
  `shotMetadata对象的完整读取规格：${JSON.stringify(H3_METADATA_SCHEMA)}。上述sourceBeatIds、sourceExcerpt、sourceLocationStatus、nsfwContinuity、visiblePrivatePartsByCharacter五个字段均必填；仅可选字符串子字段可省略。`,
  '无逐字原文定位且本镜无需额外状态的对象形状示例：{"sourceBeatIds":[],"sourceExcerpt":"本镜真实来源证据","sourceLocationStatus":"unlocated","nsfwContinuity":null,"visiblePrivatePartsByCharacter":{}}。必须依据给定证据填写，不得把示例空数组/空对象套给已有资料以消除校验错误。',
  '一一沿用来源且状态不变时，数组中对应项才可为null；整份shotMetadata必须为数组。必填对象、数组不能用空字符串替代；只有明确无法定位时才省略坐标，不用字符串或错误枚举替代所需类型。',
].join('\n');

/** Compatibility is representational only; no IDs, voices, or anchors are inferred. */
export const inspectH3IdentityBindings = (value: unknown): {
  value?: H3IdentityBindings; issues: H3DeliveryFieldIssue[];
} => {
  const issues: H3DeliveryFieldIssue[] = [];
  if (!h3Record(value)) return { issues: [h3FieldIssue('identityBindings', '包含版本和人物数组的对象', value)] };
  if (value.version !== H3_IDENTITY_SCHEMA.version && value.version !== String(H3_IDENTITY_SCHEMA.version)) {
    issues.push(h3FieldIssue('identityBindings.version', '版本数字1', value.version));
  }
  if (!Array.isArray(value.characters) || value.characters.length > H3_IDENTITY_SCHEMA.maxCharacters) {
    issues.push(h3FieldIssue('identityBindings.characters', `最多${H3_IDENTITY_SCHEMA.maxCharacters}项的人物数组`, value.characters));
    return { issues };
  }
  const characters: H3IdentityBindings['characters'] = [];
  value.characters.forEach((item: unknown, index) => {
    const path = `identityBindings.characters[${index}]`;
    if (!h3Record(item)) { issues.push(h3FieldIssue(path, '人物绑定对象', item)); return; }
    const before = issues.length;
    for (const [key, limit] of Object.entries(H3_IDENTITY_SCHEMA.requiredText)) {
      const text = item[key];
      if (typeof text !== 'string' || !text.trim() || text.length > limit) {
        issues.push(h3FieldIssue(`${path}.${key}`, `非空字符串，最多${limit}字符`, text));
      }
    }
    const tokens: { subjectToken?: string; speakerToken?: string } = {};
    for (const key of ['subjectToken', 'speakerToken'] as const) {
      const token = item[key];
      if (token === undefined || token === null || (typeof token === 'string' && !token.trim())) continue;
      if (typeof token !== 'string' || !new RegExp(H3_IDENTITY_SCHEMA.optionalTokens[key], 'u').test(token)) {
        issues.push(h3FieldIssue(`${path}.${key}`, key === 'subjectToken' ? '正文已有的主体编号标签，未使用时省略' : '正文已有的声源编号标签，未使用时省略', token));
      } else tokens[key] = token;
    }
    if (before === issues.length) characters.push({
      characterId: item.characterId as string, name: item.name as string, referenceAnchor: item.referenceAnchor as string, ...tokens,
    });
  });
  return issues.length ? { issues } : { value: { version: 1, characters }, issues };
};
