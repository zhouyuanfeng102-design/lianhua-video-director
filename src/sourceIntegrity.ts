export { sourceContentHash } from './sourceContentHash';

export type SourceIntegrityIssueType =
  | 'whole-document-duplicate'
  | 'large-duplicate-block'
  | 'high-similarity-duplicate';

export interface SourceTextRange {
  /** Inclusive UTF-16 code-unit offset. */
  start: number;
  /** Exclusive UTF-16 code-unit offset. */
  end: number;
}

export interface SourceIntegrityIssue {
  type: SourceIntegrityIssueType;
  original: SourceTextRange;
  duplicate: SourceTextRange;
  confidence: number;
  description: string;
}

export type SourceIntegrityResolution = 'keep-first';

interface NormalizedToken {
  value: string;
  start: number;
  end: number;
}

interface DuplicateCandidate {
  firstStart: number;
  firstEnd: number;
  secondStart: number;
  secondEnd: number;
  normalizedLength: number;
}

interface LongLineBlock {
  range: SourceTextRange;
  values: string[];
  grams: Set<string>;
}

const MIN_DUPLICATE_CHARACTERS = 80;
const MAX_REPORTED_ISSUES = 8;
const MIN_NEAR_DUPLICATE_SIMILARITY = 0.84;
const SIMILARITY_GRAM_SIZE = 6;
const MAX_NEAR_DUPLICATE_WINDOW_CHARACTERS = 512;
const MAX_SENTENCE_WINDOWS_PER_START = 1;
const MAX_NEAR_DUPLICATE_COMPARISONS_PER_BLOCK = 8;
const SEARCHABLE_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}]/u;
const PUNCTUATION_OR_SYMBOL_PATTERN = /[\p{P}\p{S}]/u;
const OPENING_PUNCTUATION_PATTERN = /[\p{Ps}\p{Pi}]/u;
const SEPARATOR_PATTERN = /^[\s\p{P}\p{S}]*$/u;

const normalizedTokens = (text: string): NormalizedToken[] => {
  const tokens: NormalizedToken[] = [];
  let offset = 0;

  for (const sourceCharacter of text) {
    const sourceEnd = offset + sourceCharacter.length;
    const normalized = sourceCharacter.normalize('NFKC').toLowerCase();
    for (const normalizedCharacter of normalized) {
      if (SEARCHABLE_CHARACTER_PATTERN.test(normalizedCharacter)) {
        tokens.push({
          value: normalizedCharacter,
          start: offset,
          end: sourceEnd,
        });
      }
    }
    offset = sourceEnd;
  }

  return tokens;
};

const tokenValuesEqual = (
  tokens: NormalizedToken[],
  firstStart: number,
  secondStart: number,
  length: number,
): boolean => {
  for (let index = 0; index < length; index += 1) {
    if (tokens[firstStart + index]?.value !== tokens[secondStart + index]?.value) {
      return false;
    }
  }
  return true;
};

const previousCharacter = (text: string, offset: number): { value: string; start: number } | undefined => {
  if (offset <= 0) return undefined;
  const previousCodeUnit = text.charCodeAt(offset - 1);
  const width = previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? 2 : 1;
  const start = Math.max(0, offset - width);
  return { value: text.slice(start, offset), start };
};

const normalizedValue = (text: string): string => normalizedTokens(text)
  .map((token) => token.value)
  .join('');

const similarityGrams = (values: string[]): Set<string> => {
  const grams = new Set<string>();
  for (let index = 0; index <= values.length - SIMILARITY_GRAM_SIZE; index += 3) {
    grams.add(values.slice(index, index + SIMILARITY_GRAM_SIZE).join(''));
  }
  return grams;
};

const editDistanceWithin = (
  left: string[],
  right: string[],
  maximumDistance: number,
): number | undefined => {
  if (Math.abs(left.length - right.length) > maximumDistance) return undefined;
  const infinity = maximumDistance + 1;
  let previous = new Array<number>(right.length + 1).fill(infinity);
  for (let column = 0; column <= Math.min(right.length, maximumDistance); column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1).fill(infinity);
    const firstColumn = Math.max(0, row - maximumDistance);
    const lastColumn = Math.min(right.length, row + maximumDistance);
    if (firstColumn === 0) current[0] = row;

    for (let column = Math.max(1, firstColumn); column <= lastColumn; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length] <= maximumDistance ? previous[right.length] : undefined;
};

const normalizedSimilarity = (
  leftText: string,
  rightText: string,
  minimumSimilarity = MIN_NEAR_DUPLICATE_SIMILARITY,
): number | undefined => {
  const left = normalizedTokens(leftText).map((token) => token.value);
  const right = normalizedTokens(rightText).map((token) => token.value);
  const maximumLength = Math.max(left.length, right.length);
  if (maximumLength === 0) return undefined;
  const maximumDistance = Math.floor(maximumLength * (1 - minimumSimilarity));
  const distance = editDistanceWithin(left, right, maximumDistance);
  if (distance === undefined) return undefined;
  const similarity = 1 - distance / maximumLength;
  return similarity >= minimumSimilarity ? similarity : undefined;
};

const exactWholeDocumentIssue = (
  text: string,
  secondContentStart: number,
): SourceIntegrityIssue | undefined => {
  const earliestCandidate = Math.max(1, secondContentStart - 24);

  for (let duplicateStart = earliestCandidate; duplicateStart <= secondContentStart; duplicateStart += 1) {
    const copyLength = text.length - duplicateStart;
    if (copyLength <= 0 || copyLength > duplicateStart) continue;
    const originalEnd = copyLength;
    if (!SEPARATOR_PATTERN.test(text.slice(originalEnd, duplicateStart))) continue;
    if (text.slice(0, originalEnd) !== text.slice(duplicateStart)) continue;
    if (normalizedValue(text.slice(0, originalEnd)).length < MIN_DUPLICATE_CHARACTERS) continue;

    return {
      type: 'whole-document-duplicate',
      original: { start: 0, end: originalEnd },
      duplicate: { start: duplicateStart, end: text.length },
      confidence: 1,
      description: '检测到整篇来源文本连续重复两遍；只有在用户明确选择保留第一份后，才应移除第二份。',
    };
  }

  return undefined;
};

const normalizedWholeDocumentIssue = (
  text: string,
  tokens: NormalizedToken[],
): SourceIntegrityIssue | undefined => {
  if (tokens.length < MIN_DUPLICATE_CHARACTERS * 2 || tokens.length % 2 !== 0) {
    return undefined;
  }

  const halfLength = tokens.length / 2;
  if (!tokenValuesEqual(tokens, 0, halfLength, halfLength)) return undefined;

  const secondContentStart = tokens[halfLength].start;
  const exactIssue = exactWholeDocumentIssue(text, secondContentStart);
  if (exactIssue) return exactIssue;

  let originalEnd = secondContentStart;
  let previous = previousCharacter(text, originalEnd);
  while (previous && /\s/u.test(previous.value)) {
    originalEnd = previous.start;
    previous = previousCharacter(text, originalEnd);
  }

  return {
    type: 'whole-document-duplicate',
    original: { start: 0, end: originalEnd },
    duplicate: { start: secondContentStart, end: text.length },
    confidence: 0.98,
    description: '检测到整篇来源文本高度相似地重复两遍，差异主要是空白或标点；不会自动删除任何内容。',
  };
};

const normalizedRangeToSourceRange = (
  tokens: NormalizedToken[],
  start: number,
  end: number,
): SourceTextRange => ({
  start: tokens[start].start,
  end: tokens[end - 1].end,
});

/** Expand only punctuation that is visibly shared by both copies. Unique
 * symbols immediately following the duplicate belong to the surrounding
 * source and must never be included in a destructive keep-first range. */
const expandMatchingBoundaryPunctuation = (
  text: string,
  first: SourceTextRange,
  second: SourceTextRange,
): [SourceTextRange, SourceTextRange] => {
  let firstStart = first.start;
  let secondStart = second.start;
  let firstEnd = first.end;
  let secondEnd = second.end;

  while (firstStart > 0 && secondStart > firstEnd) {
    const firstPrevious = previousCharacter(text, firstStart);
    const secondPrevious = previousCharacter(text, secondStart);
    if (
      !firstPrevious
      || !secondPrevious
      || firstPrevious.value !== secondPrevious.value
      || !OPENING_PUNCTUATION_PATTERN.test(firstPrevious.value)
    ) break;
    firstStart = firstPrevious.start;
    secondStart = secondPrevious.start;
  }

  while (firstEnd < secondStart && secondEnd < text.length) {
    const firstCharacter = String.fromCodePoint(text.codePointAt(firstEnd) as number);
    const secondCharacter = String.fromCodePoint(text.codePointAt(secondEnd) as number);
    if (
      firstCharacter !== secondCharacter
      || !PUNCTUATION_OR_SYMBOL_PATTERN.test(firstCharacter)
    ) break;
    firstEnd += firstCharacter.length;
    secondEnd += secondCharacter.length;
  }

  return [
    { start: firstStart, end: firstEnd },
    { start: secondStart, end: secondEnd },
  ];
};

const duplicateCandidates = (tokens: NormalizedToken[]): DuplicateCandidate[] => {
  if (tokens.length < MIN_DUPLICATE_CHARACTERS * 2) return [];

  const occurrences = new Map<string, number[]>();
  const candidates = new Map<string, DuplicateCandidate>();
  const lastSeedStart = tokens.length - MIN_DUPLICATE_CHARACTERS;

  for (let secondStart = 0; secondStart <= lastSeedStart; secondStart += 1) {
    const seed = tokens
      .slice(secondStart, secondStart + MIN_DUPLICATE_CHARACTERS)
      .map((token) => token.value)
      .join('');
    const previousStarts = occurrences.get(seed) || [];

    for (const firstSeedStart of previousStarts) {
      if (firstSeedStart + MIN_DUPLICATE_CHARACTERS > secondStart) continue;
      if (!tokenValuesEqual(tokens, firstSeedStart, secondStart, MIN_DUPLICATE_CHARACTERS)) continue;

      let firstStart = firstSeedStart;
      let secondCandidateStart = secondStart;
      while (
        firstStart > 0
        && secondCandidateStart > 0
        && tokens[firstStart - 1].value === tokens[secondCandidateStart - 1].value
      ) {
        firstStart -= 1;
        secondCandidateStart -= 1;
      }

      let firstEnd = firstSeedStart + MIN_DUPLICATE_CHARACTERS;
      let secondEnd = secondStart + MIN_DUPLICATE_CHARACTERS;
      while (
        firstEnd < secondCandidateStart
        && secondEnd < tokens.length
        && tokens[firstEnd].value === tokens[secondEnd].value
      ) {
        firstEnd += 1;
        secondEnd += 1;
      }

      const candidate: DuplicateCandidate = {
        firstStart,
        firstEnd,
        secondStart: secondCandidateStart,
        secondEnd,
        normalizedLength: firstEnd - firstStart,
      };
      const key = `${candidate.firstStart}:${candidate.firstEnd}:${candidate.secondStart}:${candidate.secondEnd}`;
      candidates.set(key, candidate);
    }

    if (previousStarts.length === 0) {
      occurrences.set(seed, [secondStart]);
    } else if (previousStarts.length < 4) {
      previousStarts.push(secondStart);
    } else {
      occurrences.set(seed, [previousStarts[0], previousStarts[2], previousStarts[3], secondStart]);
    }
  }

  return [...candidates.values()]
    .sort((left, right) => (
      right.normalizedLength - left.normalizedLength
      || left.firstStart - right.firstStart
      || left.secondStart - right.secondStart
    ));
};

const rangeContains = (outer: SourceTextRange, inner: SourceTextRange): boolean => (
  outer.start <= inner.start && outer.end >= inner.end
);

const blockIssues = (text: string, tokens: NormalizedToken[]): SourceIntegrityIssue[] => {
  const issues: SourceIntegrityIssue[] = [];

  for (const candidate of duplicateCandidates(tokens)) {
    const rawOriginal = normalizedRangeToSourceRange(
      tokens,
      candidate.firstStart,
      candidate.firstEnd,
    );
    const rawDuplicate = normalizedRangeToSourceRange(
      tokens,
      candidate.secondStart,
      candidate.secondEnd,
    );
    const [original, duplicate] = expandMatchingBoundaryPunctuation(
      text,
      rawOriginal,
      rawDuplicate,
    );
    if (original.end > duplicate.start) continue;
    if (issues.some((issue) => (
      rangeContains(issue.original, original) && rangeContains(issue.duplicate, duplicate)
    ))) {
      continue;
    }

    const originalText = text.slice(original.start, original.end);
    const duplicateText = text.slice(duplicate.start, duplicate.end);
    const exact = originalText === duplicateText;
    issues.push({
      type: exact ? 'large-duplicate-block' : 'high-similarity-duplicate',
      original,
      duplicate,
      confidence: exact ? 1 : 0.97,
      description: exact
        ? `检测到长度较大的重复文本块（${candidate.normalizedLength} 个归一化字符）；不会自动删除。`
        : `检测到长度较大的高相似文本块（${candidate.normalizedLength} 个归一化字符），差异主要为空白、大小写或标点；不会自动删除。`,
    });
    if (issues.length >= MAX_REPORTED_ISSUES) break;
  }

  return issues;
};

const longBlock = (
  text: string,
  range: SourceTextRange,
): LongLineBlock | undefined => {
  const values = normalizedTokens(text.slice(range.start, range.end)).map((token) => token.value);
  if (values.length < MIN_DUPLICATE_CHARACTERS) return undefined;
  return { range, values, grams: similarityGrams(values) };
};

const longLineBlocks = (text: string): LongLineBlock[] => {
  const blocksByRange = new Map<string, LongLineBlock>();
  const addBlock = (range: SourceTextRange): void => {
    const block = longBlock(text, range);
    if (block) blocksByRange.set(`${range.start}:${range.end}`, block);
  };

  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    const raw = match[0];
    const rawStart = match.index;
    const leadingWhitespace = raw.match(/^\s*/u)?.[0].length || 0;
    const trailingWhitespace = raw.match(/\s*$/u)?.[0].length || 0;
    const start = rawStart + leadingWhitespace;
    const end = rawStart + raw.length - trailingWhitespace;
    if (end <= start) continue;
    const wholeLine = longBlock(text, { start, end });
    if (!wholeLine) continue;
    blocksByRange.set(`${start}:${end}`, wholeLine);
    if (wholeLine.values.length < MIN_DUPLICATE_CHARACTERS * 2) continue;

    const sentenceRanges = [...text.slice(start, end).matchAll(/[^。！？!?]+(?:[。！？!?]+|$)/gu)]
      .map((sentence) => {
        const sentenceStart = start + sentence.index;
        const leading = sentence[0].match(/^\s*/u)?.[0].length || 0;
        const trailing = sentence[0].match(/\s*$/u)?.[0].length || 0;
        return {
          start: sentenceStart + leading,
          end: sentenceStart + sentence[0].length - trailing,
        };
      })
      .filter((range) => range.end > range.start);
    const normalizedSentenceLengths = sentenceRanges.map((range) => (
      normalizedTokens(text.slice(range.start, range.end)).length
    ));

    sentenceRanges.forEach((sentenceRange, sentenceIndex) => {
      let normalizedLength = 0;
      let reportedWindowCount = 0;
      for (let endIndex = sentenceIndex; endIndex < sentenceRanges.length; endIndex += 1) {
        normalizedLength += normalizedSentenceLengths[endIndex];
        if (normalizedLength > MAX_NEAR_DUPLICATE_WINDOW_CHARACTERS) break;
        if (normalizedLength < MIN_DUPLICATE_CHARACTERS) continue;
        addBlock({ start: sentenceRange.start, end: sentenceRanges[endIndex].end });
        reportedWindowCount += 1;
        if (reportedWindowCount >= MAX_SENTENCE_WINDOWS_PER_START) break;
      }
    });
  }
  return [...blocksByRange.values()];
};

const approximateLineIssues = (
  text: string,
  existingIssues: SourceIntegrityIssue[],
): SourceIntegrityIssue[] => {
  const blocks = longLineBlocks(text);
  if (blocks.length < 2) return [];

  const candidates: Array<{
    original: SourceTextRange;
    duplicate: SourceTextRange;
    normalizedLength: number;
    similarity: number;
  }> = [];
  const gramOwners = new Map<string, number[]>();

  blocks.forEach((block, secondIndex) => {
    const sharedGramCounts = new Map<number, number>();
    for (const gram of block.grams) {
      for (const firstIndex of gramOwners.get(gram) || []) {
        sharedGramCounts.set(firstIndex, (sharedGramCounts.get(firstIndex) || 0) + 1);
      }
    }

    const likelyMatches = [...sharedGramCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_NEAR_DUPLICATE_COMPARISONS_PER_BLOCK);
    for (const [firstIndex, sharedGramCount] of likelyMatches) {
      const first = blocks[firstIndex];
      if (first.range.end > block.range.start) continue;
      const shorterLength = Math.min(first.values.length, block.values.length);
      const longerLength = Math.max(first.values.length, block.values.length);
      if (shorterLength / longerLength < MIN_NEAR_DUPLICATE_SIMILARITY) continue;
      const requiredSharedGrams = Math.max(
        4,
        Math.floor(Math.min(first.grams.size, block.grams.size) * 0.2),
      );
      if (sharedGramCount < requiredSharedGrams) continue;

      const maximumDistance = Math.floor(longerLength * (1 - MIN_NEAR_DUPLICATE_SIMILARITY));
      const distance = editDistanceWithin(first.values, block.values, maximumDistance);
      if (distance === undefined) continue;
      const similarity = 1 - distance / longerLength;
      if (similarity < MIN_NEAR_DUPLICATE_SIMILARITY) continue;
      candidates.push({
        original: first.range,
        duplicate: block.range,
        normalizedLength: shorterLength,
        similarity,
      });
    }

    for (const gram of block.grams) {
      const owners = gramOwners.get(gram) || [];
      if (owners.length < 32) {
        owners.push(secondIndex);
      } else {
        owners.splice(1, 1);
        owners.push(secondIndex);
      }
      gramOwners.set(gram, owners);
    }
  });

  return candidates
    .sort((left, right) => (
      right.normalizedLength - left.normalizedLength
      || right.similarity - left.similarity
      || left.original.start - right.original.start
    ))
    .filter((candidate, index, sorted) => !sorted.slice(0, index).some((reported) => (
      rangeContains(reported.original, candidate.original)
      && rangeContains(reported.duplicate, candidate.duplicate)
    )))
    .filter((candidate) => !existingIssues.some((issue) => (
      rangeContains(issue.original, candidate.original)
      && rangeContains(issue.duplicate, candidate.duplicate)
    )))
    .slice(0, Math.max(0, MAX_REPORTED_ISSUES - existingIssues.length))
    .map((candidate) => ({
      type: 'high-similarity-duplicate' as const,
      original: candidate.original,
      duplicate: candidate.duplicate,
      confidence: Math.min(0.96, candidate.similarity),
      description: `检测到长度较大的高相似文本块（相似度约 ${Math.round(candidate.similarity * 100)}%），包含少量措辞、空白或标点差异；不会自动删除。`,
    }));
};

/**
 * Finds suspicious source duplication without modifying the supplied text.
 * Every returned range uses JavaScript's native UTF-16, half-open offsets.
 */
export const detectSourceIntegrityIssues = (text: string): SourceIntegrityIssue[] => {
  if (!text) return [];
  const tokens = normalizedTokens(text);
  const wholeDocumentIssue = normalizedWholeDocumentIssue(text, tokens);
  if (wholeDocumentIssue) return [wholeDocumentIssue];
  const exactOrFormattingIssues = blockIssues(text, tokens);
  return [
    ...exactOrFormattingIssues,
    ...approximateLineIssues(text, exactOrFormattingIssues),
  ];
};

const validRange = (range: SourceTextRange, textLength: number): boolean => (
  Number.isInteger(range.start)
  && Number.isInteger(range.end)
  && range.start >= 0
  && range.end > range.start
  && range.end <= textLength
);

/**
 * Applies the caller's explicit resolution. Detection itself never calls this
 * function and therefore never removes user-owned source content.
 */
export const applySourceIntegrityResolution = (
  text: string,
  issue: SourceIntegrityIssue,
  resolution: SourceIntegrityResolution,
): string => {
  if (resolution !== 'keep-first') return text;
  if (!validRange(issue.original, text.length) || !validRange(issue.duplicate, text.length)) {
    return text;
  }
  if (issue.original.end > issue.duplicate.start) return text;

  const originalValue = normalizedValue(text.slice(issue.original.start, issue.original.end));
  const duplicateValue = normalizedValue(text.slice(issue.duplicate.start, issue.duplicate.end));
  if (!originalValue) return text;
  if (originalValue !== duplicateValue) {
    if (issue.type !== 'high-similarity-duplicate') return text;
    const similarity = normalizedSimilarity(
      text.slice(issue.original.start, issue.original.end),
      text.slice(issue.duplicate.start, issue.duplicate.end),
    );
    if (similarity === undefined) return text;
  }

  if (
    issue.type === 'whole-document-duplicate'
    && issue.original.start === 0
    && issue.duplicate.end === text.length
  ) {
    return text.slice(0, issue.original.end);
  }

  return text.slice(0, issue.duplicate.start) + text.slice(issue.duplicate.end);
};
