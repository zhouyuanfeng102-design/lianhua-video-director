const FRAME_KEYS = ['frames', 'framePlans', 'imageFrames'] as const;
const ENVELOPE_KEYS = ['data', 'result'] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Boundary/transport errors only. Never include model prose or JSON.parse's
 * content-bearing exception in the runtime log. */
class ImagePlanJsonError extends Error {}
const issue = (detail: string, length: number): ImagePlanJsonError =>
  new ImagePlanJsonError(`AI 图片规划${detail}（响应 ${length} 字符）。`);

interface JsonSpan { start: number; end?: number }

/** Match complete original values, respecting quoted braces and escapes.
 * This does not repair syntax or extract children from a broken parent. */
const readSpan = (raw: string, start: number, limit: number): JsonSpan => {
  const stack: string[] = [];
  let quoted = raw[start] === '"';
  let escaped = false;
  if (!quoted) stack.push(raw[start]);
  for (let index = start + 1; index < limit; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        if (!stack.length) return { start, end: index + 1 };
      }
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') stack.push(char);
    else if (char === ']' || char === '}') {
      // A mismatched closer is invalid syntax, not the end of the parent.
      // Keep scanning that parent so a later nested frames array can never be
      // mistaken for an independent valid response.
      if (stack[stack.length - 1] !== (char === ']' ? '[' : '{')) continue;
      stack.pop();
      if (!stack.length) return { start, end: index + 1 };
    }
  }
  return { start };
};

/** Accept known transport wrappers only, not arbitrary arrays such as a
 * reference list hidden somewhere in an unrelated provider response. */
const decodeFrames = (
  initial: unknown, length: number, wrapperDepth = 0, stringDepth = 0,
): unknown[] | undefined => {
  let value = initial;
  while (typeof value === 'string') {
    if (stringDepth >= 2) throw issue('的 JSON 字符串编码层数超过 2 层', length);
    stringDepth += 1;
    try { value = JSON.parse(value.trim()) as unknown; }
    catch { throw issue('的 JSON 字符串内容不是完整合法 JSON', length); }
  }
  if (Array.isArray(value)) return value;
  if (!record(value)) return undefined;
  if (wrapperDepth > 3) throw issue('的 data/result 封套嵌套超过 3 层', length);
  const plans: unknown[][] = [];
  for (const key of FRAME_KEYS) {
    if (!has(value, key)) continue;
    const frames = decodeFrames(value[key], length, wrapperDepth + 1, stringDepth);
    if (!frames) throw issue(`的 ${key} 字段不是图片规划数组`, length);
    plans.push(frames);
  }
  for (const key of ENVELOPE_KEYS) {
    if (!has(value, key)) continue;
    const wrapped = value[key];
    // Ordinary metadata such as result: "ok" is not a second JSON payload.
    if (!Array.isArray(wrapped) && !record(wrapped)
      && !(typeof wrapped === 'string' && /^[\s]*[\[{"]/u.test(wrapped))) continue;
    const frames = decodeFrames(wrapped, length, wrapperDepth + 1, stringDepth);
    if (frames) plans.push(frames);
  }
  if (plans.length > 1) throw issue('包含多个 frames/data/result 规划，无法确定唯一结果', length);
  return plans[0];
};

const nextNonWhitespace = (raw: string, start: number, limit: number): number => {
  let index = start;
  while (index < limit && /\s/u.test(raw[index])) index += 1;
  return index;
};

/** Read a complete model-authored plan without changing its contents. A fence
 * or harmless introduction is a transport wrapper, not a reason to spend an
 * extra model call. Multiple plans and a truncated final response remain errors. */
export const readStoryboardImagePlanJson = (raw: string): unknown[] => {
  const trimmed = raw.trim();
  if (!trimmed) throw issue('返回空内容，未提供图片规划', raw.length);
  let direct: unknown;
  let directParsed = false;
  try { direct = JSON.parse(trimmed) as unknown; directParsed = true; } catch { /* Read original boundaries below. */ }
  if (directParsed) {
    const frames = decodeFrames(direct, raw.length);
    if (frames) return frames;
    throw issue('的 JSON 未包含 frames 图片规划数组；也支持根数组或 data/result 封套', raw.length);
  }

  const ranges: Array<[number, number]> = [];
  // Fence boundaries prevent an unfinished prose example from consuming the
  // actual fenced result; they never alter or complete JSON within a fence.
  const fenceLines = /^[\t ]*```(?:[A-Za-z][\w-]*)?[\t ]*(?:\r?\n|$)/gmu;
  let rangeStart = 0;
  for (let match = fenceLines.exec(raw); match; match = fenceLines.exec(raw)) {
    ranges.push([rangeStart, match.index]);
    rangeStart = match.index + match[0].length;
  }
  ranges.push([rangeStart, raw.length]);
  const candidates: Array<JsonSpan & { frames?: unknown[]; error?: ImagePlanJsonError }> = [];
  for (const [begin, end] of ranges) {
    const firstContent = nextNonWhitespace(raw, begin, end);
    for (let index = begin; index < end; index += 1) {
      const char = raw[index];
      if (char !== '{' && char !== '[' && char !== '"') continue;
      const next = raw[nextNonWhitespace(raw, index + 1, end)];
      const objectStart = char === '{' && (next === '"' || next === '}');
      const arrayStart = char === '[' && (next === '{' || next === '[' || next === '"' || next === ']');
      const encodedStart = char === '"' && (next === '{' || next === '[' || next === '\\');
      if (char === '"' && !encodedStart) continue;
      // Consume every outer container, including {frames: ...} and
      // [invalid, ...]. Otherwise an unrecognized/broken parent would expose
      // its complete child as if the model had returned that child alone.
      const span = readSpan(raw, index, end);
      const protocolBearing = /"(?:frames|framePlans|imageFrames|sourceShotId)"\s*:/u.test(raw.slice(index, span.end ?? end));
      const unquotedObjectStart = char === '{' && /^\{\s*[A-Za-z_$][\w$]*\s*:/u.test(raw.slice(index, span.end ?? end));
      const jsonCandidate = objectStart || arrayStart || encodedStart || unquotedObjectStart || index === firstContent || protocolBearing;
      if (span.end === undefined) {
        candidates.push(span);
        break;
      }
      // Prose placeholders such as {notes} and [1] are not image plans, but
      // still have their entire boundary consumed so no child can escape.
      if (!jsonCandidate) { index = span.end - 1; continue; }
      try {
        const value: unknown = JSON.parse(raw.slice(index, span.end));
        const frames = decodeFrames(value, raw.length);
        candidates.push({ ...span, frames });
      } catch (error) {
        candidates.push({ ...span, error: error instanceof ImagePlanJsonError ? error
          : issue('的 JSON 语法无效；请由 AI 输出完整且合法的 JSON', raw.length) });
      }
      index = span.end - 1;
    }
  }
  const plans = candidates.filter((candidate) => candidate.frames !== undefined);
  if (plans.length > 1) throw issue('返回多个独立图片规划，无法确定唯一结果；请只输出一份完整规划', raw.length);
  const selected = plans[0];
  const unfinished = candidates.find((candidate) => candidate.end === undefined
    && (!selected || candidate.start >= (selected.end ?? selected.start)));
  if (unfinished || trimmed === '[' || trimmed === '{') {
    throw issue('的 JSON 未闭合，可能输出被截断；请由 AI 重新返回完整规划', raw.length);
  }
  // Do not use an earlier complete example if the final payload is malformed.
  const finalError = candidates.find((candidate) => candidate.error
    && (!selected || candidate.start >= (selected.end ?? selected.start)))?.error;
  if (finalError) throw finalError;
  if (selected?.frames) {
    // A complete but wrong-schema final payload is not harmless prose. Do not
    // silently fall back to an earlier example merely because it had frames.
    // Metadata within the same plan object remains accepted by decodeFrames.
    if (candidates.some((candidate) => candidate.start >= (selected.end ?? selected.start))) {
      throw issue('的后续 JSON 未包含 frames 图片规划数组；请只返回一份完整规划，不能用前面的示例代替最终结果', raw.length);
    }
    if (/^[\s]*[\]}]/u.test(raw.slice(selected.end))) throw issue('的 JSON 语法无效：完整结果后有多余的闭合括号', raw.length);
    return selected.frames;
  }
  if (candidates.length) throw issue('的 JSON 未包含 frames 图片规划数组', raw.length);
  throw issue('未返回可读取的 JSON 数组或 frames 对象；返回的是非 JSON 内容', raw.length);
};
