/** Mask authored dialogue, sound payloads and quoted text without moving
 * UTF-16 offsets. Binding edits must never rewrite those literal payloads. */
export const maskVideoPictureReferenceLiterals = (value: string): string => {
  const ranges = [...value.matchAll(/<(d|sound)>[\s\S]*?(?:<\/\1>|$)/giu)]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
  for (let index = 0; index < value.length; index += 1) {
    const protectedRange = ranges.find((range) => range.start <= index && index < range.end);
    if (protectedRange) { index = protectedRange.end - 1; continue; }
    const opening = value[index]; const closing = pairs[opening];
    if (!closing || opening === "'" && /[\p{L}\p{N}_]/u.test(value[index - 1] || '')) continue;
    let end = index + 1; let escaped = false;
    for (; end < value.length; end += 1) {
      if ((opening === '"' || opening === "'") && value[end] === '\\' && !escaped) { escaped = true; continue; }
      if (value[end] === closing && !escaped) break;
      escaped = false;
    }
    if (end < value.length) { ranges.push({ start: index, end: end + 1 }); index = end; }
  }
  let masked = value;
  for (const range of ranges) masked = masked.slice(0, range.start)
    + masked.slice(range.start, range.end).replace(/[^\r\n]/gu, (character) => ' '.repeat(character.length))
    + masked.slice(range.end);
  return masked;
};

export const videoPictureReferencePattern = (): RegExp => /<\s*(?:Image|Picture)\s*(\d+)\s*>|\[(?:Pic|Picture)\s*(\d+)\]|(?<![\p{L}\p{N}_<])(?:Image|Picture)\s*#?\s*(\d+)(?![\p{L}\p{N}_]|\s*>)/giu;

/** These are editable image bindings, excluding protected authored literals.
 * A provider's strict whole-prompt tag validator may scan literals separately. */
export const collectVideoPictureReferenceNumbers = (prompt: string): number[] => [...new Set(
  [...maskVideoPictureReferenceLiterals(prompt).matchAll(videoPictureReferencePattern())]
    .map((match) => Number(match[1] ?? match[2] ?? match[3])),
)];
