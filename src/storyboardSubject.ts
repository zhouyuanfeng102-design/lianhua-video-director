/**
 * Explicit, model/user-authored subject labels are not prose-extraction
 * candidates. Preserve their spelling (including surnames, single characters,
 * spaces, groups and locations) instead of applying the local actor heuristic.
 */
export const normalizeStoryboardSubject = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  let name = value.trim().replace(/^[@＠]\s*/u, '');
  const quotePairs: Readonly<Record<string, string>> = {
    '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』',
  };
  if (name.length >= 2 && quotePairs[name[0]] === name[name.length - 1]) {
    name = name.slice(1, -1).trim();
  }
  return name.replace(/^[@＠]\s*/u, '').trim();
};

const PRONOUN_SUBJECT = /^(?:我|我们|我方|咱|咱们|你|你们|您|您们|他|她|它|祂|他们|她们|它们|祂们|其|自己|对方|此人|那人|I|we|you|he|she|it|they)$/iu;
const PLACEHOLDER_SUBJECT = /^(?:无|无人|无人物|暂无|无主体|未知|未指定|未提供|未命名|待定|待填写|同上|同前|主体|主体名|主体名称|稳定主体名|稳定主体名称|当前场景|剧情主体|人物|角色|主角|第一人称主角|叙述者|某人|占位符|none|null|undefined|unknown|n\/?a|subject|subject[_ -]?name|character)$/iu;

/** A reason is returned only for an unusable declaration, never its style. */
export const storyboardSubjectValidationError = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return 'subject 必须填写文本名称';
  const name = normalizeStoryboardSubject(value);
  if (!name) return 'subject 为空';
  if (PRONOUN_SUBJECT.test(name)) return 'subject 只有独立代词，未指明本镜可复用的主体';
  if (PLACEHOLDER_SUBJECT.test(name)) return 'subject 是空值或占位词；无人出场时应填写原剧情中的具体环境、地点或物体名称';
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) return 'subject 不能包含控制字符或多行内容';
  if (/^[\p{P}\p{S}\s]+$/u.test(name)) return 'subject 不能只有标点或符号';
  if (/[【】\[\]{}；;]/u.test(name)) return 'subject 不能混入时间轴或多字段结构';
  return undefined;
};
