import type { NsfwPrivatePart, NsfwShotContinuityState } from './types';
import { H3DeliveryValidationError, H3_METADATA_SCHEMA, h3FieldIssue, h3Record as record, type H3DeliveryFieldIssue } from './h3DeliverySchema';

/** Explicit AI choices for a new shot after merging/splitting an old layout. */
export interface H3StagingShotMetadata {
  sourceBeatIds: string[];
  sourceExcerpt: string;
  sourceLocationStatus: 'located' | 'unlocated';
  sourceStart?: number;
  sourceEnd?: number;
  nsfwContinuity: NsfwShotContinuityState | null;
  visiblePrivatePartsByCharacter: Record<string, NsfwPrivatePart[]>;
}

const partNames = new Set<string>(H3_METADATA_SCHEMA.visiblePrivatePartsByCharacter.items);
const continuityKeys = H3_METADATA_SCHEMA.nsfwContinuity.optionalStringKeys;

/** Validate metadata shape only; never decide visibility, clothing or story relevance. */
export const readH3StagingShotMetadata = (value: unknown): Array<H3StagingShotMetadata | null> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new H3DeliveryValidationError([h3FieldIssue('shotMetadata', '与新镜头逐项对应的数组', value)]);
  const issues: H3DeliveryFieldIssue[] = [];
  const metadata = value.map((item, index): H3StagingShotMetadata | null => {
    if (item === null) return null;
    const path = `shotMetadata[${index}]`;
    const issue = (field: string, expected: string, actual: unknown): void => { issues.push(h3FieldIssue(`${path}${field}`, expected, actual)); };
    if (!record(item)) { issue('', '镜头元数据对象或明确空值', item); return null; }
    const before = issues.length;
    if (!Array.isArray(item.sourceBeatIds)) issue('.sourceBeatIds', '来源节拍编号字符串数组', item.sourceBeatIds);
    else item.sourceBeatIds.forEach((id: unknown, position) => {
      if (typeof id !== 'string') issue(`.sourceBeatIds[${position}]`, '来源节拍编号字符串', id);
    });
    if (typeof item.sourceExcerpt !== 'string') issue('.sourceExcerpt', '来源证据字符串', item.sourceExcerpt);
    if (!H3_METADATA_SCHEMA.sourceLocationStatus.some((status) => status === item.sourceLocationStatus)) {
      issue('.sourceLocationStatus', '已定位或未定位的规定枚举值', item.sourceLocationStatus);
    }
    let continuity: NsfwShotContinuityState | null = null;
    if (item.nsfwContinuity !== null) {
      if (!record(item.nsfwContinuity)) issue('.nsfwContinuity', '明确的状态对象或空值，不能缺失', item.nsfwContinuity);
      else {
        continuity = {};
        if (Object.keys(item.nsfwContinuity).some((key) => !continuityKeys.some((allowed) => key === allowed))) {
          issue('.nsfwContinuity', '仅包含规格中允许的状态字段', item.nsfwContinuity);
        }
        for (const key of continuityKeys) {
          const detail = item.nsfwContinuity[key];
          if (detail !== undefined && typeof detail !== 'string') issue(`.nsfwContinuity.${key}`, '可选字符串，未使用时省略', detail);
          if (typeof detail === 'string') continuity[key] = detail;
        }
      }
    }
    const visibleParts: Record<string, NsfwPrivatePart[]> = {};
    if (!record(item.visiblePrivatePartsByCharacter)) issue('.visiblePrivatePartsByCharacter', '人物编号到已选类别数组的对象', item.visiblePrivatePartsByCharacter);
    else {
      Object.entries(item.visiblePrivatePartsByCharacter).forEach(([characterId, parts], position) => {
        if (!characterId || ['__proto__', 'constructor', 'prototype'].includes(characterId) || !Array.isArray(parts)
          || !parts.every((part) => typeof part === 'string' && partNames.has(part))) {
          // Ordinal entry paths avoid disclosing user-controlled IDs in logs.
          issue(`.visiblePrivatePartsByCharacter[${position}]`, '有效人物编号及规定类别的数组', parts);
        } else visibleParts[characterId] = [...parts] as NsfwPrivatePart[];
      });
    }
    const located = item.sourceLocationStatus === 'located';
    if (located) {
      if (!Number.isSafeInteger(item.sourceStart) || (item.sourceStart as number) < 0) issue('.sourceStart', '非负的安全整数原文起点', item.sourceStart);
      if (!Number.isSafeInteger(item.sourceEnd) || !Number.isSafeInteger(item.sourceStart) || (item.sourceEnd as number) <= (item.sourceStart as number)) {
        issue('.sourceEnd', '大于原文起点的安全整数终点', item.sourceEnd);
      }
    } else if (item.sourceLocationStatus === 'unlocated') {
      for (const key of ['sourceStart', 'sourceEnd'] as const) {
        if (item[key] !== undefined && item[key] !== null) issue(`.${key}`, '未定位时省略或置为空值', item[key]);
      }
    }
    if (issues.length !== before) return null;
    return {
      sourceBeatIds: [...item.sourceBeatIds as string[]], sourceExcerpt: item.sourceExcerpt as string,
      sourceLocationStatus: located ? 'located' : 'unlocated',
      ...(located ? { sourceStart: item.sourceStart as number, sourceEnd: item.sourceEnd as number } : {}),
      nsfwContinuity: continuity, visiblePrivatePartsByCharacter: visibleParts,
    };
  });
  if (issues.length) throw new H3DeliveryValidationError(issues);
  return metadata;
};
