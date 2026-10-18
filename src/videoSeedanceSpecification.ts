import type { VideoTaskApiConfig } from './types';
import { buildLaoliVideoApiBody, isLaoliVideoBuiltinProtocol } from './genericVideoApi';
import { readSeedanceSections } from './seedanceSections';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

interface SpecificationResult { prompt: string; warnings: string[] }
interface TextEdit { start: number; end: number; text: string }
export type VideoSeedanceSpecificationApi = Partial<Pick<VideoTaskApiConfig, 'provider' | 'model' | 'baseUrl' | 'endpoint' | 'requestTemplate'>>;
type SpecificationField = 'resolution' | 'aspect_ratio';
const fieldLabel = (field: SpecificationField): string => field === 'resolution' ? '分辨率' : '画面比例';
const hasOverride = (parameters: Record<string, unknown>): boolean =>
  ['resolution', 'aspect_ratio', 'ratio'].some((key) => parameters[key] !== undefined);

/** Only concrete request values are eligible. Never interpolate free-form
 * parameter text into a prompt, or invent defaults from UI suggestions. */
const specificationValue = (field: SpecificationField, value: unknown): string | undefined => {
  if (typeof value !== 'string' || value !== value.trim()) return undefined;
  if (field === 'resolution') return /^(?:[1-9]\d*(?:\.\d+)?[pk]|[1-9]\d*\s*[x×]\s*[1-9]\d*|auto|original)$/iu.test(value) ? value : undefined;
  if (/^(?:auto|original)$/iu.test(value)) return value;
  const ratio = value.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u);
  return ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0 ? value : undefined;
};

const fieldEdits = (masked: string, field: SpecificationField, value: string): TextEdit[] => {
  const number = '[1-9]\\d*(?:\\.\\d+)?';
  const token = field === 'resolution'
    ? `(?:${number}\\s*[pk]|[1-9]\\d*\\s*[x×]\\s*[1-9]\\d*)`
    : `(?:${number}\\s*[:∶]\\s*${number})`;
  const namedValue = `(?:${token}|按(?:项目|当前|接口|工作流)设置|保留原值|默认(?:值)?|auto|original|default)`;
  const label = field === 'resolution' ? '(?:分辨率|(?:output\\s+)?resolution)'
    : '(?:画面比例|画幅(?:比例)?|宽高比|画面|比例|aspect(?:\\s+ratio)?|ratio)';
  const edits: TextEdit[] = [];
  const named = new RegExp(`(${label}[ \\t]*[:：=]?[ \\t]*)(${namedValue})(?![A-Za-z0-9_])`, 'giu');
  for (const match of masked.matchAll(named)) {
    edits.push({ start: match.index! + match[1].length, end: match.index! + match[0].length, text: value });
  }
  // Old prompts also use comma-separated specifications without field names.
  // Match a whole specification item, never arbitrary numbers in prose.
  const bare = new RegExp(`(^|[,，;；。\\r\\n])([ \\t]*)(${token})(?=[ \\t]*(?:[,，;；。\\r\\n]|$))`, 'gimu');
  for (const match of masked.matchAll(bare)) {
    const start = match.index! + match[1].length + match[2].length;
    if (!edits.some((edit) => edit.start === start)) edits.push({ start, end: start + match[3].length, text: value });
  }
  return edits;
};

/** Pure request-only render. Callers establish source provenance and always
 * start from the authored prompt when parameters change or are cleared.
 * Duration, audio, quoted literals and the other five sections stay exact. */
export const renderVideoSeedanceSpecification = (
  prompt: string, parameters: Record<string, unknown>, api?: VideoSeedanceSpecificationApi,
): SpecificationResult => {
  if (!api || api.provider && !['generic', 'minimax'].includes(api.provider) || api.requestTemplate?.trim()) {
    return { prompt, warnings: hasOverride(parameters)
      ? ['当前连接未明确可同步的输出规格字段，已保留原稿规格；请核对本次请求参数。'] : [] };
  }
  let effective = parameters;
  if (isLaoliVideoBuiltinProtocol({ ...api, endpoint: api.endpoint || '' })) {
    try {
      // Reuse the transport's actual defaults, aliases and validation instead
      // of maintaining another model table just for prompt previews.
      effective = buildLaoliVideoApiBody(api, { name: '', prompt: '', backend: 'api', references: [], parameters }, []);
    } catch (cause) {
      return { prompt, warnings: [`本次请求参数尚不能形成有效视频规格，已保留原稿规格：${cause instanceof Error ? cause.message : String(cause)}`] };
    }
  }
  const warnings: string[] = [];
  const values: Partial<Record<SpecificationField, string>> = {};
  if (effective.resolution !== undefined) {
    const value = specificationValue('resolution', effective.resolution);
    if (value) values.resolution = value;
    else warnings.push('本次分辨率不是可明确同步的规格值，已保留原稿分辨率。');
  }
  if (effective.aspect_ratio !== undefined && effective.ratio !== undefined && effective.aspect_ratio !== effective.ratio) {
    warnings.push('本次 aspect_ratio 与 ratio 不一致，已保留原稿画面比例。');
  } else if (effective.aspect_ratio !== undefined || effective.ratio !== undefined) {
    const value = specificationValue('aspect_ratio', effective.aspect_ratio ?? effective.ratio);
    if (value) values.aspect_ratio = value;
    else warnings.push('本次画面比例不是可明确同步的规格值，已保留原稿画面比例。');
  }
  if (!Object.keys(values).length) return { prompt, warnings };
  const section = readSeedanceSections(prompt)?.sections.specification;
  if (!section) return { prompt, warnings: [...warnings, '无法唯一定位 Seedance 视频规格章节，已保留正文；请核对本次请求参数。'] };
  const masked = maskVideoPictureReferenceLiterals(prompt).slice(section.start, section.end);
  const edits: TextEdit[] = [];
  for (const [field, value] of Object.entries(values) as Array<[SpecificationField, string]>) {
    const replacements = fieldEdits(masked, field, value);
    if (!replacements.length) warnings.push(`视频规格中没有可明确替换的${fieldLabel(field)}字段，已保留原文。`);
    else edits.push(...replacements);
  }
  let rendered = prompt;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rendered = rendered.slice(0, section.start + edit.start) + edit.text + rendered.slice(section.start + edit.end);
  }
  return { prompt: rendered, warnings };
};
