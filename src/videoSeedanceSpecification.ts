import type { VideoTaskApiConfig } from './types';
import { buildLaoliVideoApiBody, isLaoliVideoBuiltinProtocol } from './genericVideoApi';
import { readSeedanceSections } from './seedanceSections';
import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

interface SpecificationResult { prompt: string; warnings: string[] }
interface TextEdit { start: number; end: number; text: string }
export type VideoSeedanceSpecificationApi = Partial<Pick<VideoTaskApiConfig, 'provider' | 'model' | 'baseUrl' | 'endpoint' | 'requestTemplate'>>;
type SpecificationField = 'duration' | 'resolution' | 'aspect_ratio';
const hasOverride = (parameters: Record<string, unknown>): boolean =>
  ['duration', 'seconds', 'resolution', 'aspect_ratio', 'ratio'].some((key) => parameters[key] !== undefined);

/** Only concrete request values are eligible. Never interpolate free-form
 * parameter text into a prompt, or invent defaults from UI suggestions. */
const specificationValue = (field: SpecificationField, value: unknown): string | undefined => {
  if (field === 'duration') {
    const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) && number > 0 ? String(number) : undefined;
  }
  if (typeof value !== 'string' || value !== value.trim()) return undefined;
  if (field === 'resolution') return /^(?:[1-9]\d*(?:\.\d+)?[pk]|[1-9]\d*\s*[x×]\s*[1-9]\d*|auto|original)$/iu.test(value) ? value : undefined;
  if (/^(?:auto|original)$/iu.test(value)) return value;
  const ratio = value.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u);
  return ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0 ? value : undefined;
};

const labels: Record<SpecificationField, RegExp> = {
  duration: /总时长|时长|持续时间|(?:total\s+)?duration|(?:running|run)\s*time/giu,
  resolution: /分辨率|(?:output\s+)?resolution/giu,
  aspect_ratio: /画面比例|画幅(?:比例)?|宽高比|画面|比例|aspect(?:\s+ratio)?|ratio|frame/giu,
};
const tokens: Record<SpecificationField, RegExp> = {
  duration: /\d+(?:\.\d+)?\s*(?:秒|seconds?\b|secs?\b|s\b)/iu,
  resolution: /[1-9]\d*(?:\.\d+)?\s*[pk]\b|[1-9]\d*\s*[x×]\s*[1-9]\d*/iu,
  aspect_ratio: /[1-9]\d*(?:\.\d+)?\s*[:∶]\s*[1-9]\d*(?:\.\d+)?/u,
};
const defaultValue = /按(?:项目|当前|接口|工作流)设置|保留原值|默认(?:值)?|auto|original|default/iu;

/** Read complete technical items as data, independent of value/label order.
 * User notes and literal payloads are not specification fields. The selected
 * request value is then rendered from one fixed zh/en vocabulary. */
const specificationItems = (body: string): Array<TextEdit & { field: SpecificationField; value?: string }> => {
  const masked = maskVideoPictureReferenceLiterals(body);
  const items: Array<TextEdit & { field: SpecificationField; value?: string }> = [];
  let start = 0;
  const ends = [...masked.matchAll(/[,，;；。\r\n]|[.!?](?=\s|$)/gu)].map((match) => match.index!);
  for (const end of [...ends, body.length]) {
    const raw = body.slice(start, end);
    const text = raw.trim();
    const offset = start + raw.indexOf(text);
    if (text && body.slice(start, end) === masked.slice(start, end)) {
      for (const field of ['duration', 'aspect_ratio', 'resolution'] as const) {
        const withoutLabel = text.replace(labels[field], '');
        const token = tokens[field].exec(withoutLabel) || (withoutLabel !== text ? defaultValue.exec(withoutLabel) : null);
        if (!token) continue;
        const remainder = withoutLabel.slice(0, token.index) + withoutLabel.slice(token.index + token[0].length);
        if (!/^[\s:：=为是*_-]*$/u.test(remainder)) continue;
        const value = field === 'duration' ? token[0].match(/^\d+(?:\.\d+)?/u)?.[0]
          : token[0].replace(/\s/gu, '').replace('∶', ':');
        items.push({ start: offset, end: offset + text.length, text, field, value });
        break;
      }
    }
    start = end + 1;
  }
  return items;
};

const renderField = (field: SpecificationField, value: string, language: 'zh' | 'en'): string => language === 'en'
  ? field === 'duration' ? `duration ${value} seconds` : field === 'aspect_ratio' ? `aspect ratio ${value}` : `resolution ${value}`
  : field === 'duration' ? `总时长${value}秒` : field === 'aspect_ratio' ? `画面比例${value}` : `分辨率${value}`;

/** Pure request-only render. Callers establish source provenance and always
 * start from the authored prompt when parameters change or are cleared.
 * Request duration is a specification, never permission to retime the story.
 * Audio, quoted literals, user notes and the other five sections stay exact. */
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
  const duration = effective.seconds ?? effective.duration;
  if (duration !== undefined && (effective.seconds === undefined || effective.duration === undefined
    || Number(effective.seconds) === Number(effective.duration))) {
    const value = specificationValue('duration', duration);
    if (value) values.duration = value;
  }
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
  const parsed = readSeedanceSections(prompt);
  const section = parsed?.sections.specification;
  if (!section) return { prompt, warnings: [...warnings, '无法唯一定位 Seedance 视频规格章节，已保留正文；请核对本次请求参数。'] };
  const body = prompt.slice(section.start, section.end);
  const items = specificationItems(body);
  const edits: TextEdit[] = [];
  const missing: string[] = [];
  for (const [field, value] of Object.entries(values) as Array<[SpecificationField, string]>) {
    const matches = items.filter((item) => item.field === field);
    const text = renderField(field, value, parsed!.language);
    if (!matches.length) missing.push(text);
    else for (const item of matches) {
      if (item.value?.toLowerCase() !== value.replace(/\s/gu, '').toLowerCase()) edits.push({ ...item, text });
    }
  }
  if (missing.length) {
    const start = body.search(/\S/u);
    edits.push({ start: Math.max(start, 0), end: Math.max(start, 0),
      text: `${missing.join(parsed!.language === 'en' ? ', ' : '，')}${parsed!.language === 'en' ? '. ' : '。'}` });
  }
  let rendered = prompt;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rendered = rendered.slice(0, section.start + edit.start) + edit.text + rendered.slice(section.start + edit.end);
  }
  return { prompt: rendered, warnings };
};
